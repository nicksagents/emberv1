// @ember/connectors rebuilt — edit this file to force tsx watch to reload packaged dependencies.

// Load .env before any module reads process.env. ESM hoists all imports,
// so this MUST be a separate module imported first.
import "./env-loader.js";

import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
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
  consolidateMemories,
  consolidateConversationMemory,
  createMemoryRepository,
  deriveCompressionPromptBudget,
  estimateConversationTokens,
  estimatePromptExtraTokens,
  estimatePromptInputTokens,
  progressiveCompactConversation,
  revalidateMemoryItem,
  retireProcedureMemory,
  suppressMemoryItem,
  type ConnectorTypeId,
  ensureDataFiles,
  initializeMemoryInfrastructure,
  getProviderCapabilities,
  isLocalOpenAiCompatibleBaseUrl,
  MIN_CONTEXT_WINDOW_TOKENS,
  resolveProviderContextWindowTokens,
  sanitizeProviderConfig,
  readConnectorTypes,
  readConversations,
  readProviderSecrets,
  readProviders,
  readRoleAssignments,
  readRuntime,
  readSettings,
  recordTaskOutcomeMemory,
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
  ConversationUsage,
  MemoryPromptContext,
  MemoryRepository,
  MemoryToolObservation,
  PromptStack,
  Provider,
  Role,
  RoleAssignment,
  TaskOutcome,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "@ember/core";
import type { UiBlock } from "@ember/ui-schema";
import {
  buildDispatchInput,
  formatRouteSource,
  resolveDispatchDecision,
  routeAutoRequestPolicy,
  type AutoRouteDecision,
} from "./routing.js";
import {
  buildAssignedModelFallbackDecision,
  buildModelDispatchInput,
  formatModelRouteSource,
  resolveModelDispatchDecision,
  resolveModelRoutePolicy,
  type ExecutionModelDecision,
} from "./model-routing.js";
import {
  buildAssignedProviderFallbackDecision,
  buildProviderDispatchInput,
  formatProviderRouteSource,
  resolveProviderDispatchDecision,
  resolveProviderRoutePolicy,
  type ExecutionProviderDecision,
} from "./provider-routing.js";
import {
  applyParallelChildToolProfile,
  applyParallelChildToolProfileToSnapshot,
  createToolHandler,
  getExecutionToolSnapshotForRole,
  getExecutionToolsForRole,
  registerMcpTools,
  registerPluginTools,
  replaceMcpTools,
  setToolConfig,
  setMcpInstallContext,
  setToolMakerContext,
  setSwarmLlmCall,
  setSwarmEventSink,
  loadCustomTools,
  loadToolPlugins,
  setActivePlugins,
  cleanupPlugins,
} from "./tools/index.js";
import { skillManager } from "@ember/core/skills";
import { McpClientManager } from "./mcp/mcp-client-manager.js";
import type { McpConfig, McpServerConfig } from "@ember/core/mcp";
import {
  buildInstalledMcpServer,
  buildRemoteMcpServer,
  describeMcpServerTransport,
  derivePublicMcpServerName,
  normalizeMcpServerName,
  readResolvedMcpConfigState,
  removeMcpServer,
  resolveMcpTransportKind,
  sanitizeMcpRoleList,
  sanitizeMcpStringList,
  sanitizeMcpStringRecord,
  upsertMcpServer,
  validateMcpServerConfig,
  validatePublicMcpPackageName,
  type McpConfigScope,
} from "./mcp/config.js";
import {
  buildSettingsSecretStatus,
  redactMcpServerConfig,
  redactSettingsForApi,
  unmaskMcpSecretRecord,
} from "./api-redaction.js";
import {
  assertAuthConfigIsSafe,
  authorizeApiRequest,
  buildIdempotencyFingerprint,
  isCorsOriginAllowed,
  MemoryIdempotencyStore,
  isRuntimeMcpInstallEnabled,
  MemoryRateLimiter,
  normalizeIdempotencyKey,
  parseCorsOrigins,
  resolveIdempotencyConfig,
  resolveApiAuthConfig,
  resolveRateLimitConfig,
  shouldApplyIdempotency,
  validateMutationOrigin,
  validateMcpRemoteTarget,
  validateRequestBodyShape,
} from "./security.js";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { prepareAttachmentUploads } from "./chat-attachments.js";
import { listMemoryRetrievalTraces, recordMemoryRetrievalTrace } from "./memory-traces.js";
import { buildRequestAuditEvent, flushAuditLog, writeAuditEvent } from "./audit-log.js";
import { CONFIG } from "./config.js";
import { createRequestLogger, type RequestLogger } from "./logger.js";
import {
  getMemoryReplayState,
  maybeRunMemoryReplayWithRepository,
  runScheduledMemoryReplay,
  startMemoryReplayScheduler,
} from "./memory-maintenance.js";
import { buildMemoryGraph, buildMemoryOverview } from "./memory-visualization.js";
import {
  decidePendingTerminalApproval,
  listPendingTerminalApprovals,
  type TerminalApprovalDecision,
} from "./tools/terminal.js";
import {
  listCheckpoints,
  rollbackCheckpoint,
} from "./checkpoints.js";
import {
  resolveExecutionModelProfile,
  resolveExecutionPromptBudget,
  toMemorySearchBudgetOverrides,
} from "./prompt-budget.js";
import { buildRolePromptStack } from "./orchestration-prompt.js";
import {
  applyTaskOutcomeFeedback,
  assessTask,
  buildSimulationRecommendationHint,
  resolveCognitiveProfile,
  buildProviderOverrides,
  buildMetacognitivePromptSection,
  createExecutionMonitor,
  shouldAutoSimulate,
  updateExecutionMonitor,
  suggestStrategyAdjustment,
  buildStrategyInjection,
} from "./metacognition.js";
import {
  deriveAttentionKey,
  getOrCreateAttentionContext,
  recordRoleAttentionUpdate,
  buildAttentionPromptSection,
} from "./attention.js";
import {
  buildDeliveryWorkflowBlocks,
  buildDeliveryWorkflowReminder,
  buildDeliveryWorkflowPrompt,
  createInitialDeliveryWorkflow,
  extractPersistedDeliveryWorkflow,
  type DeliveryWorkflowState,
} from "./delivery-workflow.js";
import {
  buildProcedureMemorySearchQuery,
  buildStructuredMemorySearchQuery,
  hasProcedureMemorySearchCues,
  hasStructuredMemorySearchCues,
} from "./memory-query.js";
import {
  executeParallelSubtasks,
  formatParallelResults,
  getParallelTaskPolicy,
  listParallelTaskTraces,
  parseParallelTaskRequest,
  recordParallelTaskTrace,
  type ParallelTaskToolProfile,
} from "./parallel-tasks.js";
import {
  classifyFailoverCause,
  getFailoverMetricsSnapshot,
  getUnavailableProviderIds,
  isProviderAvailable,
  isProviderAvailablePassive,
  recordProviderFailure,
  recordProviderSuccess,
  recordFailoverEvent,
  setCircuitBreakerEventSink,
} from "./failover.js";
import { normalizeSessionRecallQuery, searchSessionRecall } from "./session-recall.js";
const host = CONFIG.network.apiHost;
const port = CONFIG.network.apiPort;

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function requestHasImageAttachments(request: ChatRequest): boolean {
  return request.conversation.some((message) =>
    (message.attachments ?? []).some((attachment) => attachment.kind === "image"),
  );
}

function conversationHasImageAttachments(conversation: ChatMessage[]): boolean {
  return conversation.some((message) =>
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

function validateProviderContextWindowConfig(
  typeId: Provider["typeId"],
  config: Record<string, string>,
): string | null {
  if (typeId !== "openai-compatible") {
    return null;
  }

  const baseUrl = config.baseUrl?.trim() ?? "";
  if (!isLocalOpenAiCompatibleBaseUrl(baseUrl)) {
    return null;
  }

  const raw = config.contextWindowTokens?.trim() ?? "";
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < MIN_CONTEXT_WINDOW_TOKENS) {
    return `Local provider context window must be at least ${MIN_CONTEXT_WINDOW_TOKENS} tokens.`;
  }

  return null;
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

function computeConversationUsage(
  messages: ChatMessage[],
  existingUsage?: ConversationUsage,
): ConversationUsage {
  const usage: ConversationUsage = existingUsage
    ? { ...existingUsage, providerUsage: { ...existingUsage.providerUsage } }
    : { totalInputTokens: 0, totalOutputTokens: 0, messageCount: 0, toolCallCount: 0, providerUsage: {} };

  // Only process messages not already counted
  const startIndex = existingUsage ? existingUsage.messageCount : 0;
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!;
    usage.messageCount++;
    if (msg.usage) {
      usage.totalInputTokens += msg.usage.inputTokens;
      usage.totalOutputTokens += msg.usage.outputTokens;
      const providerKey = msg.providerId ?? "unknown";
      const existing = usage.providerUsage[providerKey] ?? { inputTokens: 0, outputTokens: 0 };
      existing.inputTokens += msg.usage.inputTokens;
      existing.outputTokens += msg.usage.outputTokens;
      usage.providerUsage[providerKey] = existing;
    }
    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
      usage.toolCallCount += msg.toolCalls.length;
    }
  }
  return usage;
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
    usage: computeConversationUsage(finalMessages, existing?.usage),
  };
}

type ExecutionRole = Exclude<Role, "dispatch">;

