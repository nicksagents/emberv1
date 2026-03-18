"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  ConnectorType,
  ConnectorTypeId,
  Provider,
  Role,
  RoleAssignment,
  RuntimeState,
  Settings,
} from "@ember/core/client";
import {
  isLocalOpenAiCompatibleBaseUrl,
  MAX_PROVIDER_TOOL_LOOP_LIMIT,
  MIN_CONTEXT_WINDOW_TOKENS,
  ROLES,
} from "@ember/core/client";
import type { McpServerConfig } from "@ember/core/mcp";

import { clientApiPath } from "../lib/api";
import { SimulationHistory } from "./simulation-history";

interface ProviderView extends Provider {
  connectorType: ConnectorType | null;
}

interface ProviderEditorState {
  name: string;
  baseUrl: string;
  defaultModelId: string;
  contextWindowTokens: string;
  apiKey: string;
}

interface ProviderPreset {
  name: string;
  description: string;
  requiresKey: boolean;
  keyPlaceholder?: string;
  keyHelp?: string;
  baseUrl?: string;
  setupNote: string;
}

const PROVIDER_PRESETS: Record<ConnectorTypeId, ProviderPreset> = {
  "codex-cli": {
    name: "Codex CLI",
    description: "Use your local Codex login, discovered models, and EMBER tool support.",
    requiresKey: false,
    setupNote: "Model choices come from your local Codex CLI session on this machine.",
  },
  "anthropic-api": {
    name: "Anthropic API",
    description: "Connect with an API key and fetch the available Claude models automatically.",
    requiresKey: true,
    keyPlaceholder: "sk-ant-...",
    keyHelp: "The runtime pulls your available models from Anthropic after connect.",
    setupNote: "No manual model entry. EMBER fetches the current model catalog for this key.",
  },
  "openai-compatible": {
    name: "OpenAI-Compatible Endpoint",
    description: "Connect OpenAI or a local model server and fetch models from the /models endpoint.",
    requiresKey: false,
    keyPlaceholder: "sk-... (optional for local)",
    keyHelp: "Leave blank for local endpoints that do not require auth.",
    baseUrl: "http://127.0.0.1:11434/v1",
    setupNote: "EMBER calls /models on the endpoint so users do not need to type model ids manually.",
  },
};

interface QuickPreset {
  id: string;
  label: string;
  tagline: string;
  typeId: ConnectorTypeId;
  baseUrl?: string;
  apiKeyPlaceholder?: string;
  apiKeyRequired: boolean;
  defaultModelSuggestion?: string;
}

type McpConfigScope = "default" | "user" | "project";

interface McpServerStatus {
  name: string;
  sourceScope: McpConfigScope;
  config: McpServerConfig;
  roles: Role[];
  toolNames: string[];
  status: "running" | "error" | "disabled" | "configured";
  lastError: string | null;
  activeCalls?: number;
  target?: string;
}

interface McpState {
  layers: Array<{
    scope: McpConfigScope;
    path: string;
    exists: boolean;
    serverCount: number;
  }>;
  items: McpServerStatus[];
  merged: Array<{
    name: string;
    sourceScope: McpConfigScope;
    config: McpServerConfig;
    target?: string;
  }>;
  stats: {
    configuredServers: number;
    runningServers: number;
    drainingServers?: number;
    activeTools: number;
    activeCalls?: number;
  };
}

interface SettingsSecretStatus {
  sudoPasswordSet: boolean;
  braveApiKeySet: boolean;
}

interface TerminalApproval {
  id: string;
  sessionKey: string;
  command: string;
  reasons: string[];
  createdAt: string;
  expiresAt: string;
}

interface CheckpointSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
  turnKey: string | null;
  scopeDir: string;
  snapshotCount: number;
}

function ProviderIcon({ id }: { id: string }) {
  switch (id) {
    case "claude-api":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <rect x="2.5" y="8" width="2.6" height="8" rx="1.3" fill="currentColor" />
          <rect x="6.8" y="4" width="2.6" height="16" rx="1.3" fill="currentColor" />
          <rect x="11.1" y="2" width="2.6" height="20" rx="1.3" fill="currentColor" />
          <rect x="15.4" y="4" width="2.6" height="16" rx="1.3" fill="currentColor" />
          <rect x="19.7" y="8" width="2.6" height="8" rx="1.3" fill="currentColor" />
        </svg>
      );
    case "gemini":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M12 2C11.4 6.5 9.2 9.2 6 12c3.2 2.8 5.4 5.5 6 10 .6-4.5 2.8-7.2 6-10-3.2-2.8-5.4-5.5-6-10z"
            fill="currentColor"
          />
        </svg>
      );
    case "kimi":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 1 0 9.79 9.79z"
            fill="currentColor"
          />
        </svg>
      );
    case "deepseek":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M5 5h6a7 7 0 0 1 0 14H5V5zm3.5 3v8H11a3.5 3.5 0 0 0 0-7H8.5z M15.5 16.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0z"
            fill="currentColor"
          />
        </svg>
      );
    case "codex":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
          <path d="M8 8 4 12l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M16 8l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14 5l-4 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "local":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
          <rect x="2" y="3" width="20" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M8 21h8M12 16v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="9.5" r="2" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}

const QUICK_PRESETS: QuickPreset[] = [
  {
    id: "claude-api",
    label: "Claude",
    tagline: "Anthropic API",
    typeId: "anthropic-api",
    apiKeyPlaceholder: "sk-ant-...",
    defaultModelSuggestion: "claude-sonnet-4-5",
    apiKeyRequired: true,
  },
  {
    id: "gemini",
    label: "Gemini",
    tagline: "Google AI",
    typeId: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyPlaceholder: "AIza...",
    defaultModelSuggestion: "gemini-2.0-flash",
    apiKeyRequired: true,
  },
  {
    id: "kimi",
    label: "Kimi",
    tagline: "Moonshot AI",
    typeId: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyPlaceholder: "sk-...",
    defaultModelSuggestion: "moonshot-v1-8k",
    apiKeyRequired: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    tagline: "DeepSeek AI",
    typeId: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyPlaceholder: "sk-...",
    defaultModelSuggestion: "deepseek-chat",
    apiKeyRequired: true,
  },
  {
    id: "codex",
    label: "Codex",
    tagline: "CLI · browser login",
    typeId: "codex-cli",
    apiKeyRequired: false,
  },
  {
    id: "local",
    label: "Local",
    tagline: "Ollama · LM Studio",
    typeId: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyRequired: false,
  },
];

const MIN_SWARM_PERSONAS = 8;
const MAX_SWARM_PERSONAS = 200;
const MIN_SWARM_ROUNDS = 1;
const MAX_SWARM_ROUNDS = 120;
const MIN_SWARM_CONCURRENCY = 1;
const MAX_SWARM_CONCURRENCY = 32;

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

const ROLE_DETAILS: Record<Role, { title: string; description: string }> = {
  dispatch: {
    title: "Dispatch",
    description: "Chooses the best role when chat is running in auto mode.",
  },
  coordinator: {
    title: "Coordinator",
    description: "Default operator for most tasks, including browsing, research, and routine execution.",
  },
  advisor: {
    title: "Advisor",
    description: "Planning-first role for architecture, scoping, sequencing, and tradeoffs.",
  },
  director: {
    title: "Director",
    description: "Implements product, UI, and code changes across the workspace.",
  },
  inspector: {
    title: "Inspector",
    description: "Reviews work, validates browser/UI behavior, and produces findings.",
  },
  ops: {
    title: "Ops",
    description: "Cleans up formatting, naming, and low-risk polish tasks.",
  },
};

type SettingsPanelId = "general" | "providers" | "roles" | "mcp" | "prompts" | "simulation";
type McpInstallTransport = "package" | "sse" | "streamable-http";

// ── MCP Service Keys ─────────────────────────────────────────────────────────

interface McpServiceKeyDef {
  /** MCP server name in mcp.default.json */
  serverName: string;
  /** Human-readable service label */
  label: string;
  /** Short description shown under the label */
  description: string;
  /** Env var name → input placeholder */
  envKeys: Array<{
    key: string;
    label: string;
    placeholder: string;
    helpUrl?: string;
    /** If false the field is shown as plain text (e.g. email, URL). Defaults to true. */
    sensitive?: boolean;
  }>;
}

const MCP_SERVICE_KEYS: McpServiceKeyDef[] = [
  {
    serverName: "github",
    label: "GitHub",
    description: "Repos, issues, PRs, and code search via the GitHub API.",
    envKeys: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "Personal Access Token",
        placeholder: "ghp_...",
        helpUrl: "https://github.com/settings/tokens",
      },
    ],
  },
  {
    serverName: "brave-search",
    label: "Brave Search",
    description: "Web and local search powered by the Brave Search API.",
    envKeys: [
      {
        key: "BRAVE_API_KEY",
        label: "API Key",
        placeholder: "BSA...",
        helpUrl: "https://brave.com/search/api/",
      },
    ],
  },
  {
    serverName: "slack",
    label: "Slack",
    description: "Read channels, post messages, and search Slack conversations.",
    envKeys: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot Token",
        placeholder: "xoxb-...",
        helpUrl: "https://api.slack.com/apps",
      },
      {
        key: "SLACK_TEAM_ID",
        label: "Team ID",
        placeholder: "T0123456789",
        sensitive: false,
      },
    ],
  },
  {
    serverName: "gitlab",
    label: "GitLab",
    description: "Projects, issues, merge requests, and repo operations.",
    envKeys: [
      {
        key: "GITLAB_PERSONAL_ACCESS_TOKEN",
        label: "Personal Access Token",
        placeholder: "glpat-...",
        helpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
      },
      {
        key: "GITLAB_API_URL",
        label: "API URL",
        placeholder: "https://gitlab.com/api/v4",
        sensitive: false,
      },
    ],
  },
  {
    serverName: "google-maps",
    label: "Google Maps",
    description: "Geocoding, directions, place search, and distance calculations.",
    envKeys: [
      {
        key: "GOOGLE_MAPS_API_KEY",
        label: "API Key",
        placeholder: "AIza...",
        helpUrl: "https://console.cloud.google.com/apis/credentials",
      },
    ],
  },
  {
    serverName: "postgres",
    label: "PostgreSQL",
    description: "Read-only schema inspection and SELECT queries.",
    envKeys: [
      {
        key: "_POSTGRES_CONNECTION_STRING",
        label: "Connection String",
        placeholder: "postgres://user:pass@host:5432/db",
        sensitive: false,
      },
    ],
  },
  // ── Email ──────────────────────────────────────────────────────────────
  {
    serverName: "gmail",
    label: "Gmail",
    description: "Read, search, send, and manage Gmail emails via IMAP/SMTP.",
    envKeys: [
      {
        key: "GMAIL_EMAIL",
        label: "Gmail Address",
        placeholder: "you@gmail.com",
        sensitive: false,
      },
      {
        key: "GMAIL_APP_PASSWORD",
        label: "App Password",
        placeholder: "xxxx xxxx xxxx xxxx",
        helpUrl: "https://myaccount.google.com/apppasswords",
      },
    ],
  },
  {
    serverName: "outlook-mail",
    label: "Outlook / Microsoft 365",
    description: "Read, send, search Outlook/365 emails via Microsoft Graph API.",
    envKeys: [
      {
        key: "MICROSOFT_CLIENT_ID",
        label: "Azure App Client ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        helpUrl: "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps",
        sensitive: false,
      },
      {
        key: "MICROSOFT_TENANT_ID",
        label: "Tenant ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        sensitive: false,
      },
    ],
  },
];

const SETTINGS_PANELS: Array<{
  id: SettingsPanelId;
  label: string;
  description: string;
}> = [
  {
    id: "general",
    label: "General",
    description: "Profile and workspace",
  },
  {
    id: "providers",
    label: "Providers",
    description: "Connections and models",
  },
  {
    id: "roles",
    label: "Roles",
    description: "Provider routing",
  },
  {
    id: "mcp",
    label: "MCP",
    description: "Global tool servers",
  },
  {
    id: "prompts",
    label: "Prompts",
    description: "System overrides",
  },
  {
    id: "simulation",
    label: "Simulation",
    description: "Swarm settings",
  },
];

