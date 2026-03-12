import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { EmberTool } from "./types.js";

const ENTRY_LIMIT = 20;
const SCRIPT_LIMIT = 20;
const PACKAGE_LIMIT = 12;

interface RootPackageInfo {
  name: string | null;
  packageManager: string | null;
  scripts: string[];
  workspaces: string[];
}

function formatPath(inputPath: string): string {
  try {
    return path.resolve(inputPath);
  } catch {
    return inputPath;
  }
}

function parseJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function runGit(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return (result.stdout ?? "").trim();
}

function getGitInfo(rootPath: string): { root: string | null; branch: string | null; statusSummary: string[] } {
  const gitRoot = runGit(["rev-parse", "--show-toplevel"], rootPath);
  if (!gitRoot) {
    return { root: null, branch: null, statusSummary: [] };
  }

  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], gitRoot);
  const status = runGit(["status", "--short", "--branch"], gitRoot) ?? "";
  const statusLines = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 12);

  return {
    root: gitRoot,
    branch,
    statusSummary: statusLines,
  };
}

function collectTopEntries(rootPath: string): string[] {
  try {
    return readdirSync(rootPath, { withFileTypes: true })
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      })
      .slice(0, ENTRY_LIMIT)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

function readRootPackageInfo(rootPath: string): RootPackageInfo | null {
  const packageJsonPath = path.join(rootPath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  const pkg = parseJsonFile<Record<string, unknown>>(packageJsonPath);
  if (!pkg) {
    return null;
  }

  const scripts =
    pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
      ? Object.keys(pkg.scripts as Record<string, unknown>).slice(0, SCRIPT_LIMIT)
      : [];
  const workspaces = Array.isArray(pkg.workspaces)
    ? pkg.workspaces.filter((value): value is string => typeof value === "string")
    : pkg.workspaces &&
        typeof pkg.workspaces === "object" &&
        !Array.isArray(pkg.workspaces) &&
        Array.isArray((pkg.workspaces as { packages?: unknown[] }).packages)
      ? (pkg.workspaces as { packages: unknown[] }).packages.filter((value): value is string => typeof value === "string")
      : [];

  return {
    name: typeof pkg.name === "string" ? pkg.name : null,
    packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager : null,
    scripts,
    workspaces,
  };
}

function collectWorkspacePackageNames(rootPath: string): string[] {
  const candidateParents = ["apps", "packages", "services", "libs", "tools"];
  const results: string[] = [];

  for (const parent of candidateParents) {
    const parentPath = path.join(rootPath, parent);
    if (!existsSync(parentPath)) {
      continue;
    }

    let entries: string[] = [];
    try {
      entries = readdirSync(parentPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= PACKAGE_LIMIT) {
        return results;
      }

      const packageJsonPath = path.join(parentPath, entry, "package.json");
      if (!existsSync(packageJsonPath)) {
        continue;
      }

      const pkg = parseJsonFile<Record<string, unknown>>(packageJsonPath);
      const packageName = typeof pkg?.name === "string" ? pkg.name : `${parent}/${entry}`;
      results.push(`${packageName} (${parent}/${entry})`);
    }
  }

  return results;
}

function detectProjectMarkers(rootPath: string): string[] {
  const markers = [
    "pnpm-workspace.yaml",
    "turbo.json",
    "nx.json",
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "docker-compose.yml",
    "Dockerfile",
  ];

  return markers.filter((marker) => existsSync(path.join(rootPath, marker)));
}

function execute(input: Record<string, unknown>): string {
  const targetPath = typeof input.path === "string" && input.path.trim() ? input.path.trim() : ".";

  console.log(`[tool:project_overview] ${targetPath}`);

  let rootStats;
  try {
    rootStats = statSync(targetPath);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const rootPath = rootStats.isDirectory() ? targetPath : path.dirname(targetPath);
  const resolvedRoot = formatPath(rootPath);
  const gitInfo = getGitInfo(rootPath);
  const topEntries = collectTopEntries(rootPath);
  const rootPackage = readRootPackageInfo(rootPath);
  const workspacePackages = collectWorkspacePackageNames(rootPath);
  const markers = detectProjectMarkers(rootPath);

  const lines = [
    `Path: ${resolvedRoot}`,
    gitInfo.root ? `Git root: ${formatPath(gitInfo.root)}` : "Git root: none detected",
    gitInfo.branch ? `Git branch: ${gitInfo.branch}` : "",
    markers.length ? `Project markers: ${markers.join(", ")}` : "",
    rootPackage?.name ? `Root package: ${rootPackage.name}` : "",
    rootPackage?.packageManager ? `Package manager: ${rootPackage.packageManager}` : "",
    rootPackage?.scripts?.length ? `Root scripts: ${rootPackage.scripts.join(", ")}` : "",
    rootPackage?.workspaces?.length ? `Workspace globs: ${rootPackage.workspaces.join(", ")}` : "",
    topEntries.length ? `Top entries: ${topEntries.join(", ")}` : "",
    gitInfo.statusSummary.length ? `Git status:\n${gitInfo.statusSummary.join("\n")}` : "",
    workspacePackages.length ? `Workspace packages:\n${workspacePackages.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean);

  return lines.join("\n\n");
}

export const projectOverviewTool: EmberTool = {
  definition: {
    name: "project_overview",
    description:
      "Summarize a local project or repo: root path, git branch/status, top-level structure, package manager, scripts, and detected workspace packages. " +
      "Use this first when entering an unfamiliar codebase so you can orient yourself before searching files or running commands.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional absolute or relative file or directory path to inspect. Defaults to the current workspace/project root.",
        },
      },
    },
  },
  execute,
};
