import type { Role, ToolDefinition } from "@ember/core";
import { skillManager } from "@ember/core/skills";

// browserTool is intentionally NOT imported here — replaced by @playwright/mcp (Phase 3).
// See apps/server/mcp.default.json and skills/playwright-browser/SKILL.md.
// To roll back: re-import browserTool and add it to REGISTRY + ROLE_TOOLS.
import { fetchPageTool } from "./fetch-page.js";
import { editFileTool, listDirectoryTool, readFileTool, writeFileTool } from "./files.js";
import { gitInspectTool } from "./git-inspect.js";
import { handoffTool } from "./handoff.js";
import { httpRequestTool } from "./http-request.js";
import { projectOverviewTool } from "./project-overview.js";
import { searchFilesTool } from "./search-files.js";
import { setSudoPassword, terminalTool } from "./terminal.js";
import type { EmberTool } from "./types.js";
import { webSearchTool } from "./web-search.js";

export type { EmberTool };

// ─── Registry ─────────────────────────────────────────────────────────────────
// Add your tool to this array to make it available to the system.
// See TOOLS.md for how to create and register a new tool.
// MCP tools are added at startup via registerMcpTools() — do not edit by hand.

const REGISTRY: EmberTool[] = [
  projectOverviewTool,
  gitInspectTool,
  terminalTool,
  listDirectoryTool,
  searchFilesTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  webSearchTool,
  httpRequestTool,
  fetchPageTool,
  // browserTool removed — replaced by @playwright/mcp (mcp__playwright__browser_*)
  handoffTool,
];

// Fast lookup map rebuilt whenever registerMcpTools() adds new tools.
const TOOL_MAP = new Map<string, EmberTool>(
  REGISTRY.map((tool) => [tool.definition.name, tool]),
);

// ─── Per-role tool sets ────────────────────────────────────────────────────────
// Controls which tools each role can call. Roles not listed here get no tools.
// MCP tools are appended to these arrays by registerMcpTools() at startup.

// Note: browser tools are NOT listed here — they are injected at startup via
// registerMcpTools() when the @playwright/mcp server connects (mcp.default.json).
// Roles: coordinator, advisor, director, inspector get mcp__playwright__browser_*
const ROLE_TOOLS: Record<Role, EmberTool[]> = {
  dispatch:    [],
  coordinator: [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, handoffTool],
  advisor:     [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, handoffTool],
  director:    [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, handoffTool],
  inspector:   [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, handoffTool],
  ops:         [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, httpRequestTool, handoffTool],
};

// ─── Handoff state ────────────────────────────────────────────────────────────

export interface PendingHandoff {
  role: string;
  message: string;
}

const VALID_HANDOFF_ROLES = ["advisor", "coordinator", "director", "inspector", "ops"];

/**
 * Creates a per-execution tool handler that intercepts `handoff` calls and
 * delegates everything else to the global handleToolCall.
 */
