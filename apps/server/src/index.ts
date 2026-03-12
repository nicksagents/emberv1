// @ember/connectors rebuilt — edit this file to force tsx watch to reload packaged dependencies.
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  executeProviderChat,
  getConnectorModelCatalog,
  launchProviderConnect,
  providerCanChat,
  recheckProvider,
  streamProviderChat,
} from "@ember/connectors";
import {
  approveMemoryItem,
  buildProcedurePromptContext,
  compactConversationHistory,
  consolidateConversationMemory,
  createMemoryRepository,
  revalidateMemoryItem,
  retireProcedureMemory,
  suppressMemoryItem,
  type ConnectorTypeId,
  ensureDataFiles,
  initializeMemoryInfrastructure,
  getProviderCapabilities,
  sanitizeProviderConfig,
  readConnectorTypes,
  readConversations,
  readProviderSecrets,
  readProviders,
  readRoleAssignments,
  readRuntime,
  readSettings,
  writeConversations,
  writeProviderSecrets,
  writeProviders,
  writeRoleAssignments,
  writeSettings,
} from "@ember/core";
import type {
  ChatAttachmentUpload,
  ChatExecutionResult,
  ChatMessage,
  ChatMode,
  ChatRequest,
  ChatStreamEvent,
  Conversation,
  ConversationSummary,
  MemoryPromptContext,
  MemoryRepository,
  MemoryToolObservation,
  Provider,
  Role,
  RoleAssignment,
} from "@ember/core";
import type { UiBlock } from "@ember/ui-schema";
import { getPromptStack } from "@ember/prompts";
import {
  buildDispatchInput,
  formatRouteSource,
  resolveDispatchDecision,
  routeAutoRequestPolicy,
  type AutoRouteDecision,
} from "./routing.js";
import {
  createToolHandler,
  getExecutionToolsForRole,
  getToolSystemPrompt,
  registerMcpTools,
  setToolConfig,
} from "./tools/index.js";
import { skillManager } from "@ember/core/skills";
import { McpClientManager } from "./mcp/mcp-client-manager.js";
import type { McpConfig } from "@ember/core/mcp";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { prepareAttachmentUploads } from "./chat-attachments.js";
import { listMemoryRetrievalTraces, recordMemoryRetrievalTrace } from "./memory-traces.js";
import {
  getMemoryReplayState,
  maybeRunMemoryReplayWithRepository,
  runScheduledMemoryReplay,
  startMemoryReplayScheduler,
} from "./memory-maintenance.js";
import { buildMemoryGraph, buildMemoryOverview } from "./memory-visualization.js";
import {
  resolveExecutionModelProfile,
  resolveExecutionPromptBudget,
  toMemorySearchBudgetOverrides,
} from "./prompt-budget.js";
import {
  buildProcedureMemorySearchQuery,
  buildStructuredMemorySearchQuery,
  hasProcedureMemorySearchCues,
  hasStructuredMemorySearchCues,
} from "./memory-query.js";
const host = process.env.EMBER_RUNTIME_HOST ?? "0.0.0.0";
const port = Number(process.env.EMBER_RUNTIME_PORT ?? "3005");

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function requestHasImageAttachments(request: ChatRequest): boolean {
  return request.conversation.some((message) =>
    (message.attachments ?? []).some((attachment) => attachment.kind === "image"),
  );
}

function summarizeText(content: string, limit = 84): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Untitled chat";
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function sanitizeRecord(value: Record<string, string> | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, item.trim()] as const)
      .filter(([, item]) => item.length > 0),
  );
}

function toConversationSummary(conversation: Conversation): ConversationSummary {
  const { messages: _messages, ...summary } = conversation;
  return summary;
}

function normalizeChatMode(mode: ChatMode): ChatMode {
  return mode === "dispatch" ? "auto" : mode;
}

function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function createConversationRecord(
  existing: Conversation | null,
  request: ChatRequest,
  newMessages: ChatMessage[],
): Conversation {
  const normalizedMode = normalizeChatMode(request.mode);
  const finalMessages = [...request.conversation, ...newMessages];
  const firstUserMessage = finalMessages.find((message) => message.role === "user");
  const lastMessage = finalMessages.at(-1) ?? null;
  const createdAt = existing?.createdAt ?? firstUserMessage?.createdAt ?? new Date().toISOString();

  return {
    id: existing?.id ?? request.conversationId ?? createId("conv"),
    title: summarizeText(firstUserMessage?.content ?? "New chat", 48),
    mode: normalizedMode,
    createdAt,
    updatedAt: new Date().toISOString(),
    archivedAt: newMessages.length > 0 ? null : (existing?.archivedAt ?? null),
    lastMessageAt: lastMessage?.createdAt ?? null,
    preview: summarizeText(lastMessage?.content ?? firstUserMessage?.content ?? ""),
    messageCount: finalMessages.length,
    messages: finalMessages,
  };
}

type ExecutionRole = Exclude<Role, "dispatch">;

function resolveSpeakingRole(role: Role | null): Role {
  return role === "dispatch" || role === null ? "coordinator" : role;
}

function roleLead(role: Role): string {
  switch (role) {
    case "dispatch":
      return "Routing analysis";
    case "coordinator":
      return "Operator-facing response";
    case "advisor":
      return "Execution plan";
    case "director":
      return "Implementation direction";
    case "inspector":
      return "Audit pass";
    case "ops":
      return "Polish pass";
  }
}

function createBlocks(
  role: Role,
  mode: ChatMode,
  content: string,
  providerName: string | null,
  modelId: string | null,
  executionSource: "live" | "fallback",
  note: string,
): UiBlock[] {
  const trimmed = content.trim();
  return [
    {
      type: "summary",
      title: roleLead(role),
      body:
        executionSource === "live"
          ? `This ${role} response was generated by a connected provider in ${mode === "auto" ? "Auto" : "direct"} mode.`
          : `This ${role} response is using EMBER's local fallback path because no live provider execution was available.`,
    },
    {
      type: "checklist",
      title: "Next actions",
      items: [
        {
          label: trimmed
            ? `Handle request: ${trimmed.slice(0, 72)}${trimmed.length > 72 ? "..." : ""}`
            : "Handle the incoming request",
          state: "active",
        },
        {
          label: providerName
            ? `Use assigned provider ${providerName}`
            : "No provider assigned yet for this role",
          state: providerName ? "complete" : "pending",
        },
        {
          label: modelId ? `Use model ${modelId}` : "Model selection still unassigned",
          state: modelId ? "complete" : "pending",
        },
        {
          label:
            executionSource === "live"
              ? "Provider execution is active"
              : "Execution fell back to the local scaffold",
          state: executionSource === "live" ? "complete" : "active",
        },
      ],
    },
    {
      type: "stat-grid",
      title: "Execution metadata",
      stats: [
        { label: "Role", value: role },
        { label: "Mode", value: mode === "auto" ? "Auto" : "Direct" },
        { label: "Provider", value: providerName ?? "Unassigned" },
        { label: "Model", value: modelId ?? "Unassigned" },
        { label: "Source", value: executionSource === "live" ? "Live provider" : "Fallback" },
      ],
    },
    {
      type: "note",
      tone: executionSource === "live" ? "success" : "warning",
      body: note,
    },
  ];
}

