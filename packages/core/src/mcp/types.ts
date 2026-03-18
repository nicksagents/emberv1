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
  /** Whether this server should be started. Defaults to true. */
  enabled?: boolean;
  /** The executable to run for stdio servers, e.g. "npx" or "/usr/local/bin/my-mcp-server". */
  command?: string;
  /** Arguments passed to the stdio command, e.g. ["-y", "@playwright/mcp", "--headless"]. */
  args?: string[];
  /** SSE endpoint for a remote MCP server. Deprecated in the MCP SDK but still widely used. */
  url?: string;
  /** Streamable HTTP endpoint for a remote MCP server. */
  httpUrl?: string;
  /**
   * Extra environment variables merged into the stdio subprocess environment.
   * Process env is always inherited; this only adds or overrides specific keys.
   */
  env?: Record<string, string>;
  /** Extra HTTP headers for remote transports. */
  headers?: Record<string, string>;
  /** Optional display copy for settings UI and runtime inspection. */
  description?: string;
  /**
   * Ember roles that may call tools from this MCP server.
   * Empty or absent = no roles have access by default.
   * Valid values: "coordinator" | "advisor" | "director" | "inspector" | "ops" | "dispatch"
   */
  roles?: string[];
  /**
   * Optional allowlist of server tool names to expose. If set, only these tools
   * will be registered from the MCP server.
   */
  includeTools?: string[];
  /**
   * Optional denylist of server tool names to hide. Applied after includeTools.
   */
  excludeTools?: string[];
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

// ── MCP Resources ─────────────────────────────────────────────────────────────

/** A resource exposed by an MCP server via listResources(). */
export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A URI template exposed by an MCP server via listResourceTemplates(). */
export interface McpResourceTemplateInfo {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ── MCP Prompts ───────────────────────────────────────────────────────────────

/** A prompt argument descriptor from an MCP server. */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** A prompt template exposed by an MCP server via listPrompts(). */
export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}
