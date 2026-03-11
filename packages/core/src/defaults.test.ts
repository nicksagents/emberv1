import test from "node:test";
import assert from "node:assert/strict";

import {
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

  assert.equal(settings.compression.maxPromptTokens, 65_000);
  assert.equal(settings.compression.targetPromptTokens, 57_200);
});

test("normalizeSettings clamps recent-message preservation and token floors", () => {
  const settings = normalizeSettings(
    {
      compression: {
        enabled: true,
        contextWindowTokens: 2_000,
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
  assert.equal(settings.compression.targetPromptTokens, 1_000);
});

test("provider context windows use local override only for local openai-compatible endpoints", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const makeProvider = (
    overrides: Partial<Provider> & { typeId: Provider["typeId"] },
  ): Provider =>
    normalizeProvider({
      id: "provider_test",
      name: "Provider",
      typeId: overrides.typeId,
      status: "connected",
      config: overrides.config ?? {},
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
      ...overrides,
    });

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

  assert.equal(localProvider.config.contextWindowTokens, "65536");
  assert.equal(resolveProviderContextWindowTokens(localProvider, settings), 65_536);

  assert.equal(remoteProvider.config.contextWindowTokens, undefined);
  assert.equal(resolveProviderContextWindowTokens(remoteProvider, settings), 300_000);

  assert.equal(anthropicProvider.config.contextWindowTokens, undefined);
  assert.equal(resolveProviderContextWindowTokens(anthropicProvider, settings), 300_000);
});
