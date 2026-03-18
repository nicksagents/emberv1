import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTaskOutcomeFeedback,
  assessTask,
  resolveCognitiveProfile,
  createExecutionMonitor,
  updateExecutionMonitor,
  suggestStrategyAdjustment,
  buildMetacognitivePromptSection,
  buildProviderOverrides,
  shouldAutoSimulate,
  type TaskAssessment,
  type ExecutionMonitorState,
} from "./metacognition.js";
import type { ChatMessage, ToolCall } from "@ember/core";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    role: "user",
    authorRole: "user",
    mode: "auto",
    content: "",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-1",
    name: "read_file",
    arguments: { path: "/test" },
    status: "complete",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── assessTask ─────────────────────────────────────────────────────────────────

test("assessTask: simple questions are reflexive", () => {
  const assessment = assessTask("What time is it?", [], "coordinator");
  assert.equal(assessment.suggestedTier, "reflexive");
  assert.ok(assessment.complexity < 0.3);
  assert.equal(assessment.thinkingPlan.length, 0);
});

test("assessTask: implementation tasks score higher complexity", () => {
  const simple = assessTask("What time is it?", [], "coordinator");
  const complex = assessTask(
    "Implement a REST API endpoint for user authentication with JWT tokens and build comprehensive tests",
    [],
    "director",
  );
  assert.ok(complex.complexity > simple.complexity, "implementation should score higher than simple question");
  assert.ok(complex.complexity > 0.1);
});

test("assessTask: high-stakes tasks are deep", () => {
  const assessment = assessTask(
    "Architect a complete database migration for production that handles user payment data " +
    "with security compliance requirements and deploy it to the live system",
    [],
    "director",
  );
  assert.equal(assessment.suggestedTier, "deep");
  assert.ok(assessment.stakes > 0.1);
  assert.ok(assessment.risk > 0.1);
});

test("shouldAutoSimulate: enabled only for high-stakes simulation triggers", () => {
  const high = assessTask(
    "What if we deploy this critical production migration before launch with legal compliance and revenue impact risk?",
    [],
    "director",
  );
  const low = assessTask("What if we rename this local variable?", [], "director");
  assert.equal(shouldAutoSimulate(high), true);
  assert.equal(shouldAutoSimulate(low), false);
});

test("applyTaskOutcomeFeedback: boosts complexity when similar failures exist", async () => {
  const base = assessTask("Implement OAuth refresh token handling.", [], "director");
  const enriched = await applyTaskOutcomeFeedback(base, {
    taskDescription: "Implement OAuth refresh token handling.",
    memoryRepository: {
      search: async () => [
        {
          score: 0.88,
          matchedTerms: [],
          cueMatches: [],
          reason: "similar task_outcome",
          item: {
            id: "mem_1",
            sessionId: null,
            createdAt: "2026-03-15T10:00:00.000Z",
            updatedAt: "2026-03-15T10:00:00.000Z",
            observedAt: "2026-03-15T10:00:00.000Z",
            memoryType: "task_outcome",
            scope: "workspace",
            content: "Final task outcome: OAuth rollout failed due to expired token.",
            jsonValue: {
              taskDescription: "OAuth rollout",
              approach: "Direct deployment without token-refresh validation",
              result: "failure",
              failureReason: "The API token had expired.",
              timestamp: "2026-03-15T10:00:00.000Z",
            },
            tags: ["__task_outcome"],
            sourceType: "system",
            sourceRef: null,
            confidence: 0.8,
            salience: 0.8,
            volatility: "event",
            validFrom: null,
            validUntil: null,
            supersedesId: null,
            supersededById: null,
          },
        },
      ],
    } as any,
  });
  assert.ok(enriched.complexity >= base.complexity);
  assert.ok((enriched.pastOutcomes ?? []).length > 0);
});

