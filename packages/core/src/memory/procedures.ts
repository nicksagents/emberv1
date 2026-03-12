import type { ChatMessage } from "../types";
import type { MemoryToolObservation } from "./consolidation";
import {
  getMemoryGovernanceState,
  mergeMemoryGovernanceState,
  updateGovernanceTags,
} from "./governance";
import type { MemoryItem, MemoryPromptContext, MemorySearchResult, MemoryWriteCandidate } from "./types";

const PROCEDURE_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "continue",
  "ember",
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
  "tool",
  "when",
  "with",
  "work",
]);

export interface ProcedureSupportPlan {
  memoryId: string | null;
  candidateSignature: string | null;
  supportItemIds: string[];
  supersedesId: string | null;
}

export interface ProcedureMemoryExtractionResult {
  candidates: MemoryWriteCandidate[];
  edgePlans: ProcedureSupportPlan[];
}

export interface ProcedureMemoryExtractionInput {
  sessionId: string;
  messages: ChatMessage[];
  toolObservations: MemoryToolObservation[];
  existingItems: MemoryItem[];
  scope: MemoryItem["scope"];
}

export function extractProcedureMemory(
  input: ProcedureMemoryExtractionInput,
): ProcedureMemoryExtractionResult {
  if (input.scope !== "workspace") {
    return { candidates: [], edgePlans: [] };
  }

  const observations = input.toolObservations.filter((observation) => !isObservationNoise(observation));
  const outcome = inferProcedureOutcome(input.messages, observations);
  if (outcome === null) {
    return { candidates: [], edgePlans: [] };
  }

  const signature = buildProcedureSignature(input.messages, observations);
  if (!signature) {
    return { candidates: [], edgePlans: [] };
  }

  const existing = input.existingItems.find(
    (item) =>
      item.memoryType === "procedure" &&
      item.jsonValue?.key === signature.key &&
      !item.supersededById,
  );

  if (outcome === "failure" && !existing) {
    return { candidates: [], edgePlans: [] };
  }

  const previousSuccessCount = getProcedureCounter(existing, "successCount");
  const previousFailureCount = getProcedureCounter(existing, "failureCount");
  const nextSuccessCount = outcome === "success" ? previousSuccessCount + 1 : previousSuccessCount;
  const nextFailureCount = outcome === "failure" ? previousFailureCount + 1 : previousFailureCount;
  const published = nextSuccessCount >= 2 && nextFailureCount < 2;
  const retired = nextFailureCount >= 2;
  const existingGovernance = existing ? getMemoryGovernanceState(existing) : null;
  const approvalStatus =
    !published || retired
      ? existingGovernance?.approvalStatus === "approved"
        ? "approved"
        : "implicit"
      : existingGovernance?.approvalStatus === "approved"
        ? "approved"
        : "pending";

  const candidate: MemoryWriteCandidate = {
    sessionId: input.sessionId,
    memoryType: "procedure",
    scope: "workspace",
    content: buildProcedureContent(signature.trigger, observations),
    jsonValue: {
      ...mergeMemoryGovernanceState(existing?.jsonValue, {
        approvalStatus,
        contradictionCount: existingGovernance?.contradictionCount ?? 0,
        contradictionSessionCount: existingGovernance?.contradictionSessionCount ?? 0,
      }),
      key: signature.key,
      trigger: signature.trigger,
      triggerTopics: signature.triggerTopics,
      preconditions: buildProcedurePreconditions(observations),
      steps: observations.map((observation) => ({
        toolName: observation.toolName,
        instruction: describeObservationStep(observation),
      })),
      verification: buildProcedureVerification(observations),
      successCount: nextSuccessCount,
      failureCount: nextFailureCount,
      published,
      retired,
      toolSequence: observations.map((observation) => observation.toolName),
      source: outcome,
    },
    tags: [
      ...updateGovernanceTags(["procedure"], approvalStatus, existingGovernance?.contradictionCount ?? 0),
      ...signature.triggerTopics.map((topic) => normalizeToken(topic)),
      ...observations.map((observation) => `tool:${normalizeToken(observation.toolName)}`),
      published ? "procedure:published" : "procedure:draft",
      retired ? "procedure:retired" : "procedure:active",
    ],
    sourceType: "session_summary",
    confidence: published ? 0.84 : 0.62,
    salience: retired ? 0.42 : published ? 0.82 : 0.64,
    volatility: "slow-changing",
    supersedesId: existing?.id ?? null,
  };

  return {
    candidates: [candidate],
    edgePlans: [
      {
        memoryId: null,
        candidateSignature: buildProcedureCandidateSignature(candidate),
        supportItemIds: findProcedureSupportItemIds(input.existingItems, input.sessionId, signature.triggerTopics),
        supersedesId: existing?.id ?? null,
      },
    ],
  };
}

