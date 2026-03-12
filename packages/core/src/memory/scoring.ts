import type {
  MemoryConfig,
  MemoryItem,
  MemoryPromptContext,
  MemorySearchQuery,
  MemorySearchResult,
} from "./types";
import { getMemoryGovernanceState } from "./governance";
import { getItemInternalMetadata } from "./metadata";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PROMPT_TYPE_CAPS: Partial<Record<MemoryItem["memoryType"], number>> = {
  user_profile: 1,
  user_preference: 1,
  project_fact: 2,
  environment_fact: 1,
  procedure: 1,
  world_fact: 1,
  episode_summary: 1,
  task_outcome: 1,
  warning_or_constraint: 1,
};
const LEXICAL_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "any",
  "been",
  "being",
  "both",
  "cant",
  "cannot",
  "could",
  "did",
  "does",
  "doing",
  "done",
  "from",
  "have",
  "into",
  "just",
  "like",
  "make",
  "maybe",
  "more",
  "need",
  "please",
  "really",
  "should",
  "some",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "want",
  "were",
  "what",
  "when",
  "with",
  "would",
  "your",
]);

export function scoreMemoryItems(
  items: MemoryItem[],
  query: MemorySearchQuery,
  config: MemoryConfig,
  options: {
    semanticSimilarityById?: ReadonlyMap<string, number>;
  } = {},
): MemorySearchResult[] {
  const normalizedNow = new Date(query.now ?? new Date().toISOString()).getTime();
  const terms = tokenize(query.text);
  const requiredTags = new Set(
    (query.tags ?? []).map((tag) => normalizeCueToken(tag)).filter(Boolean),
  );

  return items
    .filter((item) => shouldIncludeMemoryItem(item, query, normalizedNow))
    .map((item) =>
      scoreMemoryItem(
        item,
        terms,
        requiredTags,
        query,
        normalizedNow,
        config,
        options.semanticSimilarityById?.get(item.id) ?? 0,
      ),
    )
    .filter((result): result is MemorySearchResult => result !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, query.maxResults ?? config.retrieval.maxResults);
}

export function buildMemoryPromptContext(
  results: MemorySearchResult[],
  config: MemoryConfig,
  options: {
    now?: string;
    maxInjectedItems?: number;
    maxInjectedChars?: number;
  } = {},
): MemoryPromptContext {
  const nowMs = new Date(options.now ?? new Date().toISOString()).getTime();
  const maxInjectedItems = Math.max(
    1,
    Math.floor(options.maxInjectedItems ?? config.retrieval.maxInjectedItems),
  );
  const maxInjectedChars = Math.max(
    64,
    Math.floor(options.maxInjectedChars ?? config.retrieval.maxInjectedChars),
  );
  const lines = ["Persistent memory:"];
  const kept: MemorySearchResult[] = [];
  let totalChars = lines[0].length;
  const sharedContentBudget = Math.max(
    80,
    Math.floor(Math.max(0, maxInjectedChars - lines[0].length - 1) / maxInjectedItems),
  );
  const keptByType = new Map<MemoryItem["memoryType"], number>();
  const keptContentKeys = new Set<string>();

  for (const result of results) {
    if (kept.length >= maxInjectedItems) {
      break;
    }
    const typeCap = PROMPT_TYPE_CAPS[result.item.memoryType] ?? 1;
    if ((keptByType.get(result.item.memoryType) ?? 0) >= typeCap) {
      continue;
    }

    const label = describeMemoryType(result.item.memoryType);
    const linePrefix = `- ${label}: `;
    const remainingChars = maxInjectedChars - totalChars - 1;
    if (remainingChars <= linePrefix.length + 16) {
      break;
    }
    const content = truncatePromptContent(
      formatPromptContent(result.item, nowMs),
      Math.max(
        24,
        Math.min(remainingChars - linePrefix.length, sharedContentBudget - linePrefix.length),
      ),
    );
    if (!content) {
      continue;
    }
    const contentKey = `${result.item.memoryType}::${content.toLowerCase()}`;
    if (keptContentKeys.has(contentKey)) {
      continue;
    }
    const line = `${linePrefix}${content}`;
    const nextChars = totalChars + 1 + line.length;
    if (nextChars > maxInjectedChars) {
      break;
    }

    lines.push(line);
    kept.push(result);
    keptByType.set(result.item.memoryType, (keptByType.get(result.item.memoryType) ?? 0) + 1);
    keptContentKeys.add(contentKey);
    totalChars = nextChars;
  }

  return {
    text: kept.length > 0 ? lines.join("\n") : "",
    totalChars: kept.length > 0 ? totalChars : 0,
    results: kept,
  };
}

