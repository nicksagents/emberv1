import { getHistorySummaryMessage, isHistorySummaryMessage } from "../conversation-compaction";
import type { ChatMessage, Conversation } from "../types";
import { defaultMemoryConfig } from "./defaults";
import { extractProcedureMemory } from "./procedures";
import type {
  MemoryConfig,
  MemoryItem,
  MemoryRepository,
  MemoryScope,
  MemorySession,
  MemorySourceType,
  MemoryWriteCandidate,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

const WORLD_EVENT_KEYWORDS = [
  "announced",
  "approved",
  "banned",
  "bill",
  "changed",
  "court",
  "election",
  "event",
  "launched",
  "law",
  "passed",
  "policy",
  "regulation",
  "released",
  "signed",
  "treaty",
  "updated",
];

const TOPIC_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "allow",
  "also",
  "because",
  "before",
  "being",
  "build",
  "chat",
  "conversation",
  "ember",
  "feature",
  "from",
  "have",
  "into",
  "just",
  "like",
  "make",
  "memory",
  "more",
  "need",
  "onto",
  "please",
  "project",
  "really",
  "should",
  "that",
  "their",
  "them",
  "this",
  "through",
  "user",
  "want",
  "with",
  "work",
  "continue",
  "continuing",
  "plan",
  "same",
]);

const ACTIVE_SUMMARY_MIN_NEW_TOPIC_TERMS = 3;
const ACTIVE_SUMMARY_MIN_LENGTH_DELTA = 96;
const ACTIVE_SUMMARY_MAX_OVERLAP_RATIO = 0.72;

export interface MemoryToolObservation {
  toolName: string;
  input: Record<string, unknown>;
  resultText: string;
  createdAt: string;
  sourceRef: string | null;
  sourceType: Extract<MemorySourceType, "tool_result" | "web_page">;
  command: string | null;
  workingDirectory: string | null;
  targetPath: string | null;
  queryText: string | null;
  exitCode: number | null;
}

export interface ConversationMemoryConsolidationInput {
  conversation: Conversation;
  toolObservations?: MemoryToolObservation[];
  config?: MemoryConfig;
  now?: string;
  lifecycle?: "active" | "archived";
  endReason?: "archived" | "deleted" | "reset" | "completed" | null;
}

export interface ConversationMemoryConsolidationResult {
  session: MemorySession;
  summaryItem: MemoryItem | null;
  writtenItems: MemoryItem[];
  reinforcedItems: MemoryItem[];
}

interface PendingReinforcement {
  id: string;
  salienceDelta?: number;
  confidenceDelta?: number;
  extendValidity?: boolean;
  revalidationDueAt?: string | null;
}

interface PendingSemanticEdgePlan {
  memoryId: string | null;
  candidateSignature: string | null;
  supportItemIds: string[];
  supersedesId: string | null;
}

interface SemanticDistillationResult {
  candidates: MemoryWriteCandidate[];
  edgePlans: PendingSemanticEdgePlan[];
}

interface DistilledSemanticFact {
  memoryType: "project_fact" | "environment_fact";
  key: string;
  content: string;
  jsonValue?: Record<string, unknown> | null;
  tags: string[];
  sourceType: MemorySourceType;
  sourceRef?: string | null;
  confidence: number;
  salience: number;
  volatility: "stable" | "slow-changing";
  observedAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  revalidationDueAt?: string | null;
}

export async function consolidateConversationMemory(
  repository: MemoryRepository,
  input: ConversationMemoryConsolidationInput,
): Promise<ConversationMemoryConsolidationResult> {
  const config = input.config ?? defaultMemoryConfig();
  const now = input.now ?? new Date().toISOString();
  const lifecycle = input.lifecycle ?? "active";
  const endReason = input.endReason ?? null;
  const sessionId = input.conversation.id;
  const existingSession = await repository.getSession(sessionId);
  const existingItems = await repository.listItems({ includeSuperseded: false });
  const toolObservations = input.toolObservations ?? [];
  const reinforcements: PendingReinforcement[] = [];
  const summary = buildSessionSummary(input.conversation.messages, toolObservations, {
    lifecycle,
    endReason,
  });
  const topics = extractSessionTopics(input.conversation.messages, toolObservations);
  const cueTags = buildConversationCueTags(input.conversation.messages, toolObservations, topics);
  const session = await repository.upsertSession({
    id: sessionId,
    conversationId: input.conversation.id,
    startedAt: existingSession?.startedAt ?? input.conversation.createdAt,
    endedAt: lifecycle === "archived" ? now : null,
    summary,
    topics,
    messageCount: input.conversation.messageCount,
    lastMessageAt: input.conversation.lastMessageAt,
  });

  if (!config.enabled || !config.consolidation.enabled) {
    return {
      session,
      summaryItem: null,
      writtenItems: [],
      reinforcedItems: [],
    };
  }

  const scope = inferConversationScope(input.conversation.messages, toolObservations);
  const candidates: MemoryWriteCandidate[] = [];
  const summaryItem = buildSessionSummaryCandidate(
    sessionId,
    scope,
    summary,
    existingItems,
    input.conversation.id,
    lifecycle,
    endReason,
    lifecycle === "archived" ? now : null,
    cueTags,
  );
  if (summaryItem) {
    candidates.push(summaryItem);
  }

  if (config.consolidation.autoExtractUserFacts) {
    candidates.push(
      ...extractUserMemoryCandidates(sessionId, input.conversation.messages, existingItems, reinforcements),
    );
  }

  if (config.consolidation.autoExtractWorldFacts) {
    candidates.push(
      ...extractWorldMemoryCandidates(sessionId, toolObservations, existingItems, now, reinforcements),
    );
  }

  const semanticDistillation = extractSemanticDistillation(
    sessionId,
    input.conversation.messages,
    toolObservations,
    existingItems,
    scope,
    now,
    reinforcements,
  );
  candidates.push(...semanticDistillation.candidates);
  const procedureMemory = extractProcedureMemory({
    sessionId,
    messages: input.conversation.messages,
    toolObservations,
    existingItems,
    scope,
  });
  candidates.push(...procedureMemory.candidates);

  if (lifecycle === "archived") {
    candidates.push(
      ...extractSessionLifecycleCandidates(
        sessionId,
        input.conversation.messages,
        existingItems,
        scope,
        endReason,
        now,
        cueTags,
      ),
    );
  }

  const limitedCandidates = prioritizeMemoryWriteCandidates(
    candidates,
    config.consolidation.maxWriteCandidatesPerTurn,
  );
  const writtenItems =
    limitedCandidates.length > 0 ? await repository.upsertItems(limitedCandidates) : [];
  const reinforcedItems = await reinforceMemoryItems(repository, reinforcements, now);
  const writtenSummaryItem =
    summaryItem === null
      ? null
      : writtenItems.find(
          (item) =>
            item.sessionId === sessionId &&
            item.memoryType === "episode_summary" &&
            item.sourceType === "session_summary",
        ) ?? null;

  await persistDerivedEdges(
    repository,
    writtenItems,
    semanticDistillation.edgePlans,
    writtenSummaryItem,
  );
  await persistDerivedEdges(
    repository,
    writtenItems,
    procedureMemory.edgePlans,
    writtenSummaryItem,
  );

  return {
    session,
    summaryItem: writtenSummaryItem,
    writtenItems: [...writtenItems, ...reinforcedItems],
    reinforcedItems,
  };
}

export function buildMemoryRetrievalQuery(content: string, conversation: ChatMessage[]): string {
  const recentMessages = conversation
    .filter((message) => !isHistorySummaryMessage(message))
    .slice(-6);
  const candidates = [
    content,
    ...recentMessages
      .filter((message) => message.role === "user")
      .slice(-2)
      .map((message) => message.content),
    ...recentMessages
      .filter((message) => message.role === "assistant")
      .slice(-1)
      .map((message) => summarizeText(message.content, 220)),
  ];

  return [...new Set(candidates.map((value) => normalizeWhitespace(value)).filter(Boolean))].join("\n");
}

