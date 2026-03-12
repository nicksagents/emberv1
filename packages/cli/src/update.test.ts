import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  listPreservedWorkspacePaths,
  listTrackedWorkspacePaths,
  resolveGitUpstream,
  runUpdate,
} from "./update.js";

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}\n${result.stderr || result.stdout}`,
    );
  }

  return result.stdout.trim();
}

function writeFile(target: string, contents: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function configureGitRepo(repoRoot: string): void {
  run("git", ["config", "user.name", "Ember Test"], repoRoot);
  run("git", ["config", "user.email", "ember@example.com"], repoRoot);
}

function createRemoteFixture(): {
  origin: string;
  updater: string;
  work: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "ember-update-fixture-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  const updater = path.join(root, "updater");

  mkdirSync(seed, { recursive: true });
  run("git", ["init", "--bare", origin], root);
  run("git", ["init", "--initial-branch=main"], seed);
  configureGitRepo(seed);

  writeFile(path.join(seed, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFile(path.join(seed, ".env"), "EMBER_WEB_PORT=3000\n");
  writeFile(path.join(seed, "data", "conversations.json"), "[]\n");
  writeFile(path.join(seed, "data", "settings.json"), "{\n  \"themePreference\": \"ember-night\"\n}\n");
  writeFile(path.join(seed, "src.txt"), "base\n");

  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "Initial commit"], seed);
  run("git", ["remote", "add", "origin", origin], seed);
  run("git", ["push", "-u", "origin", "main"], seed);

  run("git", ["clone", "--branch", "main", origin, work], root);
  run("git", ["clone", "--branch", "main", origin, updater], root);
  configureGitRepo(work);
  configureGitRepo(updater);

  return { origin, updater, work };
}

test("listPreservedWorkspacePaths includes local state and excludes logs", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "ember-update-paths-"));

  writeFile(path.join(repoRoot, ".env"), "EMBER_RUNTIME_PORT=3005\n");
  writeFile(path.join(repoRoot, "data", "conversations.json"), "[]\n");
  writeFile(path.join(repoRoot, "data", "provider-secrets.json"), "{}\n");
  writeFile(path.join(repoRoot, "data", "server.log"), "ignore me\n");

  assert.deepEqual(listPreservedWorkspacePaths(repoRoot), [
    ".env",
    "data/conversations.json",
    "data/provider-secrets.json",
  ]);
});

test("resolveGitUpstream and tracked state discovery use the active branch config", () => {
  const { work } = createRemoteFixture();

  writeFile(path.join(work, "data", "provider-secrets.json"), "{\"token\":\"secret\"}\n");

  assert.deepEqual(resolveGitUpstream(work), {
    remote: "origin",
    branchName: "main",
    remoteRef: "origin/main",
  });
  assert.deepEqual(listTrackedWorkspacePaths(work, listPreservedWorkspacePaths(work)), [
    ".env",
    "data/conversations.json",
    "data/settings.json",
  ]);
});

test("runUpdate preserves Ember state while pulling remote changes and reapplying local code changes", () => {
  const { updater, work } = createRemoteFixture();

  writeFile(path.join(work, ".env"), "EMBER_WEB_PORT=4010\n");
  writeFile(path.join(work, "data", "conversations.json"), "[{\"id\":\"chat_local\"}]\n");
  writeFile(path.join(work, "data", "provider-secrets.json"), "{\"token\":\"local-secret\"}\n");
  writeFile(path.join(work, "src.txt"), "base\nlocal change\n");

  writeFile(path.join(updater, "remote.txt"), "from remote\n");
  run("git", ["add", "remote.txt"], updater);
  run("git", ["commit", "-m", "Remote update"], updater);
  run("git", ["push", "origin", "main"], updater);

  let installRan = false;
  const result = runUpdate(work, {
    log: () => {},
    runInstall: () => {
      installRan = true;
    },
  });

  assert.equal(installRan, true);
  assert.equal(result.upstream, "origin/main");
  assert.equal(result.stashed, true);
  assert.equal(readFileSync(path.join(work, ".env"), "utf8"), "EMBER_WEB_PORT=4010\n");
  assert.equal(
    readFileSync(path.join(work, "data", "conversations.json"), "utf8"),
    "[{\"id\":\"chat_local\"}]\n",
  );
  assert.equal(
    readFileSync(path.join(work, "data", "provider-secrets.json"), "utf8"),
    "{\"token\":\"local-secret\"}\n",
  );
  assert.equal(readFileSync(path.join(work, "src.txt"), "utf8"), "base\nlocal change\n");
  assert.equal(readFileSync(path.join(work, "remote.txt"), "utf8"), "from remote\n");
});

test("runUpdate restores preserved Ember state even when install steps fail", () => {
  const { updater, work } = createRemoteFixture();

  writeFile(path.join(work, ".env"), "EMBER_RUNTIME_PORT=4444\n");
  writeFile(path.join(work, "data", "conversations.json"), "[{\"id\":\"chat_fail\"}]\n");

  writeFile(path.join(updater, "remote.txt"), "from remote\n");
  run("git", ["add", "remote.txt"], updater);
  run("git", ["commit", "-m", "Remote update"], updater);
  run("git", ["push", "origin", "main"], updater);

  assert.throws(
    () =>
      runUpdate(work, {
        log: () => {},
        runInstall: () => {
          throw new Error("boom");
        },
      }),
    /boom/,
  );

  assert.equal(readFileSync(path.join(work, ".env"), "utf8"), "EMBER_RUNTIME_PORT=4444\n");
  assert.equal(
    readFileSync(path.join(work, "data", "conversations.json"), "utf8"),
    "[{\"id\":\"chat_fail\"}]\n",
  );
  assert.equal(readFileSync(path.join(work, "remote.txt"), "utf8"), "from remote\n");
});
