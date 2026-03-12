import { getHistorySummaryMessage, isHistorySummaryMessage, type ChatRequest, type Provider, type Role } from "@ember/core";
import { isProductDeliveryRequest } from "./delivery-workflow.js";

export type ModelRoutedRole = Exclude<Role, "dispatch">;

export type ModelDecisionSource = "policy" | "router-llm" | "policy-fallback";

export interface ExecutionModelDecision {
  modelId: string | null;
  reason: string;
  source: ModelDecisionSource;
  confidence: number;
}

export interface ModelRouteCandidate {
  modelId: string;
  summary: string;
}

export interface PolicyModelRouteEvaluation {
  decision: ExecutionModelDecision;
  shouldQueryDispatch: boolean;
  candidates: ModelRouteCandidate[];
}

interface DispatchModelDecisionPayload {
  modelId: string;
  confidence: number;
  reason: string;
}

const MODEL_ROUTER_MAX_MESSAGES = 6;
const MODEL_ROUTER_CONTEXT_CHAR_BUDGET = 1_800;
const MODEL_ROUTER_SUMMARY_CHAR_LIMIT = 800;
const MODEL_ROUTER_MESSAGE_CHAR_LIMIT = 420;
const MAX_MODEL_CANDIDATES = 6;
const MIN_MODEL_DISPATCH_CONFIDENCE = 0.34;

function countPatternMatches(content: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + (pattern.test(content) ? 1 : 0), 0);
}

function estimateTaskCount(content: string): number {
  const normalized = content
    .toLowerCase()
    .replace(/\b(after that|afterwards|next|then)\b/g, " and ");
  const parts = normalized
    .split(/\b(?:and|also)\b|[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return Math.max(1, Math.min(parts.length, 6));
}

function parseJsonOnly(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith("```")) {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced) {
      return null;
    }
    return JSON.parse(fenced[1]);
  }

  return JSON.parse(trimmed);
}

function normalizeModelDispatchPayload(payload: unknown): DispatchModelDecisionPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const modelId = typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
  const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
  const rawConfidence = candidate.confidence;
  const confidence =
    typeof rawConfidence === "number"
      ? rawConfidence
      : typeof rawConfidence === "string"
        ? Number(rawConfidence)
        : Number.NaN;

  if (!modelId || !reason || !Number.isFinite(confidence)) {
    return null;
  }

  return {
    modelId,
    reason,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

export function parseModelDispatchDecision(content: string): DispatchModelDecisionPayload | null {
  try {
    return normalizeModelDispatchPayload(parseJsonOnly(content));
  } catch {
    return null;
  }
}

function normalizeModelId(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function dedupeModelIds(provider: Provider, assignedModelId: string | null): string[] {
  const seen = new Set<string>();
  const modelIds = [assignedModelId, provider.config.defaultModelId ?? null, ...provider.availableModels]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .filter((modelId) => {
      const normalized = normalizeModelId(modelId);
      if (!normalized || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });

  return modelIds;
}

function extractModelSizeInBillions(modelId: string): number | null {
  const match = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function isCodingModel(modelId: string): boolean {
  return /\b(?:codex|coder|code)\b/.test(modelId.toLowerCase()) || /-(?:codex|coder|code)(?:[-._]|$)/.test(modelId.toLowerCase());
}

function isSmallModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  const size = extractModelSizeInBillions(normalized);
  return (
    /\b(?:mini|nano|small|flash|fast)\b/.test(normalized) ||
    (size !== null && size <= 8)
  );
}

function isLargeModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  const size = extractModelSizeInBillions(normalized);
  return (
    /\b(?:max|opus|ultra|pro)\b/.test(normalized) ||
    (size !== null && size >= 30) ||
    /\bgpt-5\.(?:4|3|2)\b/.test(normalized)
  );
}

function isReasoningModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    /\b(?:max|opus|reason|think|sonnet|claude)\b/.test(normalized) ||
    /\bgpt-5\.(?:4|3|2)(?!-codex)\b/.test(normalized) ||
    /\bqwen(?:[\w.-]*)3\.5\b/.test(normalized)
  );
}