function createStatusError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function resolveBrowserSessionKey(request: ChatRequest): string {
  return (
    request.conversation.find((message) => message.role === "user")?.id ??
    request.conversationId ??
    createId("browser")
  );
}

function compactChatRequest(
  request: ChatRequest,
  settings: Awaited<ReturnType<typeof readSettings>>,
  promptStack: ReturnType<typeof getPromptStack>,
  provider: Provider | null,
): ChatRequest {
  const result = compactConversationForContext(
    request.conversation,
    request.content,
    settings,
    promptStack,
    provider,
  );
  if (!result.didCompact) {
    return request;
  }

  return {
    ...request,
    conversation: result.messages,
  };
}

function compactConversationForContext(
  conversation: ChatMessage[],
  content: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  promptStack: ReturnType<typeof getPromptStack>,
  provider: Provider | null,
) {
  const promptBudget = resolveExecutionPromptBudget(settings, provider);

  return compactConversationHistory(conversation, {
    enabled: settings.compression.enabled,
    maxPromptTokens: promptBudget.maxPromptTokens,
    targetPromptTokens: promptBudget.targetPromptTokens,
    preserveRecentMessages: settings.compression.preserveRecentMessages,
    minimumRecentMessages: settings.compression.minimumRecentMessages,
    promptStack,
    currentUserContent: content,
  });
}

interface ExecutionContext {
  compactedRequest: ChatRequest;
  mode: ChatMode;
  settings: Awaited<ReturnType<typeof readSettings>>;
  memoryRepository: MemoryRepository | null;
  providers: Provider[];
  secrets: Awaited<ReturnType<typeof readProviderSecrets>>;
  assignmentMap: Map<Role, RoleAssignment>;
  routeDecision: AutoRouteDecision | null;
  routedTo: Role | null;
  activeRole: Role;
  promptStack: ReturnType<typeof getPromptStack>;
  tools: ReturnType<typeof getExecutionToolsForRole>;
  assignment: RoleAssignment | undefined;
  provider: Provider | null;
  responseModelId: string | null;
  routeNote: string | null;
  handoffSourceRole: Role | null;
  browserSessionKey: string;
}

interface BuiltExecution {
  context: ExecutionContext;
  result: ChatExecutionResult;
  toolObservations: MemoryToolObservation[];
}

function sendStreamEvent(
  emit: ((event: ChatStreamEvent) => void) | undefined,
  event: ChatStreamEvent,
) {
  emit?.(event);
}

function buildReplyMessage(
  context: ExecutionContext,
  request: ChatRequest,
  responseContent: string,
  responseThinking: string | null,
  responseModelId: string | null,
  executionNote: string,
): ChatMessage {
  return {
    id: createId("msg"),
    role: "assistant",
    authorRole: context.activeRole,
    mode: context.mode,
    content: responseContent,
    thinking: responseThinking,
    createdAt: new Date().toISOString(),
    providerId: context.provider?.id ?? null,
    providerName: context.provider?.name ?? null,
    modelId: responseModelId,
    routedTo: context.routedTo,
    blocks: createBlocks(
      context.activeRole,
      context.mode,
      request.content,
      context.provider?.name ?? null,
      responseModelId,
      "live",
      executionNote,
    ),
  };
}

const MAX_AGENT_LOOP = 16;
const MAX_ROLE_VISITS = 5;
const DISPATCH_TIMEOUT_MS = 10_000;

function buildHandoffContext(source: ExecutionContext, targetRole: ExecutionRole): ExecutionContext {
  const assignment = source.assignmentMap.get(targetRole);
  const provider = source.providers.find((p) => p.id === assignment?.providerId) ?? null;
  const responseModelId =
    assignment?.modelId ?? provider?.config.defaultModelId ?? provider?.availableModels[0] ?? null;
  const executionProfile = resolveExecutionModelProfile(source.settings, provider, targetRole);
  const tools = provider && !provider.capabilities.canUseTools
    ? []
    : getExecutionToolsForRole(targetRole, {
        compact: executionProfile.compactToolset,
        content: source.compactedRequest.content,
        conversation: source.compactedRequest.conversation,
      });
  const promptStack = getPromptStack(source.settings, targetRole);
  promptStack.tools = getToolSystemPrompt(tools, targetRole, {
    compact: executionProfile.compactToolPrompt,
  });
  return {
    ...source,
    activeRole: targetRole,
    promptStack,
    tools,
    assignment,
    provider,
    responseModelId,
    routedTo: targetRole,
    routeNote: `${source.activeRole} chained to ${targetRole}.`,
    handoffSourceRole: source.activeRole,
  };
}

