import test from "node:test";
import assert from "node:assert/strict";

import { envInt, envFloat, envBool, CONFIG } from "./config.js";

// ─── envInt ──────────────────────────────────────────────────────────────────

test("envInt returns fallback when env var is not set", () => {
  const key = `EMBER_TEST_UNSET_INT_${Date.now()}`;
  delete process.env[key];
  assert.equal(envInt(key, 42), 42);
});

test("envInt parses a valid integer from env", () => {
  const key = `EMBER_TEST_INT_${Date.now()}`;
  process.env[key] = "100";
  try {
    assert.equal(envInt(key, 42), 100);
  } finally {
    delete process.env[key];
  }
});

test("envInt clamps to min boundary", () => {
  const key = `EMBER_TEST_INT_MIN_${Date.now()}`;
  process.env[key] = "0";
  try {
    assert.equal(envInt(key, 50, { min: 10 }), 10);
  } finally {
    delete process.env[key];
  }
});

test("envInt clamps to max boundary", () => {
  const key = `EMBER_TEST_INT_MAX_${Date.now()}`;
  process.env[key] = "999";
  try {
    assert.equal(envInt(key, 50, { min: 1, max: 100 }), 100);
  } finally {
    delete process.env[key];
  }
});

test("envInt returns fallback for non-numeric string", () => {
  const key = `EMBER_TEST_INT_NAN_${Date.now()}`;
  process.env[key] = "not_a_number";
  try {
    assert.equal(envInt(key, 77), 77);
  } finally {
    delete process.env[key];
  }
});

test("envInt trims whitespace from value", () => {
  const key = `EMBER_TEST_INT_TRIM_${Date.now()}`;
  process.env[key] = "  25  ";
  try {
    assert.equal(envInt(key, 0), 25);
  } finally {
    delete process.env[key];
  }
});

test("envInt clamps fallback to min when env var is unset", () => {
  const key = `EMBER_TEST_INT_FALLBACK_CLAMP_${Date.now()}`;
  delete process.env[key];
  // fallback 0 should be clamped to min 5
  assert.equal(envInt(key, 0, { min: 5 }), 5);
});

// ─── envFloat ────────────────────────────────────────────────────────────────

test("envFloat returns fallback when env var is not set", () => {
  const key = `EMBER_TEST_UNSET_FLOAT_${Date.now()}`;
  delete process.env[key];
  assert.equal(envFloat(key, 0.5), 0.5);
});

test("envFloat parses a valid float from env", () => {
  const key = `EMBER_TEST_FLOAT_${Date.now()}`;
  process.env[key] = "0.75";
  try {
    assert.equal(envFloat(key, 0.5), 0.75);
  } finally {
    delete process.env[key];
  }
});

test("envFloat clamps to min/max boundaries", () => {
  const key = `EMBER_TEST_FLOAT_CLAMP_${Date.now()}`;
  process.env[key] = "0.99";
  try {
    assert.equal(envFloat(key, 0.5, { min: 0.05, max: 0.95 }), 0.95);
  } finally {
    delete process.env[key];
  }
});

test("envFloat returns fallback for Infinity", () => {
  const key = `EMBER_TEST_FLOAT_INF_${Date.now()}`;
  process.env[key] = "Infinity";
  try {
    assert.equal(envFloat(key, 0.4), 0.4);
  } finally {
    delete process.env[key];
  }
});

// ─── envBool ─────────────────────────────────────────────────────────────────

test("envBool returns fallback when env var is not set", () => {
  const key = `EMBER_TEST_UNSET_BOOL_${Date.now()}`;
  delete process.env[key];
  assert.equal(envBool(key, true), true);
  assert.equal(envBool(key, false), false);
});

test("envBool recognizes truthy values", () => {
  const key = `EMBER_TEST_BOOL_TRUE_${Date.now()}`;
  for (const value of ["1", "true", "yes", "on", "TRUE", "Yes", "ON"]) {
    process.env[key] = value;
    assert.equal(envBool(key, false), true, `"${value}" should be truthy`);
  }
  delete process.env[key];
});

test("envBool recognizes falsy values", () => {
  const key = `EMBER_TEST_BOOL_FALSE_${Date.now()}`;
  for (const value of ["0", "false", "no", "off", "FALSE", "No", "OFF"]) {
    process.env[key] = value;
    assert.equal(envBool(key, true), false, `"${value}" should be falsy`);
  }
  delete process.env[key];
});

test("envBool returns fallback for unrecognized string", () => {
  const key = `EMBER_TEST_BOOL_UNK_${Date.now()}`;
  process.env[key] = "maybe";
  try {
    assert.equal(envBool(key, true), true);
    assert.equal(envBool(key, false), false);
  } finally {
    delete process.env[key];
  }
});

// ─── CONFIG object ───────────────────────────────────────────────────────────

test("CONFIG has expected top-level sections", () => {
  const sections = Object.keys(CONFIG);
  for (const expected of [
    "contextWindow", "toolLoop", "parallel", "terminal", "mcp",
    "compaction", "checkpoints", "failover", "network", "prompt",
    "request", "memory", "audit",
  ]) {
    assert.ok(sections.includes(expected), `CONFIG should have section "${expected}"`);
  }
});

test("CONFIG defaults are within expected ranges", () => {
  // Context window
  assert.ok(CONFIG.contextWindow.defaultTokens >= 4_000);
  assert.ok(CONFIG.contextWindow.localTokens >= 4_000);

  // Parallel
  assert.ok(CONFIG.parallel.maxTasks >= 1 && CONFIG.parallel.maxTasks <= 12);
  assert.ok(CONFIG.parallel.maxDepth >= 0 && CONFIG.parallel.maxDepth <= 4);
  assert.ok(CONFIG.parallel.maxConcurrency >= 1 && CONFIG.parallel.maxConcurrency <= 8);

  // Compaction thresholds should be ascending
  assert.ok(CONFIG.compaction.stage1 < CONFIG.compaction.stage2);
  assert.ok(CONFIG.compaction.stage2 < CONFIG.compaction.stage3);

  // Network ports
  assert.ok(CONFIG.network.webPort >= 1);
  assert.ok(CONFIG.network.apiPort >= 1);

  // Failover
  assert.ok(CONFIG.failover.circuitBreakerThreshold >= 1);
  assert.ok(CONFIG.failover.circuitBreakerResetMs >= 1_000);
});

test("CONFIG terminal defaults are sane", () => {
  assert.ok(CONFIG.terminal.defaultTimeoutMs >= 1_000);
  assert.ok(CONFIG.terminal.maxTimeoutMs >= CONFIG.terminal.defaultTimeoutMs);
  assert.ok(CONFIG.terminal.maxOutputChars >= 10_000);
  assert.ok(CONFIG.terminal.sudoTtlMs >= 30_000);
  assert.ok(CONFIG.terminal.approvalTtlMs >= 30_000);
});
