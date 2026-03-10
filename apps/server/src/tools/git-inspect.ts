import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { EmberTool } from "./types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_OUTPUT_CHARS = 100_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function resolveWorkingDirectory(inputPath: string): string {
  if (!inputPath.trim()) {
    return process.cwd();
  }

  const resolved = path.resolve(inputPath);
  if (!existsSync(resolved)) {
    return resolved;
  }

  try {
    return statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return resolved;
  }
}

function runGit(args: string[], cwd: string): { ok: boolean; output: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();

  if (result.error) {
    return { ok: false, output: `Error: ${result.error.message}` };
  }

  return {
    ok: result.status === 0,
    output,
  };
}

function formatOutput(output: string): string {
  if (!output) {
    return "(no output)";
  }

  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }

  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated at ${MAX_OUTPUT_CHARS} chars]`;
}

function execute(input: Record<string, unknown>): string {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  const targetPath = typeof input.path === "string" ? input.path : ".";
  const filePath = typeof input.file === "string" ? input.file.trim() : "";
  const rev = typeof input.rev === "string" ? input.rev.trim() : "";
  const staged = input.staged === true;
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? clamp(Math.floor(input.limit), 1, MAX_LIMIT)
      : DEFAULT_LIMIT;

  if (!action) {
    return "Error: action is required. Valid actions: status, diff_stats, diff, log.";
  }

  const cwd = resolveWorkingDirectory(targetPath);
  console.log(`[tool:git_inspect] action="${action}" cwd="${cwd}"`);

  const rootCheck = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!rootCheck.ok) {
    return "Error: not inside a git repository or git is unavailable.";
  }

  const separatorArgs = filePath ? ["--", filePath] : [];
  let result: { ok: boolean; output: string };

  switch (action) {
    case "status":
      result = runGit(["status", "--short", "--branch"], cwd);
      break;
    case "diff_stats":
      result = runGit(["diff", ...(staged ? ["--cached"] : []), "--stat", "--find-renames", ...separatorArgs], cwd);
      break;
    case "diff":
      result = runGit(
        ["diff", ...(staged ? ["--cached"] : []), ...(rev ? [rev] : []), "--find-renames", "--unified=3", ...separatorArgs],
        cwd,
      );
      break;
    case "log":
      result = runGit(["log", "--oneline", "--decorate", `-n${limit}`, ...(rev ? [rev] : [])], cwd);
      break;
    default:
      return `Error: unknown action "${action}". Valid actions: status, diff_stats, diff, log.`;
  }

  if (!result.ok) {
    return result.output || "Error: git command failed.";
  }

  return [
    `Repo: ${rootCheck.output}`,
    `Action: ${action}`,
    filePath ? `File: ${filePath}` : "",
    staged ? "Scope: staged changes" : "",
    rev ? `Revision: ${rev}` : "",
    "",
    formatOutput(result.output),
  ]
    .filter(Boolean)
    .join("\n");
}

export const gitInspectTool: EmberTool = {
  definition: {
    name: "git_inspect",
    description:
      "Inspect git state without using the terminal. Supports status, diff stats, full diff, and recent commits. " +
      "Use this for reviews, regression hunts, change summaries, and before editing in a dirty worktree.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Git action to run: status, diff_stats, diff, or log.",
        },
        path: {
          type: "string",
          description: "Optional repo, directory, or file path used to locate the git repository.",
        },
        file: {
          type: "string",
          description: "Optional file path within the repo to limit diff output.",
        },
        rev: {
          type: "string",
          description: "Optional revision or revision range for diff/log, such as HEAD~1 or main..HEAD.",
        },
        staged: {
          type: "boolean",
          description: "Set to true to inspect staged changes for diff_stats or diff.",
        },
        limit: {
          type: "number",
          description: "Maximum commits to show for log. Default 10, maximum 50.",
        },
      },
      required: ["action"],
    },
  },
  execute,
};
