import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

import { terminalTool } from "./tools/terminal.js";

async function runTerminal(
  sessionKey: string,
  input: Record<string, unknown>,
): Promise<string> {
  const result = await terminalTool.execute({
    ...input,
    __sessionKey: sessionKey,
  });

  if (typeof result !== "string") {
    throw new Error("Expected terminal tool to return text.");
  }
  return result;
}

test("terminal session preserves working directory across calls", async () => {
  const sessionKey = `terminal-test-cwd-${Date.now()}`;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ember-terminal-"));

  try {
    await runTerminal(sessionKey, { command: `cd ${JSON.stringify(tempDir)}` });
    const pwd = await runTerminal(sessionKey, { command: "pwd" });
    assert.equal(pwd.trim(), tempDir);
  } finally {
    await runTerminal(sessionKey, { session_action: "reset" });
  }
});

test("terminal session preserves exports across calls and reset clears them", async () => {
  const sessionKey = `terminal-test-env-${Date.now()}`;

  try {
    await runTerminal(sessionKey, { command: "export EMBER_TEST_VALUE=persistent-shell" });
    const envValue = await runTerminal(sessionKey, { command: 'printf "%s" "$EMBER_TEST_VALUE"' });
    assert.equal(envValue, "persistent-shell");
  } finally {
    await runTerminal(sessionKey, { session_action: "reset" });
  }

  const afterReset = await runTerminal(sessionKey, { command: 'printf "%s" "$EMBER_TEST_VALUE"' });
  assert.equal(afterReset, "(no output)");
  await runTerminal(sessionKey, { session_action: "reset" });
});