async function buildPersistentMemoryContext(
  context: ExecutionContext,
  conversation: ChatMessage[],
  content: string,
  activeSessionId: string | null,
): Promise<MemoryPromptContext | null> {
  if (!context.settings.memory.enabled || !context.memoryRepository) {
    return null;
  }

  const promptBudget = resolveExecutionPromptBudget(context.settings, context.provider);
  const query = {
    ...buildStructuredMemorySearchQuery({
      content,
      conversation,
      activeRole: context.activeRole,
      activeSessionId,
      handoffSourceRole: context.handoffSourceRole,
    }),
    ...toMemorySearchBudgetOverrides(promptBudget.memory),
  };
  if (!query.text.trim() && !hasStructuredMemorySearchCues(query)) {
    return null;
  }

  try {
    const memoryContext = await context.memoryRepository.buildPromptContext(query);

    if (memoryContext.text.trim() && context.settings.memory.rollout.traceCaptureEnabled) {
      recordMemoryRetrievalTrace({
        kind: "persistent",
        conversationId: activeSessionId,
        query,
        memoryContext,
      });
    }

    return memoryContext.text.trim() ? memoryContext : null;
  } catch (error) {
    console.warn(
      `[memory] retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function buildProcedureMemoryContext(
  context: ExecutionContext,
  conversation: ChatMessage[],
  content: string,
  activeSessionId: string | null,
): Promise<MemoryPromptContext | null> {
  if (!context.settings.memory.enabled || !context.memoryRepository) {
    return null;
  }

  const promptBudget = resolveExecutionPromptBudget(context.settings, context.provider);
  const query = {
    ...buildProcedureMemorySearchQuery({
      content,
      conversation,
      activeRole: context.activeRole,
      activeSessionId,
      handoffSourceRole: context.handoffSourceRole,
    }),
    ...toMemorySearchBudgetOverrides(promptBudget.procedures),
  };
  if (!hasProcedureMemorySearchCues(query)) {
    return null;
  }

  try {
    const results = await context.memoryRepository.search(query);
    const procedureContext = buildProcedurePromptContext(results, {
      maxInjectedItems: query.maxInjectedItems,
      maxInjectedChars: query.maxInjectedChars,
    });

    if (procedureContext.text.trim() && context.settings.memory.rollout.traceCaptureEnabled) {
      recordMemoryRetrievalTrace({
        kind: "procedure",
        conversationId: activeSessionId,
        query,
        memoryContext: procedureContext,
      });
    }

    return procedureContext.text.trim() ? procedureContext : null;
  } catch (error) {
    console.warn(
      `[memory] procedure retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function recordMemoryRetrievalSuccesses(
  repository: MemoryRepository | null,
  memoryContext: MemoryPromptContext | null,
  now = new Date().toISOString(),
): Promise<void> {
  if (!repository || !memoryContext || memoryContext.results.length === 0) {
    return;
  }

  const memoryIds = [...new Set(memoryContext.results.map((result) => result.item.id))];
  for (const memoryId of memoryIds) {
    await repository.reinforceItem(memoryId, {
      now,
      salienceDelta: 0.01,
      confidenceDelta: 0,
      reinforcementDelta: 0,
      retrievalSuccessDelta: 1,
      lastRetrievedAt: now,
    });
  }
}

async function withMemoryRepository<T>(
  handler: (
    repository: MemoryRepository,
    settings: Awaited<ReturnType<typeof readSettings>>,
  ) => Promise<T>,
): Promise<T> {
  const settings = await readSettings();
  if (!settings.memory.enabled) {
    throw createStatusError(503, "Long-term memory is disabled in settings.");
  }
  if (!settings.memory.rollout.inspectionApiEnabled) {
    throw createStatusError(404, "Memory inspection APIs are disabled by rollout settings.");
  }

  const repository = createMemoryRepository(settings.memory);
  try {
    return await handler(repository, settings);
  } finally {
    await repository.close?.();
  }
}

function parsePositiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(maximum, parsed);
}

async function consolidatePersistedConversation(
  context: ExecutionContext,
  conversation: Conversation,
  toolObservations: MemoryToolObservation[],
): Promise<void> {
  if (!context.settings.memory.enabled || !context.memoryRepository) {
    return;
  }

  try {
    await consolidateConversationMemory(context.memoryRepository, {
      conversation,
      toolObservations,
      config: context.settings.memory,
    });
  } catch (error) {
    console.warn(
      `[memory] consolidation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function finalizeConversationLifecycle(
  conversation: Conversation,
  reason: "archived" | "deleted" | "reset" | "completed",
  endedAt = new Date().toISOString(),
): Promise<void> {
  const settings = await readSettings();
  if (!settings.memory.enabled) {
    return;
  }

  const repository = createMemoryRepository(settings.memory);
  try {
    await consolidateConversationMemory(repository, {
      conversation,
      config: settings.memory,
      lifecycle: "archived",
      endReason: reason,
      now: endedAt,
    });
    await maybeRunMemoryReplayWithRepository(repository, {
      reason: "archive-finalization",
      force: true,
      now: endedAt,
    });
  } catch (error) {
    console.warn(
      `[memory] lifecycle finalization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await repository.close?.();
  }
}

async function resolveAutoRouteDecision(
  request: ChatRequest,
  settings: ExecutionContext["settings"],
  providers: Provider[],
  assignmentMap: Map<Role, RoleAssignment>,
  secrets: ExecutionContext["secrets"],
): Promise<AutoRouteDecision> {
  const policy = routeAutoRequestPolicy(request);
  if (!policy.shouldQueryDispatch) {
    return policy.decision;
  }

  const routerAssignment = assignmentMap.get("dispatch");
  const routerProvider =
    providers.find((candidate) => candidate.id === routerAssignment?.providerId) ?? null;

  if (!routerProvider || routerProvider.status !== "connected" || !providerCanChat(routerProvider)) {
    const reason = !routerProvider
      ? "Dispatch provider is not assigned."
      : routerProvider.status !== "connected"
        ? `Dispatch provider ${routerProvider.name} is ${routerProvider.status}.`
        : `Dispatch provider ${routerProvider.name} cannot execute chat requests.`;
    return {
      ...policy.decision,
      source: "policy-fallback",
      reason: `${reason} Using the policy fallback.`,
    };
  }

  try {
    console.log(`[dispatch] calling ${routerProvider.name} (${routerAssignment?.modelId ?? "default model"})`);
    const routerExecution = await Promise.race([
      executeProviderChat(routerProvider, secrets, {
        modelId: routerAssignment?.modelId ?? null,
        promptStack: getPromptStack(settings, "dispatch"),
        role: "dispatch",
        conversation: [],
        content: buildDispatchInput(request),
        purpose: "route",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms.`));
        }, DISPATCH_TIMEOUT_MS).unref();
      }),
    ]);
    console.log(`[dispatch] raw response: "${routerExecution.content}"`);
    const decision = resolveDispatchDecision(routerExecution.content, policy.decision);
    console.log(
      `[dispatch] parsed role: ${decision.role} (source: ${decision.source}, confidence: ${decision.confidence.toFixed(2)})`,
    );
    return decision;
  } catch (error) {
    console.warn(
      `[dispatch] failed, using policy fallback. reason: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      ...policy.decision,
      source: "policy-fallback",
      reason: `Dispatch failed, so the policy fallback kept ${policy.decision.role}.`,
    };
  }
}

async function prepareExecution(request: ChatRequest): Promise<ExecutionContext> {
  const mode = normalizeChatMode(request.mode);
  const [settings, providers, assignments, secrets] = await Promise.all([
    readSettings(),
    readProviders(),
    readRoleAssignments(),
    readProviderSecrets(),
  ]);

  const assignmentMap = new Map<Role, RoleAssignment>(
    assignments.map((assignment) => [assignment.role, assignment]),
  );
  const routerAssignment = assignmentMap.get("dispatch");
  const routerProvider =
    providers.find((candidate) => candidate.id === routerAssignment?.providerId) ?? null;

  setToolConfig({ sudoPassword: settings.sudoPassword ?? "" });

  const dispatchPromptStack = getPromptStack(settings, "dispatch");
  const routingRequest =
    mode === "auto" ? compactChatRequest(request, settings, dispatchPromptStack, routerProvider) : request;
  const routeDecision =
    mode === "auto"
      ? await resolveAutoRouteDecision(routingRequest, settings, providers, assignmentMap, secrets)
      : null;
  const routedTo = mode === "auto" ? resolveSpeakingRole(routeDecision?.role ?? null) : null;
  const activeRole = mode === "auto" ? routedTo ?? "coordinator" : resolveSpeakingRole(mode);
  const assignment = assignmentMap.get(activeRole);
  const provider = providers.find((candidate) => candidate.id === assignment?.providerId) ?? null;
  const executionProfile = resolveExecutionModelProfile(settings, provider, activeRole);
  const tools = provider && !provider.capabilities.canUseTools
    ? []
    : getExecutionToolsForRole(activeRole, {
        compact: executionProfile.compactToolset,
        content: request.content,
        conversation: request.conversation,
      });
  const promptStack = getPromptStack(settings, activeRole);
  promptStack.tools = getToolSystemPrompt(tools, activeRole, {
    compact: executionProfile.compactToolPrompt,
  });
  const compactedRequest = compactChatRequest(request, settings, promptStack, provider);
  const responseModelId =
    assignment?.modelId ?? provider?.config.defaultModelId ?? provider?.availableModels[0] ?? null;
  const routeNote = routeDecision
    ? `Auto routed to ${routeDecision.role} via ${formatRouteSource(routeDecision.source)}.`
    : null;
  const memoryRepository = settings.memory.enabled
    ? createMemoryRepository(settings.memory)
    : null;

  return {
    compactedRequest,
    mode,
    settings,
    memoryRepository,
    providers,
    secrets,
    assignmentMap,
    routeDecision,
    routedTo,
    activeRole,
    promptStack,
    tools,
    assignment,
    provider,
    responseModelId,
    routeNote,
    handoffSourceRole: null,
    browserSessionKey: resolveBrowserSessionKey(request),
  };
}

function resolveExecutionGuard(context: ExecutionContext): never {
  const { provider, routeNote } = context;
  let executionNote = provider
    ? `Assigned provider ${provider.name} is not ready for live execution yet.`
    : "No provider is assigned to this role yet.";

  if (provider && !providerCanChat(provider)) {
    executionNote =
      "This provider can be connected and rechecked, but role execution is not wired for this connector type yet.";
  } else if (provider && provider.status !== "connected") {
    executionNote = `Assigned provider ${provider.name} is currently ${provider.status}. Recheck the connection before using live execution.`;
  }

  if (routeNote) {
    executionNote = `${routeNote} ${executionNote}`;
  }

  throw createStatusError(409, executionNote);
}

async function persistConversationFromResult(
  request: ChatRequest,
  result: ChatExecutionResult,
) {
  const conversations = await readConversations();
  const existing = request.conversationId
    ? conversations.find((item) => item.id === request.conversationId) ?? null
    : null;
  const conversation = createConversationRecord(existing, request, result.messages);
  const remaining = conversations.filter((item) => item.id !== conversation.id);
  const nextConversations = sortConversations([conversation, ...remaining]);

  await writeConversations(nextConversations);

  return conversation;
}

async function buildExecution(
  request: ChatRequest,
): Promise<BuiltExecution> {
  const context = await prepareExecution(request);
  try {
    const compactedRequest = context.compactedRequest;
    const provider = context.provider;
    if (!provider || provider.status !== "connected" || !providerCanChat(provider)) {
      resolveExecutionGuard(context);
    }

    if (requestHasImageAttachments(compactedRequest) && !provider.capabilities.canUseImages) {
      throw createStatusError(
        409,
        `${provider.name} does not accept image inputs. Switch to an image-capable provider or remove the image.`,
      );
    }

    const messages: ChatMessage[] = [];
    const toolObservations: MemoryToolObservation[] = [];
    const visitCounts = new Map<string, number>();
    let currentCtx = context;
    let currentConversation = compactedRequest.conversation;
    let currentContent = compactedRequest.content;

    for (let iteration = 0; iteration < MAX_AGENT_LOOP; iteration++) {
      const iterProvider = currentCtx.provider;
      if (!iterProvider || iterProvider.status !== "connected" || !providerCanChat(iterProvider)) {
        if (iteration === 0) resolveExecutionGuard(currentCtx);
        console.warn(`[loop] no usable provider for ${currentCtx.activeRole}, stopping`);
        break;
      }

      const memoryContext = await buildPersistentMemoryContext(
        currentCtx,
        currentConversation,
        currentContent,
        request.conversationId ?? null,
      );
      const procedureContext = await buildProcedureMemoryContext(
        currentCtx,
        currentConversation,
        currentContent,
        request.conversationId ?? null,
      );
      const handler = createToolHandler({
        browserSessionKey: currentCtx.browserSessionKey,
        onToolResult(observation) {
          toolObservations.push(observation);
        },
      });
      const compactedConversation = compactConversationForContext(
        currentConversation,
        currentContent,
        currentCtx.settings,
        currentCtx.promptStack,
        iterProvider,
      ).messages;
      let iterContent: string;
      let iterThinking: string | null;
      let iterModelId: string | null;

      try {
        const iterExecution = await executeProviderChat(iterProvider, currentCtx.secrets, {
          modelId: currentCtx.assignment?.modelId ?? null,
          promptStack: currentCtx.promptStack,
          memoryContext,
          procedureContext,
          role: currentCtx.activeRole,
          conversation: compactedConversation,
          content: currentContent,
          tools: currentCtx.tools,
          onToolCall: handler.onToolCall,
        });
        iterContent = iterExecution.content;
        iterThinking = iterExecution.thinking ?? null;
        iterModelId = iterExecution.modelId;
        await recordMemoryRetrievalSuccesses(
          currentCtx.memoryRepository,
          memoryContext,
          new Date().toISOString(),
        );
        await recordMemoryRetrievalSuccesses(
          currentCtx.memoryRepository,
          procedureContext,
          new Date().toISOString(),
        );
      } catch (error) {
        const note = `${currentCtx.routeNote ? `${currentCtx.routeNote} ` : ""}Live provider execution failed: ${
          error instanceof Error ? error.message : "Unknown error."
        }`;
        if (iteration === 0) throw createStatusError(502, note);
        console.warn(`[loop] ${currentCtx.activeRole} failed: ${note}`);
        break;
      }

      const iterNote = `${currentCtx.routeNote ?? ""} Live response via ${iterProvider.name}.`.trim();
      const iterMsg = buildReplyMessage(currentCtx, request, iterContent, iterThinking, iterModelId, iterNote);
      messages.push(iterMsg);

      const handoff = handler.getPendingHandoff();
      if (!handoff) break;

      const visits = (visitCounts.get(handoff.role) ?? 0) + 1;
      if (visits > MAX_ROLE_VISITS) {
        console.warn(`[loop] ${handoff.role} hit visit limit (${MAX_ROLE_VISITS}), stopping`);
        break;
      }
      visitCounts.set(handoff.role, visits);
      console.log(`[loop] ${currentCtx.activeRole} → handoff: ${handoff.role} (visit ${visits})`);

      currentConversation = [...compactedConversation, iterMsg];
      currentContent = handoff.message;
      currentCtx = buildHandoffContext(currentCtx, handoff.role as ExecutionRole);
    }

    const lastMessage = messages.at(-1)!;
    return {
      context,
      result: {
        messages,
        activeRole: (lastMessage.authorRole as Role) ?? context.activeRole,
        providerId: lastMessage.providerId ?? provider.id,
        providerName: lastMessage.providerName ?? provider.name,
        modelId: lastMessage.modelId ?? context.responseModelId,
        promptStack: context.promptStack,
        routedTo: context.routedTo,
        conversationId: request.conversationId ?? null,
      },
      toolObservations,
    };
  } catch (error) {
    await context.memoryRepository?.close?.();
    throw error;
  }
}

const app = Fastify({
  bodyLimit: 24 * 1024 * 1024,
  logger: false,
});

await ensureDataFiles();
const bootSettings = await readSettings();
await initializeMemoryInfrastructure(bootSettings.memory);
if (bootSettings.memory.enabled && bootSettings.memory.rollout.replaySchedulerEnabled) {
  startMemoryReplayScheduler();
}

// ── Startup: skills + MCP ─────────────────────────────────────────────────
const __serverDir = dirname(fileURLToPath(import.meta.url));

// Initialize the SkillManager so skill bodies are available for all roles.
// Bundled skills live in skills/ at the repo root; user + project overrides
// are discovered automatically from ~/.ember/skills/ and .ember/skills/.
skillManager.initialize({
  bundledDir: join(__serverDir, "..", "..", "..", "skills"),
});

// Load the built-in default MCP config shipped with the server.
// Resolves any `npx -y <pkg>` commands to the locally-installed CLI path so
// MCP servers start correctly regardless of the working directory (pnpm
// workspaces installs @playwright/mcp under apps/server/node_modules, not
// the monorepo root, so plain `npx` from the root won't find it).
function loadDefaultMcpConfig(): McpConfig | null {
  const path = join(__serverDir, "..", "mcp.default.json");
  if (!existsSync(path)) return null;
  let cfg: McpConfig;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as McpConfig;
  } catch {
    console.warn("[mcp] Could not parse mcp.default.json — skipping default config.");
    return null;
  }

  // For each server configured with `npx -y <pkg>`, check whether the package
  // is installed locally under apps/server/node_modules and rewrite the command
  // to `node <cli-path>` so it bypasses npx resolution entirely.
  const serverNodeModules = join(__serverDir, "..", "node_modules");
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    if (server.command !== "npx") continue;
    // Find the package name: first arg that looks like a package (skip flags like -y)
    const pkgArg = server.args.find((a) => !a.startsWith("-"));
    if (!pkgArg) continue;

    // Convert @scope/pkg → scope/pkg for filesystem path lookup
    const pkgPath = pkgArg.startsWith("@")
      ? pkgArg.slice(1).replace("/", "/")
      : pkgArg;
    const pkgDir = join(serverNodeModules, ...pkgArg.split("/"));

    let cliPath: string | null = null;
    let sourcePath: string | null = null;
    try {
      const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
      const bin = pkgJson.bin;
      if (typeof bin === "string") {
        cliPath = join(pkgDir, bin);
      } else if (bin && typeof bin === "object") {
        const firstBin = Object.values(bin as Record<string, string>)[0];
        if (firstBin) cliPath = join(pkgDir, firstBin);
      }
      const candidateSourcePath = join(pkgDir, "src", "index.ts");
      if (existsSync(candidateSourcePath)) {
        sourcePath = candidateSourcePath;
      }
    } catch {
      // package.json not found — not installed locally, leave npx command as-is
    }

    if (cliPath && existsSync(cliPath)) {
      // Strip the npx flags and package name, keep the rest as args to the CLI
      const cliArgs = server.args.filter((a) => a !== "-y" && a !== "--yes" && a !== pkgArg);
      cfg.mcpServers[name] = {
        ...server,
        command: process.execPath, // node
        args: [cliPath, ...cliArgs],
      };
      console.log(`[mcp] resolved "${name}" to local CLI: ${cliPath}`);
    } else if (sourcePath) {
      const cliArgs = server.args.filter((a) => a !== "-y" && a !== "--yes" && a !== pkgArg);
      cfg.mcpServers[name] = {
        ...server,
        command: process.execPath,
        args: ["--import", "tsx", sourcePath, ...cliArgs],
      };
      console.log(`[mcp] resolved "${name}" to TypeScript source: ${sourcePath}`);
    }
  }

  return cfg;
}

// Start MCP servers and register their tools into the Ember tool registry.
// Failure of individual servers is isolated — the main process continues.
const mcpManager = new McpClientManager({
  defaultConfig: loadDefaultMcpConfig(),
  workspaceDir: process.cwd(),
});

await mcpManager.start();
registerMcpTools(mcpManager.getTools());

let shuttingDown = false;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: NodeJS.Signals | "exit"): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  await Promise.race([
    Promise.allSettled([
      app.close(),
      mcpManager.stop(),
    ]),
    delay(1_500),
  ]);

  if (signal !== "exit") {
    process.exit(0);
  }
}

// Graceful shutdown: close the Fastify listener and MCP subprocesses so
// tsx watch restarts and Ctrl-C do not leave the old server bound to 3005.
process.once("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
process.once("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
process.once("exit", () => {
  void shutdown("exit");
});

await app.register(cors, {
  origin: true,
});

app.get("/health", async () => {
  const runtime = await readRuntime();
  return {
    status: "ok",
    runtime,
    now: new Date().toISOString(),
  };
});

app.get("/api/runtime", async () => {
  const [runtime, settings] = await Promise.all([readRuntime(), readSettings()]);
  return {
    runtime,
    settings,
  };
});

app.get("/api/memory/overview", async (request, reply) => {
  try {
    const memory = await withMemoryRepository(async (repository) => {
      const [items, sessions, edges] = await Promise.all([
        repository.listItems({ includeSuperseded: true }),
        repository.listSessions(),
        repository.listEdges(),
      ]);
      return buildMemoryOverview({
        items,
        sessions,
        edges,
        traces: listMemoryRetrievalTraces(
          parsePositiveInteger((request.query as { trace_limit?: string }).trace_limit, 12, 48),
        ),
        maintenance: {
          replay: getMemoryReplayState(),
        },
      });
    });

    return memory;
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Failed to load memory overview.",
    };
  }
});

app.get("/api/memory/graph", async (request, reply) => {
  try {
    const query = request.query as {
      limit?: string;
      trace_limit?: string;
    };
    const graph = await withMemoryRepository(async (repository) => {
      const [items, sessions, edges] = await Promise.all([
        repository.listItems({ includeSuperseded: true }),
        repository.listSessions(),
        repository.listEdges(),
      ]);
      return buildMemoryGraph({
        items,
        sessions,
        edges,
        limit: parsePositiveInteger(query.limit, 220, 320),
        traces: listMemoryRetrievalTraces(parsePositiveInteger(query.trace_limit, 18, 72)),
      });
    });

    return graph;
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Failed to load memory graph.",
    };
  }
});

app.get("/api/memory/traces", async (request, reply) => {
  try {
    const settings = await readSettings();
    if (!settings.memory.enabled || !settings.memory.rollout.inspectionApiEnabled) {
      throw createStatusError(404, "Memory inspection APIs are disabled by rollout settings.");
    }
    if (!settings.memory.rollout.traceCaptureEnabled) {
      return {
        items: [],
      };
    }
    const limit = parsePositiveInteger((request.query as { limit?: string }).limit, 16, 72);
    return {
      items: listMemoryRetrievalTraces(limit),
    };
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Failed to load memory traces.",
    };
  }
});

app.post("/api/memory/replay", async (request, reply) => {
  try {
    const settings = await readSettings();
    if (!settings.memory.enabled || !settings.memory.rollout.inspectionApiEnabled) {
      throw createStatusError(404, "Memory inspection APIs are disabled by rollout settings.");
    }
    const body = (request.body as { force?: boolean } | undefined) ?? {};
    const result = await runScheduledMemoryReplay({
      reason: "operator-manual",
      force: body.force !== false,
    });
    return result;
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Failed to run memory replay.",
    };
  }
});

