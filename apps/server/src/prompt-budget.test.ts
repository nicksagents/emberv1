import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProvider, normalizeSettings } from "@ember/core";
import type { Provider } from "@ember/core";

import {
  resolveAdaptiveMemoryRetrievalBudget,
  resolveAdaptiveProcedureRetrievalBudget,
  resolveExecutionModelProfile,
  resolveExecutionPromptBudget,
  toMemorySearchBudgetOverrides,
} from "./prompt-budget.js";

function makeProvider(
  overrides: Partial<Provider> & { typeId: Provider["typeId"] },
): Provider {
  const { typeId, ...rest } = overrides;
  return normalizeProvider({
    id: "provider_test",
    name: "Provider",
    typeId,
    status: "connected",
    config: rest.config ?? {},
    availableModels: [],
    capabilities: {
      canChat: true,
      canListModels: true,
      requiresBrowserAuth: false,
      canUseImages: true,
      canUseTools: true,
    },
    lastError: null,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    ...rest,
  });
}

test("resolveExecutionPromptBudget keeps small local context windows usable", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const provider = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindowTokens: "25000",
    },
  });

  const budget = resolveExecutionPromptBudget(settings, provider);

  assert.equal(budget.contextWindowTokens, 25_000);
  assert.ok(budget.maxPromptTokens >= 13_500);
  assert.ok(budget.targetPromptTokens >= 11_500);
  assert.ok(budget.targetPromptTokens < budget.maxPromptTokens);
  assert.equal(budget.memory.maxInjectedItems, 3);
  assert.ok(budget.memory.maxInjectedChars <= 700);
  assert.ok(budget.memory.minScore > settings.memory.retrieval.minScore);
  assert.ok(budget.memory.reservedPromptTokens >= 96);
  assert.ok(budget.procedures.maxInjectedItems <= 1);
  assert.ok(budget.procedures.maxInjectedChars <= 350);
  assert.ok(budget.procedures.minScore > budget.memory.minScore);
});

test("resolveAdaptiveMemoryRetrievalBudget keeps injected memory small and selective", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const budget = resolveAdaptiveMemoryRetrievalBudget(settings.memory, 25_000);
  const overrides = toMemorySearchBudgetOverrides(budget);

  assert.deepEqual(overrides, {
    maxResults: 5,
    minScore: budget.minScore,
    maxInjectedItems: 3,
    maxInjectedChars: 700,
  });
  assert.ok(budget.minScore > 0.24);
});

test("resolveAdaptiveProcedureRetrievalBudget keeps learned procedure recall tighter than fact recall", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const budget = resolveAdaptiveProcedureRetrievalBudget(settings.memory, 25_000);

  assert.equal(budget.maxInjectedItems, 1);
  assert.ok(budget.maxInjectedChars <= 350);
  assert.ok(budget.minScore >= 0.5);
  assert.ok(budget.reservedPromptTokens >= 48);
});

test("resolveExecutionModelProfile enables compact coordinator mode for small local models only", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const localSmallProvider = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindowTokens: "25000",
    },
  });
  const localLargeProvider = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindowTokens: "64000",
    },
  });

  const compactCoordinator = resolveExecutionModelProfile(settings, localSmallProvider, "coordinator");
  const fullCoordinator = resolveExecutionModelProfile(settings, localLargeProvider, "coordinator");
  const directorProfile = resolveExecutionModelProfile(settings, localSmallProvider, "director");

  assert.equal(compactCoordinator.compactCoordinatorProfile, true);
  assert.equal(compactCoordinator.compactToolPrompt, true);
  assert.equal(compactCoordinator.compactToolset, true);
  assert.equal(fullCoordinator.compactCoordinatorProfile, false);
  assert.equal(directorProfile.compactCoordinatorProfile, false);
});