export function shouldIncludeMemoryItem(
  item: MemoryItem,
  query: MemorySearchQuery,
  nowMs: number,
): boolean {
  if (item.supersededById) {
    return false;
  }
  if (query.activeSessionId && item.sessionId && query.activeSessionId === item.sessionId) {
    return false;
  }
  if (query.scopes && query.scopes.length > 0 && !query.scopes.includes(item.scope)) {
    return false;
  }
  if (query.memoryTypes && query.memoryTypes.length > 0 && !query.memoryTypes.includes(item.memoryType)) {
    return false;
  }
  if (query.sourceTypes && query.sourceTypes.length > 0 && !query.sourceTypes.includes(item.sourceType)) {
    return false;
  }
  if (item.validUntil) {
    const validUntilMs = new Date(item.validUntil).getTime();
    if (Number.isFinite(validUntilMs) && validUntilMs < nowMs) {
      return false;
    }
  }
  return true;
}

function scoreMemoryItem(
  item: MemoryItem,
  terms: string[],
  requiredTags: Set<string>,
  query: MemorySearchQuery,
  nowMs: number,
  config: MemoryConfig,
  semanticScore: number,
): MemorySearchResult | null {
  const normalizedTags = item.tags.map((tag) => normalizeCueToken(tag));
  const haystackTerms = new Set([
    ...tokenize(item.content),
    ...normalizedTags,
    ...tokenize(item.memoryType),
  ]);
  const matchedTerms = terms.filter((term) => haystackTerms.has(term));
  const cueMatch = scoreCueMatch(item, query, normalizedTags);
  if (
    terms.length > 0 &&
    matchedTerms.length === 0 &&
    requiredTags.size === 0 &&
    semanticScore <= 0 &&
    cueMatch.score <= 0
  ) {
    return null;
  }

  const lexicalScore = terms.length > 0 ? matchedTerms.length / terms.length : 0;
  const tagHits = [...requiredTags].filter((tag) => normalizedTags.includes(tag));
  const tagScore = requiredTags.size > 0 ? tagHits.length / requiredTags.size : 0;
  const exactPhraseBoost = terms.length > 1 && item.content.toLowerCase().includes(terms.join(" ")) ? 0.15 : 0;
  const recencyMultiplier = getRecencyMultiplier(item, nowMs);
  const reinforcementBoost = getReinforcementBoost(item);
  const retrievalSuccessBoost = getRetrievalSuccessBoost(item);
  const revalidationMultiplier = getRevalidationMultiplier(item, nowMs);
  const governanceMultiplier = getGovernanceMultiplier(item);

  const score =
    ((Math.max(lexicalScore, tagScore) * config.retrieval.lexicalWeight) +
      semanticScore * config.retrieval.semanticWeight +
      item.salience * config.retrieval.salienceWeight +
      item.confidence * config.retrieval.confidenceWeight +
      cueMatch.score +
      exactPhraseBoost +
      reinforcementBoost +
      retrievalSuccessBoost) *
    recencyMultiplier *
    revalidationMultiplier *
    governanceMultiplier;

  if (
    score < queryMinScore(config, query, item, lexicalScore, tagScore, semanticScore, cueMatch.score)
  ) {
    return null;
  }

  return {
    item,
    score,
    matchedTerms,
    cueMatches: cueMatch.matches,
    reason: [
      matchedTerms.length > 0
        ? `matched terms: ${matchedTerms.join(", ")}`
        : semanticScore > 0
          ? `semantic similarity: ${semanticScore.toFixed(2)}`
        : tagHits.length > 0
          ? `matched tags: ${tagHits.join(", ")}`
          : cueMatch.matches.length > 0
            ? `matched cues: ${cueMatch.matches.join(", ")}`
          : "ranked by salience/confidence",
      cueMatch.matches.length > 0 && matchedTerms.length > 0
        ? `matched cues: ${cueMatch.matches.join(", ")}`
        : "",
      describeMemoryFreshness(item, nowMs),
    ]
      .filter(Boolean)
      .join("; "),
  };
}

