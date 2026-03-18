import type { UiBlock } from "@ember/ui-schema";
import type { MemoryConfig, MemoryPromptContext } from "./memory/types";

export const ROLES = [
  "dispatch",
  "coordinator",
  "advisor",
  "director",
  "inspector",
  "ops",
] as const;

export type Role = (typeof ROLES)[number];
export type ChatMode = Role | "auto";

export const CONNECTOR_TYPE_IDS = [
  "codex-cli",
  "anthropic-api",
  "openai-compatible",
] as const;

export type ConnectorTypeId = (typeof CONNECTOR_TYPE_IDS)[number];
export type ProviderStatus =
  | "idle"
  | "connected"
  | "needs-auth"
  | "missing"
  | "error";

export interface ConnectorType {
  id: ConnectorTypeId;
  name: string;
  description: string;
  kind: "cli" | "api" | "endpoint";
  setupFields: string[];
}

export interface ProviderCapabilities {
  canChat: boolean;
  canListModels: boolean;
  requiresBrowserAuth: boolean;
  canUseImages: boolean;
  canUseTools: boolean;
}

export interface ChatAttachmentBase {
  id: string;
  name: string;
  mediaType: string;
  sourceId?: string | null;
  sourceName?: string | null;
  pageNumber?: number | null;
}

export interface ChatImageAttachment extends ChatAttachmentBase {
  kind: "image";
  dataUrl: string;
}

export interface ChatTextAttachment extends ChatAttachmentBase {
  kind: "text";
  text: string;
  language?: string | null;
  truncated?: boolean;
}

export type ChatAttachment = ChatImageAttachment | ChatTextAttachment;

export interface ChatAttachmentUpload {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
}

export interface PreparedAttachmentGroup {
  sourceId: string;
  sourceName: string;
  sourceMediaType: string;
  attachments: ChatAttachment[];
  summary: string;
  warnings?: string[];
}

export interface Provider {
  id: string;
  name: string;
  typeId: ConnectorTypeId;
  status: ProviderStatus;
  config: Record<string, string>;
  availableModels: string[];
  capabilities: ProviderCapabilities;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleAssignment {
  role: Role;
  providerId: string | null;
  modelId: string | null;
}

export interface Settings {
  humanName: string;
  workspaceRoot: string;
  themePreference: string;
  tailscaleStatus: string;
  sudoPassword: string;
  braveApiKey: string;
  compression: {
    enabled: boolean;
    contextWindowTokens: number;
    toolLoopLimit: number;
    responseHeadroomTokens: number;
    safetyMarginTokens: number;
    maxPromptTokens: number;
    targetPromptTokens: number;
    preserveRecentMessages: number;
    minimumRecentMessages: number;
  };
  systemPrompts: {
    shared: string;
    roles: Record<Role, string>;
  };
  runtimeInfo: {
    webUrl: string;
    apiUrl: string;
  };
  customTools: {
    trustMode: "disabled" | "local-only" | "allow";
  };
  agent?: {
    autoSimulate?: boolean;
  };
  memory: MemoryConfig;
  simulation?: {
    defaultPersonaCount?: number;
    defaultRoundCount?: number;
    maxConcurrency?: number;
    personaTimeoutMs?: number;
    autoRetryOnParseFail?: boolean;
    providerModelPool?: Array<{
      providerId: string;
      modelId: string;
      usage: "persona" | "synthesis" | "both";
      priority?: number;
      enabled?: boolean;
      replicas?: number;
      weight?: number;
      minPersonaSlotsPerRound?: number;
    }>;
    providerUsePolicy?: {
      strategy?: "use-all-selected" | "weighted-distribution" | "tier-strict";
      enforceAllProvidersPerRun?: boolean;
      allowReplicaBurst?: boolean;
      fallbackStrategy?: "continue-with-remaining" | "retry-on-same-tier" | "fail-fast";
      minDistinctProviders?: number;
    };
    compactMode?: boolean;
  };
}

export interface SettingsSecrets {
  sudoPassword: string;
  braveApiKey: string;
}

export interface RuntimeState {
  serverPid: number | null;
  webPid: number | null;
  startedAt: string | null;
  webUrl: string;
  apiUrl: string;
  status: "idle" | "starting" | "running" | "stopping" | "error";
}

export interface ProviderSecrets {
  [providerId: string]: Record<string, string>;
}

export type CredentialKind = "website" | "application" | "service" | "other";
export type CredentialSecretBackend = "os-keychain" | "local-file" | "mock" | "none";

export interface CredentialEntry {
  id: string;
  label: string;
  target: string | null;
  kind: CredentialKind;
  username: string | null;
  email: string | null;
  password: string | null;
  loginUrl: string | null;
  appName: string | null;
  notes: string | null;
  tags: string[];
  hasSecret: boolean;
  secretBackend: CredentialSecretBackend;
  secretRef: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  status: "pending" | "running" | "complete" | "error";
  startedAt: string;
  endedAt?: string;
}

export interface ChatHistorySummaryMeta {
  kind: "history-summary";
  sourceMessageCount: number;
  sourceToolCallCount: number;
  generatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "system" | "assistant";
  authorRole: Role | "user";
  mode: ChatMode;
  content: string;
  attachments?: ChatAttachment[];
  thinking?: string | null;
  toolCalls?: ToolCall[];
  createdAt: string;
  providerId?: string | null;
  providerName?: string | null;
  modelId?: string | null;
  routedTo?: Role | null;
  blocks?: UiBlock[];
  historySummary?: ChatHistorySummaryMeta | null;
  usage?: TokenUsage | null;
}

export interface ChatRequest {
  mode: ChatMode;
  content: string;
  conversation: ChatMessage[];
  conversationId?: string | null;
}

export interface PromptStack {
  shared: string;
  role: string;
  tools: string;
}

export interface ChatExecutionResult {
  messages: ChatMessage[];
  activeRole: Role;
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  promptStack: PromptStack;
  routedTo: Role | null;
  conversationId?: string | null;
}

export type ChatStreamEvent =
  | {
      type: "status";
      phase: "routing" | "provider" | "streaming" | "saving";
      message: string;
      role?: Role | null;
      providerName?: string | null;
      modelId?: string | null;
    }
  | {
      type: "thinking";
      text: string;
    }
  | {
      type: "toolCall";
      toolCall: ToolCall;
    }
  | {
      type: "content";
      text: string;
    }
  | {
      type: "simulation";
      event: SimulationStreamEvent;
    }
  | {
      type: "complete";
      message: ChatMessage;
      conversationId: string | null;
      conversation?: ConversationSummary;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: "error";
      message: string;
      statusCode?: number;
    };

// ─── Simulation Stream Events (for real-time chat visualization) ────────────

export type SimulationStreamEvent =
  | { type: "sim:start"; simulationId: string; title: string; scenario: string; personaCount: number; roundCount: number; domain: string }
  | { type: "sim:persona"; simulationId: string; persona: { id: string; name: string; role: string; perspective: string; background: string } }
  | { type: "sim:round-start"; simulationId: string; round: number; totalRounds: number }
  | { type: "sim:persona-response"; simulationId: string; round: number; personaId: string; personaName: string; confidence: number; content: string; providerId?: string; modelId?: string }
  | { type: "sim:round-synthesis"; simulationId: string; round: number; synthesis: string }
  | { type: "sim:round-complete"; simulationId: string; round: number }
  | { type: "sim:final"; simulationId: string; synthesis: string; probabilities: Record<string, number> | null }
  | { type: "sim:complete"; simulationId: string; duration: number }
  | { type: "sim:error"; simulationId: string; error: string };

export interface ConversationUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  messageCount: number;
  toolCallCount: number;
  providerUsage: Record<string, { inputTokens: number; outputTokens: number }>;
}

