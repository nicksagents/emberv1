/**
 * McpClientManager — lifecycle and tool-discovery manager for MCP servers.
 *
 * Reads config from (ascending priority):
 *   1. defaultConfig  — passed in at construction (apps/server/mcp.default.json)
 *   2. ~/.ember/mcp.json  — user-level overrides
 *   3. .ember/mcp.json    — project-level overrides (highest priority)
 *
 * For each configured MCP server the manager:
 *   - Connects over stdio, SSE, or Streamable HTTP
 *   - Calls listTools() to discover available tools
 *   - Wraps each tool as an EmberTool with the mcp__server__tool naming scheme
 *   - Handles server crashes without crashing the main process
 */

import { delimiter } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConfig, McpServerConfig } from "@ember/core/mcp";
import { formatMcpResult, extractImageResult, normalizeToolSchema } from "@ember/core/mcp";
import type { EmberTool } from "../tools/types.js";
import type { Role } from "@ember/core";
import {
  describeMcpServerTransport,
  readResolvedMcpConfigState,
  resolveMcpTransportKind,
  type McpConfigLayer,
  type McpConfigScope,
  type ResolvedMcpConfigState,
} from "./config.js";

// ─── Internal state ────────────────────────────────────────────────────────

interface ActiveServer {
  name: string;
  client: Client;
  config: McpServerConfig;
  tools: EmberToolEntry[];
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

function parseRoles(raw: string[] | undefined): Role[] {
  if (!raw || raw.length === 0) return [];
  return raw.filter((r): r is Role => EMBER_ROLES.includes(r as Role));
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
   * tools. Servers that fail to start are logged and skipped — they do not
   * prevent other servers from loading.
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
    console.log(
      `[mcp] Ready — ${this.servers.size} server(s), ${total} tool(s) discovered.`,
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
   * Return all discovered MCP tools as EmberTool entries with role assignments.
   * Caller (tools/index.ts registerMcpTools) uses this to merge into REGISTRY
   * and ROLE_TOOLS.
   */
  getTools(): EmberToolEntry[] {
    const all: EmberToolEntry[] = [];
    for (const srv of this.servers.values()) {
      all.push(...srv.tools);
    }
    return all;
  }

  get toolCount(): number {
    let n = 0;
    for (const srv of this.servers.values()) n += srv.tools.length;
    return n;
  }

  getRuntimeStats(): {
    runningServers: number;
    drainingServers: number;
    activeCalls: number;
  } {
    const allServers = [...this.servers.values(), ...this.drainingServers.values()];
    return {
      runningServers: this.servers.size,
      drainingServers: this.drainingServers.size,
      activeCalls: allServers.reduce((total, server) => total + server.activeCalls, 0),
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
        const server = await this.startServer(name, config);
        if (server) {
          servers.set(name, server);
        }
      }),
    );
    return servers;
  }

  private async startServer(name: string, config: McpServerConfig): Promise<ActiveServer | null> {
    const roles = parseRoles(config.roles);
    const client = new Client({ name: "ember", version: "0.1.0" });
    const server: ActiveServer = {
      name,
      client,
      config,
      tools: [],
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

    // Discover tools
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

      // Capture closure variables for execute()
      const serverName = name;
      const originalToolName = mcpTool.name;
      const toolTimeout = config.timeout ?? 30_000;

      const emberTool: EmberTool = {
        definition: {
          name: qName,
          description: mcpTool.description ?? `${originalToolName} (${serverName} MCP server)`,
          inputSchema: schema,
        },
        // No systemPrompt — MCP tools are documented by the server's own descriptions.
        // A SKILL.md can be added to skills/<qualified-name>/SKILL.md for richer guidance.
        execute: async (input) => {
          return this.callMcpTool(server, serverName, originalToolName, input, toolTimeout);
        },
      };

      return { tool: emberTool, roles };
    });

    server.tools = toolEntries;
    this.serverErrors.delete(name);

    console.log(
      `[mcp] Server "${name}" ready — ${toolEntries.length} tool(s):`,
      toolEntries.map((e) => e.tool.definition.name).join(", "),
    );
    return server;
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
  ): Promise<import("@ember/core").ToolResult> {
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
