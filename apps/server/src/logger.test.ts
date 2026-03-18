import test from "node:test";
import assert from "node:assert/strict";

import { createRequestLogger } from "./logger.js";

test("createRequestLogger returns a logger with the correct requestId", () => {
  const logger = createRequestLogger("req_123");
  assert.equal(logger.requestId, "req_123");
});

test("logger info emits structured JSON to console.log", (t) => {
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(String(args[0]));
  };
  t.after(() => {
    console.log = originalLog;
  });

  const logger = createRequestLogger("req_info_test");
  logger.info("request started", { method: "POST", path: "/api/chat" });

  assert.equal(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.requestId, "req_info_test");
  assert.equal(parsed.msg, "request started");
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.path, "/api/chat");
  assert.ok(typeof parsed.ts === "number", "should include numeric timestamp");
});

test("logger warn emits structured JSON to console.warn", (t) => {
  const captured: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    captured.push(String(args[0]));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const logger = createRequestLogger("req_warn_test");
  logger.warn("slow response", { durationMs: 5000 });

  assert.equal(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.requestId, "req_warn_test");
  assert.equal(parsed.msg, "slow response");
  assert.equal(parsed.durationMs, 5000);
});

test("logger error emits structured JSON to console.error", (t) => {
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(String(args[0]));
  };
  t.after(() => {
    console.error = originalError;
  });

  const logger = createRequestLogger("req_error_test");
  logger.error("provider timeout", { provider: "anthropic" });

  assert.equal(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, "error");
  assert.equal(parsed.requestId, "req_error_test");
  assert.equal(parsed.msg, "provider timeout");
  assert.equal(parsed.provider, "anthropic");
});

test("logger works without optional data parameter", (t) => {
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(String(args[0]));
  };
  t.after(() => {
    console.log = originalLog;
  });

  const logger = createRequestLogger("req_no_data");
  logger.info("simple message");

  assert.equal(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "simple message");
  // Should not have extra fields beyond level, requestId, msg, ts
  const keys = Object.keys(parsed);
  assert.deepEqual(keys.sort(), ["level", "msg", "requestId", "ts"]);
});

test("each logger instance maintains its own requestId", () => {
  const loggerA = createRequestLogger("req_a");
  const loggerB = createRequestLogger("req_b");
  assert.equal(loggerA.requestId, "req_a");
  assert.equal(loggerB.requestId, "req_b");
  assert.notEqual(loggerA.requestId, loggerB.requestId);
});
