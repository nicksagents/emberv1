import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_FILE_NAMES = new Set(["server.log", "web.log"]);

export interface GitUpstream {
  remote: string;
  branchName: string;
  remoteRef: string;
}

export interface UpdateResult {
  hadLocalChanges: boolean;
  preservedPaths: string[];
  stashed: boolean;
  upstream: string;
}

export interface UpdateOptions {
  log?: (message: string) => void;
  runInstall?: () => void;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio?: "inherit" | "pipe";
  },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function ensureGitRepository(repoRoot: string): void {
  const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
  });

  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error("Ember update requires a git checkout.");
  }
}

function ensureNoGitOperationInProgress(repoRoot: string): void {
  const conflicts = runCommand("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: repoRoot,
  });

  if (conflicts.status === 0 && conflicts.stdout.trim()) {
    throw new Error("Resolve existing git merge conflicts before running ember update.");
  }

  for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    const result = runCommand("git", ["rev-parse", "-q", "--verify", ref], {
      cwd: repoRoot,
    });
    if (result.status === 0) {
      throw new Error("Finish the current git merge or rebase before running ember update.");
    }
  }
}

function commandFailedMessage(action: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `${action}\n${detail}` : action;
}

function runGitOrThrow(
  repoRoot: string,
  args: string[],
  action: string,
  options: {
    stdio?: "inherit" | "pipe";
  } = {},
): CommandResult {
  const result = runCommand("git", args, {
    cwd: repoRoot,
    stdio: options.stdio,
  });

  if (result.status !== 0) {
    throw new Error(commandFailedMessage(action, result));
  }

  return result;
}

function hasLocalChanges(repoRoot: string): boolean {
  const result = runGitOrThrow(repoRoot, ["status", "--short"], "Unable to inspect git status.");
  return result.stdout.trim().length > 0;
}

export function listPreservedWorkspacePaths(repoRoot: string): string[] {
  const preserved = new Set<string>();
  const dotEnvPath = path.join(repoRoot, ".env");
  if (existsSync(dotEnvPath) && statSync(dotEnvPath).isFile()) {
    preserved.add(".env");
  }

  const dataRoot = path.join(repoRoot, "data");
  if (existsSync(dataRoot) && statSync(dataRoot).isDirectory()) {
    for (const entry of readdirSync(dataRoot).sort()) {
      const absolutePath = path.join(dataRoot, entry);
      if (!statSync(absolutePath).isFile() || LOG_FILE_NAMES.has(entry)) {
        continue;
      }
      preserved.add(path.posix.join("data", entry));
    }
  }

  return [...preserved].sort();
}

