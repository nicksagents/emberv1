import assert from "node:assert/strict";
import test from "node:test";

import { ROLES, normalizeProvider, normalizeSettings } from "@ember/core";
import type { Provider, RoleAssignment } from "@ember/core";

import {
  resolveAdaptiveMemoryRetrievalBudget,
  resolveAdaptiveProcedureRetrievalBudget,
  resolveExecutionModelProfile,
  resolveExecutionPromptBudget,
  toMemorySearchBudgetOverrides,
} from "./prompt-budget.js";
import { buildRolePromptStack } from "./orchestration-prompt.js";
import { getExecutionToolsForRole } from "./tools/index.js";

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

test("resolveExecutionModelProfile enables compact prompts for small coordinators and ultra-small specialists", () => {
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
  const localTinyProvider = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindowTokens: "10240",
    },
  });

  const compactCoordinator = resolveExecutionModelProfile(settings, localSmallProvider, "coordinator");
  const fullCoordinator = resolveExecutionModelProfile(settings, localLargeProvider, "coordinator");
  const directorProfile = resolveExecutionModelProfile(settings, localSmallProvider, "director");
  const ultraCompactDirector = resolveExecutionModelProfile(settings, localTinyProvider, "director");

  assert.equal(compactCoordinator.compactRolePrompt, true);
  assert.equal(compactCoordinator.compactToolPrompt, true);
  assert.equal(compactCoordinator.compactToolset, true);
  assert.equal(compactCoordinator.ultraCompactToolset, false);
  assert.equal(fullCoordinator.compactRolePrompt, false);
  // 25k model is under 50k threshold — all roles get compact
  assert.equal(directorProfile.compactRolePrompt, true);
  assert.equal(directorProfile.ultraCompactToolset, false);
  assert.equal(ultraCompactDirector.compactRolePrompt, true);
  assert.equal(ultraCompactDirector.compactToolset, true);
  assert.equal(ultraCompactDirector.ultraCompactToolset, true);
});

test("compact coordinator profile keeps prompt and tool overhead small for local models", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const provider = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindowTokens: "25000",
    },
  });

  const executionProfile = resolveExecutionModelProfile(settings, provider, "coordinator");
  const tools = getExecutionToolsForRole("coordinator", {
    compact: executionProfile.compactToolset,
    content: "Search the latest docs and fetch the relevant page.",
    conversation: [],
  });
  const assignmentMap = new Map<RoleAssignment["role"], RoleAssignment>(
    ROLES.map((role) => [
      role,
      {
        role,
        providerId: role === "coordinator" ? provider.id : null,
        modelId: null,
      },
    ]),
  );
  const promptStack = buildRolePromptStack({
    settings,
    role: "coordinator",
    tools,
    providers: [provider],
    assignmentMap,
    compactRolePrompt: executionProfile.compactRolePrompt,
    compactToolPrompt: executionProfile.compactToolPrompt,
  });

  const promptChars = [promptStack.shared, promptStack.role, promptStack.tools].join("\n\n").length;
  const toolBodyChars = JSON.stringify(
    tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
  ).length;

  assert.ok(promptChars < 3_200);
  assert.ok(toolBodyChars < 3_600);
  assert.ok(tools.length <= 6);
  assert.match(promptStack.shared, /Current lane:/);
});

test("ultra compact specialist profile trims the tool surface for tiny local models", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const provider = makeProvider({
    typeId: "openai-compatible",
    config: {
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindowTokens: "10240",
    },
  });

  const profile = resolveExecutionModelProfile(settings, provider, "director");
  const task = "Inspect the repo, edit the failing server file, run the build, and fix any errors.";
  const fullTools = getExecutionToolsForRole("director", {
    compact: false,
    content: task,
    conversation: [],
  });
  const compactTools = getExecutionToolsForRole("director", {
    compact: profile.compactToolset,
    content: task,
    conversation: [],
  });

  const fullToolBodyChars = JSON.stringify(fullTools).length;
  const compactToolBodyChars = JSON.stringify(compactTools).length;

  assert.equal(profile.compactRolePrompt, true);
  assert.ok(compactTools.length < fullTools.length);
  assert.ok(compactToolBodyChars < fullToolBodyChars);
});