export function buildProcedurePromptContext(
  results: MemorySearchResult[],
  options: {
    maxInjectedItems?: number;
    maxInjectedChars?: number;
  } = {},
): MemoryPromptContext {
  const maxInjectedItems = Math.max(1, Math.floor(options.maxInjectedItems ?? 2));
  const maxInjectedChars = Math.max(160, Math.floor(options.maxInjectedChars ?? 520));
  const lines = ["Learned procedures:"];
  const kept: MemorySearchResult[] = [];
  let totalChars = lines[0].length;

  for (const result of results) {
    if (kept.length >= maxInjectedItems) {
      break;
    }
    if (!isProcedurePublished(result.item)) {
      continue;
    }

    const remainingChars = maxInjectedChars - totalChars - 1;
    if (remainingChars <= 24) {
      break;
    }
    const line = truncate(formatProcedureLine(result.item), remainingChars);
    const nextChars = totalChars + 1 + line.length;
    if (nextChars > maxInjectedChars) {
      break;
    }
    lines.push(line);
    kept.push(result);
    totalChars = nextChars;
  }

  return {
    text: kept.length > 0 ? lines.join("\n") : "",
    totalChars: kept.length > 0 ? totalChars : 0,
    results: kept,
  };
}

export function isProcedurePublished(item: MemoryItem): boolean {
  return (
    item.memoryType === "procedure" &&
    item.jsonValue?.published === true &&
    item.jsonValue?.retired !== true
  );
}

function isObservationNoise(observation: MemoryToolObservation): boolean {
  return observation.toolName === "memory_search" || observation.toolName === "memory_get";
}

