import type { ChatMessage, MemoryToolObservation, Role, ToolDefinition, ToolResult } from "@ember/core";
import { skillManager } from "@ember/core/skills";
import type { DeliveryWorkflowState } from "../delivery-workflow.js";
import { resolveDeliveryWorkflowAfterHandoff } from "../delivery-workflow.js";

// browserTool is intentionally NOT imported here — replaced by @playwright/mcp (Phase 3).
// See apps/server/mcp.default.json and skills/playwright-browser/SKILL.md.
// To roll back: re-import browserTool and add it to REGISTRY + ROLE_TOOLS.
import { fetchPageTool } from "./fetch-page.js";
import { deleteFileTool, editFileTool, listDirectoryTool, readFileTool, writeFileTool } from "./files.js";
import { gitInspectTool } from "./git-inspect.js";
import { handoffTool } from "./handoff.js";
import { httpRequestTool } from "./http-request.js";
import { forgetMemoryTool, memoryGetTool, memorySearchTool, saveMemoryTool } from "./memory.js";
import { parallelTasksTool } from "./parallel-tasks.js";
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

const BASE_REGISTRY: EmberTool[] = [
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
  parallelTasksTool,
  // browserTool removed — replaced by @playwright/mcp (mcp__playwright__browser_*)
  handoffTool,
];

const REGISTRY: EmberTool[] = [...BASE_REGISTRY];

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
const BASE_ROLE_TOOLS: Record<Role, EmberTool[]> = {
  dispatch:    [],
  coordinator: [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, parallelTasksTool, handoffTool],
  advisor:     [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, parallelTasksTool, handoffTool],
  director:    [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, parallelTasksTool, handoffTool],
  inspector:   [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, parallelTasksTool, handoffTool],
  ops:         [editFileTool, deleteFileTool],
};

const ROLE_TOOLS: Record<Role, EmberTool[]> = Object.fromEntries(
  Object.entries(BASE_ROLE_TOOLS).map(([role, tools]) => [role, [...tools]]),
) as Record<Role, EmberTool[]>;
const MCP_TOOL_REGISTRY = new Map<string, { tool: EmberTool; roles: Role[] }>();

// ─── Handoff state ────────────────────────────────────────────────────────────

export interface PendingHandoff {
  role: string;
  message: string;
  workflowState: DeliveryWorkflowState | null;
}

export type ToolSnapshot = ReadonlyMap<string, EmberTool>;

const VALID_HANDOFF_ROLES = ["advisor", "coordinator", "director", "inspector", "ops"];
const COMPACT_BROWSER_TOOL_SUFFIXES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill_form",
  "browser_type",
  "browser_press_key",
  "browser_select_option",
  "browser_check",
  "browser_wait_for",
  "browser_get_url",
  "browser_screenshot",
  "browser_take_screenshot",
  "browser_navigate_back",
  "browser_handle_dialog",
  "browser_evaluate",
]);
const COMPACT_DESKTOP_TOOL_SUFFIXES = new Set([
  "describe_environment",
  "take_screenshot",
  "list_open_applications",
  "open_application",
  "focus_application",
  "open_resource",
  "type_text",
  "press_keys",
  "move_mouse",
  "click_mouse",
]);
const HANDOFF_REQUIRED_SECTIONS = ["GOAL", "DONE", "TODO", "FILES", "NOTES"] as const;
const TOOL_DESCRIPTION_LIMIT = 110;
const TOOL_PROPERTY_DESCRIPTION_LIMIT = 56;
const COMPACT_EXTRA_MCP_TOOL_LIMIT = 4;
const COMPACT_TOOL_SELECTION_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "agent",
  "around",
  "build",
  "could",
  "fetch",
  "from",
  "have",
  "into",
  "just",
  "latest",
  "make",
  "need",
  "page",
  "please",
  "project",
  "repo",
  "role",
  "that",
  "this",
  "tool",
  "using",
  "want",
  "with",
  "work",
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

