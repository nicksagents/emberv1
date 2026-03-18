/**
 * Metacognition Layer — "Prefrontal Cortex"
 *
 * Assesses task complexity, allocates cognitive budget (model tier, tool loop
 * depth), monitors execution progress, and suggests strategy adjustments when
 * the agent gets stuck.
 *
 * Integration points:
 *   1. Pre-routing  — assessTask() informs role and model selection
 *   2. Prompt build — buildMetacognitivePromptSection() via extraSharedSections
 *   3. Tool loop    — updateExecutionMonitor() after each onToolCall
 */

import type { ChatMessage, MemoryItem, MemoryRepository, Role, ToolCall } from "@ember/core";

// ─── Types ──────────────────────────────────────────────────────────────────────

export type CognitiveTier = "reflexive" | "deliberate" | "deep";

export interface TaskAssessment {
  id: string;
  complexity: number;   // 0-1
  risk: number;         // 0-1
  stakes: number;       // 0-1
  ambiguity: number;    // 0-1
  estimatedSteps: number;
  suggestedTier: CognitiveTier;
  thinkingPlan: string[];
  createdAt: string;
  simulationTrigger?: boolean;
  simulationConfig?: SimulationSuggestion;
  pastOutcomes?: TaskOutcomeFeedback[];
  /** Internal: populated when simulation trigger patterns are detected. */
  _simulationTrigger?: SimulationSuggestion;
}

export interface SimulationSuggestion {
  recommended: boolean;
  scenario: string;
  domain: string;
  personaCount: number;
  roundCount: number;
}

export interface TaskOutcomeFeedback {
  id: string;
  taskDescription: string;
  approach: string;
  result: "success" | "failure" | "partial";
  failureReason: string | null;
  timestamp: string | null;
  similarityScore: number;
}

export interface CognitiveProfile {
  tier: CognitiveTier;
  preferLargeModel: boolean;
  preferReasoningModel: boolean;
  maxToolLoopIterations: number;
  enableThinkingPlan: boolean;
  allowMidTaskEscalation: boolean;
  simulationConfig?: SimulationSuggestion;
}

export type StrategyAction =
  | "escalate-model"
  | "switch-approach"
  | "break-into-subtasks"
  | "request-help"
  | "simplify";

export interface StrategyAdjustment {
  action: StrategyAction;
  reason: string;
  promptInjection: string;
}

export interface ExecutionMonitorState {
  assessmentId: string;
  turnsCompleted: number;
  turnsWithoutProgress: number;
  repeatedToolCalls: number;
  errorCount: number;
  consecutiveErrors: number;
  lastToolName: string | null;
  lastToolInput: string | null;
  progressScore: number;
  stuck: boolean;
  escalated: boolean;
  strategyAdjustments: string[];
}

// ─── Pattern Libraries ──────────────────────────────────────────────────────────

const COMPLEXITY_PATTERNS: [RegExp, number][] = [
  [/\b(architect|redesign|refactor|migration|infrastructure)\b/i, 0.18],
  [/\b(implement|build|create|develop|engineer)\b/i, 0.12],
  [/\b(integrate|connect|wire|compose|orchestrate)\b/i, 0.12],
  [/\b(optimize|performance|scale|concurrent)\b/i, 0.10],
  [/\b(debug|diagnose|troubleshoot|investigate)\b/i, 0.08],
  [/\b(endpoint|api|rest|graphql|authentication|auth)\b/i, 0.08],
  [/\b(database|schema|table|query|sql)\b/i, 0.08],
  [/\b(test|validate|verify|ensure)\b/i, 0.05],
  [/\b(complete|full|entire|comprehensive|system)\b/i, 0.06],
  [/\b(fix|patch|update|change|modify)\b/i, 0.03],
  [/\b(read|check|look|list|show|explain)\b/i, -0.05],
];

const RISK_PATTERNS: [RegExp, number][] = [
  [/\b(production|prod|live)\b/i, 0.22],
  [/\b(deploy|release|ship)\b/i, 0.18],
  [/\b(delete|remove|drop|destroy|purge|wipe)\b/i, 0.15],
  [/\b(security|auth|permission|credential|secret|token|key)\b/i, 0.14],
  [/\b(database|migration|schema|table)\b/i, 0.12],
  [/\b(payment|billing|money|financial|transaction)\b/i, 0.18],
  [/\b(user data|personal|pii|gdpr|privacy|compliance)\b/i, 0.14],
  [/\b(force|override|bypass|skip)\b/i, 0.08],
];

