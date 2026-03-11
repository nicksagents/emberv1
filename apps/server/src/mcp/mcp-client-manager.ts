/**
 * McpClientManager — lifecycle and tool-discovery manager for MCP servers.
 *
 * Reads config from (ascending priority):
 *   1. defaultConfig  — passed in at construction (apps/server/mcp.default.json)
 *   2. ~/.ember/mcp.json  — user-level overrides
 *   3. .ember/mcp.json    — project-level overrides (highest priority)
 *
 * For each configured MCP server the manager:
 *   - Spawns the subprocess via StdioClientTransport
 *   - Calls listTools() to discover available tools
 *   - Wraps each tool as an EmberTool with the mcp__server__tool naming scheme
 *   - Handles server crashes without crashing the main process
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpConfig, McpServerConfig } from "@ember/core/mcp";
import { formatMcpResult, extractImageResult, normalizeToolSchema } from "@ember/core/mcp";
import type { EmberTool } from "../tools/types.js";
import type { Role } from "@ember/core";

// ─── Internal state ────────────────────────────────────────────────────────

interface ActiveServer {
  client: Client;
  config: McpServerConfig;
  tools: EmberToolEntry[];
}

interface EmberToolEntry {
  tool: EmberTool;
  /** Ember roles that may call this tool. Derived from the server's `roles` config. */
  roles: Role[];
}

// ─── Config loading ─────────────────────────────────────────────────────────

function loadJsonFile(path: string): McpConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as McpConfig;
  } catch (err) {
    console.warn(`[mcp] Failed to parse ${path}:`, (err as Error).message);
    return null;
  }
}

/**
 * Merge two McpConfig objects. Keys in `override` replace keys in `base`.
 * This implements the precedence model: project > user > default.
 */
function mergeConfigs(...configs: Array<McpConfig | null>): McpConfig {
  const merged: McpConfig = { mcpServers: {} };
  for (const cfg of configs) {
    if (!cfg) continue;
    Object.assign(merged.mcpServers, cfg.mcpServers);
  }
  return merged;
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
    const userConfig = loadJsonFile(join(homedir(), ".ember", "mcp.json"));
    const projectConfig = loadJsonFile(
      join(this.workspaceDir, ".ember", "mcp.json"),
    );

    const merged = mergeConfigs(this.defaultConfig, userConfig, projectConfig);
    const entries = Object.entries(merged.mcpServers);

    if (entries.length === 0) {
      console.log("[mcp] No MCP servers configured.");
      return;
    }

    console.log(`[mcp] Starting ${entries.length} MCP server(s)…`);

    // Discover tools from all servers in parallel; failures are isolated.
    await Promise.all(
      entries.map(([name, config]) => this.startServer(name, config)),
    );

    const total = this.toolCount;
    console.log(
      `[mcp] Ready — ${this.servers.size} server(s), ${total} tool(s) discovered.`,
    );
  }

  /** Disconnect all active MCP servers. Safe to call multiple times. */
  async stop(): Promise<void> {
    const stops = Array.from(this.servers.entries()).map(async ([name, srv]) => {
      try {
        await srv.client.close();
      } catch (err) {
        console.warn(`[mcp] Error stopping server "${name}":`, (err as Error).message);
      }
    });
    await Promise.all(stops);
    this.servers.clear();
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

  // ── Private: server lifecycle ─────────────────────────────────────────────

  private async startServer(name: string, config: McpServerConfig): Promise<void> {
    const roles = parseRoles(config.roles);

    let transport: StdioClientTransport;
    let client: Client;

    try {
      // Build PATH with any extra bin directories prepended so that npx can
      // resolve locally-installed packages (e.g. @playwright/mcp in the server's
      // node_modules) even when the working directory is the monorepo root.
      const extraPath = this.extraBinDirs.join(":");
      const resolvedPath = extraPath
        ? [extraPath, process.env.PATH].filter(Boolean).join(":")
        : (process.env.PATH ?? "");

      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: {
          ...process.env,
          PATH: resolvedPath,
          ...(config.env ?? {}),
        } as Record<string, string>,
      });

      client = new Client({ name: "ember", version: "0.1.0" });

      // Crash recovery: log the error and deregister the server. The main
      // process continues — other servers and native tools are unaffected.
      client.onerror = (err) => {
        console.error(`[mcp] Server "${name}" error:`, err.message ?? err);
        this.servers.delete(name);
      };

      await client.connect(transport);
    } catch (err) {
      console.warn(
        `[mcp] Failed to start server "${name}" (${config.command} ${config.args.join(" ")}):`,
        (err as Error).message,
      );
      return;
    }

    // Discover tools
    let rawTools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    try {
      const result = await client.listTools();
      rawTools = result.tools ?? [];
    } catch (err) {
      console.warn(`[mcp] listTools() failed for server "${name}":`, (err as Error).message);
      await client.close().catch(() => undefined);
      return;
    }

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
          return callMcpTool(client, serverName, originalToolName, input, toolTimeout);
        },
      };

      return { tool: emberTool, roles };
    });

    this.servers.set(name, { client, config, tools: toolEntries });

    console.log(
      `[mcp] Server "${name}" ready — ${toolEntries.length} tool(s):`,
      toolEntries.map((e) => e.tool.definition.name).join(", "),
    );
  }
}

// ── MCP tool call helper ────────────────────────────────────────────────────

async function callMcpTool(
  client: Client,
  serverName: string,
  toolName: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<import("@ember/core").ToolResult> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`MCP tool "${toolName}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );

  const call = client.callTool({ name: toolName, arguments: input });

  let raw: { content?: unknown[]; isError?: boolean };
  try {
    raw = (await Promise.race([call, timer])) as typeof raw;
  } catch (err) {
    return `[mcp:${serverName}/${toolName}] ${(err as Error).message}`;
  }

  const result = raw as import("@ember/core/mcp").McpCallToolResult;

  // If the server returned an image, surface it as a ToolImageResult
  const img = extractImageResult(result);
  if (img) {
    return {
      text: formatMcpResult(result, toolName),
      imageBase64: img.imageBase64,
      imageMimeType: img.imageMimeType,
    };
  }

  return formatMcpResult(result, toolName);
}

// ── Singleton export ────────────────────────────────────────────────────────

export const mcpClientManager = new McpClientManager();