export interface Conversation {
  id: string;
  title: string;
  mode: ChatMode;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastMessageAt: string | null;
  preview: string;
  messageCount: number;
  messages: ChatMessage[];
  usage?: ConversationUsage;
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: ChatMode;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastMessageAt: string | null;
  preview: string;
  messageCount: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * JSON Schema describing the tool's input parameters.
   * `properties` accepts the full JSON Schema property definition so MCP tools
   * with nested types, enums, and anyOf can round-trip without stripping.
   * The connectors package maps this to `input_schema` (Anthropic) or
   * `parameters` (OpenAI-compatible) when sending to the LLM API.
   */
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** A tool result that includes both text and an optional screenshot/image. */
export interface ToolImageResult {
  text: string;
  imageBase64: string;
  imageMimeType: "image/png" | "image/jpeg" | "image/webp";
}

/** What a tool's execute() function may return. */
export type ToolResult = string | ToolImageResult;

export interface ProviderExecutionRequest {
  modelId: string | null;
  toolLoopLimit?: number | null;
  /** Effective context window for this provider, resolved from settings + provider config.
   *  Used by the driver for tool-loop compaction budget. */
  contextWindowTokens?: number | null;
  promptStack: PromptStack;
  memoryContext?: MemoryPromptContext | null;
  procedureContext?: MemoryPromptContext | null;
  conversation: ChatMessage[];
  content: string;
  role?: Role;
  purpose?: "chat" | "route";
  tools?: ToolDefinition[];
  onToolCall?: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  onProviderSuccess?: (providerId: string) => void;
  onProviderFailure?: (providerId: string, message: string) => void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderExecutionResult {
  content: string;
  modelId: string | null;
  thinking?: string | null;
  usage?: TokenUsage | null;
}

export interface TaskOutcome {
  taskDescription: string;
  approach: string;
  result: "success" | "failure" | "partial";
  failureReason?: string;
  toolsUsed: string[];
  providerUsed: string;
  modelUsed: string;
  duration: number;
  timestamp: string;
}
