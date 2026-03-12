import type { ChatMessage, MemoryToolObservation, Role, ToolDefinition, ToolResult } from "@ember/core";
import { skillManager } from "@ember/core/skills";

// browserTool is intentionally NOT imported here — replaced by @playwright/mcp (Phase 3).
// See apps/server/mcp.default.json and skills/playwright-browser/SKILL.md.
// To roll back: re-import browserTool and add it to REGISTRY + ROLE_TOOLS.
import { fetchPageTool } from "./fetch-page.js";
import { deleteFileTool, editFileTool, listDirectoryTool, readFileTool, writeFileTool } from "./files.js";
import { gitInspectTool } from "./git-inspect.js";
import { handoffTool } from "./handoff.js";
import { httpRequestTool } from "./http-request.js";
import { forgetMemoryTool, memoryGetTool, memorySearchTool, saveMemoryTool } from "./memory.js";
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
  deleteFileTool,
  webSearchTool,
  httpRequestTool,
  fetchPageTool,
  saveMemoryTool,
  memorySearchTool,
  memoryGetTool,
  forgetMemoryTool,
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
  coordinator: [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, handoffTool],
  advisor:     [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, handoffTool],
  director:    [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, handoffTool],
  inspector:   [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, handoffTool],
  ops:         [editFileTool, deleteFileTool],
};

// ─── Handoff state ────────────────────────────────────────────────────────────

export interface PendingHandoff {
  role: string;
  message: string;
}

const VALID_HANDOFF_ROLES = ["advisor", "coordinator", "director", "inspector", "ops"];
const COMPACT_BROWSER_TOOL_SUFFIXES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill_form",
  "browser_type",
  "browser_wait_for",
  "browser_get_url",
  "browser_screenshot",
  "browser_evaluate",
]);

function toolResultToText(result: ToolResult): string {
  return typeof result === "string" ? result : result.text;
}

