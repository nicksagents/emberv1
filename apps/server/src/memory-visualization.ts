import {
  getItemInternalMetadata,
  getMemoryGovernanceState,
  type MemoryApprovalStatus,
  type MemoryEdge,
  type MemoryItem,
  type MemorySession,
} from "@ember/core";

import type { MemoryRetrievalTrace } from "./memory-traces.js";
import type { MemoryReplayState } from "./memory-maintenance.js";

export interface MemoryOverviewRecord {
  id: string;
  sessionId: string | null;
  content: string;
  memoryType: MemoryItem["memoryType"];
  scope: MemoryItem["scope"];
  sourceType: MemoryItem["sourceType"];
  sourceRef: string | null;
  sourceLabel: string;
  volatility: MemoryItem["volatility"];
  confidence: number;
  salience: number;
  status: "active" | "superseded" | "expired" | "forgotten";
  tags: string[];
  updatedAt: string;
  observedAt: string | null;
  validUntil: string | null;
  reinforcementCount: number;
  lastReinforcedAt: string | null;
  revalidationDueAt: string | null;
  needsRevalidation: boolean;
  approvalStatus: MemoryApprovalStatus;
  contradictionCount: number;
  contradictionSessionCount: number;
  approvedAt: string | null;
  clusterId: string;
  clusterLabel: string;
  activation: number;
}

export interface MemoryOverviewPayload {
  generatedAt: string;
  summary: {
    totalMemories: number;
    activeMemories: number;
    staleMemories: number;
    supersededMemories: number;
    forgottenMemories: number;
    activeSessions: number;
    archivedSessions: number;
    recentTraceCount: number;
    explicitEdgeCount: number;
    replayEdgeCount: number;
  };
  maintenance: {
    replay: MemoryReplayState;
  };
  recentMemories: MemoryOverviewRecord[];
  profileMemories: MemoryOverviewRecord[];
  sessionMemories: MemoryOverviewRecord[];
  staleMemories: MemoryOverviewRecord[];
  sessions: Array<{
    id: string;
    summary: string;
    topics: string[];
    startedAt: string;
    endedAt: string | null;
    messageCount: number;
  }>;
  traces: MemoryRetrievalTrace[];
}

export interface MemoryGraphNode extends MemoryOverviewRecord {
  label: string;
  size: number;
  energy: number;
  colorKey: string;
}

export interface MemoryGraphCluster {
  id: string;
  label: string;
  kind: "self" | "workspace" | "world" | "session" | "constraint";
  nodeCount: number;
  energy: number;
  dominantType: MemoryItem["memoryType"];
}

export interface MemoryGraphLink {
  source: string;
  target: string;
  weight: number;
  pulseRate: number;
  sharedTags: string[];
  reasons: string[];
}

export interface MemoryGraphPayload {
  generatedAt: string;
  stats: {
    totalMemories: number;
    visibleNodes: number;
    visibleLinks: number;
    staleNodes: number;
    activeNodes: number;
    clusterCount: number;
    activeTraceCount: number;
  };
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  clusters: MemoryGraphCluster[];
}