export function buildSessionSummary(
  messages: ChatMessage[],
  toolObservations: MemoryToolObservation[] = [],
  options: {
    lifecycle?: "active" | "archived";
    endReason?: "archived" | "deleted" | "reset" | "completed" | null;
  } = {},
): string {
  const historySummary = getHistorySummaryMessage(messages);
  const visibleMessages = messages.filter((message) => !isHistorySummaryMessage(message));
  const lastUserMessage = findLastSubstantiveMessage(visibleMessages, "user");
  const lastAssistantMessage = findLastSubstantiveMessage(visibleMessages, "assistant");
  const highlights = extractSessionHighlights(visibleMessages);
  const observedSources = toolObservations
    .filter((observation) => observation.sourceRef)
    .slice(-2)
    .map((observation) => {
      const source = getSourceLabel(observation.sourceRef);
      const note = summarizeText(extractObservationHeadline(observation.resultText), 120);
      return note ? `${source}: ${note}` : source;
    });

  const parts = [
    lastUserMessage ? `Goal: ${summarizeText(lastUserMessage.content, 180)}` : "",
    historySummary ? `Working memory: ${summarizeText(historySummary.content, 180)}` : "",
    highlights.length > 0 ? `Highlights: ${highlights.join("; ")}` : "",
    observedSources.length > 0 ? `Observed sources: ${observedSources.join("; ")}` : "",
    lastAssistantMessage ? `Latest outcome: ${summarizeText(lastAssistantMessage.content, 180)}` : "",
    options.lifecycle === "archived"
      ? `Session status: archived${options.endReason ? ` (${options.endReason})` : ""}.`
      : "",
  ].filter(Boolean);

  return parts.join(" ");
}

function buildSessionSummaryCandidate(
  sessionId: string,
  scope: MemoryScope,
  summary: string,
  existingItems: MemoryItem[],
  conversationId: string,
  lifecycle: "active" | "archived",
  endReason: "archived" | "deleted" | "reset" | "completed" | null,
  endedAt: string | null,
  cueTags: string[],
): MemoryWriteCandidate | null {
  if (!summary) {
    return null;
  }

  const existingSummary = existingItems.find(
    (item) =>
      item.sessionId === sessionId &&
      item.memoryType === "episode_summary" &&
      item.sourceType === "session_summary" &&
      !item.supersededById,
  );
  if (existingSummary?.content === summary) {
    return null;
  }
  if (
    lifecycle !== "archived" &&
    existingSummary &&
    !hasMeaningfulActiveSummaryChange(existingSummary.content, summary)
  ) {
    return null;
  }

  return {
    sessionId,
    memoryType: "episode_summary",
    scope,
    content: summary,
    jsonValue: {
      key: "session_summary",
      conversationId,
      lifecycle,
      endReason,
      endedAt,
    },
    tags: ["session", "summary", scope, ...cueTags],
    sourceType: "session_summary",
    confidence: 0.82,
    salience: scope === "workspace" ? 0.72 : 0.68,
    volatility: "event",
    supersedesId: existingSummary?.id ?? null,
  };
}

function hasMeaningfulActiveSummaryChange(previousSummary: string, nextSummary: string): boolean {
  const normalizedPrevious = normalizeWhitespace(previousSummary);
  const normalizedNext = normalizeWhitespace(nextSummary);
  if (!normalizedPrevious || !normalizedNext || normalizedPrevious === normalizedNext) {
    return false;
  }

  const previousSections = extractSummarySections(normalizedPrevious);
  const nextSections = extractSummarySections(normalizedNext);
  const stableSectionsChanged = ["Working memory", "Highlights", "Observed sources", "Session status"].some(
    (label) => (previousSections[label] ?? "") !== (nextSections[label] ?? ""),
  );
  if (
    !stableSectionsChanged &&
    isGenericContinuationSummaryValue(nextSections.Goal) &&
    isGenericContinuationSummaryValue(nextSections["Latest outcome"])
  ) {
    return false;
  }

  const previousTerms = new Set(tokenizeForTopics(normalizedPrevious));
  const nextTerms = new Set(tokenizeForTopics(normalizedNext));
  const sharedTermCount = [...nextTerms].filter((term) => previousTerms.has(term)).length;
  const overlapRatio =
    Math.max(previousTerms.size, nextTerms.size) > 0
      ? sharedTermCount / Math.max(previousTerms.size, nextTerms.size)
      : 1;
  const newTermCount = [...nextTerms].filter((term) => !previousTerms.has(term)).length;
  const removedTermCount = [...previousTerms].filter((term) => !nextTerms.has(term)).length;
  const lengthDelta = Math.abs(normalizedNext.length - normalizedPrevious.length);

  return (
    newTermCount >= ACTIVE_SUMMARY_MIN_NEW_TOPIC_TERMS ||
    removedTermCount >= ACTIVE_SUMMARY_MIN_NEW_TOPIC_TERMS ||
    lengthDelta >= ACTIVE_SUMMARY_MIN_LENGTH_DELTA ||
    overlapRatio <= ACTIVE_SUMMARY_MAX_OVERLAP_RATIO
  );
}

function extractSummarySections(summary: string): Record<string, string> {
  const labels = [
    "Goal",
    "Working memory",
    "Highlights",
    "Observed sources",
    "Latest outcome",
    "Session status",
  ];
  const sections: Record<string, string> = {};

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    const marker = `${label}: `;
    const start = summary.indexOf(marker);
    if (start === -1) {
      continue;
    }
    const contentStart = start + marker.length;
    const nextMarkers = labels
      .slice(index + 1)
      .map((candidate) => {
        const nextStart = summary.indexOf(`${candidate}: `, contentStart);
        return nextStart === -1 ? Number.POSITIVE_INFINITY : nextStart;
      });
    const end = Math.min(...nextMarkers);
    sections[label] = normalizeWhitespace(
      summary.slice(contentStart, Number.isFinite(end) ? end : summary.length),
    );
  }

  return sections;
}

function isGenericContinuationSummaryValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return /\b(continue|continuing|same plan|carry on|keep going|proceed)\b/.test(normalized);
}

function prioritizeMemoryWriteCandidates(
  candidates: MemoryWriteCandidate[],
  limit: number,
): MemoryWriteCandidate[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const seen = new Set<string>();
  const perGroupCounts = new Map<string, number>();
  const ordered = [...candidates]
    .filter((candidate) => candidate.content.trim().length > 0)
    .sort((left, right) => {
      const priorityDelta = getWritePriority(right) - getWritePriority(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      const salienceDelta = (right.salience ?? 0) - (left.salience ?? 0);
      if (salienceDelta !== 0) {
        return salienceDelta;
      }
      const confidenceDelta = (right.confidence ?? 0) - (left.confidence ?? 0);
      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }
      return left.content.localeCompare(right.content);
    });

  const kept: MemoryWriteCandidate[] = [];
  for (const candidate of ordered) {
    if (kept.length >= normalizedLimit) {
      break;
    }

    const dedupeKey = buildWriteCandidateDedupeKey(candidate);
    if (seen.has(dedupeKey)) {
      continue;
    }

    const group = getWriteCandidateGroup(candidate);
    const groupCount = perGroupCounts.get(group) ?? 0;
    if (groupCount >= getWriteCandidateGroupCap(group)) {
      continue;
    }

    kept.push(candidate);
    seen.add(dedupeKey);
    perGroupCounts.set(group, groupCount + 1);
  }

  return kept;
}

function getWritePriority(candidate: MemoryWriteCandidate): number {
  switch (candidate.memoryType) {
    case "user_profile":
      return 120;
    case "user_preference":
      return 116;
    case "project_fact":
      return 112;
    case "environment_fact":
      return 104;
    case "procedure":
      return candidate.jsonValue?.published === true ? 108 : 94;
    case "world_fact":
      return 96;
    case "warning_or_constraint":
      return 92;
    case "task_outcome":
      return 90;
    case "episode_summary":
      return candidate.jsonValue?.lifecycle === "archived" ? 88 : 72;
  }
  return 0;
}