export function createToolHandler(options?: { browserSessionKey?: string }) {
  let pendingHandoff: PendingHandoff | null = null;

  return {
    async onToolCall(name: string, input: Record<string, unknown>): Promise<import("@ember/core").ToolResult> {
      if (name === "handoff") {
        const role = String(input.role ?? "").toLowerCase().trim();
        const message = String(input.message ?? "").trim();
        if (!VALID_HANDOFF_ROLES.includes(role)) {
          return `Unknown role "${role}". Valid handoff roles: ${VALID_HANDOFF_ROLES.join(", ")}`;
        }
        if (!message) {
          return "Handoff message is required. Include the goal, completed work, and what the next role should do.";
        }
        pendingHandoff = { role, message };
        return `Handoff to ${role} registered. Wrap up your response and ${role} will continue.`;
      }

      // Only terminal tools use __sessionKey for session persistence.
      // Playwright MCP manages its own sessions internally via the MCP server process.
      if (name === "run_terminal_command" && options?.browserSessionKey) {
        return handleToolCall(name, {
          ...input,
          __sessionKey: options.browserSessionKey,
        });
      }

      return handleToolCall(name, input);
    },
    getPendingHandoff(): PendingHandoff | null {
      return pendingHandoff;
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function setToolConfig(config: { sudoPassword?: string }) {
  if (config.sudoPassword !== undefined) {
    setSudoPassword(config.sudoPassword);
  }
}

/**
 * Register MCP-discovered tools into the global registry and role maps.
 *
 * Called once at server startup after McpClientManager.start() completes.
 * Each entry carries the EmberTool and the Ember roles that may invoke it
 * (derived from the server's `roles` config field).
 *
 * Tools with no roles remain in REGISTRY and TOOL_MAP (so handleToolCall
 * can execute them if the LLM somehow names them), but they are not added to
 * any ROLE_TOOLS array — meaning no role will receive them in its tool list.
 */
export function registerMcpTools(
  entries: Array<{ tool: EmberTool; roles: Role[] }>,
): void {
  for (const { tool, roles } of entries) {
    // Skip if already registered (e.g. duplicate names from multiple servers)
    if (TOOL_MAP.has(tool.definition.name)) {
      console.warn(
        `[mcp] Tool name collision: "${tool.definition.name}" already registered. Skipping.`,
      );
      continue;
    }

    REGISTRY.push(tool);
    TOOL_MAP.set(tool.definition.name, tool);

    for (const role of roles) {
      if (ROLE_TOOLS[role]) {
        ROLE_TOOLS[role].push(tool);
      }
    }
  }
}

export function getToolsForRole(role: Role): ToolDefinition[] {
  return (ROLE_TOOLS[role] ?? []).map((t) => t.definition);
}

/**
 * Build the tools section of a role's system prompt.
 *
 * Injection logic:
 *   - Tool-gated skills  (frontmatter `tools: [...]`): injected when at least
 *     one of the listed tools is in the active set (from skills/<name>/SKILL.md).
 *   - Role-scoped skills (no `tools` field): always injected for the role
 *     (e.g. loop-prevention, coordinator-behavior).
 *   - Dynamic workflow hints: short one-liners derived from the active tool set.
 */
export function getToolSystemPrompt(tools: ToolDefinition[], role?: Role): string {
  if (!tools.length) return "";

  const toolNames = new Set(tools.map((t) => t.name));

  // ── Skill injection ───────────────────────────────────────────────────────
  const skills = skillManager.listSkills(role, toolNames);
  const toolSkills = skills.filter((s) => s.tools && s.tools.length > 0);
  const roleSkills = skills.filter((s) => !s.tools || s.tools.length === 0);

  // ── Dynamic workflow hints ────────────────────────────────────────────────
  const workflows: string[] = [];
  if (toolNames.has("project_overview")) {
    workflows.push("For unfamiliar repos: start with project_overview.");
  }
  if (toolNames.has("git_inspect")) {
    workflows.push("For dirty worktrees, reviews, or change summaries: check git_inspect before editing.");
  }
  if (toolNames.has("search_files") && toolNames.has("read_file")) {
    workflows.push("For code tasks: search_files first, then read_file before editing.");
  }
  if (toolNames.has("http_request")) {
    workflows.push("For APIs and health checks: prefer http_request over browser automation.");
  }
  if (toolNames.has("web_search") && toolNames.has("fetch_page")) {
    workflows.push("For external research: web_search first, then fetch_page on the best source.");
  }
  // Detect Playwright MCP tools (registered as mcp__playwright__browser_*)
  if ([...toolNames].some((n) => n.startsWith("mcp__playwright__browser_"))) {
    workflows.push(
      "For web automation: navigate → snapshot (read accessibility tree refs) → click/fill using refs → snapshot to verify. Never skip the snapshot step.",
    );
  }
  if (toolNames.has("run_terminal_command")) {
    workflows.push("Use the terminal for commands or interactive workflows only after a narrower tool would not be enough.");
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const out: string[] = [
    "## Tools",
    "Use tools when they help you answer correctly or complete the task.",
    "Base every claim on tool results. Never say you checked, changed, ran, or verified something unless a tool result proves it.",
    "Choose the smallest tool that fits the job.",
    "Prefer short-output tools and the smallest valid input shape.",
    "Prefer one tool call per step, then reassess.",
  ];

  if (workflows.length) {
    out.push("", "## Recommended Workflows");
    out.push(...workflows.map((w) => `- ${w}`));
  }

  // Inject tool-gated skill bodies
  for (const skill of toolSkills) {
    out.push("", skill.body);
  }

  // Inject role-scoped skill bodies (loop-prevention, coordinator-behavior, etc.)
  for (const skill of roleSkills) {
    out.push("", skill.body);
  }

  return out.join("\n");
}

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<import("@ember/core").ToolResult> {
  let tool = TOOL_MAP.get(name);

  // Alias resolution: local models (e.g. Qwen GGUF) may call MCP tools by their
  // base name (e.g. "browser_navigate") instead of the full namespaced name
  // (e.g. "mcp__playwright__browser_navigate"). If the exact name is not found,
  // scan the registry for a unique tool whose name ends with "__<name>".
  if (!tool && !name.includes("__")) {
    const suffix = `__${name}`;
    const matches: EmberTool[] = [];
    for (const [registeredName, registeredTool] of TOOL_MAP) {
      if (registeredName.endsWith(suffix)) {
        matches.push(registeredTool);
      }
    }
    if (matches.length === 1) {
      console.log(`[tools] alias resolved: "${name}" → "${matches[0].definition.name}"`);
      tool = matches[0];
    } else if (matches.length > 1) {
      const candidates = matches.map((t) => t.definition.name).join(", ");
      return `Ambiguous tool name "${name}" — matches multiple registered tools: ${candidates}. Use the full tool name.`;
    }
  }

  if (!tool) return `Unknown tool: ${name}`;
  return tool.execute(input);
}