function normalizeObservationText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function parseTerminalExitCode(resultText: string): number | null {
  const match = resultText.match(/^Exit code (\d+):/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveToolObservation(
  name: string,
  input: Record<string, unknown>,
  result: ToolResult,
): MemoryToolObservation {
  const resultText = toolResultToText(result);
  const rawSourceRef = typeof input.url === "string"
    ? input.url.trim()
    : typeof input.path === "string"
      ? input.path.trim()
      : null;
  const sourceRef = rawSourceRef && rawSourceRef.length > 0 ? rawSourceRef : null;
  const sourceType =
    sourceRef && /^https?:\/\//i.test(sourceRef) ? "web_page" : "tool_result";

  return {
    toolName: name,
    input,
    resultText,
    createdAt: new Date().toISOString(),
    sourceRef,
    sourceType,
    command: normalizeObservationText(input.command),
    workingDirectory: normalizeObservationText(input.cwd),
    targetPath: normalizeObservationText(
      typeof input.path === "string"
        ? input.path
        : typeof input.file === "string"
          ? input.file
          : null,
    ),
    queryText: normalizeObservationText(input.query),
    exitCode: name === "run_terminal_command" ? parseTerminalExitCode(resultText) : null,
  };
}

/**
 * Creates a per-execution tool handler that intercepts `handoff` calls and
 * delegates everything else to the global handleToolCall.
 */
export function createToolHandler(options?: {
  browserSessionKey?: string;
  onToolResult?: (observation: MemoryToolObservation) => void;
}) {
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
        const result = await handleToolCall(name, {
          ...input,
          __sessionKey: options.browserSessionKey,
        });
        options.onToolResult?.(resolveToolObservation(name, input, result));
        return result;
      }

      const result = await handleToolCall(name, input);
      options?.onToolResult?.(resolveToolObservation(name, input, result));
      return result;
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

export function getExecutionToolsForRole(
  role: Role,
  options: {
    compact?: boolean;
    content?: string;
    conversation?: ChatMessage[];
  } = {},
): ToolDefinition[] {
  const tools = getToolsForRole(role);
  if (!options.compact || role !== "coordinator") {
    return tools;
  }

  const contextText = buildToolSelectionContext(options.content ?? "", options.conversation ?? []);
  const needsWorkspaceRead =
    /\b(repo|workspace|project|file|files|code|typescript|tsconfig|function|class|server|debug|fix|build|test|lint|package|component|api)\b/i.test(
      contextText,
    );
  const needsWorkspaceWrite =
    /\b(fix|implement|change|edit|update|patch|write|create|add|refactor|rename|remove)\b/i.test(
      contextText,
    );
  const needsDirectoryContext = /\b(path|directory|folder|tree|layout|list files|list dir)\b/i.test(contextText);
  const needsTerminal =
    /\b(build|test|lint|typecheck|run|start|serve|install|command|terminal|shell|pnpm|npm|node|python|script)\b/i.test(
      contextText,
    );
  const needsWeb =
    /\b(web|website|page|url|article|docs|documentation|search|research|latest|current|news|fetch|http|api|endpoint|source|cite)\b/i.test(
      contextText,
    );
  const needsInteractiveBrowser =
    /\b(login|log in|sign in|browser|click|button|form|fill|otp|navigate|page state|session|interactive)\b/i.test(
      contextText,
    );
  const needsMemoryMutation =
    /\b(remember|save memory|forget|stop remembering|remove memory|delete memory|correct memory)\b/i.test(
      contextText,
    );

  const selected = new Set<string>(["handoff", "project_overview", "memory_search", "memory_get"]);
  if (needsWorkspaceRead || needsWorkspaceWrite || needsTerminal || needsDirectoryContext) {
    selected.add("git_inspect");
    selected.add("search_files");
    selected.add("read_file");
  }
  if (needsDirectoryContext || needsWorkspaceRead) {
    selected.add("list_directory");
  }
  if (needsWorkspaceWrite) {
    selected.add("write_file");
    selected.add("edit_file");
  }
  if (needsTerminal) {
    selected.add("run_terminal_command");
  }
  if (needsWeb || needsInteractiveBrowser) {
    selected.add("web_search");
    selected.add("http_request");
    selected.add("fetch_page");
  }
  if (needsMemoryMutation) {
    selected.add("save_memory");
    selected.add("forget_memory");
  }
  if (selected.size <= 4) {
    selected.add("search_files");
    selected.add("read_file");
    selected.add("http_request");
    selected.add("fetch_page");
  }

  return tools.filter((tool) => {
    if (selected.has(tool.name)) {
      return true;
    }
    if (!needsInteractiveBrowser || !tool.name.startsWith("mcp__playwright__")) {
      return false;
    }
    const suffix = tool.name.split("__").slice(-1)[0] ?? "";
    return COMPACT_BROWSER_TOOL_SUFFIXES.has(suffix);
  });
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
export function getToolSystemPrompt(
  tools: ToolDefinition[],
  role?: Role,
  options: {
    compact?: boolean;
  } = {},
): string {
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
  if (toolNames.has("memory_search") && toolNames.has("memory_get")) {
    workflows.push("For cross-session recall: memory_search first, then memory_get on the best id before asking the user to repeat themselves.");
  }
  if (toolNames.has("save_memory")) {
    workflows.push("Use save_memory only for durable facts worth keeping across chats, not routine turn-by-turn context.");
  }
  if (toolNames.has("forget_memory")) {
    workflows.push("For corrections or deletion requests: identify the target memory first, then call forget_memory with confirm=true.");
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
  if (toolNames.has("mcp__scaffold__scaffold_project")) {
    workflows.push(
      "For new projects: list_templates → get_template_options → scaffold_project → post_setup, then hand off to director for real implementation.",
    );
  }

  if (options.compact) {
    const compactSkills = [...toolSkills, ...roleSkills]
      .slice(0, 8)
      .map((skill) => `- ${skill.name}: ${skill.description}`);
    const compactWorkflows = workflows.slice(0, 6);

    return [
      "## Tools",
      "Use tools only when they materially help.",
      "Choose the smallest tool that fits and prefer one tool call per step.",
      "Base every claim on tool results. Never say you checked, changed, or verified something without a tool result.",
      "If the task grows beyond a compact tool loop, use handoff once and stop.",
      ...(compactWorkflows.length > 0 ? ["", "## Quick Workflows", ...compactWorkflows.map((workflow) => `- ${workflow}`)] : []),
      ...(compactSkills.length > 0 ? ["", "## Active Skills", ...compactSkills] : []),
    ].join("\n");
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

function buildToolSelectionContext(content: string, conversation: ChatMessage[]): string {
  const recentMessages = conversation.slice(-6).map((message) => message.content);
  return [content, ...recentMessages].join(" ").toLowerCase();
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
