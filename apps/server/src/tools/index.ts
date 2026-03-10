import type { Role, ToolDefinition } from "@ember/core";

import { browserTool } from "./browser.js";
import { fetchPageTool } from "./fetch-page.js";
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { handoffTool } from "./handoff.js";
import { setSudoPassword, terminalTool } from "./terminal.js";
import type { EmberTool } from "./types.js";
import { webSearchTool } from "./web-search.js";

export type { EmberTool };

// ─── Registry ─────────────────────────────────────────────────────────────────
// Add your tool to this array to make it available to the system.
// See TOOLS.md for how to create and register a new tool.

const REGISTRY: EmberTool[] = [
  terminalTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  webSearchTool,
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
  coordinator: [readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, fetchPageTool, browserTool, handoffTool],
  advisor:     [readFileTool, terminalTool, webSearchTool, fetchPageTool, browserTool, handoffTool],
  director:    [readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, fetchPageTool, browserTool, handoffTool],
  inspector:   [readFileTool, terminalTool, webSearchTool, fetchPageTool, browserTool, handoffTool],
  ops:         [readFileTool, writeFileTool, editFileTool, handoffTool],
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

      if (name === "browser" && options?.browserSessionKey) {
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
  const lines = tools
    .map((t) => TOOL_MAP.get(t.name)?.systemPrompt)
    .filter(Boolean)
    .map((p) => `- ${p}`);
  return [
    "## Tools",
    "Use tools when they help you answer correctly or complete the task.",
    "Base claims on tool results. Do not claim you checked, changed, ran, or verified something unless you actually did.",
    "Choose the smallest tool that fits the job.",
    "Read before editing. Verify after important changes when feasible.",
    "After a tool result, either continue with the next necessary step or give a complete answer.",
    "Do not loop unnecessarily. Once you have enough information or the task is complete, stop using tools and respond.",
    ...lines,
  ].join("\n");
}

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<import("@ember/core").ToolResult> {
  const tool = TOOL_MAP.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  return tool.execute(input);
}
