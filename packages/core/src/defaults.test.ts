import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveCompressionPromptBudget,
  normalizeProvider,
  normalizeSettings,
  resolveProviderContextWindowTokens,
} from "./defaults.js";
import type { Provider } from "./types.js";

test("normalizeSettings derives compression prompt budgets from context window and reserves", () => {
  const settings = normalizeSettings(
    {
      compression: {
        enabled: true,
        contextWindowTokens: 100_000,
        toolLoopLimit: 0,
        responseHeadroomTokens: 25_000,
        safetyMarginTokens: 10_000,
        maxPromptTokens: 1,
        targetPromptTokens: 1,
        preserveRecentMessages: 6,
        minimumRecentMessages: 4,
      },
    },
    "/tmp/workspace",
  );

  assert.equal(settings.compression.maxPromptTokens, 67_000);
  assert.equal(settings.compression.targetPromptTokens, 59_000);
});

test("normalizeSettings clamps recent-message preservation and token floors", () => {
  const settings = normalizeSettings(
    {
      compression: {
        enabled: true,
        contextWindowTokens: 2_000,
        toolLoopLimit: 0,
        responseHeadroomTokens: 200,
        safetyMarginTokens: 100,
        maxPromptTokens: 999_999,
        targetPromptTokens: 999_999,
        preserveRecentMessages: 3,
        minimumRecentMessages: 9,
      },
    },
    "/tmp/workspace",
  );

  assert.equal(settings.compression.contextWindowTokens, 4_000);
  assert.equal(settings.compression.responseHeadroomTokens, 512);
  assert.equal(settings.compression.safetyMarginTokens, 512);
  assert.equal(settings.compression.minimumRecentMessages, 3);
  assert.equal(settings.compression.maxPromptTokens, 2_976);
  assert.equal(settings.compression.targetPromptTokens, 1_976);
});

test("provider context windows use local override only for local openai-compatible endpoints", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const lowContextSettings = normalizeSettings(
    {
      compression: {
        enabled: true,
        contextWindowTokens: 12_000,
        toolLoopLimit: 0,
        responseHeadroomTokens: 24_000,
        safetyMarginTokens: 12_000,
        maxPromptTokens: 1,
        targetPromptTokens: 1,
        preserveRecentMessages: 6,
        minimumRecentMessages: 4,
      },
    },
    "/tmp/workspace",
  );
  const makeProvider = (
    overrides: Partial<Provider> & { typeId: Provider["typeId"] },
  ): Provider => {
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
  };

  const localProvider = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindowTokens: "65536.8",
    },
  });
  const remoteProvider = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "https://api.openai.com/v1",
      contextWindowTokens: "64000",
    },
  });
  const anthropicProvider = makeProvider({
    typeId: "anthropic-api",
    config: {
      contextWindowTokens: "32000",
    },
  });
  const localProviderWithoutOverride = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
    },
  });

  assert.equal(localProvider.config.contextWindowTokens, "65536");
  assert.equal(resolveProviderContextWindowTokens(localProvider, settings), 65_536);

  assert.equal(remoteProvider.config.contextWindowTokens, undefined);
  assert.equal(resolveProviderContextWindowTokens(remoteProvider, settings), 100_000);

  assert.equal(anthropicProvider.config.contextWindowTokens, undefined);
  assert.equal(resolveProviderContextWindowTokens(anthropicProvider, settings), 100_000);

  assert.equal(resolveProviderContextWindowTokens(localProviderWithoutOverride, settings), 16_000);
  assert.equal(resolveProviderContextWindowTokens(localProviderWithoutOverride, lowContextSettings), 12_000);
});

test("deriveCompressionPromptBudget caps fixed reserves for low-context models", () => {
  const budget = deriveCompressionPromptBudget({
    contextWindowTokens: 25_000,
    responseHeadroomTokens: 24_000,
    safetyMarginTokens: 12_000,
  });

  // Small model (25k < 50k): ratios 0.15 response headroom, 0.05 safety margin
  assert.equal(budget.responseHeadroomTokens, 3_750);
  assert.equal(budget.safetyMarginTokens, 1_250);
  assert.equal(budget.maxPromptTokens, 20_000);
  assert.equal(budget.targetPromptTokens, 18_400);
});

test("normalizeSettings preserves memory rollout flags", () => {
  const settings = normalizeSettings(
    {
      memory: {
        enabled: true,
        backend: "sqlite",
        storage: {
          fileName: "memory.json",
          sqliteFileName: "memory.sqlite",
        },
        embeddings: {
          enabled: true,
          model: "token-hash",
          dimensions: 192,
          maxCandidates: 48,
        },
        retrieval: {
          maxResults: 8,
          minScore: 0.18,
          maxInjectedItems: 5,
          maxInjectedChars: 1800,
          lexicalWeight: 0.45,
          semanticWeight: 0.2,
          salienceWeight: 0.2,
          confidenceWeight: 0.15,
        },
        consolidation: {
          enabled: true,
          autoExtractUserFacts: true,
          autoExtractWorldFacts: true,
          autoSummarizeSessions: true,
          maxWriteCandidatesPerTurn: 6,
        },
        rollout: {
          traceCaptureEnabled: false,
          inspectionApiEnabled: false,
          cortexUiEnabled: true,
          replaySchedulerEnabled: false,
        },
      },
    },
    "/tmp/workspace",
  );

  assert.equal(settings.memory.rollout.traceCaptureEnabled, false);
  assert.equal(settings.memory.rollout.inspectionApiEnabled, false);
  assert.equal(settings.memory.rollout.cortexUiEnabled, true);
  assert.equal(settings.memory.rollout.replaySchedulerEnabled, false);
});

test("normalizeSettings clamps provider tool loop limit to supported bounds", () => {
  const high = normalizeSettings(
    {
      compression: {
        enabled: true,
        contextWindowTokens: 12_000,
        toolLoopLimit: 99_999,
        responseHeadroomTokens: 2_000,
        safetyMarginTokens: 1_000,
        maxPromptTokens: 1,
        targetPromptTokens: 1,
        preserveRecentMessages: 6,
        minimumRecentMessages: 4,
      },
    },
    "/tmp/workspace",
  );
  const low = normalizeSettings(
    {
      compression: {
        enabled: true,
        contextWindowTokens: 12_000,
        toolLoopLimit: -8,
        responseHeadroomTokens: 2_000,
        safetyMarginTokens: 1_000,
        maxPromptTokens: 1,
        targetPromptTokens: 1,
        preserveRecentMessages: 6,
        minimumRecentMessages: 4,
      },
    },
    "/tmp/workspace",
  );

  assert.equal(high.compression.toolLoopLimit, 4_000);
  assert.equal(low.compression.toolLoopLimit, 0);
});