function queryMinScore(
  config: MemoryConfig,
  query: MemorySearchQuery,
  item: MemoryItem,
  lexicalScore: number,
  tagScore: number,
  semanticScore: number,
  cueScore: number,
): number {
  const baseMinScore = Math.max(0, Math.min(1, query.minScore ?? config.retrieval.minScore));
  if (lexicalScore > 0 || tagScore > 0 || semanticScore > 0 || cueScore > 0) {
    return baseMinScore;
  }
  return Math.max(baseMinScore, (item.salience + item.confidence) / 3);
}

function getRecencyMultiplier(item: MemoryItem, nowMs: number): number {
  const reference = item.observedAt ?? item.updatedAt;
  const timeMs = new Date(reference).getTime();
  if (!Number.isFinite(timeMs)) {
    return 1;
  }

  const ageDays = Math.max(0, (nowMs - timeMs) / DAY_MS);
  if (item.volatility === "stable") {
    return 1;
  }
  if (item.volatility === "slow-changing") {
    return Math.max(0.65, Math.exp((-Math.LN2 * ageDays) / 180));
  }
  if (item.volatility === "event") {
    return Math.max(0.35, Math.exp((-Math.LN2 * ageDays) / 45));
  }
  return Math.max(0.15, Math.exp((-Math.LN2 * ageDays) / 7));
}

function getReinforcementBoost(item: MemoryItem): number {
  const { reinforcementCount } = getItemInternalMetadata(item);
  if (reinforcementCount <= 1) {
    return 0;
  }
  return Math.min(0.12, Math.log2(reinforcementCount) * 0.04);
}

function getRetrievalSuccessBoost(item: MemoryItem): number {
  const { retrievalSuccessCount } = getItemInternalMetadata(item);
  if (retrievalSuccessCount <= 0) {
    return 0;
  }
  return Math.min(0.16, Math.log2(retrievalSuccessCount + 1) * 0.05);
}

function getRevalidationMultiplier(item: MemoryItem, nowMs: number): number {
  const { revalidationDueAt } = getItemInternalMetadata(item);
  if (!revalidationDueAt) {
    return 1;
  }

  const dueMs = new Date(revalidationDueAt).getTime();
  if (!Number.isFinite(dueMs) || dueMs >= nowMs) {
    return 1;
  }

  const overdueDays = Math.max(0, (nowMs - dueMs) / DAY_MS);
  if (item.volatility === "event") {
    return Math.max(0.55, Math.exp((-Math.LN2 * overdueDays) / 180));
  }
  if (item.volatility === "slow-changing") {
    return Math.max(0.5, Math.exp((-Math.LN2 * overdueDays) / 90));
  }
  return Math.max(0.35, Math.exp((-Math.LN2 * overdueDays) / 30));
}

function getGovernanceMultiplier(item: MemoryItem): number {
  const governance = getMemoryGovernanceState(item);
  switch (governance.approvalStatus) {
    case "approved":
      return 1.06;
    case "pending":
      return 0.94;
    case "disputed":
      return 0.72;
    case "rejected":
      return 0.4;
    case "implicit":
      return 1;
  }
}