function getWriteCandidateGroup(candidate: MemoryWriteCandidate): string {
  switch (candidate.memoryType) {
    case "user_profile":
    case "user_preference":
      return "user";
    case "project_fact":
    case "environment_fact":
      return "semantic";
    case "world_fact":
      return "world";
    case "procedure":
      return "procedure";
    case "episode_summary":
      return "session";
    case "task_outcome":
    case "warning_or_constraint":
      return "lifecycle";
  }
  return "other";
}

function getWriteCandidateGroupCap(group: string): number {
  switch (group) {
    case "user":
      return 2;
    case "semantic":
      return 3;
    case "world":
      return 1;
    case "procedure":
      return 1;
    case "session":
      return 1;
    case "lifecycle":
      return 3;
    default:
      return 1;
  }
}

function buildWriteCandidateDedupeKey(candidate: MemoryWriteCandidate): string {
  const key =
    candidate.jsonValue &&
    typeof candidate.jsonValue === "object" &&
    !Array.isArray(candidate.jsonValue) &&
    typeof candidate.jsonValue.key === "string"
      ? candidate.jsonValue.key
      : "";
  return [
    candidate.memoryType,
    candidate.scope,
    candidate.sourceType,
    key,
    normalizeWhitespace(candidate.content).toLowerCase(),
  ].join("::");
}

function extractUserMemoryCandidates(
  sessionId: string,
  messages: ChatMessage[],
  existingItems: MemoryItem[],
  reinforcements: PendingReinforcement[],
): MemoryWriteCandidate[] {
  const candidates: MemoryWriteCandidate[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const dob = extractDateOfBirth(message.content);
    if (dob) {
      const signature = `dob:${dob}`;
      if (!seen.has(signature)) {
        seen.add(signature);
        const existingDob = existingItems.find(
          (item) =>
            item.memoryType === "user_profile" &&
            typeof item.jsonValue?.dateOfBirth === "string" &&
            !item.supersededById,
        );
        if (existingDob?.jsonValue?.dateOfBirth === dob) {
          queueReinforcement(reinforcements, {
            id: existingDob.id,
            confidenceDelta: 0.01,
            salienceDelta: 0.02,
          });
        } else {
          candidates.push({
            sessionId,
            memoryType: "user_profile",
            scope: "user",
            content: `User date of birth is ${dob}.`,
            jsonValue: {
              key: "date_of_birth",
              dateOfBirth: dob,
            },
            tags: ["birthday", "dob", "profile"],
            sourceType: "user_message",
            confidence: 0.99,
            salience: 0.98,
            volatility: "stable",
            supersedesId: existingDob?.id ?? null,
          });
        }
      }
    }

    const preference = extractResponseStylePreference(message.content);
    if (!preference) {
      continue;
    }

    const signature = `preference:${preference.value}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    const existingPreference = existingItems.find(
      (item) =>
        item.memoryType === "user_preference" &&
        item.jsonValue?.key === "response_style" &&
        !item.supersededById,
    );
    if (existingPreference?.jsonValue?.value === preference.value) {
      queueReinforcement(reinforcements, {
        id: existingPreference.id,
        confidenceDelta: 0.01,
        salienceDelta: 0.02,
      });
      continue;
    }

    candidates.push({
      sessionId,
      memoryType: "user_preference",
      scope: "user",
      content: preference.content,
      jsonValue: {
        key: "response_style",
        value: preference.value,
      },
      tags: ["preference", "response-style", preference.value],
      sourceType: "user_message",
      confidence: 0.88,
      salience: 0.83,
      volatility: "slow-changing",
      supersedesId: existingPreference?.id ?? null,
    });
  }

  return candidates;
}

function extractWorldMemoryCandidates(
  sessionId: string,
  observations: MemoryToolObservation[],
  existingItems: MemoryItem[],
  now: string,
  reinforcements: PendingReinforcement[],
): MemoryWriteCandidate[] {
  const candidates: MemoryWriteCandidate[] = [];
  const seen = new Set<string>();

  for (const observation of observations) {
    if (observation.sourceType !== "web_page" || !observation.sourceRef) {
      continue;
    }
    if (isLocalSource(observation.sourceRef) || isErrorResult(observation.resultText)) {
      continue;
    }

    const extracted = extractWorldFact(observation);
    if (!extracted) {
      continue;
    }
    const timing = buildWorldFactTiming(observation.createdAt || now, extracted.volatility);

    const signature = `${observation.sourceRef}|${normalizeWhitespace(extracted.content).toLowerCase()}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    const existingMatch = existingItems.find(
      (item) =>
        item.memoryType === "world_fact" &&
        item.sourceRef === observation.sourceRef &&
        normalizeWhitespace(item.content).toLowerCase() === normalizeWhitespace(extracted.content).toLowerCase() &&
        !item.supersededById,
    );
    if (existingMatch) {
      queueReinforcement(reinforcements, {
        id: existingMatch.id,
        confidenceDelta: 0.02,
        salienceDelta: 0.03,
        extendValidity: true,
        revalidationDueAt: timing.revalidationDueAt,
      });
      continue;
    }

    candidates.push({
      sessionId,
      memoryType: "world_fact",
      scope: "global",
      content: extracted.content,
      jsonValue: {
        key: "world_fact",
        toolName: observation.toolName,
        title: extracted.title,
      },
      tags: [...extracted.tags, `tool:${normalizeCueTag(observation.toolName)}`],
      sourceType: "web_page",
      sourceRef: observation.sourceRef,
      confidence: extracted.confidence,
      salience: extracted.salience,
      volatility: extracted.volatility,
      observedAt: observation.createdAt || now,
      validFrom: observation.createdAt || now,
      validUntil: timing.validUntil,
      revalidationDueAt: timing.revalidationDueAt,
    });
  }

  return candidates;
}

function extractSemanticDistillation(
  sessionId: string,
  messages: ChatMessage[],
  observations: MemoryToolObservation[],
  existingItems: MemoryItem[],
  scope: MemoryScope,
  now: string,
  reinforcements: PendingReinforcement[],
): SemanticDistillationResult {
  if (scope !== "workspace" && observations.length === 0) {
    return { candidates: [], edgePlans: [] };
  }

  const candidates: MemoryWriteCandidate[] = [];
  const edgePlans: PendingSemanticEdgePlan[] = [];
  const seenKeys = new Set<string>();
  const messageFacts = extractProjectConstraintSemanticFacts(messages, existingItems, scope);

  for (const fact of messageFacts) {
    seenKeys.add(fact.key);
    const supportItemIds = findSupportingEpisodeIds(existingItems, sessionId, fact);
    const plan = planSemanticFact(sessionId, fact, existingItems, reinforcements, supportItemIds);
    if (!plan) {
      continue;
    }
    if (plan.candidate) {
      candidates.push(plan.candidate);
    }
    edgePlans.push(plan.edgePlan);
  }

  for (const observation of observations) {
    const facts = [
      ...extractProjectOverviewSemanticFacts(observation),
      ...extractFileDerivedSemanticFacts(observation),
      ...extractEnvironmentVersionFacts(observation),
    ];

    for (const fact of facts) {
      if (seenKeys.has(fact.key)) {
        continue;
      }
      seenKeys.add(fact.key);

      const supportItemIds = findSupportingEpisodeIds(existingItems, sessionId, fact);
      const plan = planSemanticFact(sessionId, fact, existingItems, reinforcements, supportItemIds);
      if (!plan) {
        continue;
      }
      if (plan.candidate) {
        candidates.push(plan.candidate);
      }
      edgePlans.push(plan.edgePlan);
    }
  }

  for (const fact of extractProjectCommandFacts(observations, existingItems)) {
    if (seenKeys.has(fact.key)) {
      continue;
    }
    seenKeys.add(fact.key);

    const supportItemIds = findSupportingEpisodeIds(existingItems, sessionId, fact);
    const plan = planSemanticFact(sessionId, fact, existingItems, reinforcements, supportItemIds);
    if (!plan) {
      continue;
    }
    if (plan.candidate) {
      candidates.push(plan.candidate);
    }
    edgePlans.push(plan.edgePlan);
  }

  const orderedCandidates = candidates.sort((left, right) => {
    const leftScore = left.memoryType === "project_fact" ? 2 : 1;
    const rightScore = right.memoryType === "project_fact" ? 2 : 1;
    return rightScore - leftScore || (right.salience ?? 0) - (left.salience ?? 0);
  });

  return {
    candidates: orderedCandidates.slice(0, 4),
    edgePlans,
  };
}

