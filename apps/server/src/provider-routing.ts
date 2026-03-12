import {
  getHistorySummaryMessage,
  isHistorySummaryMessage,
  isLocalProvider,
  resolveProviderContextWindowTokens,
  type ChatRequest,
  type Provider,
  type Role,
  type Settings,
} from "@ember/core";
import { isProductDeliveryRequest } from "./delivery-workflow.js";

export type ProviderRoutedRole = Exclude<Role, "dispatch">;

export type ProviderDecisionSource = "policy" | "router-llm" | "policy-fallback";

export interface ExecutionProviderDecision {
  providerId: string | null;
  reason: string;
  source: ProviderDecisionSource;
  confidence: number;
}

export interface ProviderRouteCandidate {
  providerId: string;
  providerName: string;
  summary: string;
}

export interface PolicyProviderRouteEvaluation {
  decision: ExecutionProviderDecision;
  shouldQueryDispatch: boolean;
  candidates: ProviderRouteCandidate[];
}

interface DispatchProviderDecisionPayload {
  providerId: string;
  confidence: number;
  reason: string;
}

const PROVIDER_ROUTER_MAX_MESSAGES = 6;
const PROVIDER_ROUTER_CONTEXT_CHAR_BUDGET = 1_900;
const PROVIDER_ROUTER_SUMMARY_CHAR_LIMIT = 800;
const PROVIDER_ROUTER_MESSAGE_CHAR_LIMIT = 420;
const MAX_PROVIDER_CANDIDATES = 6;
const MIN_PROVIDER_DISPATCH_CONFIDENCE = 0.36;

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