function describeMemoryFreshness(item: MemoryItem, nowMs: number): string {
  const { reinforcementCount, revalidationDueAt, retrievalSuccessCount } = getItemInternalMetadata(item);
  const governance = getMemoryGovernanceState(item);
  const notes: string[] = [];
  if (reinforcementCount > 1) {
    notes.push(`reinforced x${reinforcementCount}`);
  }
  if (retrievalSuccessCount > 0) {
    notes.push(`useful x${retrievalSuccessCount}`);
  }
  if (governance.approvalStatus === "pending") {
    notes.push("pending approval");
  } else if (governance.approvalStatus === "disputed") {
    notes.push(`contradicted x${governance.contradictionCount}`);
  } else if (governance.approvalStatus === "approved") {
    notes.push("approved");
  }
  if (revalidationDueAt) {
    const dueMs = new Date(revalidationDueAt).getTime();
    if (Number.isFinite(dueMs) && dueMs < nowMs) {
      notes.push("needs revalidation");
    }
  }
  return notes.join(", ");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !LEXICAL_STOP_WORDS.has(term));
}

function scoreCueMatch(
  item: MemoryItem,
  query: MemorySearchQuery,
  normalizedTags: string[],
): { score: number; matches: string[] } {
  const matches: string[] = [];
  let score = 0;
  const tagSet = new Set(normalizedTags);

  if (query.activeRole) {
    const roleTag = `role:${normalizeCueToken(query.activeRole)}`;
    if (tagSet.has(roleTag)) {
      matches.push(roleTag);
      score += 0.16;
    }
  }

  if (query.handoffSourceRole) {
    const handoffTag = `handoff-from:${normalizeCueToken(query.handoffSourceRole)}`;
    if (tagSet.has(handoffTag)) {
      matches.push(handoffTag);
      score += 0.12;
    }
  }

  const toolMatches = uniqueCueMatches(
    (query.recentToolNames ?? []).map((toolName) => `tool:${normalizeCueToken(toolName)}`),
    tagSet,
  );
  if (toolMatches.length > 0) {
    matches.push(...toolMatches);
    score += Math.min(0.24, toolMatches.length * 0.08);
  }

  const topicMatches = uniqueCueMatches(
    (query.workspaceTopics ?? []).flatMap((topic) => {
      const normalized = normalizeCueToken(topic);
      if (!normalized) {
        return [];
      }
      return [`topic:${normalized}`, normalized];
    }),
    tagSet,
  );
  if (topicMatches.length > 0) {
    matches.push(...topicMatches.slice(0, 3));
    score += Math.min(0.2, topicMatches.length * 0.05);
  }

  const subgoalTokens = tokenizeCueText(query.activeSubgoal);
  const subgoalHits = subgoalTokens.filter((token) => tagSet.has(`topic:${token}`) || tagSet.has(token));
  if (subgoalHits.length > 0) {
    matches.push(...subgoalHits.slice(0, 2).map((token) => `subgoal:${token}`));
    score += Math.min(0.14, subgoalHits.length * 0.05);
  }

  if (query.taskState && query.taskState !== "normal" && memoryMatchesTaskState(item, tagSet, query.taskState)) {
    matches.push(`task:${query.taskState}`);
    score += 0.14;
  }

  if (query.preferredSourceTypes && query.preferredSourceTypes.length > 0) {
    const sourceRank = query.preferredSourceTypes.findIndex((sourceType) => sourceType === item.sourceType);
    if (sourceRank !== -1) {
      matches.push(`source:${item.sourceType}`);
      score += Math.max(0.05, 0.16 - sourceRank * 0.04);
    }
  }

  return {
    score: Math.min(0.55, score),
    matches: [...new Set(matches)],
  };
}

function memoryMatchesTaskState(
  item: MemoryItem,
  tagSet: Set<string>,
  taskState: NonNullable<MemorySearchQuery["taskState"]>,
): boolean {
  if (taskState === "blocked" || taskState === "failing") {
    if (item.memoryType === "warning_or_constraint" || item.memoryType === "task_outcome") {
      return true;
    }
    if (["failure", "blocked", "caution", "open-thread", "regression"].some((tag) => tagSet.has(tag))) {
      return true;
    }
    return /\b(blocked|failed|failure|broken|regression|caution)\b/i.test(item.content);
  }

  return false;
}