app.post("/api/memory/items/:id/suppress", async (request, reply) => {
  try {
    const id = (request.params as { id: string }).id;
    const body = (request.body as { reason?: string } | undefined) ?? {};
    const item = await withMemoryRepository(async (repository) => {
      const suppressed = await suppressMemoryItem(repository, id, {
        reason: body.reason ?? null,
      });
      if (!suppressed) {
        throw createStatusError(404, "Memory not found.");
      }
      return suppressed;
    });
    return { item };
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Failed to suppress memory.",
    };
  }
});

app.post("/api/memory/items/:id/revalidate", async (request, reply) => {
  try {
    const id = (request.params as { id: string }).id;
    const body = (request.body as { reason?: string } | undefined) ?? {};
    const item = await withMemoryRepository(async (repository) => {
      const revalidated = await revalidateMemoryItem(repository, id, {
        reason: body.reason ?? null,
      });
      if (!revalidated) {
        throw createStatusError(404, "Memory not found or no longer active.");
      }
      return revalidated;
    });
    return { item };
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Failed to revalidate memory.",
    };
  }
});

app.post("/api/memory/items/:id/approve", async (request, reply) => {
  try {
    const id = (request.params as { id: string }).id;
    const body = (request.body as { reason?: string } | undefined) ?? {};
    const item = await withMemoryRepository(async (repository) => {
      const approved = await approveMemoryItem(repository, id, {
        reason: body.reason ?? null,
      });
      if (!approved) {
        throw createStatusError(404, "Memory not found or no longer active.");
      }
      return approved;
    });
    return { item };
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Failed to approve memory.",
    };
  }
});

