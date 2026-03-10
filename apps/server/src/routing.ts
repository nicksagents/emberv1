import type { ChatRequest, Role } from "@ember/core";

export type RoutedRole = Exclude<Role, "dispatch" | "ops">;

export type RouteDecisionSource = "policy" | "router-llm" | "policy-fallback";

export interface AutoRouteDecision {
  role: RoutedRole;
  reason: string;
  source: RouteDecisionSource;
  confidence: number;
}

export interface PolicyRouteEvaluation {
  decision: AutoRouteDecision;
  shouldQueryDispatch: boolean;
}

interface DispatchDecisionPayload {
  role: RoutedRole;
  confidence: number;
  reason: string;
}

const ROUTED_ROLES: RoutedRole[] = ["coordinator", "advisor", "director", "inspector"];

const DISPATCH_MAX_MESSAGES = 8;
const DISPATCH_CONTEXT_CHAR_BUDGET = 2200;
const DISPATCH_MESSAGE_CHAR_LIMIT = 500;
const MIN_DISPATCH_CONFIDENCE = 0.55;

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

function getMostRecentAssistantRole(request: ChatRequest): RoutedRole | null {
  for (let index = request.conversation.length - 1; index >= 0; index -= 1) {
    const message = request.conversation[index];
    if (message.role !== "assistant") {
      continue;
    }
    if (message.authorRole && ROUTED_ROLES.includes(message.authorRole as RoutedRole)) {
      return message.authorRole as RoutedRole;
    }
  }

  return null;
}

function isContextDependentFollowUp(content: string): boolean {
  return (
    /^(and|also|then|next|now|continue|keep going|go ahead|try again|again|still|instead)\b/.test(content) ||
    /\b(this|that|it|them|those|same|previous|above)\b/.test(content) ||
    /\b(follow up|follow-up|continue from|pick up where you left off)\b/.test(content)
  );
}