function describeModel(modelId: string): string {
  const parts: string[] = [];
  const size = extractModelSizeInBillions(modelId);

  if (isCodingModel(modelId)) {
    parts.push("coding-specialized");
  }
  if (isReasoningModel(modelId)) {
    parts.push("reasoning-heavy");
  }
  if (isSmallModel(modelId)) {
    parts.push("faster/smaller");
  } else if (isLargeModel(modelId)) {
    parts.push("stronger-capacity");
  }

  if (size !== null) {
    if (size >= 30) {
      parts.push("large local model");
    } else if (size >= 10) {
      parts.push("mid-size local model");
    } else {
      parts.push("compact local model");
    }
  }

  if (parts.length === 0) {
    parts.push("general-purpose");
  }

  return parts.join(", ");
}

interface ModelTaskProfile {
  normalized: string;
  browserOrResearch: boolean;
  codeHeavy: boolean;
  planningHeavy: boolean;
  reviewHeavy: boolean;
  securityHeavy: boolean;
  complexityHigh: boolean;
  productDelivery: boolean;
  simpleTask: boolean;
}

function buildTaskProfile(content: string): ModelTaskProfile {
  const normalized = content.toLowerCase().trim();
  const taskCount = estimateTaskCount(normalized);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const browserScore = countPatternMatches(normalized, [
    /\bbrowser\b/,
    /\bwebsite\b/,
    /\bsite\b/,
    /\bpage\b/,
    /\bnavigate\b/,
    /\bclick\b/,
    /\bplaywright\b/,
    /\bdom\b/,
  ]);
  const researchScore = countPatternMatches(normalized, [
    /\bresearch\b/,
    /\bsearch\b/,
    /\bcompare\b/,
    /\blook up\b/,
    /\bdocumentation\b/,
    /\bdocs\b/,
    /\bsource\b/,
  ]);
  const planningScore = countPatternMatches(normalized, [
    /\bplan\b/,
    /\barchitecture\b/,
    /\broadmap\b/,
    /\bsequence\b/,
    /\bmilestone\b/,
    /\bdesign\b/,
    /\bspec\b/,
    /\btradeoff\b/,
  ]);
  const codingScore = countPatternMatches(normalized, [
    /\bcode\b/,
    /\bimplement\b/,
    /\bbuild\b/,
    /\bfix\b/,
    /\bdebug\b/,
    /\brefactor\b/,
    /\bpatch\b/,
    /\bapi\b/,
    /\bbackend\b/,
    /\bfrontend\b/,
    /\btypescript\b/,
    /\bjavascript\b/,
    /\breact\b/,
  ]);
  const reviewScore = countPatternMatches(normalized, [
    /\breview\b/,
    /\baudit\b/,
    /\binspect\b/,
    /\bvalidate\b/,
    /\bverify\b/,
    /\bregression\b/,
    /\bsecurity\b/,
    /\bvulnerab(?:ility|ilities)\b/,
    /\bqa\b/,
    /\bfindings\b/,
    /\bscore\b/,
  ]);
  const complexityScore = countPatternMatches(normalized, [
    /\bcomplex\b/,
    /\bsubstantial\b/,
    /\bfull[-\s]?stack\b/,
    /\bend[-\s]?to[-\s]?end\b/,
    /\bmulti[-\s]?(?:step|phase|file)\b/,
    /\bdeep\b/,
    /\broot cause\b/,
    /\bmigration\b/,
    /\boverhaul\b/,
    /\bdatabase\b/,
    /\bschema\b/,
    /\binfra(?:structure)?\b/,
    /\bdeployment\b/,
  ]);
  const productDelivery = isProductDeliveryRequest(normalized);
  const complexityHigh =
    productDelivery || complexityScore >= 1 || taskCount >= 3 || wordCount >= 22;
  const browserOrResearch = browserScore + researchScore >= 1;
  const codeHeavy = codingScore >= 1;
  const planningHeavy = planningScore >= 1;
  const reviewHeavy = reviewScore >= 1;
  const securityHeavy = /\bsecurity\b|\bvulnerab(?:ility|ilities)\b|\bthreat\b/.test(normalized);
  const simpleTask = !complexityHigh && taskCount <= 2 && wordCount <= 18 && !productDelivery;

  return {
    normalized,
    browserOrResearch,
    codeHeavy,
    planningHeavy,
    reviewHeavy,
    securityHeavy,
    complexityHigh,
    productDelivery,
    simpleTask,
  };
}