app.post("/api/memory/items/:id/retire", async (request, reply) => {
  try {
    const id = (request.params as { id: string }).id;
    const body = (request.body as { reason?: string } | undefined) ?? {};
    const item = await withMemoryRepository(async (repository) => {
      const existing = await repository.getItem(id);
      if (!existing) {
        throw createStatusError(404, "Memory not found.");
      }
      if (existing.memoryType !== "procedure") {
        throw createStatusError(400, "Only learned procedures can be retired.");
      }
      const retired = await retireProcedureMemory(repository, id, {
        reason: body.reason ?? null,
      });
      if (!retired) {
        throw createStatusError(409, "Procedure could not be retired.");
      }
      return retired;
    });
    return { item };
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Failed to retire procedure.",
    };
  }
});

app.get("/api/connector-types", async () => {
  return {
    items: await readConnectorTypes(),
  };
});

app.get("/api/connector-models", async () => {
  return {
    items: getConnectorModelCatalog() as Partial<Record<ConnectorTypeId, string[]>>,
  };
});

app.get("/api/conversations", async () => {
  const conversations = await readConversations();
  return {
    items: sortConversations(conversations).map(toConversationSummary),
  };
});

app.get("/api/conversations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const conversations = await readConversations();
  const conversation = conversations.find((item) => item.id === id);

  if (!conversation) {
    reply.code(404);
    return { error: "Conversation not found." };
  }

  return {
    item: conversation,
  };
});