const STAKES_PATTERNS: [RegExp, number][] = [
  [/\b(critical|urgent|emergency|breaking|blocker)\b/i, 0.20],
  [/\b(revenue|customer|client|user-facing)\b/i, 0.15],
  [/\b(deadline|ship|launch|release)\b/i, 0.10],
  [/\b(legal|compliance|regulation|audit)\b/i, 0.15],
  [/\b(irreversible|permanent|destructive)\b/i, 0.15],
  [/\b(money|trading|invest|portfolio|market)\b/i, 0.12],
];

const AMBIGUITY_PATTERNS: [RegExp, number][] = [
  [/\b(maybe|possibly|might|could|probably|perhaps)\b/i, 0.08],
  [/\b(not sure|unclear|confused|don't know|figure out)\b/i, 0.10],
  [/\b(best way|good approach|how should|what if)\b/i, 0.06],
  [/\b(explore|research|investigate|look into)\b/i, 0.06],
  [/\?/g, 0.03],
];

const SIMULATION_TRIGGER_PATTERNS: RegExp[] = [
  /\bwhat if\b/i,
  /\bwhat are the odds\b/i,
  /\bshould I\b/i,
  /\bpredict\b/i,
  /\bforecast\b/i,
  /\bwhich option\b/i,
  /\bpros and cons\b/i,
  /\bcompare options\b/i,
  /\bwhat would happen\b/i,
  /\bscenario analysis\b/i,
  /\brisk assessment\b/i,
  /\blikelihood\b/i,
  /\bprobability\b/i,
];

const DOMAIN_DETECTION_MAP: [RegExp, string][] = [
  [/\b(stock|market|invest|portfolio|bitcoin|crypto|trading|financial|economy)\b/i, "finance"],
  [/\b(software|ai|machine learning|tech|startup|saas|cloud|computing)\b/i, "technology"],
  [/\b(election|war|sanctions|diplomacy|geopoliti|nato|un\b)/i, "geopolitics"],
  [/\b(social media|culture|demographic|society|community)\b/i, "social"],
  [/\b(company|business|revenue|acquisition|merger|startup|enterprise)\b/i, "business"],
  [/\b(research|experiment|physics|chemistry|biology|science)\b/i, "science"],
  [/\b(health|medical|disease|patient|clinical|pharma|drug)\b/i, "healthcare"],
  [/\b(climate|environment|energy|sustainability|carbon|pollution)\b/i, "environment"],
];

const MULTI_STEP_PATTERNS: RegExp[] = [
  /\b(first|then|after that|next|finally|lastly|step \d)\b/i,
  /\b(and also|additionally|plus|as well as|and then)\b/i,
  /\d+\.\s/,
  /\b(multiple|several|various|bunch of|all the)\b/i,
  /,\s*(then|and)\s/i,
];

// ─── Assessment ─────────────────────────────────────────────────────────────────

function countPatternScore(text: string, patterns: [RegExp, number][]): number {
  let score = 0;
  for (const [pattern, weight] of patterns) {
    if (pattern.test(text)) score += weight;
  }
  return score;
}

function countPriorFailures(conversation: ChatMessage[]): number {
  let failures = 0;
  const recent = conversation.slice(-10);
  for (const msg of recent) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.status === "error" || (tc.result && tc.result.startsWith("Error"))) {
          failures++;
        }
      }
    }
  }
  return failures;
}

function estimateStepCount(text: string): number {
  const normalized = text.toLowerCase();
  let steps = 1;
  for (const pattern of MULTI_STEP_PATTERNS) {
    if (pattern.test(normalized)) steps++;
  }
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount > 100) steps += 2;
  else if (wordCount > 50) steps += 1;
  return Math.min(steps, 10);
}