function extractProjectOverviewSemanticFacts(
  observation: MemoryToolObservation,
): DistilledSemanticFact[] {
  if (observation.toolName !== "project_overview" || isErrorResult(observation.resultText)) {
    return [];
  }

  const facts: DistilledSemanticFact[] = [];
  const packageManager = extractObservationLine(observation.resultText, "Package manager");
  if (packageManager) {
    facts.push({
      memoryType: "project_fact",
      key: "project:package_manager",
      content: `Repository package manager is ${packageManager}.`,
      jsonValue: {
        key: "project:package_manager",
        packageManager,
        evidenceKind: "project_overview",
      },
      tags: ["package-manager", normalizeCueTag(packageManager), "tool:project_overview"],
      sourceType: "tool_result",
      sourceRef: observation.sourceRef,
      confidence: 0.9,
      salience: 0.84,
      volatility: "slow-changing",
      observedAt: observation.createdAt,
      revalidationDueAt: buildRevalidationDueAt(observation.createdAt, 180),
    });
  }

  const workspaceGlobs = extractObservationLine(observation.resultText, "Workspace globs");
  const workspaceBuckets = extractWorkspacePackageBuckets(observation.resultText);
  const workspaceLayout =
    workspaceGlobs && workspaceGlobs.length > 0
      ? `Workspace package globs are ${workspaceGlobs}.`
      : workspaceBuckets.length > 0
        ? `Workspace packages are organized under ${workspaceBuckets.join(", ")}.`
        : null;
  if (workspaceLayout) {
    facts.push({
      memoryType: "project_fact",
      key: "project:workspace_layout",
      content: `Repository ${workspaceLayout.charAt(0).toLowerCase()}${workspaceLayout.slice(1)}`,
      jsonValue: {
        key: "project:workspace_layout",
        workspaceGlobs,
        workspaceBuckets,
        evidenceKind: "project_overview",
      },
      tags: ["workspace-layout", "workspace", ...workspaceBuckets.map((bucket) => normalizeCueTag(bucket)), "tool:project_overview"],
      sourceType: "tool_result",
      sourceRef: observation.sourceRef,
      confidence: 0.84,
      salience: 0.8,
      volatility: "slow-changing",
      observedAt: observation.createdAt,
      revalidationDueAt: buildRevalidationDueAt(observation.createdAt, 180),
    });
  }

  return facts;
}

function extractFileDerivedSemanticFacts(
  observation: MemoryToolObservation,
): DistilledSemanticFact[] {
  const facts: DistilledSemanticFact[] = [];

  if (observation.toolName === "read_file" && observation.targetPath) {
    const normalizedPath = observation.targetPath.toLowerCase();
    const body = extractReadableFileBody(observation.resultText);

    if (normalizedPath.endsWith("package.json")) {
      const pkg = safeParseJsonRecord(body);
      const packageManager =
        pkg && typeof pkg.packageManager === "string" ? normalizeWhitespace(pkg.packageManager) : null;
      if (packageManager) {
        facts.push({
          memoryType: "project_fact",
          key: "project:package_manager",
          content: `Repository package manager is ${packageManager}.`,
          jsonValue: {
            key: "project:package_manager",
            packageManager,
            evidenceKind: "package_json",
          },
          tags: ["package-manager", normalizeCueTag(packageManager), "tool:read_file"],
          sourceType: "tool_result",
          sourceRef: observation.targetPath,
          confidence: 0.93,
          salience: 0.82,
          volatility: "slow-changing",
          observedAt: observation.createdAt,
          revalidationDueAt: buildRevalidationDueAt(observation.createdAt, 180),
        });
      }

      const scripts =
        pkg &&
        pkg.scripts &&
        typeof pkg.scripts === "object" &&
        !Array.isArray(pkg.scripts)
          ? pkg.scripts
          : null;
      if (scripts) {
        for (const [scriptName, scriptValue] of Object.entries(scripts)) {
          if (typeof scriptValue !== "string") {
            continue;
          }
          const classified = classifyProjectCommand(scriptValue);
          if (!classified) {
            continue;
          }
          facts.push({
            memoryType: "project_fact",
            key: classified.key,
            content: `Primary ${classified.label} command is \`${normalizeWhitespace(scriptValue)}\`.`,
            jsonValue: {
              key: classified.key,
              command: normalizeWhitespace(scriptValue),
              commandKind: classified.label,
              scriptName,
              evidenceKind: "package_json_script",
            },
            tags: [...classified.tags, `script:${normalizeCueTag(scriptName)}`, "tool:read_file"],
            sourceType: "tool_result",
            sourceRef: observation.targetPath,
            confidence: 0.84,
            salience: 0.78,
            volatility: "slow-changing",
            observedAt: observation.createdAt,
            revalidationDueAt: buildRevalidationDueAt(observation.createdAt, 180),
          });
        }
      }
    }

    if (normalizedPath.endsWith("tsconfig.json")) {
      const config = safeParseJsonRecord(body);
      const compilerOptions =
        config &&
        config.compilerOptions &&
        typeof config.compilerOptions === "object" &&
        !Array.isArray(config.compilerOptions)
          ? (config.compilerOptions as Record<string, unknown>)
          : null;
      const moduleTarget =
        compilerOptions && typeof compilerOptions.module === "string"
          ? normalizeWhitespace(compilerOptions.module)
          : null;
      facts.push({
        memoryType: "project_fact",
        key: "project:typescript_workspace",
        content: moduleTarget
          ? `Repository uses TypeScript configuration via tsconfig.json with module target ${moduleTarget}.`
          : "Repository uses TypeScript configuration via tsconfig.json.",
        jsonValue: {
          key: "project:typescript_workspace",
          module: moduleTarget,
          evidenceKind: "tsconfig",
        },
        tags: ["typescript", "tsconfig", ...(moduleTarget ? [normalizeCueTag(moduleTarget)] : []), "tool:read_file"],
        sourceType: "tool_result",
        sourceRef: observation.targetPath,
        confidence: 0.88,
        salience: 0.8,
        volatility: "slow-changing",
        observedAt: observation.createdAt,
        revalidationDueAt: buildRevalidationDueAt(observation.createdAt, 180),
      });
    }
  }

  if (observation.toolName === "list_directory") {
    const layout = extractDirectoryLayoutBuckets(observation.resultText);
    if (layout.length >= 2) {
      facts.push({
        memoryType: "project_fact",
        key: "project:workspace_layout",
        content: `Workspace packages are organized under ${layout.join(", ")}.`,
        jsonValue: {
          key: "project:workspace_layout",
          workspaceBuckets: layout,
          evidenceKind: "directory_layout",
        },
        tags: ["workspace-layout", ...layout.map((bucket) => normalizeCueTag(bucket)), "tool:list_directory"],
        sourceType: "tool_result",
        sourceRef: observation.targetPath ?? observation.sourceRef,
        confidence: 0.78,
        salience: 0.74,
        volatility: "slow-changing",
        observedAt: observation.createdAt,
        revalidationDueAt: buildRevalidationDueAt(observation.createdAt, 120),
      });
    }
  }

  return facts;
}