app.patch("/api/conversations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = request.body as { title?: string };
  const conversations = await readConversations();
  const existing = conversations.find((item) => item.id === id);

  if (!existing) {
    reply.code(404);
    return { error: "Conversation not found." };
  }

  const nextTitle = summarizeText(body.title ?? existing.title, 48);
  const updated = conversations.map((item) =>
    item.id === id
      ? {
          ...item,
          title: nextTitle,
          updatedAt: new Date().toISOString(),
        }
      : item,
  );

  await writeConversations(sortConversations(updated));

  return {
    item: updated.find((item) => item.id === id),
  };
});

app.post("/api/conversations/:id/archive", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const conversations = await readConversations();
  const existing = conversations.find((item) => item.id === id);

  if (!existing) {
    reply.code(404);
    return { error: "Conversation not found." };
  }

  const archivedAt = new Date().toISOString();
  const archivedConversation: Conversation = {
    ...existing,
    archivedAt,
    updatedAt: archivedAt,
  };
  const updated = conversations.map((item) => (item.id === id ? archivedConversation : item));

  await writeConversations(sortConversations(updated));
  await finalizeConversationLifecycle(archivedConversation, "archived", archivedAt);

  return {
    item: archivedConversation,
  };
});

app.delete("/api/conversations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const conversations = await readConversations();
  const existing = conversations.find((item) => item.id === id) ?? null;
  const remaining = conversations.filter((item) => item.id !== id);

  if (remaining.length === conversations.length) {
    reply.code(404);
    return { error: "Conversation not found." };
  }

  if (existing) {
    const archivedAt = new Date().toISOString();
    await finalizeConversationLifecycle(
      {
        ...existing,
        archivedAt: existing.archivedAt ?? archivedAt,
        updatedAt: archivedAt,
      },
      "deleted",
      archivedAt,
    );
  }

  await writeConversations(sortConversations(remaining));
  return { ok: true };
});

app.get("/api/providers", async () => {
  const [providers, connectorTypes] = await Promise.all([
    readProviders(),
    readConnectorTypes(),
  ]);

  return {
    items: providers.map((provider) => ({
      ...provider,
      connectorType:
        connectorTypes.find((item) => item.id === provider.typeId) ?? null,
    })),
  };
});

app.post("/api/providers", async (request, reply) => {
  const body = request.body as {
    name?: string;
    typeId?: Provider["typeId"];
    config?: Record<string, string>;
    secrets?: Record<string, string>;
  };

  if (!body?.name || !body?.typeId) {
    reply.code(400);
    return { error: "name and typeId are required." };
  }

  const [providers, secrets] = await Promise.all([
    readProviders(),
    readProviderSecrets(),
  ]);

  const provider: Provider = {
    id: createId("provider"),
    name: body.name.trim(),
    typeId: body.typeId,
    status: "idle",
    config: sanitizeProviderConfig(body.typeId, sanitizeRecord(body.config)),
    availableModels: [],
    capabilities: getProviderCapabilities(body.typeId),
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  providers.unshift(provider);
  await writeProviders(providers);

  const sanitizedSecrets = sanitizeRecord(body.secrets);
  if (Object.keys(sanitizedSecrets).length > 0) {
    secrets[provider.id] = sanitizedSecrets;
    await writeProviderSecrets(secrets);
  }

  reply.code(201);
  return { item: provider };
});

app.put("/api/providers/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = request.body as {
    name?: string;
    config?: Record<string, string>;
    secrets?: Record<string, string>;
    clearSecrets?: string[];
  };

  const [providers, secrets] = await Promise.all([
    readProviders(),
    readProviderSecrets(),
  ]);
  const provider = providers.find((candidate) => candidate.id === id);

  if (!provider) {
    reply.code(404);
    return { error: "Provider not found." };
  }

  if (typeof body?.name === "string" && body.name.trim().length === 0) {
    reply.code(400);
    return { error: "Provider name cannot be empty." };
  }

  const nextConfig = sanitizeProviderConfig(provider.typeId, {
    ...provider.config,
    ...sanitizeRecord(body?.config),
  });

  if (body?.config) {
    for (const [key, value] of Object.entries(body.config)) {
      if (typeof value === "string" && value.trim().length === 0) {
        delete nextConfig[key];
      }
    }
  }

  const currentSecrets = { ...(secrets[id] ?? {}) };
  if (body?.clearSecrets?.length) {
    for (const key of body.clearSecrets) {
      delete currentSecrets[key];
    }
  }

  Object.assign(currentSecrets, sanitizeRecord(body?.secrets));
  if (Object.keys(currentSecrets).length === 0) {
    delete secrets[id];
  } else {
    secrets[id] = currentSecrets;
  }

  const updated = providers.map((candidate) =>
    candidate.id === id
      ? {
          ...candidate,
          name: body?.name?.trim() || candidate.name,
          config: nextConfig,
          updatedAt: new Date().toISOString(),
        }
      : candidate,
  );

  await Promise.all([
    writeProviders(updated),
    writeProviderSecrets(secrets),
  ]);

  return { item: updated.find((candidate) => candidate.id === id) };
});

