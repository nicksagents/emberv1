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
  type ConnectorTypeId,
  ensureDataFiles,
  getProviderCapabilities,
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
  ChatExecutionResult,
  ChatMessage,
  ChatMode,
  ChatRequest,
  ChatStreamEvent,
  Conversation,
  ConversationSummary,
  Provider,
  Role,
  RoleAssignment,
} from "@ember/core";
import type { UiBlock } from "@ember/ui-schema";
import { getPromptStack } from "@ember/prompts";

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
  const { messages, ...summary } = conversation;
  void messages;
  return summary;
}

function normalizeChatMode(mode: ChatMode): ChatMode {
  return mode === "router" ? "auto" : mode;
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
    lastMessageAt: lastMessage?.createdAt ?? null,
    preview: summarizeText(lastMessage?.content ?? firstUserMessage?.content ?? ""),
    messageCount: finalMessages.length,
    messages: finalMessages,
  };
}

type RoutedRole = Exclude<Role, "router">;

interface AutoRouteDecision {
  role: RoutedRole;
  reason: string;
  source: "router-llm" | "heuristic";
}

function countPatternMatches(content: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + (pattern.test(content) ? 1 : 0), 0);
}

function estimateTaskCount(content: string): number {
  const normalized = content
    .toLowerCase()
    .replace(/\b(after that|afterwards|next|then)\b/g, " and ");
  const parts = normalized
    .split(/\b(?:and|also)\b|[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return Math.max(1, Math.min(parts.length, 6));
}

function routeAutoRequestHeuristic(content: string): AutoRouteDecision {
  const normalized = content.toLowerCase();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const taskCount = estimateTaskCount(normalized);

  const browserScore = countPatternMatches(normalized, [
    /\bbrowser\b/,
    /\bplaywright\b/,
    /\bdevtools\b/,
    /\bscreenshot\b/,
    /\bdom\b/,
    /\bselector\b/,
    /\btab\b/,
    /\bnavigate\b/,
    /\bclick\b/,
    /\bpage\b/,
    /\be2e\b/,
  ]);

  const plannerScore = countPatternMatches(normalized, [
    /\bplan\b/,
    /\bplanning\b/,
    /\broadmap\b/,
    /\bmilestone\b/,
    /\barchitecture\b/,
    /\bmigration\b/,
    /\boverhaul\b/,
    /\bstrategy\b/,
    /\brollout\b/,
  ]);

  const codingScore = countPatternMatches(normalized, [
    /\bcode\b/,
    /\bcoder\b/,
    /\bimplement\b/,
    /\bbuild\b/,
    /\bfix\b/,
    /\bbug\b/,
    /\brefactor\b/,
    /\bcomponent\b/,
    /\bapi\b/,
    /\bendpoint\b/,
    /\btypescript\b/,
    /\bjavascript\b/,
    /\breact\b/,
    /\bcss\b/,
    /\bui\b/,
    /\bfile\b/,
    /\bfunction\b/,
    /\bpatch\b/,
  ]);

  const auditScore = countPatternMatches(normalized, [
    /\breview\b/,
    /\baudit\b/,
    /\bregression\b/,
    /\btest\b/,
    /\bvalidate\b/,
    /\bverify\b/,
    /\bsecurity\b/,
    /\brisk\b/,
  ]);

  const janitorScore = countPatternMatches(normalized, [
    /\bcleanup\b/,
    /\bpolish\b/,
    /\brename\b/,
    /\bformat\b/,
    /\blint\b/,
    /\btidy\b/,
    /\bsimplify\b/,
    /\borganize\b/,
  ]);

  const casualChat =
    /^(hi|hello|hey|yo|sup|thanks|thank you)\b/.test(normalized) ||
    /\b(chat|talk|brainstorm|explain|summarize|summary|question)\b/.test(normalized);

  const planningNeeded =
    plannerScore >= 2 ||
    (codingScore >= 3 && (wordCount > 35 || taskCount > 3)) ||
    /(plan this|think through|before coding|safe rollout|implementation plan|spec this)/.test(
      normalized,
    );

  const simpleCodingTask =
    (codingScore >= 1 || browserScore >= 1) &&
    !planningNeeded &&
    wordCount <= 45 &&
    taskCount <= 3;

  if (auditScore >= 1 && codingScore === 0) {
    return {
      role: "auditor",
      reason: "The request is focused on review, validation, or regression risk.",
      source: "heuristic",
    };
  }

  if (janitorScore >= 1 && codingScore <= 1 && plannerScore === 0) {
    return {
      role: "janitor",
      reason: "The request is focused on cleanup, polish, or formatting.",
      source: "heuristic",
    };
  }

  if (browserScore >= 1) {
    return {
      role: "coder",
      reason: "The request is browser-heavy and needs implementation work.",
      source: "heuristic",
    };
  }

  if (planningNeeded) {
    return {
      role: "planner",
      reason: "The request needs planning, safety checks, or is large enough to scope before coding.",
      source: "heuristic",
    };
  }

  if (simpleCodingTask) {
    return {
      role: "coder",
      reason: "The request looks like a direct code task that can be handled without a planning pass.",
      source: "heuristic",
    };
  }

  if (casualChat || taskCount <= 3) {
    return {
      role: "assistant",
      reason: "The request is conversational or a small task that does not need planning first.",
      source: "heuristic",
    };
  }

  return {
    role: "assistant",
    reason: "The request is best handled as a direct assistant response.",
    source: "heuristic",
  };
}


function parseRouterRole(content: string): RoutedRole | null {
  const normalized = content.trim().toLowerCase();
  const roles: RoutedRole[] = ["assistant", "planner", "coder", "auditor", "janitor"];

  for (const role of roles) {
    if (normalized === role || new RegExp(`\\b${role}\\b`).test(normalized)) {
      return role;
    }
  }

  return null;
}

function resolveSpeakingRole(role: Role | null): Role {
  return role === "router" || role === null ? "assistant" : role;
}

function roleLead(role: Role): string {
  switch (role) {
    case "router":
      return "Routing analysis";
    case "assistant":
      return "Operator-facing response";
    case "planner":
      return "Execution plan";
    case "coder":
      return "Implementation direction";
    case "auditor":
      return "Audit pass";
    case "janitor":
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

interface ExecutionContext {
  mode: ChatMode;
  settings: Awaited<ReturnType<typeof readSettings>>;
  providers: Provider[];
  secrets: Awaited<ReturnType<typeof readProviderSecrets>>;
  assignmentMap: Map<Role, RoleAssignment>;
  routeDecision: AutoRouteDecision | null;
  routedTo: Role | null;
  activeRole: Role;
  promptStack: ReturnType<typeof getPromptStack>;
  assignment: RoleAssignment | undefined;
  provider: Provider | null;
  responseModelId: string | null;
  routeNote: string | null;
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

function parseHandoffTarget(content: string): RoutedRole | null {
  const match = /^HANDOFF:\s*(coder|auditor|janitor|assistant)\b/im.exec(content);
  if (!match) return null;
  return match[1].trim().toLowerCase() as RoutedRole;
}

function buildHandoffContext(source: ExecutionContext, targetRole: RoutedRole): ExecutionContext {
  const assignment = source.assignmentMap.get(targetRole);
  const provider = source.providers.find((p) => p.id === assignment?.providerId) ?? null;
  const responseModelId =
    assignment?.modelId ?? provider?.config.defaultModelId ?? provider?.availableModels[0] ?? null;
  return {
    ...source,
    activeRole: targetRole,
    promptStack: getPromptStack(source.settings, targetRole),
    assignment,
    provider,
    responseModelId,
    routedTo: targetRole,
    routeNote: `Planner chained to ${targetRole}.`,
  };
}

async function resolveAutoRouteDecision(
  request: ChatRequest,
  settings: ExecutionContext["settings"],
  providers: Provider[],
  assignmentMap: Map<Role, RoleAssignment>,
  secrets: ExecutionContext["secrets"],
): Promise<AutoRouteDecision> {
  const routerAssignment = assignmentMap.get("router");
  const routerProvider =
    providers.find((candidate) => candidate.id === routerAssignment?.providerId) ?? null;

  if (!routerProvider) {
    throw createStatusError(409, "Auto mode requires a provider assigned to the router role.");
  }

  if (routerProvider.status !== "connected") {
    throw createStatusError(
      409,
      `Auto mode requires a connected router provider. ${routerProvider.name} is currently ${routerProvider.status}.`,
    );
  }

  if (!providerCanChat(routerProvider)) {
    throw createStatusError(
      409,
      `Auto mode requires a chat-capable router provider. ${routerProvider.name} cannot execute chat requests.`,
    );
  }

  try {
    console.log(`[router] calling ${routerProvider.name} (${routerAssignment?.modelId ?? "default model"})`);
    const routerExecution = await executeProviderChat(routerProvider, secrets, {
      modelId: routerAssignment?.modelId ?? null,
      promptStack: getPromptStack(settings, "router"),
      conversation: [],
      content: request.content,
      purpose: "route",
    });
    console.log(`[router] raw response: "${routerExecution.content}"`);
    const role = parseRouterRole(routerExecution.content);

    if (!role) {
      throw new Error(`Router returned an invalid role: "${routerExecution.content}"`);
    }

    console.log(`[router] parsed role: ${role} (source: router-llm)`);
    return {
      role,
      reason: `Router chose ${role}.`,
      source: "router-llm",
    };
  } catch (error) {
    console.warn(`[router] failed, using heuristic fallback. reason: ${error instanceof Error ? error.message : String(error)}`);
    const fallbackDecision = routeAutoRequestHeuristic(request.content);
    console.log(`[router] heuristic chose: ${fallbackDecision.role}`);
    return {
      ...fallbackDecision,
      reason: `Router failed, fallback chose ${fallbackDecision.role}.`,
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

  const routeDecision =
    mode === "auto"
      ? await resolveAutoRouteDecision(request, settings, providers, assignmentMap, secrets)
      : null;
  const routedTo = mode === "auto" ? resolveSpeakingRole(routeDecision?.role ?? null) : null;
  const activeRole = mode === "auto" ? routedTo ?? "assistant" : resolveSpeakingRole(mode);
  const promptStack = getPromptStack(settings, activeRole);
  const assignment = assignmentMap.get(activeRole);
  const provider = providers.find((candidate) => candidate.id === assignment?.providerId) ?? null;
  const responseModelId =
    assignment?.modelId ?? provider?.config.defaultModelId ?? provider?.availableModels[0] ?? null;
  const routeNote = routeDecision
    ? `Auto routed to ${routeDecision.role} via ${
        routeDecision.source === "router-llm" ? "router" : "fallback"
      }.`
    : null;

  return {
    mode,
    settings,
    providers,
    secrets,
    assignmentMap,
    routeDecision,
    routedTo,
    activeRole,
    promptStack,
    assignment,
    provider,
    responseModelId,
    routeNote,
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
): Promise<ChatExecutionResult> {
  const context = await prepareExecution(request);
  const provider = context.provider;
  if (!provider || provider.status !== "connected" || !providerCanChat(provider)) {
    resolveExecutionGuard(context);
  }

  if (requestHasImageAttachments(request) && !provider.capabilities.canUseImages) {
    throw createStatusError(
      409,
      `${provider.name} does not accept image inputs. Switch to an image-capable provider or remove the image.`,
    );
  }

  let responseContent: string;
  let responseThinking: string | null = null;
  let responseModelId = context.responseModelId;
  let executionNote = context.routeNote
    ? `${context.routeNote} Live response generated through ${provider.name}.`
    : `Live response generated through ${provider.name}.`;

  try {
    const execution = await executeProviderChat(provider, context.secrets, {
      modelId: context.assignment?.modelId ?? null,
      promptStack: context.promptStack,
      conversation: request.conversation,
      content: request.content,
    });

    responseContent = execution.content;
    responseThinking = execution.thinking ?? null;
    responseModelId = execution.modelId;
  } catch (error) {
    const executionNote = `${context.routeNote ? `${context.routeNote} ` : ""}Live provider execution failed: ${
      error instanceof Error ? error.message : "Unknown error."
    }`;
    throw createStatusError(502, executionNote);
  }

  const replyMessage = buildReplyMessage(
    context,
    request,
    responseContent,
    responseThinking,
    responseModelId,
    executionNote,
  );

  const messages: ChatMessage[] = [replyMessage];

  if (context.activeRole === "planner") {
    const handoffTarget = parseHandoffTarget(responseContent);
    if (handoffTarget) {
      const handoffCtx = buildHandoffContext(context, handoffTarget);
      const handoffProvider = handoffCtx.provider;
      if (handoffProvider && handoffProvider.status === "connected" && providerCanChat(handoffProvider)) {
        try {
          console.log(`[planner] HANDOFF detected → chaining to ${handoffTarget}`);
          const handoffExecution = await executeProviderChat(handoffProvider, context.secrets, {
            modelId: handoffCtx.assignment?.modelId ?? null,
            promptStack: handoffCtx.promptStack,
            conversation: [],
            content: responseContent,
          });
          messages.push(
            buildReplyMessage(
              handoffCtx,
              request,
              handoffExecution.content,
              handoffExecution.thinking ?? null,
              handoffExecution.modelId,
              `Planner chained to ${handoffTarget} via EMBER orchestration.`,
            ),
          );
        } catch (chainError) {
          console.warn(`[planner] chain to ${handoffTarget} failed: ${chainError instanceof Error ? chainError.message : String(chainError)}`);
        }
      } else {
        console.warn(`[planner] HANDOFF: ${handoffTarget} requested but provider not available.`);
      }
    }
  }

  const lastMessage = messages.at(-1)!;
  return {
    messages,
    activeRole: (lastMessage.authorRole as Role) ?? context.activeRole,
    providerId: lastMessage.providerId ?? provider.id,
    providerName: lastMessage.providerName ?? provider.name,
    modelId: lastMessage.modelId ?? responseModelId,
    promptStack: context.promptStack,
    routedTo: context.routedTo,
    conversationId: request.conversationId ?? null,
  };
}

const app = Fastify({
  bodyLimit: 12 * 1024 * 1024,
  logger: false,
});

await ensureDataFiles();

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

app.delete("/api/conversations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const conversations = await readConversations();
  const remaining = conversations.filter((item) => item.id !== id);

  if (remaining.length === conversations.length) {
    reply.code(404);
    return { error: "Conversation not found." };
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
    config: body.config ?? {},
    availableModels: [],
    capabilities: getProviderCapabilities(body.typeId),
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  providers.unshift(provider);
  await writeProviders(providers);

  if (body.secrets && Object.keys(body.secrets).length > 0) {
    secrets[provider.id] = body.secrets;
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

  const nextConfig = {
    ...provider.config,
    ...sanitizeRecord(body?.config),
  };

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
  if (!["router", "assistant", "planner", "coder", "auditor", "janitor"].includes(role)) {
    reply.code(400);
    return { error: "Unknown role." };
  }

  return {
    item: getPromptStack(settings, role),
  };
});

app.post("/api/chat", async (request) => {
  const body = request.body as ChatRequest;
  const result = await buildExecution(body);
  const conversation = await persistConversationFromResult(body, result);

  return {
    ...result,
    conversationId: conversation.id,
    conversation: toConversationSummary(conversation),
  };
});

app.post("/api/chat/stream", async (request, reply) => {
  const body = request.body as ChatRequest;

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const send = (event: ChatStreamEvent) => {
    reply.raw.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const context = await prepareExecution(body);

    if (context.routeDecision) {
      sendStreamEvent(send, {
        type: "status",
        phase: "routing",
        message:
          context.routeDecision.source === "router-llm"
            ? `Router chose ${context.routeDecision.role}.`
            : `Router fallback chose ${context.routeDecision.role}.`,
        role: context.routeDecision.role,
        providerName: null,
        modelId: null,
      });
    }

    const provider = context.provider;
    if (!provider || provider.status !== "connected" || !providerCanChat(provider)) {
      resolveExecutionGuard(context);
    }

    if (requestHasImageAttachments(body) && !provider.capabilities.canUseImages) {
      throw createStatusError(
        409,
        `${provider.name} does not accept image inputs. Switch to an image-capable provider or remove the image.`,
      );
    }

    sendStreamEvent(send, {
      type: "status",
      phase: "provider",
      message: `Using ${provider.name}${context.responseModelId ? ` with ${context.responseModelId}` : ""}.`,
      role: context.activeRole,
      providerName: provider.name,
      modelId: context.responseModelId,
    });

    let streamedContent = "";
    let streamedThinking = "";

    const execution = await streamProviderChat(
      provider,
      context.secrets,
      {
        modelId: context.assignment?.modelId ?? null,
        promptStack: context.promptStack,
        conversation: body.conversation,
        content: body.content,
      },
      {
        onStatus(message) {
          sendStreamEvent(send, {
            type: "status",
            phase: streamedContent ? "streaming" : "provider",
            message,
            role: context.activeRole,
            providerName: provider.name,
            modelId: context.responseModelId,
          });
        },
        onThinking(text) {
          streamedThinking += text;
          sendStreamEvent(send, {
            type: "thinking",
            text,
          });
        },
        onContent(text) {
          streamedContent += text;
          sendStreamEvent(send, {
            type: "content",
            text,
          });
        },
      },
    );

    const executionNote = [
      context.routeNote,
      `Live response generated through ${provider.name}.`,
      streamedThinking ? "Reasoning details were streamed during generation." : null,
    ]
      .filter(Boolean)
      .join(" ");

    const primaryMessage = buildReplyMessage(
      context,
      body,
      execution.content,
      execution.thinking ?? null,
      execution.modelId,
      executionNote,
    );
    const resultMessages: ChatMessage[] = [primaryMessage];

    if (context.activeRole === "planner") {
      const handoffTarget = parseHandoffTarget(execution.content);
      if (handoffTarget) {
        const handoffCtx = buildHandoffContext(context, handoffTarget);
        const handoffProvider = handoffCtx.provider;
        if (handoffProvider && handoffProvider.status === "connected" && providerCanChat(handoffProvider)) {
          sendStreamEvent(send, {
            type: "status",
            phase: "routing",
            message: `Planner complete — chaining to ${handoffTarget}...`,
            role: handoffTarget,
            providerName: handoffProvider.name,
            modelId: handoffCtx.responseModelId,
          });
          try {
            console.log(`[planner] HANDOFF detected → chaining to ${handoffTarget}`);
            let chainContent = "";
            let chainThinking = "";
            const chainExecution = await streamProviderChat(
              handoffProvider,
              context.secrets,
              {
                modelId: handoffCtx.assignment?.modelId ?? null,
                promptStack: handoffCtx.promptStack,
                conversation: [],
                content: execution.content,
              },
              {
                onContent(text) {
                  chainContent += text;
                  sendStreamEvent(send, { type: "content", text });
                },
                onThinking(text) {
                  chainThinking += text;
                  sendStreamEvent(send, { type: "thinking", text });
                },
                onStatus(message) {
                  sendStreamEvent(send, {
                    type: "status",
                    phase: "streaming",
                    message,
                    role: handoffCtx.activeRole,
                    providerName: handoffProvider.name,
                    modelId: handoffCtx.responseModelId,
                  });
                },
              },
            );
            resultMessages.push(
              buildReplyMessage(
                handoffCtx,
                body,
                chainExecution.content,
                chainExecution.thinking ?? null,
                chainExecution.modelId,
                `Planner chained to ${handoffTarget} via EMBER orchestration.`,
              ),
            );
          } catch (chainError) {
            console.warn(`[planner] stream chain to ${handoffTarget} failed: ${chainError instanceof Error ? chainError.message : String(chainError)}`);
          }
        } else {
          console.warn(`[planner] HANDOFF: ${handoffTarget} requested but provider not available.`);
        }
      }
    }

    const lastResultMessage = resultMessages.at(-1)!;
    const result: ChatExecutionResult = {
      messages: resultMessages,
      activeRole: (lastResultMessage.authorRole as Role) ?? context.activeRole,
      providerId: lastResultMessage.providerId ?? provider.id,
      providerName: lastResultMessage.providerName ?? provider.name,
      modelId: lastResultMessage.modelId ?? execution.modelId,
      promptStack: context.promptStack,
      routedTo: context.routedTo,
      conversationId: body.conversationId ?? null,
    };

    sendStreamEvent(send, {
      type: "status",
      phase: "saving",
      message: "Saving conversation...",
      role: context.activeRole,
      providerName: provider.name,
      modelId: execution.modelId,
    });

    const conversation = await persistConversationFromResult(body, result);
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
    reply.raw.end();
  }

  return reply;
});

app.listen({ host, port }).catch((error) => {
  console.error(error);
  process.exit(1);
});
