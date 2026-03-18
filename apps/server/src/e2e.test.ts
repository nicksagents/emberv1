import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { executeProviderChat } from "@ember/connectors";
import {
  createMemoryRepository,
  defaultRoleAssignments,
  normalizeProvider,
  normalizeSettings,
  recordTaskOutcomeMemory,
  type ChatMessage,
  type Provider,
  type Settings,
  type ToolCall,
} from "@ember/core";

import { writeAuditEvent } from "./audit-log.js";
import { clearFailoverMetrics, classifyFailoverCause, getFailoverMetricsSnapshot, recordFailoverEvent, recordProviderFailure, recordProviderSuccess } from "./failover.js";
import { assessTask, buildStrategyInjection, createExecutionMonitor, suggestStrategyAdjustment, updateExecutionMonitor } from "./metacognition.js";
import { resolveModelRoutePolicy } from "./model-routing.js";
import { buildRolePromptStack } from "./orchestration-prompt.js";
import { resolveProviderRoutePolicy } from "./provider-routing.js";
import { routeAutoRequestPolicy } from "./routing.js";
import { createToolHandler, getExecutionToolSnapshotForRole, getExecutionToolsForRole } from "./tools/index.js";

function makeProvider(options: {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
}): Provider {
  return normalizeProvider({
    id: options.id,
    name: options.name,
    typeId: "openai-compatible",
    status: "connected",
    config: {
      baseUrl: options.baseUrl,
      defaultModelId: options.models[0] ?? "",
    },
    availableModels: options.models,
    capabilities: {
      canChat: true,
      canListModels: true,
      canUseImages: true,
      canUseTools: true,
      requiresBrowserAuth: false,
    },
    lastError: null,
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
  });
}

function makeSettings(workspaceRoot: string): Settings {
  const settings = normalizeSettings({}, workspaceRoot);
  settings.memory.backend = "file";
  return settings;
}

