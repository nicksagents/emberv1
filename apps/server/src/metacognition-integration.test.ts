import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProvider, normalizeSettings } from "@ember/core";
import type { ChatMessage, Provider, RoleAssignment, ToolCall } from "@ember/core";

import { buildRolePromptStack } from "./orchestration-prompt.js";
import { resolveModelRoutePolicy } from "./model-routing.js";
import {
  assessTask,
  buildMetacognitivePromptSection,
  buildProviderOverrides,
  buildStrategyInjection,
  createExecutionMonitor,
  resolveCognitiveProfile,
  suggestStrategyAdjustment,
  updateExecutionMonitor,
} from "./metacognition.js";

function makeProvider(options: {
  id: string;
  name: string;
  models: string[];
  baseUrl?: string;
  contextWindowTokens?: string;
}): Provider {
  return normalizeProvider({
    id: options.id,
    name: options.name,
    typeId: "openai-compatible",
    status: "connected",
    config: {
      baseUrl: options.baseUrl ?? "http://127.0.0.1:11434/v1",
      defaultModelId: options.models[0] ?? "",
      contextWindowTokens: options.contextWindowTokens ?? "64000",
    },
    availableModels: options.models,
    capabilities: {
      canChat: true,
      canListModels: true,
      canUseTools: true,
      canUseImages: true,
      requiresBrowserAuth: false,
    },
    lastError: null,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
  });
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc_1",
    name: "read_file",
    arguments: { path: "/tmp/a.ts" },
    status: "complete",
    startedAt: "2026-03-17T10:00:00.000Z",
    result: "ok",
    ...overrides,
  };
}

test("simple task stays reflexive with no metacognitive prompt injection", () => {
  const assessment = assessTask("What does this function do?", [], "coordinator");
  const profile = resolveCognitiveProfile(assessment);
  const section = buildMetacognitivePromptSection(assessment, profile, "coordinator");

  assert.equal(profile.tier, "reflexive");
  assert.equal(section, "");
});

test("complex task injects metacognitive section into prompt stack", () => {
  const content = "Plan and implement a secure auth migration across backend and frontend.";
  const assessment = assessTask(content, [], "director");
  const profile = resolveCognitiveProfile(assessment);
  const section = buildMetacognitivePromptSection(assessment, profile, "director");

  const settings = normalizeSettings({}, "/tmp/workspace");
  const provider = makeProvider({
    id: "provider_director",
    name: "Director Provider",
    models: ["gpt-5.3-codex"],
    contextWindowTokens: "300000",
  });
  const assignmentMap = new Map<RoleAssignment["role"], RoleAssignment>([
    ["dispatch", { role: "dispatch", providerId: null, modelId: null }],
    ["coordinator", { role: "coordinator", providerId: null, modelId: null }],
    ["advisor", { role: "advisor", providerId: null, modelId: null }],
    ["director", { role: "director", providerId: provider.id, modelId: null }],
    ["inspector", { role: "inspector", providerId: null, modelId: null }],
    ["ops", { role: "ops", providerId: null, modelId: null }],
  ]);
  const stack = buildRolePromptStack({
    settings,
    role: "director",
    tools: [],
    providers: [provider],
    assignmentMap,
    extraSharedSections: [section],
  });

  assert.notEqual(section, "");
  assert.match(stack.shared, /Metacognition:/);
});

test("repeated tool calls produce strategy adjustment injection", () => {
  const assessment = assessTask("Fix auth bug in login handler.", [], "director");
  let monitor = createExecutionMonitor(assessment);
  const repeated = makeToolCall({
    name: "search_files",
    arguments: { query: "login handler" },
  });
  monitor = updateExecutionMonitor(monitor, repeated);
  monitor = updateExecutionMonitor(monitor, repeated);
  monitor = updateExecutionMonitor(monitor, repeated);
  const adjustment = suggestStrategyAdjustment(monitor, assessment);

  assert.ok(adjustment);
  assert.equal(adjustment?.action, "switch-approach");
  assert.match(buildStrategyInjection(adjustment!), /STRATEGY SHIFT|WARNING/i);
});

test("deep cognitive profile influences model route toward stronger lane", () => {
  const provider = makeProvider({
    id: "provider_local",
    name: "Local",
    models: ["qwen3-8b", "qwen3-32b"],
    contextWindowTokens: "64000",
  });
  const conversation: ChatMessage[] = [];
  const request = { content: "Check current status.", conversation };
  const baseDecision = resolveModelRoutePolicy({
    role: "director",
    provider,
    assignedModelId: null,
    request,
  });

  const deepAssessment = assessTask(
    "Architect a complete database migration for production payment data with security compliance and deploy it to the live system.",
    [],
    "director",
  );
  const deepProfile = resolveCognitiveProfile(deepAssessment);
  const overrideDecision = resolveModelRoutePolicy({
    role: "director",
    provider,
    assignedModelId: null,
    request,
    profileOverrides: buildProviderOverrides(deepProfile),
  });

  assert.equal(baseDecision.decision.modelId, "qwen3-8b");
  assert.equal(overrideDecision.decision.modelId, "qwen3-32b");
});
