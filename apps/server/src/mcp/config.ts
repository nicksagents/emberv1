import { writeJson } from "@ember/core";
import type { Role } from "@ember/core";
import type { McpConfig, McpServerConfig } from "@ember/core/mcp";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type McpConfigScope = "default" | "user" | "project";
export type McpTransportKind = "stdio" | "sse" | "streamable-http";

export interface McpConfigLayer {
  scope: McpConfigScope;
  path: string;
  exists: boolean;
  config: McpConfig | null;
}

export interface ResolvedMcpServerEntry {
  name: string;
  config: McpServerConfig;
  sourceScope: McpConfigScope;
}

export interface ResolvedMcpConfigState {
  layers: McpConfigLayer[];
  merged: McpConfig;
  servers: ResolvedMcpServerEntry[];
}

function normalizeMcpConfig(value: unknown): McpConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { mcpServers?: unknown };
  if (!record.mcpServers || typeof record.mcpServers !== "object") {
    return { mcpServers: {} };
  }
  return {
    mcpServers: Object.fromEntries(
      Object.entries(record.mcpServers as Record<string, unknown>).filter(([, entry]) =>
        entry && typeof entry === "object",
      ),
    ) as Record<string, McpServerConfig>,
  };
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveMcpTransportKind(
  config: Partial<McpServerConfig> | null | undefined,
): McpTransportKind | null {
  const hasCommand = hasNonEmptyString(config?.command);
  const hasUrl = hasNonEmptyString(config?.url);
  const hasHttpUrl = hasNonEmptyString(config?.httpUrl);
  const transportCount = Number(hasCommand) + Number(hasUrl) + Number(hasHttpUrl);

  if (transportCount !== 1) {
    return null;
  }
  if (hasCommand) {
    return "stdio";
  }
  return hasHttpUrl ? "streamable-http" : "sse";
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateMcpServerConfig(config: Partial<McpServerConfig>): string | null {
  const transport = resolveMcpTransportKind(config);
  if (!transport) {
    return "Configure exactly one MCP transport: command, url, or httpUrl.";
  }

  if (transport === "stdio") {
    if (!hasNonEmptyString(config.command)) {
      return "config.command is required for stdio MCP servers.";
    }
    return null;
  }

  const rawUrl = transport === "streamable-http" ? config.httpUrl : config.url;
  if (!hasNonEmptyString(rawUrl)) {
    return transport === "streamable-http"
      ? "config.httpUrl is required for streamable HTTP MCP servers."
      : "config.url is required for SSE MCP servers.";
  }
  if (!isValidUrl(rawUrl)) {
    return `${transport === "streamable-http" ? "config.httpUrl" : "config.url"} must be a valid http or https URL.`;
  }
  return null;
}

export function describeMcpServerTransport(config: Partial<McpServerConfig>): string {
  const transport = resolveMcpTransportKind(config);
  if (transport === "stdio") {
    return [config.command?.trim() ?? "", ...(config.args ?? [])].filter(Boolean).join(" ").trim();
  }
  if (transport === "streamable-http") {
    return config.httpUrl?.trim() ?? "streamable HTTP";
  }
  if (transport === "sse") {
    return config.url?.trim() ?? "SSE";
  }
  return "invalid transport";
}

export function loadMcpConfigFile(path: string): McpConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return normalizeMcpConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    console.warn(`[mcp] Failed to parse ${path}:`, (error as Error).message);
    return null;
  }
}

export function resolveMcpConfigPath(scope: Exclude<McpConfigScope, "default">, workspaceDir: string): string {
  if (scope === "user") {
    return join(homedir(), ".ember", "mcp.json");
  }
  return join(workspaceDir, ".ember", "mcp.json");
}