function createToolCallFromObservation(name: string, args: Record<string, unknown>, result: string): ToolCall {
  return {
    id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args,
    result,
    status: /^error\b/i.test(result.trim()) ? "error" : "complete",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
}

function chatCompletionResponse(message: {
  content?: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message }],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

async function withTempRoot(fn: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-e2e-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    await fn(tempRoot);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("full chat flow: request -> dispatch -> provider/model routing -> tool execution -> memory update", async () => {
  await withTempRoot(async (tempRoot) => {
    clearFailoverMetrics();
    const originalFetch = globalThis.fetch;
    const settings = makeSettings(tempRoot);
    const provider = makeProvider({
      id: "provider_primary",
      name: "Primary",
      baseUrl: "http://provider-primary.local/v1",
      models: ["gpt-5.3-codex"],
    });
    const fixturePath = path.join(tempRoot, "auth-context.txt");
    await writeFile(fixturePath, "AUTH_CONTEXT=phase4-e2e", "utf8");
    const conversation: ChatMessage[] = [];
    const content = `Implement and debug auth flow; read this file first: ${fixturePath}`;

    const fetchBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      fetchBodies.push(body);
      if (fetchBodies.length === 1) {
        return chatCompletionResponse({
          content: "I'll inspect the file first.",
          tool_calls: [
            {
              id: "call_read_file",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: fixturePath }),
              },
            },
          ],
        });
      }
      return chatCompletionResponse({
        content: "Final answer: AUTH_CONTEXT=phase4-e2e",
      });
    }) as typeof fetch;

    const memory = createMemoryRepository(settings.memory);

    try {
      const route = routeAutoRequestPolicy({
        mode: "auto",
        content,
        conversation,
      });
      assert.equal(route.decision.role, "director");

      const assessment = assessTask(content, conversation, route.decision.role);
      assert.ok(assessment.complexity > 0);

      const providerDecision = resolveProviderRoutePolicy({
        role: route.decision.role,
        providers: [provider],
        preferredProviderId: provider.id,
        request: { content, conversation },
        settings,
      });
      assert.equal(providerDecision.decision.providerId, provider.id);

      const modelDecision = resolveModelRoutePolicy({
        role: route.decision.role,
        provider,
        assignedModelId: provider.config.defaultModelId,
        request: { content, conversation },
      });
      assert.equal(modelDecision.decision.modelId, "gpt-5.3-codex");

      const assignments = defaultRoleAssignments().map((assignment) =>
        assignment.role === route.decision.role
          ? {
              ...assignment,
              providerId: provider.id,
              modelId: modelDecision.decision.modelId,
            }
          : assignment,
      );
      const assignmentMap = new Map(assignments.map((assignment) => [assignment.role, assignment]));
      const tools = getExecutionToolsForRole(route.decision.role, { content, conversation });
      const toolSnapshot = getExecutionToolSnapshotForRole(route.decision.role, { content, conversation });
      const promptStack = buildRolePromptStack({
        settings,
        role: route.decision.role,
        tools,
        providers: [provider],
        assignmentMap,
      });

      const observedToolCalls: ToolCall[] = [];
      const handler = createToolHandler({
        activeRole: route.decision.role,
        toolSnapshot,
        onToolResult(observation) {
          observedToolCalls.push(
            createToolCallFromObservation(
              observation.toolName,
              observation.input,
              observation.resultText,
            ),
          );
        },
      });

      await writeAuditEvent({
        action: "chat.request.received",
        method: "POST",
        path: "/api/chat",
        ip: "127.0.0.1",
        status: "ok",
        details: {
          role: route.decision.role,
          providerId: provider.id,
        },
      });

      const result = await executeProviderChat(provider, {}, {
        modelId: modelDecision.decision.modelId,
        promptStack,
        conversation,
        content,
        role: route.decision.role,
        tools,
        onToolCall: handler.onToolCall,
      });
      recordProviderSuccess(provider.id);

      await writeAuditEvent({
        action: "chat.request.completed",
        method: "POST",
        path: "/api/chat",
        ip: "127.0.0.1",
        status: "ok",
        details: {
          providerId: provider.id,
          toolCalls: observedToolCalls.length,
        },
      });

      await recordTaskOutcomeMemory(memory, {
        taskDescription: content,
        approach: `role=${route.decision.role};provider=${provider.id};tools=${observedToolCalls.map((call) => call.name).join(",") || "none"}`,
        result: "success",
        toolsUsed: observedToolCalls.map((call) => call.name),
        providerUsed: provider.name,
        modelUsed: result.modelId ?? "unknown",
        duration: 250,
        timestamp: new Date().toISOString(),
      });

      const outcomeMatches = await memory.search({
        text: "phase4-e2e",
        memoryTypes: ["task_outcome"],
        tags: ["__task_outcome"],
        maxResults: 5,
      });
      const dateTag = new Date().toISOString().slice(0, 10);
      const auditLog = await readFile(path.join(tempRoot, "data", "audit-logs", `audit-${dateTag}.jsonl`), "utf8");

      assert.match(result.content, /AUTH_CONTEXT=phase4-e2e/);
      assert.equal(observedToolCalls.length, 1);
      assert.equal(observedToolCalls[0]?.name, "read_file");
      assert.match(observedToolCalls[0]?.result ?? "", /phase4-e2e/);
      assert.ok(outcomeMatches.length >= 1);
      assert.match(auditLog, /chat\.request\.received/);
      assert.match(auditLog, /chat\.request\.completed/);
      assert.equal(getFailoverMetricsSnapshot().totalEvents, 0);
    } finally {
      await memory.close?.();
      globalThis.fetch = originalFetch;
      clearFailoverMetrics();
    }
  });
});