app.post("/api/providers/:id/connect", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const [providers, secrets] = await Promise.all([
    readProviders(),
    readProviderSecrets(),
  ]);
  const provider = providers.find((candidate) => candidate.id === id);

  if (!provider) {
    reply.code(404);
    return { error: "Provider not found." };
  }

  const existingStatus = await recheckProvider(provider, secrets);
  const result =
    existingStatus.status === "connected"
      ? existingStatus
      : provider.capabilities.requiresBrowserAuth
        ? launchProviderConnect(provider)
        : existingStatus;
  const updated = providers.map((candidate) =>
    candidate.id === id
      ? {
          ...candidate,
          status: result.status,
          availableModels: result.availableModels,
          lastError: result.lastError,
          updatedAt: new Date().toISOString(),
        }
      : candidate,
  );

  await writeProviders(updated);
  return { item: updated.find((candidate) => candidate.id === id) };
});

app.post("/api/providers/:id/reconnect", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const [providers, secrets] = await Promise.all([
    readProviders(),
    readProviderSecrets(),
  ]);
  const provider = providers.find((candidate) => candidate.id === id);

  if (!provider) {
    reply.code(404);
    return { error: "Provider not found." };
  }

  const result = provider.capabilities.requiresBrowserAuth
    ? launchProviderConnect(provider)
    : await recheckProvider(provider, secrets);

  const updated = providers.map((candidate) =>
    candidate.id === id
      ? {
          ...candidate,
          status: result.status,
          availableModels: result.availableModels,
          lastError: result.lastError,
          updatedAt: new Date().toISOString(),
        }
      : candidate,
  );

  await writeProviders(updated);
  return { item: updated.find((candidate) => candidate.id === id) };
});

app.post("/api/providers/:id/recheck", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const [providers, secrets] = await Promise.all([
    readProviders(),
    readProviderSecrets(),
  ]);
  const provider = providers.find((candidate) => candidate.id === id);

  if (!provider) {
    reply.code(404);
    return { error: "Provider not found." };
  }

  const result = await recheckProvider(provider, secrets);
  const updated = providers.map((candidate) =>
    candidate.id === id
      ? {
          ...candidate,
          status: result.status,
          availableModels: result.availableModels,
          lastError: result.lastError,
          updatedAt: new Date().toISOString(),
        }
      : candidate,
  );

  await writeProviders(updated);
  return { item: updated.find((candidate) => candidate.id === id) };
});

app.delete("/api/providers/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const [providers, secrets, assignments] = await Promise.all([
    readProviders(),
    readProviderSecrets(),
    readRoleAssignments(),
  ]);

  const remainingProviders = providers.filter((provider) => provider.id !== id);
  if (remainingProviders.length === providers.length) {
    reply.code(404);
    return { error: "Provider not found." };
  }

  delete secrets[id];

  const sanitizedAssignments = assignments.map((assignment) =>
    assignment.providerId === id
      ? {
          ...assignment,
          providerId: null,
          modelId: null,
        }
      : assignment,
  );

  await Promise.all([
    writeProviders(remainingProviders),
    writeProviderSecrets(secrets),
    writeRoleAssignments(sanitizedAssignments),
  ]);

  return { ok: true };
});

app.get("/api/roles", async () => {
  const [assignments, providers] = await Promise.all([
    readRoleAssignments(),
    readProviders(),
  ]);
  return {
    items: assignments.map((assignment) => ({
      ...assignment,
      provider: providers.find((provider) => provider.id === assignment.providerId) ?? null,
    })),
    providers,
  };
});

app.put("/api/roles", async (request, reply) => {
  const body = request.body as { items?: RoleAssignment[] };
  if (!body?.items) {
    reply.code(400);
    return { error: "items are required." };
  }

  await writeRoleAssignments(body.items);
  return { items: body.items };
});

app.get("/api/settings", async () => {
  return {
    item: await readSettings(),
  };
});

app.put("/api/settings", async (request, reply) => {
  const body = request.body as { item?: Awaited<ReturnType<typeof readSettings>> };
  if (!body?.item) {
    reply.code(400);
    return { error: "item is required." };
  }

  await writeSettings(body.item);
  return { item: body.item };
});

app.get("/api/prompts/:role", async (request, reply) => {
  const role = (request.params as { role: Role }).role;
  const settings = await readSettings();
  if (!["dispatch", "coordinator", "advisor", "director", "inspector", "ops"].includes(role)) {
    reply.code(400);
    return { error: "Unknown role." };
  }

  return {
    item: getPromptStack(settings, role),
  };
});

app.post("/api/chat", async (request) => {
  const body = request.body as ChatRequest;
  const built = await buildExecution(body);

  try {
    const conversation = await persistConversationFromResult(body, built.result);
    await consolidatePersistedConversation(built.context, conversation, built.toolObservations);

    return {
      ...built.result,
      conversationId: conversation.id,
      conversation: toConversationSummary(conversation),
    };
  } finally {
    await built.context.memoryRepository?.close?.();
  }
});

app.post("/api/chat/attachments/prepare", async (request, reply) => {
  const body = request.body as { uploads?: ChatAttachmentUpload[] };
  if (!Array.isArray(body.uploads) || body.uploads.length === 0) {
    reply.code(400);
    return { message: "uploads is required." };
  }

  try {
    const groups = await prepareAttachmentUploads(body.uploads);
    return { groups };
  } catch (error) {
    reply.code(400);
    return {
      message: error instanceof Error ? error.message : "Attachment preparation failed.",
    };
  }
});