function normalizeDispatchPayload(payload: unknown): DispatchDecisionPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const role = typeof candidate.role === "string" ? candidate.role.trim().toLowerCase() : "";
  const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
  const rawConfidence = candidate.confidence;
  const confidence =
    typeof rawConfidence === "number"
      ? rawConfidence
      : typeof rawConfidence === "string"
        ? Number(rawConfidence)
        : Number.NaN;

  if (!ROUTED_ROLES.includes(role as RoutedRole) || !reason || !Number.isFinite(confidence)) {
    return null;
  }

  return {
    role: role as RoutedRole,
    reason,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
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

export function parseDispatchDecision(content: string): DispatchDecisionPayload | null {
  try {
    return normalizeDispatchPayload(parseJsonOnly(content));
  } catch {
    return null;
  }
}

function formatDispatchMessage(message: ChatRequest["conversation"][number]): string {
  const speaker =
    message.role === "user"
      ? "User"
      : message.authorRole && message.authorRole !== "user"
        ? `Assistant (${message.authorRole})`
        : "Assistant";
  const content =
    message.content.length > DISPATCH_MESSAGE_CHAR_LIMIT
      ? `${message.content.slice(0, DISPATCH_MESSAGE_CHAR_LIMIT)}...`
      : message.content;
  return `${speaker}: ${content}`;
}

export function buildDispatchInput(request: ChatRequest): string {
  const recentMessages = request.conversation.slice(-DISPATCH_MAX_MESSAGES);
  const alreadyHasLatest =
    recentMessages.at(-1)?.role === "user" &&
    recentMessages.at(-1)?.content.trim() === request.content.trim();

  let usedChars = 0;
  const selectedMessages: string[] = [];

  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const formatted = formatDispatchMessage(recentMessages[index]);
    const addition = selectedMessages.length === 0 ? formatted.length : formatted.length + 1;
    if (usedChars + addition > DISPATCH_CONTEXT_CHAR_BUDGET) {
      break;
    }
    selectedMessages.unshift(formatted);
    usedChars += addition;
  }

  const recentTranscript = selectedMessages.join("\n");
  const latestUserRequest = alreadyHasLatest ? recentMessages.at(-1)?.content ?? request.content : request.content;

  return [
    recentTranscript ? `<recent_conversation>\n${recentTranscript}\n</recent_conversation>` : "",
    `<latest_user_request>\n${latestUserRequest}\n</latest_user_request>`,
    'Return strict JSON only: {"role":"coordinator|advisor|director|inspector","confidence":0.0,"reason":"brief explanation"}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createDecision(
  role: RoutedRole,
  reason: string,
  source: RouteDecisionSource,
  confidence: number,
): AutoRouteDecision {
  return { role, reason, source, confidence };
}

export function routeAutoRequestPolicy(request: ChatRequest): PolicyRouteEvaluation {
  const normalized = request.content.toLowerCase().trim();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const taskCount = estimateTaskCount(normalized);
  const previousRole = getMostRecentAssistantRole(request);
  const followUp = isContextDependentFollowUp(normalized);

  const browserScore = countPatternMatches(normalized, [
    /\bbrowser\b/,
    /\bwebsite\b/,
    /\bsite\b/,
    /\bweb\s+page\b/,
    /\bplaywright\b/,
    /\bdevtools\b/,
    /\bscreenshot\b/,
    /\bdom\b/,
    /\bselector\b/,
    /\blog(?:\s|-)?in\b/,
    /\bsign(?:\s|-)?in\b/,
    /\bnavigate\b/,
    /\bclick\b/,
    /\btab\b/,
    /\bui\b/,
  ]);

  const researchScore = countPatternMatches(normalized, [
    /\bresearch\b/,
    /\blook up\b/,
    /\binvestigate\b/,
    /\bcompare\b/,
    /\bfind\b/,
    /\bsearch\b/,
    /\bdocumentation\b/,
    /\bdocs\b/,
    /\bsource\b/,
    /\bbrowse\b/,
  ]);

  const planningScore = countPatternMatches(normalized, [
    /\bplan\b/,
    /\bplanning\b/,
    /\broadmap\b/,
    /\bmilestone\b/,
    /\barchitecture\b/,
    /\barchitect\b/,
    /\bstrategy\b/,
    /\bscop(?:e|ing)\b/,
    /\bspec\b/,
    /\bdesign\b/,
    /\brollout\b/,
    /\btradeoff\b/,
    /\bsequence\b/,
  ]);

  const codingScore = countPatternMatches(normalized, [
    /\bcode\b/,
    /\bimplement\b/,
    /\bbuild\b/,
    /\bfix\b/,
    /\bdebug\b/,
    /\bbug\b/,
    /\brefactor\b/,
    /\bpatch\b/,
    /\bcomponent\b/,
    /\bapi\b/,
    /\bendpoint\b/,
    /\bbackend\b/,
    /\bfrontend\b/,
    /\btypescript\b/,
    /\bjavascript\b/,
    /\breact\b/,
    /\bcss\b/,
    /\bfunction\b/,
    /\bfile\b/,
    /\btest failing\b/,
  ]);

  const reviewScore = countPatternMatches(normalized, [
    /\breview\b/,
    /\baudit\b/,
    /\binspect\b/,
    /\bvalidate\b/,
    /\bverify\b/,
    /\bregression\b/,
    /\bsecurity\b/,
    /\bqa\b/,
    /\bfindings\b/,
    /\bwrite[-\s]?up\b/,
    /\breport\b/,
    /\bbug hunt\b/,
    /\btest\b/,
  ]);

  const filesystemScore = countPatternMatches(normalized, [
    /\bdelete\b/,
    /\bremove\b/,
    /\bmove\b/,
    /\bcopy\b/,
    /\bcreate\b/,
    /\bmkdir\b/,
    /\bfolder\b/,
    /\bdirectory\b/,
    /\bdesktop\b/,
    /\bpath\b/,
    /\bls\b/,
  ]);

  const complexityScore = countPatternMatches(normalized, [
    /\bcomplex\b/,
    /\bsubstantial\b/,
    /\bfull[-\s]?stack\b/,
    /\bcross[-\s]?cutting\b/,
    /\bend[-\s]?to[-\s]?end\b/,
    /\bmulti[-\s]?(?:step|phase|file)\b/,
    /\bdeep\b/,
    /\blonger\b/,
    /\broot cause\b/,
    /\bmigration\b/,
    /\boverhaul\b/,
    /\bauth(?:entication)?\b/,
    /\bdatabase\b/,
    /\bschema\b/,
    /\binfra(?:structure)?\b/,
    /\bdeployment\b/,
  ]);

  const wantsExecution = /(implement|build|fix|debug|update|change|edit|write|run|open|click|go to|navigate)/.test(
    normalized,
  );
  const wantsPlanningOnly =
    planningScore >= 1 &&
    (!wantsExecution ||
      /(before (?:coding|implementing)|plan first|think through|spec this|architecture only|roadmap)/.test(
        normalized,
      ));
  const wantsBrowserFindings =
    browserScore >= 1 && (reviewScore >= 1 || /\bfindings\b|\bwrite[-\s]?up\b|\breport\b/.test(normalized));
  const explicitReview =
    reviewScore >= 1 && !/(implement|build|fix now|go ahead and fix|patch it now)/.test(normalized);
  const substantialCoding =
    codingScore >= 2 &&
    (complexityScore >= 1 || taskCount >= 3 || wordCount >= 20 || /(across backend and frontend|multi-file|refactor)/.test(normalized));
  const routineExecution = browserScore + researchScore + filesystemScore >= 1;

  if (wantsBrowserFindings) {
    return {
      decision: createDecision(
        "inspector",
        "The request is browser-heavy and asks for validation or a findings write-up.",
        "policy",
        0.96,
      ),
      shouldQueryDispatch: false,
    };
  }

  if (explicitReview) {
    return {
      decision: createDecision(
        "inspector",
        "The request is primarily review, testing, validation, or bug finding.",
        "policy",
        0.97,
      ),
      shouldQueryDispatch: false,
    };
  }

  if (wantsPlanningOnly) {
    return {
      decision: createDecision(
        "advisor",
        "The request is asking for planning, architecture, sequencing, or scoping before execution.",
        "policy",
        0.96,
      ),
      shouldQueryDispatch: false,
    };
  }

  if (followUp && previousRole) {
    const conflictsWithDirector = previousRole !== "director" && substantialCoding;
    const conflictsWithAdvisor = previousRole !== "advisor" && wantsPlanningOnly;
    const conflictsWithInspector = previousRole !== "inspector" && (explicitReview || wantsBrowserFindings);

    if (!conflictsWithDirector && !conflictsWithAdvisor && !conflictsWithInspector) {
      return {
        decision: createDecision(
          previousRole,
          `This looks like a context-dependent follow-up, so keeping the current ${previousRole} role is safer than rerouting.`,
          "policy",
          0.9,
        ),
        shouldQueryDispatch: false,
      };
    }
  }

  if (substantialCoding) {
    return {
      decision: createDecision(
        "director",
        "The request is substantial technical execution that likely needs deeper coding loops.",
        "policy",
        0.94,
      ),
      shouldQueryDispatch: false,
    };
  }

  if (browserScore >= 1 || researchScore >= 1) {
    return {
      decision: createDecision(
        "coordinator",
        "Browsing, research, and routine investigation should stay with the coordinator by default.",
        "policy",
        0.93,
      ),
      shouldQueryDispatch: false,
    };
  }

  if (routineExecution && codingScore === 0) {
    return {
      decision: createDecision(
        "coordinator",
        "This is routine execution that the coordinator can handle directly.",
        "policy",
        0.9,
      ),
      shouldQueryDispatch: false,
    };
  }

  if (codingScore >= 1) {
    return {
      decision: createDecision(
        "coordinator",
        "This looks technical but not clearly substantial, so defaulting to coordinator unless dispatch sees stronger evidence for director.",
        "policy",
        0.62,
      ),
      shouldQueryDispatch: true,
    };
  }

  return {
    decision: createDecision(
      "coordinator",
      "Coordinator is the default role for direct answers and routine work.",
      "policy",
      0.88,
    ),
    shouldQueryDispatch: false,
  };
}

export function resolveDispatchDecision(
  content: string,
  fallback: AutoRouteDecision,
): AutoRouteDecision {
  const parsed = parseDispatchDecision(content);
  if (!parsed || parsed.confidence < MIN_DISPATCH_CONFIDENCE) {
    return {
      ...fallback,
      source: "policy-fallback",
      reason: parsed
        ? `Dispatch responded with low confidence (${parsed.confidence.toFixed(2)}), so the policy fallback was kept.`
        : "Dispatch returned invalid output, so the policy fallback was kept.",
    };
  }

  return {
    role: parsed.role,
    reason: parsed.reason,
    source: "router-llm",
    confidence: parsed.confidence,
  };
}

export function formatRouteSource(source: RouteDecisionSource): string {
  switch (source) {
    case "policy":
      return "policy";
    case "router-llm":
      return "dispatch";
    case "policy-fallback":
      return "policy fallback";
  }
}