export function readResolvedMcpConfigState(options: {
  defaultConfig?: McpConfig | null;
  workspaceDir: string;
}): ResolvedMcpConfigState {
  const layers: McpConfigLayer[] = [
    {
      scope: "default",
      path: join(options.workspaceDir, "apps", "server", "mcp.default.json"),
      exists: options.defaultConfig != null,
      config: options.defaultConfig ?? null,
    },
    {
      scope: "user",
      path: resolveMcpConfigPath("user", options.workspaceDir),
      exists: existsSync(resolveMcpConfigPath("user", options.workspaceDir)),
      config: loadMcpConfigFile(resolveMcpConfigPath("user", options.workspaceDir)),
    },
    {
      scope: "project",
      path: resolveMcpConfigPath("project", options.workspaceDir),
      exists: existsSync(resolveMcpConfigPath("project", options.workspaceDir)),
      config: loadMcpConfigFile(resolveMcpConfigPath("project", options.workspaceDir)),
    },
  ];

  const merged: McpConfig = { mcpServers: {} };
  const sourceScopeByServer = new Map<string, McpConfigScope>();

  for (const layer of layers) {
    if (!layer.config) {
      continue;
    }
    for (const [name, config] of Object.entries(layer.config.mcpServers)) {
      merged.mcpServers[name] = config;
      sourceScopeByServer.set(name, layer.scope);
    }
  }

  return {
    layers,
    merged,
    servers: Object.entries(merged.mcpServers)
      .map(([name, config]) => ({
        name,
        config,
        sourceScope: sourceScopeByServer.get(name) ?? "default",
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function sanitizeMcpRoleList(value: unknown): Role[] {
  const validRoles: Role[] = ["dispatch", "coordinator", "advisor", "director", "inspector", "ops"];
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(
    value
      .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
      .filter((entry): entry is Role => validRoles.includes(entry as Role)),
  )];
}

export function sanitizeMcpStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(
    value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean),
  )];
}

export function sanitizeMcpStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key.trim(), typeof entry === "string" ? entry.trim() : ""] as const)
      .filter(([key, entry]) => key.length > 0 && entry.length > 0),
  );
}

export function normalizeMcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function derivePublicMcpServerName(packageName: string): string {
  const trimmed = packageName.trim();
  const baseName = trimmed.split("/").at(-1) ?? trimmed;
  return normalizeMcpServerName(baseName.replace(/^mcp-/, ""));
}

export function validatePublicMcpPackageName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Package name is required.";
  }
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) {
    return "Package name must look like a public npm package id.";
  }
  return null;
}

export function buildInstalledMcpServer(options: {
  packageName: string;
  roles: Role[];
  args?: string[];
  env?: Record<string, string>;
  timeout?: number | null;
  description?: string | null;
}): McpServerConfig {
  return {
    enabled: true,
    command: "npx",
    args: ["-y", options.packageName.trim(), ...sanitizeMcpStringList(options.args)],
    env: sanitizeMcpStringRecord(options.env),
    roles: options.roles,
    includeTools: [],
    excludeTools: [],
    timeout: typeof options.timeout === "number" && Number.isFinite(options.timeout)
      ? Math.max(1_000, Math.floor(options.timeout))
      : undefined,
    description: options.description?.trim() || undefined,
  };
}

export function buildRemoteMcpServer(options: {
  transport: Exclude<McpTransportKind, "stdio">;
  url: string;
  roles: Role[];
  headers?: Record<string, string>;
  timeout?: number | null;
  description?: string | null;
}): McpServerConfig {
  return {
    enabled: true,
    ...(options.transport === "streamable-http"
      ? { httpUrl: options.url.trim() }
      : { url: options.url.trim() }),
    headers: sanitizeMcpStringRecord(options.headers),
    roles: options.roles,
    includeTools: [],
    excludeTools: [],
    timeout: typeof options.timeout === "number" && Number.isFinite(options.timeout)
      ? Math.max(1_000, Math.floor(options.timeout))
      : undefined,
    description: options.description?.trim() || undefined,
  };
}

export async function upsertMcpServer(options: {
  scope: Exclude<McpConfigScope, "default">;
  workspaceDir: string;
  name: string;
  config: McpServerConfig;
}): Promise<McpConfig> {
  const path = resolveMcpConfigPath(options.scope, options.workspaceDir);
  const current = loadMcpConfigFile(path) ?? { mcpServers: {} };
  current.mcpServers[options.name] = options.config;
  await writeJson(path, current);
  return current;
}

export async function removeMcpServer(options: {
  scope: Exclude<McpConfigScope, "default">;
  workspaceDir: string;
  name: string;
}): Promise<boolean> {
  const path = resolveMcpConfigPath(options.scope, options.workspaceDir);
  const current = loadMcpConfigFile(path) ?? { mcpServers: {} };
  if (!current.mcpServers[options.name]) {
    return false;
  }
  delete current.mcpServers[options.name];
  await writeJson(path, current);
  return true;
}