function scoreModelForTask(
  modelId: string,
  role: ModelRoutedRole,
  assignedModelId: string | null,
  profile: ModelTaskProfile,
): number {
  let score = 0;
  const assigned = normalizeModelId(modelId) === normalizeModelId(assignedModelId);
  const coding = isCodingModel(modelId);
  const small = isSmallModel(modelId);
  const large = isLargeModel(modelId);
  const reasoning = isReasoningModel(modelId);

  if (assigned) {
    score += 3;
  }

  switch (role) {
    case "advisor":
      if (!coding) {
        score += 3;
      }
      if (reasoning || large) {
        score += 3;
      }
      break;
    case "director":
      if (coding) {
        score += 5;
      }
      if (profile.complexityHigh && (large || reasoning)) {
        score += 2;
      }
      break;
    case "inspector":
      if (reasoning || large) {
        score += 3;
      }
      if (coding && profile.codeHeavy) {
        score += 2;
      }
      break;
    case "coordinator":
      if (profile.simpleTask && small) {
        score += 3;
      }
      if (!profile.simpleTask && (reasoning || large)) {
        score += 2;
      }
      if (coding && profile.codeHeavy) {
        score += 1;
      }
      break;
    case "ops":
      if (small) {
        score += 2;
      }
      if (coding) {
        score += 1;
      }
      break;
  }

  if (profile.codeHeavy && coding) {
    score += 3;
  }
  if (profile.planningHeavy && !coding) {
    score += 2;
  }
  if ((profile.reviewHeavy || profile.securityHeavy) && (reasoning || large)) {
    score += 2;
  }
  if (profile.productDelivery) {
    score += small ? -3 : 2;
  }
  if (profile.complexityHigh && !small) {
    score += 2;
  }
  if (!profile.simpleTask && small) {
    score -= 1;
  }
  if (profile.simpleTask && small) {
    score += 2;
  }
  if (profile.browserOrResearch && profile.simpleTask && small) {
    score += 1;
  }

  return score;
}

function buildPolicyReason(
  modelId: string,
  role: ModelRoutedRole,
  assignedModelId: string | null,
  profile: ModelTaskProfile,
): string {
  const reasons: string[] = [];

  if (normalizeModelId(modelId) === normalizeModelId(assignedModelId) && assignedModelId) {
    reasons.push("it matches the role's default lane");
  }
  if (role === "director" && isCodingModel(modelId)) {
    reasons.push("the task is implementation-heavy");
  }
  if (role === "advisor" && !isCodingModel(modelId)) {
    reasons.push("the task is planning-first");
  }
  if (role === "inspector" && (isReasoningModel(modelId) || isLargeModel(modelId))) {
    reasons.push("review and security work benefits from stronger reasoning headroom");
  }
  if (profile.simpleTask && isSmallModel(modelId)) {
    reasons.push("the step looks small enough for a faster lane");
  }
  if (profile.complexityHigh && !isSmallModel(modelId)) {
    reasons.push("the step looks complex enough to justify a stronger model");
  }

  if (reasons.length === 0) {
    return `${modelId} is the safest fit for this ${role} step.`;
  }

  return `${modelId} is the best fit because ${reasons.join(", ")}.`;
}