function extractProjectConstraintSemanticFacts(
  messages: ChatMessage[],
  existingItems: MemoryItem[],
  scope: MemoryScope,
): DistilledSemanticFact[] {
  if (scope !== "workspace") {
    return [];
  }

  const counts = new Map<string, { count: number; text: string; tags: string[] }>();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    for (const snippet of extractProjectConstraintSnippets(message.content)) {
      const key = `project:constraint:${normalizeCueTag(snippet).slice(0, 64)}`;
      const entry = counts.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(key, {
          count: 1,
          text: snippet,
          tags: ["constraint", "project-constraint", ...extractKeywordTags(snippet).map((tag) => normalizeCueTag(tag))],
        });
      }
    }
  }

  const facts: DistilledSemanticFact[] = [];
  for (const [key, entry] of counts.entries()) {
    const supportingExisting = existingItems.filter(
      (item) =>
        !item.supersededById &&
        item.scope === "workspace" &&
        (item.memoryType === "warning_or_constraint" || item.memoryType === "project_fact") &&
        normalizeWhitespace(item.content).toLowerCase().includes(entry.text.toLowerCase().slice(0, 24)),
    ).length;
    if (entry.count < 2 && supportingExisting < 1) {
      continue;
    }
    facts.push({
      memoryType: "project_fact",
      key,
      content: `Persistent project constraint: ${entry.text}`,
      jsonValue: {
        key,
        constraint: entry.text,
        mentionCount: entry.count + supportingExisting,
        evidenceKind: "repeated_constraint",
      },
      tags: [...entry.tags, "workspace"],
      sourceType: "assistant_message",
      confidence: Math.min(0.94, 0.72 + (entry.count - 1) * 0.08 + supportingExisting * 0.05),
      salience: Math.min(0.92, 0.76 + (entry.count - 1) * 0.06 + supportingExisting * 0.04),
      volatility: "slow-changing",
    });
  }

  return facts;
}

function extractProjectCommandFacts(
  observations: MemoryToolObservation[],
  existingItems: MemoryItem[],
): DistilledSemanticFact[] {
  const grouped = new Map<
    string,
    {
      command: string;
      classified: { key: string; label: string; tags: string[] };
      count: number;
      latestObservation: MemoryToolObservation;
    }
  >();

  for (const observation of observations) {
    if (observation.toolName !== "run_terminal_command" || observation.exitCode !== 0 || !observation.command) {
      continue;
    }

    const command = normalizeWhitespace(observation.command);
    const classified = classifyProjectCommand(command);
    if (!classified) {
      continue;
    }

    const bucketKey = `${classified.key}::${command.toLowerCase()}`;
    const existing = grouped.get(bucketKey);
    if (existing) {
      existing.count += 1;
      if ((observation.createdAt ?? "") >= (existing.latestObservation.createdAt ?? "")) {
        existing.latestObservation = observation;
      }
      continue;
    }

    grouped.set(bucketKey, {
      command,
      classified,
      count: 1,
      latestObservation: observation,
    });
  }

  const facts: DistilledSemanticFact[] = [];
  for (const entry of grouped.values()) {
    const matchingExisting = existingItems.find(
      (item) =>
        item.memoryType === "project_fact" &&
        item.jsonValue?.key === entry.classified.key &&
        normalizeWhitespace(
          typeof item.jsonValue?.command === "string" ? item.jsonValue.command : "",
        ).toLowerCase() === entry.command.toLowerCase() &&
        !item.supersededById,
    );

    // Avoid promoting a single one-off command into semantic memory.
    if (entry.count < 2 && !matchingExisting) {
      continue;
    }

    facts.push({
      memoryType: "project_fact",
      key: entry.classified.key,
      content: `Primary ${entry.classified.label} command is \`${entry.command}\`.`,
      jsonValue: {
        key: entry.classified.key,
        command: entry.command,
        commandKind: entry.classified.label,
        evidenceKind: "repeated_successful_command",
        observationCount: entry.count,
      },
      tags: [...entry.classified.tags, `tool:${normalizeCueTag(entry.latestObservation.toolName)}`],
      sourceType: "tool_result",
      sourceRef: entry.latestObservation.sourceRef,
      confidence: entry.count >= 2 ? 0.84 : 0.8,
      salience: entry.count >= 2 ? 0.8 : 0.76,
      volatility: "slow-changing",
      observedAt: entry.latestObservation.createdAt,
      revalidationDueAt: buildRevalidationDueAt(entry.latestObservation.createdAt, 120),
    });
  }

  return facts;
}

function extractEnvironmentVersionFacts(
  observation: MemoryToolObservation,
): DistilledSemanticFact[] {
  if (observation.toolName !== "run_terminal_command" || observation.exitCode !== 0 || !observation.command) {
    return [];
  }

  const versionFact = parseEnvironmentVersionFact(observation.command, observation.resultText);
  if (!versionFact) {
    return [];
  }

  return [
    {
      memoryType: "environment_fact",
      key: versionFact.key,
      content: versionFact.content,
      jsonValue: {
        key: versionFact.key,
        runtime: versionFact.runtime,
        version: versionFact.version,
        command: normalizeWhitespace(observation.command),
        evidenceKind: "successful_command",
      },
      tags: ["environment", versionFact.runtime, "version", `tool:${normalizeCueTag(observation.toolName)}`],
      sourceType: "tool_result",
      sourceRef: observation.sourceRef,
      confidence: 0.92,
      salience: 0.78,
      volatility: "slow-changing",
      observedAt: observation.createdAt,
      revalidationDueAt: buildRevalidationDueAt(observation.createdAt, 180),
    },
  ];
}

function planSemanticFact(
  sessionId: string,
  fact: DistilledSemanticFact,
  existingItems: MemoryItem[],
  reinforcements: PendingReinforcement[],
  supportItemIds: string[],
): { candidate: MemoryWriteCandidate | null; edgePlan: PendingSemanticEdgePlan } | null {
  const existing = existingItems.find(
    (item) =>
      item.memoryType === fact.memoryType &&
      item.jsonValue?.key === fact.key &&
      !item.supersededById,
  );

  if (existing && normalizeWhitespace(existing.content).toLowerCase() === normalizeWhitespace(fact.content).toLowerCase()) {
    queueReinforcement(reinforcements, {
      id: existing.id,
      confidenceDelta: 0.01,
      salienceDelta: 0.02,
      revalidationDueAt: fact.revalidationDueAt ?? null,
    });
    return {
      candidate: null,
      edgePlan: {
        memoryId: existing.id,
        candidateSignature: null,
        supportItemIds,
        supersedesId: null,
      },
    };
  }

  const candidate: MemoryWriteCandidate = {
    sessionId,
    memoryType: fact.memoryType,
    scope: "workspace",
    content: fact.content,
    jsonValue: fact.jsonValue ?? { key: fact.key },
    tags: fact.tags,
    sourceType: fact.sourceType,
    sourceRef: fact.sourceRef ?? null,
    confidence: fact.confidence,
    salience: fact.salience,
    volatility: fact.volatility,
    observedAt: fact.observedAt ?? null,
    validFrom: fact.validFrom ?? fact.observedAt ?? null,
    validUntil: fact.validUntil ?? null,
    revalidationDueAt: fact.revalidationDueAt ?? null,
    supersedesId: existing?.id ?? null,
  };

  return {
    candidate,
    edgePlan: {
      memoryId: null,
      candidateSignature: buildCandidateSignature(candidate),
      supportItemIds,
      supersedesId: existing?.id ?? null,
    },
  };
}

function findSupportingEpisodeIds(
  existingItems: MemoryItem[],
  sessionId: string,
  fact: DistilledSemanticFact,
): string[] {
  const factTagSet = new Set(fact.tags.map((tag) => normalizeCueTag(tag)).filter(Boolean));
  const factTerms = new Set(tokenizeForTopics(fact.content));

  return existingItems
    .filter(
      (item) =>
        item.sessionId !== sessionId &&
        !item.supersededById &&
        (item.memoryType === "episode_summary" ||
          item.memoryType === "task_outcome" ||
          item.memoryType === "warning_or_constraint"),
    )
    .map((item) => {
      const tagScore = item.tags.reduce((score, tag) => {
        return factTagSet.has(normalizeCueTag(tag)) ? score + 2 : score;
      }, 0);
      const termScore = tokenizeForTopics(item.content).reduce((score, term) => {
        return factTerms.has(term) ? score + 1 : score;
      }, 0);
      return {
        id: item.id,
        score: tagScore + termScore,
      };
    })
    .filter((entry) => entry.score >= 2)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 3)
    .map((entry) => entry.id);
}