interface EnrichedMemoryRecord extends MemoryOverviewRecord {
  nodeSortScore: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const STATUS_RANK: Record<MemoryOverviewRecord["status"], number> = {
  active: 4,
  expired: 3,
  forgotten: 2,
  superseded: 1,
};

export function buildMemoryOverview(input: {
  items: MemoryItem[];
  sessions: MemorySession[];
  edges: MemoryEdge[];
  traces: MemoryRetrievalTrace[];
  maintenance: {
    replay: MemoryReplayState;
  };
  now?: string;
}): MemoryOverviewPayload {
  const now = input.now ?? new Date().toISOString();
  const activationById = buildActivationById(input.traces, now);
  const persistentItems = input.items.filter(isPersistentVisualMemoryItem);
  const records = persistentItems.map((item) => enrichMemoryItem(item, activationById.get(item.id) ?? 0, now));

  return {
    generatedAt: now,
    summary: {
      totalMemories: records.length,
      activeMemories: records.filter((item) => item.status === "active").length,
      staleMemories: records.filter((item) => item.status === "expired" || item.needsRevalidation).length,
      supersededMemories: records.filter((item) => item.status === "superseded").length,
      forgottenMemories: records.filter((item) => item.status === "forgotten").length,
      activeSessions: 0,
      archivedSessions: 0,
      recentTraceCount: input.traces.length,
      explicitEdgeCount: input.edges.length,
      replayEdgeCount: input.edges.filter((edge) => !["derived_from", "supersedes"].includes(edge.relation)).length,
    },
    maintenance: input.maintenance,
    recentMemories: sortForFreshness(records).slice(0, 14),
    profileMemories: sortForFreshness(
      records.filter((item) => item.scope === "user" && item.status === "active"),
    ).slice(0, 12),
    sessionMemories: [],
    staleMemories: sortForFreshness(
      records.filter((item) => item.status !== "active" || item.needsRevalidation),
    ).slice(0, 12),
    sessions: [],
    traces: input.traces.slice(0, 12),
  };
}

export function buildMemoryGraph(input: {
  items: MemoryItem[];
  sessions: MemorySession[];
  edges: MemoryEdge[];
  traces: MemoryRetrievalTrace[];
  limit?: number;
  now?: string;
}): MemoryGraphPayload {
  const now = input.now ?? new Date().toISOString();
  const activationById = buildActivationById(input.traces, now);
  const persistentItems = input.items.filter(isPersistentVisualMemoryItem);
  const allRecords = persistentItems.map((item) => enrichMemoryItem(item, activationById.get(item.id) ?? 0, now));
  const sorted = [...allRecords].sort((left, right) => right.nodeSortScore - left.nodeSortScore);
  const limit = Math.max(24, Math.min(320, input.limit ?? 220));
  const selected = sorted.slice(0, limit);
  const coActivation = buildCoActivationMap(input.traces, now);
  const links = buildGraphLinks(selected, coActivation, input.edges).slice(0, Math.max(180, limit * 4));
  const clusterById = new Map<string, MemoryGraphCluster>();

  const nodes: MemoryGraphNode[] = selected.map((item) => {
    const size = 1.9 + item.salience * 4.2 + Math.min(1.8, item.reinforcementCount * 0.16);
    const energy = Math.min(1, item.activation * 0.28 + (item.status === "active" ? 0.35 : 0.14));
    const colorKey = item.memoryType;

    const cluster = clusterById.get(item.clusterId);
    if (cluster) {
      cluster.nodeCount += 1;
      cluster.energy += energy;
    } else {
      clusterById.set(item.clusterId, {
        id: item.clusterId,
        label: item.clusterLabel,
        kind: getClusterKind(item),
        nodeCount: 1,
        energy,
        dominantType: item.memoryType,
      });
    }

    return {
      ...item,
      label: buildNodeLabel(item),
      size,
      energy,
      colorKey,
    };
  });

  const clusters = [...clusterById.values()]
    .map((cluster) => ({
      ...cluster,
      energy: Number((cluster.energy / Math.max(cluster.nodeCount, 1)).toFixed(3)),
    }))
    .sort((left, right) => right.energy - left.energy || right.nodeCount - left.nodeCount);

  return {
    generatedAt: now,
    stats: {
      totalMemories: allRecords.length,
      visibleNodes: nodes.length,
      visibleLinks: links.length,
      staleNodes: nodes.filter((node) => node.status !== "active" || node.needsRevalidation).length,
      activeNodes: nodes.filter((node) => node.status === "active").length,
      clusterCount: clusters.length,
      activeTraceCount: input.traces.length,
    },
    nodes,
    links,
    clusters,
  };
}

function isPersistentVisualMemoryItem(item: MemoryItem): boolean {
  if (item.memoryType === "episode_summary") {
    return false;
  }
  if (item.sourceType === "session_summary" && item.memoryType !== "procedure") {
    return false;
  }
  return true;
}

function enrichMemoryItem(item: MemoryItem, activation: number, now: string): EnrichedMemoryRecord {
  const metadata = getItemInternalMetadata(item);
  const governance = getMemoryGovernanceState(item);
  const status = getMemoryStatus(item, now);
  const cluster = getClusterDescriptor(item);
  const needsRevalidation = Boolean(
    metadata.revalidationDueAt &&
      new Date(metadata.revalidationDueAt).getTime() < new Date(now).getTime() &&
      status === "active",
  );
  const updatedKey = item.observedAt ?? item.updatedAt ?? item.createdAt;
  const freshnessWeight = getFreshnessWeight(updatedKey, now);
  const governanceWeight =
    governance.approvalStatus === "approved"
      ? 0.45
      : governance.approvalStatus === "pending"
        ? -0.08
        : governance.approvalStatus === "disputed"
          ? -0.4
          : governance.approvalStatus === "rejected"
            ? -0.9
            : 0;
  const nodeSortScore =
    STATUS_RANK[status] * 5 +
    item.salience * 2.2 +
    item.confidence * 1.8 +
    activation * 2.6 +
    Math.min(1.3, metadata.reinforcementCount * 0.14) +
    freshnessWeight +
    governanceWeight;

  return {
    id: item.id,
    sessionId: item.sessionId,
    content: item.content,
    memoryType: item.memoryType,
    scope: item.scope,
    sourceType: item.sourceType,
    sourceRef: item.sourceRef,
    sourceLabel: getSourceLabel(item.sourceRef),
    volatility: item.volatility,
    confidence: item.confidence,
    salience: item.salience,
    status,
    tags: [...item.tags],
    updatedAt: item.updatedAt,
    observedAt: item.observedAt,
    validUntil: item.validUntil,
    reinforcementCount: metadata.reinforcementCount,
    lastReinforcedAt: metadata.lastReinforcedAt,
    revalidationDueAt: metadata.revalidationDueAt,
    needsRevalidation,
    approvalStatus: governance.approvalStatus,
    contradictionCount: governance.contradictionCount,
    contradictionSessionCount: governance.contradictionSessionCount,
    approvedAt: governance.approvedAt,
    clusterId: cluster.id,
    clusterLabel: cluster.label,
    activation,
    nodeSortScore,
  };
}

function buildActivationById(traces: MemoryRetrievalTrace[], now: string): Map<string, number> {
  const nowMs = new Date(now).getTime();
  const activation = new Map<string, number>();

  for (const trace of traces) {
    const traceMs = new Date(trace.createdAt).getTime();
    const ageHours = Number.isFinite(traceMs) ? Math.max(0, (nowMs - traceMs) / (60 * 60 * 1_000)) : 0;
    const decay = Math.max(0.2, Math.exp((-Math.LN2 * ageHours) / 18));
    for (const result of trace.results) {
      activation.set(
        result.memoryId,
        (activation.get(result.memoryId) ?? 0) + decay * Math.max(0.25, result.score),
      );
    }
  }

  return activation;
}

function buildCoActivationMap(traces: MemoryRetrievalTrace[], now: string): Map<string, number> {
  const nowMs = new Date(now).getTime();
  const pairs = new Map<string, number>();

  for (const trace of traces) {
    const traceMs = new Date(trace.createdAt).getTime();
    const ageHours = Number.isFinite(traceMs) ? Math.max(0, (nowMs - traceMs) / (60 * 60 * 1_000)) : 0;
    const decay = Math.max(0.2, Math.exp((-Math.LN2 * ageHours) / 18));
    const ids = [...new Set(trace.results.map((result) => result.memoryId))];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = buildPairKey(ids[i]!, ids[j]!);
        pairs.set(key, (pairs.get(key) ?? 0) + decay);
      }
    }
  }

  return pairs;
}

