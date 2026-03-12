import assert from "node:assert/strict";
import test from "node:test";

import { ROLES, normalizeProvider, normalizeSettings } from "@ember/core";
import type { Provider, RoleAssignment } from "@ember/core";

import { buildOrchestrationPrompt, buildRolePromptStack } from "./orchestration-prompt.js";
import type { EmberTool } from "./tools/index.js";
import { registerMcpTools } from "./tools/index.js";

function makeProvider(
  id: string,
  name: string,
  modelId: string,
): Provider {
  return normalizeProvider({
    id,
    name,
    typeId: "openai-compatible",
    status: "connected",
    config: {
      defaultModelId: modelId,
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindowTokens: "64000",
    },
    availableModels: [modelId],
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

function makeNoopTool(name: string, description: string): EmberTool {
  return {
    definition: {
      name,
      description,
      inputSchema: { type: "object", properties: {} },
    },
    execute: async () => "ok",
  };
}

function buildAssignmentMap(providerByRole: Partial<Record<RoleAssignment["role"], string>>): Map<RoleAssignment["role"], RoleAssignment> {
  return new Map(
    ROLES.map((role) => [
      role,
      {
        role,
        providerId: providerByRole[role] ?? null,
        modelId: null,
      },
    ]),
  );
}

test("orchestration prompt exposes current model lanes and live MCP surfaces", () => {
  registerMcpTools([
    {
      tool: makeNoopTool(
        "mcp__atlas__query_workspace",
        "Query a shared workspace knowledge base.",
      ),
      roles: ["coordinator", "director"],
    },
  ]);

  const providers = [
    makeProvider("provider_coord", "Coordinator Provider", "qwen3-32b"),
    makeProvider("provider_director", "Director Provider", "gpt-5-coder"),
    makeProvider("provider_inspector", "Inspector Provider", "o4-mini"),
  ];
  const assignmentMap = buildAssignmentMap({
    coordinator: "provider_coord",
    director: "provider_director",
    inspector: "provider_inspector",
  });

  const prompt = buildOrchestrationPrompt({
    role: "coordinator",
    providers,
    assignmentMap,
  });

  assert.match(prompt, /Current role: coordinator/i);
  assert.match(prompt, /coordinator: .*qwen3-32b/i);
  assert.match(prompt, /director: .*gpt-5-coder/i);
  assert.match(prompt, /Global MCP surfaces:/);
  assert.match(prompt, /Atlas: coordinator, director/);
});

test("buildRolePromptStack combines shared prompt, orchestration brief, and role skills", () => {
  const settings = normalizeSettings({}, "/tmp/workspace");
  const coordinatorProvider = makeProvider("provider_coord", "Coordinator Provider", "qwen3-32b");
  const assignmentMap = buildAssignmentMap({
    coordinator: coordinatorProvider.id,
  });

  const promptStack = buildRolePromptStack({
    settings,
    role: "dispatch",
    tools: [],
    providers: [coordinatorProvider],
    assignmentMap,
  });

  assert.match(promptStack.shared, /## Team Orchestration/);
  assert.match(promptStack.shared, /Current role: dispatch/i);
  assert.match(promptStack.tools, /## Workflow/);
  assert.match(promptStack.tools, /Team Orchestration/);
});
