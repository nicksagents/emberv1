/**
 * MCP configuration types for Ember.
 *
 * The config format matches the standard `mcpServers` JSON used by Qwen-Agent
 * and Claude Code so configs are portable between tools.
 *
 * Config files are loaded from (ascending priority):
 *   1. apps/server/mcp.default.json  — bundled defaults (Phase 3: @playwright/mcp)
 *   2. ~/.ember/mcp.json             — user-level overrides
 *   3. .ember/mcp.json               — project-level overrides (highest priority)
 */

/**
 * Configuration for a single MCP server process.
 */
export interface McpServerConfig {
  /** The executable to run, e.g. "npx" or "/usr/local/bin/my-mcp-server". */
  command: string;
  /** Arguments passed to the command, e.g. ["-y", "@playwright/mcp", "--headless"]. */
  args: string[];
  /**
   * Extra environment variables merged into the subprocess environment.
   * Process env is always inherited; this only adds or overrides specific keys.
   */
  env?: Record<string, string>;
  /**
   * Ember roles that may call tools from this MCP server.
   * Empty or absent = no roles have access by default.
   * Valid values: "coordinator" | "advisor" | "director" | "inspector" | "ops" | "dispatch"
   */
  roles?: string[];
  /**
   * Timeout in milliseconds for tool calls to this server.
   * Defaults to 30 000 ms if not set.
   */
  timeout?: number;
}

/**
 * The top-level mcp.json config shape.
 */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * An MCP tool as returned by client.listTools(), normalized for Ember.
 * Name is prefixed with `mcp__<serverName>__<toolName>` following the
 * Qwen-Code convention to avoid collisions with native EmberTools.
 */
export interface McpToolEntry {
  /** Prefixed name: mcp__serverName__toolName */
  qualifiedName: string;
  /** Original tool name on the MCP server (used when calling the tool). */
  serverToolName: string;
  /** MCP server name this tool belongs to. */
  serverName: string;
  /** Human-readable description from the MCP server. */
  description: string;
  /**
   * JSON Schema for the tool's input, normalized to the Ember ToolDefinition
   * inputSchema format. Always has `type: "object"`.
   */
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  /** Ember roles that may call this tool (from the server's `roles` config). */
  roles: string[];
}