function validateHandoffMessage(message: string): string | null {
  const missing = HANDOFF_REQUIRED_SECTIONS.filter((section) =>
    !new RegExp(`(^|\\n)${section}:\\s*\\S`, "i").test(message),
  );
  if (missing.length === 0) {
    return null;
  }
  return `Handoff message must include ${missing.join(", ")} sections.`;
}

function tokenizeToolSelectionText(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) =>
        token.length >= 4 &&
        !COMPACT_TOOL_SELECTION_STOP_WORDS.has(token),
      ),
  );
}

function scoreCompactToolRelevance(
  tool: ToolDefinition,
  contextTokens: ReadonlySet<string>,
): number {
  if (contextTokens.size === 0) {
    return 0;
  }

  const haystack = tokenizeToolSelectionText(
    `${tool.name.replace(/__/g, " ").replace(/_/g, " ")} ${tool.description}`,
  );
  let score = 0;
  for (const token of contextTokens) {
    if (haystack.has(token)) {
      score += 1;
    }
  }
  return score;
}

function selectRelevantCompactMcpTools(
  tools: ToolDefinition[],
  contextText: string,
  selectedNames: ReadonlySet<string>,
  options: {
    needsInteractiveBrowser: boolean;
    needsDesktopAutomation: boolean;
    needsProjectScaffold: boolean;
  },
): Set<string> {
  const extra = new Set<string>();
  const contextTokens = tokenizeToolSelectionText(contextText);

  if (options.needsInteractiveBrowser) {
    for (const tool of tools) {
      if (!tool.name.startsWith("mcp__playwright__")) {
        continue;
      }
      const suffix = tool.name.split("__").slice(-1)[0] ?? "";
      if (COMPACT_BROWSER_TOOL_SUFFIXES.has(suffix)) {
        extra.add(tool.name);
      }
    }
  }

  if (options.needsProjectScaffold) {
    for (const tool of tools) {
      if (tool.name.startsWith("mcp__scaffold__")) {
        extra.add(tool.name);
      }
    }
  }

  if (options.needsDesktopAutomation) {
    for (const tool of tools) {
      if (!tool.name.startsWith("mcp__desktop__")) {
        continue;
      }
      const suffix = tool.name.split("__").slice(-1)[0] ?? "";
      if (COMPACT_DESKTOP_TOOL_SUFFIXES.has(suffix)) {
        extra.add(tool.name);
      }
    }
  }

  const ranked = tools
    .filter((tool) => tool.name.startsWith("mcp__") && !selectedNames.has(tool.name) && !extra.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      score: scoreCompactToolRelevance(tool, contextTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, COMPACT_EXTRA_MCP_TOOL_LIMIT);

  for (const entry of ranked) {
    extra.add(entry.name);
  }

  return extra;
}

/**
 * Creates a per-execution tool handler that intercepts `handoff` calls and
 * can execute the request-scoped tool snapshot for the current run.
 */
export function createToolHandler(options?: {
  activeRole?: Role;
  workflowState?: DeliveryWorkflowState | null;
  browserSessionKey?: string;
  toolSnapshot?: ToolSnapshot;
  parallelDepth?: number;
  onParallelTasks?: (input: Record<string, unknown>) => Promise<import("@ember/core").ToolResult>;
  onToolResult?: (observation: MemoryToolObservation) => void;
}) {
  let pendingHandoff: PendingHandoff | null = null;

  return {
    async onToolCall(name: string, input: Record<string, unknown>): Promise<import("@ember/core").ToolResult> {
      if (name === "handoff") {
        if (pendingHandoff) {
          return `Handoff already registered for ${pendingHandoff.role}. Finish your response without calling handoff again.`;
        }
        const role = String(input.role ?? "").toLowerCase().trim();
        const message = String(input.message ?? "").trim();
        if (!VALID_HANDOFF_ROLES.includes(role)) {
          return `Unknown role "${role}". Valid handoff roles: ${VALID_HANDOFF_ROLES.join(", ")}`;
        }
        if (!message) {
          return "Handoff message is required. Include the goal, completed work, and what the next role should do.";
        }
        const handoffValidationError = validateHandoffMessage(message);
        if (handoffValidationError) {
          return handoffValidationError;
        }
        const workflowResolution = resolveDeliveryWorkflowAfterHandoff({
          current: options?.workflowState ?? null,
          sourceRole: options?.activeRole ?? "coordinator",
          targetRole: role,
          message,
        });
        if (workflowResolution.error) {
          return workflowResolution.error;
        }
        pendingHandoff = { role, message, workflowState: workflowResolution.state };
        return `Handoff to ${role} registered. Wrap up your response and ${role} will continue.`;
      }

      if (name === "launch_parallel_tasks") {
        if (!options?.onParallelTasks) {
          return "Parallel task execution is not available in this context.";
        }
        if ((options.parallelDepth ?? 0) >= 1) {
          return "Parallel task execution is limited to one fan-out layer. Finish this subtask without launching more parallel workers.";
        }
        const result = await options.onParallelTasks(input);
        options.onToolResult?.(resolveToolObservation(name, input, result));
        return result;
      }

      const tool = resolveTool(name, options?.toolSnapshot);
      if (!tool) {
        return options?.toolSnapshot
          ? `Tool "${name}" is not active for this execution.`
          : `Unknown tool: ${name}`;
      }

      // Only terminal tools use __sessionKey for session persistence.
      // Playwright MCP manages its own sessions internally via the MCP server process.
      if (name === "run_terminal_command" && options?.browserSessionKey) {
        const result = await tool.execute({
          ...input,
          __sessionKey: options.browserSessionKey,
        });
        options.onToolResult?.(resolveToolObservation(name, input, result));
        return result;
      }

      const result = await tool.execute(input);
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
  ingestMcpTools(entries, false);
}

export function replaceMcpTools(
  entries: Array<{ tool: EmberTool; roles: Role[] }>,
): void {
  ingestMcpTools(entries, true);
}

export function getToolsForRole(role: Role): ToolDefinition[] {
  return (ROLE_TOOLS[role] ?? []).map((t) => t.definition);
}

function ingestMcpTools(
  entries: Array<{ tool: EmberTool; roles: Role[] }>,
  replaceAll: boolean,
): void {
  if (replaceAll) {
    MCP_TOOL_REGISTRY.clear();
  }

  for (const { tool, roles } of entries) {
    const nativeCollision = BASE_REGISTRY.some((candidate) => candidate.definition.name === tool.definition.name);
    if (nativeCollision) {
      console.warn(
        `[mcp] Tool name collision: "${tool.definition.name}" already exists in the native registry. Skipping.`,
      );
      continue;
    }
    if (MCP_TOOL_REGISTRY.has(tool.definition.name) && !replaceAll) {
      console.warn(
        `[mcp] Tool name collision: "${tool.definition.name}" already registered. Skipping.`,
      );
      continue;
    }
    MCP_TOOL_REGISTRY.set(tool.definition.name, { tool, roles });
  }

  rebuildToolRegistry();
}

function rebuildToolRegistry(): void {
  REGISTRY.splice(0, REGISTRY.length, ...BASE_REGISTRY);
  TOOL_MAP.clear();
  for (const tool of BASE_REGISTRY) {
    TOOL_MAP.set(tool.definition.name, tool);
  }

  for (const role of Object.keys(BASE_ROLE_TOOLS) as Role[]) {
    ROLE_TOOLS[role] = [...BASE_ROLE_TOOLS[role]];
  }

  for (const { tool, roles } of MCP_TOOL_REGISTRY.values()) {
    REGISTRY.push(tool);
    TOOL_MAP.set(tool.definition.name, tool);
    for (const role of roles) {
      if (ROLE_TOOLS[role]) {
        ROLE_TOOLS[role].push(tool);
      }
    }
  }
}

export function getExecutionToolsForRole(
  role: Role,
  options: {
    compact?: boolean;
    content?: string;
    conversation?: ChatMessage[];
  } = {},
): ToolDefinition[] {
  const tools = selectExecutionToolsForRole(role, options);
  if (!options.compact || role !== "coordinator") {
    return tools.map((tool) => tool.definition);
  }

  return tools.map((tool) => compactToolDefinition(tool.definition));
}

export function getExecutionToolSnapshotForRole(
  role: Role,
  options: {
    compact?: boolean;
    content?: string;
    conversation?: ChatMessage[];
  } = {},
): ToolSnapshot {
  return new Map(
    selectExecutionToolsForRole(role, options).map((tool) => [tool.definition.name, tool] as const),
  );
}

function selectExecutionToolsForRole(
  role: Role,
  options: {
    compact?: boolean;
    content?: string;
    conversation?: ChatMessage[];
  } = {},
): EmberTool[] {
  const tools = ROLE_TOOLS[role] ?? [];
  if (!options.compact || role !== "coordinator") {
    return [...tools];
  }

  const contextText = buildToolSelectionContext(options.content ?? "", options.conversation ?? []);
  const workspaceContext =
    /\b(repo|workspace|codebase|project files?|source code|file|files|path|directory|folder|tree|layout|tsconfig|package\.json|component|class|function|module|build|test|lint|typecheck|pnpm|npm|git|diff|branch|commit)\b/i.test(
      contextText,
    ) ||
    (/\b(fix|implement|change|edit|update|patch|write|create|add|refactor|rename|remove|debug)\b/i.test(
      contextText,
    ) &&
      /\b(api|server|endpoint|typescript|javascript|react|backend|frontend|component|function|module)\b/i.test(
        contextText,
      ));
  const needsWorkspaceRead = workspaceContext;
  const needsWorkspaceWrite =
    workspaceContext &&
    /\b(fix|implement|change|edit|update|patch|write|create|add|refactor|rename|remove)\b/i.test(
      contextText,
    );
  const needsDirectoryContext =
    workspaceContext && /\b(path|directory|folder|tree|layout|list files|list dir)\b/i.test(contextText);
  const needsTerminal =
    workspaceContext &&
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
  const needsDesktopAutomation =
    /\b(desktop|native app|application|window|screen|cursor|mouse|keyboard|type text|press key|focus app|open app|open application|mail app|chatgpt app|desktop screenshot)\b/i.test(
      contextText,
    );
  const needsProjectScaffold =
    /\b(scaffold|template|starter|boilerplate|bootstrap|new project|new app|new repo|spin up)\b/i.test(
      contextText,
    );
  const needsMemoryMutation =
    /\b(remember|save memory|forget|stop remembering|remove memory|delete memory|correct memory)\b/i.test(
      contextText,
    );
  const needsMemoryRecall =
    needsMemoryMutation ||
    /\b(earlier|previous|last time|from before|past chat|past conversation|what do you remember|what do you know about me|you saved|memory)\b/i.test(
      contextText,
    );

  const selected = new Set<string>(["handoff"]);
  if (needsWorkspaceRead || needsWorkspaceWrite || needsDirectoryContext || needsTerminal) {
    selected.add("project_overview");
  }
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
  if (needsMemoryRecall) {
    selected.add("memory_search");
    selected.add("memory_get");
  }
  if (needsMemoryMutation) {
    selected.add("save_memory");
    selected.add("forget_memory");
  }
  selected.add("launch_parallel_tasks");

  const compactMcpTools = selectRelevantCompactMcpTools(
    tools.map((tool) => tool.definition),
    contextText,
    selected,
    {
      needsInteractiveBrowser,
      needsDesktopAutomation,
      needsProjectScaffold,
    },
  );

  return tools.filter((tool) => {
    if (selected.has(tool.definition.name)) {
      return true;
    }
    return compactMcpTools.has(tool.definition.name);
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
  const toolNames = new Set(tools.map((t) => t.name));

  // ── Skill injection ───────────────────────────────────────────────────────
  const skills = skillManager.listSkills(role, toolNames);
  const toolSkills = skills.filter((s) => s.tools && s.tools.length > 0);
  const roleSkills = skills.filter((s) => !s.tools || s.tools.length === 0);
  const hasInjectedWorkflow = tools.length > 0 || roleSkills.length > 0;
  if (!hasInjectedWorkflow) {
    return "";
  }

  if (!tools.length) {
    if (options.compact) {
      const compactSkills = roleSkills
        .slice(0, 8)
        .map((skill) => `- ${skill.name}: ${skill.description}`);
      return [
        "## Workflow",
        "Stay in role unless the next role clearly has the better lane.",
        ...(compactSkills.length > 0 ? ["", "## Active Skills", ...compactSkills] : []),
      ].join("\n");
    }

    return [
      "## Workflow",
      "No tools are active for this role. Follow the role guidance and the injected skills below.",
      ...roleSkills.flatMap((skill) => ["", skill.body]),
    ].join("\n");
  }

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
  if (toolNames.has("launch_parallel_tasks")) {
    workflows.push(
      "For independent multi-part work: fan out up to 4 self-contained subtasks with launch_parallel_tasks and avoid overlapping file writes.",
    );
  }
  // Detect Playwright MCP tools (registered as mcp__playwright__browser_*)
  if ([...toolNames].some((n) => n.startsWith("mcp__playwright__browser_"))) {
    workflows.push(
      "For web automation: navigate → snapshot (read accessibility tree refs) → click/fill using refs → snapshot to verify. Never skip the snapshot step.",
    );
  }
  if ([...toolNames].some((n) => n.startsWith("mcp__desktop__"))) {
    workflows.push(
      "For desktop automation: describe_environment first, then screenshot → open/focus app → move/click or type/press → screenshot to verify. Use browser tools for websites and terminal/filesystem tools for code or file tasks.",
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

function compactToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    description: truncateInstruction(tool.description, TOOL_DESCRIPTION_LIMIT),
    inputSchema: compactJsonSchema(tool.inputSchema),
  };
}

function compactJsonSchema(value: unknown): ToolDefinition["inputSchema"] {
  return compactJsonSchemaNode(value) as ToolDefinition["inputSchema"];
}

function compactJsonSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactJsonSchemaNode(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};

  if (typeof record.type === "string") {
    compact.type = record.type;
  }
  if (typeof record.description === "string" && record.description.trim()) {
    compact.description = truncateInstruction(record.description, TOOL_PROPERTY_DESCRIPTION_LIMIT);
  }
  if (Array.isArray(record.required) && record.required.length > 0) {
    compact.required = record.required;
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    compact.enum = record.enum;
  }
  if (record.additionalProperties === false) {
    compact.additionalProperties = false;
  }
  if (record.properties && typeof record.properties === "object") {
    compact.properties = Object.fromEntries(
      Object.entries(record.properties as Record<string, unknown>).map(([key, property]) => [
        key,
        compactJsonSchemaNode(property),
      ]),
    );
  }
  if (record.items !== undefined) {
    compact.items = compactJsonSchemaNode(record.items);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(record[key])) {
      compact[key] = record[key].map((entry) => compactJsonSchemaNode(entry));
    }
  }

  return compact;
}

function truncateInstruction(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  const sentence = normalized.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? normalized;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}...` : sentence;
}

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<import("@ember/core").ToolResult> {
  const tool = resolveTool(name);
  if (!tool) return `Unknown tool: ${name}`;
  return tool.execute(input);
}

function resolveTool(name: string, tools: ToolSnapshot = TOOL_MAP): EmberTool | null {
  let tool = tools.get(name) ?? null;

  if (!tool && !name.includes("__")) {
    const suffix = `__${name}`;
    const matches: EmberTool[] = [];
    for (const [registeredName, registeredTool] of tools) {
      if (registeredName.endsWith(suffix)) {
        matches.push(registeredTool);
      }
    }
    if (matches.length === 1) {
      console.log(`[tools] alias resolved: "${name}" → "${matches[0].definition.name}"`);
      tool = matches[0];
    } else if (matches.length > 1) {
      console.warn(
        `[tools] ambiguous tool alias "${name}" across: ${matches.map((candidate) => candidate.definition.name).join(", ")}`,
      );
      return null;
    }
  }

  return tool;
}