function buildPolicyConfidence(topScore: number, runnerUpScore: number): number {
  const margin = Math.max(0, topScore - runnerUpScore);
  return Math.max(0.55, Math.min(0.92, 0.58 + margin * 0.06));
}

function formatConversationMessage(message: ChatRequest["conversation"][number]): string {
  const speaker =
    message.role === "user"
      ? "User"
      : message.authorRole && message.authorRole !== "user"
        ? `Assistant (${message.authorRole})`
        : "Assistant";
  const content =
    message.content.length > MODEL_ROUTER_MESSAGE_CHAR_LIMIT
      ? `${message.content.slice(0, MODEL_ROUTER_MESSAGE_CHAR_LIMIT)}...`
      : message.content;
  return `${speaker}: ${content}`;
}

export function resolveModelRoutePolicy(options: {
  role: ModelRoutedRole;
  provider: Provider;
  assignedModelId: string | null;
  request: Pick<ChatRequest, "content" | "conversation">;
}): PolicyModelRouteEvaluation {
  const modelIds = dedupeModelIds(options.provider, options.assignedModelId);
  if (modelIds.length === 0) {
    return {
      decision: {
        modelId: null,
        reason: "No model is assigned or advertised for this provider.",
        source: "policy",
        confidence: 1,
      },
      shouldQueryDispatch: false,
      candidates: [],
    };
  }

  const profile = buildTaskProfile(options.request.content);
  const scored = modelIds
    .map((modelId) => ({
      modelId,
      summary: describeModel(modelId),
      score: scoreModelForTask(modelId, options.role, options.assignedModelId, profile),
    }))
    .sort((left, right) => right.score - left.score || left.modelId.localeCompare(right.modelId));

  const candidates = scored.slice(0, MAX_MODEL_CANDIDATES);
  const assignedCandidate = scored.find(
    (candidate) => normalizeModelId(candidate.modelId) === normalizeModelId(options.assignedModelId),
  );
  if (
    assignedCandidate &&
    !candidates.some((candidate) => normalizeModelId(candidate.modelId) === normalizeModelId(assignedCandidate.modelId))
  ) {
    candidates[candidates.length - 1] = assignedCandidate;
    candidates.sort((left, right) => right.score - left.score || left.modelId.localeCompare(right.modelId));
  }

  const winner = candidates[0]!;
  const runnerUpScore = candidates[1]?.score ?? winner.score;

  return {
    decision: {
      modelId: winner.modelId,
      reason: buildPolicyReason(winner.modelId, options.role, options.assignedModelId, profile),
      source: "policy",
      confidence: buildPolicyConfidence(winner.score, runnerUpScore),
    },
    shouldQueryDispatch: candidates.length > 1 && options.request.content.trim().length > 0,
    candidates: candidates.map(({ modelId, summary }) => ({ modelId, summary })),
  };
}

export function buildAssignedModelFallbackDecision(options: {
  role: ModelRoutedRole;
  assignedModelId: string | null;
  candidates: ModelRouteCandidate[];
  policyDecision: ExecutionModelDecision;
}): ExecutionModelDecision {
  const assignedModelId = normalizeModelId(options.assignedModelId);
  if (!assignedModelId) {
    return options.policyDecision;
  }

  const assignedCandidate = options.candidates.find((candidate) =>
    normalizeModelId(candidate.modelId) === assignedModelId,
  );
  if (!assignedCandidate) {
    return options.policyDecision;
  }

  if (normalizeModelId(options.policyDecision.modelId) === assignedModelId) {
    return options.policyDecision;
  }

  return {
    modelId: assignedCandidate.modelId,
    source: "policy",
    confidence: Math.max(options.policyDecision.confidence, 0.72),
    reason:
      `${assignedCandidate.modelId} stays the default model for ${options.role} because that role is explicitly assigned to it. ` +
      "Dispatch can override this only with a confident model-routing decision.",
  };
}