async function persistDerivedEdges(
  repository: MemoryRepository,
  writtenItems: MemoryItem[],
  edgePlans: Array<{
    memoryId: string | null;
    candidateSignature: string | null;
    supportItemIds: string[];
    supersedesId: string | null;
  }>,
  summaryItem: MemoryItem | null,
): Promise<void> {
  const edges = edgePlans.flatMap((plan) => {
    const targetId =
      plan.memoryId ??
      writtenItems.find((item) => buildItemSignature(item) === plan.candidateSignature)?.id ??
      null;
    if (!targetId) {
      return [];
    }

    const supportIds = [...new Set([summaryItem?.id ?? null, ...plan.supportItemIds])]
      .filter((supportId): supportId is string => Boolean(supportId) && supportId !== targetId);
    const derivedEdges = supportIds.map((supportId) => ({
      fromId: targetId,
      toId: supportId,
      relation: "derived_from" as const,
    }));
    const supersedesEdge =
      plan.supersedesId && plan.supersedesId !== targetId
        ? [{ fromId: targetId, toId: plan.supersedesId, relation: "supersedes" as const }]
        : [];
    return [...derivedEdges, ...supersedesEdge];
  });

  if (edges.length === 0) {
    return;
  }

  const uniqueEdges = [...new Map(edges.map((edge) => [buildEdgeKey(edge), edge])).values()];
  await repository.upsertEdges(uniqueEdges);
}

function extractSessionLifecycleCandidates(
  sessionId: string,
  messages: ChatMessage[],
  existingItems: MemoryItem[],
  scope: MemoryScope,
  endReason: "archived" | "deleted" | "reset" | "completed" | null,
  endedAt: string,
  cueTags: string[],
): MemoryWriteCandidate[] {
  const candidates: MemoryWriteCandidate[] = [];
  const taskOutcome = buildTaskOutcomeCandidate(
    sessionId,
    messages,
    existingItems,
    scope,
    endReason,
    endedAt,
    cueTags,
  );
  if (taskOutcome) {
    candidates.push(taskOutcome);
  }

  const openThreads = buildOpenThreadsCandidate(sessionId, messages, existingItems, scope, endedAt, cueTags);
  if (openThreads) {
    candidates.push(openThreads);
  }

  const failure = buildFailureCandidate(sessionId, messages, existingItems, scope, endedAt, cueTags);
  if (failure) {
    candidates.push(failure);
  }

  return candidates;
}

function buildTaskOutcomeCandidate(
  sessionId: string,
  messages: ChatMessage[],
  existingItems: MemoryItem[],
  scope: MemoryScope,
  endReason: "archived" | "deleted" | "reset" | "completed" | null,
  endedAt: string,
  cueTags: string[],
): MemoryWriteCandidate | null {
  const historySummary = getHistorySummaryMessage(messages);
  const visibleMessages = messages.filter((message) => !isHistorySummaryMessage(message));
  const lastAssistant = [...visibleMessages].reverse().find((message) => message.role === "assistant");
  const decisionLines = historySummary
    ? extractSummarySectionItems(historySummary.content, "Decisions and completed work")
    : [];
  const sourceText = decisionLines.length > 0
    ? decisionLines.join("; ")
    : lastAssistant?.content ?? "";
  const normalized = summarizeText(sourceText, 220);
  if (!normalized) {
    return null;
  }

  const content = `Final task outcome: ${normalized}`;
  if (hasActiveSessionMemory(existingItems, sessionId, "task_outcome", content)) {
    return null;
  }

  return {
    sessionId,
    memoryType: "task_outcome",
    scope,
    content,
    jsonValue: {
      key: "final_task_outcome",
      endReason,
      endedAt,
    },
    tags: ["session", "outcome", "final", scope, ...cueTags],
    sourceType: "session_summary",
    confidence: 0.8,
    salience: scope === "workspace" ? 0.84 : 0.72,
    volatility: "event",
    observedAt: endedAt,
  };
}

function buildOpenThreadsCandidate(
  sessionId: string,
  messages: ChatMessage[],
  existingItems: MemoryItem[],
  scope: MemoryScope,
  endedAt: string,
  cueTags: string[],
): MemoryWriteCandidate | null {
  const historySummary = getHistorySummaryMessage(messages);
  const summaryThreads = historySummary
    ? extractSummarySectionItems(historySummary.content, "Open threads")
    : [];
  const assistantThreads = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => extractOpenThreadSnippets(message.content))
    .slice(-3);
  const snippets = summaryThreads.length > 0 ? summaryThreads : assistantThreads;
  if (snippets.length === 0) {
    return null;
  }

  const content = `Open threads from archived session: ${summarizeText(snippets.join("; "), 220)}`;
  if (hasActiveSessionMemory(existingItems, sessionId, "warning_or_constraint", content)) {
    return null;
  }

  return {
    sessionId,
    memoryType: "warning_or_constraint",
    scope,
    content,
    jsonValue: {
      key: "open_threads",
      endedAt,
    },
    tags: ["session", "open-thread", "follow-up", scope, ...cueTags],
    sourceType: "session_summary",
    confidence: 0.76,
    salience: scope === "workspace" ? 0.86 : 0.72,
    volatility: "slow-changing",
    observedAt: endedAt,
  };
}

function buildFailureCandidate(
  sessionId: string,
  messages: ChatMessage[],
  existingItems: MemoryItem[],
  scope: MemoryScope,
  endedAt: string,
  cueTags: string[],
): MemoryWriteCandidate | null {
  const historySummary = getHistorySummaryMessage(messages);
  const summaryFailures = historySummary
    ? extractSummarySectionItems(historySummary.content, "Failures and cautions")
    : [];
  const assistantFailures = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => extractFailureSnippets(message.content))
    .slice(-3);
  const snippets = summaryFailures.length > 0 ? summaryFailures : assistantFailures;
  if (snippets.length === 0) {
    return null;
  }

  const content = `Failure or caution from archived session: ${summarizeText(snippets.join("; "), 220)}`;
  if (hasActiveSessionMemory(existingItems, sessionId, "warning_or_constraint", content)) {
    return null;
  }

  return {
    sessionId,
    memoryType: "warning_or_constraint",
    scope,
    content,
    jsonValue: {
      key: "session_failure",
      endedAt,
    },
    tags: ["session", "failure", "caution", scope, ...cueTags],
    sourceType: "session_summary",
    confidence: 0.8,
    salience: 0.82,
    volatility: "event",
    observedAt: endedAt,
  };
}

function extractWorldFact(
  observation: MemoryToolObservation,
): {
  content: string;
  title: string | null;
  tags: string[];
  confidence: number;
  salience: number;
  volatility: "event" | "volatile";
} | null {
  const titleMatch = observation.resultText.match(/^Title:\s*(.+)$/m);
  const title = titleMatch?.[1]?.trim() || null;
  const body = stripObservationHeaders(observation.resultText);
  const sentence = selectNotableSentence(body);
  if (!sentence) {
    return null;
  }

  const content = title && !sentence.toLowerCase().includes(title.toLowerCase())
    ? `${title}: ${sentence}`
    : sentence;
  const tags = [
    ...extractKeywordTags(title ?? ""),
    ...extractKeywordTags(sentence),
    getSourceLabel(observation.sourceRef),
  ].filter(Boolean);
  const legalOrEventful = containsWorldEventSignal(sentence);

  return {
    content,
    title,
    tags: [...new Set(tags)].slice(0, 8),
    confidence: legalOrEventful ? 0.84 : 0.72,
    salience: legalOrEventful ? 0.86 : 0.68,
    volatility: legalOrEventful ? "event" : "volatile",
  };
}

