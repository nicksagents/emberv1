/**
 * McpClientManager — lifecycle and discovery manager for MCP servers.
 *
 * Reads config from (ascending priority):
 *   1. defaultConfig  — passed in at construction (apps/server/mcp.default.json)
 *   2. ~/.ember/mcp.json  — user-level overrides
 *   3. .ember/mcp.json    — project-level overrides (highest priority)
 *
 * For each configured MCP server the manager:
 *   - Connects over stdio, SSE, or Streamable HTTP
 *   - Calls listTools() to discover available tools
 *   - Calls listResources() / listResourceTemplates() if the server supports resources
 *   - Calls listPrompts() if the server supports prompts
 *   - Wraps each tool as an EmberTool with the mcp__server__tool naming scheme
 *   - Creates synthetic mcp_resources / mcp_prompts tools for resource/prompt access
 *   - Handles server crashes without crashing the main process
 */

import { delimiter } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConfig, McpServerConfig, McpResourceInfo, McpResourceTemplateInfo, McpPromptInfo } from "@ember/core/mcp";
import { formatMcpResult, extractImageResult, normalizeToolSchema, formatResourceContents, formatPromptMessages } from "@ember/core/mcp";
import type { McpResourceContents, McpPromptMessage } from "@ember/core/mcp";
import type { EmberTool } from "../tools/types.js";
import type { Role, ToolResult } from "@ember/core";
import { CONFIG } from "../config.js";
import {
  describeMcpServerTransport,
  readResolvedMcpConfigState,
  resolveMcpTransportKind,
  type McpConfigLayer,
  type McpConfigScope,
  type ResolvedMcpConfigState,
} from "./config.js";

// ─── Internal state ────────────────────────────────────────────────────────

interface ServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

interface ActiveServer {
  name: string;
  client: Client;
  config: McpServerConfig;
  tools: EmberToolEntry[];
  resources: McpResourceInfo[];
  resourceTemplates: McpResourceTemplateInfo[];
  prompts: McpPromptInfo[];
  capabilities: ServerCapabilities;
  activeCalls: number;
  draining: boolean;
  closePromise: Promise<void> | null;
}

interface EmberToolEntry {
  tool: EmberTool;
  /** Ember roles that may call this tool. Derived from the server's `roles` config. */
  roles: Role[];
}

// ─── Tool name helpers ──────────────────────────────────────────────────────

/**
 * Produce the Ember-namespaced tool name from server and original tool names.
 * Follows the Qwen-Code convention: mcp__<serverName>__<toolName>
 * Characters outside [a-zA-Z0-9_] in either segment are replaced with _.
 */