export function buildModelDispatchInput(options: {
  role: ModelRoutedRole;
  provider: Provider;
  assignedModelId: string | null;
  request: Pick<ChatRequest, "content" | "conversation">;
  candidates: ModelRouteCandidate[];
  fallbackDecision?: ExecutionModelDecision | null;
}): string {
  const historySummary = getHistorySummaryMessage(options.request.conversation);
  const recentMessages = options.request.conversation
    .filter((message) => !isHistorySummaryMessage(message))
    .slice(-MODEL_ROUTER_MAX_MESSAGES);

  let usedChars = 0;
  const selectedMessages: string[] = [];
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const formatted = formatConversationMessage(recentMessages[index]);
    const addition = selectedMessages.length === 0 ? formatted.length : formatted.length + 1;
    if (usedChars + addition > MODEL_ROUTER_CONTEXT_CHAR_BUDGET) {
      break;
    }
    selectedMessages.unshift(formatted);
    usedChars += addition;
  }

  const candidateLines = options.candidates
    .map((candidate) => `- ${candidate.modelId}: ${candidate.summary}`)
    .join("\n");

  return [
    "<routing_mode>\nmodel\n</routing_mode>",
    `<role>\n${options.role}\n</role>`,
    `<provider>\n${options.provider.name}\n</provider>`,
    options.assignedModelId ? `<assigned_model>\n${options.assignedModelId}\n</assigned_model>` : "",
    historySummary
      ? `<compacted_history>\n${historySummary.content.slice(0, MODEL_ROUTER_SUMMARY_CHAR_LIMIT)}\n</compacted_history>`
      : "",
    selectedMessages.length > 0 ? `<recent_conversation>\n${selectedMessages.join("\n")}\n</recent_conversation>` : "",
    `<latest_task>\n${options.request.content}\n</latest_task>`,
    `<model_candidates>\n${candidateLines}\n</model_candidates>`,
    options.fallbackDecision
      ? `<policy_fallback>\nmodelId=${options.fallbackDecision.modelId ?? "null"}\nconfidence=${options.fallbackDecision.confidence.toFixed(2)}\nreason=${options.fallbackDecision.reason}\n</policy_fallback>`
      : "",
    `Return strict JSON only: {"modelId":"${options.candidates[0]?.modelId ?? ""}","confidence":0.0,"reason":"brief explanation"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function resolveModelDispatchDecision(
  content: string,
  fallback: ExecutionModelDecision,
  candidates: ModelRouteCandidate[],
): ExecutionModelDecision {
  const parsed = parseModelDispatchDecision(content);
  const validCandidateIds = new Set(candidates.map((candidate) => normalizeModelId(candidate.modelId)));
  const parsedModelId = normalizeModelId(parsed?.modelId ?? null);

  if (!parsed || parsed.confidence < MIN_MODEL_DISPATCH_CONFIDENCE || !validCandidateIds.has(parsedModelId)) {
    return {
      ...fallback,
      source: "policy-fallback",
      reason: parsed
        ? `Dispatch model routing was invalid or low confidence (${parsed.confidence.toFixed(2)}), so the policy fallback was kept.`
        : "Dispatch model routing returned invalid output, so the policy fallback was kept.",
    };
  }

  return {
    modelId: candidates.find((candidate) => normalizeModelId(candidate.modelId) === parsedModelId)?.modelId ?? parsed.modelId,
    reason: parsed.reason,
    source: "router-llm",
    confidence: parsed.confidence,
  };
}

export function formatModelRouteSource(source: ModelDecisionSource): string {
  switch (source) {
    case "policy":
      return "model policy";
    case "router-llm":
      return "dispatch";
    case "policy-fallback":
      return "model policy fallback";
  }
}
