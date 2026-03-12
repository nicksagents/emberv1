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
import type { MemoryConfig } from "./memory/types";
import { defaultMemoryConfig, normalizeMemoryConfig } from "./memory/defaults";

const REMOTE_PROVIDER_CONTEXT_WINDOW_TOKENS = 300_000;
const DEFAULT_LOCAL_PROVIDER_CONTEXT_WINDOW_TOKENS = 100_000;
const RESPONSE_HEADROOM_CONTEXT_RATIO = 0.32;
const SAFETY_MARGIN_CONTEXT_RATIO = 0.12;

export const defaultConnectorTypes: ConnectorType[] = [
  {
    id: "codex-cli",
    name: "Codex CLI",
    description:
      "Use the local Codex OAuth browser login flow and Codex CLI auth status checks.",
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
  sudoPassword: "",
  braveApiKey: "",
  compression: {
    enabled: true,
    contextWindowTokens: 100_000,
    responseHeadroomTokens: 24_000,
    safetyMarginTokens: 12_000,
    maxPromptTokens: 64_000,
    targetPromptTokens: 56_000,
    preserveRecentMessages: 6,
    minimumRecentMessages: 4,
  },
  systemPrompts: {
    shared: "",
    roles: {
      dispatch: "",
      coordinator: "",
      advisor: "",
      director: "",
      inspector: "",
      ops: "",
    },
  },
  runtimeInfo: {
    webUrl: "http://127.0.0.1:3000",
    apiUrl: "http://127.0.0.1:3005",
  },
  memory: defaultMemoryConfig(),
});

export interface CompressionPromptBudget {
  contextWindowTokens: number;
  responseHeadroomTokens: number;
  safetyMarginTokens: number;
  maxPromptTokens: number;
  targetPromptTokens: number;
}

export function deriveCompressionPromptBudget(
  compression: Pick<
    Settings["compression"],
    "contextWindowTokens" | "responseHeadroomTokens" | "safetyMarginTokens"
  >,
  contextWindowOverride = compression.contextWindowTokens,
): CompressionPromptBudget {
  const contextWindowTokens = Math.max(4_000, Math.floor(contextWindowOverride));
  const configuredResponseHeadroomTokens = Math.max(
    512,
    Math.floor(compression.responseHeadroomTokens),
  );
  const configuredSafetyMarginTokens = Math.max(
    512,
    Math.floor(compression.safetyMarginTokens),
  );
  const responseHeadroomTokens = Math.min(
    configuredResponseHeadroomTokens,
    Math.max(512, Math.floor(contextWindowTokens * RESPONSE_HEADROOM_CONTEXT_RATIO)),
  );
  const safetyMarginTokens = Math.min(
    configuredSafetyMarginTokens,
    Math.max(512, Math.floor(contextWindowTokens * SAFETY_MARGIN_CONTEXT_RATIO)),
  );
  const maxPromptTokens = Math.max(
    1_000,
    contextWindowTokens - responseHeadroomTokens - safetyMarginTokens,
  );
  const targetPromptTokens = Math.max(
    1_000,
    Math.min(
      maxPromptTokens,
      maxPromptTokens -
        Math.min(8_000, Math.max(2_000, Math.floor(maxPromptTokens * 0.12))),
    ),
  );

  return {
    contextWindowTokens,
    responseHeadroomTokens,
    safetyMarginTokens,
    maxPromptTokens,
    targetPromptTokens,
  };
}

export function normalizeSettings(
  settings: Partial<Settings>,
  workspaceRoot: string,
): Settings {
  const defaults = defaultSettings(workspaceRoot);
  const compression = {
    ...defaults.compression,
    ...settings.compression,
  };
  const contextWindowTokens = Math.max(
    4_000,
    Math.floor(compression.contextWindowTokens),
  );
  const responseHeadroomTokens = Math.max(
    512,
    Math.floor(compression.responseHeadroomTokens),
  );
  const safetyMarginTokens = Math.max(
    512,
    Math.floor(compression.safetyMarginTokens),
  );
  const promptBudget = deriveCompressionPromptBudget({
    contextWindowTokens,
    responseHeadroomTokens,
    safetyMarginTokens,
  });
  const preserveRecentMessages = Math.max(
    1,
    Math.floor(compression.preserveRecentMessages),
  );
  const minimumRecentMessages = Math.max(
    1,
    Math.min(preserveRecentMessages, Math.floor(compression.minimumRecentMessages)),
  );

  return {
    ...defaults,
    ...settings,
    compression: {
      ...compression,
      contextWindowTokens,
      responseHeadroomTokens,
      safetyMarginTokens,
      preserveRecentMessages,
      minimumRecentMessages,
      maxPromptTokens: promptBudget.maxPromptTokens,
      targetPromptTokens: promptBudget.targetPromptTokens,
    },
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
    memory: normalizeMemoryConfig(settings.memory as Partial<MemoryConfig> | undefined),
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
        canUseImages: true,
        canUseTools: true,
      };
    case "anthropic-api":
    case "openai-compatible":
      return {
        canChat: true,
        canListModels: true,
        requiresBrowserAuth: false,
        canUseImages: true,
        canUseTools: true,
      };
  }
}

export function normalizeProvider(provider: Provider): Provider {
  const normalizedConfig = sanitizeProviderConfig(provider.typeId, provider.config);

  return {
    ...provider,
    config: normalizedConfig,
    availableModels: provider.availableModels ?? [],
    capabilities: getProviderCapabilities(provider.typeId),
  };
}

export function isLocalOpenAiCompatibleBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "127.0.0.1" ||
      host === "host.docker.internal" ||
      host.endsWith(".local")
    ) {
      return true;
    }

    if (/^10\./.test(host) || /^192\.168\./.test(host)) {
      return true;
    }

    const private172 = host.match(/^172\.(\d{1,3})\./);
    if (private172) {
      const second = Number(private172[1]);
      return second >= 16 && second <= 31;
    }

    return false;
  } catch {
    return false;
  }
}

export function isLocalProvider(provider: Provider): boolean {
  return (
    provider.typeId === "openai-compatible" &&
    isLocalOpenAiCompatibleBaseUrl(provider.config.baseUrl)
  );
}

export function sanitizeProviderConfig(
  typeId: ConnectorTypeId,
  config: Record<string, string> | undefined,
): Record<string, string> {
  const normalizedConfig = { ...(config ?? {}) };

  if (typeId !== "openai-compatible") {
    delete normalizedConfig.contextWindowTokens;
    return normalizedConfig;
  }

  if (!isLocalOpenAiCompatibleBaseUrl(normalizedConfig.baseUrl)) {
    delete normalizedConfig.contextWindowTokens;
    return normalizedConfig;
  }

  const parsed = Number(normalizedConfig.contextWindowTokens ?? "");
  if (Number.isFinite(parsed) && parsed > 0) {
    normalizedConfig.contextWindowTokens = String(Math.floor(parsed));
  } else {
    delete normalizedConfig.contextWindowTokens;
  }

  return normalizedConfig;
}

export function resolveProviderContextWindowTokens(
  provider: Provider | null,
  settings: Settings,
): number {
  if (!provider) {
    return settings.compression.contextWindowTokens;
  }

  if (!isLocalProvider(provider)) {
    return REMOTE_PROVIDER_CONTEXT_WINDOW_TOKENS;
  }

  const configured = Number(provider.config.contextWindowTokens ?? "");
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_LOCAL_PROVIDER_CONTEXT_WINDOW_TOKENS;
}
