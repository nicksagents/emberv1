import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import type { EmberTool } from "./types.js";
import {
  createToolTool,
  resolveCustomToolMemoryMb,
  resolveCustomToolTimeoutMs,
  setToolMakerContext,
} from "./tool-maker.js";

function expectText(result: unknown): string {
  if (typeof result !== "string") {
    throw new Error("Expected tool result to be text.");
  }
  return result;
}

async function withMakerContext(
  fn: (context: { dir: string; registered: Map<string, EmberTool> }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ember-tool-maker-"));
  const registered = new Map<string, EmberTool>();
  setToolMakerContext({
    workspaceDir: dir,
    registerCustomTool: (tool) => {
      registered.set(tool.definition.name, tool);
    },
    unregisterCustomTool: (name) => {
      registered.delete(name);
    },
  });

  try {
    await fn({ dir, registered });
  } finally {
    setToolMakerContext({
      workspaceDir: process.cwd(),
      registerCustomTool: () => {},
      unregisterCustomTool: () => {},
    });
    await rm(dir, { recursive: true, force: true });
  }
}

test("create_tool rejects forbidden code patterns", async () => {
  await withMakerContext(async () => {
    const result = expectText(await createToolTool.execute({
      action: "create",
      name: "forbidden_fs",
      description: "attempts forbidden fs access",
      code: "const fs = require('node:fs'); return fs.readdirSync('.').join(',');",
      scope: "project",
    }));
    assert.match(result, /forbidden pattern/i);
  });
});

test("custom tool executor times out runaway code", async () => {
  const previousTimeout = process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS;
  process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS = "150";

  try {
    await withMakerContext(async ({ registered }) => {
      const created = expectText(await createToolTool.execute({
        action: "create",
        name: "runaway_timeout",
        description: "loops forever",
        code: "while (true) {}",
        scope: "project",
      }));
      assert.match(created, /Created custom tool "custom__runaway_timeout"/i);

      const runtimeTool = registered.get("custom__runaway_timeout");
      assert.ok(runtimeTool, "expected custom tool to be registered");
      const result = expectText(await runtimeTool!.execute({}));
      assert.match(result, /timed out/i);
    });
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS;
    } else {
      process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS = previousTimeout;
    }
  }
});

test("tool-maker timeout and memory limit parsing uses bounded values", () => {
  const previousTimeout = process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS;
  const previousMemory = process.env.EMBER_CUSTOM_TOOL_MEMORY_MB;

  try {
    process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS = "1";
    process.env.EMBER_CUSTOM_TOOL_MEMORY_MB = "8";
    assert.equal(resolveCustomToolTimeoutMs(), 100);
    assert.equal(resolveCustomToolMemoryMb(), 32);

    process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS = "999999";
    process.env.EMBER_CUSTOM_TOOL_MEMORY_MB = "999999";
    assert.equal(resolveCustomToolTimeoutMs(), 120_000);
    assert.equal(resolveCustomToolMemoryMb(), 1024);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS;
    } else {
      process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS = previousTimeout;
    }
    if (previousMemory === undefined) {
      delete process.env.EMBER_CUSTOM_TOOL_MEMORY_MB;
    } else {
      process.env.EMBER_CUSTOM_TOOL_MEMORY_MB = previousMemory;
    }
  }
});