function qualifiedName(serverName: string, toolName: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp__${safe(serverName)}__${safe(toolName)}`;
}

// ─── Valid Ember roles ──────────────────────────────────────────────────────

const EMBER_ROLES: Role[] = ["coordinator", "advisor", "director", "inspector", "ops", "dispatch"];
const ALL_ACTIVE_ROLES: Role[] = ["coordinator", "advisor", "director", "inspector", "ops"];

function parseRoles(raw: string[] | undefined): Role[] {
  if (!raw || raw.length === 0) return [];
  return raw.filter((r): r is Role => EMBER_ROLES.includes(r as Role));
}

/** Collect the union of roles across all running servers. */
function collectAllServerRoles(servers: Map<string, ActiveServer>): Role[] {
  const roles = new Set<Role>();
  for (const srv of servers.values()) {
    for (const role of parseRoles(srv.config.roles)) {
      roles.add(role);
    }
  }
  return roles.size > 0 ? [...roles] : ALL_ACTIVE_ROLES;
}

// ─── McpClientManager ──────────────────────────────────────────────────────

export class McpClientManager {
  private servers = new Map<string, ActiveServer>();
  private drainingServers = new Set<ActiveServer>();
  private serverErrors = new Map<string, string>();
  private configState: ResolvedMcpConfigState = {
    layers: [],
    merged: { mcpServers: {} },
    servers: [],
  };
  private defaultConfig: McpConfig | null;
  private workspaceDir: string;
  private extraBinDirs: string[];

  constructor(options: {
    /** Pre-loaded default config (e.g. from apps/server/mcp.default.json). */
    defaultConfig?: McpConfig | null;
    /** The workspace root used to resolve .ember/mcp.json. Defaults to cwd. */
    workspaceDir?: string;
    /**
     * Extra directories to prepend to PATH when spawning MCP subprocesses.
     * Pass the server package's node_modules/.bin so that `npx` can resolve
     * locally-installed MCP packages regardless of the working directory.
     */
    extraBinDirs?: string[];
  } = {}) {
    this.defaultConfig = options.defaultConfig ?? null;
    this.workspaceDir = options.workspaceDir ?? process.cwd();
    this.extraBinDirs = options.extraBinDirs ?? [];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Read all config layers, spawn each MCP server subprocess, and discover
   * tools, resources, and prompts. Servers that fail to start are logged and
   * skipped — they do not prevent other servers from loading.
   */
  async start(): Promise<void> {
    await this.stop();
    this.serverErrors.clear();
    this.configState = readResolvedMcpConfigState({
      defaultConfig: this.defaultConfig,
      workspaceDir: this.workspaceDir,
    });
    const configuredEntries = this.getEnabledConfigEntries();

    if (configuredEntries.length === 0) {
      console.log("[mcp] No enabled MCP servers configured.");
      return;
    }

    console.log(`[mcp] Starting ${configuredEntries.length} MCP server(s)…`);
    this.servers = await this.connectConfiguredServers(configuredEntries);

    const total = this.toolCount;
    const totalResources = this.resourceCount;
    const totalPrompts = this.promptCount;
    const capabilities: string[] = [`${total} tool(s)`];
    if (totalResources > 0) capabilities.push(`${totalResources} resource(s)`);
    if (totalPrompts > 0) capabilities.push(`${totalPrompts} prompt(s)`);
    console.log(
      `[mcp] Ready — ${this.servers.size} server(s), ${capabilities.join(", ")} discovered.`,
    );
  }

  /** Disconnect all active MCP servers. Safe to call multiple times. */
  async stop(): Promise<void> {
    const servers = [...this.servers.values(), ...this.drainingServers.values()];
    this.servers.clear();
    this.drainingServers.clear();
    await Promise.all(servers.map((server) => this.closeServer(server, true)));
  }

  async reload(): Promise<EmberToolEntry[]> {
    this.serverErrors.clear();
    this.configState = readResolvedMcpConfigState({
      defaultConfig: this.defaultConfig,
      workspaceDir: this.workspaceDir,
    });
    const configuredEntries = this.getEnabledConfigEntries();

    if (configuredEntries.length === 0) {
      const previous = this.servers;
      this.servers = new Map();
      await Promise.all(
        [...previous.values()].map(async (server) => {
          server.draining = true;
          this.drainingServers.add(server);
          await this.closeServerIfIdle(server);
        }),
      );
      return [];
    }

    console.log(`[mcp] Reloading ${configuredEntries.length} MCP server(s)…`);
    const nextServers = await this.connectConfiguredServers(configuredEntries);
    const previous = this.servers;
    this.servers = nextServers;

    await Promise.all(
      [...previous.values()].map(async (server) => {
        server.draining = true;
        this.drainingServers.add(server);
        await this.closeServerIfIdle(server);
      }),
    );

    return this.getTools();
  }

  // ── Tool access ───────────────────────────────────────────────────────────

  /**
   * Return all discovered MCP tools (including synthetic resource/prompt
   * interaction tools) as EmberTool entries with role assignments.
   */
  getTools(): EmberToolEntry[] {
    const all: EmberToolEntry[] = [];
    for (const srv of this.servers.values()) {
      all.push(...srv.tools);
    }
    all.push(...this.buildInteractionTools());
    return all;
  }

  get toolCount(): number {
    let n = 0;
    for (const srv of this.servers.values()) n += srv.tools.length;
    return n;
  }

  get resourceCount(): number {
    let n = 0;
    for (const srv of this.servers.values()) n += srv.resources.length + srv.resourceTemplates.length;
    return n;
  }

  get promptCount(): number {
    let n = 0;
    for (const srv of this.servers.values()) n += srv.prompts.length;
    return n;
  }

  getRuntimeStats(): {
    runningServers: number;
    drainingServers: number;
    activeCalls: number;
    totalResources: number;
    totalResourceTemplates: number;
    totalPrompts: number;
  } {
    const allServers = [...this.servers.values(), ...this.drainingServers.values()];
    let totalResources = 0;
    let totalResourceTemplates = 0;
    let totalPrompts = 0;
    for (const srv of this.servers.values()) {
      totalResources += srv.resources.length;
      totalResourceTemplates += srv.resourceTemplates.length;
      totalPrompts += srv.prompts.length;
    }
    return {
      runningServers: this.servers.size,
      drainingServers: this.drainingServers.size,
      activeCalls: allServers.reduce((total, server) => total + server.activeCalls, 0),
      totalResources,
      totalResourceTemplates,
      totalPrompts,
    };
  }

  getConfigLayers(): McpConfigLayer[] {
    return this.configState.layers;
  }

  getConfiguredServers(): ResolvedMcpConfigState["servers"] {
    return this.configState.servers;
  }

  getServerStatus(): Array<{
    name: string;
    sourceScope: McpConfigScope;
    config: McpServerConfig;
    roles: Role[];
    toolNames: string[];
    resourceCount: number;
    promptCount: number;
    capabilities: ServerCapabilities;
    status: "running" | "error" | "disabled" | "configured";
    lastError: string | null;
    activeCalls: number;
  }> {
    return this.configState.servers.map((entry) => {
      const active = this.servers.get(entry.name);
      const lastError = this.serverErrors.get(entry.name) ?? null;
      return {
        name: entry.name,
        sourceScope: entry.sourceScope,
        config: entry.config,
        roles: parseRoles(entry.config.roles),
        toolNames: active?.tools.map((tool) => tool.tool.definition.name) ?? [],
        resourceCount: active?.resources.length ?? 0,
        promptCount: active?.prompts.length ?? 0,
        capabilities: active?.capabilities ?? { tools: false, resources: false, prompts: false },
        status: entry.config.enabled === false
          ? "disabled"
          : active
            ? "running"
            : lastError
              ? "error"
              : "configured",
        lastError,
        activeCalls: active?.activeCalls ?? 0,
      };
    });
  }

  // ── Private: server lifecycle ─────────────────────────────────────────────

  private getEnabledConfigEntries(): Array<readonly [string, McpServerConfig]> {
    return this.configState.servers
      .filter((entry) => entry.config.enabled !== false)
      .map((entry) => [entry.name, entry.config] as const);
  }

  private async connectConfiguredServers(
    configuredEntries: Array<readonly [string, McpServerConfig]>,
  ): Promise<Map<string, ActiveServer>> {
    const servers = new Map<string, ActiveServer>();
    await Promise.all(
      configuredEntries.map(async ([name, config]) => {
        const server = await this.startServerWithRetry(name, config);
        if (server) {
          servers.set(name, server);
        }
      }),
    );
    return servers;
  }

  private async startServerWithRetry(
    name: string,
    config: McpServerConfig,
    maxRetries = 3,
    baseDelayMs = 2_000,
  ): Promise<ActiveServer | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const server = await this.startServer(name, config);
      if (server) {
        if (attempt > 0) {
          console.log(`[mcp] Server "${name}" connected after ${attempt + 1} attempts.`);
        }
        return server;
      }
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[mcp] Server "${name}": attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    console.error(`[mcp] Server "${name}": failed after ${maxRetries + 1} attempts — disabling.`);
    return null;
  }

  private async startServer(name: string, config: McpServerConfig): Promise<ActiveServer | null> {
    const roles = parseRoles(config.roles);
    const client = new Client({ name: "ember", version: "0.1.0" });
    const server: ActiveServer = {
      name,
      client,
      config,
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      capabilities: { tools: false, resources: false, prompts: false },
      activeCalls: 0,
      draining: false,
      closePromise: null,
    };

    try {
      client.onerror = (err) => {
        console.error(`[mcp] Server "${name}" error:`, err.message ?? err);
        this.serverErrors.set(name, err.message ?? String(err));
        if (this.servers.get(name) === server) {
          this.servers.delete(name);
        }
        this.drainingServers.delete(server);
        void this.closeServer(server, true);
      };

      await client.connect(this.createTransport(config));
    } catch (err) {
      this.serverErrors.set(name, (err as Error).message);
      console.warn(
        `[mcp] Failed to start server "${name}" (${describeMcpServerTransport(config)}):`,
        (err as Error).message,
      );
      return null;
    }

    // ── Read server capabilities ──────────────────────────────────────────
    const caps = client.getServerCapabilities?.() ?? {};
    server.capabilities = {
      tools: !!caps.tools,
      resources: !!caps.resources,
      prompts: !!caps.prompts,
    };

    // ── Discover tools ────────────────────────────────────────────────────
    let rawTools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    try {
      const result = await client.listTools();
      rawTools = result.tools ?? [];
    } catch (err) {
      this.serverErrors.set(name, (err as Error).message);
      console.warn(`[mcp] listTools() failed for server "${name}":`, (err as Error).message);
      await this.closeServer(server, true);
      return null;
    }

    rawTools = filterDiscoveredTools(rawTools, config);
    if (rawTools.length === 0) {
      console.log(`[mcp] Server "${name}" reported 0 tools.`);
    }

    const toolEntries = rawTools.map((mcpTool): EmberToolEntry => {
      const qName = qualifiedName(name, mcpTool.name);
      const schema = normalizeToolSchema(mcpTool.inputSchema);

      const serverName = name;
      const originalToolName = mcpTool.name;
      const toolTimeout = config.timeout ?? CONFIG.mcp.defaultTimeoutMs;

      const emberTool: EmberTool = {
        definition: {
          name: qName,
          description: mcpTool.description ?? `${originalToolName} (${serverName} MCP server)`,
          inputSchema: schema,
        },
        execute: async (input) => {
          return this.callMcpTool(server, serverName, originalToolName, input, toolTimeout);
        },
      };

      return { tool: emberTool, roles };
    });

    server.tools = toolEntries;

    // ── Discover resources ────────────────────────────────────────────────
    if (server.capabilities.resources) {
      await this.discoverResources(server);
    }

    // ── Discover prompts ──────────────────────────────────────────────────
    if (server.capabilities.prompts) {
      await this.discoverPrompts(server);
    }

    this.serverErrors.delete(name);

    const summaryParts = [`${toolEntries.length} tool(s)`];
    if (server.resources.length > 0) summaryParts.push(`${server.resources.length} resource(s)`);
    if (server.resourceTemplates.length > 0) summaryParts.push(`${server.resourceTemplates.length} template(s)`);
    if (server.prompts.length > 0) summaryParts.push(`${server.prompts.length} prompt(s)`);

    console.log(
      `[mcp] Server "${name}" ready — ${summaryParts.join(", ")}:`,
      toolEntries.map((e) => e.tool.definition.name).join(", "),
    );
    return server;
  }

  private async discoverResources(server: ActiveServer): Promise<void> {
    try {
      const result = await server.client.listResources();
      server.resources = (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch (err) {
      console.warn(
        `[mcp] listResources() failed for server "${server.name}":`,
        (err as Error).message,
      );
    }

    try {
      const result = await server.client.listResourceTemplates();
      server.resourceTemplates = (result.resourceTemplates ?? []).map((t) => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      }));
    } catch (err) {
      console.warn(
        `[mcp] listResourceTemplates() failed for server "${server.name}":`,
        (err as Error).message,
      );
    }
  }

  private async discoverPrompts(server: ActiveServer): Promise<void> {
    try {
      const result = await server.client.listPrompts();
      server.prompts = (result.prompts ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      }));
    } catch (err) {
      console.warn(
        `[mcp] listPrompts() failed for server "${server.name}":`,
        (err as Error).message,
      );
    }
  }

  private createTransport(
    config: McpServerConfig,
  ): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
    const transportKind = resolveMcpTransportKind(config);
    const headers = Object.keys(config.headers ?? {}).length > 0 ? { ...(config.headers ?? {}) } : undefined;

    if (transportKind === "stdio") {
      const extraPath = this.extraBinDirs.join(delimiter);
      const resolvedPath = extraPath
        ? [extraPath, process.env.PATH].filter(Boolean).join(delimiter)
        : (process.env.PATH ?? "");

      return new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
        env: {
          ...process.env,
          PATH: resolvedPath,
          // Suppress dotenv v17+ stdout logging which corrupts MCP stdio.
          DOTENV_CONFIG_QUIET: "true",
          ...(config.env ?? {}),
        } as Record<string, string>,
      });
    }

    if (transportKind === "streamable-http") {
      return new StreamableHTTPClientTransport(new URL(config.httpUrl!), {
        requestInit: headers ? { headers } : undefined,
      });
    }

    if (transportKind === "sse") {
      return new SSEClientTransport(new URL(config.url!), {
        eventSourceInit: headers ? ({ headers } as any) : undefined,
        requestInit: headers ? { headers } : undefined,
      });
    }

    throw new Error("Invalid MCP transport configuration.");
  }

  private async closeServer(server: ActiveServer, force: boolean): Promise<void> {
    if (!force && server.activeCalls > 0) {
      return;
    }
    if (server.closePromise) {
      await server.closePromise;
      return;
    }

    server.closePromise = (async () => {
      try {
        await server.client.close();
      } catch (err) {
        console.warn(`[mcp] Error stopping server "${server.name}":`, (err as Error).message);
      } finally {
        this.drainingServers.delete(server);
      }
    })();
    await server.closePromise;
  }

  private async closeServerIfIdle(server: ActiveServer): Promise<void> {
    if (!server.draining || server.activeCalls > 0) {
      return;
    }
    await this.closeServer(server, false);
  }

  private async callMcpTool(
    server: ActiveServer,
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ToolResult> {
    server.activeCalls += 1;
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      const timer = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`MCP tool "${toolName}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timeoutHandle.unref?.();
      });
      const call = server.client.callTool({ name: toolName, arguments: input });

      let raw: { content?: unknown[]; isError?: boolean };
      try {
        raw = (await Promise.race([call, timer])) as typeof raw;
      } catch (err) {
        return `[mcp:${serverName}/${toolName}] ${(err as Error).message}`;
      }

      const result = raw as import("@ember/core/mcp").McpCallToolResult;
      const img = extractImageResult(result);
      if (img) {
        return {
          text: formatMcpResult(result, toolName),
          imageBase64: img.imageBase64,
          imageMimeType: img.imageMimeType,
        };
      }

      return formatMcpResult(result, toolName);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      server.activeCalls = Math.max(0, server.activeCalls - 1);
      await this.closeServerIfIdle(server);
    }
  }

  // ── Resource / Prompt interaction ─────────────────────────────────────────

  private async handleListResources(serverName?: string): Promise<string> {
    const results: string[] = [];

    for (const srv of this.servers.values()) {
      if (serverName && srv.name !== serverName) continue;
      if (!srv.capabilities.resources) continue;

      // Re-fetch to get current state
      try {
        const res = await srv.client.listResources();
        srv.resources = (res.resources ?? []).map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
      } catch { /* use cached */ }

      if (srv.resources.length > 0) {
        results.push(`## ${srv.name} — Resources`);
        for (const r of srv.resources) {
          const desc = r.description ? ` — ${r.description}` : "";
          const mime = r.mimeType ? ` (${r.mimeType})` : "";
          results.push(`- ${r.name}: ${r.uri}${mime}${desc}`);
        }
      }

      if (srv.resourceTemplates.length > 0) {
        results.push(`## ${srv.name} — Resource Templates`);
        for (const t of srv.resourceTemplates) {
          const desc = t.description ? ` — ${t.description}` : "";
          results.push(`- ${t.name}: ${t.uriTemplate}${desc}`);
        }
      }
    }

    if (results.length === 0) {
      return serverName
        ? `No resources found on server "${serverName}".`
        : "No MCP servers expose resources.";
    }

    return results.join("\n");
  }

  private async handleReadResource(serverName: string, uri: string): Promise<ToolResult> {
    const srv = this.servers.get(serverName);
    if (!srv) return `Error: MCP server "${serverName}" is not running.`;
    if (!srv.capabilities.resources) return `Error: Server "${serverName}" does not support resources.`;

    srv.activeCalls += 1;
    const timeoutMs = srv.config.timeout ?? CONFIG.mcp.defaultTimeoutMs;
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      const timer = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`readResource("${uri}") timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timeoutHandle.unref?.();
      });
      const call = srv.client.readResource({ uri });

      let result: { contents?: McpResourceContents[] };
      try {
        result = (await Promise.race([call, timer])) as typeof result;
      } catch (err) {
        return `[mcp:${serverName}/readResource] ${(err as Error).message}`;
      }

      return formatResourceContents(result.contents ?? [], uri);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      srv.activeCalls = Math.max(0, srv.activeCalls - 1);
      await this.closeServerIfIdle(srv);
    }
  }

  private async handleListPrompts(serverName?: string): Promise<string> {
    const results: string[] = [];

    for (const srv of this.servers.values()) {
      if (serverName && srv.name !== serverName) continue;
      if (!srv.capabilities.prompts) continue;

      // Re-fetch to get current state
      try {
        const res = await srv.client.listPrompts();
        srv.prompts = (res.prompts ?? []).map((p) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments?.map((a) => ({
            name: a.name,
            description: a.description,
            required: a.required,
          })),
        }));
      } catch { /* use cached */ }

      if (srv.prompts.length > 0) {
        results.push(`## ${srv.name} — Prompts`);
        for (const p of srv.prompts) {
          const desc = p.description ? ` — ${p.description}` : "";
          const args = p.arguments?.length
            ? ` (${p.arguments.map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ")})`
            : "";
          results.push(`- ${p.name}${args}${desc}`);
        }
      }
    }

    if (results.length === 0) {
      return serverName
        ? `No prompts found on server "${serverName}".`
        : "No MCP servers expose prompts.";
    }

    return results.join("\n");
  }

  private async handleGetPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<string> {
    const srv = this.servers.get(serverName);
    if (!srv) return `Error: MCP server "${serverName}" is not running.`;
    if (!srv.capabilities.prompts) return `Error: Server "${serverName}" does not support prompts.`;

    srv.activeCalls += 1;
    const timeoutMs = srv.config.timeout ?? CONFIG.mcp.defaultTimeoutMs;
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      const timer = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`getPrompt("${promptName}") timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timeoutHandle.unref?.();
      });
      const call = srv.client.getPrompt({ name: promptName, arguments: args });

      let result: { description?: string; messages?: McpPromptMessage[] };
      try {
        result = (await Promise.race([call, timer])) as typeof result;
      } catch (err) {
        return `[mcp:${serverName}/getPrompt] ${(err as Error).message}`;
      }

      return formatPromptMessages(
        result.messages ?? [],
        promptName,
        result.description,
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      srv.activeCalls = Math.max(0, srv.activeCalls - 1);
      await this.closeServerIfIdle(srv);
    }
  }

  // ── Synthetic interaction tools ───────────────────────────────────────────

  /**
   * Build EmberTools that let the agent interact with MCP resources and prompts
   * across all connected servers. Only created if at least one server supports
   * the relevant capability.
   */
  private buildInteractionTools(): EmberToolEntry[] {
    const entries: EmberToolEntry[] = [];
    const hasResources = [...this.servers.values()].some(
      (s) => s.capabilities.resources && (s.resources.length > 0 || s.resourceTemplates.length > 0),
    );
    const hasPrompts = [...this.servers.values()].some(
      (s) => s.capabilities.prompts && s.prompts.length > 0,
    );
    const roles = collectAllServerRoles(this.servers);

    if (hasResources) {
      entries.push({
        tool: {
          definition: {
            name: "mcp_resources",
            description:
              "Access MCP server resources. List available resources across servers, or read a specific resource by URI. Resources provide contextual data like files, configs, database records, or live state from connected MCP servers.",
            inputSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["list", "read"],
                  description: "list = show available resources; read = fetch a resource by URI.",
                },
                server: {
                  type: "string",
                  description:
                    "MCP server name to target. Required for 'read'. Optional for 'list' (omit to list all servers).",
                },
                uri: {
                  type: "string",
                  description: "Resource URI to read. Required when action is 'read'.",
                },
              },
              required: ["action"],
            },
          },
          execute: async (input) => {
            const action = input.action as string;
            if (action === "list") {
              return this.handleListResources(input.server as string | undefined);
            }
            if (action === "read") {
              if (!input.server || !input.uri) {
                return "Error: both 'server' and 'uri' are required for action='read'.";
              }
              return this.handleReadResource(input.server as string, input.uri as string);
            }
            return "Unknown action. Use 'list' or 'read'.";
          },
        },
        roles,
      });
    }

    if (hasPrompts) {
      entries.push({
        tool: {
          definition: {
            name: "mcp_prompts",
            description:
              "Access MCP server prompt templates. List available prompts or retrieve a specific prompt with arguments. Prompts provide pre-built instructions, workflows, or context from MCP servers.",
            inputSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["list", "get"],
                  description: "list = show available prompts; get = retrieve a prompt template.",
                },
                server: {
                  type: "string",
                  description:
                    "MCP server name to target. Required for 'get'. Optional for 'list' (omit to list all servers).",
                },
                name: {
                  type: "string",
                  description: "Prompt name. Required when action is 'get'.",
                },
                arguments: {
                  type: "object",
                  description: "Arguments to fill the prompt template (key-value pairs).",
                  additionalProperties: { type: "string" },
                },
              },
              required: ["action"],
            },
          },
          execute: async (input) => {
            const action = input.action as string;
            if (action === "list") {
              return this.handleListPrompts(input.server as string | undefined);
            }
            if (action === "get") {
              if (!input.server || !input.name) {
                return "Error: both 'server' and 'name' are required for action='get'.";
              }
              return this.handleGetPrompt(
                input.server as string,
                input.name as string,
                input.arguments as Record<string, string> | undefined,
              );
            }
            return "Unknown action. Use 'list' or 'get'.";
          },
        },
        roles,
      });
    }

    return entries;
  }
}

function filterDiscoveredTools(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  config: McpServerConfig,
): Array<{ name: string; description?: string; inputSchema?: unknown }> {
  const include = new Set((config.includeTools ?? []).map((entry: string) => entry.trim()).filter(Boolean));
  const exclude = new Set((config.excludeTools ?? []).map((entry: string) => entry.trim()).filter(Boolean));

  return tools.filter((tool) => {
    if (include.size > 0 && !include.has(tool.name)) {
      return false;
    }
    if (exclude.has(tool.name)) {
      return false;
    }
    return true;
  });
}

// ── Singleton export ────────────────────────────────────────────────────────

export const mcpClientManager = new McpClientManager();
