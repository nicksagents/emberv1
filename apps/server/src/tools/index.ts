import {
  capToolResult,
  redactSensitiveText,
  type ChatMessage,
  type MemoryToolObservation,
  type Role,
  type ToolDefinition,
  type ToolResult,
} from "@ember/core";
import { skillManager } from "@ember/core/skills";
import type { DeliveryWorkflowState } from "../delivery-workflow.js";
import { resolveDeliveryWorkflowAfterHandoff } from "../delivery-workflow.js";

// browserTool is intentionally NOT imported here — replaced by @playwright/mcp (Phase 3).
// See apps/server/mcp.default.json and skills/playwright-browser/SKILL.md.
// To roll back: re-import browserTool and add it to REGISTRY + ROLE_TOOLS.
import { fetchPageTool } from "./fetch-page.js";
import { deleteFileTool, editFileTool, listDirectoryTool, readFileTool, statPathTool, writeFileTool } from "./files.js";
import { gitInspectTool } from "./git-inspect.js";
import { handoffTool } from "./handoff.js";
import { httpRequestTool } from "./http-request.js";
import { credentialGetTool, credentialListTool, credentialSaveTool } from "./credentials.js";
import { forgetMemoryTool, memoryGetTool, memorySearchTool, saveMemoryTool } from "./memory.js";
import { networkToolsTool } from "./network-tools.js";
import { parallelTasksTool } from "./parallel-tasks.js";
import { processManagerTool } from "./process-manager.js";
import { projectOverviewTool } from "./project-overview.js";
import { searchFilesTool } from "./search-files.js";
import { sshExecuteTool } from "./ssh-execute.js";
import { systemInfoTool } from "./system-info.js";
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
  statPathTool,
  listDirectoryTool,
  searchFilesTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  webSearchTool,
  httpRequestTool,
  fetchPageTool,
  credentialSaveTool,
  credentialListTool,
  credentialGetTool,
  saveMemoryTool,
  memorySearchTool,
  memoryGetTool,
  forgetMemoryTool,
  parallelTasksTool,
  systemInfoTool,
  processManagerTool,
  networkToolsTool,
  sshExecuteTool,
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
  coordinator: [projectOverviewTool, gitInspectTool, statPathTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, credentialSaveTool, credentialListTool, credentialGetTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, parallelTasksTool, systemInfoTool, processManagerTool, networkToolsTool, sshExecuteTool, handoffTool],
  advisor:     [projectOverviewTool, gitInspectTool, statPathTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, credentialSaveTool, credentialListTool, credentialGetTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, parallelTasksTool, systemInfoTool, networkToolsTool, sshExecuteTool, handoffTool],
  director:    [projectOverviewTool, gitInspectTool, statPathTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, credentialSaveTool, credentialListTool, credentialGetTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, parallelTasksTool, systemInfoTool, processManagerTool, networkToolsTool, sshExecuteTool, handoffTool],
  inspector:   [projectOverviewTool, gitInspectTool, statPathTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, credentialSaveTool, credentialListTool, credentialGetTool, saveMemoryTool, memorySearchTool, memoryGetTool, forgetMemoryTool, parallelTasksTool, systemInfoTool, processManagerTool, networkToolsTool, sshExecuteTool, handoffTool],
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
  "list_windows",
  "get_active_window",
  "detect_text_on_screen",
  "find_text_on_screen",
  "list_open_applications",
  "open_application",
  "focus_application",
  "open_resource",
  "type_text",
  "press_keys",
  "move_mouse",
  "click_mouse",
  "drag_mouse",
  "scroll_mouse",
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
const OBSERVATION_SENSITIVE_KEY_PATTERN =
  /(^|_)(password|passcode|passwd|secret|token|api_key|access_token|refresh_token|auth_token|private_key|ssh_password|otp|pin)(_|$)/i;

function toolResultToText(result: ToolResult): string {
  return typeof result === "string" ? result : result.text;
}

function sanitizeToolObservationInputValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolObservationInputValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (OBSERVATION_SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = sanitizeToolObservationInputValue(item);
  }
  return output;
}

function sanitizeToolObservationInput(input: Record<string, unknown>): Record<string, unknown> {
  return sanitizeToolObservationInputValue(input) as Record<string, unknown>;
}