function scoreModel(modelId: string): number {
  const normalized = modelId.toLowerCase();
  let score = 0;

  if (/latest|default|recommended/.test(normalized)) score += 300;
  if (/opus/.test(normalized)) score += 220;
  if (/sonnet/.test(normalized)) score += 210;
  if (/codex/.test(normalized)) score += 205;
  if (/gpt-5/.test(normalized)) score += 200;
  if (/gpt-4\.1|gpt-4-1/.test(normalized)) score += 180;
  if (/gpt-4o/.test(normalized)) score += 170;
  if (/gpt-4/.test(normalized)) score += 160;
  if (/claude/.test(normalized)) score += 150;
  if (/qwen/.test(normalized)) score += 120;
  if (/llama/.test(normalized)) score += 110;
  if (/mistral|mixtral/.test(normalized)) score += 100;

  const digitMatches = normalized.match(/\d+/g) ?? [];
  for (const value of digitMatches) {
    score += Number(value) / 100;
  }

  return score;
}

function normalizeModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))].sort((left, right) => {
    const scoreDifference = scoreModel(right) - scoreModel(left);
    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return right.localeCompare(left, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function getBestModel(models: string[]): string | null {
  return normalizeModels(models)[0] ?? null;
}

function getProviderModels(
  provider: Provider,
  modelCatalog: Partial<Record<ConnectorTypeId, string[]>>,
): string[] {
  return normalizeModels([
    ...provider.availableModels,
    ...(provider.typeId === "codex-cli" ? modelCatalog[provider.typeId] ?? [] : []),
    provider.config.defaultModelId ?? "",
  ]);
}

function getStatusLabel(provider: Provider, modelCount: number): string {
  if (provider.status === "connected") {
    if (modelCount > 0 && provider.capabilities.canChat) {
      return `${modelCount} models`;
    }
    if (modelCount > 0 && !provider.capabilities.canChat) {
      return `${modelCount} models, pending`;
    }
    return "Connected";
  }
  if (provider.status === "needs-auth") {
    return "Auth required";
  }
  if (provider.status === "missing") {
    return "Not installed";
  }
  if (provider.status === "error") {
    return "Error";
  }
  return "Unchecked";
}

function getProviderTypeLabel(provider: ProviderView): string {
  return provider.connectorType?.name ?? PROVIDER_PRESETS[provider.typeId].name;
}

function getProviderAuthLabel(provider: Provider): string {
  if (provider.typeId === "codex-cli") {
    return "Local CLI session";
  }
  return provider.capabilities.requiresBrowserAuth ? "Browser sign-in" : "API key";
}

function getProviderSummary(provider: ProviderView, modelCount: number): string {
  if (provider.status === "connected") {
    if (modelCount > 0) {
      return provider.capabilities.canChat
        ? "Connected and ready to use"
        : "Connected. Models found, chat pending";
    }
    return "Connected. Refresh after authentication";
  }
  if (provider.status === "needs-auth") {
    return provider.capabilities.requiresBrowserAuth
      ? "Finish sign-in to discover models"
      : "Add credentials and refresh";
  }
  if (provider.status === "missing") {
    return "Install the required local connector";
  }
  if (provider.status === "error") {
    return "Connection check failed";
  }
  return "Run a connection check to discover models";
}

function getProviderContextWindowLabel(provider: Provider): string {
  if (provider.typeId === "codex-cli" || provider.typeId === "anthropic-api") {
    return "Auto 300k window";
  }
  if (provider.typeId === "openai-compatible") {
    if (isLocalOpenAiCompatibleBaseUrl(provider.config.baseUrl)) {
      return provider.config.contextWindowTokens?.trim()
        ? `${provider.config.contextWindowTokens.trim()} tokens`
        : "Local default 100k";
    }
    return "Auto 300k window";
  }
  return "Auto";
}

function validateContextWindowTokensInput(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return "Context window must be a number.";
  }
  if (Math.floor(parsed) < MIN_CONTEXT_WINDOW_TOKENS) {
    return `Context window must be at least ${MIN_CONTEXT_WINDOW_TOKENS.toLocaleString()} tokens.`;
  }

  return null;
}

function deriveProviderName(typeId: ConnectorTypeId, baseUrl: string): string {
  if (typeId === "codex-cli") {
    return "Codex CLI";
  }
  if (typeId === "anthropic-api") {
    return "Anthropic API";
  }
  try {
    const url = new URL(baseUrl);
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(url.hostname)) {
      return "Local Model Server";
    }
    if (/openai\.com$/i.test(url.hostname)) return "OpenAI API";
    if (/googleapis\.com$/i.test(url.hostname)) return "Gemini";
    if (/moonshot\.cn$/i.test(url.hostname)) return "Kimi";
    if (/deepseek\.com$/i.test(url.hostname)) return "DeepSeek";
    return url.hostname;
  } catch {
    return "OpenAI-Compatible Endpoint";
  }
}

function formatStartedAt(value: string | null): string {
  if (!value) {
    return "Not running";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatMcpScope(scope: McpConfigScope): string {
  if (scope === "default") {
    return "Bundled";
  }
  return scope[0].toUpperCase() + scope.slice(1);
}

function formatMcpStatus(status: McpServerStatus["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "error":
      return "Error";
    case "disabled":
      return "Disabled";
    case "configured":
      return "Configured";
  }
}

function formatMcpTransport(config: McpServerConfig): string {
  if (config.httpUrl?.trim()) {
    return "Streamable HTTP";
  }
  if (config.url?.trim()) {
    return "SSE";
  }
  return "stdio";
}

function formatMcpTarget(config: McpServerConfig, target?: string): string {
  if (target?.trim()) {
    return target;
  }
  if (config.httpUrl?.trim()) {
    return config.httpUrl.trim();
  }
  if (config.url?.trim()) {
    return config.url.trim();
  }
  return [config.command?.trim() ?? "", ...(config.args ?? [])].filter(Boolean).join(" ").trim();
}

function createProviderEditorState(provider: Provider): ProviderEditorState {
  return {
    name: provider.name,
    baseUrl: provider.config.baseUrl ?? PROVIDER_PRESETS["openai-compatible"].baseUrl ?? "",
    defaultModelId: provider.config.defaultModelId ?? "",
    contextWindowTokens: provider.config.contextWindowTokens ?? "",
    apiKey: "",
  };
}

function sanitizeRoleAssignments(assignments: RoleAssignment[]): RoleAssignment[] {
  return assignments.map(({ role, providerId, modelId }) => ({
    role,
    providerId,
    modelId,
  }));
}

export function SettingsClient({
  initialSettings,
  initialSettingsSecretStatus,
  runtime,
  initialProviders,
  connectorTypes,
  modelCatalog,
  initialAssignments,
  initialMcpState,
}: {
  initialSettings: Settings;
  initialSettingsSecretStatus: SettingsSecretStatus;
  runtime: RuntimeState;
  initialProviders: ProviderView[];
  connectorTypes: ConnectorType[];
  modelCatalog: Partial<Record<ConnectorTypeId, string[]>>;
  initialAssignments: RoleAssignment[];
  initialMcpState: McpState;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [settingsSecretStatus, setSettingsSecretStatus] = useState(initialSettingsSecretStatus);
  const [providers, setProviders] = useState(initialProviders);
  const [assignments, setAssignments] = useState(() => sanitizeRoleAssignments(initialAssignments));
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [savedAssignments, setSavedAssignments] = useState(() =>
    sanitizeRoleAssignments(initialAssignments),
  );
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; message: string } | null>(null);

  const [showAddProvider, setShowAddProvider] = useState(false);
  const [selectedProviderType, setSelectedProviderType] = useState<ConnectorTypeId | null>(null);
  const [providerName, setProviderName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS["openai-compatible"].baseUrl ?? "");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [contextWindowTokens, setContextWindowTokens] = useState("");
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerEditor, setProviderEditor] = useState<ProviderEditorState | null>(null);
  const [activePanel, setActivePanel] = useState<SettingsPanelId>("general");
  const [selectedQuickPresetId, setSelectedQuickPresetId] = useState<string | null>(null);
  const [mcpState, setMcpState] = useState(initialMcpState);
  const [mcpBusyKey, setMcpBusyKey] = useState<string | null>(null);
  const [mcpInstallTransport, setMcpInstallTransport] = useState<McpInstallTransport>("package");
  const [mcpPackageName, setMcpPackageName] = useState("");
  const [mcpRemoteUrl, setMcpRemoteUrl] = useState("");
  const [mcpServerName, setMcpServerName] = useState("");
  const [mcpScope, setMcpScope] = useState<Exclude<McpConfigScope, "default">>("project");
  const [mcpDescription, setMcpDescription] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpHeaders, setMcpHeaders] = useState("");
  const [mcpTimeout, setMcpTimeout] = useState("30000");
  const [mcpRoles, setMcpRoles] = useState<Role[]>(["coordinator", "director", "inspector"]);
  const [terminalApprovals, setTerminalApprovals] = useState<TerminalApproval[]>([]);
  const [terminalApprovalBusyId, setTerminalApprovalBusyId] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [checkpointBusyId, setCheckpointBusyId] = useState<string | null>(null);

  // Service key state: serverName → envKey → value
  const [serviceKeys, setServiceKeys] = useState<Record<string, Record<string, string>>>(() => {
    const keys: Record<string, Record<string, string>> = {};
    for (const def of MCP_SERVICE_KEYS) {
      const server = initialMcpState.items.find((s) => s.name === def.serverName)
        ?? initialMcpState.merged.find((s) => s.name === def.serverName);
      const env = server?.config?.env ?? {};
      keys[def.serverName] = {};
      for (const envDef of def.envKeys) {
        keys[def.serverName][envDef.key] = env[envDef.key] ?? "";
      }
    }
    return keys;
  });
  const [serviceKeySaving, setServiceKeySaving] = useState<string | null>(null);

  const providerMap = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );

  const providerModelsMap = useMemo(
    () =>
      new Map(
        providers.map((provider) => [provider.id, getProviderModels(provider, modelCatalog)]),
      ),
    [modelCatalog, providers],
  );

  const connectedProviders = useMemo(
    () => providers.filter((provider) => provider.status === "connected"),
    [providers],
  );

  const roleReadyProviders = useMemo(
    () =>
      providers.filter((provider) => {
        const models = providerModelsMap.get(provider.id) ?? [];
        return provider.status === "connected" && provider.capabilities.canChat && models.length > 0;
      }),
    [providerModelsMap, providers],
  );

  const orderedProviders = useMemo(() => {
    const statusWeight: Record<Provider["status"], number> = {
      connected: 0,
      "needs-auth": 1,
      idle: 2,
      error: 3,
      missing: 4,
    };

    return [...providers].sort((left, right) => {
      const statusDifference = statusWeight[left.status] - statusWeight[right.status];
      if (statusDifference !== 0) {
        return statusDifference;
      }

      const leftModels = providerModelsMap.get(left.id)?.length ?? 0;
      const rightModels = providerModelsMap.get(right.id)?.length ?? 0;
      if (rightModels !== leftModels) {
        return rightModels - leftModels;
      }

      return left.name.localeCompare(right.name);
    });
  }, [providerModelsMap, providers]);

  const selectedCliModels =
    selectedProviderType && selectedProviderType === "codex-cli"
      ? normalizeModels(modelCatalog[selectedProviderType] ?? [])
      : [];
  const isCreatingLocalOpenAiEndpoint =
    selectedProviderType === "openai-compatible" &&
    isLocalOpenAiCompatibleBaseUrl(baseUrl.trim());
  const createContextWindowError = isCreatingLocalOpenAiEndpoint
    ? validateContextWindowTokensInput(contextWindowTokens)
    : null;

  const assignedRoleCount = assignments.filter(
    (assignment) => assignment.providerId && assignment.modelId,
  ).length;
  const normalizedAssignments = useMemo(
    () => sanitizeRoleAssignments(assignments),
    [assignments],
  );
  const hasWorkspaceChanges = useMemo(
    () =>
      JSON.stringify(settings) !== JSON.stringify(savedSettings) ||
      JSON.stringify(normalizedAssignments) !== JSON.stringify(savedAssignments),
    [normalizedAssignments, savedAssignments, savedSettings, settings],
  );
  const simulationPool = settings.simulation?.providerModelPool ?? [];
  const configuredPersonaInstances = useMemo(
    () =>
      simulationPool.reduce((sum, entry) => {
        if (entry.enabled === false || entry.usage === "synthesis") return sum;
        return sum + clampInt(entry.replicas ?? 1, 1, MAX_SWARM_PERSONAS);
      }, 0),
    [simulationPool],
  );
  const targetSimulationPersonas = clampInt(
    settings.simulation?.defaultPersonaCount ?? MIN_SWARM_PERSONAS,
    MIN_SWARM_PERSONAS,
    MAX_SWARM_PERSONAS,
  );
  const simulationDeploymentMismatch = configuredPersonaInstances !== targetSimulationPersonas;

  useEffect(() => {
    if (roleReadyProviders.length === 0) {
      return;
    }

    setAssignments((current) =>
      current.map((assignment) => {
        if (assignment.providerId && assignment.modelId) {
          return assignment;
        }

        const provider = assignment.providerId
          ? providerMap.get(assignment.providerId) ?? roleReadyProviders[0]
          : roleReadyProviders[0];
        const models = provider ? providerModelsMap.get(provider.id) ?? [] : [];

        if (!provider || models.length === 0) {
          return assignment;
        }

        return {
          ...assignment,
          providerId: provider.id,
          modelId: assignment.modelId ?? getBestModel(models),
        };
      }),
    );
  }, [providerMap, providerModelsMap, roleReadyProviders]);

  async function refreshTerminalApprovals() {
    try {
      const response = await fetch(clientApiPath("/terminal/approvals"), {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Terminal approvals request failed (${response.status}).`);
      }
      const payload = (await response.json()) as { items?: TerminalApproval[] };
      setTerminalApprovals(Array.isArray(payload.items) ? payload.items : []);
    } catch (error) {
      console.warn(
        "[settings] failed to refresh terminal approvals:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function refreshCheckpoints() {
    try {
      const response = await fetch(clientApiPath("/checkpoints?limit=20"), {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Checkpoint list request failed (${response.status}).`);
      }
      const payload = (await response.json()) as { items?: CheckpointSummary[] };
      setCheckpoints(Array.isArray(payload.items) ? payload.items : []);
    } catch (error) {
      console.warn(
        "[settings] failed to refresh checkpoints:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function decideTerminalApproval(
    approvalId: string,
    decision: "deny" | "once" | "session" | "always",
  ) {
    setTerminalApprovalBusyId(approvalId);
    setNotice(null);

    try {
      const response = await fetch(clientApiPath(`/terminal/approvals/${approvalId}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Approval update failed (${response.status}).`);
      }
      await refreshTerminalApprovals();
      setNotice({
        tone: "success",
        message: `Terminal approval decision saved (${decision}).`,
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Failed to update terminal approval.",
      });
    } finally {
      setTerminalApprovalBusyId(null);
    }
  }

  async function rollbackCheckpoint(checkpointId: string) {
    setCheckpointBusyId(checkpointId);
    setNotice(null);
    try {
      const response = await fetch(clientApiPath(`/checkpoints/${checkpointId}/rollback`), {
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Checkpoint rollback failed (${response.status}).`);
      }
      await refreshCheckpoints();
      setNotice({
        tone: "success",
        message: "Checkpoint rollback completed.",
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Failed to rollback checkpoint.",
      });
    } finally {
      setCheckpointBusyId(null);
    }
  }

  useEffect(() => {
    void refreshTerminalApprovals();
    void refreshCheckpoints();
    const timer = setInterval(() => {
      void refreshTerminalApprovals();
      void refreshCheckpoints();
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  function resetProviderBuilder() {
    setShowAddProvider(false);
    setSelectedProviderType(null);
    setSelectedQuickPresetId(null);
    setProviderName("");
    setApiKey("");
    setBaseUrl(PROVIDER_PRESETS["openai-compatible"].baseUrl ?? "");
    setDefaultModelId("");
    setContextWindowTokens("");
  }

  function startEditingProvider(provider: Provider) {
    setActivePanel("providers");
    setEditingProviderId(provider.id);
    setProviderEditor(createProviderEditorState(provider));
  }

  function stopEditingProvider() {
    setEditingProviderId(null);
    setProviderEditor(null);
  }

  function setRolePrompt(role: Role, value: string) {
    setSettings((current) => ({
      ...current,
      systemPrompts: {
        ...current.systemPrompts,
        roles: {
          ...current.systemPrompts.roles,
          [role]: value,
        },
      },
    }));
  }

  function updateCompressionSetting(
    key: keyof Settings["compression"],
    value: number | boolean,
  ) {
    setSettings((current) => ({
      ...current,
      compression: {
        ...current.compression,
        [key]: value,
      },
    }));
  }

  function updateRoleProvider(role: RoleAssignment["role"], providerId: string) {
    const nextProviderId = providerId || null;
    const provider = nextProviderId ? providerMap.get(nextProviderId) ?? null : null;
    const models = provider ? providerModelsMap.get(provider.id) ?? [] : [];

    setAssignments((current) =>
      current.map((assignment) =>
        assignment.role === role
          ? {
              ...assignment,
              providerId: nextProviderId,
              modelId: nextProviderId ? getBestModel(models) : null,
            }
          : assignment,
      ),
    );
  }

  function updateRoleModel(role: RoleAssignment["role"], modelId: string) {
    setAssignments((current) =>
      current.map((assignment) =>
        assignment.role === role ? { ...assignment, modelId: modelId || null } : assignment,
      ),
    );
  }

  function autoAssignRoles() {
    if (roleReadyProviders.length === 0) {
      setNotice({
        tone: "danger",
        message: "No connected chat providers with discovered models are ready for role assignment.",
      });
      return;
    }

    const bestProvider = [...roleReadyProviders].sort((left, right) => {
      const rightModelCount = providerModelsMap.get(right.id)?.length ?? 0;
      const leftModelCount = providerModelsMap.get(left.id)?.length ?? 0;
      if (rightModelCount !== leftModelCount) {
        return rightModelCount - leftModelCount;
      }

      return scoreModel(getBestModel(providerModelsMap.get(right.id) ?? []) ?? "") -
        scoreModel(getBestModel(providerModelsMap.get(left.id) ?? []) ?? "");
    })[0];
    const bestModel = getBestModel(providerModelsMap.get(bestProvider.id) ?? []);

    setAssignments((current) =>
      current.map((assignment) => ({
        ...assignment,
        providerId: bestProvider.id,
        modelId: bestModel,
      })),
    );

    setNotice({
      tone: "success",
      message: `Assigned all roles to ${bestProvider.name}${bestModel ? ` (${bestModel})` : ""}.`,
    });
  }

  async function saveWorkspace() {
    setSavingWorkspace(true);
    setNotice(null);

    try {
      const [settingsResponse, rolesResponse] = await Promise.all([
        fetch(clientApiPath("/settings"), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ item: settings }),
        }),
        fetch(clientApiPath("/roles"), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: normalizedAssignments }),
        }),
      ]);

      if (!settingsResponse.ok || !rolesResponse.ok) {
        throw new Error("Saving settings failed.");
      }

      const settingsPayload = (await settingsResponse.json()) as {
        item: Settings;
        secretStatus?: SettingsSecretStatus;
      };

      setSavedSettings(settings);
      setSavedAssignments(normalizedAssignments);
      if (settingsPayload.secretStatus) {
        setSettingsSecretStatus(settingsPayload.secretStatus);
      }
      setNotice({ tone: "success", message: "Settings saved successfully." });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Save failed.",
      });
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function mutateProvider(
    id: string,
    action: "connect" | "reconnect" | "recheck" | "delete",
  ) {
    setBusyProviderId(id);
    setNotice(null);
    const providerNameValue = providers.find((provider) => provider.id === id)?.name ?? "Provider";

    try {
      const method = action === "delete" ? "DELETE" : "POST";
      const endpoint =
        action === "delete"
          ? clientApiPath(`/providers/${id}`)
          : clientApiPath(`/providers/${id}/${action}`);
      const response = await fetch(endpoint, { method });

      if (!response.ok) {
        throw new Error(`${action} failed with status ${response.status}.`);
      }

      if (action === "delete") {
        setProviders((current) => current.filter((provider) => provider.id !== id));
        setAssignments((current) =>
          current.map((assignment) =>
            assignment.providerId === id
              ? { ...assignment, providerId: null, modelId: null }
              : assignment,
          ),
        );
        setNotice({ tone: "success", message: `${providerNameValue} removed.` });
        return;
      }

      const payload = (await response.json()) as { item: Provider };
      setProviders((current) =>
        current.map((provider) =>
          provider.id === id
            ? { ...provider, ...payload.item, connectorType: provider.connectorType }
            : provider,
        ),
      );

      const discoveredCount = payload.item.availableModels.length;
      const actionLabel = action === "recheck" ? "refreshed" : "updated";
      setNotice({
        tone: "success",
        message:
          discoveredCount > 0
            ? `${providerNameValue} ${actionLabel}. ${discoveredCount} models discovered.`
            : `${providerNameValue} ${actionLabel}.`,
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Provider action failed.",
      });
    } finally {
      setBusyProviderId(null);
    }
  }

  async function saveProviderEdits(provider: Provider) {
    if (!providerEditor) {
      return;
    }

    setBusyProviderId(provider.id);
    setNotice(null);

    try {
      const config: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      const isLocalEndpoint =
        provider.typeId === "openai-compatible" &&
        isLocalOpenAiCompatibleBaseUrl(providerEditor.baseUrl);
      const contextWindowError = isLocalEndpoint
        ? validateContextWindowTokensInput(providerEditor.contextWindowTokens)
        : null;

      if (contextWindowError) {
        throw new Error(contextWindowError);
      }

      if (provider.typeId === "openai-compatible") {
        config.baseUrl = providerEditor.baseUrl.trim();
      }

      if (providerEditor.defaultModelId.trim()) {
        config.defaultModelId = providerEditor.defaultModelId.trim();
      } else {
        config.defaultModelId = "";
      }

      if (provider.typeId === "openai-compatible" && isLocalEndpoint) {
        config.contextWindowTokens = providerEditor.contextWindowTokens.trim();
      } else {
        config.contextWindowTokens = "";
      }

      if (providerEditor.apiKey.trim()) {
        secrets.apiKey = providerEditor.apiKey.trim();
      }

      const updateResponse = await fetch(clientApiPath(`/providers/${provider.id}`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: providerEditor.name.trim(),
          config,
          secrets,
        }),
      });

      if (!updateResponse.ok) {
        const payload = (await updateResponse.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Update failed with status ${updateResponse.status}.`);
      }

      let updatedProvider = ((await updateResponse.json()) as { item: Provider }).item;
      const recheckResponse = await fetch(clientApiPath(`/providers/${provider.id}/recheck`), {
        method: "POST",
      });

      if (recheckResponse.ok) {
        updatedProvider = ((await recheckResponse.json()) as { item: Provider }).item;
      }

      setProviders((current) =>
        current.map((candidate) =>
          candidate.id === provider.id
            ? {
                ...candidate,
                ...updatedProvider,
                connectorType: candidate.connectorType,
              }
            : candidate,
        ),
      );

      stopEditingProvider();
      setNotice({
        tone: "success",
        message: `${updatedProvider.name} saved and refreshed.`,
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Provider update failed.",
      });
    } finally {
      setBusyProviderId(null);
    }
  }

  async function createPresetProvider() {
    if (!selectedProviderType) {
      return;
    }

    setCreatingProvider(true);
    setNotice(null);

    try {
      const config: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      const isLocalEndpoint =
        selectedProviderType === "openai-compatible" &&
        isLocalOpenAiCompatibleBaseUrl(baseUrl.trim());
      const contextWindowError = isLocalEndpoint
        ? validateContextWindowTokensInput(contextWindowTokens)
        : null;

      if (contextWindowError) {
        throw new Error(contextWindowError);
      }

      if (selectedProviderType === "codex-cli" && defaultModelId.trim()) {
        config.defaultModelId = defaultModelId.trim();
      }

      if (selectedProviderType === "openai-compatible") {
        config.baseUrl = baseUrl.trim();
        if (defaultModelId.trim()) {
          config.defaultModelId = defaultModelId.trim();
        }
        if (isLocalEndpoint && contextWindowTokens.trim()) {
          config.contextWindowTokens = contextWindowTokens.trim();
        }
        if (apiKey.trim()) {
          secrets.apiKey = apiKey.trim();
        }
      }

      if (selectedProviderType === "anthropic-api") {
        if (defaultModelId.trim()) {
          config.defaultModelId = defaultModelId.trim();
        }
        if (apiKey.trim()) {
          secrets.apiKey = apiKey.trim();
        }
      }

      const providerNameValue =
        providerName.trim() ||
        (selectedProviderType === "openai-compatible"
          ? deriveProviderName(selectedProviderType, baseUrl.trim())
          : PROVIDER_PRESETS[selectedProviderType].name);

      const response = await fetch(clientApiPath("/providers"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: providerNameValue,
          typeId: selectedProviderType,
          config,
          secrets,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Create failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as { item: Provider };
      let createdProvider = payload.item;

      const recheck = await fetch(clientApiPath(`/providers/${payload.item.id}/recheck`), {
        method: "POST",
      });
      if (recheck.ok) {
        const rechecked = (await recheck.json()) as { item: Provider };
        createdProvider = rechecked.item;
      }

      setProviders((current) => [
        {
          ...createdProvider,
          connectorType:
            connectorTypes.find((connectorType) => connectorType.id === createdProvider.typeId) ??
            null,
        },
        ...current,
      ]);

      resetProviderBuilder();

      const discoveredCount = createdProvider.availableModels.length;
      setNotice({
        tone: "success",
        message:
          discoveredCount > 0
            ? `${providerNameValue} connected. ${discoveredCount} models discovered automatically.`
            : `${providerNameValue} added. Run a refresh after authentication to pull models.`,
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Provider creation failed.",
      });
    } finally {
      setCreatingProvider(false);
    }
  }

  function resetMcpInstaller() {
    setMcpInstallTransport("package");
    setMcpPackageName("");
    setMcpRemoteUrl("");
    setMcpServerName("");
    setMcpDescription("");
    setMcpArgs("");
    setMcpHeaders("");
    setMcpTimeout("30000");
    setMcpRoles(["coordinator", "director", "inspector"]);
    setMcpScope("project");
  }

  function toggleMcpRole(role: Role) {
    setMcpRoles((current) =>
      current.includes(role)
        ? current.filter((candidate) => candidate !== role)
        : [...current, role],
    );
  }

  function parseMcpKeyValueLines(value: string): Record<string, string> {
    return Object.fromEntries(
      value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          if (separator === -1) {
            return [line, ""] as const;
          }
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
        })
        .filter(([key, item]) => key.length > 0 && item.length > 0),
    );
  }

  async function reloadMcpServers() {
    setMcpBusyKey("reload");
    setNotice(null);

    try {
      const response = await fetch(clientApiPath("/mcp/reload"), {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`MCP reload failed with status ${response.status}.`);
      }
      const payload = (await response.json()) as McpState;
      setMcpState(payload);
      setNotice({
        tone: "success",
        message:
          `Reloaded MCP servers. ${payload.stats.runningServers}/${payload.stats.configuredServers} running with ` +
          `${payload.stats.activeTools} active tools and ${payload.stats.drainingServers ?? 0} draining server` +
          `${payload.stats.drainingServers === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "MCP reload failed.",
      });
    } finally {
      setMcpBusyKey(null);
    }
  }

  async function installMcpPackage() {
    setMcpBusyKey("install");
    setNotice(null);

    try {
      const response = await fetch(clientApiPath("/mcp/install"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transport: mcpInstallTransport,
          packageName: mcpInstallTransport === "package" ? mcpPackageName : undefined,
          url: mcpInstallTransport === "sse" ? mcpRemoteUrl : undefined,
          httpUrl: mcpInstallTransport === "streamable-http" ? mcpRemoteUrl : undefined,
          serverName: mcpServerName || undefined,
          scope: mcpScope,
          description: mcpDescription || undefined,
          timeout: Number(mcpTimeout) || undefined,
          roles: mcpRoles,
          args: mcpInstallTransport === "package"
            ? mcpArgs
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean)
            : undefined,
          headers: mcpInstallTransport === "package"
            ? undefined
            : parseMcpKeyValueLines(mcpHeaders),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Install failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as McpState;
      setMcpState(payload);
      resetMcpInstaller();
      setNotice({
        tone: "success",
        message:
          mcpInstallTransport === "package"
            ? `Installed MCP server from ${mcpPackageName.trim()}.`
            : `Added ${mcpInstallTransport === "sse" ? "SSE" : "Streamable HTTP"} MCP server.`,
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "MCP install failed.",
      });
    } finally {
      setMcpBusyKey(null);
    }
  }

  async function removeScopedMcpServer(scope: Exclude<McpConfigScope, "default">, name: string) {
    setMcpBusyKey(`remove:${scope}:${name}`);
    setNotice(null);

    try {
      const response = await fetch(clientApiPath(`/mcp/servers/${scope}/${name}`), {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Remove failed with status ${response.status}.`);
      }
      const payload = (await response.json()) as McpState;
      setMcpState(payload);
      setNotice({
        tone: "success",
        message: `Removed MCP server ${name}.`,
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "MCP remove failed.",
      });
    } finally {
      setMcpBusyKey(null);
    }
  }

  function setServiceKey(serverName: string, envKey: string, value: string) {
    setServiceKeys((prev) => ({
      ...prev,
      [serverName]: { ...prev[serverName], [envKey]: value },
    }));
  }

  async function saveServiceKey(def: McpServiceKeyDef) {
    setServiceKeySaving(def.serverName);
    setNotice(null);

    try {
      const env: Record<string, string> = {};
      for (const envDef of def.envKeys) {
        const value = serviceKeys[def.serverName]?.[envDef.key]?.trim() ?? "";
        if (value) {
          env[envDef.key] = value;
        }
      }

      // Postgres is special: connection string goes as a CLI arg, not env
      let args: string[] | undefined;
      if (def.serverName === "postgres" && env["_POSTGRES_CONNECTION_STRING"]) {
        const connStr = env["_POSTGRES_CONNECTION_STRING"];
        delete env["_POSTGRES_CONNECTION_STRING"];
        // Build the full args with the connection string appended
        args = ["-y", "@modelcontextprotocol/server-postgres", connStr];
      }

      // Check if any real key has a value — if so, enable the server
      const hasAnyKey = def.envKeys.some((e) => {
        const v = serviceKeys[def.serverName]?.[e.key]?.trim() ?? "";
        return v.length > 0;
      });

      const config: Partial<McpServerConfig> = {
        env,
        enabled: hasAnyKey ? true : undefined,
        ...(args ? { args } : {}),
      };

      const response = await fetch(clientApiPath(`/mcp/servers/user/${def.serverName}`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Save failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as McpState;
      setMcpState(payload);
      setNotice({
        tone: "success",
        message: `Saved ${def.label} configuration. ${hasAnyKey ? "Server enabled." : ""}`,
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : `Failed to save ${def.label} keys.`,
      });
    } finally {
      setServiceKeySaving(null);
    }
  }

  function renderWorkspaceSaveAction(label: string) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <span className="helper-copy" style={{ margin: 0 }}>
          {hasWorkspaceChanges ? "Unsaved changes" : "All changes saved"}
        </span>
        <button
          className="button primary"
          onClick={saveWorkspace}
          disabled={savingWorkspace || !hasWorkspaceChanges}
        >
          {savingWorkspace ? "Saving..." : label}
        </button>
      </div>
    );
  }

  return (
    <div className="settings-page">
      {/* Topbar */}
      <div className="topbar chat-topbar settings-topbar">
        <div className="chat-topbar-inner">
          <button
            type="button"
            className="icon-btn chat-topbar-toggle"
            onClick={() => window.dispatchEvent(new CustomEvent("toggleSidebar"))}
            aria-label="Toggle sidebar"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="chat-topbar-copy">
            <span className="topbar-title">Settings</span>
          </div>
          <div className="topbar-spacer" />
        </div>
      </div>

      <div className="settings-shell">
        <div className="settings-layout-wrapper">
          {/* Navigation Rail */}
          <nav className="settings-rail" aria-label="Settings sections">
            {SETTINGS_PANELS.map((panel) => (
              <button
                key={panel.id}
                type="button"
                className={`settings-rail-item${activePanel === panel.id ? " active" : ""}`}
                onClick={() => setActivePanel(panel.id)}
              >
                <span>{panel.label}</span>
                <small>{panel.description}</small>
              </button>
            ))}
          </nav>

          {/* Content Area */}
          <div className="settings-content">
            {/* Notice */}
            {notice ? <div className={`notice-strip ${notice.tone}`}>{notice.message}</div> : null}

            {/* General Panel */}
            {activePanel === "general" && (
              <div className="settings-pane">
                <div className="settings-pane-head">
                  <div>
                    <h2>General</h2>
                    <p className="helper-copy">Workspace identity, runtime status, and defaults.</p>
                  </div>
                  {renderWorkspaceSaveAction("Save Changes")}
                </div>

                {/* Profile Section */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Profile</h3>
                    <p className="helper-copy">How Ember should refer to you inside chat.</p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-field-row">
                      <div className="settings-field">
                        <label>Your name</label>
                        <input
                          value={settings.humanName}
                          onChange={(e) =>
                            setSettings((c) => ({ ...c, humanName: e.target.value }))
                          }
                          placeholder="Your name"
                        />
                      </div>
                      <div className="settings-field">
                        <label>Sudo password</label>
                        <input
                          type="password"
                          value={settings.sudoPassword ?? ""}
                          onChange={(e) =>
                            setSettings((c) => ({ ...c, sudoPassword: e.target.value }))
                          }
                          placeholder="For elevated commands"
                          autoComplete="new-password"
                        />
                      </div>
                    </div>
                    <div className="settings-stats-grid" style={{ padding: 0 }}>
                      <div className="settings-stat-card">
                        <strong>{connectedProviders.length}</strong>
                        <span className="settings-stat-label">Connected Providers</span>
                      </div>
                      <div className="settings-stat-card">
                        <strong>{assignedRoleCount}/{assignments.length}</strong>
                        <span className="settings-stat-label">Roles Assigned</span>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Search Section */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Search</h3>
                    <p className="helper-copy">
                      Brave Search API for structured web results.{" "}
                      <a href="https://brave.com/search/api/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                        Get a free API key
                      </a>
                    </p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-field" style={{ maxWidth: "400px" }}>
                      <label>Brave Search API key</label>
                      <input
                        type="password"
                        value={settings.braveApiKey ?? ""}
                        onChange={(e) =>
                          setSettings((c) => ({ ...c, braveApiKey: e.target.value }))
                        }
                        placeholder="BSA..."
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="settings-info-note" style={{ maxWidth: "400px" }}>
                      <span className="label">Status</span>
                      <p>
                        {settings.braveApiKey?.trim() || settingsSecretStatus.braveApiKeySet
                          ? "Brave Search active"
                          : "Using DuckDuckGo fallback"}
                      </p>
                    </div>
                  </div>
                </section>

                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Custom Tool Trust</h3>
                    <p className="helper-copy">
                      Control whether runtime-created custom tools can be created and executed.
                    </p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-field" style={{ maxWidth: "400px" }}>
                      <label>Trust mode</label>
                      <select
                        value={settings.customTools.trustMode}
                        onChange={(e) =>
                          setSettings((current) => ({
                            ...current,
                            customTools: {
                              ...current.customTools,
                              trustMode: e.target.value as Settings["customTools"]["trustMode"],
                            },
                          }))
                        }
                      >
                        <option value="disabled">Disabled</option>
                        <option value="local-only">Local-only (project scoped)</option>
                        <option value="allow">Allow all custom tools</option>
                      </select>
                    </div>
                    <div className="settings-info-note" style={{ maxWidth: "700px" }}>
                      <span className="label">Mode details</span>
                      <p>
                        Disabled blocks create_tool and all custom__* tools. Local-only allows create_tool for
                        project scope and blocks user-scoped custom tools. Allow enables all custom tools.
                      </p>
                    </div>
                  </div>
                </section>

                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Terminal Command Approvals</h3>
                    <p className="helper-copy">
                      Review and decide pending dangerous terminal commands detected by the runtime.
                    </p>
                  </div>
                  <div className="settings-block-content">
                    {terminalApprovals.length === 0 ? (
                      <div className="settings-empty-state" style={{ margin: 0 }}>
                        <strong>No pending approvals</strong>
                        <span>Dangerous commands will appear here when operator confirmation is required.</span>
                      </div>
                    ) : (
                      <div className="settings-provider-list" style={{ padding: 0 }}>
                        {terminalApprovals.map((approval) => (
                          <article key={approval.id} className="settings-provider-card">
                            <div className="settings-provider-head">
                              <div className="settings-provider-title">
                                <h4 style={{ margin: 0 }}>Session: {approval.sessionKey}</h4>
                                <p style={{ margin: 0, opacity: 0.75 }}>
                                  Requested {new Date(approval.createdAt).toLocaleString()} • Expires{" "}
                                  {new Date(approval.expiresAt).toLocaleTimeString()}
                                </p>
                              </div>
                            </div>
                            <div className="settings-info-note" style={{ marginLeft: 0 }}>
                              <span className="label">Command</span>
                              <p style={{ fontFamily: "var(--font-mono, monospace)" }}>{approval.command}</p>
                              <span className="label">Risk Signals</span>
                              <p>{approval.reasons.join(", ")}</p>
                            </div>
                            <div className="settings-provider-actions">
                              <button
                                className="button ghost"
                                disabled={terminalApprovalBusyId === approval.id}
                                onClick={() => void decideTerminalApproval(approval.id, "deny")}
                              >
                                Deny
                              </button>
                              <button
                                className="button ghost"
                                disabled={terminalApprovalBusyId === approval.id}
                                onClick={() => void decideTerminalApproval(approval.id, "once")}
                              >
                                Allow Once
                              </button>
                              <button
                                className="button ghost"
                                disabled={terminalApprovalBusyId === approval.id}
                                onClick={() => void decideTerminalApproval(approval.id, "session")}
                              >
                                Allow Session
                              </button>
                              <button
                                className="button"
                                disabled={terminalApprovalBusyId === approval.id}
                                onClick={() => void decideTerminalApproval(approval.id, "always")}
                              >
                                Always Allow
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Checkpoint Rollback</h3>
                    <p className="helper-copy">
                      File mutations create safety checkpoints. Roll back a checkpoint to restore prior file state.
                    </p>
                  </div>
                  <div className="settings-block-content">
                    {checkpoints.length === 0 ? (
                      <div className="settings-empty-state" style={{ margin: 0 }}>
                        <strong>No checkpoints yet</strong>
                        <span>Checkpoints appear after write_file, edit_file, or delete_file mutations.</span>
                      </div>
                    ) : (
                      <div className="settings-provider-list" style={{ padding: 0 }}>
                        {checkpoints.map((checkpoint) => (
                          <article key={checkpoint.id} className="settings-provider-card">
                            <div className="settings-provider-head">
                              <div className="settings-provider-title">
                                <h4 style={{ margin: 0 }}>{checkpoint.id}</h4>
                                <p style={{ margin: 0, opacity: 0.75 }}>
                                  {new Date(checkpoint.createdAt).toLocaleString()} • files {checkpoint.snapshotCount}
                                </p>
                              </div>
                            </div>
                            <div className="settings-info-note" style={{ marginLeft: 0 }}>
                              <span className="label">Scope</span>
                              <p style={{ fontFamily: "var(--font-mono, monospace)" }}>{checkpoint.scopeDir}</p>
                              <span className="label">Reason</span>
                              <p>{checkpoint.reason}{checkpoint.turnKey ? ` • turn ${checkpoint.turnKey}` : ""}</p>
                            </div>
                            <div className="settings-provider-actions">
                              <button
                                className="button ghost"
                                disabled={checkpointBusyId === checkpoint.id}
                                onClick={() => void rollbackCheckpoint(checkpoint.id)}
                              >
                                Rollback
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                {/* Workspace Section */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Workspace</h3>
                    <p className="helper-copy">Current runtime and endpoint information.</p>
                  </div>
                  <div className="settings-definition-grid">
                    <div className="def-item">
                      <dt>Status</dt>
                      <dd>{runtime.status}</dd>
                    </div>
                    <div className="def-item">
                      <dt>Started</dt>
                      <dd>{formatStartedAt(runtime.startedAt)}</dd>
                    </div>
                    <div className="def-item">
                      <dt>Web URL</dt>
                      <dd>{runtime.webUrl || settings.runtimeInfo.webUrl}</dd>
                    </div>
                    <div className="def-item">
                      <dt>API URL</dt>
                      <dd>{runtime.apiUrl || settings.runtimeInfo.apiUrl}</dd>
                    </div>
                    <div className="def-item wide">
                      <dt>Workspace Root</dt>
                      <dd>{settings.workspaceRoot}</dd>
                    </div>
                  </div>
                </section>

                {/* Compression Section */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Context Compression</h3>
                    <p className="helper-copy">Configure token estimation and context window behavior.</p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-field-row">
                      <div className="settings-field">
                        <label>Compression enabled</label>
                        <select
                          value={settings.compression.enabled ? "true" : "false"}
                          onChange={(e) =>
                            updateCompressionSetting("enabled", e.target.value === "true")
                          }
                        >
                          <option value="true">Enabled</option>
                          <option value="false">Disabled</option>
                        </select>
                      </div>
                      <div className="settings-field">
                        <label>Context window tokens</label>
                        <input
                          type="number"
                          min={4000}
                          step={1000}
                          value={settings.compression.contextWindowTokens}
                          onChange={(e) =>
                            updateCompressionSetting(
                              "contextWindowTokens",
                              Math.max(4000, Number(e.target.value) || 4000),
                            )
                          }
                        />
                      </div>
                      <div className="settings-field">
                        <label>Tool loop limit</label>
                        <input
                          type="number"
                          min={0}
                          max={MAX_PROVIDER_TOOL_LOOP_LIMIT}
                          step={10}
                          value={settings.compression.toolLoopLimit}
                          onChange={(e) =>
                            updateCompressionSetting(
                              "toolLoopLimit",
                              Math.max(
                                0,
                                Math.min(
                                  MAX_PROVIDER_TOOL_LOOP_LIMIT,
                                  Math.floor(Number(e.target.value) || 0),
                                ),
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="settings-field">
                        <label>Response headroom</label>
                        <input
                          type="number"
                          min={512}
                          step={500}
                          value={settings.compression.responseHeadroomTokens}
                          onChange={(e) =>
                            updateCompressionSetting(
                              "responseHeadroomTokens",
                              Math.max(512, Number(e.target.value) || 512),
                            )
                          }
                        />
                      </div>
                      <div className="settings-field">
                        <label>Safety reserve</label>
                        <input
                          type="number"
                          min={512}
                          step={500}
                          value={settings.compression.safetyMarginTokens}
                          onChange={(e) =>
                            updateCompressionSetting(
                              "safetyMarginTokens",
                              Math.max(512, Number(e.target.value) || 512),
                            )
                          }
                        />
                      </div>
                      <div className="settings-field">
                        <label>Preserve recent messages</label>
                        <input
                          type="number"
                          min={1}
                          max={24}
                          value={settings.compression.preserveRecentMessages}
                          onChange={(e) =>
                            updateCompressionSetting(
                              "preserveRecentMessages",
                              Math.max(1, Number(e.target.value) || 1),
                            )
                          }
                        />
                      </div>
                      <div className="settings-field">
                        <label>Minimum recent</label>
                        <input
                          type="number"
                          min={1}
                          max={24}
                          value={settings.compression.minimumRecentMessages}
                          onChange={(e) =>
                            updateCompressionSetting(
                              "minimumRecentMessages",
                              Math.max(1, Number(e.target.value) || 1),
                            )
                          }
                        />
                      </div>
                    </div>
                    <div className="settings-info-note">
                      <span className="label">Recommended</span>
                      <p>
                        Max prompt: ~{settings.compression.maxPromptTokens.toLocaleString()} tokens, targeting{" "}
                        {settings.compression.targetPromptTokens.toLocaleString()} after compaction.
                      </p>
                      <p style={{ marginTop: "0.35rem" }}>
                        Tool loop limit:{" "}
                        {settings.compression.toolLoopLimit === 0
                          ? "adaptive (context-based)"
                          : `${settings.compression.toolLoopLimit.toLocaleString()} turns`}
                        . Set 0 to use adaptive context-window limits.
                      </p>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {/* Providers Panel */}
            {activePanel === "providers" && (
              <div className="settings-pane">
                <div className="settings-pane-head">
                  <div>
                    <h2>Providers</h2>
                    <p className="helper-copy">Add and manage AI provider connections.</p>
                  </div>
                  <button
                    className="button"
                    onClick={() => {
                      if (showAddProvider) {
                        resetProviderBuilder();
                      } else {
                        setShowAddProvider(true);
                        setSelectedQuickPresetId(null);
                        setSelectedProviderType(null);
                      }
                    }}
                  >
                    {showAddProvider ? "Close" : "Add Provider"}
                  </button>
                </div>

                {/* Add Provider Section */}
                {showAddProvider && (
                  <section className="settings-block">
                    <div className="settings-block-head">
                      <h3>Choose Provider</h3>
                      <p className="helper-copy">Select a provider type to configure.</p>
                    </div>
                    <div className="provider-quick-grid">
                      {QUICK_PRESETS.map((preset) => {
                        const isSelected = selectedQuickPresetId === preset.id;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            className={`provider-quick-card${isSelected ? " selected" : ""}`}
                            onClick={() => {
                              setSelectedQuickPresetId(preset.id);
                              setSelectedProviderType(preset.typeId);
                              setBaseUrl(preset.baseUrl ?? PROVIDER_PRESETS["openai-compatible"].baseUrl ?? "");
                              setDefaultModelId(preset.defaultModelSuggestion ?? "");
                              setContextWindowTokens("");
                              setApiKey("");
                              setProviderName(preset.label);
                            }}
                          >
                            <span className="icon-wrap">
                              <ProviderIcon id={preset.id} />
                            </span>
                            <strong>{preset.label}</strong>
                            <span>{preset.tagline}</span>
                          </button>
                        );
                      })}
                    </div>

                    {selectedQuickPresetId && selectedProviderType && (() => {
                      const qp = QUICK_PRESETS.find((p) => p.id === selectedQuickPresetId)!;
                      const isCli = selectedProviderType === "codex-cli";
                      const isOpenAI = selectedProviderType === "openai-compatible";
                      const isLocal = isOpenAI && isLocalOpenAiCompatibleBaseUrl(baseUrl.trim());
                      return (
                        <div className="provider-quick-form">
                          <div className="settings-field">
                            <label>Provider name</label>
                            <input
                              value={providerName}
                              onChange={(e) => setProviderName(e.target.value)}
                              placeholder={qp.label}
                            />
                          </div>

                          {isOpenAI && (
                            <>
                              <div className="settings-field">
                                <label>Endpoint URL</label>
                                <input
                                  value={baseUrl}
                                  onChange={(e) => setBaseUrl(e.target.value)}
                                  placeholder="http://127.0.0.1:11434/v1"
                                />
                              </div>
                              {isLocal && (
                                <div className="settings-field">
                                  <label>Context window</label>
                                  <input
                                    type="number"
                                    min={0}
                                    step={1000}
                                    value={contextWindowTokens}
                                    onChange={(e) => setContextWindowTokens(e.target.value)}
                                    placeholder="100000"
                                  />
                                  {createContextWindowError && (
                                    <p className="helper-copy" style={{ color: "var(--danger-400)" }}>
                                      {createContextWindowError}
                                    </p>
                                  )}
                                </div>
                              )}
                            </>
                          )}

                          {!isCli && (
                            <div className="settings-field">
                              <label>
                                API key
                                {!qp.apiKeyRequired && <span className="optional"> (optional)</span>}
                              </label>
                              <input
                                type="password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder={qp.apiKeyPlaceholder ?? ""}
                              />
                            </div>
                          )}

                          {isCli ? (
                            <div className="settings-field">
                              <label>
                                Default model <span className="optional">(optional)</span>
                              </label>
                              <select
                                value={defaultModelId}
                                onChange={(e) => setDefaultModelId(e.target.value)}
                              >
                                <option value="">Use connector default</option>
                                {selectedCliModels.map((model) => (
                                  <option key={model} value={model}>{model}</option>
                                ))}
                              </select>
                            </div>
                          ) : (
                            <div className="settings-field">
                              <label>
                                Default model <span className="optional">(optional)</span>
                              </label>
                              <input
                                value={defaultModelId}
                                onChange={(e) => setDefaultModelId(e.target.value)}
                                placeholder={qp.defaultModelSuggestion ?? "e.g. gpt-4o"}
                              />
                            </div>
                          )}

                          <div className="form-actions">
                            <button className="button ghost" onClick={resetProviderBuilder}>
                              Cancel
                            </button>
                            <button
                              className="button primary"
                              onClick={() => void createPresetProvider()}
                              disabled={
                                creatingProvider ||
                                !providerName.trim() ||
                                (qp.apiKeyRequired && !apiKey.trim()) ||
                                (isOpenAI && !baseUrl.trim()) ||
                                Boolean(createContextWindowError)
                              }
                            >
                              {creatingProvider ? "Connecting..." : "Connect Provider"}
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </section>
                )}

                {/* Providers List */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Connected Providers</h3>
                    <p className="helper-copy">Manage existing connections and discover models.</p>
                  </div>

                  {orderedProviders.length === 0 ? (
                    <div className="settings-empty-state" style={{ margin: "0 1.5rem 1.25rem" }}>
                      <strong>No providers configured</strong>
                      <span>Add Codex, Claude, or an OpenAI-compatible endpoint to get started.</span>
                    </div>
                  ) : (
                    <div className="settings-provider-list">
                      {orderedProviders.map((provider) => {
                        const models = providerModelsMap.get(provider.id) ?? [];
                        const featuredModels = models.slice(0, 3);
                        const busy = busyProviderId === provider.id;
                        const isEditing = editingProviderId === provider.id && providerEditor !== null;
                        const editContextWindowError =
                          isEditing &&
                          provider.typeId === "openai-compatible" &&
                          providerEditor &&
                          isLocalOpenAiCompatibleBaseUrl(providerEditor.baseUrl.trim())
                            ? validateContextWindowTokensInput(providerEditor.contextWindowTokens)
                            : null;
                        const canAssign =
                          provider.status === "connected" &&
                          provider.capabilities.canChat &&
                          models.length > 0;
                        const defaultModel = provider.config.defaultModelId?.trim() ?? "";

                        return (
                          <article key={provider.id} className="settings-provider-card">
                            {/* Header */}
                            <div className="settings-provider-head">
                              <div className="settings-provider-title">
                                <div className={`provider-status-dot ${provider.status}`} />
                                <div>
                                  <span className="type-label">{getProviderTypeLabel(provider)}</span>
                                  <h3>{provider.name}</h3>
                                  <p className="helper-copy">{getProviderSummary(provider, models.length)}</p>
                                </div>
                              </div>
                              <span className={`settings-status-pill ${provider.status}`}>
                                {getStatusLabel(provider, models.length)}
                              </span>
                            </div>

                            {/* Meta */}
                            <div className="settings-provider-meta">
                              <span>{getProviderAuthLabel(provider)}</span>
                              <span>{models.length} model{models.length === 1 ? "" : "s"}</span>
                              <span>{canAssign ? "Role ready" : "Needs setup"}</span>
                              {defaultModel && <span>Default: {defaultModel}</span>}
                              <span>{getProviderContextWindowLabel(provider)}</span>
                            </div>

                            {/* Error */}
                            {provider.lastError && (
                              <div className="provider-error">{provider.lastError}</div>
                            )}

                            {/* Models */}
                            {models.length > 0 ? (
                              <div className="settings-model-pills">
                                {featuredModels.map((model) => (
                                  <span key={model} className="settings-model-pill">{model}</span>
                                ))}
                                {models.length > featuredModels.length && (
                                  <span className="settings-model-pill muted">
                                    +{models.length - featuredModels.length} more
                                  </span>
                                )}
                              </div>
                            ) : null}

                            {/* Editor */}
                            {isEditing && (
                              <div className="settings-provider-editor">
                                <div className="settings-provider-editor-grid">
                                  <div className="settings-field">
                                    <label>Provider name</label>
                                    <input
                                      value={providerEditor.name}
                                      onChange={(e) =>
                                        setProviderEditor((c) =>
                                          c ? { ...c, name: e.target.value } : c
                                        )
                                      }
                                      placeholder="Name"
                                    />
                                  </div>
                                  {provider.typeId === "openai-compatible" && (
                                    <>
                                      <div className="settings-field">
                                        <label>Endpoint URL</label>
                                        <input
                                          value={providerEditor.baseUrl}
                                          onChange={(e) =>
                                            setProviderEditor((c) =>
                                              c ? { ...c, baseUrl: e.target.value } : c
                                            )
                                          }
                                          placeholder="http://127.0.0.1:11434/v1"
                                        />
                                      </div>
                                      {isLocalOpenAiCompatibleBaseUrl(providerEditor.baseUrl.trim()) && (
                                        <div className="settings-field">
                                          <label>Context window</label>
                                          <input
                                            type="number"
                                            min={0}
                                            step={1000}
                                            value={providerEditor.contextWindowTokens}
                                            onChange={(e) =>
                                              setProviderEditor((c) =>
                                                c ? { ...c, contextWindowTokens: e.target.value } : c
                                              )
                                            }
                                            placeholder="100000"
                                          />
                                          {editContextWindowError && (
                                            <p className="helper-copy" style={{ color: "var(--danger-400)" }}>
                                              {editContextWindowError}
                                            </p>
                                          )}
                                        </div>
                                      )}
                                    </>
                                  )}
                                  <div className="settings-field">
                                    <label>Default model</label>
                                    <select
                                      value={providerEditor.defaultModelId}
                                      onChange={(e) =>
                                        setProviderEditor((c) =>
                                          c ? { ...c, defaultModelId: e.target.value } : c
                                        )
                                      }
                                    >
                                      <option value="">Use connector default</option>
                                      {models.map((model) => (
                                        <option key={model} value={model}>{model}</option>
                                      ))}
                                    </select>
                                  </div>
                                  {provider.typeId !== "codex-cli" && (
                                    <div className="settings-field">
                                      <label>Replace API key</label>
                                      <input
                                        type="password"
                                        value={providerEditor.apiKey}
                                        onChange={(e) =>
                                          setProviderEditor((c) =>
                                            c ? { ...c, apiKey: e.target.value } : c
                                          )
                                        }
                                        placeholder="Leave blank to keep current"
                                      />
                                    </div>
                                  )}
                                </div>
                                <div className="settings-provider-actions" style={{ borderTop: "none", paddingTop: 0 }}>
                                  <button className="button ghost" onClick={stopEditingProvider}>
                                    Cancel
                                  </button>
                                  <button
                                    className="button primary"
                                    onClick={() => void saveProviderEdits(provider)}
                                    disabled={
                                      busy ||
                                      !providerEditor.name.trim() ||
                                      (provider.typeId === "openai-compatible" &&
                                        !providerEditor.baseUrl.trim()) ||
                                      Boolean(editContextWindowError)
                                    }
                                  >
                                    {busy ? "Saving..." : "Save Provider"}
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Actions */}
                            <div className="settings-provider-actions">
                              {provider.status === "connected" ? (
                                <button
                                  className="button"
                                  onClick={() => void mutateProvider(provider.id, "recheck")}
                                  disabled={busy}
                                >
                                  {busy ? "Refreshing..." : "Refresh Models"}
                                </button>
                              ) : (
                                <button
                                  className="button primary"
                                  onClick={() =>
                                    void mutateProvider(
                                      provider.id,
                                      provider.capabilities.requiresBrowserAuth ? "connect" : "recheck",
                                    )
                                  }
                                  disabled={busy}
                                >
                                  {busy
                                    ? "Working..."
                                    : provider.capabilities.requiresBrowserAuth
                                      ? "Launch Login"
                                      : "Connect"}
                                </button>
                              )}
                              {provider.capabilities.requiresBrowserAuth && (
                                <button
                                  className="button"
                                  onClick={() => void mutateProvider(provider.id, "reconnect")}
                                  disabled={busy}
                                >
                                  Reconnect
                                </button>
                              )}
                              {!isEditing && (
                                <button
                                  className="button"
                                  onClick={() => startEditingProvider(provider)}
                                  disabled={busy}
                                >
                                  Edit
                                </button>
                              )}
                              <button
                                className="button ghost"
                                onClick={() => {
                                  if (window.confirm(`Remove "${provider.name}"?`)) {
                                    void mutateProvider(provider.id, "delete");
                                  }
                                }}
                                disabled={busy}
                              >
                                Remove
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* Roles Panel */}
            {activePanel === "roles" && (
              <div className="settings-pane">
                <div className="settings-pane-head">
                  <div>
                    <h2>Roles</h2>
                    <p className="helper-copy">Assign providers and models to each role.</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <button
                      className="button"
                      onClick={autoAssignRoles}
                      disabled={roleReadyProviders.length === 0}
                    >
                      Auto-Assign
                    </button>
                    {renderWorkspaceSaveAction("Save Roles")}
                  </div>
                </div>

                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Role Routing</h3>
                    <p className="helper-copy">Map each role to a provider and model.</p>
                  </div>

                  {connectedProviders.length === 0 ? (
                    <div className="settings-empty-state" style={{ margin: "0 1.5rem 1.25rem" }}>
                      <strong>Connect a provider first</strong>
                      <span>Role assignment becomes available once a provider is connected.</span>
                    </div>
                  ) : (
                    <div className="settings-role-list">
                      {assignments.map((assignment) => {
                        const selectedProvider = assignment.providerId
                          ? providerMap.get(assignment.providerId) ?? null
                          : null;
                        const availableModels = selectedProvider
                          ? providerModelsMap.get(selectedProvider.id) ?? []
                          : [];

                        return (
                          <article key={assignment.role} className="settings-role-row">
                            <div className="role-info">
                              <strong>{ROLE_DETAILS[assignment.role].title}</strong>
                              <span>{ROLE_DETAILS[assignment.role].description}</span>
                            </div>
                            <div className="settings-field">
                              <label>Provider</label>
                              <select
                                value={assignment.providerId ?? ""}
                                onChange={(e) => updateRoleProvider(assignment.role, e.target.value)}
                              >
                                <option value="">Select provider...</option>
                                {connectedProviders
                                  .filter((p) => p.capabilities.canChat)
                                  .map((p) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                  ))}
                              </select>
                            </div>
                            <div className="settings-field">
                              <label>Model</label>
                              <select
                                value={assignment.modelId ?? ""}
                                onChange={(e) => updateRoleModel(assignment.role, e.target.value)}
                                disabled={!selectedProvider || availableModels.length === 0}
                              >
                                <option value="">
                                  {selectedProvider ? "Select model..." : "Choose provider first"}
                                </option>
                                {availableModels.map((model) => (
                                  <option key={model} value={model}>{model}</option>
                                ))}
                              </select>
                            </div>
                            <span
                              className={`settings-role-badge${
                                assignment.providerId && assignment.modelId ? " assigned" : ""
                              }`}
                            >
                              {assignment.providerId && assignment.modelId ? "Assigned" : "Setup"}
                            </span>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* MCP Panel */}
            {activePanel === "mcp" && (
              <div className="settings-pane">
                <div className="settings-pane-head">
                  <div>
                    <h2>MCP</h2>
                    <p className="helper-copy">Manage global MCP servers and the tool surfaces they expose.</p>
                  </div>
                  <button
                    className="button"
                    onClick={() => void reloadMcpServers()}
                    disabled={mcpBusyKey === "reload"}
                  >
                    {mcpBusyKey === "reload" ? "Reloading..." : "Reload Servers"}
                  </button>
                </div>

                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Runtime Status</h3>
                    <p className="helper-copy">Audit the current MCP registry, memory engine, and config layers.</p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-stats-grid" style={{ padding: 0 }}>
                      <div className="settings-stat-card">
                        <strong>{mcpState.stats.runningServers}/{mcpState.stats.configuredServers}</strong>
                        <span className="settings-stat-label">MCP Servers Running</span>
                      </div>
                      <div className="settings-stat-card">
                        <strong>{mcpState.stats.activeTools}</strong>
                        <span className="settings-stat-label">Active MCP Tools</span>
                      </div>
                      <div className="settings-stat-card">
                        <strong>{mcpState.stats.drainingServers ?? 0}</strong>
                        <span className="settings-stat-label">Draining Servers</span>
                      </div>
                      <div className="settings-stat-card">
                        <strong>{settings.memory.enabled ? "On" : "Off"}</strong>
                        <span className="settings-stat-label">Memory Engine</span>
                      </div>
                    </div>
                    <div className="settings-info-note">
                      <span className="label">Layers</span>
                      <p>
                        {mcpState.layers
                          .map((layer) =>
                            `${formatMcpScope(layer.scope)}: ${layer.exists ? `${layer.serverCount} server${layer.serverCount === 1 ? "" : "s"}` : "missing"}`,
                          )
                          .join(" · ")}
                      </p>
                    </div>
                  </div>
                </section>

                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Service Keys</h3>
                    <p className="helper-copy">
                      API keys and credentials for MCP servers that connect to external services.
                      Keys are saved to your user config and persist across projects.
                    </p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-service-keys-grid">
                      {MCP_SERVICE_KEYS.map((def) => {
                        const serverStatus = mcpState.items.find((s) => s.name === def.serverName);
                        const isRunning = serverStatus?.status === "running";
                        const isDisabled = serverStatus?.status === "disabled";
                        const isError = serverStatus?.status === "error";
                        const hasAllKeys = def.envKeys.every(
                          (e) => (serviceKeys[def.serverName]?.[e.key]?.trim() ?? "").length > 0,
                        );
                        const isSaving = serviceKeySaving === def.serverName;

                        return (
                          <article key={def.serverName} className="settings-service-key-card">
                            <div className="settings-service-key-head">
                              <div>
                                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                  <div
                                    className={`provider-status-dot ${isRunning ? "connected" : isError ? "error" : "idle"}`}
                                  />
                                  <h4 style={{ margin: 0, fontSize: "0.95rem" }}>{def.label}</h4>
                                </div>
                                <p className="helper-copy" style={{ margin: "0.25rem 0 0 0" }}>
                                  {def.description}
                                </p>
                              </div>
                              <span
                                className={`settings-status-pill ${isRunning ? "connected" : isDisabled ? "idle" : isError ? "error" : "idle"}`}
                                style={{ flexShrink: 0 }}
                              >
                                {isRunning ? "Active" : isError ? "Error" : isDisabled ? "Needs keys" : "Configured"}
                              </span>
                            </div>
                            <div className="settings-service-key-fields">
                              {def.envKeys.map((envDef) => (
                                <div key={envDef.key} className="settings-field">
                                  <label>
                                    {envDef.label}
                                    {envDef.helpUrl && (
                                      <>
                                        {" "}
                                        <a
                                          href={envDef.helpUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          style={{ color: "var(--accent)", fontSize: "0.8rem" }}
                                        >
                                          Get key
                                        </a>
                                      </>
                                    )}
                                  </label>
                                  <input
                                    type={envDef.sensitive === false ? "text" : "password"}
                                    value={serviceKeys[def.serverName]?.[envDef.key] ?? ""}
                                    onChange={(e) => setServiceKey(def.serverName, envDef.key, e.target.value)}
                                    placeholder={envDef.placeholder}
                                    autoComplete={envDef.sensitive === false ? "off" : "new-password"}
                                  />
                                </div>
                              ))}
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.5rem" }}>
                              <button
                                className="button primary"
                                style={{ padding: "0.4rem 1rem", fontSize: "0.85rem" }}
                                onClick={() => void saveServiceKey(def)}
                                disabled={isSaving}
                              >
                                {isSaving ? "Saving..." : hasAllKeys ? "Save & Enable" : "Save"}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                </section>

                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Add MCP Server</h3>
                    <p className="helper-copy">Install a public npm MCP package or add a remote SSE/Streamable HTTP endpoint, scope it to roles, then reload it into the live tool registry.</p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-field-row">
                      <div className="settings-field">
                        <label>Transport</label>
                        <select
                          value={mcpInstallTransport}
                          onChange={(e) => setMcpInstallTransport(e.target.value as McpInstallTransport)}
                        >
                          <option value="package">Public npm package</option>
                          <option value="streamable-http">Streamable HTTP</option>
                          <option value="sse">SSE</option>
                        </select>
                      </div>
                      <div className="settings-field">
                        <label>{mcpInstallTransport === "package" ? "npm package" : "Endpoint URL"}</label>
                        {mcpInstallTransport === "package" ? (
                          <input
                            value={mcpPackageName}
                            onChange={(e) => setMcpPackageName(e.target.value)}
                            placeholder="@modelcontextprotocol/server-filesystem"
                          />
                        ) : (
                          <input
                            value={mcpRemoteUrl}
                            onChange={(e) => setMcpRemoteUrl(e.target.value)}
                            placeholder={mcpInstallTransport === "sse" ? "https://mcp.example.test/sse" : "https://mcp.example.test/mcp"}
                          />
                        )}
                      </div>
                      <div className="settings-field">
                        <label>
                          Server name <span className="optional">(optional)</span>
                        </label>
                        <input
                          value={mcpServerName}
                          onChange={(e) => setMcpServerName(e.target.value)}
                          placeholder="filesystem"
                        />
                      </div>
                      <div className="settings-field">
                        <label>Scope</label>
                        <select
                          value={mcpScope}
                          onChange={(e) => setMcpScope(e.target.value as Exclude<McpConfigScope, "default">)}
                        >
                          <option value="project">Project</option>
                          <option value="user">User</option>
                        </select>
                      </div>
                      <div className="settings-field">
                        <label>Timeout ms</label>
                        <input
                          type="number"
                          min={1000}
                          step={1000}
                          value={mcpTimeout}
                          onChange={(e) => setMcpTimeout(e.target.value)}
                          placeholder="30000"
                        />
                      </div>
                    </div>
                    <div className="settings-field-row">
                      <div className="settings-field">
                        <label>
                          Description <span className="optional">(optional)</span>
                        </label>
                        <input
                          value={mcpDescription}
                          onChange={(e) => setMcpDescription(e.target.value)}
                          placeholder="Short note for why this server is installed"
                        />
                      </div>
                      <div className="settings-field">
                        <label>
                          {mcpInstallTransport === "package"
                            ? "Extra args "
                            : "Headers "}
                          <span className="optional">
                            {mcpInstallTransport === "package"
                              ? "(one token per line)"
                              : "(KEY=VALUE per line)"}
                          </span>
                        </label>
                        <textarea
                          value={mcpInstallTransport === "package" ? mcpArgs : mcpHeaders}
                          onChange={(e) =>
                            mcpInstallTransport === "package"
                              ? setMcpArgs(e.target.value)
                              : setMcpHeaders(e.target.value)
                          }
                          rows={4}
                          placeholder={
                            mcpInstallTransport === "package"
                              ? "--root\n.\n--read-only"
                              : "Authorization=Bearer ...\nX-Workspace=demo"
                          }
                        />
                      </div>
                    </div>
                    <div className="settings-field">
                      <label>Allowed roles</label>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginTop: "0.75rem" }}>
                        {ROLES.filter((role) => role !== "dispatch").map((role) => (
                          <label
                            key={role}
                            style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", fontSize: "0.9rem" }}
                          >
                            <input
                              type="checkbox"
                              checked={mcpRoles.includes(role)}
                              onChange={() => toggleMcpRole(role)}
                            />
                            {ROLE_DETAILS[role].title}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="form-actions">
                      <button className="button ghost" onClick={resetMcpInstaller}>
                        Reset
                      </button>
                      <button
                        className="button primary"
                        onClick={() => void installMcpPackage()}
                        disabled={
                          mcpBusyKey === "install" ||
                          (mcpInstallTransport === "package" ? !mcpPackageName.trim() : !mcpRemoteUrl.trim()) ||
                          mcpRoles.length === 0
                        }
                      >
                        {mcpBusyKey === "install" ? "Saving..." : "Add MCP Server"}
                      </button>
                    </div>
                  </div>
                </section>

                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Configured Servers</h3>
                    <p className="helper-copy">Inspect the live MCP surfaces and remove user or project servers when they are no longer needed.</p>
                  </div>
                  {mcpState.items.length === 0 ? (
                    <div className="settings-empty-state" style={{ margin: "0 1.5rem 1.25rem" }}>
                      <strong>No MCP servers configured</strong>
                      <span>Install a public package above or add a project override later.</span>
                    </div>
                  ) : (
                    <div className="settings-provider-list">
                      {mcpState.items.map((server) => {
                        const busyKey = `remove:${server.sourceScope}:${server.name}`;
                        const removable = server.sourceScope !== "default";
                        return (
                          <article key={`${server.sourceScope}:${server.name}`} className="settings-provider-card">
                            <div className="settings-provider-head">
                              <div className="settings-provider-title">
                                <div className={`provider-status-dot ${server.status === "error" ? "error" : server.status === "running" ? "connected" : "idle"}`} />
                                <div>
                                  <span className="type-label">{formatMcpScope(server.sourceScope)}</span>
                                  <h3>{server.name}</h3>
                                  <p className="helper-copy">
                                    {server.config.description?.trim() || formatMcpTarget(server.config, server.target)}
                                  </p>
                                </div>
                              </div>
                              <span className={`settings-status-pill ${server.status === "error" ? "error" : server.status === "running" ? "connected" : "idle"}`}>
                                {formatMcpStatus(server.status)}
                              </span>
                            </div>

                            <div className="settings-provider-meta">
                              <span>{formatMcpTransport(server.config)}</span>
                              <span>{server.roles.length > 0 ? server.roles.join(", ") : "No roles"}</span>
                              <span>{server.toolNames.length} tool{server.toolNames.length === 1 ? "" : "s"}</span>
                              {typeof server.config.timeout === "number" && <span>{server.config.timeout} ms timeout</span>}
                              {typeof server.activeCalls === "number" && server.activeCalls > 0 && <span>{server.activeCalls} active call{server.activeCalls === 1 ? "" : "s"}</span>}
                            </div>

                            {server.lastError ? (
                              <div className="provider-error">{server.lastError}</div>
                            ) : null}

                            {server.toolNames.length > 0 ? (
                              <div className="settings-model-pills">
                                {server.toolNames.slice(0, 4).map((toolName) => (
                                  <span key={toolName} className="settings-model-pill">{toolName}</span>
                                ))}
                                {server.toolNames.length > 4 && (
                                  <span className="settings-model-pill muted">+{server.toolNames.length - 4} more</span>
                                )}
                              </div>
                            ) : null}

                            <div className="settings-provider-actions">
                              {removable ? (
                                <button
                                  className="button ghost"
                                  onClick={() => {
                                    if (window.confirm(`Remove MCP server "${server.name}" from ${server.sourceScope} scope?`)) {
                                      void removeScopedMcpServer(server.sourceScope as Exclude<McpConfigScope, "default">, server.name);
                                    }
                                  }}
                                  disabled={mcpBusyKey === busyKey}
                                >
                                  {mcpBusyKey === busyKey ? "Removing..." : "Remove"}
                                </button>
                              ) : (
                                <div className="settings-info-note" style={{ marginLeft: 0 }}>
                                  <span className="label">Bundled</span>
                                  <p>Bundled defaults live in the repo and are removed by override, not deletion.</p>
                                </div>
                              )}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* Prompts Panel */}
            {activePanel === "prompts" && (
              <div className="settings-pane">
                <div className="settings-pane-head">
                  <div>
                    <h2>Prompts</h2>
                    <p className="helper-copy">Override default system prompts for specific roles.</p>
                  </div>
                  {renderWorkspaceSaveAction("Save Changes")}
                </div>

                {/* Shared Prompt */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Shared Prompt</h3>
                    <p className="helper-copy">Applied to every routed role.</p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-field">
                      <label>Shared system prompt</label>
                      <textarea
                        value={settings.systemPrompts.shared}
                        onChange={(e) =>
                          setSettings((c) => ({
                            ...c,
                            systemPrompts: { ...c.systemPrompts, shared: e.target.value },
                          }))
                        }
                        rows={4}
                        placeholder="Optional instructions applied to every role"
                      />
                    </div>
                  </div>
                </section>

                {/* Role Prompts */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Role Prompts</h3>
                    <p className="helper-copy">Edit only the roles that need specialized behavior.</p>
                  </div>
                  <div className="settings-prompt-grid">
                    {ROLES.map((role) => (
                      <div key={role} className="settings-field">
                        <label>{ROLE_DETAILS[role].title}</label>
                        <textarea
                          value={settings.systemPrompts.roles[role]}
                          onChange={(e) => setRolePrompt(role, e.target.value)}
                          rows={4}
                          placeholder={`Override for ${ROLE_DETAILS[role].title.toLowerCase()}`}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {/* Simulation Panel */}
            {activePanel === "simulation" && (
              <div className="settings-pane">
                <div className="settings-pane-head">
                  <div>
                    <h2>Simulation</h2>
                    <p className="helper-copy">Configure swarm simulation defaults and provider pool.</p>
                  </div>
                  {renderWorkspaceSaveAction("Save Changes")}
                </div>

                {/* Execution Defaults */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Execution Defaults</h3>
                    <p className="helper-copy">Default parameters for new simulations.</p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-field-row">
                      <div className="settings-field">
                        <label>Personas <span className="optional">{MIN_SWARM_PERSONAS}-{MAX_SWARM_PERSONAS}</span></label>
                        <input
                          type="number"
                          min={MIN_SWARM_PERSONAS}
                          max={MAX_SWARM_PERSONAS}
                          value={settings.simulation?.defaultPersonaCount ?? MIN_SWARM_PERSONAS}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw === "" ? undefined : parseInt(raw);
                            setSettings((c) => ({ ...c, simulation: { ...c.simulation, defaultPersonaCount: n } }));
                          }}
                          onBlur={() =>
                            setSettings((c) => ({
                              ...c,
                              simulation: {
                                ...c.simulation,
                                defaultPersonaCount: clampInt(
                                  c.simulation?.defaultPersonaCount ?? MIN_SWARM_PERSONAS,
                                  MIN_SWARM_PERSONAS,
                                  MAX_SWARM_PERSONAS,
                                ),
                              },
                            }))
                          }
                        />
                      </div>
                      <div className="settings-field">
                        <label>Rounds <span className="optional">{MIN_SWARM_ROUNDS}-{MAX_SWARM_ROUNDS}</span></label>
                        <input
                          type="number"
                          min={MIN_SWARM_ROUNDS}
                          max={MAX_SWARM_ROUNDS}
                          value={settings.simulation?.defaultRoundCount ?? 3}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw === "" ? undefined : parseInt(raw);
                            setSettings((c) => ({ ...c, simulation: { ...c.simulation, defaultRoundCount: n } }));
                          }}
                          onBlur={() =>
                            setSettings((c) => ({
                              ...c,
                              simulation: {
                                ...c.simulation,
                                defaultRoundCount: clampInt(
                                  c.simulation?.defaultRoundCount ?? 3,
                                  MIN_SWARM_ROUNDS,
                                  MAX_SWARM_ROUNDS,
                                ),
                              },
                            }))
                          }
                        />
                      </div>
                      <div className="settings-field">
                        <label>Concurrency <span className="optional">{MIN_SWARM_CONCURRENCY}-{MAX_SWARM_CONCURRENCY}</span></label>
                        <input
                          type="number"
                          min={MIN_SWARM_CONCURRENCY}
                          max={MAX_SWARM_CONCURRENCY}
                          value={settings.simulation?.maxConcurrency ?? 4}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw === "" ? undefined : parseInt(raw);
                            setSettings((c) => ({ ...c, simulation: { ...c.simulation, maxConcurrency: n } }));
                          }}
                          onBlur={() =>
                            setSettings((c) => ({
                              ...c,
                              simulation: {
                                ...c.simulation,
                                maxConcurrency: clampInt(
                                  c.simulation?.maxConcurrency ?? 4,
                                  MIN_SWARM_CONCURRENCY,
                                  MAX_SWARM_CONCURRENCY,
                                ),
                              },
                            }))
                          }
                        />
                      </div>
                      <div className="settings-field">
                        <label>Timeout <span className="optional">ms</span></label>
                        <input
                          type="number"
                          min={5000}
                          max={120000}
                          step={1000}
                          value={settings.simulation?.personaTimeoutMs ?? 60000}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw === "" ? undefined : parseInt(raw);
                            setSettings((c) => ({ ...c, simulation: { ...c.simulation, personaTimeoutMs: n } }));
                          }}
                          onBlur={() =>
                            setSettings((c) => ({
                              ...c,
                              simulation: { ...c.simulation, personaTimeoutMs: Math.max(5000, Math.min(120000, c.simulation?.personaTimeoutMs ?? 60000)) },
                            }))
                          }
                        />
                      </div>
                    </div>
                    <div className="settings-field">
                      <label className="settings-checkbox">
                        <input
                          type="checkbox"
                          checked={settings.simulation?.autoRetryOnParseFail ?? true}
                          onChange={(e) =>
                            setSettings((c) => ({
                              ...c,
                              simulation: {
                                ...c.simulation,
                                autoRetryOnParseFail: e.target.checked,
                              },
                            }))
                          }
                        />
                        Auto-retry on parse failure
                      </label>
                    </div>
                    <div className="settings-field">
                      <label className="settings-checkbox">
                        <input
                          type="checkbox"
                          checked={settings.simulation?.compactMode ?? false}
                          onChange={(e) =>
                            setSettings((c) => ({
                              ...c,
                              simulation: {
                                ...c.simulation,
                                compactMode: e.target.checked,
                              },
                            }))
                          }
                        />
                        Force compact prompts (for small models)
                      </label>
                    </div>
                  </div>
                </section>

                {/* Simulation Provider Pool */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Provider &amp; Model Pool</h3>
                    <p className="helper-copy">
                      Choose which providers and models to use in simulations.
                      Only connected providers with available models are shown.
                    </p>
                  </div>
                  <div className="settings-block-content">
                    <div className="helper-copy" style={{ marginBottom: "0.5rem" }}>
                      Configured persona instances: <strong>{configuredPersonaInstances}</strong> / target personas: <strong>{targetSimulationPersonas}</strong>
                      {simulationDeploymentMismatch && (
                        <span style={{ color: "var(--danger-400)", marginLeft: "0.5rem" }}>
                          Mismatch. Set replicas so totals match exactly.
                        </span>
                      )}
                    </div>
                    {roleReadyProviders.length === 0 ? (
                      <p className="helper-copy" style={{ opacity: 0.6 }}>
                        No connected providers with models available. Add providers in the Providers tab first.
                      </p>
                    ) : (
                      <>
                        {roleReadyProviders.map((provider) => {
                          const models = providerModelsMap.get(provider.id) ?? [];
                          const pool = settings.simulation?.providerModelPool ?? [];
                          const providerEntries = pool.filter((e) => e.providerId === provider.id);
                          const hasAnyEntry = providerEntries.length > 0;

                          return (
                            <div
                              key={provider.id}
                              className="settings-field"
                              style={{
                                border: `1px solid ${hasAnyEntry ? "var(--border-accent)" : "var(--border)"}`,
                                borderRadius: "var(--radius-md)",
                                padding: "0.75rem",
                                marginBottom: "0.5rem",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: hasAnyEntry ? "0.5rem" : 0 }}>
                                <label style={{ fontWeight: 600, fontSize: "0.82rem" }}>{provider.name}</label>
                                <span style={{ fontSize: "0.68rem", color: "var(--text-tertiary)" }}>
                                  {models.length} model{models.length !== 1 ? "s" : ""}
                                </span>
                              </div>

                              {/* Entries for this provider */}
                              {providerEntries.map((entry, ei) => (
                                <div key={`${entry.providerId}-${entry.modelId}-${ei}`} style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.35rem", flexWrap: "wrap" }}>
                                  <select
                                    style={{ flex: "1 1 140px", minWidth: 0, fontSize: "0.78rem" }}
                                    value={entry.modelId}
                                    onChange={(e) => {
                                      const updated = [...pool];
                                      const idx = updated.findIndex((x) => x === entry);
                                      if (idx >= 0) updated[idx] = { ...entry, modelId: e.target.value };
                                      setSettings((c) => ({ ...c, simulation: { ...c.simulation, providerModelPool: updated } }));
                                    }}
                                  >
                                    {models.map((m) => (
                                      <option key={m} value={m}>{m}</option>
                                    ))}
                                  </select>
                                  <select
                                    style={{ width: "90px", fontSize: "0.78rem" }}
                                    value={entry.usage}
                                    onChange={(e) => {
                                      const updated = [...pool];
                                      const idx = updated.findIndex((x) => x === entry);
                                      if (idx >= 0) updated[idx] = { ...entry, usage: e.target.value as "persona" | "synthesis" | "both" };
                                      setSettings((c) => ({ ...c, simulation: { ...c.simulation, providerModelPool: updated } }));
                                    }}
                                  >
                                    <option value="both">Both</option>
                                    <option value="persona">Persona</option>
                                    <option value="synthesis">Synthesis</option>
                                  </select>
                                  <input
                                    type="number"
                                    min={1}
                                    max={99}
                                    title="Priority (lower = used first)"
                                    placeholder="Pri"
                                    style={{ width: "52px", fontSize: "0.78rem", textAlign: "center" }}
                                    value={entry.priority ?? 50}
                                    onChange={(e) => {
                                      const updated = [...pool];
                                      const idx = updated.findIndex((x) => x === entry);
                                      if (idx >= 0) updated[idx] = { ...entry, priority: Math.max(1, parseInt(e.target.value) || 50) };
                                      setSettings((c) => ({ ...c, simulation: { ...c.simulation, providerModelPool: updated } }));
                                    }}
                                  />
                                  <input
                                    type="number"
                                    min={1}
                                    max={MAX_SWARM_PERSONAS}
                                    title="Replicas/instances for this provider+model"
                                    placeholder="Rep"
                                    style={{ width: "58px", fontSize: "0.78rem", textAlign: "center" }}
                                    value={entry.replicas ?? 1}
                                    onChange={(e) => {
                                      const updated = [...pool];
                                      const idx = updated.findIndex((x) => x === entry);
                                      if (idx >= 0) updated[idx] = {
                                        ...entry,
                                        replicas: clampInt(parseInt(e.target.value) || 1, 1, MAX_SWARM_PERSONAS),
                                      };
                                      setSettings((c) => ({ ...c, simulation: { ...c.simulation, providerModelPool: updated } }));
                                    }}
                                  />
                                  <label className="settings-checkbox" style={{ fontSize: "0.72rem", gap: "0.25rem" }}>
                                    <input
                                      type="checkbox"
                                      checked={entry.enabled !== false}
                                      onChange={(e) => {
                                        const updated = [...pool];
                                        const idx = updated.findIndex((x) => x === entry);
                                        if (idx >= 0) updated[idx] = { ...entry, enabled: e.target.checked };
                                        setSettings((c) => ({ ...c, simulation: { ...c.simulation, providerModelPool: updated } }));
                                      }}
                                    />
                                    On
                                  </label>
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    style={{ width: "1.4rem", height: "1.4rem" }}
                                    title="Remove"
                                    onClick={() => {
                                      const updated = pool.filter((x) => x !== entry);
                                      setSettings((c) => ({ ...c, simulation: { ...c.simulation, providerModelPool: updated } }));
                                    }}
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                  </button>
                                </div>
                              ))}

                              {/* Add model button */}
                              {models.length > 0 && (
                                <button
                                  type="button"
                                  className="text-btn"
                                  style={{ fontSize: "0.72rem", marginTop: hasAnyEntry ? "0.25rem" : 0 }}
                                  onClick={() => {
                                    const newEntry = {
                                      providerId: provider.id,
                                      modelId: models[0],
                                      usage: "both" as const,
                                      priority: 50,
                                      enabled: true,
                                      replicas: 1,
                                    };
                                    setSettings((c) => ({
                                      ...c,
                                      simulation: {
                                        ...c.simulation,
                                        providerModelPool: [...(c.simulation?.providerModelPool ?? []), newEntry],
                                      },
                                    }));
                                  }}
                                >
                                  + Add model from {provider.name}
                                </button>
                              )}
                            </div>
                          );
                        })}

                        {(settings.simulation?.providerModelPool ?? []).length > 0 && (
                          <p className="helper-copy" style={{ fontSize: "0.68rem", marginTop: "0.5rem" }}>
                            Usage: <strong>Persona</strong> = individual agents, <strong>Synthesis</strong> = round/final summaries, <strong>Both</strong> = either.
                            Lower priority number = used first. <strong>Rep</strong> sets per-model instances and must total your persona count.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </section>

                {/* Provider Use Policy */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Provider Policy</h3>
                    <p className="helper-copy">How providers are distributed across simulation personas.</p>
                  </div>
                  <div className="settings-block-content">
                    <div className="settings-field">
                      <label>Distribution strategy</label>
                      <select
                        value={settings.simulation?.providerUsePolicy?.strategy ?? "use-all-selected"}
                        onChange={(e) =>
                          setSettings((c) => ({
                            ...c,
                            simulation: {
                              ...c.simulation,
                              providerUsePolicy: {
                                ...c.simulation?.providerUsePolicy,
                                strategy: e.target.value as "use-all-selected" | "weighted-distribution" | "tier-strict",
                              },
                            },
                          }))
                        }
                      >
                        <option value="use-all-selected">Use all selected providers</option>
                        <option value="weighted-distribution">Weighted distribution</option>
                        <option value="tier-strict">Strict tier routing</option>
                      </select>
                    </div>
                    <div className="settings-field">
                      <label>Fallback strategy</label>
                      <select
                        value={settings.simulation?.providerUsePolicy?.fallbackStrategy ?? "continue-with-remaining"}
                        onChange={(e) =>
                          setSettings((c) => ({
                            ...c,
                            simulation: {
                              ...c.simulation,
                              providerUsePolicy: {
                                ...c.simulation?.providerUsePolicy,
                                fallbackStrategy: e.target.value as "continue-with-remaining" | "retry-on-same-tier" | "fail-fast",
                              },
                            },
                          }))
                        }
                      >
                        <option value="continue-with-remaining">Continue with remaining providers</option>
                        <option value="retry-on-same-tier">Retry on same tier</option>
                        <option value="fail-fast">Fail fast</option>
                      </select>
                    </div>
                    <div className="settings-field">
                      <label className="settings-checkbox">
                        <input
                          type="checkbox"
                          checked={settings.simulation?.providerUsePolicy?.enforceAllProvidersPerRun ?? true}
                          onChange={(e) =>
                            setSettings((c) => ({
                              ...c,
                              simulation: {
                                ...c.simulation,
                                providerUsePolicy: {
                                  ...c.simulation?.providerUsePolicy,
                                  enforceAllProvidersPerRun: e.target.checked,
                                },
                              },
                            }))
                          }
                        />
                        Enforce all providers per run
                      </label>
                    </div>
                  </div>
                </section>

                {/* Past Simulations */}
                <section className="settings-block">
                  <div className="settings-block-head">
                    <h3>Past Simulations</h3>
                    <p className="helper-copy">Browse and manage previous swarm simulation runs.</p>
                  </div>
                  <div className="settings-block-content">
                    <SimulationHistory />
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
