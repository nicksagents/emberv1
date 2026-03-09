import type { UiBlock } from "@ember/ui-schema";

export const ROLES = [
  "router",
  "assistant",
  "planner",
  "coder",
  "auditor",
  "janitor",
] as const;

export type Role = (typeof ROLES)[number];
export type ChatMode = Role | "auto";

export const CONNECTOR_TYPE_IDS = [
  "codex-cli",
  "claude-code-cli",
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
}

export interface ChatAttachment {
  id: string;
  kind: "image";
  name: string;
  mediaType: string;
  dataUrl: string;
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
  systemPrompts: {
    shared: string;
    roles: Record<Role, string>;
  };
  runtimeInfo: {
    webUrl: string;
    apiUrl: string;
  };
}

export interface RuntimeState {
  serverPid: number | null;
  webPid: number | null;
  startedAt: string | null;
  webUrl: string;
  apiUrl: string;
  status: "idle" | "starting" | "running" | "error";
}

export interface ProviderSecrets {
  [providerId: string]: Record<string, string>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "system" | "assistant";
  authorRole: Role | "assistant" | "user";
  mode: ChatMode;
  content: string;
  attachments?: ChatAttachment[];
  thinking?: string | null;
  createdAt: string;
  providerId?: string | null;
  providerName?: string | null;
  modelId?: string | null;
  routedTo?: Role | null;
  blocks?: UiBlock[];
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
      type: "content";
      text: string;
    }
  | {
      type: "complete";
      message: ChatMessage;
      conversationId: string | null;
      conversation?: ConversationSummary;
    }
  | {
      type: "error";
      message: string;
      statusCode?: number;
    };

export interface Conversation {
  id: string;
  title: string;
  mode: ChatMode;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  preview: string;
  messageCount: number;
  messages: ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: ChatMode;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  preview: string;
  messageCount: number;
}

export interface ProviderExecutionRequest {
  modelId: string | null;
  promptStack: PromptStack;
  conversation: ChatMessage[];
  content: string;
  purpose?: "chat" | "route";
}

export interface ProviderExecutionResult {
  content: string;
  modelId: string | null;
  thinking?: string | null;
}