function resolveSpeakingRole(role: Role | null): ExecutionRole {
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
            ? `Use active provider ${providerName}`
            : "No provider resolved yet for this role",
          state: providerName ? "complete" : "pending",
        },
        {
          label: modelId ? `Use active model ${modelId}` : "Model selection is still unresolved",
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
  promptStack: PromptStack,
  provider: Provider | null,
  tools: ToolDefinition[],
): ChatRequest {
  const result = compactConversationForContext(
    request.conversation,
    request.content,
    settings,
    promptStack,
    provider,
    tools,
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
  promptStack: PromptStack,
  provider: Provider | null,
  tools: ToolDefinition[],
  extraPromptTokens = 0,
) {
  const promptBudget = resolveExecutionPromptBudget(settings, provider);
  const compressionBudget = deriveCompressionPromptBudget(
    settings.compression,
    promptBudget.contextWindowTokens,
  );
  const extraTokens =
    estimatePromptExtraTokens({ tools }) + Math.max(0, Math.floor(extraPromptTokens));

  // Estimate current prompt tokens to determine progressive compaction stage
  const currentPromptTokens = extraTokens + estimatePromptInputTokens({
    promptStack,
    conversation,
    content,
  });

  // Apply progressive compaction first (tool result aging, thinking removal)
  const { messages: progressiveMessages } = progressiveCompactConversation(
    conversation,
    {
      currentPromptTokens,
      maxPromptTokens: compressionBudget.maxPromptTokens,
      targetPromptTokens: compressionBudget.targetPromptTokens,
      contextWindowTokens: promptBudget.contextWindowTokens,
    },
  );

  // Then apply full compaction if still needed (on pre-aged messages)
  return compactConversationHistory(progressiveMessages, {
    enabled: settings.compression.enabled,
    maxPromptTokens: compressionBudget.maxPromptTokens,
    targetPromptTokens: compressionBudget.targetPromptTokens,
    preserveRecentMessages: settings.compression.preserveRecentMessages,
    minimumRecentMessages: settings.compression.minimumRecentMessages,
    extraPromptTokens: extraTokens,
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
  promptStack: PromptStack;
  tools: ReturnType<typeof getExecutionToolsForRole>;
  toolSnapshot: ReturnType<typeof getExecutionToolSnapshotForRole>;
  assignment: RoleAssignment | undefined;
  provider: Provider | null;
  providerDecision: ExecutionProviderDecision | null;
  modelDecision: ExecutionModelDecision | null;
  responseModelId: string | null;
  routeNote: string | null;
  handoffSourceRole: Role | null;
  workflowState: DeliveryWorkflowState | null;
  taskAssessment: ReturnType<typeof assessTask>;
  cognitiveProfile: ReturnType<typeof resolveCognitiveProfile>;
  browserSessionKey: string;
  parallelDepth: number;
  parallelToolProfile: ParallelTaskToolProfile | null;
  inheritedContextWindowTokens: number | null;
  inheritedSubtaskTimeoutMs: number | null;
  failoverAttempts: number;
  /** True when the user explicitly selected a role (not "auto"). Handoff is disabled. */
  rolePinned: boolean;
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

function buildModelSelectionNote(decision: ExecutionModelDecision | null): string | null {
  if (!decision?.modelId) {
    return null;
  }

  return `Model routed to ${decision.modelId} via ${formatModelRouteSource(decision.source)}. ${decision.reason}`;
}

function buildProviderSelectionNote(
  provider: Provider | null,
  decision: ExecutionProviderDecision | null,
): string | null {
  if (!provider || !decision?.providerId) {
    return null;
  }

  return `Provider routed to ${provider.name} via ${formatProviderRouteSource(decision.source)}. ${decision.reason}`;
}

function buildProviderStatusMessage(
  provider: Provider,
  providerDecision: ExecutionProviderDecision | null,
  decision: ExecutionModelDecision | null,
): string {
  const reasonParts = [buildProviderSelectionNote(provider, providerDecision), buildModelSelectionNote(decision)]
    .filter(Boolean)
    .join(" ");
  if (!decision?.modelId) {
    return reasonParts ? `Using ${provider.name}. ${reasonParts}` : `Using ${provider.name}.`;
  }

  return reasonParts
    ? `Using ${provider.name} with ${decision.modelId}. ${reasonParts}`
    : `Using ${provider.name} with ${decision.modelId}.`;
}

function buildReplyMessage(
  context: ExecutionContext,
  request: ChatRequest,
  responseContent: string,
  responseThinking: string | null,
  responseModelId: string | null,
  executionNote: string,
  responseUsage?: TokenUsage | null,
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
    usage: responseUsage ?? null,
    blocks: createBlocks(
      context.activeRole,
      context.mode,
      request.content,
      context.provider?.name ?? null,
      responseModelId,
      "live",
      executionNote,
    ).concat(buildDeliveryWorkflowBlocks(context.workflowState)),
  };
}

const MAX_AGENT_LOOP = CONFIG.request.maxAgentLoop;
const MAX_ROLE_VISITS = CONFIG.request.maxRoleVisits;
const DISPATCH_TIMEOUT_MS = CONFIG.request.dispatchTimeoutMs;
const parallelTaskPolicy = getParallelTaskPolicy();
const FAILOVER_ENABLED = CONFIG.failover.enabled;
const FAILOVER_FAILURE_THRESHOLD = CONFIG.failover.failureThreshold;
const FAILOVER_MAX_SWITCHES_PER_TURN = CONFIG.failover.maxSwitchesPerTurn;
const MEMORY_CONSOLIDATION_IDLE_THRESHOLD_MS = CONFIG.memory.consolidationIdleThresholdMs;
let lastExecutionActivityAt: number | null = null;

async function buildHandoffContext(
  source: ExecutionContext,
  targetRole: ExecutionRole,
  handoffMessage: string,
  conversation: ChatMessage[],
  workflowState: DeliveryWorkflowState | null,
  options: {
    forceEscalation?: boolean;
    routeNote?: string | null;
  } = {},
): Promise<ExecutionContext> {
  const assignment = source.assignmentMap.get(targetRole);
  const routerAssignment = source.assignmentMap.get("dispatch");
  let taskAssessment = assessTask(handoffMessage, conversation, targetRole);
  taskAssessment = await applyTaskOutcomeFeedback(taskAssessment, {
    taskDescription: handoffMessage,
    memoryRepository: source.memoryRepository,
  });
  const cognitiveProfile = resolveCognitiveProfile(taskAssessment);
  const simulationHint = buildSimulationRecommendationHint(taskAssessment);
  const providerOverrides = buildProviderOverrides(cognitiveProfile);
  const candidateProviders = source.providers.filter((candidate) =>
    candidate.id !== routerAssignment?.providerId || candidate.id === assignment?.providerId,
  );
  const preferredProvider = source.providers.find((p) => p.id === assignment?.providerId) ?? null;
  const providerDecision = await resolveExecutionProviderDecision({
    role: targetRole,
    preferredProviderId: assignment?.providerId ?? null,
    request: {
      content: handoffMessage,
      conversation,
    },
    settings: source.settings,
    candidateProviders,
    providers: source.providers,
    assignmentMap: source.assignmentMap,
    secrets: source.secrets,
    workflowState,
    requiresImages: conversationHasImageAttachments(conversation),
    profileOverrides: providerOverrides,
    forceEscalation: options.forceEscalation === true,
  });
  const provider =
    source.providers.find((candidate) => candidate.id === providerDecision.providerId) ??
    preferredProvider ??
    null;
  const handoffPressure = (() => {
    const convTokens = estimateConversationTokens(conversation);
    const budget = deriveCompressionPromptBudget(source.settings.compression, resolveProviderContextWindowTokens(provider, source.settings));
    return budget.maxPromptTokens > 0 ? convTokens / budget.maxPromptTokens : 0;
  })();
  const executionProfile = resolveExecutionModelProfile(source.settings, provider, targetRole, handoffPressure);
  const roleTools = provider && !provider.capabilities.canUseTools
    ? []
    : getExecutionToolsForRole(targetRole, {
        compact: executionProfile.compactToolset,
        ultraCompact: executionProfile.ultraCompactToolset,
        content: handoffMessage,
        conversation,
        customToolTrustMode: source.settings.customTools.trustMode,
        maxEffectiveTools: executionProfile.maxEffectiveTools,
      });
  const roleToolSnapshot = provider && !provider.capabilities.canUseTools
    ? new Map()
    : getExecutionToolSnapshotForRole(targetRole, {
        compact: executionProfile.compactToolset,
        content: handoffMessage,
        conversation,
        customToolTrustMode: source.settings.customTools.trustMode,
      });
  const tools = source.parallelToolProfile
    ? applyParallelChildToolProfile(roleTools, source.parallelToolProfile)
    : roleTools;
  const toolSnapshot = source.parallelToolProfile
    ? applyParallelChildToolProfileToSnapshot(roleToolSnapshot, source.parallelToolProfile)
    : roleToolSnapshot;
  const metacognitiveSection = executionProfile.includeAdvancedSections
    ? buildMetacognitivePromptSection(taskAssessment, cognitiveProfile, targetRole)
    : "";
  const attentionKey = deriveAttentionKey(source.compactedRequest.conversationId ?? null, conversation, handoffMessage);
  const attentionCtx = getOrCreateAttentionContext({
    key: attentionKey,
    primaryGoal: handoffMessage,
    currentFocus: handoffMessage,
    conversation,
  });
  const attentionSection = executionProfile.includeAdvancedSections
    ? buildAttentionPromptSection(attentionCtx)
    : "";
  const promptStack = buildRolePromptStack({
    settings: source.settings,
    role: targetRole,
    tools,
    providers: source.providers,
    assignmentMap: source.assignmentMap,
    compactRolePrompt: executionProfile.compactRolePrompt,
    compactToolPrompt: executionProfile.compactToolPrompt,
    extraSharedSections: [
      buildDeliveryWorkflowPrompt(workflowState, targetRole),
      ...(simulationHint ? [simulationHint] : []),
      ...(metacognitiveSection ? [metacognitiveSection] : []),
      ...(attentionSection ? [attentionSection] : []),
    ],
  });
  const modelDecision = provider
    ? await resolveExecutionModelDecision({
        role: targetRole,
        provider,
        preferredModelId: provider.id === assignment?.providerId ? assignment?.modelId ?? null : null,
        request: {
          content: handoffMessage,
          conversation,
        },
        settings: source.settings,
        providers: source.providers,
        assignmentMap: source.assignmentMap,
        secrets: source.secrets,
        workflowState,
        profileOverrides: providerOverrides,
        forceEscalation: options.forceEscalation === true,
      })
    : null;
  const responseModelId =
    modelDecision?.modelId ??
    assignment?.modelId ??
    provider?.config.defaultModelId ??
    provider?.availableModels[0] ??
    null;
  const resolvedProviderWindow = resolveProviderContextWindowTokens(provider, source.settings);
  const inheritedContextWindowTokens = source.inheritedContextWindowTokens != null
    ? Math.min(source.inheritedContextWindowTokens, resolvedProviderWindow)
    : resolvedProviderWindow;
  const routeNote =
    options.routeNote ??
    (
      options.forceEscalation === true
        ? `Metacognitive escalation refreshed the ${targetRole} lane.`
        : `${source.activeRole} chained to ${targetRole}.`
    );
  return {
    ...source,
    activeRole: targetRole,
    promptStack,
    tools,
    toolSnapshot,
    assignment,
    provider,
    providerDecision,
    modelDecision,
    responseModelId,
    routedTo: targetRole,
    routeNote,
    handoffSourceRole: source.activeRole,
    workflowState,
    taskAssessment,
    cognitiveProfile,
    inheritedContextWindowTokens,
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

function resolveWritableMcpScope(value: unknown): Exclude<McpConfigScope, "default"> | null {
  return value === "user" || value === "project" ? value : null;
}

function normalizeMcpTimeout(value: unknown, fallback?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1_000, Math.floor(value));
}

function resolveMcpInstallTransport(body: {
  transport?: string;
  packageName?: string;
  url?: string;
  httpUrl?: string;
}): "package" | "sse" | "streamable-http" | null {
  const explicit = typeof body.transport === "string" ? body.transport.trim().toLowerCase() : "";
  if (explicit === "package" || explicit === "sse" || explicit === "streamable-http") {
    return explicit;
  }
  if (typeof body.httpUrl === "string" && body.httpUrl.trim()) {
    return "streamable-http";
  }
  if (typeof body.url === "string" && body.url.trim()) {
    return "sse";
  }
  if (typeof body.packageName === "string" && body.packageName.trim()) {
    return "package";
  }
  return null;
}

function buildMergedMcpServerConfig(
  patch: Partial<McpServerConfig>,
  existing: McpServerConfig | null,
): McpServerConfig {
  const nextEnv = patch.env === undefined
    ? sanitizeMcpStringRecord(existing?.env ?? {})
    : unmaskMcpSecretRecord(sanitizeMcpStringRecord(patch.env), existing?.env);
  const nextHeaders = patch.headers === undefined
    ? sanitizeMcpStringRecord(existing?.headers ?? {})
    : unmaskMcpSecretRecord(sanitizeMcpStringRecord(patch.headers), existing?.headers);
  const transportCandidate: Partial<McpServerConfig> = {
    command: typeof patch.command === "string" ? patch.command.trim() : existing?.command,
    args: sanitizeMcpStringList(patch.args ?? existing?.args ?? []),
    env: nextEnv,
    url: typeof patch.url === "string" ? patch.url.trim() : existing?.url,
    httpUrl: typeof patch.httpUrl === "string" ? patch.httpUrl.trim() : existing?.httpUrl,
    headers: nextHeaders,
  };
  const transport = resolveMcpTransportKind(transportCandidate);

  const common: Omit<McpServerConfig, "command" | "args" | "env" | "url" | "httpUrl" | "headers"> = {
    enabled: patch.enabled ?? existing?.enabled ?? true,
    roles: sanitizeMcpRoleList(patch.roles ?? existing?.roles ?? []),
    includeTools: sanitizeMcpStringList(patch.includeTools ?? existing?.includeTools ?? []),
    excludeTools: sanitizeMcpStringList(patch.excludeTools ?? existing?.excludeTools ?? []),
    timeout: normalizeMcpTimeout(patch.timeout, existing?.timeout),
    description: typeof patch.description === "string"
      ? patch.description.trim() || undefined
      : existing?.description,
  };

  if (transport === "stdio") {
    return {
      ...common,
      command: transportCandidate.command?.trim(),
      args: transportCandidate.args,
      env: transportCandidate.env,
    };
  }

  if (transport === "streamable-http") {
    return {
      ...common,
      httpUrl: transportCandidate.httpUrl?.trim(),
      headers: transportCandidate.headers,
    };
  }

  return {
    ...common,
    url: transportCandidate.url?.trim(),
    headers: transportCandidate.headers,
  };
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
    const workflowState = createInitialDeliveryWorkflow(request.content) ??
      extractPersistedDeliveryWorkflow(request.conversation);
    const dispatchPromptStack = buildRolePromptStack({
      settings,
      role: "dispatch",
      tools: [],
      providers,
      assignmentMap,
      extraSharedSections: [buildDeliveryWorkflowPrompt(workflowState, "dispatch")],
    });
    console.log(`[dispatch] calling ${routerProvider.name} (${routerAssignment?.modelId ?? "default model"})`);
    const routerExecution = await Promise.race([
      executeProviderChat(routerProvider, secrets, {
        modelId: routerAssignment?.modelId ?? null,
        promptStack: dispatchPromptStack,
        toolLoopLimit: settings.compression.toolLoopLimit,
        role: "dispatch",
        conversation: [],
        content: buildDispatchInput(request, policy.decision),
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

async function resolveExecutionModelDecision(options: {
  role: ExecutionRole;
  provider: Provider;
  preferredModelId: string | null;
  request: Pick<ChatRequest, "content" | "conversation">;
  settings: ExecutionContext["settings"];
  providers: Provider[];
  assignmentMap: Map<Role, RoleAssignment>;
  secrets: ExecutionContext["secrets"];
  workflowState: DeliveryWorkflowState | null;
  profileOverrides?: {
    complexityHigh?: boolean;
    securityHeavy?: boolean;
    planningHeavy?: boolean;
  };
  forceEscalation?: boolean;
}): Promise<ExecutionModelDecision> {
  const policy = resolveModelRoutePolicy({
    role: options.role,
    provider: options.provider,
    assignedModelId: options.preferredModelId,
    request: options.request,
    profileOverrides: options.profileOverrides,
  });
  const fallbackDecision = options.forceEscalation
    ? policy.decision
    : buildAssignedModelFallbackDecision({
        role: options.role,
        assignedModelId: options.preferredModelId,
        candidates: policy.candidates,
        policyDecision: policy.decision,
      });
  const shouldQueryDispatch =
    options.forceEscalation === true ||
    policy.shouldQueryDispatch ||
    (
      fallbackDecision.modelId !== policy.decision.modelId &&
      policy.candidates.length > 1 &&
      options.request.content.trim().length > 0
    );

  if (!shouldQueryDispatch) {
    return fallbackDecision;
  }

  const routerAssignment = options.assignmentMap.get("dispatch");
  const routerProvider =
    options.providers.find((candidate) => candidate.id === routerAssignment?.providerId) ?? null;

  if (!routerProvider || routerProvider.status !== "connected" || !providerCanChat(routerProvider)) {
    const reason = !routerProvider
      ? "Dispatch provider is not assigned."
      : routerProvider.status !== "connected"
        ? `Dispatch provider ${routerProvider.name} is ${routerProvider.status}.`
        : `Dispatch provider ${routerProvider.name} cannot execute chat requests.`;
    return {
      ...fallbackDecision,
      source: "policy-fallback",
      reason:
        `${reason} ` +
        `Keeping ${fallbackDecision.modelId ?? "the provider default"} as the assigned model lane.`,
    };
  }

  try {
    const dispatchPromptStack = buildRolePromptStack({
      settings: options.settings,
      role: "dispatch",
      tools: [],
      providers: options.providers,
      assignmentMap: options.assignmentMap,
      extraSharedSections: [buildDeliveryWorkflowPrompt(options.workflowState, "dispatch")],
    });
    console.log(
      `[model-routing] calling ${routerProvider.name} for ${options.role} (${routerAssignment?.modelId ?? "default model"})`,
    );
    const routerExecution = await Promise.race([
      executeProviderChat(routerProvider, options.secrets, {
        modelId: routerAssignment?.modelId ?? null,
        promptStack: dispatchPromptStack,
        toolLoopLimit: options.settings.compression.toolLoopLimit,
        role: "dispatch",
        conversation: [],
        content: buildModelDispatchInput({
          role: options.role,
          provider: options.provider,
          assignedModelId: options.preferredModelId,
          request: options.request,
          candidates: policy.candidates,
          fallbackDecision,
        }),
        purpose: "route",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Model routing timed out after ${DISPATCH_TIMEOUT_MS}ms.`));
        }, DISPATCH_TIMEOUT_MS).unref();
      }),
    ]);
    console.log(`[model-routing] raw response: "${routerExecution.content}"`);
    const decision = resolveModelDispatchDecision(
      routerExecution.content,
      fallbackDecision,
      policy.candidates,
    );
    console.log(
      `[model-routing] selected ${decision.modelId ?? "default"} for ${options.role} (source: ${decision.source}, confidence: ${decision.confidence.toFixed(2)})`,
    );
    return decision;
  } catch (error) {
    console.warn(
      `[model-routing] failed, using policy fallback. reason: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      ...fallbackDecision,
      source: "policy-fallback",
      reason:
        `Model routing failed, so the fallback kept ${fallbackDecision.modelId ?? "the provider default"}.`,
    };
  }
}

async function resolveExecutionProviderDecision(options: {
  role: ExecutionRole;
  preferredProviderId: string | null;
  request: Pick<ChatRequest, "content" | "conversation">;
  settings: ExecutionContext["settings"];
  candidateProviders: Provider[];
  providers: Provider[];
  assignmentMap: Map<Role, RoleAssignment>;
  secrets: ExecutionContext["secrets"];
  workflowState: DeliveryWorkflowState | null;
  requiresImages: boolean;
  profileOverrides?: {
    complexityHigh?: boolean;
    securityHeavy?: boolean;
    planningHeavy?: boolean;
  };
  forceEscalation?: boolean;
}): Promise<ExecutionProviderDecision> {
  const policy = resolveProviderRoutePolicy({
    role: options.role,
    providers: options.candidateProviders,
    preferredProviderId: options.preferredProviderId,
    request: options.request,
    settings: options.settings,
    requiresImages: options.requiresImages,
    profileOverrides: options.profileOverrides,
  });
  const fallbackDecision = options.forceEscalation
    ? policy.decision
    : buildAssignedProviderFallbackDecision({
        role: options.role,
        preferredProviderId: options.preferredProviderId,
        providers: options.candidateProviders,
        policyDecision: policy.decision,
      });
  const shouldQueryDispatch =
    options.forceEscalation === true ||
    policy.shouldQueryDispatch ||
    (
      fallbackDecision.providerId !== policy.decision.providerId &&
      policy.candidates.length > 1 &&
      options.request.content.trim().length > 0
    );

  if (!shouldQueryDispatch) {
    return fallbackDecision;
  }

  const routerAssignment = options.assignmentMap.get("dispatch");
  const routerProvider =
    options.providers.find((candidate) => candidate.id === routerAssignment?.providerId) ?? null;

  if (!routerProvider || routerProvider.status !== "connected" || !providerCanChat(routerProvider)) {
    const reason = !routerProvider
      ? "Dispatch provider is not assigned."
      : routerProvider.status !== "connected"
        ? `Dispatch provider ${routerProvider.name} is ${routerProvider.status}.`
        : `Dispatch provider ${routerProvider.name} cannot execute chat requests.`;
    return {
      ...fallbackDecision,
      source: "policy-fallback",
      reason:
        `${reason} ` +
        `Keeping ${fallbackDecision.providerId ?? "the assigned provider"} as the assigned provider lane.`,
    };
  }

  try {
    const dispatchPromptStack = buildRolePromptStack({
      settings: options.settings,
      role: "dispatch",
      tools: [],
      providers: options.providers,
      assignmentMap: options.assignmentMap,
      extraSharedSections: [buildDeliveryWorkflowPrompt(options.workflowState, "dispatch")],
    });
    console.log(
      `[provider-routing] calling ${routerProvider.name} for ${options.role} (${routerAssignment?.modelId ?? "default model"})`,
    );
    const routerExecution = await Promise.race([
      executeProviderChat(routerProvider, options.secrets, {
        modelId: routerAssignment?.modelId ?? null,
        promptStack: dispatchPromptStack,
        toolLoopLimit: options.settings.compression.toolLoopLimit,
        role: "dispatch",
        conversation: [],
        content: buildProviderDispatchInput({
          role: options.role,
          request: options.request,
          candidates: policy.candidates,
          preferredProviderId: options.preferredProviderId,
          fallbackDecision,
        }),
        purpose: "route",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Provider routing timed out after ${DISPATCH_TIMEOUT_MS}ms.`));
        }, DISPATCH_TIMEOUT_MS).unref();
      }),
    ]);
    console.log(`[provider-routing] raw response: "${routerExecution.content}"`);
    const decision = resolveProviderDispatchDecision(
      routerExecution.content,
      fallbackDecision,
      policy.candidates,
    );
    console.log(
      `[provider-routing] selected ${decision.providerId ?? "none"} for ${options.role} (source: ${decision.source}, confidence: ${decision.confidence.toFixed(2)})`,
    );
    return decision;
  } catch (error) {
    console.warn(
      `[provider-routing] failed, using policy fallback. reason: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      ...fallbackDecision,
      source: "policy-fallback",
      reason:
        `Provider routing failed, so the fallback kept ${fallbackDecision.providerId ?? "no provider"}.`,
    };
  }
}

async function prepareExecution(
  request: ChatRequest,
  options: {
    parallelDepth?: number;
    parallelToolProfile?: ParallelTaskToolProfile | null;
    inheritedContextWindowTokens?: number | null;
    inheritedSubtaskTimeoutMs?: number | null;
    requestLogger?: RequestLogger | null;
  } = {},
): Promise<ExecutionContext> {
  const mode = normalizeChatMode(request.mode);
  const [settings, providers, assignments, secrets] = await Promise.all([
    readSettings(),
    readProviders(),
    readRoleAssignments(),
    readProviderSecrets(),
  ]);
  const memoryRepository = settings.memory.enabled
    ? createMemoryRepository(settings.memory)
    : null;
  await maybeRunIdleMemoryConsolidation(request, settings, memoryRepository);

  const assignmentMap = new Map<Role, RoleAssignment>(
    assignments.map((assignment) => [assignment.role, assignment]),
  );
  const routerAssignment = assignmentMap.get("dispatch");
  const routerProvider =
    providers.find((candidate) => candidate.id === routerAssignment?.providerId) ?? null;
  const workflowState = createInitialDeliveryWorkflow(request.content) ??
    extractPersistedDeliveryWorkflow(request.conversation);
  const terminalSessionKey = resolveBrowserSessionKey(request);

  setToolConfig({
    sudoPassword: settings.sudoPassword ?? "",
    sudoSessionKey: terminalSessionKey,
    workspaceRoot: settings.workspaceRoot ?? null,
  });

  const dispatchPromptStack = buildRolePromptStack({
    settings,
    role: "dispatch",
    tools: [],
    providers,
    assignmentMap,
    extraSharedSections: [buildDeliveryWorkflowPrompt(workflowState, "dispatch")],
  });
  const routingRequest =
    mode === "auto"
      ? compactChatRequest(request, settings, dispatchPromptStack, routerProvider, [])
      : request;
  const routeDecision =
    mode === "auto"
      ? await resolveAutoRouteDecision(routingRequest, settings, providers, assignmentMap, secrets)
      : null;
  options.requestLogger?.info("dispatch.decision", {
    mode,
    routeRole: routeDecision?.role ?? null,
    source: routeDecision?.source ?? null,
    confidence: routeDecision?.confidence ?? null,
  });
  const rolePinned = mode !== "auto";
  const routedTo = mode === "auto" ? resolveSpeakingRole(routeDecision?.role ?? null) : null;
  const activeRole = mode === "auto" ? routedTo ?? "coordinator" : resolveSpeakingRole(mode);
  let taskAssessment = assessTask(request.content, request.conversation, activeRole);
  taskAssessment = await applyTaskOutcomeFeedback(taskAssessment, {
    taskDescription: request.content,
    memoryRepository,
  });
  const cognitiveProfile = resolveCognitiveProfile(taskAssessment);
  const simulationHint = buildSimulationRecommendationHint(taskAssessment);
  const autoSimulationMessage = await maybeRunAutoSimulation({
    enabled: settings.agent?.autoSimulate === true,
    role: activeRole,
    mode,
    assessment: taskAssessment,
    settings,
    providers,
    secrets,
  });
  const executionConversation = autoSimulationMessage
    ? [...request.conversation, autoSimulationMessage]
    : request.conversation;
  const requestWithSimulationContext = autoSimulationMessage
    ? { ...request, conversation: executionConversation }
    : request;
  const providerOverrides = buildProviderOverrides(cognitiveProfile);
  const assignment = assignmentMap.get(activeRole);
  const candidateProviders = providers.filter((candidate) =>
    candidate.id !== routerAssignment?.providerId || candidate.id === assignment?.providerId,
  );
  const preferredProvider = providers.find((candidate) => candidate.id === assignment?.providerId) ?? null;
  const providerDecision = await resolveExecutionProviderDecision({
    role: activeRole,
    preferredProviderId: assignment?.providerId ?? null,
    request: {
      content: request.content,
      conversation: executionConversation,
    },
    settings,
    candidateProviders,
    providers,
    assignmentMap,
    secrets,
    workflowState,
    requiresImages: requestHasImageAttachments(request),
    profileOverrides: providerOverrides,
  });
  options.requestLogger?.info("provider.selected", {
    role: activeRole,
    providerId: providerDecision.providerId,
    source: providerDecision.source,
    confidence: providerDecision.confidence,
  });
  const provider =
    providers.find((candidate) => candidate.id === providerDecision.providerId) ??
    preferredProvider ??
    null;
  const contextPressure = (() => {
    const conversationTokens = estimateConversationTokens(executionConversation);
    const budget = deriveCompressionPromptBudget(settings.compression, resolveProviderContextWindowTokens(provider, settings));
    return budget.maxPromptTokens > 0 ? conversationTokens / budget.maxPromptTokens : 0;
  })();
  const executionProfile = resolveExecutionModelProfile(settings, provider, activeRole, contextPressure);
  const rawTools = provider && !provider.capabilities.canUseTools
    ? []
    : getExecutionToolsForRole(activeRole, {
        compact: executionProfile.compactToolset,
        ultraCompact: executionProfile.ultraCompactToolset,
        content: request.content,
        conversation: executionConversation,
        customToolTrustMode: settings.customTools.trustMode,
        maxEffectiveTools: executionProfile.maxEffectiveTools,
      });
  const rawToolSnapshot = provider && !provider.capabilities.canUseTools
    ? new Map()
    : getExecutionToolSnapshotForRole(activeRole, {
        compact: executionProfile.compactToolset,
        content: request.content,
        conversation: executionConversation,
        customToolTrustMode: settings.customTools.trustMode,
      });
  const profileFilteredTools = options.parallelToolProfile
    ? applyParallelChildToolProfile(rawTools, options.parallelToolProfile)
    : rawTools;
  const profileFilteredSnapshot = options.parallelToolProfile
    ? applyParallelChildToolProfileToSnapshot(rawToolSnapshot, options.parallelToolProfile)
    : rawToolSnapshot;
  // When the user pins a specific role, remove the handoff tool so the LLM cannot route to another role.
  const tools = rolePinned ? profileFilteredTools.filter((t) => t.name !== "handoff") : profileFilteredTools;
  const toolSnapshot = rolePinned
    ? new Map([...profileFilteredSnapshot].filter(([name]) => name !== "handoff"))
    : profileFilteredSnapshot;
  const pinnedRoleSection = rolePinned ? buildPinnedRoleSection(activeRole) : "";
  const metacognitiveSection = executionProfile.includeAdvancedSections
    ? buildMetacognitivePromptSection(taskAssessment, cognitiveProfile, activeRole)
    : "";
  const attentionKey = deriveAttentionKey(request.conversationId ?? null, request.conversation, request.content);
  const attentionCtx = getOrCreateAttentionContext({
    key: attentionKey,
    primaryGoal: request.content,
    currentFocus: request.content,
    conversation: request.conversation,
  });
  const attentionSection = executionProfile.includeAdvancedSections
    ? buildAttentionPromptSection(attentionCtx)
    : "";
  const promptStack = buildRolePromptStack({
    settings,
    role: activeRole,
    tools,
    providers,
    assignmentMap,
    compactRolePrompt: executionProfile.compactRolePrompt,
    compactToolPrompt: executionProfile.compactToolPrompt,
    extraSharedSections: [
      buildDeliveryWorkflowPrompt(workflowState, activeRole),
      ...(pinnedRoleSection ? [pinnedRoleSection] : []),
      ...(simulationHint ? [simulationHint] : []),
      ...(metacognitiveSection ? [metacognitiveSection] : []),
      ...(attentionSection ? [attentionSection] : []),
    ],
  });
  const compactedRequest = compactChatRequest(requestWithSimulationContext, settings, promptStack, provider, tools);
  const modelDecision = provider
    ? await resolveExecutionModelDecision({
        role: activeRole,
        provider,
        preferredModelId: provider.id === assignment?.providerId ? assignment?.modelId ?? null : null,
        request: {
          content: request.content,
          conversation: executionConversation,
        },
        settings,
        providers,
        assignmentMap,
        secrets,
        workflowState,
        profileOverrides: providerOverrides,
      })
    : null;
  if (modelDecision) {
    options.requestLogger?.info("model.selected", {
      role: activeRole,
      modelId: modelDecision.modelId,
      source: modelDecision.source,
      confidence: modelDecision.confidence,
    });
  }
  const responseModelId =
    modelDecision?.modelId ??
    assignment?.modelId ??
    provider?.config.defaultModelId ??
    provider?.availableModels[0] ??
    null;
  const providerContextWindow = resolveProviderContextWindowTokens(provider, settings);
  const inheritedContextWindowTokens = options.inheritedContextWindowTokens != null
    ? Math.min(options.inheritedContextWindowTokens, providerContextWindow)
    : providerContextWindow;
  const routeNote = routeDecision
    ? `Auto routed to ${routeDecision.role} via ${formatRouteSource(routeDecision.source)}. ${routeDecision.reason}`
    : null;
  const autoSimulationNote = autoSimulationMessage ? "Auto simulation completed and injected into context." : null;

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
    toolSnapshot,
    assignment,
    provider,
    providerDecision,
    modelDecision,
    responseModelId,
    routeNote: [routeNote, autoSimulationNote].filter(Boolean).join(" ").trim() || null,
    handoffSourceRole: null,
    workflowState,
    taskAssessment,
    cognitiveProfile,
    browserSessionKey: terminalSessionKey,
    parallelDepth: options.parallelDepth ?? 0,
    parallelToolProfile: options.parallelToolProfile ?? null,
    inheritedContextWindowTokens,
    inheritedSubtaskTimeoutMs: options.inheritedSubtaskTimeoutMs ?? null,
    failoverAttempts: 0,
    rolePinned,
  };
}

function resolveExecutionGuard(context: ExecutionContext): never {
  const { provider, routeNote, providerDecision, modelDecision } = context;
  let executionNote = provider
    ? `Assigned provider ${provider.name} is not ready for live execution yet.`
    : "No provider is assigned to this role yet.";

  if (provider && !providerCanChat(provider)) {
    executionNote =
      "This provider can be connected and rechecked, but role execution is not wired for this connector type yet.";
  } else if (provider && provider.status !== "connected") {
    executionNote = `Assigned provider ${provider.name} is currently ${provider.status}. Recheck the connection before using live execution.`;
  }

  executionNote = [
    routeNote,
    buildProviderSelectionNote(provider, providerDecision),
    buildModelSelectionNote(modelDecision),
    executionNote,
  ]
    .filter(Boolean)
    .join(" ");

  throw createStatusError(409, executionNote);
}

function buildFailoverTargetKey(providerId: string | null, modelId: string | null): string {
  return `${providerId ?? "none"}::${modelId ?? "default"}`;
}

function appendFailoverRouteNote(existing: string | null, message: string): string {
  return `${existing ? `${existing} ` : ""}${message}`.trim();
}

function buildPinnedRoleSection(role: Role): string {
  return `You are pinned to the ${role} role by the user. Handoff is disabled — do all work yourself regardless of task complexity. The user chose to speak directly to you.`;
}

function markExecutionActivity(timestamp = Date.now()): void {
  lastExecutionActivityAt = timestamp;
}

async function maybeRunIdleMemoryConsolidation(
  request: ChatRequest,
  settings: Awaited<ReturnType<typeof readSettings>>,
  memoryRepository: MemoryRepository | null,
): Promise<void> {
  if (!memoryRepository || !settings.memory.enabled) {
    return;
  }

  const isNewConversation = request.conversation.length === 0 || !request.conversationId;
  if (!isNewConversation || lastExecutionActivityAt === null) {
    return;
  }

  const idleMs = Date.now() - lastExecutionActivityAt;
  if (idleMs < MEMORY_CONSOLIDATION_IDLE_THRESHOLD_MS) {
    return;
  }

  try {
    await consolidateMemories(memoryRepository, {
      maxAge: 30 * 24 * 60 * 60 * 1_000,
    });
  } catch (error) {
    console.warn(`[memory] auto consolidation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function maybeRunAutoSimulation(options: {
  enabled: boolean;
  role: ExecutionRole;
  mode: ChatMode;
  assessment: ReturnType<typeof assessTask>;
  settings: Awaited<ReturnType<typeof readSettings>>;
  providers: Awaited<ReturnType<typeof readProviders>>;
  secrets: Awaited<ReturnType<typeof readProviderSecrets>>;
}): Promise<ChatMessage | null> {
  if (!options.enabled || !shouldAutoSimulate(options.assessment) || !options.assessment.simulationConfig) {
    return null;
  }

  const simulationConfig = options.assessment.simulationConfig;
  try {
    const simulationState = createSim({
      title: `Auto simulation: ${summarizeText(simulationConfig.scenario, 64)}`,
      scenario: simulationConfig.scenario,
      personaCount: simulationConfig.personaCount,
      roundCount: simulationConfig.roundCount,
      modelTier: "small",
      synthesisModelTier: "medium",
      domain: simulationConfig.domain,
      providerModelPool: resolveSimulationPool(options.settings, []),
      compactMode: options.settings.simulation?.compactMode ?? true,
      contextData: [],
    });

    const completed = await runFullSimulationInternal(simulationState, {
      callLlm: (systemPrompt, userPrompt, tier, metadata) =>
        executeSwarmLlmCall(
          {
            providers: options.providers,
            secrets: options.secrets,
            settings: options.settings,
          },
          systemPrompt,
          userPrompt,
          tier,
          metadata,
        ),
      maxConcurrency: options.settings.simulation?.maxConcurrency ?? 4,
    });

    if (completed.status !== "completed" || !completed.finalSynthesis?.trim()) {
      return null;
    }

    return buildStrategySystemMessage(
      options.role,
      options.mode,
      `[AUTO SIMULATION CONTEXT]\n${completed.finalSynthesis}`,
    );
  } catch (error) {
    console.warn(`[simulation] auto simulation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function buildAllProvidersUnavailableMessage(context: ExecutionContext): string | null {
  const connectedProviders = context.providers.filter(
    (provider) => provider.status === "connected" && provider.capabilities.canChat,
  );
  if (connectedProviders.length === 0) {
    return null;
  }
  const unavailable = getUnavailableProviderIds(connectedProviders.map((provider) => provider.id));
  if (unavailable.length !== connectedProviders.length) {
    return null;
  }

  const lastErrors = connectedProviders
    .map((provider) => `${provider.name}: ${provider.lastError ?? "unknown error"}`)
    .join("; ");
  return `All configured providers are currently unavailable. Last errors: ${lastErrors}`;
}

async function recordTaskOutcomeForExecution(options: {
  memoryRepository: MemoryRepository | null;
  request: ChatRequest;
  context: ExecutionContext;
  result: ChatExecutionResult | null;
  toolObservations: MemoryToolObservation[];
  durationMs: number;
  failureReason?: string;
}): Promise<void> {
  if (!options.memoryRepository) {
    return;
  }

  const toolsUsed = [...new Set(options.toolObservations.map((observation) => observation.toolName))];
  const providerUsed =
    options.result?.providerId ??
    options.context.provider?.id ??
    "none";
  const modelUsed =
    options.result?.modelId ??
    options.context.responseModelId ??
    "default";
  const outcome: TaskOutcome = {
    taskDescription: options.request.content,
    approach: `${options.context.activeRole} role execution`,
    result: options.failureReason
      ? "failure"
      : (options.result?.messages.length ?? 0) > 0
        ? "success"
        : "partial",
    failureReason: options.failureReason,
    toolsUsed,
    providerUsed,
    modelUsed,
    duration: Math.max(0, Math.floor(options.durationMs)),
    timestamp: new Date().toISOString(),
  };

  try {
    await recordTaskOutcomeMemory(options.memoryRepository, outcome, {
      sessionId: options.request.conversationId ?? null,
      scope: "workspace",
    });
  } catch (error) {
    console.warn(`[memory] task outcome recording failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveFailoverContext(options: {
  context: ExecutionContext;
  conversation: ChatMessage[];
  content: string;
  errorMessage: string;
  failureCount: number;
  attemptedTargets: Set<string>;
}): ExecutionContext | null {
  const context = options.context;
  if (!FAILOVER_ENABLED || !context.provider) {
    return null;
  }
  if (context.activeRole === "dispatch") {
    return null;
  }
  if (options.failureCount < FAILOVER_FAILURE_THRESHOLD) {
    return null;
  }
  if (FAILOVER_MAX_SWITCHES_PER_TURN <= 0 || context.failoverAttempts >= FAILOVER_MAX_SWITCHES_PER_TURN) {
    return null;
  }

  const cause = classifyFailoverCause(options.errorMessage);
  const currentProvider = context.provider;
  const currentModelId = context.responseModelId ?? null;
  const request = {
    content: options.content,
    conversation: options.conversation,
  };

  const modelPolicy = resolveModelRoutePolicy({
    role: context.activeRole,
    provider: currentProvider,
    assignedModelId: currentProvider.id === context.assignment?.providerId ? context.assignment?.modelId ?? null : null,
    request,
  });
  const nextModel = isProviderAvailable(currentProvider.id)
    ? modelPolicy.candidates.find((candidate) =>
        (candidate.modelId ?? "").trim() &&
        candidate.modelId !== currentModelId &&
        !options.attemptedTargets.has(buildFailoverTargetKey(currentProvider.id, candidate.modelId)),
      )
    : null;
  if (nextModel) {
    const event = recordFailoverEvent({
      role: context.activeRole,
      fromProviderId: currentProvider.id,
      fromModelId: currentModelId,
      toProviderId: currentProvider.id,
      toModelId: nextModel.modelId,
      cause,
      reason: `Model failover after ${options.failureCount} consecutive failures on ${currentProvider.name}.`,
    });
    options.attemptedTargets.add(buildFailoverTargetKey(currentProvider.id, nextModel.modelId));
    const nextDecision: ExecutionModelDecision = {
      modelId: nextModel.modelId,
      source: "policy-fallback",
      confidence: Math.max(modelPolicy.decision.confidence, 0.7),
      reason: `${modelPolicy.decision.reason} Failover switched model after repeated execution failure.`,
    };
    return {
      ...context,
      modelDecision: nextDecision,
      responseModelId: nextModel.modelId,
      failoverAttempts: context.failoverAttempts + 1,
      routeNote: appendFailoverRouteNote(
        context.routeNote,
        `Failover event ${event.id}: model ${currentModelId ?? "default"} → ${nextModel.modelId} (${cause}).`,
      ),
    };
  }

  const providerCandidates = context.providers.filter((candidate) =>
    candidate.status === "connected" &&
    candidate.capabilities.canChat &&
    (!options.conversation.some((msg) => (msg.attachments ?? []).some((attachment) => attachment.kind === "image"))
      || candidate.capabilities.canUseImages),
  );
  const providerPolicy = resolveProviderRoutePolicy({
    role: context.activeRole,
    providers: providerCandidates,
    preferredProviderId: context.assignment?.providerId ?? null,
    request,
    settings: context.settings,
    requiresImages: options.conversation.some((msg) => (msg.attachments ?? []).some((attachment) => attachment.kind === "image")),
  });
  let nextProvider: Provider | null = null;
  let nextProviderModelPolicy: ReturnType<typeof resolveModelRoutePolicy> | null = null;
  let nextModelId: string | null = null;
  for (const providerCandidate of providerPolicy.candidates) {
    if (providerCandidate.providerId === currentProvider.id) {
      continue;
    }
    const candidateProvider =
      context.providers.find((candidate) => candidate.id === providerCandidate.providerId) ?? null;
    if (!candidateProvider) {
      continue;
    }
    const candidateModelPolicy = resolveModelRoutePolicy({
      role: context.activeRole,
      provider: candidateProvider,
      assignedModelId:
        candidateProvider.id === context.assignment?.providerId ? context.assignment?.modelId ?? null : null,
      request,
    });
    const candidateModelId =
      candidateModelPolicy.decision.modelId ??
      candidateProvider.config.defaultModelId ??
      candidateProvider.availableModels[0] ??
      null;
    if (options.attemptedTargets.has(buildFailoverTargetKey(candidateProvider.id, candidateModelId))) {
      continue;
    }
    nextProvider = candidateProvider;
    nextProviderModelPolicy = candidateModelPolicy;
    nextModelId = candidateModelId;
    break;
  }
  if (!nextProvider || !nextProviderModelPolicy) {
    return null;
  }

  const event = recordFailoverEvent({
    role: context.activeRole,
    fromProviderId: currentProvider.id,
    fromModelId: currentModelId,
    toProviderId: nextProvider.id,
    toModelId: nextModelId,
    cause,
    reason: `Provider failover after ${options.failureCount} consecutive failures on ${currentProvider.name}.`,
  });
  options.attemptedTargets.add(buildFailoverTargetKey(nextProvider.id, nextModelId));
  const nextProviderDecision: ExecutionProviderDecision = {
    providerId: nextProvider.id,
    source: "policy-fallback",
    confidence: Math.max(providerPolicy.decision.confidence, 0.7),
    reason: `${providerPolicy.decision.reason} Failover switched provider after repeated execution failure.`,
  };
  const nextModelDecision: ExecutionModelDecision = {
    modelId: nextModelId,
    source: "policy-fallback",
    confidence: Math.max(nextProviderModelPolicy.decision.confidence, 0.7),
    reason: `${nextProviderModelPolicy.decision.reason} Failover selected the next model lane.`,
  };
  const failoverPressure = (() => {
    const conversationTokens = estimateConversationTokens(options.conversation);
    const budget = deriveCompressionPromptBudget(
      context.settings.compression,
      resolveProviderContextWindowTokens(nextProvider, context.settings),
    );
    return budget.maxPromptTokens > 0 ? conversationTokens / budget.maxPromptTokens : 0;
  })();
  const failoverExecutionProfile = resolveExecutionModelProfile(
    context.settings,
    nextProvider,
    context.activeRole,
    failoverPressure,
  );
  const rawFailoverTools = nextProvider.capabilities.canUseTools
    ? getExecutionToolsForRole(context.activeRole, {
        compact: failoverExecutionProfile.compactToolset,
        ultraCompact: failoverExecutionProfile.ultraCompactToolset,
        content: options.content,
        conversation: options.conversation,
        customToolTrustMode: context.settings.customTools.trustMode,
      })
    : [];
  const rawFailoverToolSnapshot = nextProvider.capabilities.canUseTools
    ? getExecutionToolSnapshotForRole(context.activeRole, {
        compact: failoverExecutionProfile.compactToolset,
        content: options.content,
        conversation: options.conversation,
        customToolTrustMode: context.settings.customTools.trustMode,
      })
    : new Map();
  const profileFilteredTools = context.parallelToolProfile
    ? applyParallelChildToolProfile(rawFailoverTools, context.parallelToolProfile)
    : rawFailoverTools;
  const profileFilteredSnapshot = context.parallelToolProfile
    ? applyParallelChildToolProfileToSnapshot(rawFailoverToolSnapshot, context.parallelToolProfile)
    : rawFailoverToolSnapshot;
  const failoverTools = context.rolePinned
    ? profileFilteredTools.filter((tool) => tool.name !== "handoff")
    : profileFilteredTools;
  const failoverToolSnapshot = context.rolePinned
    ? new Map([...profileFilteredSnapshot].filter(([name]) => name !== "handoff"))
    : profileFilteredSnapshot;
  const pinnedRoleSection = context.rolePinned ? buildPinnedRoleSection(context.activeRole) : "";
  const failoverPromptStack = buildRolePromptStack({
    settings: context.settings,
    role: context.activeRole,
    tools: failoverTools,
    providers: context.providers,
    assignmentMap: context.assignmentMap,
    compactRolePrompt: failoverExecutionProfile.compactRolePrompt,
    compactToolPrompt: failoverExecutionProfile.compactToolPrompt,
    extraSharedSections: [
      buildDeliveryWorkflowPrompt(context.workflowState, context.activeRole),
      ...(pinnedRoleSection ? [pinnedRoleSection] : []),
    ],
  });
  const inheritedContextWindowTokens = context.inheritedContextWindowTokens != null
    ? Math.min(context.inheritedContextWindowTokens, resolveProviderContextWindowTokens(nextProvider, context.settings))
    : resolveProviderContextWindowTokens(nextProvider, context.settings);
  return {
    ...context,
    provider: nextProvider,
    providerDecision: nextProviderDecision,
    modelDecision: nextModelDecision,
    responseModelId: nextModelId,
    promptStack: failoverPromptStack,
    tools: failoverTools,
    toolSnapshot: failoverToolSnapshot,
    failoverAttempts: context.failoverAttempts + 1,
    inheritedContextWindowTokens,
    routeNote: appendFailoverRouteNote(
      context.routeNote,
      `Failover event ${event.id}: provider ${currentProvider.name} → ${nextProvider.name} (${cause}).`,
    ),
  };
}

function buildParallelSubtaskContent(options: {
  parentRequest: ChatRequest;
  parentContext: ExecutionContext;
  currentContent: string;
  title: string;
  task: string;
  inheritedContextWindowTokens: number | null;
  inheritedTimeoutMs: number;
}): string {
  const sections = [
    `PARENT GOAL: ${options.parentRequest.content}`,
    `REQUESTED BY ROLE: ${options.parentContext.activeRole}`,
    `INHERITED TOKEN WINDOW: ${options.inheritedContextWindowTokens ?? "default"}`,
    `INHERITED TIME BUDGET (ms): ${options.inheritedTimeoutMs}`,
  ];

  const normalizedCurrent = options.currentContent.trim();
  if (normalizedCurrent && normalizedCurrent !== options.parentRequest.content.trim()) {
    sections.push(`CURRENT WORKING CONTEXT: ${normalizedCurrent}`);
  }

  sections.push(`SUBTASK TITLE: ${options.title}`);
  sections.push(`SUBTASK: ${options.task}`);
  sections.push(
    "Complete only this subtask. Use tools if needed and return the concrete result to the calling agent.",
  );

  return sections.join("\n\n");
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

async function runParallelTasks(options: {
  parentRequest: ChatRequest;
  parentContext: ExecutionContext;
  currentContent: string;
  input: Record<string, unknown>;
}): Promise<import("@ember/core").ToolResult> {
  if (parallelTaskPolicy.maxDepth <= 0) {
    return "Parallel task execution is disabled by policy.";
  }
  if (options.parentContext.parallelDepth >= parallelTaskPolicy.maxDepth) {
    return `Parallel task execution is limited to depth ${parallelTaskPolicy.maxDepth}.`;
  }

  const parsed = parseParallelTaskRequest(
    options.input,
    options.parentContext.activeRole,
    { maxTasks: parallelTaskPolicy.maxTasks },
  );
  if (parsed.error) {
    return parsed.error;
  }

  const requestedConcurrency = clampInteger(
    options.input.max_concurrency,
    parallelTaskPolicy.maxConcurrency,
    1,
    parallelTaskPolicy.maxConcurrency,
  );
  const inheritedContextWindowTokens = options.parentContext.inheritedContextWindowTokens
    ?? resolveProviderContextWindowTokens(options.parentContext.provider, options.parentContext.settings);
  const inheritedTimeoutMs = clampInteger(
    options.parentContext.inheritedSubtaskTimeoutMs,
    parallelTaskPolicy.defaultTimeoutMs,
    parallelTaskPolicy.minTimeoutMs,
    parallelTaskPolicy.maxTimeoutMs,
  );
  const requestedTimeoutMs = clampInteger(
    options.input.timeout_ms,
    inheritedTimeoutMs,
    parallelTaskPolicy.minTimeoutMs,
    inheritedTimeoutMs,
  );
  const outcomes = await executeParallelSubtasks({
    tasks: parsed.tasks.map((task) => ({
      title: task.title,
      instruction: task.task,
      role: task.role,
      profile: task.profile,
    })),
    concurrency: requestedConcurrency,
    timeoutMs: requestedTimeoutMs,
    executeTask: async (task) => {
      const traceId = `ptask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const nestedMode: ChatMode =
        task.role === "auto" || task.role === "dispatch" ? "auto" : task.role;
      const nestedRequest: ChatRequest = {
        mode: nestedMode,
        content: buildParallelSubtaskContent({
          parentRequest: options.parentRequest,
          parentContext: options.parentContext,
          currentContent: options.currentContent,
          title: task.title,
          task: task.instruction,
          inheritedContextWindowTokens,
          inheritedTimeoutMs: requestedTimeoutMs,
        }),
        conversation: [],
      };

      const built = await buildExecution(nestedRequest, {
        parallelDepth: options.parentContext.parallelDepth + 1,
        parallelToolProfile: task.profile,
        inheritedContextWindowTokens,
        inheritedSubtaskTimeoutMs: requestedTimeoutMs,
      });
      try {
        const lastMessage = built.result.messages.at(-1) ?? null;
        const content = lastMessage?.content?.trim() || "Subtask finished without a visible result.";
        const usage = lastMessage?.usage;
        const tokensUsed = usage ? Math.max(0, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) : 0;
        return {
          traceId,
          title: task.title,
          profile: task.profile,
          requestedRole: task.role,
          activeRole: built.result.activeRole ?? (lastMessage?.authorRole as Role | null) ?? null,
          providerName: built.result.providerName ?? lastMessage?.providerName ?? null,
          modelId: built.result.modelId ?? lastMessage?.modelId ?? null,
          output: content,
          error: null,
          tokensUsed,
        };
      } finally {
        await built.context.memoryRepository?.close?.();
      }
    },
    onTaskEnd: (result) => {
      recordParallelTaskTrace({
        traceId: result.traceId,
        parentRole: options.parentContext.activeRole,
        parentDepth: options.parentContext.parallelDepth,
        profile: result.profile,
        requestedRole: result.requestedRole,
        activeRole: result.activeRole,
        providerName: result.providerName,
        modelId: result.modelId,
        title: result.title,
        status: result.status === "completed" ? "ok" : "error",
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        durationMs: result.durationMs,
        error: result.error,
      });
    },
  });

  return formatParallelResults(outcomes);
}

function buildToolCallFromObservation(observation: MemoryToolObservation): ToolCall {
  const resultText = observation.resultText?.trim() ?? "";
  const status: ToolCall["status"] = /^error\b/i.test(resultText) ? "error" : "complete";
  return {
    id: createId("tool"),
    name: observation.toolName,
    arguments: observation.input,
    result: observation.resultText,
    status,
    startedAt: observation.createdAt,
    endedAt: observation.createdAt,
  };
}

function applyMetacognitiveMonitorUpdate(
  state: ReturnType<typeof createExecutionMonitor>,
  observation: MemoryToolObservation,
  assessment: ReturnType<typeof assessTask>,
): {
  nextState: ReturnType<typeof createExecutionMonitor>;
  injectionText: string | null;
  shouldEscalateModel: boolean;
} {
  const updatedState = updateExecutionMonitor(state, buildToolCallFromObservation(observation));
  const adjustment = suggestStrategyAdjustment(updatedState, assessment);
  if (!adjustment) {
    return {
      nextState: updatedState,
      injectionText: null,
      shouldEscalateModel: false,
    };
  }

  const adjustmentTag = `${adjustment.action}:${adjustment.reason}`;
  if (updatedState.strategyAdjustments.includes(adjustmentTag)) {
    return {
      nextState: updatedState,
      injectionText: null,
      shouldEscalateModel: false,
    };
  }

  const shouldEscalateModel = adjustment.action === "escalate-model" && !updatedState.escalated;
  const nextState: ReturnType<typeof createExecutionMonitor> = {
    ...updatedState,
    escalated: updatedState.escalated || shouldEscalateModel,
    strategyAdjustments: [...updatedState.strategyAdjustments, adjustmentTag],
  };

  return {
    nextState,
    injectionText: buildStrategyInjection(adjustment),
    shouldEscalateModel,
  };
}

function buildStrategySystemMessage(
  role: Role,
  mode: ChatMode,
  content: string,
): ChatMessage {
  return {
    id: createId("msg"),
    role: "system",
    authorRole: role,
    mode,
    content,
    createdAt: new Date().toISOString(),
  };
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
  options: {
    parallelDepth?: number;
    parallelToolProfile?: ParallelTaskToolProfile | null;
    inheritedContextWindowTokens?: number | null;
    inheritedSubtaskTimeoutMs?: number | null;
    requestLogger?: RequestLogger | null;
  } = {},
): Promise<BuiltExecution> {
  const executionStartedAt = Date.now();
  const context = await prepareExecution(request, options);
  options.requestLogger?.info("execution.context", {
    mode: context.mode,
    activeRole: context.activeRole,
    routedRole: context.routedTo,
    routeSource: context.routeDecision?.source ?? null,
    providerId: context.provider?.id ?? null,
    providerName: context.provider?.name ?? null,
    providerRouteSource: context.providerDecision?.source ?? null,
    modelId: context.responseModelId,
    modelRouteSource: context.modelDecision?.source ?? null,
    parallelDepth: options.parallelDepth ?? 0,
  });
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
    const workflowReminderCounts = new Map<string, number>();
    const providerFailureCounts = new Map<string, number>();
    const attemptedFailoverTargets = new Set<string>();
    let currentCtx = context;
    let currentConversation = compactedRequest.conversation;
    let currentContent = compactedRequest.content;
    let monitorState = createExecutionMonitor(currentCtx.taskAssessment);
    let pendingStrategyInjection: string | null = null;
    let pendingModelEscalation = false;
    if (currentCtx.provider) {
      attemptedFailoverTargets.add(
        buildFailoverTargetKey(currentCtx.provider.id, currentCtx.responseModelId ?? null),
      );
    }

    // Frozen memory snapshots: load once before the loop to preserve prompt cache
    // across tool-loop iterations. Live reads still happen via memory_save/memory_search tools.
    const frozenMemoryContext = await buildPersistentMemoryContext(
      currentCtx,
      currentConversation,
      currentContent,
      request.conversationId ?? null,
    );
    const frozenProcedureContext = await buildProcedureMemoryContext(
      currentCtx,
      currentConversation,
      currentContent,
      request.conversationId ?? null,
    );

    for (let iteration = 0; iteration < MAX_AGENT_LOOP; iteration++) {
      const iterProvider = currentCtx.provider;
      if (!iterProvider || iterProvider.status !== "connected" || !providerCanChat(iterProvider)) {
        if (iteration === 0) resolveExecutionGuard(currentCtx);
        console.warn(`[loop] no usable provider for ${currentCtx.activeRole}, stopping`);
        break;
      }
      const iterContextWindow = currentCtx.inheritedContextWindowTokens != null
        ? Math.min(
            currentCtx.inheritedContextWindowTokens,
            resolveProviderContextWindowTokens(iterProvider, currentCtx.settings),
          )
        : resolveProviderContextWindowTokens(iterProvider, currentCtx.settings);

      const memoryContext = frozenMemoryContext;
      const procedureContext = frozenProcedureContext;
      const handler = createToolHandler({
        activeRole: currentCtx.activeRole,
        workflowState: currentCtx.workflowState,
        browserSessionKey: currentCtx.browserSessionKey,
        toolSnapshot: currentCtx.toolSnapshot,
        parallelDepth: currentCtx.parallelDepth,
        contextWindowTokens: iterContextWindow,
        rolePinned: currentCtx.rolePinned,
        customToolTrustMode: currentCtx.settings.customTools.trustMode,
        onParallelTasks: (input) =>
          runParallelTasks({
            parentRequest: request,
            parentContext: currentCtx,
            currentContent,
            input,
          }),
        onToolResult(observation) {
          toolObservations.push(observation);
          const monitorUpdate = applyMetacognitiveMonitorUpdate(
            monitorState,
            observation,
            currentCtx.taskAssessment,
          );
          monitorState = monitorUpdate.nextState;
          if (monitorUpdate.injectionText) {
            pendingStrategyInjection = monitorUpdate.injectionText;
          }
          if (monitorUpdate.shouldEscalateModel) {
            pendingModelEscalation = true;
          }
        },
      });
      const onToolCallWithLogging = async (
        name: string,
        input: Record<string, unknown>,
      ): Promise<import("@ember/core").ToolResult> => {
        options.requestLogger?.info("tool.call", {
          role: currentCtx.activeRole,
          providerId: iterProvider.id,
          modelId: currentCtx.responseModelId,
          toolName: name,
          toolInputKeys: Object.keys(input).slice(0, 12),
        });
        const result = await handler.onToolCall(name, input);
        options.requestLogger?.info("tool.result", {
          role: currentCtx.activeRole,
          providerId: iterProvider.id,
          modelId: currentCtx.responseModelId,
          toolName: name,
          preview: summarizeToolResult(result),
        });
        return result;
      };
      const compactedConversation = compactConversationForContext(
        currentConversation,
        currentContent,
        currentCtx.settings,
        currentCtx.promptStack,
        iterProvider,
        currentCtx.tools,
        estimatePromptExtraTokens({
          memoryContextText: memoryContext?.text ?? null,
          procedureContextText: procedureContext?.text ?? null,
        }),
      ).messages;
      let iterContent: string;
      let iterThinking: string | null;
      let iterModelId: string | null;
      let iterUsage: TokenUsage | null = null;

      try {
        const iterExecution = await executeProviderChat(iterProvider, currentCtx.secrets, {
          modelId: currentCtx.responseModelId,
          promptStack: currentCtx.promptStack,
          toolLoopLimit: currentCtx.settings.compression.toolLoopLimit,
          contextWindowTokens: iterContextWindow,
          memoryContext,
          procedureContext,
          role: currentCtx.activeRole,
          conversation: compactedConversation,
          content: currentContent,
          tools: currentCtx.tools,
          onToolCall: onToolCallWithLogging,
        });
        iterContent = iterExecution.content;
        iterThinking = iterExecution.thinking ?? null;
        iterModelId = iterExecution.modelId;
        iterUsage = iterExecution.usage ?? null;
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
        recordProviderSuccess(iterProvider.id);
        providerFailureCounts.set(
          `${currentCtx.activeRole}:${buildFailoverTargetKey(iterProvider.id, currentCtx.responseModelId ?? null)}`,
          0,
        );
      } catch (error) {
        recordProviderFailure(iterProvider.id);
        const failureKey = `${currentCtx.activeRole}:${buildFailoverTargetKey(
          iterProvider.id,
          currentCtx.responseModelId ?? null,
        )}`;
        const failureCount = (providerFailureCounts.get(failureKey) ?? 0) + 1;
        providerFailureCounts.set(failureKey, failureCount);
        if (FAILOVER_ENABLED && failureCount < FAILOVER_FAILURE_THRESHOLD) {
          console.warn(
            `[loop] ${currentCtx.activeRole} transient failure (${failureCount}/${FAILOVER_FAILURE_THRESHOLD}), retrying same lane`,
          );
          continue;
        }
        const failoverCtx = resolveFailoverContext({
          context: currentCtx,
          conversation: currentConversation,
          content: currentContent,
          errorMessage: error instanceof Error ? error.message : String(error),
          failureCount,
          attemptedTargets: attemptedFailoverTargets,
        });
        if (failoverCtx) {
          console.warn(
            `[loop] failover applied for ${currentCtx.activeRole}: ${iterProvider.name} -> ${failoverCtx.provider?.name ?? "none"}`,
          );
          currentCtx = failoverCtx;
          continue;
        }
        const note = [
          currentCtx.routeNote,
          buildProviderSelectionNote(currentCtx.provider, currentCtx.providerDecision),
          buildModelSelectionNote(currentCtx.modelDecision),
          buildAllProvidersUnavailableMessage(currentCtx),
          `Live provider execution failed: ${error instanceof Error ? error.message : "Unknown error."}`,
        ]
          .filter(Boolean)
          .join(" ");
        if (iteration === 0) throw createStatusError(502, note);
        console.warn(`[loop] ${currentCtx.activeRole} failed: ${note}`);
        break;
      }

      const iterNote = [
        currentCtx.routeNote,
        buildProviderSelectionNote(currentCtx.provider, currentCtx.providerDecision),
        buildModelSelectionNote(currentCtx.modelDecision),
        `Live response via ${iterProvider.name}.`,
      ]
        .filter(Boolean)
        .join(" ");
      const iterMsg = buildReplyMessage(currentCtx, request, iterContent, iterThinking, iterModelId, iterNote, iterUsage);
      messages.push(iterMsg);
      options.requestLogger?.info("provider.response", {
        role: currentCtx.activeRole,
        providerId: iterProvider.id,
        modelId: iterModelId ?? currentCtx.responseModelId,
        iteration,
      });

      const handoff = currentCtx.rolePinned ? null : handler.getPendingHandoff();
      if (!handoff && pendingStrategyInjection) {
        const strategyMessage = buildStrategySystemMessage(
          currentCtx.activeRole,
          currentCtx.mode,
          pendingStrategyInjection,
        );
        currentConversation = [...compactedConversation, iterMsg, strategyMessage];
        currentContent = "Continue this task with the updated strategy. Avoid repeating failed steps.";
        if (pendingModelEscalation) {
          currentCtx = await buildHandoffContext(
            currentCtx,
            currentCtx.activeRole as ExecutionRole,
            currentContent,
            currentConversation,
            currentCtx.workflowState,
            {
              forceEscalation: true,
              routeNote: appendFailoverRouteNote(
                currentCtx.routeNote,
                "Metacognitive escalation requested a stronger model lane.",
              ),
            },
          );
          if (currentCtx.provider) {
            attemptedFailoverTargets.add(
              buildFailoverTargetKey(currentCtx.provider.id, currentCtx.responseModelId ?? null),
            );
          }
        } else {
          currentCtx = {
            ...currentCtx,
            routeNote: appendFailoverRouteNote(
              currentCtx.routeNote,
              "Metacognitive strategy adjustment injected for the next turn.",
            ),
          };
        }
        monitorState = createExecutionMonitor(currentCtx.taskAssessment);
        pendingStrategyInjection = null;
        pendingModelEscalation = false;
        continue;
      }
      if (!handoff) {
        const reminder = currentCtx.rolePinned ? null : buildDeliveryWorkflowReminder(currentCtx.workflowState, currentCtx.activeRole);
        if (reminder) {
          const reminderCount = (workflowReminderCounts.get(currentCtx.activeRole) ?? 0) + 1;
          if (reminderCount <= 1) {
            workflowReminderCounts.set(currentCtx.activeRole, reminderCount);
            currentConversation = [...compactedConversation, iterMsg];
            currentContent = reminder;
            currentCtx = {
              ...currentCtx,
              routeNote: `${currentCtx.routeNote ? `${currentCtx.routeNote} ` : ""}Delivery workflow requires a specialist handoff.`,
            };
            continue;
          }
        }
        break;
      }

      const visits = (visitCounts.get(handoff.role) ?? 0) + 1;
      if (visits > MAX_ROLE_VISITS) {
        console.warn(`[loop] ${handoff.role} hit visit limit (${MAX_ROLE_VISITS}), stopping`);
        break;
      }
      visitCounts.set(handoff.role, visits);
      console.log(`[loop] ${currentCtx.activeRole} → handoff: ${handoff.role} (visit ${visits})`);

      // Update attention context after role completes work
      const attKey = deriveAttentionKey(currentCtx.compactedRequest.conversationId ?? null, compactedConversation, currentContent);
      recordRoleAttentionUpdate({
        key: attKey,
        role: currentCtx.activeRole,
        response: iterMsg.content ?? "",
        handoffMessage: handoff.message,
      });

      currentConversation = [...compactedConversation, iterMsg];
      currentContent = handoff.message;
      currentCtx = await buildHandoffContext(
        currentCtx,
        handoff.role as ExecutionRole,
        handoff.message,
        currentConversation,
        handoff.workflowState,
      );
      monitorState = createExecutionMonitor(currentCtx.taskAssessment);
      pendingStrategyInjection = null;
      pendingModelEscalation = false;
      if (currentCtx.provider) {
        attemptedFailoverTargets.add(
          buildFailoverTargetKey(currentCtx.provider.id, currentCtx.responseModelId ?? null),
        );
      }
    }

    const lastMessage = messages.at(-1)!;
    const result: ChatExecutionResult = {
      messages,
      activeRole: (lastMessage.authorRole as Role) ?? context.activeRole,
      providerId: lastMessage.providerId ?? provider.id,
      providerName: lastMessage.providerName ?? provider.name,
      modelId: lastMessage.modelId ?? context.responseModelId,
      promptStack: context.promptStack,
      routedTo: context.routedTo,
      conversationId: request.conversationId ?? null,
    };
    await recordTaskOutcomeForExecution({
      memoryRepository: context.memoryRepository,
      request,
      context,
      result,
      toolObservations,
      durationMs: Date.now() - executionStartedAt,
    });

    return {
      context,
      result,
      toolObservations,
    };
  } catch (error) {
    options.requestLogger?.error("execution.failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    await recordTaskOutcomeForExecution({
      memoryRepository: context.memoryRepository,
      request,
      context,
      result: null,
      toolObservations: [],
      durationMs: Date.now() - executionStartedAt,
      failureReason: error instanceof Error ? error.message : String(error),
    });
    await context.memoryRepository?.close?.();
    throw error;
  }
}

const app = Fastify({
  bodyLimit: 24 * 1024 * 1024,
  logger: false,
  genReqId: () => randomUUID(),
});
const apiAuthConfig = resolveApiAuthConfig();
assertAuthConfigIsSafe(apiAuthConfig);
const corsOrigins = parseCorsOrigins();
const rateLimiter = new MemoryRateLimiter();
const idempotencyConfig = resolveIdempotencyConfig();
const idempotencyStore = new MemoryIdempotencyStore(idempotencyConfig);
void idempotencyStore.restore().then((count) => {
  if (count > 0) {
    console.log(`[idempotency] Restored ${count} entries from disk.`);
  }
});
const hstsEnabled = process.env.EMBER_ENABLE_HSTS === "1";
const runtimeMcpInstallEnabled = isRuntimeMcpInstallEnabled();

type RequestIdempotencyState = {
  key: string;
  fingerprint: string;
};

type FastifyRequestWithIdempotency = FastifyRequest & {
  __emberIdempotency?: RequestIdempotencyState;
  __emberRequestLogger?: RequestLogger;
  __emberStartedAtMs?: number;
  __emberRequestClosed?: boolean;
};

const systemLogger = createRequestLogger("system");
let inFlightRequestCount = 0;

function getRequestLogger(request: FastifyRequest): RequestLogger {
  const candidate = (request as FastifyRequestWithIdempotency).__emberRequestLogger;
  return candidate ?? createRequestLogger(request.id);
}

function summarizeToolResult(result: import("@ember/core").ToolResult): string {
  const text = typeof result === "string" ? result : result.text;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty result)";
  }
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
}

function markRequestClosed(request: FastifyRequest): void {
  const tracked = request as FastifyRequestWithIdempotency;
  if (tracked.__emberRequestClosed) {
    return;
  }
  tracked.__emberRequestClosed = true;
  inFlightRequestCount = Math.max(0, inFlightRequestCount - 1);
}

function logAudit(
  request: FastifyRequest,
  action: string,
  status: "ok" | "denied" | "error",
  details?: Record<string, unknown>,
): void {
  const requestLogger = getRequestLogger(request);
  void writeAuditEvent(buildRequestAuditEvent(request, action, status, details)).catch((error) => {
    requestLogger.warn("audit.write_failed", {
      action,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

setCircuitBreakerEventSink((event) => {
  void writeAuditEvent({
    action: "failover.circuit",
    method: "SYSTEM",
    path: "/system/failover/circuit",
    ip: "127.0.0.1",
    requestId: "system",
    status: "ok",
    details: { ...event },
  }).catch((error) => {
    systemLogger.warn("audit.write_failed", {
      action: "failover.circuit",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

app.addHook("onRequest", async (request, reply) => {
  const requestLogger = createRequestLogger(request.id);
  const tracked = request as FastifyRequestWithIdempotency;
  tracked.__emberRequestLogger = requestLogger;
  tracked.__emberStartedAtMs = Date.now();
  inFlightRequestCount += 1;

  reply.header("x-request-id", request.id);
  const pathname = request.url.split("?")[0] ?? request.url;
  if (pathname.startsWith("/api/")) {
    requestLogger.info("request.received", {
      method: request.method,
      path: pathname,
      ip: request.ip,
    });
  }
});

app.addHook("onResponse", async (request, reply) => {
  markRequestClosed(request);
  const requestLogger = getRequestLogger(request);
  const startedAt = (request as FastifyRequestWithIdempotency).__emberStartedAtMs ?? Date.now();
  const pathname = request.url.split("?")[0] ?? request.url;
  if (pathname.startsWith("/api/")) {
    requestLogger.info("response.sent", {
      method: request.method,
      path: pathname,
      statusCode: reply.statusCode,
      durationMs: Math.max(0, Date.now() - startedAt),
      inFlightRequests: inFlightRequestCount,
    });
  }
});

app.setErrorHandler((error, request, reply) => {
  const requestLogger = getRequestLogger(request);
  const statusCode = Number((error as { statusCode?: unknown }).statusCode ?? 500);
  if (statusCode >= 400 && statusCode < 500) {
    requestLogger.warn("request.error", {
      method: request.method,
      path: request.url.split("?")[0] ?? request.url,
      statusCode,
      message: error instanceof Error ? error.message : String(error),
    });
    reply.code(statusCode);
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }

  requestLogger.error("request.error", {
    method: request.method,
    path: request.url.split("?")[0] ?? request.url,
    statusCode,
    message: error instanceof Error ? error.message : String(error),
  });
  reply.code(500);
  return {
    error: "Internal server error.",
  };
});

function normalizeIdempotencyResponsePayload(payload: unknown): unknown {
  if (Buffer.isBuffer(payload)) {
    const text = payload.toString("utf8").trim();
    if (!text) {
      return "";
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return payload;
    }
  }
  return payload;
}

app.addHook("onSend", async (request, reply, payload) => {
  reply.header("x-frame-options", "DENY");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-xss-protection", "0");
  reply.header("referrer-policy", "no-referrer");
  reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (hstsEnabled) {
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  const idempotency = (request as FastifyRequestWithIdempotency).__emberIdempotency;
  if (idempotency) {
    idempotencyStore.complete({
      key: idempotency.key,
      fingerprint: idempotency.fingerprint,
      statusCode: reply.statusCode,
      body: normalizeIdempotencyResponsePayload(payload),
    });
  }

  return payload;
});

app.addHook("preHandler", async (request, reply) => {
  const pathname = request.url.split("?")[0] ?? request.url;
  if (!pathname.startsWith("/api/")) {
    return;
  }
  if (pathname === "/api/health") {
    return;
  }
  if (shuttingDown) {
    reply.code(503);
    return reply.send({ error: "Server is shutting down. Try again shortly." });
  }
  const requestLogger = getRequestLogger(request);

  const auth = authorizeApiRequest(request, apiAuthConfig);
  if (!auth.ok) {
    requestLogger.warn("request.denied", {
      method: request.method,
      path: pathname,
      reason: auth.message,
      statusCode: auth.statusCode,
    });
    reply.code(auth.statusCode);
    return reply.send({ error: auth.message });
  }

  const rateLimit = resolveRateLimitConfig(pathname, request.method);
  if (rateLimit) {
    const rateKey = `${request.ip}:${request.method}:${pathname}`;
    if (!rateLimiter.check(rateKey, rateLimit)) {
      requestLogger.warn("request.denied", {
        method: request.method,
        path: pathname,
        reason: "rate-limit",
        statusCode: 429,
      });
      reply.code(429);
      return reply.send({ error: "Rate limit exceeded. Try again shortly." });
    }
  }

  const originValidation = validateMutationOrigin(request, corsOrigins);
  if (!originValidation.ok) {
    requestLogger.warn("request.denied", {
      method: request.method,
      path: pathname,
      reason: originValidation.message,
      statusCode: 403,
    });
    reply.code(403);
    return reply.send({ error: originValidation.message });
  }

  const routePath = request.routeOptions.url ?? pathname;
  const bodyValidationError = validateRequestBodyShape(
    routePath,
    request.method,
    request.body,
  );
  if (bodyValidationError) {
    requestLogger.warn("request.denied", {
      method: request.method,
      path: pathname,
      reason: bodyValidationError,
      statusCode: 400,
    });
    reply.code(400);
    return reply.send({ error: bodyValidationError });
  }

  if (idempotencyConfig.enabled && shouldApplyIdempotency(pathname, request.method)) {
    const idempotencyKey = normalizeIdempotencyKey(request.headers["idempotency-key"]);
    if (idempotencyKey) {
      const fingerprint = buildIdempotencyFingerprint({
        method: request.method,
        pathname,
        body: request.body,
      });
      const decision = idempotencyStore.begin({
        key: idempotencyKey,
        fingerprint,
      });
      if (decision.kind === "replay") {
        reply.header("x-idempotent-replay", "1");
        reply.code(decision.statusCode);
        return reply.send(decision.body);
      }
      if (decision.kind === "in-flight" || decision.kind === "mismatch") {
        requestLogger.warn("request.denied", {
          method: request.method,
          path: pathname,
          reason: decision.message,
          statusCode: 409,
        });
        reply.code(409);
        return reply.send({ error: decision.message });
      }

      (request as FastifyRequestWithIdempotency).__emberIdempotency = {
        key: idempotencyKey,
        fingerprint,
      };
    }
  }
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
    const args = server.args ?? [];
    const pkgArg = args.find((a) => !a.startsWith("-"));
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
      const cliArgs = args.filter((a) => a !== "-y" && a !== "--yes" && a !== pkgArg);
      cfg.mcpServers[name] = {
        ...server,
        command: process.execPath, // node
        args: [cliPath, ...cliArgs],
      };
      console.log(`[mcp] resolved "${name}" to local CLI: ${cliPath}`);
    } else if (sourcePath) {
      const cliArgs = args.filter((a) => a !== "-y" && a !== "--yes" && a !== pkgArg);
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

const workspaceDir = process.cwd();
const defaultMcpConfig = loadDefaultMcpConfig();

// Start MCP servers and register their tools into the Ember tool registry.
// Failure of individual servers is isolated — the main process continues.
const mcpManager = new McpClientManager({
  defaultConfig: defaultMcpConfig,
  workspaceDir,
});

async function reloadMcpRuntime(): Promise<void> {
  replaceMcpTools(await mcpManager.reload());
}

function buildMcpApiState() {
  const configState = readResolvedMcpConfigState({
    defaultConfig: defaultMcpConfig,
    workspaceDir,
  });
  const servers = mcpManager.getServerStatus();
  const runtimeStats = mcpManager.getRuntimeStats();

  return {
    layers: configState.layers.map((layer) => ({
      scope: layer.scope,
      path: layer.path,
      exists: layer.exists,
      serverCount: Object.keys(layer.config?.mcpServers ?? {}).length,
    })),
    items: servers.map((server) => ({
      ...server,
      config: redactMcpServerConfig(server.config),
      target: describeMcpServerTransport(server.config),
      capabilities: server.capabilities,
    })),
    merged: configState.servers.map((entry) => ({
      name: entry.name,
      sourceScope: entry.sourceScope,
      config: redactMcpServerConfig(entry.config),
      target: describeMcpServerTransport(entry.config),
    })),
    stats: {
      configuredServers: configState.servers.length,
      runningServers: servers.filter((server) => server.status === "running").length,
      drainingServers: runtimeStats.drainingServers,
      activeTools: servers.reduce((total, server) => total + server.toolNames.length, 0),
      activeCalls: runtimeStats.activeCalls,
      totalResources: runtimeStats.totalResources,
      totalResourceTemplates: runtimeStats.totalResourceTemplates,
      totalPrompts: runtimeStats.totalPrompts,
    },
  };
}

await mcpManager.start();
registerMcpTools(mcpManager.getTools());

// Wire the mcp_install tool to the server's install + reload flow.
setMcpInstallContext({
  installServer: async (options) => {
    if (!runtimeMcpInstallEnabled) {
      throw new Error("Runtime MCP install is disabled by policy.");
    }
    const config = buildInstalledMcpServer({
      packageName: options.packageName,
      roles: sanitizeMcpRoleList(options.roles) as Role[],
      args: options.args,
      env: options.env ? sanitizeMcpStringRecord(options.env) : undefined,
      timeout: options.timeout,
    });
    const scope = options.scope ?? "user";
    const serverName = options.serverName
      ?? derivePublicMcpServerName(options.packageName);

    await upsertMcpServer({
      scope,
      workspaceDir,
      name: serverName,
      config,
    });
    await reloadMcpRuntime();

    const state = buildMcpApiState();
    return {
      serverCount: state.stats.runningServers,
      toolCount: state.stats.activeTools,
    };
  },
});

// Wire the create_tool tool to the registry's register/unregister flow.
setToolMakerContext({
  registerCustomTool: (tool, roles) => {
    const validRoles = sanitizeMcpRoleList(roles) as Role[];
    registerMcpTools([{ tool, roles: validRoles }]);
  },
  unregisterCustomTool: (name) => {
    // Remove from MCP registry and rebuild
    replaceMcpTools(mcpManager.getTools());
  },
  workspaceDir,
});

// Wire the swarm simulation tools to use the server's LLM execution infrastructure.
// Distributes calls across the simulation provider pool with fixed deployment slots.
const swarmPoolCounters = new Map<string, number>(); // simulationId+tier -> next slot

type SwarmLlmMetadata = {
  simulationId?: string;
  phase?: "persona-generation" | "persona" | "synthesis";
  slotId?: string;
  providerIdHint?: string;
  modelIdHint?: string;
};

function resolveSwarmTierUsage(
  tier: "small" | "medium" | "large",
  metadata?: SwarmLlmMetadata,
): "persona" | "synthesis" {
  if (metadata?.phase === "persona" || metadata?.phase === "persona-generation") return "persona";
  if (metadata?.phase === "synthesis") return "synthesis";
  return tier === "large" || tier === "medium" ? "synthesis" : "persona";
}

function chooseSwarmProvider(
  providers: Awaited<ReturnType<typeof readProviders>>,
  pool: NonNullable<Awaited<ReturnType<typeof readSettings>>["simulation"]>["providerModelPool"] | undefined,
  tier: "small" | "medium" | "large",
  metadata?: SwarmLlmMetadata,
): { provider: Awaited<ReturnType<typeof readProviders>>[number] | null; modelId: string | null } {
  const connectedProviders = providers.filter(
    (p) => providerCanChat(p) && p.status === "connected" && isProviderAvailable(p.id),
  );
  const anyChatProvider = connectedProviders[0] ?? null;
  if (!anyChatProvider) return { provider: null, modelId: null };

  // Persona slots can carry fixed provider/model hints from deployment assignment.
  if (metadata?.providerIdHint) {
    const hinted = providers.find(
      (p) =>
        p.id === metadata.providerIdHint &&
        providerCanChat(p) &&
        p.status === "connected" &&
        isProviderAvailable(p.id),
    );
    if (hinted) {
      return {
        provider: hinted,
        modelId: metadata.modelIdHint?.trim() || null,
      };
    }
  }

  const normalizedPool = normalizeProviderModelPool(pool ?? []);
  if (normalizedPool.length === 0) {
    return { provider: anyChatProvider, modelId: null };
  }

  const tierUsage = resolveSwarmTierUsage(tier, metadata);
  const candidates = normalizedPool.filter((entry) => {
    if (entry.enabled === false) return false;
    if (!(entry.usage === tierUsage || entry.usage === "both")) return false;
    return providers.some(
      (p) => p.id === entry.providerId && providerCanChat(p) && p.status === "connected" && isProviderAvailable(p.id),
    );
  });
  const poolEntries = candidates.length > 0
    ? candidates
    : normalizedPool.filter((entry) =>
      entry.enabled !== false
      && providers.some(
        (p) => p.id === entry.providerId && providerCanChat(p) && p.status === "connected" && isProviderAvailable(p.id),
      ),
    );

  if (poolEntries.length === 0) {
    return { provider: anyChatProvider, modelId: null };
  }

  const expanded: Array<{ providerId: string; modelId: string; priority: number }> = [];
  for (const entry of poolEntries) {
    const replicas = Math.max(1, Math.floor(entry.replicas ?? 1));
    for (let idx = 0; idx < replicas; idx += 1) {
      expanded.push({
        providerId: entry.providerId,
        modelId: entry.modelId,
        priority: entry.priority ?? 50,
      });
    }
  }
  expanded.sort((a, b) => a.priority - b.priority);

  const counterKey = `${metadata?.simulationId ?? "global"}:${tierUsage}`;
  const idx = (swarmPoolCounters.get(counterKey) ?? 0) % expanded.length;
  swarmPoolCounters.set(counterKey, idx + 1);
  const selected = expanded[idx];
  const provider = providers.find(
    (p) => p.id === selected.providerId && providerCanChat(p) && p.status === "connected" && isProviderAvailable(p.id),
  )
    ?? anyChatProvider;
  return { provider, modelId: selected.modelId || null };
}

async function executeSwarmLlmCall(
  deps: {
    providers: Awaited<ReturnType<typeof readProviders>>;
    secrets: Awaited<ReturnType<typeof readProviderSecrets>>;
    settings: Awaited<ReturnType<typeof readSettings>>;
  },
  systemPrompt: string,
  userPrompt: string,
  tier: "small" | "medium" | "large",
  metadata?: SwarmLlmMetadata,
): Promise<{ content: string; providerId?: string; modelId?: string }> {
  const selected = chooseSwarmProvider(deps.providers, deps.settings.simulation?.providerModelPool, tier, metadata);
  if (!selected.provider) {
    throw new Error("No chat-capable provider available for swarm simulation.");
  }

  try {
    const result = await executeProviderChat(selected.provider, deps.secrets, {
      modelId: selected.modelId,
      promptStack: {
        shared: systemPrompt,
        role: "",
        tools: "",
      },
      toolLoopLimit: 0,
      role: "advisor",
      conversation: [],
      content: userPrompt,
      purpose: "chat",
    });
    recordProviderSuccess(selected.provider.id);
    return {
      content: result.content,
      providerId: selected.provider.id,
      modelId: selected.modelId || result.modelId || undefined,
    };
  } catch (error) {
    recordProviderFailure(selected.provider.id);
    throw error;
  }
}

setSwarmLlmCall(async (systemPrompt, userPrompt, tier, metadata) => {
  const deps = await Promise.all([
    readProviders(),
    readProviderSecrets(),
    readSettings(),
  ]);
  return executeSwarmLlmCall(
    {
      providers: deps[0],
      secrets: deps[1],
      settings: deps[2],
    },
    systemPrompt,
    userPrompt,
    tier,
    metadata,
  );
});

// Load persisted custom tools from ~/.ember/custom-tools/ and .ember/custom-tools/
const customTools = loadCustomTools(workspaceDir);
if (customTools.length > 0) {
  registerMcpTools(
    customTools.map(({ tool, roles }) => ({
      tool,
      roles: sanitizeMcpRoleList(roles) as Role[],
    })),
  );
  console.log(`[tool-maker] Loaded ${customTools.length} custom tool(s) from disk.`);
}

// Load dynamic tool plugins from <data-root>/plugins/
void loadToolPlugins().then((plugins) => {
  if (plugins.length > 0) {
    setActivePlugins(plugins);
    registerPluginTools(plugins);
    const toolCount = plugins.reduce((sum, p) => sum + p.tools.length, 0);
    console.log(`[plugins] Registered ${toolCount} tool(s) from ${plugins.length} plugin(s).`);
  }
}).catch((error) => {
  console.warn(`[plugins] Failed to load plugins: ${error instanceof Error ? error.message : String(error)}`);
});

let shuttingDown = false;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainInflightRequests(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (inFlightRequestCount > 0) {
    if (Date.now() - startedAt >= timeoutMs) {
      break;
    }
    await delay(100);
  }
}

async function gracefulShutdown(signal: NodeJS.Signals | "exit"): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  systemLogger.info("shutdown.received", {
    signal,
    inFlightRequests: inFlightRequestCount,
  });

  try {
    await app.close();
  } catch (error) {
    systemLogger.warn("shutdown.app_close_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await drainInflightRequests(CONFIG.request.shutdownDrainMs);
  systemLogger.info("shutdown.drain_complete", {
    inFlightRequests: inFlightRequestCount,
    timeoutMs: CONFIG.request.shutdownDrainMs,
  });

  try {
    await mcpManager.stop();
  } catch (error) {
    systemLogger.warn("shutdown.mcp_stop_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await cleanupPlugins();
  } catch (error) {
    systemLogger.warn("shutdown.plugin_cleanup_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await flushAuditLog().catch((error) => {
    systemLogger.warn("shutdown.audit_flush_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  systemLogger.info("shutdown.complete", {
    signal,
  });

  if (signal !== "exit") {
    process.exit(0);
  }
}

// Graceful shutdown: close the Fastify listener and MCP subprocesses so
// tsx watch restarts and Ctrl-C do not leave the old server bound to 3005.
process.once("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
process.once("SIGINT", () => {
  gracefulShutdown("SIGINT").catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
process.once("exit", () => {
  void gracefulShutdown("exit");
});

await app.register(cors, {
  origin(origin, callback) {
    callback(null, isCorsOriginAllowed(origin, corsOrigins));
  },
});

app.get("/health", async () => {
  const runtime = await readRuntime();
  return {
    status: "ok",
    runtime,
    now: new Date().toISOString(),
  };
});

app.get("/api/health", async () => {
  const [providers] = await Promise.all([
    readProviders(),
  ]);
  const mcpServers = mcpManager.getServerStatus();
  const failover = getFailoverMetricsSnapshot(32);
  const openCircuitCount = Object.values(failover.circuitBreakers).filter((breaker) => breaker.state === "open").length;
  const availableProviders = providers.filter((provider) =>
    provider.status === "connected"
    && providerCanChat(provider)
    && isProviderAvailablePassive(provider.id),
  );
  const enabledMcpServers = mcpServers.filter((server) => server.config.enabled !== false);
  const disconnectedMcpCount = enabledMcpServers.filter((server) => server.status !== "running").length;

  let status: "ok" | "degraded" | "unhealthy" = "ok";
  if (availableProviders.length === 0) {
    status = "unhealthy";
  } else if (openCircuitCount > 0 || disconnectedMcpCount > 0) {
    status = "degraded";
  }

  return {
    status,
    uptime: process.uptime(),
    providers: {
      total: providers.length,
      available: availableProviders.length,
    },
    mcpServers: {
      total: enabledMcpServers.length,
      connected: enabledMcpServers.length - disconnectedMcpCount,
    },
    memory: {
      heapUsed: process.memoryUsage().heapUsed,
    },
    circuitBreakers: {
      open: openCircuitCount,
    },
    timestamp: new Date().toISOString(),
  };
});

app.get("/api/runtime", async () => {
  const [runtime, settings] = await Promise.all([readRuntime(), readSettings()]);
  return {
    runtime,
    settings: redactSettingsForApi(settings),
    secretStatus: buildSettingsSecretStatus(settings),
    failover: getFailoverMetricsSnapshot(8),
  };
});

app.get("/api/failover/metrics", async (request) => {
  const query = request.query as { limit?: number };
  return getFailoverMetricsSnapshot(query.limit);
});

app.get("/api/parallel-tasks/traces", async (request) => {
  const query = request.query as { limit?: number };
  return {
    items: listParallelTaskTraces(query.limit),
    policy: parallelTaskPolicy,
  };
});

app.get("/api/mcp/servers", async () => {
  return buildMcpApiState();
});

app.post("/api/mcp/reload", async (_request, reply) => {
  try {
    await reloadMcpRuntime();
    logAudit(_request, "mcp.reload", "ok");
    return buildMcpApiState();
  } catch (error) {
    logAudit(_request, "mcp.reload", "error", {
      message: error instanceof Error ? error.message : String(error),
    });
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : "Failed to reload MCP servers.",
    };
  }
});

app.post("/api/mcp/install", async (request, reply) => {
  if (!runtimeMcpInstallEnabled) {
    logAudit(request, "mcp.install", "denied", {
      reason: "runtime-install-disabled",
    });
    reply.code(403);
    return { error: "Runtime MCP install is disabled by policy. Set EMBER_ENABLE_RUNTIME_MCP_INSTALL=1 to enable it." };
  }

  const body = (request.body as {
    transport?: string;
    packageName?: string;
    url?: string;
    httpUrl?: string;
    serverName?: string;
    scope?: McpConfigScope;
    roles?: Role[];
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    timeout?: number;
    description?: string;
  } | undefined) ?? {};
  const scope = resolveWritableMcpScope(body.scope ?? "project");
  if (!scope) {
    reply.code(400);
    return { error: "scope must be user or project." };
  }

  const transport = resolveMcpInstallTransport(body);
  if (!transport) {
    reply.code(400);
    return { error: "transport must be package, sse, or streamable-http." };
  }

  const packageName = body.packageName?.trim() ?? "";
  if (transport === "package") {
    const packageError = validatePublicMcpPackageName(packageName);
    if (packageError) {
      reply.code(400);
      return { error: packageError };
    }
  }

  const remoteTarget = ((transport === "streamable-http" ? body.httpUrl : body.url) ?? "").trim();
  let derivedRemoteName = "";
  if (transport !== "package" && remoteTarget) {
    const remotePolicyError = validateMcpRemoteTarget(remoteTarget);
    if (remotePolicyError) {
      logAudit(request, "mcp.install", "denied", {
        reason: "remote-target-policy",
        target: remoteTarget,
      });
      reply.code(403);
      return { error: remotePolicyError };
    }
    try {
      derivedRemoteName = normalizeMcpServerName(new URL(remoteTarget).hostname);
    } catch {
      derivedRemoteName = "";
    }
  }
  const derivedServerName = body.serverName?.trim()
    ? normalizeMcpServerName(body.serverName)
    : transport === "package"
      ? derivePublicMcpServerName(packageName)
      : derivedRemoteName;
  if (!derivedServerName) {
    reply.code(400);
    return { error: "serverName must contain letters or numbers." };
  }

  const roles = sanitizeMcpRoleList(body.roles);
  if (roles.length === 0) {
    reply.code(400);
    return { error: "At least one role must be allowed to use the server." };
  }

  const config = transport === "package"
    ? buildInstalledMcpServer({
        packageName,
        roles,
        args: sanitizeMcpStringList(body.args),
        env: sanitizeMcpStringRecord(body.env),
        timeout: typeof body.timeout === "number" ? body.timeout : null,
        description: typeof body.description === "string" ? body.description : null,
      })
    : buildRemoteMcpServer({
        transport,
        url: remoteTarget,
        roles,
        headers: sanitizeMcpStringRecord(body.headers),
        timeout: typeof body.timeout === "number" ? body.timeout : null,
        description: typeof body.description === "string" ? body.description : null,
      });
  const validationError = validateMcpServerConfig(config);
  if (validationError) {
    reply.code(400);
    return { error: validationError };
  }

  await upsertMcpServer({
    scope,
    workspaceDir,
    name: derivedServerName,
    config,
  });
  await reloadMcpRuntime();
  logAudit(request, "mcp.install", "ok", {
    scope,
    transport,
    serverName: derivedServerName,
  });

  reply.code(201);
  return buildMcpApiState();
});

app.put("/api/mcp/servers/:scope/:name", async (request, reply) => {
  const params = request.params as { scope: McpConfigScope; name: string };
  const body = (request.body as {
    config?: Partial<McpServerConfig>;
  } | undefined) ?? {};
  const scope = resolveWritableMcpScope(params.scope);
  if (!scope) {
    reply.code(400);
    return { error: "scope must be user or project." };
  }

  const serverName = normalizeMcpServerName(params.name);
  if (!serverName) {
    reply.code(400);
    return { error: "Server name is required." };
  }

  const currentState = readResolvedMcpConfigState({
    defaultConfig: defaultMcpConfig,
    workspaceDir,
  });
  const existing = currentState.servers.find((entry) => entry.name === serverName)?.config ?? null;
  const patch = body.config;
  if (!patch) {
    reply.code(400);
    return { error: "config is required." };
  }
  const config = buildMergedMcpServerConfig(patch, existing);
  const validationError = validateMcpServerConfig(config);
  if (validationError) {
    reply.code(400);
    return { error: validationError };
  }

  await upsertMcpServer({
    scope,
    workspaceDir,
    name: serverName,
    config,
  });
  await reloadMcpRuntime();
  logAudit(request, "mcp.update", "ok", {
    scope,
    serverName,
  });

  return buildMcpApiState();
});

app.delete("/api/mcp/servers/:scope/:name", async (request, reply) => {
  const params = request.params as { scope: McpConfigScope; name: string };
  const scope = resolveWritableMcpScope(params.scope);
  if (!scope) {
    reply.code(400);
    return { error: "scope must be user or project." };
  }

  const serverName = normalizeMcpServerName(params.name);
  if (!serverName) {
    reply.code(400);
    return { error: "Server name is required." };
  }

  const removed = await removeMcpServer({
    scope,
    workspaceDir,
    name: serverName,
  });
  if (!removed) {
    reply.code(404);
    return { error: "Server not found in that scope." };
  }

  await reloadMcpRuntime();
  logAudit(request, "mcp.delete", "ok", {
    scope,
    serverName,
  });
  return buildMcpApiState();
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

app.get("/api/session-recall", async (request, reply) => {
  const query = normalizeSessionRecallQuery((request.query as Record<string, unknown>) ?? {});
  if (!query) {
    reply.code(400);
    return {
      error: "Provide at least one recall filter: query, project, role, source, date_from, or date_to.",
    };
  }

  const conversations = await readConversations();
  const result = searchSessionRecall(conversations, query);
  return {
    query: result.query,
    generatedAt: result.generatedAt,
    truncated: result.truncated,
    recallBlock: result.recallBlock,
    items: result.items,
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
  const sanitizedConfigInput = sanitizeRecord(body.config);
  const contextWindowError = validateProviderContextWindowConfig(
    body.typeId,
    sanitizedConfigInput,
  );
  if (contextWindowError) {
    reply.code(400);
    return { error: contextWindowError };
  }

  const provider: Provider = {
    id: createId("provider"),
    name: body.name.trim(),
    typeId: body.typeId,
    status: "idle",
    config: sanitizeProviderConfig(body.typeId, sanitizedConfigInput),
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
  logAudit(request, "providers.create", "ok", {
    providerId: provider.id,
    typeId: provider.typeId,
    name: provider.name,
    secretCount: Object.keys(sanitizedSecrets).length,
  });

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

  const nextConfigInput = {
    ...provider.config,
    ...sanitizeRecord(body?.config),
  };

  if (body?.config) {
    for (const [key, value] of Object.entries(body.config)) {
      if (typeof value === "string" && value.trim().length === 0) {
        delete nextConfigInput[key];
      }
    }
  }

  const contextWindowError = validateProviderContextWindowConfig(provider.typeId, nextConfigInput);
  if (contextWindowError) {
    reply.code(400);
    return { error: contextWindowError };
  }

  const nextConfig = sanitizeProviderConfig(provider.typeId, nextConfigInput);

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
  logAudit(request, "providers.update", "ok", {
    providerId: id,
    name: body?.name?.trim() || provider.name,
    clearSecretCount: body?.clearSecrets?.length ?? 0,
  });

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
  logAudit(request, "providers.connect", "ok", {
    providerId: id,
    status: result.status,
  });
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
  logAudit(request, "providers.reconnect", "ok", {
    providerId: id,
    status: result.status,
  });
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
  logAudit(request, "providers.recheck", "ok", {
    providerId: id,
    status: result.status,
  });
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
  logAudit(request, "providers.delete", "ok", {
    providerId: id,
  });

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
  logAudit(request, "roles.update", "ok", {
    count: body.items.length,
  });
  return { items: body.items };
});

app.get("/api/settings", async () => {
  const settings = await readSettings();
  return {
    item: redactSettingsForApi(settings),
    secretStatus: buildSettingsSecretStatus(settings),
  };
});

app.put("/api/settings", async (request, reply) => {
  const body = request.body as { item?: Awaited<ReturnType<typeof readSettings>> };
  if (!body?.item) {
    reply.code(400);
    return { error: "item is required." };
  }

  await writeSettings(body.item);
  logAudit(request, "settings.update", "ok", {
    memoryEnabled: body.item.memory?.enabled ?? null,
    customToolTrustMode: body.item.customTools?.trustMode ?? null,
  });
  const settings = await readSettings();
  return {
    item: redactSettingsForApi(settings),
    secretStatus: buildSettingsSecretStatus(settings),
  };
});

app.get("/api/terminal/approvals", async (_request) => {
  return {
    items: listPendingTerminalApprovals(),
  };
});

app.post("/api/terminal/approvals/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body as { decision?: TerminalApprovalDecision } | undefined) ?? {};
  if (!body.decision) {
    reply.code(400);
    return { error: "decision is required." };
  }

  const result = await decidePendingTerminalApproval({
    approvalId: id,
    decision: body.decision,
  });
  if (!result.ok) {
    reply.code(404);
    logAudit(request, "terminal.approval.decide", "denied", {
      approvalId: id,
      message: result.message,
    });
    return {
      error: result.message,
    };
  }

  logAudit(request, "terminal.approval.decide", "ok", {
    approvalId: id,
    decision: body.decision,
    sessionKey: result.item.sessionKey,
  });
  return {
    item: result.item,
  };
});

app.get("/api/checkpoints", async (request) => {
  const query = request.query as { limit?: number };
  return {
    items: await listCheckpoints(query.limit),
  };
});

app.post("/api/checkpoints/:id/rollback", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const result = await rollbackCheckpoint(id);
  if (!result.ok) {
    reply.code(404);
    logAudit(request, "checkpoint.rollback", "denied", {
      checkpointId: id,
      message: result.message,
    });
    return { error: result.message };
  }

  logAudit(request, "checkpoint.rollback", "ok", {
    checkpointId: id,
    restoredCount: result.restoredCount,
  });
  return { item: result };
});

app.get("/api/prompts/:role", async (request, reply) => {
  const role = (request.params as { role: Role }).role;
  if (!["dispatch", "coordinator", "advisor", "director", "inspector", "ops"].includes(role)) {
    reply.code(400);
    return { error: "Unknown role." };
  }

  const [settings, assignments, providers] = await Promise.all([
    readSettings(),
    readRoleAssignments(),
    readProviders(),
  ]);
  const assignmentMap = new Map<Role, RoleAssignment>(
    assignments.map((assignment) => [assignment.role, assignment]),
  );
  const assignment = assignmentMap.get(role);
  const provider = providers.find((candidate) => candidate.id === assignment?.providerId) ?? null;
  const executionProfile = resolveExecutionModelProfile(settings, provider, role);
  const tools: ToolDefinition[] = role === "dispatch"
    ? []
    : getExecutionToolsForRole(role, {
        compact: executionProfile.compactToolset,
        ultraCompact: executionProfile.ultraCompactToolset,
        customToolTrustMode: settings.customTools.trustMode,
      });

  return {
    item: buildRolePromptStack({
      settings,
      role,
      tools,
      providers,
      assignmentMap,
      compactRolePrompt: executionProfile.compactRolePrompt,
      compactToolPrompt: executionProfile.compactToolPrompt,
    }),
  };
});

app.post("/api/chat", async (request) => {
  const body = request.body as ChatRequest;
  const requestLogger = getRequestLogger(request);
  let built: BuiltExecution | null = null;
  requestLogger.info("chat.request", {
    mode: body.mode,
    conversationLength: body.conversation.length,
    hasConversationId: Boolean(body.conversationId),
  });

  try {
    built = await buildExecution(body, {
      requestLogger,
    });
    const conversation = await persistConversationFromResult(body, built.result);
    await consolidatePersistedConversation(built.context, conversation, built.toolObservations);
    requestLogger.info("chat.response.ready", {
      conversationId: conversation.id,
      activeRole: built.result.activeRole,
      providerId: built.result.providerId,
      modelId: built.result.modelId,
      messageCount: built.result.messages.length,
      toolObservationCount: built.toolObservations.length,
    });

    return {
      ...built.result,
      conversationId: conversation.id,
      conversation: toConversationSummary(conversation),
    };
  } finally {
    markExecutionActivity();
    await built?.context.memoryRepository?.close?.();
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
  const requestLogger = getRequestLogger(request);
  let streamExecutionContext: ExecutionContext | null = null;
  const streamStartedAt = Date.now();
  let streamToolObservations: MemoryToolObservation[] = [];
  let streamResult: ChatExecutionResult | null = null;
  requestLogger.info("chat.stream.request", {
    mode: body.mode,
    conversationLength: body.conversation.length,
    hasConversationId: Boolean(body.conversationId),
  });

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "x-xss-protection": "0",
    "referrer-policy": "no-referrer",
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
    const context = await prepareExecution(body, {
      requestLogger,
    });
    streamExecutionContext = context;
    const compactedBody = context.compactedRequest;
    requestLogger.info("execution.context", {
      mode: context.mode,
      activeRole: context.activeRole,
      routedRole: context.routedTo,
      routeSource: context.routeDecision?.source ?? null,
      providerId: context.provider?.id ?? null,
      providerName: context.provider?.name ?? null,
      providerRouteSource: context.providerDecision?.source ?? null,
      modelId: context.responseModelId,
      modelRouteSource: context.modelDecision?.source ?? null,
    });

    if (context.routeDecision) {
      sendStreamEvent(send, {
        type: "status",
        phase: "routing",
        message:
          `Auto routed to ${context.routeDecision.role} via ${formatRouteSource(context.routeDecision.source)}. ` +
          context.routeDecision.reason,
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
    streamToolObservations = toolObservations;
    const streamVisitCounts = new Map<string, number>();
    const streamProviderFailureCounts = new Map<string, number>();
    const streamAttemptedFailoverTargets = new Set<string>();
    let streamCtx = context;
    let streamConversation = [...compactedBody.conversation];
    let streamContent = compactedBody.content;
    let streamMonitorState = createExecutionMonitor(streamCtx.taskAssessment);
    let pendingStreamStrategyInjection: string | null = null;
    let pendingStreamModelEscalation = false;
    const streamWorkflowReminderCounts = new Map<string, number>();
    if (streamCtx.provider) {
      streamAttemptedFailoverTargets.add(
        buildFailoverTargetKey(streamCtx.provider.id, streamCtx.responseModelId ?? null),
      );
    }

    // Wire simulation events through the chat SSE stream for real-time visualization
    setSwarmEventSink((simEvent) => {
      send({ type: "simulation", event: simEvent });
    });

    // Frozen memory snapshots: load once before the loop to preserve prompt cache
    // across tool-loop iterations. Live reads still happen via memory_save/memory_search tools.
    const frozenStreamMemoryContext = await buildPersistentMemoryContext(
      streamCtx,
      streamConversation,
      streamContent,
      body.conversationId ?? null,
    );
    const frozenStreamProcedureContext = await buildProcedureMemoryContext(
      streamCtx,
      streamConversation,
      streamContent,
      body.conversationId ?? null,
    );

    for (let iteration = 0; iteration < MAX_AGENT_LOOP; iteration++) {
      const iterProvider = streamCtx.provider;
      if (!iterProvider || iterProvider.status !== "connected" || !providerCanChat(iterProvider)) {
        if (iteration === 0) resolveExecutionGuard(streamCtx);
        console.warn(`[loop] no usable provider for ${streamCtx.activeRole}, stopping`);
        break;
      }
      const iterContextWindow = streamCtx.inheritedContextWindowTokens != null
        ? Math.min(
            streamCtx.inheritedContextWindowTokens,
            resolveProviderContextWindowTokens(iterProvider, streamCtx.settings),
          )
        : resolveProviderContextWindowTokens(iterProvider, streamCtx.settings);

      if (iteration === 0) {
        sendStreamEvent(send, {
          type: "status",
          phase: "provider",
          message: buildProviderStatusMessage(
            iterProvider,
            streamCtx.providerDecision,
            streamCtx.modelDecision,
          ),
          role: streamCtx.activeRole,
          providerName: iterProvider.name,
          modelId: streamCtx.responseModelId,
        });
      } else {
        sendStreamEvent(send, {
          type: "status",
          phase: "routing",
          message:
            `Handing off to ${streamCtx.activeRole} via ${iterProvider.name}` +
            `${streamCtx.responseModelId ? ` / ${streamCtx.responseModelId}` : ""}...`,
          role: streamCtx.activeRole,
          providerName: iterProvider.name,
          modelId: streamCtx.responseModelId,
        });
      }

      const memoryContext = frozenStreamMemoryContext;
      const procedureContext = frozenStreamProcedureContext;
      const handler = createToolHandler({
        activeRole: streamCtx.activeRole,
        workflowState: streamCtx.workflowState,
        browserSessionKey: streamCtx.browserSessionKey,
        toolSnapshot: streamCtx.toolSnapshot,
        parallelDepth: streamCtx.parallelDepth,
        contextWindowTokens: iterContextWindow,
        rolePinned: streamCtx.rolePinned,
        customToolTrustMode: streamCtx.settings.customTools.trustMode,
        onParallelTasks: (input) =>
          runParallelTasks({
            parentRequest: body,
            parentContext: streamCtx,
            currentContent: streamContent,
            input,
          }),
        onToolResult(observation) {
          toolObservations.push(observation);
          const monitorUpdate = applyMetacognitiveMonitorUpdate(
            streamMonitorState,
            observation,
            streamCtx.taskAssessment,
          );
          streamMonitorState = monitorUpdate.nextState;
          if (monitorUpdate.injectionText) {
            pendingStreamStrategyInjection = monitorUpdate.injectionText;
          }
          if (monitorUpdate.shouldEscalateModel) {
            pendingStreamModelEscalation = true;
          }
        },
      });
      const onToolCallWithLogging = async (
        name: string,
        input: Record<string, unknown>,
      ): Promise<import("@ember/core").ToolResult> => {
        requestLogger.info("tool.call", {
          role: streamCtx.activeRole,
          providerId: iterProvider.id,
          modelId: streamCtx.responseModelId,
          toolName: name,
          toolInputKeys: Object.keys(input).slice(0, 12),
        });
        const result = await handler.onToolCall(name, input);
        requestLogger.info("tool.result", {
          role: streamCtx.activeRole,
          providerId: iterProvider.id,
          modelId: streamCtx.responseModelId,
          toolName: name,
          preview: summarizeToolResult(result),
        });
        return result;
      };
      const compactedConversation = compactConversationForContext(
        streamConversation,
        streamContent,
        streamCtx.settings,
        streamCtx.promptStack,
        iterProvider,
        streamCtx.tools,
        estimatePromptExtraTokens({
          memoryContextText: memoryContext?.text ?? null,
          procedureContextText: procedureContext?.text ?? null,
        }),
      ).messages;
      let iterThinking = "";
      let iterContent = "";

      try {
        const iterExecution = await streamProviderChat(
          iterProvider,
          context.secrets,
          {
            modelId: streamCtx.responseModelId,
            promptStack: streamCtx.promptStack,
            toolLoopLimit: streamCtx.settings.compression.toolLoopLimit,
            contextWindowTokens: iterContextWindow,
            memoryContext,
            procedureContext,
            role: streamCtx.activeRole,
            conversation: compactedConversation,
            content: streamContent,
            tools: streamCtx.tools,
            onToolCall: onToolCallWithLogging,
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
            onUsage(inputTokens, outputTokens) {
              sendStreamEvent(send, { type: "usage", inputTokens, outputTokens });
            },
          },
        );
        requestLogger.info("provider.response", {
          role: streamCtx.activeRole,
          providerId: iterProvider.id,
          modelId: iterExecution.modelId ?? streamCtx.responseModelId,
          iteration,
        });
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
        recordProviderSuccess(iterProvider.id);
        streamProviderFailureCounts.set(
          `${streamCtx.activeRole}:${buildFailoverTargetKey(iterProvider.id, streamCtx.responseModelId ?? null)}`,
          0,
        );

        const iterNote = [
          streamCtx.routeNote,
          buildProviderSelectionNote(streamCtx.provider, streamCtx.providerDecision),
          buildModelSelectionNote(streamCtx.modelDecision),
          `Live response via ${iterProvider.name}.`,
        ]
          .filter(Boolean)
          .join(" ");
        const iterMsg = buildReplyMessage(
          streamCtx, body, iterExecution.content, iterExecution.thinking ?? null, iterExecution.modelId, iterNote,
          iterExecution.usage ?? null,
        );
        resultMessages.push(iterMsg);

        const handoff = streamCtx.rolePinned ? null : handler.getPendingHandoff();
        if (!handoff && pendingStreamStrategyInjection) {
          const strategyMessage = buildStrategySystemMessage(
            streamCtx.activeRole,
            streamCtx.mode,
            pendingStreamStrategyInjection,
          );
          streamConversation = [...compactedConversation, iterMsg, strategyMessage];
          streamContent = "Continue this task with the updated strategy. Avoid repeating failed steps.";
          sendStreamEvent(send, {
            type: "status",
            phase: "routing",
            message: "Metacognitive strategy adjustment injected.",
            role: streamCtx.activeRole,
            providerName: iterProvider.name,
            modelId: streamCtx.responseModelId,
          });
          if (pendingStreamModelEscalation) {
            streamCtx = await buildHandoffContext(
              streamCtx,
              streamCtx.activeRole as ExecutionRole,
              streamContent,
              streamConversation,
              streamCtx.workflowState,
              {
                forceEscalation: true,
                routeNote: appendFailoverRouteNote(
                  streamCtx.routeNote,
                  "Metacognitive escalation requested a stronger model lane.",
                ),
              },
            );
            sendStreamEvent(send, {
              type: "status",
              phase: "routing",
              message:
                `Escalating model lane to ${streamCtx.provider?.name ?? "no provider"}` +
                `${streamCtx.responseModelId ? ` / ${streamCtx.responseModelId}` : ""}.`,
              role: streamCtx.activeRole,
              providerName: streamCtx.provider?.name ?? null,
              modelId: streamCtx.responseModelId,
            });
            if (streamCtx.provider) {
              streamAttemptedFailoverTargets.add(
                buildFailoverTargetKey(streamCtx.provider.id, streamCtx.responseModelId ?? null),
              );
            }
          } else {
            streamCtx = {
              ...streamCtx,
              routeNote: appendFailoverRouteNote(
                streamCtx.routeNote,
                "Metacognitive strategy adjustment injected for the next turn.",
              ),
            };
          }
          streamMonitorState = createExecutionMonitor(streamCtx.taskAssessment);
          pendingStreamStrategyInjection = null;
          pendingStreamModelEscalation = false;
          continue;
        }
        if (!handoff) {
          const reminder = streamCtx.rolePinned ? null : buildDeliveryWorkflowReminder(streamCtx.workflowState, streamCtx.activeRole);
          if (reminder) {
            const reminderCount = (streamWorkflowReminderCounts.get(streamCtx.activeRole) ?? 0) + 1;
            if (reminderCount <= 1) {
              streamWorkflowReminderCounts.set(streamCtx.activeRole, reminderCount);
              streamConversation = [...compactedConversation, iterMsg];
              streamContent = reminder;
              streamCtx = {
                ...streamCtx,
                routeNote: `${streamCtx.routeNote ? `${streamCtx.routeNote} ` : ""}Delivery workflow requires a specialist handoff.`,
              };
              continue;
            }
          }
          break;
        }

        const visits = (streamVisitCounts.get(handoff.role) ?? 0) + 1;
        if (visits > MAX_ROLE_VISITS) {
          console.warn(`[loop] ${handoff.role} hit visit limit (${MAX_ROLE_VISITS}), stopping`);
          break;
        }
        streamVisitCounts.set(handoff.role, visits);
        console.log(`[loop] ${streamCtx.activeRole} → handoff: ${handoff.role} (visit ${visits})`);

        streamConversation = [...compactedConversation, iterMsg];
        streamContent = handoff.message;
        streamCtx = await buildHandoffContext(
          streamCtx,
          handoff.role as ExecutionRole,
          handoff.message,
          streamConversation,
          handoff.workflowState,
        );
        streamMonitorState = createExecutionMonitor(streamCtx.taskAssessment);
        pendingStreamStrategyInjection = null;
        pendingStreamModelEscalation = false;
        if (streamCtx.provider) {
          streamAttemptedFailoverTargets.add(
            buildFailoverTargetKey(streamCtx.provider.id, streamCtx.responseModelId ?? null),
          );
        }
      } catch (chainError) {
        recordProviderFailure(iterProvider.id);
        const failureKey = `${streamCtx.activeRole}:${buildFailoverTargetKey(
          iterProvider.id,
          streamCtx.responseModelId ?? null,
        )}`;
        const failureCount = (streamProviderFailureCounts.get(failureKey) ?? 0) + 1;
        streamProviderFailureCounts.set(failureKey, failureCount);
        if (FAILOVER_ENABLED && failureCount < FAILOVER_FAILURE_THRESHOLD) {
          sendStreamEvent(send, {
            type: "status",
            phase: "routing",
            message:
              `Execution failed on ${iterProvider.name}; retrying same lane ` +
              `(${failureCount}/${FAILOVER_FAILURE_THRESHOLD})...`,
            role: streamCtx.activeRole,
            providerName: iterProvider.name,
            modelId: streamCtx.responseModelId,
          });
          continue;
        }
        const failoverCtx = resolveFailoverContext({
          context: streamCtx,
          conversation: streamConversation,
          content: streamContent,
          errorMessage: chainError instanceof Error ? chainError.message : String(chainError),
          failureCount,
          attemptedTargets: streamAttemptedFailoverTargets,
        });
        if (failoverCtx) {
          sendStreamEvent(send, {
            type: "status",
            phase: "routing",
            message:
              `Failover activated after repeated failures: ${iterProvider.name}` +
              ` → ${failoverCtx.provider?.name ?? "none"}` +
              `${failoverCtx.responseModelId ? ` / ${failoverCtx.responseModelId}` : ""}.`,
            role: failoverCtx.activeRole,
            providerName: failoverCtx.provider?.name ?? null,
            modelId: failoverCtx.responseModelId,
          });
          streamCtx = failoverCtx;
          continue;
        }
        if (iteration === 0) {
          const unavailable = buildAllProvidersUnavailableMessage(streamCtx);
          if (unavailable) {
            throw createStatusError(
              502,
              `${unavailable} Live provider execution failed: ${chainError instanceof Error ? chainError.message : String(chainError)}`,
            );
          }
          throw chainError;
        }
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
    streamResult = result;

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
    await recordTaskOutcomeForExecution({
      memoryRepository: context.memoryRepository,
      request: body,
      context,
      result,
      toolObservations,
      durationMs: Date.now() - streamStartedAt,
    });
    sendStreamEvent(send, {
      type: "complete",
      message: lastResultMessage,
      conversationId: conversation.id,
      conversation: toConversationSummary(conversation),
    });
    requestLogger.info("chat.stream.complete", {
      conversationId: conversation.id,
      activeRole: result.activeRole,
      providerId: result.providerId,
      modelId: result.modelId,
      messageCount: result.messages.length,
      toolObservationCount: toolObservations.length,
    });
  } catch (error) {
    requestLogger.error("chat.stream.error", {
      message: error instanceof Error ? error.message : String(error),
    });
    if (streamExecutionContext) {
      await recordTaskOutcomeForExecution({
        memoryRepository: streamExecutionContext.memoryRepository,
        request: body,
        context: streamExecutionContext,
        result: streamResult,
        toolObservations: streamToolObservations,
        durationMs: Date.now() - streamStartedAt,
        failureReason: error instanceof Error ? error.message : String(error),
      });
    }
    sendStreamEvent(send, {
      type: "error",
      message: error instanceof Error ? error.message : "Chat request failed.",
      statusCode:
        error && typeof error === "object" && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode) || undefined
          : undefined,
    });
  } finally {
    markExecutionActivity();
    setSwarmEventSink(null);
    clearInterval(heartbeat);
    await streamExecutionContext?.memoryRepository?.close?.();
    reply.raw.end();
    markRequestClosed(request);
  }

  return reply;
});

// ─── Simulation API Endpoints (Phase 2) ─────────────────────────────────────────

import {
  listSimulations as listSimulationStates,
  loadSimulationState as loadSimState,
  deleteSimulation as deleteSimState,
  saveSimulationState as saveSimState,
} from "./swarm/simulation-store.js";
import {
  createSimulation as createSim,
  interviewPersona as interviewSim,
  runFullSimulation as runFullSimulationInternal,
} from "./swarm/simulation-runner.js";
import type { SimulationEvent } from "./swarm/types.js";
import { addSimulationEventListener } from "./swarm/simulation-events.js";
import {
  getSimulationRunActions,
  getSimulationRunState,
  isSimulationRunning,
  startSimulationBackground,
  stopSimulationRun,
} from "./swarm/simulation-runtime.js";
import { deleteSimulationRuntimeArtifacts } from "./swarm/runtime-store.js";
import {
  MAX_SWARM_PERSONAS,
  MAX_SWARM_ROUNDS,
  MIN_SWARM_PERSONAS,
  MIN_SWARM_ROUNDS,
  normalizeProviderModelPool,
  resolveSimulationPool,
  validateSwarmDeployment,
} from "./swarm/simulation-planning.js";

const simulationInterviewQueues = new Map<string, Promise<unknown>>();

function enqueueSimulationInterviewTask<T>(simulationId: string, task: () => Promise<T>): Promise<T> {
  const previous = simulationInterviewQueues.get(simulationId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task);
  simulationInterviewQueues.set(simulationId, next);
  return next.finally(() => {
    if (simulationInterviewQueues.get(simulationId) === next) {
      simulationInterviewQueues.delete(simulationId);
    }
  });
}

app.get("/api/simulations", async () => {
  const sims = listSimulationStates();
  return {
    items: sims.map((s) => {
      const runState = getSimulationRunState(s.config.id);
      return {
        id: s.config.id,
        title: s.config.title,
        status: runState?.runnerStatus ?? s.status,
        simulationStatus: s.status,
        runnerStatus: runState?.runnerStatus ?? null,
        domain: s.config.domain,
        personaCount: s.personas.length,
        roundCount: s.config.roundCount,
        currentRound: runState?.currentRound ?? s.currentRound,
        actionsCount: runState?.actionsCount ?? s.rounds.reduce((sum, r) => sum + r.actions.length, 0),
        createdAt: s.config.createdAt,
        updatedAt: runState?.updatedAt ?? s.updatedAt,
      };
    }),
    total: sims.length,
  };
});

app.get("/api/simulations/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });
  return state;
});

app.post("/api/simulations", async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  const scenario = typeof body.scenario === "string" ? body.scenario.trim() : "";
  if (!scenario) return reply.status(400).send({ error: "scenario is required." });

  const settings = await readSettings();
  const title = typeof body.title === "string" ? body.title.trim() : scenario.slice(0, 60);
  const personaCount = typeof body.personaCount === "number"
    ? Math.max(MIN_SWARM_PERSONAS, Math.min(MAX_SWARM_PERSONAS, body.personaCount))
    : Math.max(MIN_SWARM_PERSONAS, Math.min(MAX_SWARM_PERSONAS, settings.simulation?.defaultPersonaCount ?? MIN_SWARM_PERSONAS));
  const roundCount = typeof body.roundCount === "number"
    ? Math.max(MIN_SWARM_ROUNDS, Math.min(MAX_SWARM_ROUNDS, body.roundCount))
    : Math.max(MIN_SWARM_ROUNDS, Math.min(MAX_SWARM_ROUNDS, settings.simulation?.defaultRoundCount ?? 3));
  const domain = typeof body.domain === "string" ? body.domain : "other";
  const inputPool = Array.isArray(body.providerModelPool)
    ? body.providerModelPool as Array<Record<string, unknown>>
    : null;
  const pool = resolveSimulationPool(settings, inputPool);
  const deploymentCheck = validateSwarmDeployment(personaCount, pool, true);
  if (!deploymentCheck.ok) {
    return reply.status(400).send({ error: deploymentCheck.reason });
  }

  const state = createSim({
    title,
    scenario,
    personaCount,
    roundCount,
    modelTier: "small",
    synthesisModelTier: "medium",
    domain,
    providerModelPool: pool,
  });

  return reply.status(201).send(state);
});

app.post("/api/simulations/:id/run", async (request, reply) => {
  const { id } = request.params as { id: string };
  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });
  if (state.status === "completed") return reply.status(400).send({ error: "Already completed." });
  if (isSimulationRunning(id)) return reply.status(400).send({ error: "Already running." });

  // Run in background, return immediately
  const [providers, secrets, settings] = await Promise.all([
    readProviders(),
    readProviderSecrets(),
    readSettings(),
  ]);

  const hasChatProvider = providers.some((p) => providerCanChat(p) && p.status === "connected")
    || providers.some((p) => providerCanChat(p));
  if (!hasChatProvider) {
    return reply.status(500).send({ error: "No chat-capable provider available." });
  }

  const pool = normalizeProviderModelPool(
    (state.config.providerModelPool && state.config.providerModelPool.length > 0)
      ? state.config.providerModelPool
      : (settings.simulation?.providerModelPool ?? []),
  );
  const deploymentCheck = validateSwarmDeployment(state.config.personaCount, pool, true);
  if (!deploymentCheck.ok) {
    return reply.status(400).send({ error: deploymentCheck.reason });
  }
  state.config.providerModelPool = pool;
  saveSimState(state);

  const runState = await startSimulationBackground(state, {
    callLlm: async (systemPrompt: string, userPrompt: string, tier: "small" | "medium" | "large", metadata) => {
      const result = await executeSwarmLlmCall(
        { providers, secrets, settings: { ...settings, simulation: { ...settings.simulation, providerModelPool: pool } } },
        systemPrompt,
        userPrompt,
        tier,
        metadata,
      );
      return result;
    },
    maxConcurrency: settings.simulation?.maxConcurrency ?? 4,
  });

  return reply.status(202).send({ id, status: runState.runnerStatus });
});

app.post("/api/simulations/:id/stop", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (stopSimulationRun(id)) {
    return { id, status: "stopping" };
  }
  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });
  if (state.status !== "running" && state.status !== "preparing") {
    return reply.status(400).send({ error: `Simulation is ${state.status}, cannot stop.` });
  }
  state.status = "paused";
  saveSimState(state);
  return { id, status: "paused" };
});

app.get("/api/simulations/:id/run-status", async (request, reply) => {
  const { id } = request.params as { id: string };
  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });

  const runState = getSimulationRunState(id);
  if (!runState) {
    return {
      simulationId: id,
      runnerStatus: state.status === "completed" ? "completed" : "idle",
      currentRound: state.currentRound,
      totalRounds: state.config.roundCount,
      actionsCount: state.rounds.reduce((sum, r) => sum + r.actions.length, 0),
      startedAt: state.startedAt ?? null,
      updatedAt: state.updatedAt,
      completedAt: state.status === "completed" ? state.updatedAt : null,
      error: state.error,
    };
  }
  return runState;
});

app.get("/api/simulations/:id/run-status/detail", async (request, reply) => {
  const { id } = request.params as { id: string };
  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });

  const runState = getSimulationRunState(id);
  const actions = getSimulationRunActions(id, { limit: 50, offset: 0 });
  return {
    runState: runState ?? {
      simulationId: id,
      runnerStatus: state.status === "completed" ? "completed" : "idle",
      currentRound: state.currentRound,
      totalRounds: state.config.roundCount,
      actionsCount: state.rounds.reduce((sum, r) => sum + r.actions.length, 0),
      startedAt: state.startedAt ?? null,
      updatedAt: state.updatedAt,
      completedAt: state.status === "completed" ? state.updatedAt : null,
      error: state.error,
    },
    recentActions: actions.items,
    totalActionsLogged: actions.total,
  };
});

app.get("/api/simulations/:id/actions", async (request, reply) => {
  const { id } = request.params as { id: string };
  const query = request.query as { limit?: string; offset?: string };
  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });

  const limit = query.limit ? Math.max(1, Math.min(500, parseInt(query.limit, 10) || 100)) : 100;
  const offset = query.offset ? Math.max(0, parseInt(query.offset, 10) || 0) : 0;
  return getSimulationRunActions(id, { limit, offset });
});

app.delete("/api/simulations/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const deleted = deleteSimState(id);
  if (!deleted) return reply.status(404).send({ error: `Simulation "${id}" not found.` });
  stopSimulationRun(id);
  deleteSimulationRuntimeArtifacts(id);
  return { id, deleted: true };
});

app.post("/api/simulations/:id/interview", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as Record<string, unknown>;
  const personaId = typeof body.personaId === "string" ? body.personaId : "";
  const question = typeof body.question === "string" ? body.question : "";
  if (!personaId || !question) return reply.status(400).send({ error: "personaId and question required." });

  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });

  const providers = await readProviders();
  const chatProvider = providers.find((p) => providerCanChat(p) && p.status === "connected");
  if (!chatProvider) return reply.status(500).send({ error: "No provider available." });

  const secrets = await readProviderSecrets();
  const context = {
    callLlm: async (systemPrompt: string, userPrompt: string, tier: "small" | "medium" | "large") => {
      const result = await executeProviderChat(chatProvider, secrets, {
        modelId: null,
        promptStack: { shared: systemPrompt, role: "", tools: "" },
        toolLoopLimit: 0,
        role: "advisor",
        conversation: [],
        content: userPrompt,
        purpose: "chat",
      });
      return result.content;
    },
    maxConcurrency: 1,
  };

  const response = await enqueueSimulationInterviewTask(id, async () =>
    interviewSim(state, personaId, question, context),
  );
  return { personaId, response };
});

app.post("/api/simulations/:id/interview/batch", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as Record<string, unknown>;
  const interviews = Array.isArray(body.interviews) ? body.interviews : [];
  if (interviews.length === 0) {
    return reply.status(400).send({ error: "interviews array is required." });
  }

  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });

  const providers = await readProviders();
  const chatProvider = providers.find((p) => providerCanChat(p) && p.status === "connected");
  if (!chatProvider) return reply.status(500).send({ error: "No provider available." });

  const secrets = await readProviderSecrets();
  const context = {
    callLlm: async (systemPrompt: string, userPrompt: string, _tier: "small" | "medium" | "large") => {
      const result = await executeProviderChat(chatProvider, secrets, {
        modelId: null,
        promptStack: { shared: systemPrompt, role: "", tools: "" },
        toolLoopLimit: 0,
        role: "advisor",
        conversation: [],
        content: userPrompt,
        purpose: "chat",
      });
      return result.content;
    },
    maxConcurrency: 1,
  };

  const results = await enqueueSimulationInterviewTask(id, async () => {
    const output: Array<{ personaId: string; response: string }> = [];
    for (const item of interviews) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const personaId = typeof record.personaId === "string" ? record.personaId : "";
      const question = typeof record.question === "string" ? record.question : "";
      if (!personaId || !question) continue;
      const response = await interviewSim(state, personaId, question, context);
      output.push({ personaId, response });
    }
    return output;
  });

  return { simulationId: id, count: results.length, results };
});

app.get("/api/simulations/:id/report", async (request, reply) => {
  const { id } = request.params as { id: string };
  const query = request.query as { format?: string };
  const state = loadSimState(id);
  if (!state) return reply.status(404).send({ error: `Simulation "${id}" not found.` });

  // Return raw state for the frontend to render
  return {
    ...state,
    reportFormat: query.format ?? "summary",
  };
});

// SSE endpoint for live simulation streaming
app.get("/api/simulations/:id/stream", async (request, reply) => {
  const { id } = request.params as { id: string };

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendEvent = (event: SimulationEvent) => {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const removeListener = addSimulationEventListener(id, sendEvent);

  // Send current state as initial event
  const state = loadSimState(id);
  if (state) {
    sendEvent({
      type: "simulation:status",
      simulationId: id,
      status: state.status,
      message: `Current status: ${state.status}`,
    });
  }

  // Heartbeat
  const heartbeat = setInterval(() => {
    reply.raw.write(":heartbeat\n\n");
  }, 15_000);

  // Cleanup on close
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    removeListener();
  });

  return reply;
});

// Simulation settings endpoints
app.get("/api/simulation-settings", async () => {
  const settings = await readSettings();
  return settings.simulation ?? {};
});

app.put("/api/simulation-settings", async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  const settings = await readSettings();
  const merged = { ...settings, simulation: { ...settings.simulation, ...body } };
  await writeSettings(merged);
  return merged.simulation;
});

app.listen({ host, port }).catch((error) => {
  console.error(error);
  process.exit(1);
});