function backupWorkspacePaths(repoRoot: string, relativePaths: string[]): string {
  const backupRoot = mkdtempSync(path.join(os.tmpdir(), "ember-update-"));

  for (const relativePath of relativePaths) {
    const source = path.join(repoRoot, relativePath);
    if (!existsSync(source) || !statSync(source).isFile()) {
      continue;
    }

    const target = path.join(backupRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  return backupRoot;
}

function restoreWorkspacePaths(repoRoot: string, backupRoot: string, relativePaths: string[]): void {
  for (const relativePath of relativePaths) {
    const source = path.join(backupRoot, relativePath);
    if (!existsSync(source) || !statSync(source).isFile()) {
      continue;
    }

    const target = path.join(repoRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

export function listTrackedWorkspacePaths(repoRoot: string, relativePaths: string[]): string[] {
  if (relativePaths.length === 0) {
    return [];
  }

  const result = runGitOrThrow(
    repoRoot,
    ["ls-files", "--", ...relativePaths],
    "Unable to list tracked Ember state files.",
  );

  return result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function restoreTrackedWorkspacePaths(repoRoot: string, relativePaths: string[]): void {
  if (relativePaths.length === 0) {
    return;
  }

  runGitOrThrow(
    repoRoot,
    ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...relativePaths],
    "Unable to protect local Ember state before updating.",
  );
}

export function resolveGitUpstream(repoRoot: string): GitUpstream {
  const currentBranch = runGitOrThrow(
    repoRoot,
    ["branch", "--show-current"],
    "Unable to determine the current git branch.",
  ).stdout.trim();

  if (!currentBranch) {
    throw new Error("Ember update requires a checked out git branch.");
  }

  const remoteResult = runCommand("git", ["config", "--get", `branch.${currentBranch}.remote`], {
    cwd: repoRoot,
  });
  const mergeResult = runCommand("git", ["config", "--get", `branch.${currentBranch}.merge`], {
    cwd: repoRoot,
  });

  const remote = remoteResult.stdout.trim();
  const mergeRef = mergeResult.stdout.trim();
  if (remoteResult.status === 0 && mergeResult.status === 0 && remote && mergeRef.startsWith("refs/heads/")) {
    const branchName = mergeRef.slice("refs/heads/".length);
    return {
      remote,
      branchName,
      remoteRef: `${remote}/${branchName}`,
    };
  }

  const upstream = runGitOrThrow(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    "No upstream branch is configured for this checkout.",
  ).stdout.trim();
  const separatorIndex = upstream.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstream.length - 1) {
    throw new Error(`Unable to resolve the upstream ref for ${currentBranch}.`);
  }

  return {
    remote: upstream.slice(0, separatorIndex),
    branchName: upstream.slice(separatorIndex + 1),
    remoteRef: upstream,
  };
}

function runDefaultInstall(repoRoot: string): void {
  const installScript = path.join(repoRoot, "scripts", "install.sh");
  const result = runCommand("bash", [installScript], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Install steps failed after updating Ember.");
  }
}

export function runUpdate(repoRoot: string, options: UpdateOptions = {}): UpdateResult {
  const log = options.log ?? ((message: string) => console.log(message));
  const runInstall = options.runInstall ?? (() => runDefaultInstall(repoRoot));

  ensureGitRepository(repoRoot);
  ensureNoGitOperationInProgress(repoRoot);

  const preservedPaths = listPreservedWorkspacePaths(repoRoot);
  const backupRoot = backupWorkspacePaths(repoRoot, preservedPaths);
  const trackedPreservedPaths = listTrackedWorkspacePaths(repoRoot, preservedPaths);
  const upstream = resolveGitUpstream(repoRoot);

  let stashed = false;
  let stashRestored = true;
  let hadLocalChanges = false;

  try {
    if (trackedPreservedPaths.length > 0) {
      log("Protecting local Ember state...");
      restoreTrackedWorkspacePaths(repoRoot, trackedPreservedPaths);
    }

    hadLocalChanges = hasLocalChanges(repoRoot);
    if (hadLocalChanges) {
      log("Stashing local code changes...");
      runGitOrThrow(
        repoRoot,
        [
          "stash",
          "push",
          "--include-untracked",
          "--message",
          `ember-update-${new Date().toISOString()}`,
        ],
        "Unable to stash local changes before updating.",
      );
      stashed = true;
      stashRestored = false;
    }

    log(`Fetching ${upstream.remoteRef}...`);
    runGitOrThrow(
      repoRoot,
      ["fetch", "--prune", upstream.remote, upstream.branchName],
      `Unable to fetch ${upstream.remoteRef}.`,
      { stdio: "inherit" },
    );

    log(`Rebasing onto ${upstream.remoteRef}...`);
    runGitOrThrow(
      repoRoot,
      ["rebase", upstream.remoteRef],
      `Unable to rebase onto ${upstream.remoteRef}.`,
      { stdio: "inherit" },
    );

    if (stashed) {
      log("Reapplying local code changes...");
      const stashPop = runCommand("git", ["stash", "pop"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      if (stashPop.status !== 0) {
        throw new Error(
          "Updated code was pulled, but reapplying local changes produced git conflicts. " +
          "Resolve them and rerun ember update if you still need the install step.",
        );
      }
      stashRestored = true;
    }

    restoreWorkspacePaths(repoRoot, backupRoot, preservedPaths);

    log("Running Ember install and bootstrap steps...");
    runInstall();

    return {
      hadLocalChanges,
      preservedPaths,
      stashed,
      upstream: upstream.remoteRef,
    };
  } catch (error) {
    restoreWorkspacePaths(repoRoot, backupRoot, preservedPaths);
    if (error instanceof Error && stashed && !stashRestored) {
      throw new Error(
        `${error.message} Your local code changes are still available in git stash.`,
      );
    }
    throw error;
  } finally {
    rmSync(backupRoot, { recursive: true, force: true });
  }
}
