import type {
  ConnectorType,
  ConnectorTypeId,
  Provider,
  ProviderCapabilities,
  RoleAssignment,
  RuntimeState,
  Settings,
} from "./types";
import { ROLES } from "./types";

export const defaultConnectorTypes: ConnectorType[] = [
  {
    id: "codex-cli",
    name: "Codex CLI",
    description:
      "Use the local Codex CLI browser login flow and auth status checks.",
    kind: "cli",
    setupFields: ["defaultModelId"],
  },
  {
    id: "claude-code-cli",
    name: "Claude Code CLI",
    description:
      "Use the local Claude Code browser login flow and auth status checks.",
    kind: "cli",
    setupFields: ["defaultModelId"],
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    description: "Connect with an API key for Anthropic-hosted models.",
    kind: "api",
    setupFields: ["apiKey", "defaultModelId"],
  },
  {
    id: "openai-compatible",
    name: "OpenAI-Compatible Endpoint",
    description:
      "Connect local model servers and compatible hosted providers with an OpenAI-style API.",
    kind: "endpoint",
    setupFields: ["baseUrl", "apiKey", "defaultModelId"],
  },
];

export const defaultRoleAssignments = (): RoleAssignment[] =>
  ROLES.map((role) => ({
    role,
    providerId: null,
    modelId: null,
  }));

export const defaultSettings = (workspaceRoot: string): Settings => ({
  humanName: "Operator",
  workspaceRoot,
  themePreference: "ember-night",
  tailscaleStatus: "Not configured",
  systemPrompts: {
    shared: "",
    roles: {
      router: "",
      assistant: "",
      planner: "",
      coder: "",
      auditor: "",
      janitor: "",
    },
  },
  runtimeInfo: {
    webUrl: "http://127.0.0.1:3000",
    apiUrl: "http://127.0.0.1:3005",
  },
});

export function normalizeSettings(
  settings: Partial<Settings>,
  workspaceRoot: string,
): Settings {
  const defaults = defaultSettings(workspaceRoot);

  return {
    ...defaults,
    ...settings,
    systemPrompts: {
      ...defaults.systemPrompts,
      ...settings.systemPrompts,
      roles: {
        ...defaults.systemPrompts.roles,
        ...settings.systemPrompts?.roles,
      },
    },
    runtimeInfo: {
      ...defaults.runtimeInfo,
      ...settings.runtimeInfo,
    },
  };
}

export const defaultRuntime = (): RuntimeState => ({
  serverPid: null,
  webPid: null,
  startedAt: null,
  webUrl: "http://127.0.0.1:3000",
  apiUrl: "http://127.0.0.1:3005",
  status: "idle",
});

export function getProviderCapabilities(
  typeId: ConnectorTypeId,
): ProviderCapabilities {
  switch (typeId) {
    case "codex-cli":
      return {
        canChat: true,
        canListModels: true,
        requiresBrowserAuth: true,
        canUseImages: false,
      };
    case "claude-code-cli":
      return {
        canChat: false,
        canListModels: true,
        requiresBrowserAuth: true,
        canUseImages: false,
      };
    case "anthropic-api":
    case "openai-compatible":
      return {
        canChat: true,
        canListModels: true,
        requiresBrowserAuth: false,
        canUseImages: true,
      };
  }
}

export function normalizeProvider(provider: Provider): Provider {
  return {
    ...provider,
    availableModels: provider.availableModels ?? [],
    capabilities: getProviderCapabilities(provider.typeId),
  };
}