test("assessTask: prior failures increase complexity", () => {
  const failMessages: ChatMessage[] = [
    makeMessage({
      role: "assistant",
      authorRole: "director",
      toolCalls: [
        makeToolCall({ status: "error", result: "Error: file not found" }),
        makeToolCall({ status: "error", result: "Error: permission denied" }),
      ],
    }),
  ];
  const withFailures = assessTask("Fix the build", failMessages, "director");
  const withoutFailures = assessTask("Fix the build", [], "director");
  assert.ok(withFailures.complexity > withoutFailures.complexity);
});

test("assessTask: generates thinking plan for multi-step tasks", () => {
  const assessment = assessTask(
    "First research the best approach to implement a caching layer, then build the implementation, and finally validate with comprehensive tests",
    [],
    "director",
  );
  assert.ok(assessment.thinkingPlan.length > 0, "multi-step tasks should get a thinking plan");
  assert.ok(assessment.estimatedSteps >= 3, "should estimate multiple steps");
});

test("assessTask: produces valid structure", () => {
  const assessment = assessTask("Do something", [], "coordinator");
  assert.match(assessment.id, /^meta_/);
  assert.ok(assessment.complexity >= 0 && assessment.complexity <= 1);
  assert.ok(assessment.risk >= 0 && assessment.risk <= 1);
  assert.ok(assessment.stakes >= 0 && assessment.stakes <= 1);
  assert.ok(assessment.createdAt);
});

// ─── resolveCognitiveProfile ────────────────────────────────────────────────────

test("resolveCognitiveProfile: reflexive for simple tasks", () => {
  const assessment = assessTask("hello", [], "coordinator");
  const profile = resolveCognitiveProfile(assessment);
  assert.equal(profile.tier, "reflexive");
  assert.equal(profile.preferLargeModel, false);
  assert.equal(profile.enableThinkingPlan, false);
  assert.ok(profile.maxToolLoopIterations < 15);
});

test("resolveCognitiveProfile: deep for complex tasks", () => {
  const assessment: TaskAssessment = {
    id: "test",
    complexity: 0.8,
    risk: 0.5,
    stakes: 0.6,
    ambiguity: 0.3,
    estimatedSteps: 6,
    suggestedTier: "deep",
    thinkingPlan: ["Plan", "Execute", "Verify"],
    createdAt: new Date().toISOString(),
  };
  const profile = resolveCognitiveProfile(assessment);
  assert.equal(profile.tier, "deep");
  assert.equal(profile.preferLargeModel, true);
  assert.equal(profile.preferReasoningModel, true);
  assert.ok(profile.maxToolLoopIterations > 20);
});

// ─── buildProviderOverrides ─────────────────────────────────────────────────────

test("buildProviderOverrides: complexityHigh for deep tier", () => {
  const profile = resolveCognitiveProfile({
    id: "t", complexity: 0.9, risk: 0.1, stakes: 0.1, ambiguity: 0.1,
    estimatedSteps: 5, suggestedTier: "deep", thinkingPlan: [], createdAt: "",
  });
  const overrides = buildProviderOverrides(profile);
  assert.equal(overrides.complexityHigh, true);
});

test("buildProviderOverrides: empty for reflexive tier", () => {
  const profile = resolveCognitiveProfile({
    id: "t", complexity: 0.1, risk: 0.1, stakes: 0.1, ambiguity: 0.1,
    estimatedSteps: 1, suggestedTier: "reflexive", thinkingPlan: [], createdAt: "",
  });
  const overrides = buildProviderOverrides(profile);
  assert.equal(overrides.complexityHigh, undefined);
});

// ─── ExecutionMonitor ───────────────────────────────────────────────────────────

test("ExecutionMonitor: starts clean", () => {
  const assessment = assessTask("test", [], "coordinator");
  const monitor = createExecutionMonitor(assessment);
  assert.equal(monitor.turnsCompleted, 0);
  assert.equal(monitor.stuck, false);
  assert.equal(monitor.errorCount, 0);
});

