import { spawnSync } from "node:child_process";
import type { ToolDefinition } from "@ember/core";

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const TERMINAL_TOOL: ToolDefinition = {
  name: "run_terminal_command",
  description:
    "Execute a shell command in a bash terminal and return the combined stdout/stderr output. " +
    "Use this to run scripts, inspect files, install packages, query the system, or anything else " +
    "you'd do in a terminal. Commands run with a 60-second timeout.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute (e.g. 'ls -la', 'cat package.json', 'git status').",
      },
      cwd: {
        type: "string",
        description: "Working directory to run the command in. Defaults to the process working directory.",
      },
    },
    required: ["command"],
  },
};

// ALL_TOOLS is the shared set passed to every role that gets tool access.
export const ALL_TOOLS: ToolDefinition[] = [TERMINAL_TOOL];

// ─── Executor ─────────────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  if (name === "run_terminal_command") {
    return runTerminalCommand(input);
  }
  return `Unknown tool: ${name}`;
}

function runTerminalCommand(input: Record<string, unknown>): string {
  const command = typeof input.command === "string" ? input.command : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;

  if (!command.trim()) {
    return "Error: no command provided.";
  }

  console.log(`[tool:terminal] $ ${command}${cwd ? ` (cwd: ${cwd})` : ""}`);

  const result = spawnSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const lines: string[] = [];

  if (stdout) lines.push(stdout);
  if (stderr) lines.push(stderr);

  const output = lines.join("\n").trim() || "(no output)";

  if (result.error) {
    return `Error: ${result.error.message}\n${output}`;
  }

  if (result.status !== 0) {
    return `Exit code ${result.status ?? "?"}:\n${output}`;
  }

  return output;
}