app.post("/api/chat/stream", async (request, reply) => {
  const body = request.body as ChatRequest;
  let streamExecutionContext: ExecutionContext | null = null;

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.flushHeaders?.();

  // Disable Nagle's algorithm so each event flushes to the client immediately.
  (reply.raw.socket as import("node:net").Socket | null)?.setNoDelay(true);

  const send = (event: ChatStreamEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    (reply.raw as typeof reply.raw & { flush?: () => void }).flush?.();
  };

  const heartbeat = setInterval(() => {
    reply.raw.write(": keep-alive\n\n");
    (reply.raw as typeof reply.raw & { flush?: () => void }).flush?.();
  }, 15_000);

  reply.raw.write(": stream-open\n\n");
  (reply.raw as typeof reply.raw & { flush?: () => void }).flush?.();

  // Send an immediate heartbeat so the client knows the server is alive
  // before the (potentially slow) routing/dispatch LLM call begins.
  const mode = normalizeChatMode(body.mode);
  send({
    type: "status",
    phase: "routing",
    message: mode === "auto" ? "Evaluating route..." : "Connecting to provider...",
    role: null,
    providerName: null,
    modelId: null,
  });

  try {
    const context = await prepareExecution(body);
    streamExecutionContext = context;
    const compactedBody = context.compactedRequest;

    if (context.routeDecision) {
      sendStreamEvent(send, {
        type: "status",
        phase: "routing",
        message: `Auto routed to ${context.routeDecision.role} via ${formatRouteSource(context.routeDecision.source)}.`,
        role: context.routeDecision.role,
        providerName: context.provider?.name ?? null,
        modelId: context.responseModelId,
      });
    }

    const provider = context.provider;

    if (requestHasImageAttachments(compactedBody) && provider && !provider.capabilities.canUseImages) {
      throw createStatusError(
        409,
        `${provider.name} does not accept image inputs. Switch to an image-capable provider or remove the image.`,
      );
    }

    const resultMessages: ChatMessage[] = [];
    const toolObservations: MemoryToolObservation[] = [];
    const streamVisitCounts = new Map<string, number>();
    let streamCtx = context;
    let streamConversation = [...compactedBody.conversation];
    let streamContent = compactedBody.content;

    for (let iteration = 0; iteration < MAX_AGENT_LOOP; iteration++) {
      const iterProvider = streamCtx.provider;
      if (!iterProvider || iterProvider.status !== "connected" || !providerCanChat(iterProvider)) {
        if (iteration === 0) resolveExecutionGuard(streamCtx);
        console.warn(`[loop] no usable provider for ${streamCtx.activeRole}, stopping`);
        break;
      }

      if (iteration === 0) {
        sendStreamEvent(send, {
          type: "status",
          phase: "provider",
          message: `Using ${iterProvider.name}${streamCtx.responseModelId ? ` with ${streamCtx.responseModelId}` : ""}.`,
          role: streamCtx.activeRole,
          providerName: iterProvider.name,
          modelId: streamCtx.responseModelId,
        });
      } else {
        sendStreamEvent(send, {
          type: "status",
          phase: "routing",
          message: `Handing off to ${streamCtx.activeRole}...`,
          role: streamCtx.activeRole,
          providerName: iterProvider.name,
          modelId: streamCtx.responseModelId,
        });
      }

      const memoryContext = await buildPersistentMemoryContext(
        streamCtx,
        streamConversation,
        streamContent,
        body.conversationId ?? null,
      );
      const procedureContext = await buildProcedureMemoryContext(
        streamCtx,
        streamConversation,
        streamContent,
        body.conversationId ?? null,
      );
      const handler = createToolHandler({
        browserSessionKey: streamCtx.browserSessionKey,
        onToolResult(observation) {
          toolObservations.push(observation);
        },
      });
      const compactedConversation = compactConversationForContext(
        streamConversation,
        streamContent,
        streamCtx.settings,
        streamCtx.promptStack,
        iterProvider,
      ).messages;
      let iterThinking = "";
      let iterContent = "";

      try {
        const iterExecution = await streamProviderChat(
          iterProvider,
          context.secrets,
          {
            modelId: streamCtx.assignment?.modelId ?? null,
            promptStack: streamCtx.promptStack,
            memoryContext,
            procedureContext,
            role: streamCtx.activeRole,
            conversation: compactedConversation,
            content: streamContent,
            tools: streamCtx.tools,
            onToolCall: handler.onToolCall,
          },
          {
            onStatus(message) {
              sendStreamEvent(send, {
                type: "status",
                phase: "streaming",
                message,
                role: streamCtx.activeRole,
                providerName: iterProvider.name,
                modelId: streamCtx.responseModelId,
              });
            },
            onThinking(text) {
              iterThinking += text;
              sendStreamEvent(send, { type: "thinking", text });
            },
            onContent(text) {
              iterContent += text;
              sendStreamEvent(send, { type: "content", text });
            },
          },
        );
        await recordMemoryRetrievalSuccesses(
          streamCtx.memoryRepository,
          memoryContext,
          new Date().toISOString(),
        );
        await recordMemoryRetrievalSuccesses(
          streamCtx.memoryRepository,
          procedureContext,
          new Date().toISOString(),
        );

        const iterNote = `${streamCtx.routeNote ?? ""} Live response via ${iterProvider.name}.`.trim();
        const iterMsg = buildReplyMessage(
          streamCtx, body, iterExecution.content, iterExecution.thinking ?? null, iterExecution.modelId, iterNote,
        );
        resultMessages.push(iterMsg);

        const handoff = handler.getPendingHandoff();
        if (!handoff) break;

        const visits = (streamVisitCounts.get(handoff.role) ?? 0) + 1;
        if (visits > MAX_ROLE_VISITS) {
          console.warn(`[loop] ${handoff.role} hit visit limit (${MAX_ROLE_VISITS}), stopping`);
          break;
        }
        streamVisitCounts.set(handoff.role, visits);
        console.log(`[loop] ${streamCtx.activeRole} → handoff: ${handoff.role} (visit ${visits})`);

        streamConversation = [...compactedConversation, iterMsg];
        streamContent = handoff.message;
        streamCtx = buildHandoffContext(streamCtx, handoff.role as ExecutionRole);
      } catch (chainError) {
        if (iteration === 0) throw chainError;
        console.warn(`[loop] ${streamCtx.activeRole} failed: ${chainError instanceof Error ? chainError.message : String(chainError)}`);
        break;
      }
    }

    const lastResultMessage = resultMessages.at(-1)!;
    const result: ChatExecutionResult = {
      messages: resultMessages,
      activeRole: (lastResultMessage.authorRole as Role) ?? context.activeRole,
      providerId: lastResultMessage.providerId ?? provider?.id ?? null,
      providerName: lastResultMessage.providerName ?? provider?.name ?? null,
      modelId: lastResultMessage.modelId ?? context.responseModelId,
      promptStack: context.promptStack,
      routedTo: context.routedTo,
      conversationId: body.conversationId ?? null,
    };

    sendStreamEvent(send, {
      type: "status",
      phase: "saving",
      message: "Saving conversation...",
      role: context.activeRole,
      providerName: provider?.name ?? null,
      modelId: context.responseModelId,
    });

    const conversation = await persistConversationFromResult(body, result);
    await consolidatePersistedConversation(context, conversation, toolObservations);
    sendStreamEvent(send, {
      type: "complete",
      message: lastResultMessage,
      conversationId: conversation.id,
      conversation: toConversationSummary(conversation),
    });
  } catch (error) {
    sendStreamEvent(send, {
      type: "error",
      message: error instanceof Error ? error.message : "Chat request failed.",
      statusCode:
        error && typeof error === "object" && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode) || undefined
          : undefined,
    });
  } finally {
    clearInterval(heartbeat);
    await streamExecutionContext?.memoryRepository?.close?.();
    reply.raw.end();
  }

  return reply;
});

app.listen({ host, port }).catch((error) => {
  console.error(error);
  process.exit(1);
});
