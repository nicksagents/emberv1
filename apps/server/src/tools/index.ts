import type { Role, ToolDefinition } from "@ember/core";

import { browserTool } from "./browser.js";
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
  browserTool,
  handoffTool,
];

// Fast lookup map built from the registry.
const TOOL_MAP = new Map<string, EmberTool>(
  REGISTRY.map((tool) => [tool.definition.name, tool]),
);

// ─── Per-role tool sets ────────────────────────────────────────────────────────
// Controls which tools each role can call. Roles not listed here get no tools.
// Add a tool object to a role's array to grant that role access.

const ROLE_TOOLS: Record<Role, EmberTool[]> = {
  dispatch:    [],
  coordinator: [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, browserTool, handoffTool],
  advisor:     [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, browserTool, handoffTool],
  director:    [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, browserTool, handoffTool],
  inspector:   [projectOverviewTool, gitInspectTool, listDirectoryTool, searchFilesTool, readFileTool, terminalTool, webSearchTool, httpRequestTool, fetchPageTool, browserTool, handoffTool],
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

      if ((name === "browser" || name === "run_terminal_command") && options?.browserSessionKey) {
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

export function getToolsForRole(role: Role): ToolDefinition[] {
  return (ROLE_TOOLS[role] ?? []).map((t) => t.definition);
}

export function getToolSystemPrompt(tools: ToolDefinition[]): string {
  if (!tools.length) return "";
  const toolNames = new Set(tools.map((tool) => tool.name));
  const lines = tools
    .map((t) => TOOL_MAP.get(t.name)?.systemPrompt)
    .filter(Boolean)
    .map((p) => `- ${p}`);
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
  if (toolNames.has("browser")) {
    workflows.push("Use browser only when page state, UI interaction, screenshots, or cookies matter.");
  }
  if (toolNames.has("run_terminal_command")) {
    workflows.push("Use the terminal for commands or interactive workflows only after a narrower tool would not be enough.");
  }

  return [
    "## Tools",
    "Use tools when they help you answer correctly or complete the task.",
    "Base every claim on tool results. Never say you checked, changed, ran, or verified something unless a tool result proves it.",
    "Choose the smallest tool that fits the job.",
    "Prefer short-output tools and the smallest valid input shape.",
    "Prefer one tool call per step, then reassess.",
    "",
    "## Loop Prevention (IMPORTANT)",
    "- Do NOT call the same tool with the same input twice in a row unless the underlying state changed.",
    "- Do NOT read the same file multiple times in one response unless you edited it in between.",
    "- After getting a tool result, decide: is the task done? If yes, respond. If not, what is the single next step?",
    "- If you are going in circles (reading → thinking → reading the same thing again), stop and respond with what you know.",
    "- Once you have enough information to complete the task, stop using tools and give your answer.",
    "",
    "## Small-Model Defaults",
    "- For browser work: navigate -> snapshot -> act with element_id -> snapshot.",
    "- For APIs: use http_request before browser.",
    "- For code search: use search_files with literal=true for exact strings.",
    "- For file inspection: use read_file with start_line/end_line when possible.",
    "- For terminal follow-up: use action=read, action=input, or action=interrupt.",
    "",
    "## Handoff Rules",
    "- Call the handoff tool at most ONCE per response.",
    "- Only call handoff after your own tool work is complete for this turn.",
    "- If the task is done, do NOT call handoff — just respond to the user.",
    workflows.length ? "\n## Recommended Workflows" : "",
    ...workflows.map((line) => `- ${line}`),
    lines.length ? "\n## Available Tools" : "",
    ...lines,
  ].filter(Boolean).join("\n");
}

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<import("@ember/core").ToolResult> {
  const tool = TOOL_MAP.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  return tool.execute(input);
}