function generateThinkingPlan(text: string, complexity: number, steps: number): string[] {
  if (complexity < 0.2 && steps < 3) return [];
  const normalized = text.toLowerCase();
  const plan: string[] = [];

  // Always start with understanding
  if (complexity >= 0.5) {
    plan.push("Understand the full scope before acting");
  }

  // Research phase
  if (/\b(search|look|find|research|investigate)\b/.test(normalized) || complexity >= 0.6) {
    plan.push("Research existing solutions and context");
  }

  // Planning phase
  if (steps >= 3 || complexity >= 0.5) {
    plan.push("Plan the approach and identify dependencies");
  }

  // Execution phase
  plan.push("Execute the primary task");

  // Verification
  if (complexity >= 0.4 || /\b(test|verify|ensure|validate)\b/.test(normalized)) {
    plan.push("Verify the result and handle edge cases");
  }

  // Fallback
  if (complexity >= 0.6) {
    plan.push("If stuck, try alternative approach or break into subtasks");
  }

  return plan;
}

export function assessTask(
  content: string,
  conversation: ChatMessage[],
  _role: Role,
): TaskAssessment {
  const normalized = content.toLowerCase().trim();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const priorFailures = countPriorFailures(conversation);

  // Base complexity from patterns + length + steps
  let complexity = countPatternScore(normalized, COMPLEXITY_PATTERNS);
  complexity += Math.min(wordCount / 300, 0.2); // long messages = more complex
  complexity += priorFailures * 0.08; // prior failures indicate difficulty
  complexity = Math.max(0, Math.min(1, complexity));

  let risk = countPatternScore(normalized, RISK_PATTERNS);
  risk = Math.max(0, Math.min(1, risk));

  let stakes = countPatternScore(normalized, STAKES_PATTERNS);
  stakes += priorFailures * 0.05;
  stakes = Math.max(0, Math.min(1, stakes));

  let ambiguity = countPatternScore(normalized, AMBIGUITY_PATTERNS);
  ambiguity = Math.max(0, Math.min(1, ambiguity));

  const estimatedSteps = estimateStepCount(content);

  // Determine tier
  const maxDimension = Math.max(complexity, risk, stakes);
  const avgDimension = (complexity + risk + stakes) / 3;
  let suggestedTier: CognitiveTier;
  if (maxDimension > 0.7 || avgDimension > 0.5) {
    suggestedTier = "deep";
  } else if (maxDimension > 0.3 || avgDimension > 0.2 || estimatedSteps >= 4) {
    suggestedTier = "deliberate";
  } else {
    suggestedTier = "reflexive";
  }

  const thinkingPlan = generateThinkingPlan(content, complexity, estimatedSteps);

  const assessment: TaskAssessment = {
    id: `meta_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    complexity,
    risk,
    stakes,
    ambiguity,
    estimatedSteps,
    suggestedTier,
    thinkingPlan,
    createdAt: new Date().toISOString(),
  };

  // Check for simulation triggers
  const simulationTriggered = SIMULATION_TRIGGER_PATTERNS.some((p) => p.test(normalized));
  if (simulationTriggered && stakes > 0.5) {
    // Auto-detect domain
    let domain = "other";
    for (const [pattern, d] of DOMAIN_DETECTION_MAP) {
      if (pattern.test(normalized)) { domain = d; break; }
    }

    const simulationSuggestion: SimulationSuggestion = {
      recommended: true,
      scenario: content.slice(0, 500),
      domain,
      personaCount: complexity > 0.6 ? 12 : 8,
      roundCount: stakes > 0.7 ? 3 : 2,
    };
    assessment._simulationTrigger = simulationSuggestion;
    assessment.simulationTrigger = true;
    assessment.simulationConfig = simulationSuggestion;
  }

  return assessment;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeOutcomeResult(value: unknown): "success" | "failure" | "partial" {
  if (value === "success" || value === "failure" || value === "partial") {
    return value;
  }
  return "partial";
}

function parseTaskOutcomeFeedback(item: MemoryItem, similarityScore: number): TaskOutcomeFeedback {
  const metadata =
    item.jsonValue && typeof item.jsonValue === "object" && !Array.isArray(item.jsonValue)
      ? item.jsonValue
      : {};
  const taskDescription =
    typeof metadata.taskDescription === "string" && metadata.taskDescription.trim()
      ? metadata.taskDescription.trim()
      : item.content.replace(/^final task outcome:\s*/i, "").trim();
  const approach =
    typeof metadata.approach === "string" && metadata.approach.trim()
      ? metadata.approach.trim()
      : "Unknown approach";
  const failureReason =
    typeof metadata.failureReason === "string" && metadata.failureReason.trim()
      ? metadata.failureReason.trim()
      : null;
  const timestamp =
    typeof metadata.timestamp === "string" && metadata.timestamp.trim()
      ? metadata.timestamp.trim()
      : item.observedAt ?? item.updatedAt ?? null;

  return {
    id: item.id,
    taskDescription,
    approach,
    result: normalizeOutcomeResult(metadata.result),
    failureReason,
    timestamp,
    similarityScore,
  };
}

function inferTierFromAssessment(assessment: TaskAssessment): CognitiveTier {
  const maxDimension = Math.max(assessment.complexity, assessment.risk, assessment.stakes);
  const avgDimension = (assessment.complexity + assessment.risk + assessment.stakes) / 3;
  if (maxDimension > 0.7 || avgDimension > 0.5) {
    return "deep";
  }
  if (maxDimension > 0.3 || avgDimension > 0.2 || assessment.estimatedSteps >= 4) {
    return "deliberate";
  }
  return "reflexive";
}

export async function applyTaskOutcomeFeedback(
  assessment: TaskAssessment,
  options: {
    taskDescription: string;
    memoryRepository: MemoryRepository | null;
    maxResults?: number;
  },
): Promise<TaskAssessment> {
  if (!options.memoryRepository) {
    return assessment;
  }

  const maxResults = Math.max(1, Math.min(6, Math.floor(options.maxResults ?? 3)));
  try {
    const taggedResults = await options.memoryRepository.search({
      text: options.taskDescription,
      memoryTypes: ["task_outcome"],
      tags: ["__task_outcome"],
      maxResults,
      minScore: 0.08,
    });
    const fallbackResults = taggedResults.length >= maxResults
      ? []
      : await options.memoryRepository.search({
          text: options.taskDescription,
          memoryTypes: ["task_outcome"],
          maxResults,
          minScore: 0.08,
        });
    const merged = [...taggedResults, ...fallbackResults]
      .sort((left, right) => right.score - left.score)
      .filter((result, index, all) =>
        all.findIndex((candidate) => candidate.item.id === result.item.id) === index,
      )
      .slice(0, maxResults);
    if (merged.length === 0) {
      return assessment;
    }

    const outcomes = merged.map((result) => parseTaskOutcomeFeedback(result.item, result.score));
    const similarFailures = outcomes.filter((outcome) => outcome.result === "failure");
    if (similarFailures.length === 0) {
      return {
        ...assessment,
        pastOutcomes: outcomes,
      };
    }

    const complexityBoost = Math.min(0.24, similarFailures.length * 0.08);
    const riskBoost = Math.min(0.16, similarFailures.length * 0.05);
    const stakesBoost = Math.min(0.14, similarFailures.length * 0.04);
    const next: TaskAssessment = {
      ...assessment,
      complexity: clamp01(assessment.complexity + complexityBoost),
      risk: clamp01(assessment.risk + riskBoost),
      stakes: clamp01(assessment.stakes + stakesBoost),
      pastOutcomes: outcomes,
    };
    next.suggestedTier = inferTierFromAssessment(next);
    return next;
  } catch {
    return assessment;
  }
}

export function shouldAutoSimulate(assessment: TaskAssessment): boolean {
  return assessment.simulationTrigger === true && assessment.stakes > 0.5;
}

export function buildSimulationRecommendationHint(assessment: TaskAssessment): string | null {
  if (!shouldAutoSimulate(assessment) || !assessment.simulationConfig) {
    return null;
  }
  return [
    "[SIMULATION RECOMMENDED] This task involves high-stakes decision-making.",
    "Use the swarm_simulate tool to explore outcomes before committing to an approach.",
    `Suggested config: ${assessment.simulationConfig.personaCount} personas, ${assessment.simulationConfig.roundCount} rounds.`,
  ].join("\n");
}

// ─── Cognitive Profile ──────────────────────────────────────────────────────────

const TIER_PROFILES: Record<CognitiveTier, CognitiveProfile> = {
  reflexive: {
    tier: "reflexive",
    preferLargeModel: false,
    preferReasoningModel: false,
    maxToolLoopIterations: 8,
    enableThinkingPlan: false,
    allowMidTaskEscalation: false,
  },
  deliberate: {
    tier: "deliberate",
    preferLargeModel: false,
    preferReasoningModel: false,
    maxToolLoopIterations: 20,
    enableThinkingPlan: true,
    allowMidTaskEscalation: true,
  },
  deep: {
    tier: "deep",
    preferLargeModel: true,
    preferReasoningModel: true,
    maxToolLoopIterations: 35,
    enableThinkingPlan: true,
    allowMidTaskEscalation: true,
  },
};

export function resolveCognitiveProfile(assessment: TaskAssessment): CognitiveProfile {
  const profile = { ...TIER_PROFILES[assessment.suggestedTier] };

  // Check for simulation trigger
  if (assessment.simulationConfig || assessment._simulationTrigger) {
    profile.simulationConfig = assessment.simulationConfig ?? assessment._simulationTrigger;
  }

  return profile;
}

// ─── Provider Override ──────────────────────────────────────────────────────────

/**
 * Returns override flags that can be merged into the existing ProviderTaskProfile
 * to influence model/provider selection based on metacognitive assessment.
 */
export function buildProviderOverrides(profile: CognitiveProfile): {
  complexityHigh?: boolean;
  securityHeavy?: boolean;
  planningHeavy?: boolean;
} {
  if (profile.tier === "deep") {
    return { complexityHigh: true };
  }
  return {};
}

// ─── Execution Monitor ──────────────────────────────────────────────────────────

export function createExecutionMonitor(assessment: TaskAssessment): ExecutionMonitorState {
  return {
    assessmentId: assessment.id,
    turnsCompleted: 0,
    turnsWithoutProgress: 0,
    repeatedToolCalls: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    lastToolName: null,
    lastToolInput: null,
    progressScore: 0,
    stuck: false,
    escalated: false,
    strategyAdjustments: [],
  };
}

export function updateExecutionMonitor(
  state: ExecutionMonitorState,
  toolCall: ToolCall,
): ExecutionMonitorState {
  const updated = { ...state };
  updated.turnsCompleted++;

  const isError = toolCall.status === "error" ||
    (toolCall.result != null && toolCall.result.startsWith("Error"));

  if (isError) {
    updated.errorCount++;
    updated.consecutiveErrors++;
  } else {
    updated.consecutiveErrors = 0;
  }

  // Detect repeated tool calls (same name + similar input)
  const inputKey = JSON.stringify(toolCall.arguments).slice(0, 200);
  if (toolCall.name === updated.lastToolName && inputKey === updated.lastToolInput) {
    updated.repeatedToolCalls++;
  } else {
    updated.repeatedToolCalls = 0;
  }

  updated.lastToolName = toolCall.name;
  updated.lastToolInput = inputKey;

  // Progress scoring: successful diverse tool calls = progress
  if (!isError && updated.repeatedToolCalls === 0) {
    updated.progressScore = Math.min(1, updated.progressScore + 0.1);
    updated.turnsWithoutProgress = 0;
  } else {
    updated.turnsWithoutProgress++;
  }

  // Stuck detection
  updated.stuck =
    updated.repeatedToolCalls >= 2 ||
    updated.turnsWithoutProgress >= 3 ||
    updated.consecutiveErrors >= 3;

  return updated;
}

// ─── Strategy Adjustment ────────────────────────────────────────────────────────

export function suggestStrategyAdjustment(
  state: ExecutionMonitorState,
  assessment: TaskAssessment,
): StrategyAdjustment | null {
  if (!state.stuck) return null;

  // Already escalated — try different strategies
  if (state.escalated) {
    if (state.turnsWithoutProgress >= 5 && assessment.estimatedSteps >= 3) {
      return {
        action: "break-into-subtasks",
        reason: `${state.turnsWithoutProgress} turns without progress after escalation. Breaking into parallel subtasks.`,
        promptInjection:
          "STRATEGY SHIFT: Previous approach is not working. Break this task into " +
          "independent subtasks using launch_parallel_tasks. Each subtask should be " +
          "self-contained and verifiable.",
      };
    }
    if (state.repeatedToolCalls >= 2) {
      return {
        action: "switch-approach",
        reason: `Same tool called ${state.repeatedToolCalls + 1} times with same input after escalation.`,
        promptInjection:
          "STRATEGY SHIFT: You are repeating the same action. Stop and try a completely " +
          "different approach. If a tool is failing, use a different tool or method. " +
          "If a path is blocked, try an alternative path.",
      };
    }
    if (state.consecutiveErrors >= 3) {
      return {
        action: "request-help",
        reason: `${state.consecutiveErrors} consecutive errors after escalation.`,
        promptInjection:
          "STRATEGY SHIFT: Multiple errors in a row. Explain to the user what you have " +
          "tried and what is blocking you. Ask for guidance or suggest alternatives.",
      };
    }
    return {
      action: "simplify",
      reason: "Stuck after escalation — simplifying approach.",
      promptInjection:
        "STRATEGY SHIFT: Simplify your approach. Do the minimum viable version of " +
        "this task first, then iterate. Avoid over-engineering.",
    };
  }

  // First-time stuck — escalate model
  if (assessment.suggestedTier !== "deep" && state.consecutiveErrors >= 3) {
    return {
      action: "escalate-model",
      reason: `${state.consecutiveErrors} consecutive errors — escalating to stronger model.`,
      promptInjection:
        "COGNITIVE ESCALATION: This task requires deeper reasoning. Take a step back, " +
        "analyze what has gone wrong, and form a new plan before taking action.",
    };
  }

  if (state.repeatedToolCalls >= 2) {
    return {
      action: "switch-approach",
      reason: `Same tool+input repeated ${state.repeatedToolCalls + 1} times.`,
      promptInjection:
        "WARNING: You are in a loop — repeating the same tool call. Stop and try a " +
        "different approach. Consider: using a different tool, changing the input, " +
        "or breaking the task into smaller pieces.",
    };
  }

  if (state.turnsWithoutProgress >= 3) {
    return {
      action: "escalate-model",
      reason: `${state.turnsWithoutProgress} turns without measurable progress.`,
      promptInjection:
        "COGNITIVE ESCALATION: Progress has stalled. Reassess your approach: " +
        "What have you tried? What worked partially? What assumption might be wrong? " +
        "Consider using memory_search or web_search to find new information.",
    };
  }

  return null;
}

// ─── Prompt Section ─────────────────────────────────────────────────────────────

const SIMULATION_CAPABLE_ROLES = new Set(["coordinator", "advisor", "director", "inspector"]);

export function buildMetacognitivePromptSection(
  assessment: TaskAssessment,
  profile: CognitiveProfile,
  role?: string,
): string {
  // Reflexive tier — no extra prompt overhead
  if (profile.tier === "reflexive") return "";

  const sections: string[] = [];

  sections.push(
    `[Metacognition: tier=${profile.tier} complexity=${assessment.complexity.toFixed(2)} ` +
    `risk=${assessment.risk.toFixed(2)} stakes=${assessment.stakes.toFixed(2)} ` +
    `steps≈${assessment.estimatedSteps}]`,
  );

  if (profile.enableThinkingPlan && assessment.thinkingPlan.length > 0) {
    sections.push("Thinking plan:");
    for (let i = 0; i < assessment.thinkingPlan.length; i++) {
      sections.push(`  ${i + 1}. ${assessment.thinkingPlan[i]}`);
    }
  }

  if (profile.tier === "deep") {
    sections.push(
      "This is a high-stakes or complex task. Use thorough reasoning. " +
      "Verify assumptions before acting. Consider edge cases and failure modes.",
    );
  }

  if (profile.simulationConfig?.recommended && (!role || SIMULATION_CAPABLE_ROLES.has(role))) {
    sections.push(
      "\n[Simulation recommended] This question would benefit from multi-perspective simulation. " +
      "Consider using swarm_simulate to explore outcomes before answering. " +
      `Suggested config: domain=${profile.simulationConfig.domain}, ` +
      `personas=${profile.simulationConfig.personaCount}, rounds=${profile.simulationConfig.roundCount}.`,
    );
  }

  const failureOutcomes = (assessment.pastOutcomes ?? []).filter((outcome) => outcome.result === "failure");
  if (failureOutcomes.length > 0) {
    sections.push("\n[PAST EXPERIENCE] Similar tasks failed previously:");
    for (const outcome of failureOutcomes.slice(0, 2)) {
      const dateLabel = outcome.timestamp
        ? new Date(outcome.timestamp).toISOString().slice(0, 10)
        : "unknown date";
      const reason = outcome.failureReason ?? "No explicit failure reason recorded.";
      sections.push(`- ${dateLabel}: ${reason}`);
    }
    sections.push("Use this context to avoid repeating known failure modes.");
  }

  return sections.join("\n");
}

/**
 * Builds a strategy injection string to append to the system prompt when
 * the execution monitor detects the agent is stuck.
 */
export function buildStrategyInjection(adjustment: StrategyAdjustment): string {
  return `\n\n--- ${adjustment.promptInjection} ---`;
}