function buildGraphLinks(
  items: EnrichedMemoryRecord[],
  coActivation: Map<string, number>,
  edges: MemoryEdge[],
): MemoryGraphLink[] {
  const links: MemoryGraphLink[] = [];
  const selectedIds = new Set(items.map((item) => item.id));
  const explicitEdges = buildExplicitEdgeIndex(edges, selectedIds);

  for (let index = 0; index < items.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
      const left = items[index]!;
      const right = items[nextIndex]!;
      const reasons: string[] = [];
      let weight = 0;
      const explicit = explicitEdges.get(buildPairKey(left.id, right.id));

      if (explicit) {
        weight += explicit.weight;
        reasons.push(...explicit.reasons);
      }

      if (left.clusterId === right.clusterId) {
        weight += 0.24;
        reasons.push("cluster");
      }

      if (left.sessionId && left.sessionId === right.sessionId) {
        weight += 0.24;
        reasons.push("session");
      }

      if (left.scope === right.scope) {
        weight += 0.08;
        reasons.push("scope");
      }

      if (left.sourceRef && left.sourceRef === right.sourceRef) {
        weight += 0.24;
        reasons.push("source");
      }

      if (left.memoryType === right.memoryType) {
        weight += 0.12;
        reasons.push("type");
      }

      const sharedTags = left.tags.filter((tag) => right.tags.includes(tag)).slice(0, 4);
      if (sharedTags.length > 0) {
        weight += Math.min(0.36, sharedTags.length * 0.1);
        reasons.push(`tags:${sharedTags.join(",")}`);
      }

      const coFire = coActivation.get(buildPairKey(left.id, right.id)) ?? 0;
      if (coFire > 0) {
        weight += Math.min(0.45, coFire * 0.16);
        reasons.push("co-fire");
      }

      if (left.id === right.id || weight < 0.34) {
        continue;
      }

      links.push({
        source: left.id,
        target: right.id,
        weight: Number(weight.toFixed(3)),
        pulseRate: Number((0.0016 + weight * 0.004 + coFire * 0.0012).toFixed(4)),
        sharedTags,
        reasons,
      });
    }
  }

  return links.sort((left, right) => right.weight - left.weight);
}

