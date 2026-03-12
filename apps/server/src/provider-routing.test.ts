import test from "node:test";
import assert from "node:assert/strict";

import { normalizeProvider, normalizeSettings } from "@ember/core";
import type { ChatRequest, Provider } from "@ember/core";

import {
  buildAssignedProviderFallbackDecision,
  buildProviderDispatchInput,
  parseProviderDispatchDecision,
  resolveProviderDispatchDecision,
  resolveProviderRoutePolicy,
} from "./provider-routing.js";

function makeProvider(options: {
  id: string;
  name: string;
  typeId?: Provider["typeId"];
  baseUrl?: string;
  models: string[];
  canUseTools?: boolean;
  canUseImages?: boolean;
  contextWindowTokens?: string;
}): Provider {
  return normalizeProvider({
    id: options.id,
    name: options.name,
    typeId: options.typeId ?? "openai-compatible",
    status: "connected",
    config: {
      baseUrl: options.baseUrl ?? "http://127.0.0.1:11434/v1",
      defaultModelId: options.models[0] ?? "",
      ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}),
    },
    availableModels: options.models,
    capabilities: {
      canChat: true,
      canListModels: true,
      requiresBrowserAuth: false,
      canUseImages: options.canUseImages ?? true,
      canUseTools: options.canUseTools ?? true,
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

const settings = normalizeSettings({}, "/tmp/workspace");

test("parseProviderDispatchDecision accepts strict JSON", () => {
  const decision = parseProviderDispatchDecision(
    '{"providerId":"provider_codex","confidence":0.82,"reason":"better coding lane"}',
  );

  assert.deepEqual(decision, {
    providerId: "provider_codex",
    confidence: 0.82,
    reason: "better coding lane",
  });
});

test("provider policy prefers coding-heavy provider for director work", () => {
  const localProvider = makeProvider({
    id: "provider_local",
    name: "Local Qwen",
    models: ["Qwen3.5-35B-A3B-Q5_K_M.gguf"],
    contextWindowTokens: "64000",
  });
  const codexProvider = makeProvider({
    id: "provider_codex",
    name: "Codex",
    typeId: "codex-cli",
    baseUrl: "https://api.example.test/v1",
    models: ["gpt-5.4", "gpt-5.3-codex"],
  });

  const result = resolveProviderRoutePolicy({
    role: "director",
    providers: [localProvider, codexProvider],
    preferredProviderId: "provider_local",
    request: makeRequest("implement auth across backend and frontend and debug the failing API flow"),
    settings,
    requiresImages: false,
  });

  assert.equal(result.decision.providerId, "provider_codex");
  assert.equal(result.shouldQueryDispatch, true);
  assert.match(result.decision.reason, /coding-oriented|best fit/i);
});

test("provider policy prefers a local fast lane for routine coordinator work", () => {
  const localProvider = makeProvider({
    id: "provider_local",
    name: "Local Qwen",
    models: ["Qwen_Qwen3.5-9B-Q6_K_L.gguf", "Qwen3.5-35B-A3B-Q5_K_M.gguf"],
    contextWindowTokens: "64000",
  });
  const codexProvider = makeProvider({
    id: "provider_codex",
    name: "Codex",
    typeId: "codex-cli",
    baseUrl: "https://api.example.test/v1",
    models: ["gpt-5.4", "gpt-5.3-codex"],
  });

  const result = resolveProviderRoutePolicy({
    role: "coordinator",
    providers: [codexProvider, localProvider],
    preferredProviderId: "provider_codex",
    request: makeRequest("search the docs and summarize the login flow"),
    settings,
    requiresImages: false,
  });

  assert.equal(result.decision.providerId, "provider_local");
  assert.match(result.decision.reason, /local lane|best fit/i);
});

test("assigned provider fallback keeps the explicit role lane when policy prefers another provider", () => {
  const localProvider = makeProvider({
    id: "provider_local",
    name: "Local Qwen",
    models: ["Qwen3.5-35B-A3B-Q5_K_M.gguf"],
    contextWindowTokens: "64000",
  });
  const codexProvider = makeProvider({
    id: "provider_codex",
    name: "Codex",
    typeId: "codex-cli",
    baseUrl: "https://api.example.test/v1",
    models: ["gpt-5.4", "gpt-5.3-codex"],
  });

  const policy = resolveProviderRoutePolicy({
    role: "coordinator",
    providers: [localProvider, codexProvider],
    preferredProviderId: "provider_local",
    request: makeRequest("go through the repo, inspect the tooling, and explain what you can do"),
    settings,
    requiresImages: false,
  });

  assert.equal(policy.decision.providerId, "provider_codex");

  const fallback = buildAssignedProviderFallbackDecision({
    role: "coordinator",
    preferredProviderId: "provider_local",
    providers: [localProvider, codexProvider],
    policyDecision: policy.decision,
  });

  assert.equal(fallback.providerId, "provider_local");
  assert.equal(fallback.source, "policy");
  assert.match(fallback.reason, /explicitly assigned|default provider/i);
});

test("buildProviderDispatchInput includes candidates and policy fallback", () => {
  const input = buildProviderDispatchInput({
    role: "advisor",
    request: makeRequest("plan the system architecture before coding"),
    candidates: [
      { providerId: "provider_codex", providerName: "Codex", summary: "hosted, tools, context 300000" },
      { providerId: "provider_local", providerName: "Local Qwen", summary: "local, tools, context 64000" },
    ],
    preferredProviderId: "provider_local",
    fallbackDecision: {
      providerId: "provider_codex",
      confidence: 0.74,
      reason: "Reasoning lane is stronger.",
      source: "policy",
    },
  });

  assert.match(input, /routing_mode/);
  assert.match(input, /provider_candidates/);
  assert.match(input, /preferred_provider/);
  assert.match(input, /policy_fallback/);
});

test("resolveProviderDispatchDecision falls back when dispatch picks an invalid provider", () => {
  const fallback = {
    providerId: "provider_codex",
    confidence: 0.7,
    reason: "Fallback reasoning lane.",
    source: "policy" as const,
  };

  const decision = resolveProviderDispatchDecision(
    '{"providerId":"provider_missing","confidence":0.91,"reason":"wrong"}',
    fallback,
    [
      { providerId: "provider_codex", providerName: "Codex", summary: "hosted" },
      { providerId: "provider_local", providerName: "Local Qwen", summary: "local" },
    ],
  );

  assert.equal(decision.providerId, "provider_codex");
  assert.equal(decision.source, "policy-fallback");
});