function normalizeProviderDispatchPayload(payload: unknown): DispatchProviderDecisionPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const providerId = typeof candidate.providerId === "string" ? candidate.providerId.trim() : "";
  const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
  const rawConfidence = candidate.confidence;
  const confidence =
    typeof rawConfidence === "number"
      ? rawConfidence
      : typeof rawConfidence === "string"
        ? Number(rawConfidence)
        : Number.NaN;

  if (!providerId || !reason || !Number.isFinite(confidence)) {
    return null;
  }

  return {
    providerId,
    reason,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

export function parseProviderDispatchDecision(content: string): DispatchProviderDecisionPayload | null {
  try {
    return normalizeProviderDispatchPayload(parseJsonOnly(content));
  } catch {
    return null;
  }
}

interface ProviderTaskProfile {
  simpleTask: boolean;
  browserOrResearch: boolean;
  codeHeavy: boolean;
  planningHeavy: boolean;
  reviewHeavy: boolean;
  securityHeavy: boolean;
  complexityHigh: boolean;
  productDelivery: boolean;
  needsTools: boolean;
}

function buildTaskProfile(content: string, role: ProviderRoutedRole): ProviderTaskProfile {
  const normalized = content.toLowerCase().trim();
  const taskCount = estimateTaskCount(normalized);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const browserScore = countPatternMatches(normalized, [
    /\bbrowser\b/,
    /\bwebsite\b/,
    /\bsite\b/,
    /\bnavigate\b/,
    /\bclick\b/,
    /\bplaywright\b/,
    /\bdom\b/,
    /\bui\b/,
  ]);
  const researchScore = countPatternMatches(normalized, [
    /\bresearch\b/,
    /\bsearch\b/,
    /\blook up\b/,
    /\bcompare\b/,
    /\bdocumentation\b/,
    /\bdocs\b/,
    /\bsource\b/,
  ]);
  const planningScore = countPatternMatches(normalized, [
    /\bplan\b/,
    /\barchitecture\b/,
    /\broadmap\b/,
    /\bmilestone\b/,
    /\bsequence\b/,
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
  const simpleTask = !complexityHigh && taskCount <= 2 && wordCount <= 18 && !productDelivery;
  const browserOrResearch = browserScore + researchScore >= 1;
  const codeHeavy = codingScore >= 1;
  const planningHeavy = planningScore >= 1;
  const reviewHeavy = reviewScore >= 1;
  const securityHeavy = /\bsecurity\b|\bvulnerab(?:ility|ilities)\b|\bthreat\b/.test(normalized);
  const needsTools =
    role === "director" ||
    role === "inspector" ||
    productDelivery ||
    browserOrResearch ||
    codeHeavy ||
    /\b(file|repo|workspace|project|terminal|shell|command|test|lint|typecheck|edit|write|patch|fix)\b/.test(
      normalized,
    );

  return {
    simpleTask,
    browserOrResearch,
    codeHeavy,
    planningHeavy,
    reviewHeavy,
    securityHeavy,
    complexityHigh,
    productDelivery,
    needsTools,
  };
}

function extractModelIds(provider: Provider): string[] {
  const seen = new Set<string>();
  return [provider.config.defaultModelId ?? null, ...provider.availableModels]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .filter((modelId) => {
      const normalized = modelId.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });
}

function extractModelSizeInBillions(modelId: string): number | null {
  const match = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function hasCodingModel(provider: Provider): boolean {
  return extractModelIds(provider).some((modelId) =>
    /\b(?:codex|coder|code)\b/.test(modelId.toLowerCase()) ||
    /-(?:codex|coder|code)(?:[-._]|$)/.test(modelId.toLowerCase()),
  );
}

function hasReasoningModel(provider: Provider): boolean {
  return extractModelIds(provider).some((modelId) => {
    const normalized = modelId.toLowerCase();
    const size = extractModelSizeInBillions(normalized);
    return (
      /\b(?:max|opus|ultra|reason|think|sonnet|claude)\b/.test(normalized) ||
      /\bgpt-5\.(?:4|3|2)\b/.test(normalized) ||
      /\bqwen(?:[\w.-]*)3\.5\b/.test(normalized) ||
      (size !== null && size >= 30)
    );
  });
}

function hasFastModel(provider: Provider): boolean {
  return extractModelIds(provider).some((modelId) => {
    const normalized = modelId.toLowerCase();
    const size = extractModelSizeInBillions(normalized);
    return /\b(?:mini|nano|small|flash|fast)\b/.test(normalized) || (size !== null && size <= 10);
  });
}

function buildProviderSummary(provider: Provider, settings: Settings): string {
  const locality = isLocalProvider(provider) ? "local" : "hosted";
  const contextWindow = resolveProviderContextWindowTokens(provider, settings);
  const models = extractModelIds(provider).slice(0, 3);
  const modelSummary = models.length > 0 ? `models ${models.join(", ")}` : "no advertised models";

  return [
    locality,
    provider.typeId,
    provider.capabilities.canUseTools ? "tools" : "no tools",
    provider.capabilities.canUseImages ? "images" : "no images",
    `context ${contextWindow}`,
    modelSummary,
  ].join(", ");
}

function buildPolicyReason(
  provider: Provider,
  role: ProviderRoutedRole,
  preferredProviderId: string | null,
  profile: ProviderTaskProfile,
  settings: Settings,
): string {
  const reasons: string[] = [];
  if (provider.id === preferredProviderId) {
    reasons.push("it matches the role's preferred provider lane");
  }
  if (role === "director" && hasCodingModel(provider)) {
    reasons.push("it exposes stronger coding-oriented models");
  }
  if ((role === "advisor" || role === "inspector") && hasReasoningModel(provider)) {
    reasons.push("it exposes stronger reasoning-oriented models");
  }
  if (profile.simpleTask && isLocalProvider(provider) && hasFastModel(provider)) {
    reasons.push("it is a faster local lane for a routine step");
  }
  if (profile.complexityHigh && resolveProviderContextWindowTokens(provider, settings) >= 100_000) {
    reasons.push("it has enough context headroom for the task");
  }
  if (profile.needsTools && provider.capabilities.canUseTools) {
    reasons.push("it can support the expected tool loop");
  }

  if (reasons.length === 0) {
    return `${provider.name} is the safest provider fit for this ${role} step.`;
  }

  return `${provider.name} is the best fit because ${reasons.join(", ")}.`;
}

function buildPolicyConfidence(topScore: number, runnerUpScore: number): number {
  const margin = Math.max(0, topScore - runnerUpScore);
  return Math.max(0.56, Math.min(0.93, 0.6 + margin * 0.05));
}

function formatConversationMessage(message: ChatRequest["conversation"][number]): string {
  const speaker =
    message.role === "user"
      ? "User"
      : message.authorRole && message.authorRole !== "user"
        ? `Assistant (${message.authorRole})`
        : "Assistant";
  const content =
    message.content.length > PROVIDER_ROUTER_MESSAGE_CHAR_LIMIT
      ? `${message.content.slice(0, PROVIDER_ROUTER_MESSAGE_CHAR_LIMIT)}...`
      : message.content;
  return `${speaker}: ${content}`;
}

export function resolveProviderRoutePolicy(options: {
  role: ProviderRoutedRole;
  providers: Provider[];
  preferredProviderId: string | null;
  request: Pick<ChatRequest, "content" | "conversation">;
  settings: Settings;
  requiresImages?: boolean;
}): PolicyProviderRouteEvaluation {
  const profile = buildTaskProfile(options.request.content, options.role);

  const scored = options.providers
    .filter((provider) => provider.status === "connected" && provider.capabilities.canChat)
    .filter((provider) => !options.requiresImages || provider.capabilities.canUseImages)
    .map((provider) => {
      let score = 0;
      if (provider.id === options.preferredProviderId) {
        score += 4;
      }
      if (profile.needsTools) {
        score += provider.capabilities.canUseTools ? 2 : -4;
      }
      if (profile.simpleTask && isLocalProvider(provider)) {
        score += 3;
      }
      if (!profile.simpleTask && !isLocalProvider(provider)) {
        score += 1;
      }
      if (profile.complexityHigh) {
        score += Math.min(4, Math.floor(resolveProviderContextWindowTokens(provider, options.settings) / 80_000));
      }
      if (profile.codeHeavy && hasCodingModel(provider)) {
        score += 4;
      }
      if ((profile.planningHeavy || profile.reviewHeavy || profile.securityHeavy) && hasReasoningModel(provider)) {
        score += 3;
      }
      if (profile.browserOrResearch && isLocalProvider(provider)) {
        score += 1;
      }
      if (profile.productDelivery && hasReasoningModel(provider)) {
        score += 2;
      }
      if (profile.productDelivery && !isLocalProvider(provider)) {
        score += 1;
      }
      if (profile.simpleTask && hasFastModel(provider)) {
        score += 2;
      }

      return {
        provider,
        score,
        summary: buildProviderSummary(provider, options.settings),
      };
    })
    .sort((left, right) => right.score - left.score || left.provider.name.localeCompare(right.provider.name));

  if (scored.length === 0) {
    return {
      decision: {
        providerId: null,
        reason: "No connected provider can satisfy this request.",
        source: "policy",
        confidence: 1,
      },
      shouldQueryDispatch: false,
      candidates: [],
    };
  }

  const candidates = scored.slice(0, MAX_PROVIDER_CANDIDATES);
  const preferredCandidate = scored.find((entry) => entry.provider.id === options.preferredProviderId);
  if (preferredCandidate && !candidates.some((entry) => entry.provider.id === preferredCandidate.provider.id)) {
    candidates[candidates.length - 1] = preferredCandidate;
    candidates.sort((left, right) => right.score - left.score || left.provider.name.localeCompare(right.provider.name));
  }

  const winner = candidates[0]!;
  const runnerUpScore = candidates[1]?.score ?? winner.score;
  const scoreMargin = winner.score - runnerUpScore;

  return {
    decision: {
      providerId: winner.provider.id,
      reason: buildPolicyReason(
        winner.provider,
        options.role,
        options.preferredProviderId,
        profile,
        options.settings,
      ),
      source: "policy",
      confidence: buildPolicyConfidence(winner.score, runnerUpScore),
    },
    shouldQueryDispatch:
      candidates.length > 1 &&
      options.request.content.trim().length > 0 &&
      (scoreMargin <= 3 || profile.complexityHigh || profile.productDelivery),
    candidates: candidates.map((entry) => ({
      providerId: entry.provider.id,
      providerName: entry.provider.name,
      summary: entry.summary,
    })),
  };
}

export function buildAssignedProviderFallbackDecision(options: {
  role: ProviderRoutedRole;
  preferredProviderId: string | null;
  providers: Provider[];
  policyDecision: ExecutionProviderDecision;
}): ExecutionProviderDecision {
  const preferredProvider = options.providers.find((provider) =>
    provider.id === options.preferredProviderId &&
    provider.status === "connected" &&
    provider.capabilities.canChat,
  );

  if (!preferredProvider) {
    return options.policyDecision;
  }

  if (options.policyDecision.providerId === preferredProvider.id) {
    return options.policyDecision;
  }

  return {
    providerId: preferredProvider.id,
    source: "policy",
    confidence: Math.max(options.policyDecision.confidence, 0.72),
    reason:
      `${preferredProvider.name} stays the default provider for ${options.role} because that role is explicitly assigned to it. ` +
      "Dispatch can override this only with a confident provider-routing decision.",
  };
}

export function buildProviderDispatchInput(options: {
  role: ProviderRoutedRole;
  request: Pick<ChatRequest, "content" | "conversation">;
  candidates: ProviderRouteCandidate[];
  preferredProviderId?: string | null;
  fallbackDecision?: ExecutionProviderDecision | null;
}): string {
  const historySummary = getHistorySummaryMessage(options.request.conversation);
  const recentMessages = options.request.conversation
    .filter((message) => !isHistorySummaryMessage(message))
    .slice(-PROVIDER_ROUTER_MAX_MESSAGES);

  let usedChars = 0;
  const selectedMessages: string[] = [];
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const formatted = formatConversationMessage(recentMessages[index]);
    const addition = selectedMessages.length === 0 ? formatted.length : formatted.length + 1;
    if (usedChars + addition > PROVIDER_ROUTER_CONTEXT_CHAR_BUDGET) {
      break;
    }
    selectedMessages.unshift(formatted);
    usedChars += addition;
  }

  const candidateLines = options.candidates
    .map((candidate) => `- ${candidate.providerId} (${candidate.providerName}): ${candidate.summary}`)
    .join("\n");

  return [
    "<routing_mode>\nprovider\n</routing_mode>",
    `<role>\n${options.role}\n</role>`,
    options.preferredProviderId ? `<preferred_provider>\n${options.preferredProviderId}\n</preferred_provider>` : "",
    historySummary
      ? `<compacted_history>\n${historySummary.content.slice(0, PROVIDER_ROUTER_SUMMARY_CHAR_LIMIT)}\n</compacted_history>`
      : "",
    selectedMessages.length > 0 ? `<recent_conversation>\n${selectedMessages.join("\n")}\n</recent_conversation>` : "",
    `<latest_task>\n${options.request.content}\n</latest_task>`,
    `<provider_candidates>\n${candidateLines}\n</provider_candidates>`,
    options.fallbackDecision
      ? `<policy_fallback>\nproviderId=${options.fallbackDecision.providerId ?? "null"}\nconfidence=${options.fallbackDecision.confidence.toFixed(2)}\nreason=${options.fallbackDecision.reason}\n</policy_fallback>`
      : "",
    `Return strict JSON only: {"providerId":"${options.candidates[0]?.providerId ?? ""}","confidence":0.0,"reason":"brief explanation"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function resolveProviderDispatchDecision(
  content: string,
  fallback: ExecutionProviderDecision,
  candidates: ProviderRouteCandidate[],
): ExecutionProviderDecision {
  const parsed = parseProviderDispatchDecision(content);
  const validCandidateIds = new Set(candidates.map((candidate) => candidate.providerId));

  if (
    !parsed ||
    parsed.confidence < MIN_PROVIDER_DISPATCH_CONFIDENCE ||
    !validCandidateIds.has(parsed.providerId)
  ) {
    return {
      ...fallback,
      source: "policy-fallback",
      reason: parsed
        ? `Dispatch provider routing was invalid or low confidence (${parsed.confidence.toFixed(2)}), so the policy fallback was kept.`
        : "Dispatch provider routing returned invalid output, so the policy fallback was kept.",
    };
  }

  return {
    providerId: parsed.providerId,
    reason: parsed.reason,
    source: "router-llm",
    confidence: parsed.confidence,
  };
}

export function formatProviderRouteSource(source: ProviderDecisionSource): string {
  switch (source) {
    case "policy":
      return "provider policy";
    case "router-llm":
      return "dispatch";
    case "policy-fallback":
      return "provider policy fallback";
  }
}