test("ExecutionMonitor: tracks successful progress", () => {
  const assessment = assessTask("test", [], "coordinator");
  let monitor = createExecutionMonitor(assessment);
  monitor = updateExecutionMonitor(monitor, makeToolCall({ name: "read_file" }));
  monitor = updateExecutionMonitor(monitor, makeToolCall({ name: "search_files", arguments: { query: "foo" } }));
  assert.equal(monitor.turnsCompleted, 2);
  assert.ok(monitor.progressScore > 0);
  assert.equal(monitor.stuck, false);
});

test("ExecutionMonitor: detects repeated tool calls", () => {
  const assessment = assessTask("test", [], "coordinator");
  let monitor = createExecutionMonitor(assessment);
  const tc = makeToolCall({ name: "read_file", arguments: { path: "/same" } });
  monitor = updateExecutionMonitor(monitor, tc);
  monitor = updateExecutionMonitor(monitor, tc);
  monitor = updateExecutionMonitor(monitor, tc);
  assert.ok(monitor.repeatedToolCalls >= 2);
  assert.equal(monitor.stuck, true);
});

test("ExecutionMonitor: detects consecutive errors", () => {
  const assessment = assessTask("test", [], "coordinator");
  let monitor = createExecutionMonitor(assessment);
  monitor = updateExecutionMonitor(monitor, makeToolCall({ status: "error", result: "Error: a", name: "a", arguments: { x: 1 } }));
  monitor = updateExecutionMonitor(monitor, makeToolCall({ status: "error", result: "Error: b", name: "b", arguments: { x: 2 } }));
  monitor = updateExecutionMonitor(monitor, makeToolCall({ status: "error", result: "Error: c", name: "c", arguments: { x: 3 } }));
  assert.equal(monitor.consecutiveErrors, 3);
  assert.equal(monitor.stuck, true);
});

test("ExecutionMonitor: resets consecutive errors on success", () => {
  const assessment = assessTask("test", [], "coordinator");
  let monitor = createExecutionMonitor(assessment);
  monitor = updateExecutionMonitor(monitor, makeToolCall({ status: "error", result: "Error: x" }));
  monitor = updateExecutionMonitor(monitor, makeToolCall({ status: "error", result: "Error: y", name: "b", arguments: { z: 1 } }));
  assert.equal(monitor.consecutiveErrors, 2);
  monitor = updateExecutionMonitor(monitor, makeToolCall({ name: "success_tool", arguments: { a: 1 } }));
  assert.equal(monitor.consecutiveErrors, 0);
});

// ─── suggestStrategyAdjustment ──────────────────────────────────────────────────

test("suggestStrategyAdjustment: null when not stuck", () => {
  const assessment = assessTask("test", [], "coordinator");
  const monitor = createExecutionMonitor(assessment);
  assert.equal(suggestStrategyAdjustment(monitor, assessment), null);
});

test("suggestStrategyAdjustment: switch-approach on repeated calls", () => {
  const assessment = assessTask("test", [], "coordinator");
  let monitor = createExecutionMonitor(assessment);
  const tc = makeToolCall({ name: "read_file", arguments: { path: "/same" } });
  monitor = updateExecutionMonitor(monitor, tc);
  monitor = updateExecutionMonitor(monitor, tc);
  monitor = updateExecutionMonitor(monitor, tc);
  const adjustment = suggestStrategyAdjustment(monitor, assessment);
  assert.ok(adjustment !== null);
  assert.equal(adjustment!.action, "switch-approach");
});

test("suggestStrategyAdjustment: escalate-model on consecutive errors", () => {
  const assessment = assessTask("fix something", [], "coordinator");
  let monitor = createExecutionMonitor(assessment);
  monitor = updateExecutionMonitor(monitor, makeToolCall({ status: "error", result: "Error: a", name: "x", arguments: { a: 1 } }));
  monitor = updateExecutionMonitor(monitor, makeToolCall({ status: "error", result: "Error: b", name: "y", arguments: { b: 2 } }));
  monitor = updateExecutionMonitor(monitor, makeToolCall({ status: "error", result: "Error: c", name: "z", arguments: { c: 3 } }));
  const adjustment = suggestStrategyAdjustment(monitor, assessment);
  assert.ok(adjustment !== null);
  assert.equal(adjustment!.action, "escalate-model");
});

