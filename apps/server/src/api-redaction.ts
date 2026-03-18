import type { Settings } from "@ember/core";
import type { McpServerConfig } from "@ember/core/mcp";

export const REDACTED_SECRET_VALUE = "[REDACTED]";

export interface SettingsSecretStatus {
  sudoPasswordSet: boolean;
  braveApiKeySet: boolean;
}

export function redactSettingsForApi(settings: Settings): Settings {
  return {
    ...settings,
    sudoPassword: "",
    braveApiKey: "",
  };
}

export function buildSettingsSecretStatus(settings: Settings): SettingsSecretStatus {
  return {
    sudoPasswordSet: Boolean(settings.sudoPassword?.trim()),
    braveApiKeySet: Boolean(settings.braveApiKey?.trim()),
  };
}

export function redactMcpServerConfig(config: McpServerConfig): McpServerConfig {
  return {
    ...config,
    env: redactMcpEnvRecord(config.env),
    headers: redactAllRecord(config.headers),
  };
}

export function unmaskMcpSecretRecord(
  value: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
): Record<string, string> {
  if (!value) {
    return {};
  }
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = raw.trim();
    if (!normalized) {
      continue;
    }
    if (normalized === REDACTED_SECRET_VALUE && previous?.[key]) {
      next[key] = previous[key];
      continue;
    }
    next[key] = normalized;
  }
  return next;
}

/**
 * Returns true when the env-var key looks like it holds a secret
 * (password, token, API key, etc.) as opposed to a non-sensitive
 * identifier such as an email address, URL, or team/tenant ID.
 */
function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return /PASSWORD|TOKEN|SECRET|_KEY$|_KEY_|API_KEY|CREDENTIALS/.test(upper);
}

/** Redact only sensitive env-var keys, leaving emails/URLs/IDs visible. */
function redactMcpEnvRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value || Object.keys(value).length === 0) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key,
      isSensitiveEnvKey(key) ? REDACTED_SECRET_VALUE : val,
    ]),
  );
}

/** Redact all values unconditionally (used for headers which are always auth). */
function redactAllRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value || Object.keys(value).length === 0) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, REDACTED_SECRET_VALUE]),
  );
}