function extractSessionTopics(
  messages: ChatMessage[],
  toolObservations: MemoryToolObservation[],
): string[] {
  const terms = [
    ...messages.flatMap((message) => tokenizeForTopics(message.content)),
    ...toolObservations.flatMap((observation) =>
      tokenizeForTopics(`${observation.toolName} ${observation.sourceRef ?? ""} ${observation.resultText.slice(0, 200)}`),
    ),
  ];
  const counts = new Map<string, number>();
  for (const term of terms) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([term]) => term);
}

function buildConversationCueTags(
  messages: ChatMessage[],
  toolObservations: MemoryToolObservation[],
  topics: string[],
): string[] {
  const roleTags = [...new Set(
    messages
      .filter((message) => message.role === "assistant" && message.authorRole !== "user")
      .map((message) => `role:${normalizeCueTag(message.authorRole)}`),
  )];
  const handoffTags = [...new Set(extractHandoffCueTags(messages))];
  const toolTags = [...new Set([
    ...messages.flatMap((message) => (message.toolCalls ?? []).map((toolCall) => `tool:${normalizeCueTag(toolCall.name)}`)),
    ...toolObservations.map((observation) => `tool:${normalizeCueTag(observation.toolName)}`),
  ])];
  const topicTags = topics.slice(0, 4).map((topic) => `topic:${normalizeCueTag(topic)}`);

  return [...new Set([...roleTags, ...handoffTags, ...toolTags, ...topicTags])];
}

function extractHandoffCueTags(messages: ChatMessage[]): string[] {
  const assistantMessages = messages.filter(
    (message) => message.role === "assistant" && message.authorRole !== "user",
  );
  const tags: string[] = [];

  for (let index = 1; index < assistantMessages.length; index += 1) {
    const previous = assistantMessages[index - 1];
    const current = assistantMessages[index];
    if (!previous || !current || previous.authorRole === current.authorRole) {
      continue;
    }
    tags.push(`handoff-from:${normalizeCueTag(previous.authorRole)}`);
  }

  return tags;
}

function normalizeCueTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
}

function extractSessionHighlights(messages: ChatMessage[]): string[] {
  const highlights: string[] = [];
  for (const message of messages.slice(-6)) {
    if (!message.content.trim()) {
      continue;
    }
    if (isGenericContinuationMessage(message.content)) {
      continue;
    }
    const prefix = message.role === "user" ? "User" : "Assistant";
    highlights.push(`${prefix}: ${summarizeText(message.content, 96)}`);
  }
  return highlights.slice(-3);
}

function findLastSubstantiveMessage(
  messages: ChatMessage[],
  role: "user" | "assistant",
): ChatMessage | undefined {
  return [...messages].reverse().find(
    (message) => message.role === role && !isGenericContinuationMessage(message.content),
  ) ?? [...messages].reverse().find((message) => message.role === role);
}

function isGenericContinuationMessage(content: string): boolean {
  const normalized = normalizeWhitespace(content).toLowerCase();
  return /\b(continue|continuing|same plan|carry on|keep going|please continue|proceed)\b/.test(normalized);
}

function inferConversationScope(
  messages: ChatMessage[],
  toolObservations: MemoryToolObservation[],
): MemoryScope {
  if (toolObservations.length > 0) {
    return "workspace";
  }

  const combined = messages.map((message) => message.content.toLowerCase()).join(" ");
  if (/\b(repo|package|typescript|server|build|prompt|tool|code|sqlite|memory engine)\b/.test(combined)) {
    return "workspace";
  }

  return "user";
}

function extractDateOfBirth(text: string): string | null {
  const normalized = normalizeWhitespace(text);
  const anchoredText = normalized.toLowerCase();
  if (!/\b(birthday|born|birth date|date of birth|dob)\b/.test(anchoredText)) {
    return null;
  }

  const isoMatch = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const slashMatch = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, "0");
    const day = slashMatch[2].padStart(2, "0");
    return `${slashMatch[3]}-${month}-${day}`;
  }

  const monthRegex = new RegExp(
    `\\b(${Object.keys(MONTHS).join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(\\d{4})\\b`,
    "i",
  );
  const monthMatch = normalized.match(monthRegex);
  if (!monthMatch) {
    return null;
  }

  const month = MONTHS[monthMatch[1].toLowerCase()];
  const day = monthMatch[2].padStart(2, "0");
  return `${monthMatch[3]}-${month}-${day}`;
}

function extractResponseStylePreference(
  text: string,
): { value: "concise" | "detailed"; content: string } | null {
  const normalized = normalizeWhitespace(text).toLowerCase();

  if (/\b(concise|brief|short|direct)\b/.test(normalized) && /\b(prefer|keep|be|want|like)\b/.test(normalized)) {
    return {
      value: "concise",
      content: "User prefers concise, direct responses.",
    };
  }

  if (/\b(detailed|thorough|deep|step-by-step)\b/.test(normalized) && /\b(prefer|want|like|need)\b/.test(normalized)) {
    return {
      value: "detailed",
      content: "User prefers detailed, thorough responses.",
    };
  }

  return null;
}

function hasActiveSessionMemory(
  existingItems: MemoryItem[],
  sessionId: string,
  memoryType: MemoryItem["memoryType"],
  content: string,
): boolean {
  const normalized = normalizeWhitespace(content).toLowerCase();
  return existingItems.some(
    (item) =>
      item.sessionId === sessionId &&
      item.memoryType === memoryType &&
      !item.supersededById &&
      normalizeWhitespace(item.content).toLowerCase() === normalized,
  );
}

async function reinforceMemoryItems(
  repository: MemoryRepository,
  reinforcements: PendingReinforcement[],
  now: string,
): Promise<MemoryItem[]> {
  const unique = [...new Map(reinforcements.map((entry) => [entry.id, entry])).values()];
  const reinforced: MemoryItem[] = [];
  for (const entry of unique) {
    const item = await repository.reinforceItem(entry.id, {
      now,
      confidenceDelta: entry.confidenceDelta,
      salienceDelta: entry.salienceDelta,
      extendValidity: entry.extendValidity,
      revalidationDueAt: entry.revalidationDueAt,
    });
    if (item) {
      reinforced.push(item);
    }
  }
  return reinforced;
}

function queueReinforcement(target: PendingReinforcement[], next: PendingReinforcement): void {
  const existing = target.find((entry) => entry.id === next.id);
  if (!existing) {
    target.push(next);
    return;
  }

  existing.confidenceDelta = Math.max(existing.confidenceDelta ?? 0, next.confidenceDelta ?? 0);
  existing.salienceDelta = Math.max(existing.salienceDelta ?? 0, next.salienceDelta ?? 0);
  existing.extendValidity = existing.extendValidity || next.extendValidity || false;
  existing.revalidationDueAt = pickLaterTimestamp(existing.revalidationDueAt, next.revalidationDueAt);
}

function buildWorldFactTiming(
  observedAt: string,
  volatility: "event" | "volatile",
): {
  validUntil: string | null;
  revalidationDueAt: string | null;
} {
  const observedMs = new Date(observedAt).getTime();
  if (!Number.isFinite(observedMs)) {
    return {
      validUntil: null,
      revalidationDueAt: null,
    };
  }

  if (volatility === "event") {
    return {
      validUntil: null,
      revalidationDueAt: new Date(observedMs + 90 * DAY_MS).toISOString(),
    };
  }

  return {
    validUntil: new Date(observedMs + 14 * DAY_MS).toISOString(),
    revalidationDueAt: new Date(observedMs + 7 * DAY_MS).toISOString(),
  };
}

function pickLaterTimestamp(current: string | null | undefined, next: string | null | undefined): string | null {
  if (!current) {
    return next ?? null;
  }
  if (!next) {
    return current;
  }
  return new Date(current).getTime() >= new Date(next).getTime() ? current : next;
}