test("suggestStrategyAdjustment: break-into-subtasks after escalation", () => {
  const assessment: TaskAssessment = {
    id: "test", complexity: 0.8, risk: 0.1, stakes: 0.1, ambiguity: 0.1,
    estimatedSteps: 5, suggestedTier: "deliberate", thinkingPlan: ["a", "b", "c"], createdAt: "",
  };
  const monitor: ExecutionMonitorState = {
    assessmentId: "test", turnsCompleted: 8, turnsWithoutProgress: 6,
    repeatedToolCalls: 0, errorCount: 4, consecutiveErrors: 1,
    lastToolName: "x", lastToolInput: "y", progressScore: 0.1,
    stuck: true, escalated: true, strategyAdjustments: ["escalate-model"],
  };
  const adjustment = suggestStrategyAdjustment(monitor, assessment);
  assert.ok(adjustment !== null);
  assert.equal(adjustment!.action, "break-into-subtasks");
});

// ─── buildMetacognitivePromptSection ────────────────────────────────────────────

test("buildMetacognitivePromptSection: empty for reflexive", () => {
  const assessment = assessTask("hello", [], "coordinator");
  const profile = resolveCognitiveProfile(assessment);
  assert.equal(buildMetacognitivePromptSection(assessment, profile), "");
});

test("buildMetacognitivePromptSection: includes plan for deliberate", () => {
  const assessment: TaskAssessment = {
    id: "test", complexity: 0.5, risk: 0.2, stakes: 0.2, ambiguity: 0.1,
    estimatedSteps: 4, suggestedTier: "deliberate",
    thinkingPlan: ["Research", "Plan", "Execute", "Verify"], createdAt: "",
  };
  const profile = resolveCognitiveProfile(assessment);
  const section = buildMetacognitivePromptSection(assessment, profile);
  assert.ok(section.includes("tier=deliberate"));
  assert.ok(section.includes("Thinking plan:"));
  assert.ok(section.includes("Research"));
});

test("buildMetacognitivePromptSection: high-stakes for deep", () => {
  const assessment: TaskAssessment = {
    id: "test", complexity: 0.9, risk: 0.8, stakes: 0.9, ambiguity: 0.2,
    estimatedSteps: 7, suggestedTier: "deep",
    thinkingPlan: ["Understand", "Plan", "Execute"], createdAt: "",
  };
  const profile = resolveCognitiveProfile(assessment);
  const section = buildMetacognitivePromptSection(assessment, profile);
  assert.ok(section.includes("tier=deep"));
  assert.ok(section.includes("high-stakes"));
});

test("buildMetacognitivePromptSection: includes prior failure context when available", () => {
  const assessment: TaskAssessment = {
    id: "test",
    complexity: 0.6,
    risk: 0.4,
    stakes: 0.6,
    ambiguity: 0.2,
    estimatedSteps: 4,
    suggestedTier: "deliberate",
    thinkingPlan: ["Plan", "Execute"],
    createdAt: "",
    pastOutcomes: [
      {
        id: "mem_failure",
        taskDescription: "OAuth rollout",
        approach: "Direct deploy",
        result: "failure",
        failureReason: "Expired token was not refreshed.",
        timestamp: "2026-03-15T10:00:00.000Z",
        similarityScore: 0.9,
      },
    ],
  };
  const section = buildMetacognitivePromptSection(assessment, resolveCognitiveProfile(assessment), "director");
  assert.match(section, /PAST EXPERIENCE/);
  assert.match(section, /Expired token/);
});
