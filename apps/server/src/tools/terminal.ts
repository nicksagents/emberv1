import { spawn } from "node:child_process";

import type { EmberTool } from "./types.js";

let _sudoPassword = "";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

export function setSudoPassword(password: string) {
  _sudoPassword = password;
}

function appendOutput(current: string, next: string): string {
  if (!next) {
    return current;
  }

  const combined = current + next;
  if (combined.length <= MAX_OUTPUT_CHARS) {
    return combined;
  }

  return combined.slice(combined.length - MAX_OUTPUT_CHARS);
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const command = typeof input.command === "string" ? input.command : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  const requestedTimeout =
    typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
      ? Math.floor(input.timeout_ms)
      : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(1_000, Math.min(requestedTimeout, MAX_TIMEOUT_MS));

  if (!command.trim()) return "Error: no command provided.";

  console.log(`[tool:terminal] $ ${command}${cwd ? ` (cwd: ${cwd})` : ""}`);

  const hasSudo = /\bsudo\b/.test(command);
  const runCommand =
    hasSudo && _sudoPassword
      ? command.replace(/\bsudo\b(?!\s*-S\b)/, "sudo -S")
      : command;

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("bash", ["-lc", runCommand], {
      cwd,
      env: process.env,
      stdio: "pipe",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);

    if (hasSudo && _sudoPassword) {
      child.stdin.write(`${_sudoPassword}\n`);
    }
    child.stdin.end();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim() || "(no output)";
      resolve(`Error: ${error.message}\n${output}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim() || "(no output)";

      if (timedOut) {
        resolve(`Error: command timed out after ${timeoutMs}ms\n${output}`);
        return;
      }

      if (code !== 0) {
        resolve(`Exit code ${code ?? "?"}:\n${output}`);
        return;
      }

      resolve(output);
    });
  });
}

export const terminalTool: EmberTool = {
  definition: {
    name: "run_terminal_command",
    description:
      "Execute a shell command in a bash terminal and return the combined stdout/stderr output. " +
      "Use this to run scripts, install packages, execute git commands, build projects, or any " +
      "shell operation. Commands default to a 120-second timeout and can be extended up to 10 minutes. " +
      "Do not use this to read or write individual files — prefer read_file/write_file/edit_file.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute (e.g. 'ls -la', 'git status', 'npm run build').",
        },
        cwd: {
          type: "string",
          description: "Working directory to run the command in. Defaults to the process working directory.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds (default 120000, maximum 600000).",
        },
      },
      required: ["command"],
    },
  },
  systemPrompt:
    "run_terminal_command — Use for shell tasks such as builds, tests, git, installs, and diagnostics. Prefer a targeted command, increase timeout only when needed, and retry with sudo only when a permission error warrants it.",
  execute,
};