function extractSummarySectionItems(content: string, title: string): string[] {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`${escapedTitle}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][^\\n]+:|$)`));
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function extractOpenThreadSnippets(content: string): string[] {
  return extractLifecycleSnippets(content, /\b(open thread|todo|remaining|next step|follow-up|still need|pending)\b/i);
}

function extractFailureSnippets(content: string): string[] {
  return extractLifecycleSnippets(content, /\b(error|failed|failure|timeout|caution|blocked|warning)\b/i);
}

function extractLifecycleSnippets(content: string, pattern: RegExp): string[] {
  return content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length >= 20 && pattern.test(sentence))
    .slice(0, 3);
}

function extractObservationLine(content: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, "m"));
  return match?.[1] ? normalizeWhitespace(match[1]) : null;
}

function extractReadableFileBody(content: string): string {
  const pathMatch = content.match(/^Path:\s+.+$/m);
  const linesMatch = content.match(/^Lines:\s+.+$/m);
  if (pathMatch && linesMatch) {
    const marker = `${pathMatch[0]}\n${linesMatch[0]}`;
    const index = content.indexOf(marker);
    if (index !== -1) {
      return content.slice(index + marker.length).trim();
    }
  }
  return content.trim();
}

function safeParseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractWorkspacePackageBuckets(content: string): string[] {
  const match = content.match(/Workspace packages:\n([\s\S]+)$/);
  if (!match?.[1]) {
    return [];
  }

  const buckets = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const pathMatch = line.match(/\(([^)]+)\)$/);
      if (!pathMatch?.[1]) {
        return null;
      }
      const bucket = pathMatch[1].split("/")[0]?.trim();
      return bucket ? `${bucket}/` : null;
    })
    .filter((bucket): bucket is string => Boolean(bucket));

  return [...new Set(buckets)].slice(0, 4);
}

function extractDirectoryLayoutBuckets(content: string): string[] {
  return [
    ...new Set(
      content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /\/\s/.test(line))
        .map((line) => line.replace(/\s+.+$/, ""))
        .filter((line) => /^(apps|packages|services|libs|tools|src)\//.test(line))
        .slice(0, 6),
    ),
  ];
}

function extractProjectConstraintSnippets(content: string): string[] {
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

function classifyProjectCommand(
  command: string,
): { key: string; label: string; tags: string[] } | null {
  const normalized = normalizeWhitespace(command).toLowerCase();
  if (!normalized || /&&|\|\||;|\|/.test(normalized) || /\bdocker\s+build\b/.test(normalized)) {
    return null;
  }

  if (/\btypecheck\b/.test(normalized) || /\btsc(?:\s|$)/.test(normalized)) {
    return {
      key: "project:typecheck_command",
      label: "typecheck",
      tags: ["typecheck-command", "typescript", normalizeCommandTag(normalized)],
    };
  }

  if (/\b(test|vitest|jest|pytest)\b/.test(normalized)) {
    return {
      key: "project:test_command",
      label: "test",
      tags: ["test-command", normalizeCommandTag(normalized)],
    };
  }

  if (/\bbuild\b/.test(normalized)) {
    return {
      key: "project:build_command",
      label: "build",
      tags: ["build-command", normalizeCommandTag(normalized)],
    };
  }

  if (/\b(dev|start|serve)\b/.test(normalized)) {
    return {
      key: "project:runtime_command",
      label: "runtime",
      tags: ["runtime-command", normalizeCommandTag(normalized)],
    };
  }

  return null;
}

function normalizeCommandTag(command: string): string {
  const firstToken = command.split(/\s+/)[0]?.trim() ?? "";
  return firstToken ? `command:${normalizeCueTag(firstToken)}` : "command:shell";
}

function parseEnvironmentVersionFact(
  command: string,
  resultText: string,
): { key: string; runtime: string; version: string; content: string } | null {
  const normalizedCommand = normalizeWhitespace(command).toLowerCase();
  if (!normalizedCommand || /&&|\|\||;|\|/.test(normalizedCommand)) {
    return null;
  }

  const output = stripTerminalResult(resultText);
  const firstLine = output
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  if (!firstLine) {
    return null;
  }

  const patterns: Array<{
    command: RegExp;
    output: RegExp;
    key: string;
    runtime: string;
    formatter?: (match: RegExpMatchArray) => string;
  }> = [
    {
      command: /^node\s+(?:-v|--version)\b/,
      output: /^(v?\d+\.\d+\.\d+)/i,
      key: "environment:node_version",
      runtime: "node",
    },
    {
      command: /^pnpm\s+(?:-v|--version)\b/,
      output: /^(\d+\.\d+\.\d+)/i,
      key: "environment:pnpm_version",
      runtime: "pnpm",
    },
    {
      command: /^npm\s+(?:-v|--version)\b/,
      output: /^(\d+\.\d+\.\d+)/i,
      key: "environment:npm_version",
      runtime: "npm",
    },
    {
      command: /^python3?\s+--version\b/,
      output: /^Python\s+(\d+\.\d+\.\d+)/i,
      key: "environment:python_version",
      runtime: "python",
      formatter: (match) => match[1] ?? "",
    },
  ];

  for (const pattern of patterns) {
    if (!pattern.command.test(normalizedCommand)) {
      continue;
    }
    const match = firstLine.match(pattern.output);
    if (!match?.[1]) {
      continue;
    }
    const version = pattern.formatter ? pattern.formatter(match) : match[1];
    if (!version) {
      continue;
    }
    const normalizedVersion =
      pattern.runtime === "node" && !version.startsWith("v") ? `v${version}` : version;
    return {
      key: pattern.key,
      runtime: pattern.runtime,
      version: normalizedVersion,
      content: `Local ${pattern.runtime} version is ${normalizedVersion}.`,
    };
  }

  return null;
}

function stripTerminalResult(value: string): string {
  return value.replace(/^Exit code \d+:\n?/i, "").trim();
}

function buildRevalidationDueAt(observedAt: string | null | undefined, days: number): string | null {
  if (!observedAt) {
    return null;
  }
  const observedMs = new Date(observedAt).getTime();
  if (!Number.isFinite(observedMs)) {
    return null;
  }
  return new Date(observedMs + days * DAY_MS).toISOString();
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

function summarizeText(value: string, limit: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenizeForTopics(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !TOPIC_STOP_WORDS.has(term));
}

function extractKeywordTags(value: string): string[] {
  const keywords = tokenizeForTopics(value);
  return keywords.slice(0, 5);
}

function stripObservationHeaders(value: string): string {
  return value
    .replace(/^Title:\s*.+$/gm, "")
    .replace(/^URL:\s*.+$/gm, "")
    .replace(/^Content-Type:\s*.+$/gm, "")
    .replace(/^Characters:\s*.+$/gm, "")
    .replace(/^Status:\s*.+$/gm, "")
    .replace(/^Headers:\n[\s\S]*?(?:\n\n|$)/m, "")
    .replace(/This page has more content\.[^\n]*$/gm, "")
    .trim();
}

function extractObservationHeadline(value: string): string {
  return selectNotableSentence(stripObservationHeaders(value)) ?? summarizeText(stripObservationHeaders(value), 120);
}

function selectNotableSentence(value: string): string | null {
  const sentences = value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 260);

  let bestSentence: string | null = null;
  let bestScore = 0;
  for (const sentence of sentences.slice(0, 16)) {
    let score = 1;
    if (/\b(19|20)\d{2}\b/.test(sentence)) {
      score += 1.5;
    }
    if (containsWorldEventSignal(sentence)) {
      score += 2;
    }
    if (sentence.includes(":")) {
      score -= 0.25;
    }
    if (score > bestScore) {
      bestSentence = sentence;
      bestScore = score;
    }
  }

  if (bestScore < 2.5) {
    return null;
  }

  return bestSentence;
}

function containsWorldEventSignal(value: string): boolean {
  const normalized = value.toLowerCase();
  return WORLD_EVENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
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

function isLocalSource(sourceRef: string): boolean {
  try {
    const url = new URL(sourceRef);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function isErrorResult(value: string): boolean {
  return /^\s*error\b/i.test(value.trim());
}
