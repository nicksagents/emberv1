import test from "node:test";
import assert from "node:assert/strict";

import { normalizeProvider } from "@ember/core";
import type { ChatRequest, Provider } from "@ember/core";

import {
  buildAssignedModelFallbackDecision,
  buildModelDispatchInput,
  formatModelRouteSource,
  parseModelDispatchDecision,
  resolveModelDispatchDecision,
  resolveModelRoutePolicy,
} from "./model-routing.js";

function makeProvider(name: string, models: string[]): Provider {
  return normalizeProvider({
    id: `provider_${name.toLowerCase().replace(/\s+/g, "_")}`,
    name,
    typeId: "openai-compatible",
    status: "connected",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModelId: models[0] ?? "",
    },
    availableModels: models,
    capabilities: {
      canChat: true,
      canListModels: true,
      requiresBrowserAuth: false,
      canUseImages: true,
      canUseTools: true,
    },
    lastError: null,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
  });
}

function makeRequest(
  content: string,
  conversation: ChatRequest["conversation"] = [],
): Pick<ChatRequest, "content" | "conversation"> {
  return {
    content,
    conversation,
  };
}

test("parseModelDispatchDecision accepts strict JSON", () => {
  const decision = parseModelDispatchDecision(
    '{"modelId":"gpt-5.3-codex","confidence":0.81,"reason":"coding-heavy task"}',
  );

  assert.deepEqual(decision, {
    modelId: "gpt-5.3-codex",
    confidence: 0.81,
    reason: "coding-heavy task",
  });
});

test("model policy prefers coding-specialized models for director work", () => {
  const provider = makeProvider("Codex", [
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.1-codex-mini",
  ]);

  const result = resolveModelRoutePolicy({
    role: "director",
    provider,
    assignedModelId: "gpt-5.4",
    request: makeRequest("implement auth across backend and frontend and debug the failing API flow"),
  });

  assert.equal(result.decision.modelId, "gpt-5.3-codex");
  assert.equal(result.shouldQueryDispatch, true);
  assert.match(result.decision.reason, /implementation-heavy|best fit/i);
});

test("model policy prefers planning and reasoning models for advisor work", () => {
  const provider = makeProvider("Codex", [
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.1-codex-mini",
  ]);

  const result = resolveModelRoutePolicy({
    role: "advisor",
    provider,
    assignedModelId: "gpt-5.3-codex",
    request: makeRequest("plan the system architecture, rollout strategy, and migration sequence before coding"),
  });

  assert.equal(result.decision.modelId, "gpt-5.4");
  assert.equal(result.shouldQueryDispatch, true);
  assert.match(result.decision.reason, /planning-first|best fit/i);
});

test("assigned model fallback keeps the explicit role model when policy prefers another model", () => {
  const provider = makeProvider("Codex", [
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.1-codex-mini",
  ]);

  const policy = resolveModelRoutePolicy({
    role: "director",
    provider,
    assignedModelId: "gpt-5.4",
    request: makeRequest("implement auth across backend and frontend and debug the failing API flow"),
  });

  assert.equal(policy.decision.modelId, "gpt-5.3-codex");

  const fallback = buildAssignedModelFallbackDecision({
    role: "director",
    assignedModelId: "gpt-5.4",
    candidates: policy.candidates,
    policyDecision: policy.decision,
  });

  assert.equal(fallback.modelId, "gpt-5.4");
  assert.equal(fallback.source, "policy");
  assert.match(fallback.reason, /explicitly assigned|default model/i);
});

test("buildModelDispatchInput includes candidates, task context, and policy fallback", () => {
  const provider = makeProvider("Codex", [
    "gpt-5.4",
    "gpt-5.3-codex",
  ]);
  const policy = resolveModelRoutePolicy({
    role: "director",
    provider,
    assignedModelId: "gpt-5.4",
    request: makeRequest("implement the feature from the approved plan"),
  });

  const input = buildModelDispatchInput({
    role: "director",
    provider,
    assignedModelId: "gpt-5.4",
    request: makeRequest("implement the feature from the approved plan"),
    candidates: policy.candidates,
    fallbackDecision: policy.decision,
  });

  assert.match(input, /routing_mode/);
  assert.match(input, /model_candidates/);
  assert.match(input, /gpt-5.3-codex/);
  assert.match(input, /policy_fallback/);
  assert.match(input, /latest_task/);
});

test("resolveModelDispatchDecision falls back when dispatch picks an invalid candidate", () => {
  const fallback = {
    modelId: "gpt-5.3-codex",
    confidence: 0.74,
    reason: "Fallback coding lane.",
    source: "policy" as const,
  };

  const decision = resolveModelDispatchDecision(
    '{"modelId":"not-a-real-model","confidence":0.92,"reason":"wrong"}',
    fallback,
    [
      { modelId: "gpt-5.4", summary: "reasoning-heavy" },
      { modelId: "gpt-5.3-codex", summary: "coding-specialized" },
    ],
  );

  assert.equal(decision.modelId, "gpt-5.3-codex");
  assert.equal(decision.source, "policy-fallback");
});

test("resolveModelRoutePolicy returns null decision when provider has no usable models", () => {
  const provider = makeProvider("Empty", []);
  provider.config.defaultModelId = "";

  const result = resolveModelRoutePolicy({
    role: "coordinator",
    provider,
    assignedModelId: null,
    request: makeRequest("quick status check"),
  });

  assert.equal(result.decision.modelId, null);
  assert.equal(result.shouldQueryDispatch, false);
  assert.equal(result.candidates.length, 0);
});

test("resolveModelDispatchDecision keeps fallback when dispatch confidence is too low", () => {
  const fallback = {
    modelId: "gpt-5.4",
    confidence: 0.78,
    reason: "Policy-selected best match.",
    source: "policy" as const,
  };

  const decision = resolveModelDispatchDecision(
    '{"modelId":"gpt-5.3-codex","confidence":0.21,"reason":"too uncertain"}',
    fallback,
    [
      { modelId: "gpt-5.4", summary: "reasoning-heavy" },
      { modelId: "gpt-5.3-codex", summary: "coding-specialized" },
    ],
  );

  assert.equal(decision.modelId, "gpt-5.4");
  assert.equal(decision.source, "policy-fallback");
});

test("model policy honors deep-profile override and routes complex work to stronger models", () => {
  const provider = makeProvider("Local", ["qwen3-8b", "qwen3-32b"]);

  const baseline = resolveModelRoutePolicy({
    role: "director",
    provider,
    assignedModelId: null,
    request: makeRequest("check status"),
  });
  const override = resolveModelRoutePolicy({
    role: "director",
    provider,
    assignedModelId: null,
    request: makeRequest("check status"),
    profileOverrides: {
      complexityHigh: true,
    },
  });

  assert.equal(baseline.decision.modelId, "qwen3-8b");
  assert.equal(override.decision.modelId, "qwen3-32b");
});

test("formatModelRouteSource maps routing source labels", () => {
  assert.equal(formatModelRouteSource("policy"), "model policy");
  assert.equal(formatModelRouteSource("router-llm"), "dispatch");
  assert.equal(formatModelRouteSource("policy-fallback"), "model policy fallback");
});