function buildExplicitEdgeIndex(
  edges: MemoryEdge[],
  selectedIds: Set<string>,
): Map<string, { weight: number; reasons: string[] }> {
  const index = new Map<string, { weight: number; reasons: string[] }>();

  for (const edge of edges) {
    if (!selectedIds.has(edge.fromId) || !selectedIds.has(edge.toId) || edge.fromId === edge.toId) {
      continue;
    }

    const key = buildPairKey(edge.fromId, edge.toId);
    const existing = index.get(key);
    const reason = `edge:${edge.relation}`;
    const weight = existing ? existing.weight : 0;
    const nextWeight = Math.min(0.78, weight + getExplicitEdgeWeight(edge.relation));
    const nextReasons = existing ? [...new Set([...existing.reasons, reason])] : [reason];
    index.set(key, {
      weight: Number(nextWeight.toFixed(3)),
      reasons: nextReasons,
    });
  }

  return index;
}

function getExplicitEdgeWeight(relation: MemoryEdge["relation"]): number {
  switch (relation) {
    case "reinforces":
      return 0.36;
    case "contradicts":
      return 0.42;
    case "about_user":
    case "about_project":
      return 0.28;
    case "derived_from":
      return 0.24;
    case "supersedes":
      return 0.3;
  }
}

function getClusterDescriptor(item: MemoryItem): { id: string; label: string } {
  if (item.memoryType === "user_profile" || item.memoryType === "user_preference") {
    return {
      id: `self:${item.memoryType}`,
      label: item.memoryType === "user_profile" ? "Self model" : "Preference cortex",
    };
  }

  if (item.memoryType === "episode_summary" || item.memoryType === "task_outcome" || item.memoryType === "warning_or_constraint") {
    const sessionKey = item.sessionId ?? item.id;
    return {
      id: `session:${sessionKey}`,
      label: "Session archive",
    };
  }

  if (item.scope === "workspace") {
    return {
      id: `workspace:${item.memoryType}`,
      label:
        item.memoryType === "project_fact"
          ? "Workspace schema"
          : item.memoryType === "procedure"
            ? "Procedure memory"
            : "Environment model",
    };
  }

  if (item.scope === "global") {
    const sourceLabel = getSourceLabel(item.sourceRef);
    return {
      id: sourceLabel ? `world:${sourceLabel}` : `world:${item.memoryType}`,
      label: sourceLabel ? `World watch · ${sourceLabel}` : "World watch",
    };
  }

  return {
    id: `memory:${item.scope}:${item.memoryType}`,
    label: "General memory",
  };
}

function getClusterKind(item: EnrichedMemoryRecord): MemoryGraphCluster["kind"] {
  if (item.scope === "user") return "self";
  if (item.scope === "workspace") return "workspace";
  if (item.scope === "global") return "world";
  if (item.memoryType === "warning_or_constraint") return "constraint";
  return "session";
}

function buildNodeLabel(item: EnrichedMemoryRecord): string {
  if (item.memoryType === "user_profile") return "Self";
  if (item.memoryType === "user_preference") return "Preference";
  if (item.memoryType === "episode_summary") return "Session";
  if (item.memoryType === "task_outcome") return "Outcome";
  if (item.memoryType === "warning_or_constraint") return "Constraint";
  if (item.memoryType === "procedure") return "Procedure";
  if (item.memoryType === "world_fact") return item.sourceLabel || "World fact";
  return item.memoryType.replace(/_/g, " ");
}

function getMemoryStatus(item: MemoryItem, now: string): MemoryOverviewRecord["status"] {
  if (item.supersededById) {
    return "superseded";
  }

  const jsonValue = item.jsonValue;
  const forgotten = Boolean(
    jsonValue &&
      typeof jsonValue === "object" &&
      !Array.isArray(jsonValue) &&
      "forgotten" in jsonValue &&
      jsonValue.forgotten === true,
  );
  if (forgotten) {
    return "forgotten";
  }

  if (item.validUntil) {
    const validUntilMs = new Date(item.validUntil).getTime();
    if (Number.isFinite(validUntilMs) && validUntilMs < new Date(now).getTime()) {
      return "expired";
    }
  }

  return "active";
}

function sortForFreshness(items: EnrichedMemoryRecord[]): MemoryOverviewRecord[] {
  return [...items].sort((left, right) => {
    const leftKey = left.observedAt ?? left.updatedAt;
    const rightKey = right.observedAt ?? right.updatedAt;
    return (
      right.activation - left.activation ||
      STATUS_RANK[right.status] - STATUS_RANK[left.status] ||
      rightKey.localeCompare(leftKey)
    );
  });
}

function getFreshnessWeight(reference: string | null, now: string): number {
  if (!reference) {
    return 0;
  }
  const referenceMs = new Date(reference).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(referenceMs) || !Number.isFinite(nowMs)) {
    return 0;
  }

  const ageDays = Math.max(0, (nowMs - referenceMs) / DAY_MS);
  return Math.max(0, 1.5 - ageDays / 30);
}

function getSourceLabel(sourceRef: string | null): string {
  if (!sourceRef) {
    return "";
  }
  try {
    const url = new URL(sourceRef);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return sourceRef;
  }
}

function buildPairKey(left: string, right: string): string {
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}