function sanitizeToolObservationResult(
  name: string,
  input: Record<string, unknown>,
  resultText: string,
): string {
  if (name === "credential_get") {
    const label =
      (typeof input.label === "string" && input.label.trim()) ||
      (typeof input.id === "string" && input.id.trim()) ||
      (typeof input.target === "string" && input.target.trim()) ||
      "credential";
    return `Credential vault entry retrieved for ${label}. Sensitive fields were returned to the model but omitted from memory traces.`;
  }

  if (name === "credential_save") {
    const label =
      (typeof input.label === "string" && input.label.trim()) ||
      (typeof input.target === "string" && input.target.trim()) ||
      "credential";
    return `Credential vault entry saved for ${label}. Sensitive fields were stored locally and omitted from memory traces.`;
  }

  return redactSensitiveText(resultText);
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
  const sanitizedInput = sanitizeToolObservationInput(input);
  const resultText = toolResultToText(result);
  const sanitizedResultText = sanitizeToolObservationResult(name, input, resultText);
  const rawSourceRef = typeof sanitizedInput.url === "string"
    ? sanitizedInput.url.trim()
    : typeof sanitizedInput.path === "string"
      ? sanitizedInput.path.trim()
      : null;
  const sourceRef = rawSourceRef && rawSourceRef.length > 0 ? rawSourceRef : null;
  const sourceType =
    sourceRef && /^https?:\/\//i.test(sourceRef) ? "web_page" : "tool_result";

  return {
    toolName: name,
    input: sanitizedInput,
    resultText: sanitizedResultText,
    createdAt: new Date().toISOString(),
    sourceRef,
    sourceType,
    command: normalizeObservationText(sanitizedInput.command),
    workingDirectory: normalizeObservationText(sanitizedInput.cwd),
    targetPath: normalizeObservationText(
      typeof sanitizedInput.path === "string"
        ? sanitizedInput.path
        : typeof sanitizedInput.file === "string"
          ? sanitizedInput.file
          : null,
    ),
    queryText: normalizeObservationText(sanitizedInput.query),
    exitCode: name === "run_terminal_command" ? parseTerminalExitCode(sanitizedResultText) : null,
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
  contextWindowTokens?: number;
  onParallelTasks?: (input: Record<string, unknown>) => Promise<import("@ember/core").ToolResult>;
  onToolResult?: (observation: MemoryToolObservation) => void;
}) {
  let pendingHandoff: PendingHandoff | null = null;
  const ctxWindow = options?.contextWindowTokens ?? 0;

  function capResult(result: import("@ember/core").ToolResult): import("@ember/core").ToolResult {
    if (ctxWindow <= 0) return result;
    if (typeof result === "string") return capToolResult(result, ctxWindow);
    return { ...result, text: capToolResult(result.text, ctxWindow) };
  }

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
        const result = capResult(await options.onParallelTasks(input));
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
        const result = capResult(await tool.execute({
          ...input,
          __sessionKey: options.browserSessionKey,
        }));
        options.onToolResult?.(resolveToolObservation(name, input, result));
        return result;
      }

      const result = capResult(await tool.execute(input));
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
    ultraCompact?: boolean;
    content?: string;
    conversation?: ChatMessage[];
  } = {},
): ToolDefinition[] {
  const tools = selectExecutionToolsForRole(role, options);
  if (!options.compact) {
    return tools.map((tool) => tool.definition);
  }

  return tools.map((tool) => compactToolDefinition(tool.definition, options.ultraCompact));
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
  if (!options.compact) {
    return [...tools];
  }

  const contextText = buildToolSelectionContext(options.content ?? "", options.conversation ?? []);
  const repoContext =
    /\b(repo|workspace|codebase|project root|project files?|source code|tsconfig|package\.json|component|class|function|module|typescript|javascript|react|backend|frontend|build|test|lint|typecheck|pnpm|npm|git|diff|branch|commit)\b/i.test(
      contextText,
    ) ||
    /\b(this|the)\s+(project|repo|workspace|codebase)\b/i.test(contextText) ||
    (/\b(fix|implement|change|edit|update|patch|write|create|add|refactor|rename|remove|debug)\b/i.test(
      contextText,
    ) &&
      /\b(api|server|endpoint|typescript|javascript|react|backend|frontend|component|function|module)\b/i.test(
        contextText,
      ));
  const hostFilesystemContext =
    /\b(desktop|downloads|documents|pictures|videos|music|finder|explorer|filesystem|local machine|host machine|host path|absolute path|home directory|home folder)\b/i.test(
      contextText,
    ) ||
    (/\b(list|show|inspect|check|open|read|browse|look at|find|search|rename|move|copy|delete|remove|create|write|edit|update|what(?:'s| is)|contents?|items)\b/i.test(
      contextText,
    ) &&
      /\b(file|files|path|paths|directory|directories|folder|folders|desktop|downloads|documents)\b/i.test(
        contextText,
      ));
  const needsWorkspaceRead = repoContext;
  const needsWorkspaceWrite =
    repoContext &&
    /\b(fix|implement|change|edit|update|patch|write|create|add|refactor|rename|remove)\b/i.test(
      contextText,
    );
  const needsDirectoryContext =
    (repoContext || hostFilesystemContext) &&
    /\b(path|directory|folder|tree|layout|list files|list dir|desktop|downloads|documents|contents?|items)\b/i.test(
      contextText,
    );
  const needsPathInspection =
    (repoContext || hostFilesystemContext) &&
    /\b(path|exists|existence|directory|folder|file type|extension|size|modified|timestamp|permissions?|symlink|stat)\b/i.test(
      contextText,
    );
  const needsTerminal =
    (repoContext || hostFilesystemContext) &&
    /\b(build|test|lint|typecheck|run|start|serve|install|command|terminal|shell|pnpm|npm|node|python|script)\b/i.test(
      contextText,
    );
  const needsFilesystemRead =
    repoContext ||
    (hostFilesystemContext &&
      /\b(read|open|show|display|view|print|contents?|content|desktop|downloads|documents|file|files|folder|directory)\b/i.test(
        contextText,
      ));
  const needsFilesystemWrite =
    (repoContext || hostFilesystemContext) &&
    /\b(write|edit|update|change|replace|rename|move|copy|delete|remove|create)\b/i.test(contextText) &&
    /\b(file|files|path|folder|directory|desktop|downloads|documents)\b/i.test(contextText);
  const needsFilesystemSearch =
    (repoContext || hostFilesystemContext) &&
    /\b(search|find|grep|look for|match|contains?|containing)\b/i.test(contextText) &&
    /\b(file|files|path|folder|directory|repo|workspace|desktop|downloads|documents|text|string)\b/i.test(
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
  const needsCredentialVault =
    /\b(credential|credentials|password|passcode|username|login email|account email|saved login|sign in|signin|log in)\b/i.test(
      contextText,
    );
  const needsParallelTasks =
    /\b(parallel|in parallel|fan out|fan-out|independent subtasks?|split up|split into subtasks?|simultaneous)\b/i.test(
      contextText,
    );
  const needsDesktopAutomation =
    /\b(desktop|native app|application|window|screen|cursor|mouse|keyboard|type text|press key|focus app|open app|open application|mail app|chatgpt app|desktop screenshot|ocr|text on screen|find text|drag|scroll)\b/i.test(
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
  const needsSystemInfo =
    /\b(cpu|memory usage|ram|disk space|disk usage|system info|system resources|load average|load avg|how much memory|how much disk|what os|operating system|network interface|my ip|local ip)\b/i.test(
      contextText,
    );
  const needsProcessManager =
    /\b(port\s+\d+|port already|port in use|what(?:'s| is) (?:on|using) port|kill(?:ing)? (?:the |a |process)|stop(?:ping)? (?:the |a |process|server)|running process|process list|pid\b|port check|lsof|netstat)\b/i.test(
      contextText,
    );
  const needsNetworkTools =
    /\b(tailscale|mesh vpn|tailnet|tailscale status|tailscale ip|tailscale serve|tailscale funnel|ping\b|dns lookup|dns resolve|network interface|local ip address|my ip)\b/i.test(
      contextText,
    );
  const needsSsh =
    /\b(ssh|secure shell|remote command|remote shell|remote host|remote machine|remote server|tailscale ssh|connect to .* via ssh)\b/i.test(
      contextText,
    );
  const needsPackageInstall =
    /\b(brew install|npm install|pip install|cargo install|apt install|apt-get install|install (?:the |a |package|library|tool|cli|module)|pnpm add|npx )\b/i.test(
      contextText,
    );

  const selected = new Set<string>(["handoff"]);
  if (repoContext) {
    selected.add("project_overview");
  }
  if (repoContext) {
    selected.add("git_inspect");
  }
  if (repoContext || needsPathInspection || needsDirectoryContext || needsFilesystemRead || needsFilesystemWrite) {
    selected.add("stat_path");
  }
  if (repoContext || needsFilesystemSearch) {
    selected.add("search_files");
  }
  if (repoContext || needsFilesystemRead || needsFilesystemWrite) {
    selected.add("read_file");
  }
  if (needsDirectoryContext || needsWorkspaceRead || hostFilesystemContext) {
    selected.add("list_directory");
  }
  if (needsPathInspection) {
    selected.add("stat_path");
  }
  if (needsWorkspaceWrite) {
    selected.add("write_file");
    selected.add("edit_file");
  }
  if (needsFilesystemWrite) {
    selected.add("write_file");
    selected.add("edit_file");
    selected.add("delete_file");
  }
  if (needsTerminal) {
    selected.add("run_terminal_command");
  }
  if (needsWeb || needsInteractiveBrowser) {
    selected.add("web_search");
    selected.add("http_request");
    selected.add("fetch_page");
  }
  if (needsCredentialVault) {
    selected.add("credential_list");
    selected.add("credential_get");
  }
  if (needsSsh) {
    selected.add("ssh_execute");
    selected.add("credential_list");
    selected.add("credential_get");
  }
  if (
    /\b(save|store|remember|update|change|replace)\b/i.test(contextText) &&
    needsCredentialVault
  ) {
    selected.add("credential_save");
  }
  if (needsMemoryRecall) {
    selected.add("memory_search");
    selected.add("memory_get");
  }
  if (needsMemoryMutation) {
    selected.add("save_memory");
    selected.add("forget_memory");
  }
  if (needsParallelTasks) {
    selected.add("launch_parallel_tasks");
  }
  if (needsSystemInfo) {
    selected.add("system_info");
  }
  if (needsProcessManager || needsNetworkTools || needsPackageInstall) {
    selected.add("process_manager");
    selected.add("run_terminal_command");
  }
  if (needsNetworkTools) {
    selected.add("network_tools");
  }
  if (needsSsh) {
    selected.add("network_tools");
  }

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
  if (toolNames.has("list_directory")) {
    workflows.push(
      "For local folders like Desktop or Downloads: use list_directory directly on the absolute host path instead of assuming a workspace-only boundary.",
    );
  }
  if (toolNames.has("stat_path")) {
    workflows.push("Use stat_path before guessing whether a path is a file, directory, or symlink, and before deleting or rewriting unfamiliar targets.");
  }
  if (toolNames.has("http_request")) {
    workflows.push("For APIs and health checks: prefer http_request over browser automation.");
  }
  if (toolNames.has("web_search") && toolNames.has("fetch_page")) {
    workflows.push("For external research: web_search auto-fetches the top 3 pages. Only use fetch_page if you need more content from a specific result or a URL you already have.");
  }
  if (toolNames.has("memory_search") && toolNames.has("memory_get")) {
    workflows.push("For cross-session recall: memory_search first, then memory_get on the best id before asking the user to repeat themselves.");
  }
  if (toolNames.has("credential_list") && toolNames.has("credential_get")) {
    workflows.push(
      "For stored logins: credential_list if you need to locate the right account, then credential_get immediately before browser or desktop sign-in. Do not echo secrets back to the user unless they explicitly ask.",
    );
  }
  if (toolNames.has("credential_save")) {
    workflows.push(
      "Store passwords, login emails, and account secrets with credential_save, not save_memory. Ember uses the OS keychain when the host supports it and falls back to its private local credential store otherwise. Use save_memory only for reusable procedures or non-secret facts.",
    );
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
      "For desktop automation: describe_environment first, then use get_active_window or list_windows when window targeting matters, then screenshot → use OCR text detection before raw coordinate clicks when labels are visible → open/focus app → move/click, drag, scroll, or type/press → screenshot to verify. Use browser tools for websites and terminal/filesystem tools for code or file tasks.",
    );
  }
  if (toolNames.has("run_terminal_command")) {
    workflows.push("Use the terminal for commands or interactive workflows only after a narrower tool would not be enough. Use status or list_sessions instead of guessing session state.");
  }
  if (toolNames.has("mcp__scaffold__scaffold_project")) {
    workflows.push(
      "For new projects: list_templates → get_template_options → scaffold_project → post_setup, then hand off to director for real implementation.",
    );
  }
  if (toolNames.has("process_manager")) {
    workflows.push(
      "For port conflicts: process_manager port_check <port> to see what is using it, then kill by PID if needed. For runaway processes: process_manager list filter=<name> then kill.",
    );
  }
  if (toolNames.has("system_info")) {
    workflows.push(
      "For resource checks: system_info action=all for a quick snapshot, or action=cpu/memory/disk/network for a specific section.",
    );
  }
  if (toolNames.has("network_tools")) {
    workflows.push(
      "For Tailscale sharing: network_tools tailscale_status first to confirm running, then tailscale serve <port> (private) or tailscale funnel <port> (public internet).",
    );
  }
  if (toolNames.has("ssh_execute")) {
    workflows.push(
      "For remote host actions: validate LAN/Tailscale reachability first, then ssh_execute action=test before action=run. Prefer credential vault entries over typing raw SSH passwords in prompts.",
    );
  }

  if (options.compact) {
    const compactSkills = [...toolSkills, ...roleSkills]
      .slice(0, 6)
      .map((skill) => `- ${skill.name}: ${skill.description}`);
    const compactWorkflows = workflows.slice(0, 4);

    return [
      "## Tools",
      "Use the smallest tool that fits. One call per step, then reassess.",
      ...(compactWorkflows.length > 0 ? ["", ...compactWorkflows.map((workflow) => `- ${workflow}`)] : []),
      ...(compactSkills.length > 0 ? ["", ...compactSkills] : []),
    ].join("\n");
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const out: string[] = [
    "## Tools",
    "Use the smallest tool that fits. One call per step, then reassess.",
    "Prefer short-output tools and the smallest valid input shape.",
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

function compactToolDefinition(tool: ToolDefinition, ultraCompact = false): ToolDefinition {
  if (ultraCompact) {
    return {
      ...tool,
      description: truncateInstruction(tool.description, 60),
      inputSchema: ultraCompactJsonSchema(tool.inputSchema),
    };
  }
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

/**
 * Ultra-compact schema: strips all property descriptions, removes optional
 * properties, keeps only type + required + enum. For small models where
 * every token counts — property names are self-documenting enough.
 */
function ultraCompactJsonSchema(value: unknown): ToolDefinition["inputSchema"] {
  return ultraCompactJsonSchemaNode(value, null) as ToolDefinition["inputSchema"];
}

function ultraCompactJsonSchemaNode(value: unknown, requiredKeys: string[] | null): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => ultraCompactJsonSchemaNode(item, null));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  const required = Array.isArray(record.required) ? record.required as string[] : [];

  if (typeof record.type === "string") {
    compact.type = record.type;
  }
  if (required.length > 0) {
    compact.required = required;
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    compact.enum = record.enum;
  }
  // Strip optional properties — keep only required ones
  if (record.properties && typeof record.properties === "object") {
    const props = record.properties as Record<string, unknown>;
    const kept = required.length > 0
      ? Object.fromEntries(
          Object.entries(props)
            .filter(([key]) => required.includes(key))
            .map(([key, property]) => [key, ultraCompactJsonSchemaNode(property, null)]),
        )
      : Object.fromEntries(
          Object.entries(props).map(([key, property]) => [key, ultraCompactJsonSchemaNode(property, null)]),
        );
    if (Object.keys(kept).length > 0) {
      compact.properties = kept;
    }
  }
  if (record.items !== undefined) {
    compact.items = ultraCompactJsonSchemaNode(record.items, null);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(record[key])) {
      compact[key] = record[key].map((entry: unknown) => ultraCompactJsonSchemaNode(entry, null));
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
