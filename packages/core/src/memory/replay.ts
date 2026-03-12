import type {
  MemoryEdge,
  MemoryItem,
  MemoryRepository,
  MemoryWriteCandidate,
} from "./types";
import {
  downgradeContradictedMemoryItem,
  getMemoryGovernanceState,
  mergeMemoryGovernanceState,
  updateGovernanceTags,
} from "./governance";

const REPLAY_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "been",
  "being",
  "chat",
  "continue",
  "from",
  "have",
  "into",
  "just",
  "need",
  "please",
  "project",
  "really",
  "should",
  "that",
  "their",
  "them",
  "this",
  "through",
  "when",
  "with",
  "work",
]);

export interface MemoryReplayResult {
  generatedAt: string;
  writtenItems: MemoryItem[];
  reinforcedItemIds: string[];
  linkedEdges: MemoryEdge[];
}

interface ReplayAbstractionPlan {
  existingId: string | null;
  candidate: MemoryWriteCandidate | null;
  candidateSignature: string | null;
  supportItemIds: string[];
  supersedesId: string | null;
}

export async function runMemoryReplay(
  repository: MemoryRepository,
  options: {
    now?: string;
  } = {},
): Promise<MemoryReplayResult> {
  const now = options.now ?? new Date().toISOString();
  const [allItems, activeItems, existingEdges] = await Promise.all([
    repository.listItems({ includeSuperseded: true }),
    repository.listItems({ includeSuperseded: false }),
    repository.listEdges(),
  ]);
  const itemsById = new Map(allItems.map((item) => [item.id, item]));
  const existingEdgeKeys = new Set(existingEdges.map((edge) => buildEdgeKey(edge)));
  const plannedEdgeKeys = new Set(existingEdgeKeys);
  const linkedEdges: MemoryEdge[] = [];
  const reinforcedItemIds = new Set<string>();

  for (const durableItem of activeItems.filter(isReplayDurableMemory)) {
    const supportItems = collectDerivedSupportItems(durableItem, itemsById, existingEdges);
    const supportSessions = new Set(
      supportItems.map((item) => item.sessionId).filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    if (supportSessions.size < 2) {
      continue;
    }

    const supportRelation: "about_user" | "about_project" = isReplayUserMemory(durableItem)
      ? "about_user"
      : "about_project";
    const candidateEdges = supportItems.flatMap((supportItem) => [
      { fromId: supportItem.id, toId: durableItem.id, relation: supportRelation },
      { fromId: supportItem.id, toId: durableItem.id, relation: "reinforces" as const },
    ]);
    const newEdges = candidateEdges.filter((edge) => !plannedEdgeKeys.has(buildEdgeKey(edge)));
    if (newEdges.length === 0) {
      continue;
    }

    linkedEdges.push(...newEdges);
    newEdges.forEach((edge) => plannedEdgeKeys.add(buildEdgeKey(edge)));
    reinforcedItemIds.add(durableItem.id);
  }

  for (const item of activeItems) {
    if (!item.supersedesId) {
      continue;
    }
    const superseded = itemsById.get(item.supersedesId);
    if (!superseded || sameNormalizedText(item.content, superseded.content)) {
      continue;
    }
    const contradictsEdge = {
      fromId: item.id,
      toId: superseded.id,
      relation: "contradicts" as const,
    };
    if (!plannedEdgeKeys.has(buildEdgeKey(contradictsEdge))) {
      linkedEdges.push(contradictsEdge);
      plannedEdgeKeys.add(buildEdgeKey(contradictsEdge));
    }
  }

  const abstractionPlans = planReplayProjectConstraintAbstractions(activeItems, now);
  const candidateWrites = abstractionPlans
    .map((plan) => plan.candidate)
    .filter((candidate): candidate is MemoryWriteCandidate => Boolean(candidate));
  const writtenItems = candidateWrites.length > 0 ? await repository.upsertItems(candidateWrites) : [];

  const abstractionEdges = abstractionPlans.flatMap((plan) => {
    const targetId =
      plan.existingId ??
      writtenItems.find((item) => buildItemSignature(item) === plan.candidateSignature)?.id ??
      null;
    if (!targetId) {
      return [];
    }

    const supportEdges = [...new Set(plan.supportItemIds)]
      .filter((supportId) => supportId !== targetId)
      .flatMap((supportId) => [
        { fromId: targetId, toId: supportId, relation: "derived_from" as const },
        { fromId: supportId, toId: targetId, relation: "about_project" as const },
        { fromId: supportId, toId: targetId, relation: "reinforces" as const },
      ]);
    const supersessionEdges =
      plan.supersedesId && plan.supersedesId !== targetId
        ? [
            { fromId: targetId, toId: plan.supersedesId, relation: "supersedes" as const },
            { fromId: targetId, toId: plan.supersedesId, relation: "contradicts" as const },
          ]
        : [];
    return [...supportEdges, ...supersessionEdges];
  });

  const finalEdges = [
    ...new Map(
      [...linkedEdges, ...abstractionEdges]
        .filter((edge) => !existingEdgeKeys.has(buildEdgeKey(edge)))
        .map((edge) => [buildEdgeKey(edge), edge]),
    ).values(),
  ];
  if (finalEdges.length > 0) {
    await repository.upsertEdges(finalEdges);
  }

  for (const itemId of reinforcedItemIds) {
    await repository.reinforceItem(itemId, {
      now,
      confidenceDelta: 0.01,
      salienceDelta: 0.02,
      extendValidity: true,
      reinforcementDelta: 0,
    });
  }

  for (const plan of abstractionPlans) {
    if (plan.existingId) {
      const hasNovelSupport =
        plan.supportItemIds.some(
          (supportId) =>
            !existingEdgeKeys.has(
              buildEdgeKey({
                fromId: plan.existingId!,
                toId: supportId,
                relation: "derived_from",
              }),
            ),
        ) || Boolean(plan.supersedesId);
      if (!hasNovelSupport) {
        continue;
      }
      await repository.reinforceItem(plan.existingId, {
        now,
        confidenceDelta: 0.02,
        salienceDelta: 0.02,
        extendValidity: true,
      });
      reinforcedItemIds.add(plan.existingId);
    }
  }

  const contradictionDowngrades = await applySustainedContradictionDowngrades(repository, {
    now,
    existingEdges: finalEdges.length > 0 ? await repository.listEdges() : [...existingEdges, ...finalEdges],
  });

  return {
    generatedAt: now,
    writtenItems: [...writtenItems, ...contradictionDowngrades],
    reinforcedItemIds: [...reinforcedItemIds],
    linkedEdges: finalEdges,
  };
}

function collectDerivedSupportItems(
  durableItem: MemoryItem,
  itemsById: ReadonlyMap<string, MemoryItem>,
  edges: MemoryEdge[],
): MemoryItem[] {
  const supportIds = edges
    .filter((edge) => edge.fromId === durableItem.id && edge.relation === "derived_from")
    .map((edge) => edge.toId);
  return [...new Set(supportIds)]
    .map((id) => itemsById.get(id) ?? null)
    .filter((item): item is MemoryItem => item !== null)
    .filter((item) => isReplayEpisode(item));
}

function planReplayProjectConstraintAbstractions(
  activeItems: MemoryItem[],
  now: string,
): ReplayAbstractionPlan[] {
  const episodicItems = activeItems.filter((item) => item.scope === "workspace" && isReplayEpisode(item));
  const clusters = new Map<
    string,
    {
      text: string;
      tags: string[];
      sessionIds: Set<string>;
      supportItemIds: string[];
      latestObservedAt: string | null;
    }
  >();

  for (const item of episodicItems) {
    const sessionId = item.sessionId;
    if (!sessionId) {
      continue;
    }

    for (const snippet of extractConstraintSnippets(item.content)) {
      const normalized = normalizeCueToken(snippet);
      if (!normalized) {
        continue;
      }
      const key = `project:constraint:${normalized.slice(0, 64)}`;
      const cluster = clusters.get(key);
      if (cluster) {
        cluster.sessionIds.add(sessionId);
        cluster.supportItemIds.push(item.id);
        cluster.latestObservedAt = maxIsoTimestamp(cluster.latestObservedAt, item.observedAt ?? item.updatedAt);
      } else {
        clusters.set(key, {
          text: snippet,
          tags: [
            "constraint",
            "project-constraint",
            "replay",
            ...extractKeywordTags(snippet).map((tag) => normalizeCueToken(tag)),
          ],
          sessionIds: new Set([sessionId]),
          supportItemIds: [item.id],
          latestObservedAt: item.observedAt ?? item.updatedAt,
        });
      }
    }
  }

  const plans: ReplayAbstractionPlan[] = [];
  for (const [key, cluster] of clusters.entries()) {
    if (cluster.sessionIds.size < 2) {
      continue;
    }

    const activeExisting = activeItems.find(
      (item) =>
        item.scope === "workspace" &&
        !item.supersededById &&
        item.memoryType === "project_fact" &&
        item.jsonValue?.key === key,
    );
    const content = `Persistent project constraint: ${cluster.text}`;
    if (activeExisting && sameNormalizedText(activeExisting.content, content)) {
      plans.push({
        existingId: activeExisting.id,
        candidate: null,
        candidateSignature: null,
        supportItemIds: [...new Set(cluster.supportItemIds)].slice(0, 6),
        supersedesId: null,
      });
      continue;
    }

    const candidate: MemoryWriteCandidate = {
      sessionId: null,
      memoryType: "project_fact",
      scope: "workspace",
      content,
      jsonValue: {
        key,
        constraint: cluster.text,
        sessionCount: cluster.sessionIds.size,
        supportCount: cluster.supportItemIds.length,
        evidenceKind: "replay_constraint_cluster",
        replayedAt: now,
        ...mergeMemoryGovernanceState(null, {
          approvalStatus: "pending",
          contradictionCount: 0,
          contradictionSessionCount: 0,
        }),
      },
      tags: updateGovernanceTags([...new Set([...cluster.tags, "workspace"])], "pending"),
      sourceType: "system",
      sourceRef: "memory:replay",
      confidence: Math.min(0.96, 0.8 + (cluster.sessionIds.size - 2) * 0.04),
      salience: Math.min(0.94, 0.78 + (cluster.sessionIds.size - 2) * 0.04),
      volatility: "slow-changing",
      observedAt: cluster.latestObservedAt ?? now,
      revalidationDueAt: addDays(cluster.latestObservedAt ?? now, 180),
      supersedesId: activeExisting?.id ?? null,
    };

    plans.push({
      existingId: null,
      candidate,
      candidateSignature: buildCandidateSignature(candidate),
      supportItemIds: [...new Set(cluster.supportItemIds)].slice(0, 6),
      supersedesId: activeExisting?.id ?? null,
    });
  }

  return plans;
}

async function applySustainedContradictionDowngrades(
  repository: MemoryRepository,
  options: {
    now: string;
    existingEdges: MemoryEdge[];
  },
): Promise<MemoryItem[]> {
  const allItems = await repository.listItems({ includeSuperseded: true });
  const itemsById = new Map(allItems.map((item) => [item.id, item]));
  const downgraded: MemoryItem[] = [];

  for (const item of allItems.filter((candidate) => !candidate.supersededById && isReplayDurableMemory(candidate))) {
    const contradictoryItems = options.existingEdges
      .filter((edge) => edge.fromId === item.id && edge.relation === "contradicts")
      .map((edge) => itemsById.get(edge.toId) ?? null)
      .filter((candidate): candidate is MemoryItem => candidate !== null);
    const contradictionSessions = new Set(
      contradictoryItems
        .map((candidate) => candidate.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    if (contradictionSessions.size < 2) {
      continue;
    }

    const governance = getMemoryGovernanceState(item);
    if (
      governance.approvalStatus === "disputed" &&
      governance.contradictionSessionCount >= contradictionSessions.size &&
      governance.contradictionCount >= contradictoryItems.length
    ) {
      continue;
    }

    const downgradedItem = await downgradeContradictedMemoryItem(repository, item.id, {
      now: options.now,
      contradictionCount: contradictoryItems.length,
      contradictionSessionCount: contradictionSessions.size,
      reason: "replay observed sustained contradictory support across archived sessions",
    });
    if (downgradedItem) {
      downgraded.push(downgradedItem);
    }
  }

  return downgraded;
}

function isReplayEpisode(item: MemoryItem): boolean {
  return (
    item.memoryType === "episode_summary" ||
    item.memoryType === "task_outcome" ||
    item.memoryType === "warning_or_constraint"
  );
}

function isReplayDurableMemory(item: MemoryItem): boolean {
  return (
    !item.supersededById &&
    (isReplayUserMemory(item) ||
      item.memoryType === "project_fact" ||
      item.memoryType === "environment_fact" ||
      item.memoryType === "procedure")
  );
}

function isReplayUserMemory(item: MemoryItem): boolean {
  return item.memoryType === "user_profile" || item.memoryType === "user_preference";
}

function buildCandidateSignature(candidate: MemoryWriteCandidate): string {
  const key =
    candidate.jsonValue &&
    typeof candidate.jsonValue === "object" &&
    !Array.isArray(candidate.jsonValue) &&
    typeof candidate.jsonValue.key === "string"
      ? candidate.jsonValue.key
      : "";
  return [
    candidate.sessionId ?? "",
    candidate.memoryType,
    candidate.sourceType,
    key,
    normalizeWhitespace(candidate.content).toLowerCase(),
  ].join("::");
}

function buildItemSignature(item: MemoryItem): string {
  const key = typeof item.jsonValue?.key === "string" ? item.jsonValue.key : "";
  return [
    item.sessionId ?? "",
    item.memoryType,
    item.sourceType,
    key,
    normalizeWhitespace(item.content).toLowerCase(),
  ].join("::");
}

function buildEdgeKey(edge: { fromId: string; toId: string; relation: string }): string {
  return `${edge.fromId}::${edge.toId}::${edge.relation}`;
}

function extractConstraintSnippets(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length >= 18 && sentence.length <= 220)
    .filter((sentence) =>
      /\b(must|should|need to|needs to|do not|don't|avoid|without|keep|use|only|never|always|required|preserve)\b/i.test(
        sentence,
      ),
    )
    .filter((sentence) =>
      /\b(api|build|test|cli|ui|workspace|repo|repository|package|server|memory|prompt|typescript|tool|frontend|backend)\b/i.test(
        sentence,
      ),
    )
    .slice(0, 6);
}

function extractKeywordTags(content: string): string[] {
  return normalizeWhitespace(content)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !REPLAY_STOP_WORDS.has(term))
    .slice(0, 6);
}

function normalizeCueToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sameNormalizedText(left: string, right: string): boolean {
  return normalizeWhitespace(left).toLowerCase() === normalizeWhitespace(right).toLowerCase();
}

function maxIsoTimestamp(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}

function addDays(value: string, days: number): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp + days * 24 * 60 * 60 * 1_000).toISOString();
}