function uniqueCueMatches(candidates: string[], tagSet: Set<string>): string[] {
  return [...new Set(candidates.map((candidate) => normalizeCueToken(candidate)).filter((candidate) => tagSet.has(candidate)))];
}

function tokenizeCueText(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  return tokenize(value).filter((term) => !CUE_STOP_WORDS.has(term));
}

function normalizeCueToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
}

const CUE_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "continue",
  "file",
  "from",
  "have",
  "into",
  "just",
  "need",
  "please",
  "project",
  "should",
  "that",
  "this",
  "with",
  "work",
]);

function describeMemoryType(memoryType: MemoryItem["memoryType"]): string {
  switch (memoryType) {
    case "user_profile":
      return "User profile";
    case "user_preference":
      return "User preference";
    case "project_fact":
      return "Project fact";
    case "environment_fact":
      return "Environment fact";
    case "procedure":
      return "Procedure";
    case "world_fact":
      return "World fact";
    case "episode_summary":
      return "Prior session";
    case "task_outcome":
      return "Task outcome";
    case "warning_or_constraint":
      return "Constraint";
  }
}

function formatPromptContent(item: MemoryItem, nowMs: number): string {
  if (item.memoryType === "user_profile" && typeof item.jsonValue?.dateOfBirth === "string") {
    const dateOfBirth = item.jsonValue.dateOfBirth;
    const age = deriveAge(dateOfBirth, nowMs);
    if (age !== null) {
      return `Born ${dateOfBirth}. Current age: ${age}.`;
    }
    return `Born ${dateOfBirth}.`;
  }

  if (
    item.memoryType === "user_preference" &&
    item.jsonValue?.key === "response_style" &&
    typeof item.jsonValue.value === "string"
  ) {
    return item.jsonValue.value === "concise"
      ? "Prefers concise, direct responses."
      : "Prefers detailed, thorough responses.";
  }

  if (item.memoryType === "world_fact") {
    const details = [item.content.trim()];
    if (item.observedAt) {
      details.push(`Observed ${item.observedAt.slice(0, 10)}.`);
    }
    const { revalidationDueAt } = getItemInternalMetadata(item);
    if (revalidationDueAt) {
      const dueMs = new Date(revalidationDueAt).getTime();
      if (Number.isFinite(dueMs) && dueMs < nowMs) {
        details.push("Needs revalidation.");
      } else if (item.volatility === "volatile") {
        details.push("Time-sensitive.");
      }
    }
    return details.join(" ");
  }

  if (item.memoryType === "procedure") {
    const trigger =
      item.jsonValue?.trigger && typeof item.jsonValue.trigger === "string"
        ? item.jsonValue.trigger
        : item.content.trim();
    const successCount =
      typeof item.jsonValue?.successCount === "number" && Number.isFinite(item.jsonValue.successCount)
        ? item.jsonValue.successCount
        : 0;
    const published = item.jsonValue?.published === true;
    const verification = Array.isArray(item.jsonValue?.verification)
      ? item.jsonValue.verification.find((entry): entry is string => typeof entry === "string")
      : null;
    const parts = [truncatePromptContent(trigger, 140)];
    if (published) {
      parts.push(`Published after ${successCount} successful runs.`);
    } else {
      parts.push(`Draft procedure with ${successCount} successful run${successCount === 1 ? "" : "s"}.`);
    }
    if (verification) {
      parts.push(`Verify: ${truncatePromptContent(verification, 90)}`);
    }
    return parts.join(" ");
  }

  return item.content.trim();
}

function truncatePromptContent(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  if (limit <= 1) {
    return normalized.slice(0, limit);
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function deriveAge(dateOfBirth: string, nowMs: number): number | null {
  const match = dateOfBirth.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - year;
  const birthdayHasPassed =
    now.getUTCMonth() + 1 > month || (now.getUTCMonth() + 1 === month && now.getUTCDate() >= day);
  if (!birthdayHasPassed) {
    age -= 1;
  }
  return Math.max(age, 0);
}