test("failover chain: primary provider fails and fallback provider succeeds", async () => {
  await withTempRoot(async (tempRoot) => {
    clearFailoverMetrics();
    const originalFetch = globalThis.fetch;
    const settings = makeSettings(tempRoot);
    const primary = makeProvider({
      id: "provider_primary",
      name: "Primary",
      baseUrl: "http://provider-primary.local/v1",
      models: ["gpt-primary"],
    });
    const fallback = makeProvider({
      id: "provider_fallback",
      name: "Fallback",
      baseUrl: "http://provider-fallback.local/v1",
      models: ["gpt-fallback"],
    });
    const providers = [primary, fallback];

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("provider-primary")) {
        throw new Error("ECONNREFUSED: primary unavailable");
      }
      return chatCompletionResponse({
        content: "Fallback provider response.",
      });
    }) as typeof fetch;

    try {
      const content = "Implement auth middleware and fix failing tests.";
      const conversation: ChatMessage[] = [];
      const route = routeAutoRequestPolicy({
        mode: "auto",
        content,
        conversation,
      });

      const providerDecision = resolveProviderRoutePolicy({
        role: route.decision.role,
        providers,
        preferredProviderId: primary.id,
        request: { content, conversation },
        settings,
      });
      assert.equal(providerDecision.decision.providerId, primary.id);

      const tools = getExecutionToolsForRole(route.decision.role, { content, conversation });
      let lastError: Error | null = null;
      let selectedProvider: Provider | null = null;
      let finalContent = "";
      for (const provider of [primary, fallback]) {
        try {
          selectedProvider = provider;
          const modelDecision = resolveModelRoutePolicy({
            role: route.decision.role,
            provider,
            assignedModelId: provider.config.defaultModelId,
            request: { content, conversation },
          });
          const assignments = defaultRoleAssignments().map((assignment) =>
            assignment.role === route.decision.role
              ? {
                  ...assignment,
                  providerId: provider.id,
                  modelId: modelDecision.decision.modelId,
                }
              : assignment,
          );
          const promptStack = buildRolePromptStack({
            settings,
            role: route.decision.role,
            tools,
            providers,
            assignmentMap: new Map(assignments.map((assignment) => [assignment.role, assignment])),
          });
          const result = await executeProviderChat(provider, {}, {
            modelId: modelDecision.decision.modelId,
            promptStack,
            conversation,
            content,
            role: route.decision.role,
            tools,
            onToolCall: async () => "unused",
          });
          recordProviderSuccess(provider.id);
          finalContent = result.content;
          lastError = null;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordProviderFailure(provider.id);
          lastError = error instanceof Error ? error : new Error(message);
          const nextProvider = provider.id === primary.id ? fallback : null;
          if (nextProvider) {
            recordFailoverEvent({
              role: route.decision.role,
              fromProviderId: provider.id,
              fromModelId: provider.config.defaultModelId ?? null,
              toProviderId: nextProvider.id,
              toModelId: nextProvider.config.defaultModelId ?? null,
              cause: classifyFailoverCause(message),
              reason: message,
            });
          }
        }
      }

      if (lastError) {
        throw lastError;
      }

      const metrics = getFailoverMetricsSnapshot();
      assert.equal(selectedProvider?.id, fallback.id);
      assert.match(finalContent, /Fallback provider response/);
      assert.equal(metrics.totalEvents, 1);
      assert.equal(metrics.recentEvents[0]?.fromProviderId, primary.id);
      assert.equal(metrics.recentEvents[0]?.toProviderId, fallback.id);
      assert.equal(metrics.byCause.network, 1);
    } finally {
      globalThis.fetch = originalFetch;
      clearFailoverMetrics();
    }
  });
});

test("stuck detection triggers strategy adjustment and model escalation signal", () => {
  const assessment = assessTask("Fix typo in one file.", [], "director");
  let monitor = createExecutionMonitor(assessment);
  const repeatedFailure = {
    name: "search_files",
    arguments: { query: "missing_symbol" },
    result: "Error: no matches",
  };

  for (let index = 0; index < 3; index += 1) {
    monitor = updateExecutionMonitor(monitor, {
      id: `tool_${index + 1}`,
      name: repeatedFailure.name,
      arguments: repeatedFailure.arguments,
      status: "error",
      result: repeatedFailure.result,
      startedAt: `2026-03-17T10:00:0${index}.000Z`,
      endedAt: `2026-03-17T10:00:0${index}.500Z`,
    });
  }

  const adjustment = suggestStrategyAdjustment(monitor, assessment);
  assert.ok(adjustment);
  assert.equal(adjustment?.action, "escalate-model");
  assert.match(buildStrategyInjection(adjustment!), /COGNITIVE ESCALATION/i);
});