function inferProcedureOutcome(
  messages: ChatMessage[],
  observations: MemoryToolObservation[],
): "success" | "failure" | null {
  if (observations.length < 2) {
    return null;
  }

  const recentText = messages.slice(-4).map((message) => message.content).join(" ").toLowerCase();
  const hasFailureSignal =
    observations.some((observation) => observation.exitCode !== null && observation.exitCode !== 0) ||
    observations.some((observation) => /^\s*error\b/i.test(observation.resultText.trim())) ||
    /\b(blocked|error|failed|failure|broken|regression|could not|couldn't|cannot)\b/.test(recentText);
  if (hasFailureSignal) {
    return "failure";
  }

  const hasSuccessSignal =
    observations.some((observation) => observation.exitCode === 0) ||
    /\b(completed|done|fixed|implemented|resolved|success|succeeded|working)\b/.test(recentText);
  if (!hasSuccessSignal) {
    return null;
  }

  return "success";
}

function buildProcedureSignature(
  messages: ChatMessage[],
  observations: MemoryToolObservation[],
): { key: string; trigger: string; triggerTopics: string[] } | null {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const triggerTopics = extractTopics(`${lastUserMessage} ${observations.map((observation) => observation.queryText ?? observation.command ?? observation.targetPath ?? "").join(" ")}`).slice(0, 4);
  const toolSequence = observations.map((observation) => normalizeToken(observation.toolName)).slice(0, 4);
  if (toolSequence.length < 2) {
    return null;
  }

  const trigger =
    triggerTopics.length > 0
      ? `When handling ${triggerTopics.join(", ")} work that uses ${toolSequence.join(" -> ")}.`
      : `When the task needs ${toolSequence.join(" -> ")}.`;

  return {
    key: `procedure:${triggerTopics.join("-") || "general"}:${toolSequence.join(">")}`,
    trigger,
    triggerTopics,
  };
}

function buildProcedureContent(trigger: string, observations: MemoryToolObservation[]): string {
  const steps = observations.map((observation) => observation.toolName).join(" -> ");
  return `Learned procedure. Trigger: ${trigger} Steps: ${steps}.`;
}

function buildProcedurePreconditions(observations: MemoryToolObservation[]): string[] {
  const toolList = [...new Set(observations.map((observation) => observation.toolName))];
  const directories = [...new Set(observations.map((observation) => observation.workingDirectory).filter(Boolean))];
  const preconditions = [`Tools available: ${toolList.join(", ")}`];
  if (directories.length === 1) {
    preconditions.push(`Workspace path: ${directories[0]}`);
  }
  return preconditions;
}

function buildProcedureVerification(observations: MemoryToolObservation[]): string[] {
  return observations
    .map((observation) => {
      if (observation.command && observation.exitCode === 0) {
        return `Expect \`${normalizeWhitespace(observation.command)}\` to exit 0.`;
      }
      if (observation.queryText) {
        return `Expect ${observation.toolName} to return relevant matches for "${normalizeWhitespace(observation.queryText)}".`;
      }
      return `Expect ${observation.toolName} to return a non-error result.`;
    })
    .slice(-3);
}

function describeObservationStep(observation: MemoryToolObservation): string {
  if (observation.command) {
    return `Run \`${normalizeWhitespace(observation.command)}\`.`;
  }
  if (observation.queryText) {
    return `Use ${observation.toolName} for "${normalizeWhitespace(observation.queryText)}".`;
  }
  if (observation.targetPath) {
    return `Use ${observation.toolName} on ${normalizeWhitespace(observation.targetPath)}.`;
  }
  if (observation.sourceRef) {
    return `Use ${observation.toolName} with ${normalizeWhitespace(observation.sourceRef)}.`;
  }
  return `Use ${observation.toolName}.`;
}

function findProcedureSupportItemIds(
  existingItems: MemoryItem[],
  sessionId: string,
  triggerTopics: string[],
): string[] {
  const topicSet = new Set(triggerTopics.map((topic) => normalizeToken(topic)));
  return existingItems
    .filter(
      (item) =>
        item.sessionId !== sessionId &&
        !item.supersededById &&
        (item.memoryType === "task_outcome" || item.memoryType === "episode_summary"),
    )
    .filter((item) => item.tags.some((tag) => topicSet.has(normalizeToken(tag.replace(/^topic:/, "")))))
    .slice(0, 3)
    .map((item) => item.id);
}

function getProcedureCounter(
  item: MemoryItem | undefined,
  key: "successCount" | "failureCount",
): number {
  const value = item?.jsonValue?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function formatProcedureLine(item: MemoryItem): string {
  const trigger = typeof item.jsonValue?.trigger === "string" ? item.jsonValue.trigger : item.content;
  const steps = Array.isArray(item.jsonValue?.steps)
    ? item.jsonValue.steps
        .map((step) => {
          if (!step || typeof step !== "object" || Array.isArray(step)) {
            return null;
          }
          const instruction = typeof step.instruction === "string" ? step.instruction : null;
          return instruction ? normalizeWhitespace(instruction.replace(/\.$/, "")) : null;
        })
        .filter((step): step is string => Boolean(step))
        .slice(0, 3)
    : [];
  const verification = Array.isArray(item.jsonValue?.verification)
    ? item.jsonValue.verification.find((entry): entry is string => typeof entry === "string")
    : null;
  const successCount = getProcedureCounter(item, "successCount");

  return `- ${truncate(trigger, 92)} Steps: ${steps.join(" -> ")}. Verify: ${truncate(verification ?? "final command succeeds", 72)} Successes: ${successCount}.`;
}

function buildProcedureCandidateSignature(candidate: MemoryWriteCandidate): string {
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

function extractTopics(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !PROCEDURE_STOP_WORDS.has(term));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function truncate(value: string, limit: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}
