import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { appendNodeOption, buildRuntimeEnv, ensureLocalEnvFile, hasManagedRuntime, resolveEmberRoot } from "./runtime.js";

function createWorkspaceFixture(): { root: string; nested: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "ember-cli-workspace-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
  const nested = path.join(root, "apps", "server");
  mkdirSync(nested, { recursive: true });
  return { root, nested };
}

test("resolveEmberRoot prefers an explicit valid EMBER_ROOT", () => {
  const workspace = createWorkspaceFixture();
  const outside = mkdtempSync(path.join(os.tmpdir(), "ember-cli-outside-"));

  assert.equal(resolveEmberRoot(outside, workspace.root), workspace.root);
});

test("resolveEmberRoot falls back to the nearest workspace root when EMBER_ROOT is invalid", () => {
  const workspace = createWorkspaceFixture();

  assert.equal(resolveEmberRoot(workspace.nested, path.join(workspace.root, "missing")), workspace.root);
});

test("buildRuntimeEnv wires the runtime and web process environment", () => {
  const env = buildRuntimeEnv({
    repoRoot: "/tmp/ember",
    runtimeHost: "0.0.0.0",
    runtimePort: "4010",
    webHost: "127.0.0.1",
    webPort: "4011",
    apiUrl: "http://127.0.0.1:4010",
    env: {
      PATH: process.env.PATH,
      COREPACK_HOME: "/custom/corepack",
    },
  });

  assert.equal(env.EMBER_ROOT, "/tmp/ember");
  assert.equal(env.EMBER_RUNTIME_HOST, "0.0.0.0");
  assert.equal(env.EMBER_RUNTIME_PORT, "4010");
  assert.equal(env.EMBER_WEB_HOST, "127.0.0.1");
  assert.equal(env.EMBER_WEB_PORT, "4011");
  assert.equal(env.NEXT_PUBLIC_API_URL, "http://127.0.0.1:4010");
  assert.equal(env.COREPACK_HOME, "/custom/corepack");
  assert.match(env.NODE_OPTIONS ?? "", /--disable-warning=ExperimentalWarning/);
});

test("hasManagedRuntime returns true when either service pid is present", () => {
  assert.equal(hasManagedRuntime({ serverPid: 123, webPid: null }), true);
  assert.equal(hasManagedRuntime({ serverPid: null, webPid: 456 }), true);
  assert.equal(hasManagedRuntime({ serverPid: null, webPid: null }), false);
});

test("appendNodeOption avoids duplicate flags", () => {
  assert.equal(appendNodeOption("", "--disable-warning=ExperimentalWarning"), "--disable-warning=ExperimentalWarning");
  assert.equal(
    appendNodeOption("--trace-warnings", "--disable-warning=ExperimentalWarning"),
    "--trace-warnings --disable-warning=ExperimentalWarning",
  );
  assert.equal(
    appendNodeOption("--disable-warning=ExperimentalWarning", "--disable-warning=ExperimentalWarning"),
    "--disable-warning=ExperimentalWarning",
  );
});

test("ensureLocalEnvFile copies .env.example only when .env is missing", () => {
  const workspace = createWorkspaceFixture();
  const examplePath = path.join(workspace.root, ".env.example");
  const envPath = path.join(workspace.root, ".env");

  writeFileSync(examplePath, "EMBER_WEB_PORT=3000\n", "utf8");
  ensureLocalEnvFile(workspace.root);
  assert.equal(existsSync(envPath), true);
  assert.equal(readFileSync(envPath, "utf8"), "EMBER_WEB_PORT=3000\n");

  writeFileSync(envPath, "EMBER_WEB_PORT=4010\n", "utf8");
  ensureLocalEnvFile(workspace.root);
  assert.equal(readFileSync(envPath, "utf8"), "EMBER_WEB_PORT=4010\n");
});
