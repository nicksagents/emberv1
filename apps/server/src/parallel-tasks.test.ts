import test from "node:test";
import assert from "node:assert/strict";

import {
  formatParallelTaskResults,
  MAX_PARALLEL_TASKS,
  parseParallelTaskRequest,
} from "./parallel-tasks.js";

test("parseParallelTaskRequest defaults missing roles to the current role", () => {
  const parsed = parseParallelTaskRequest({
    tasks: [
      {
        title: "Review auth",
        task: "Inspect the login flow for security issues.",
      },
      {
        title: "Compare providers",
        task: "Find the best provider lane for coding.",
        role: "auto",
      },
    ],
  }, "inspector");

  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.tasks, [
    {
      title: "Review auth",
      task: "Inspect the login flow for security issues.",
      role: "inspector",
    },
    {
      title: "Compare providers",
      task: "Find the best provider lane for coding.",
      role: "auto",
    },
  ]);
});

test("parseParallelTaskRequest enforces limits and valid roles", () => {
  const tooMany = parseParallelTaskRequest({
    tasks: Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, index) => ({
      title: `Task ${index + 1}`,
      task: "Do the work.",
    })),
  }, "coordinator");
  assert.match(tooMany.error ?? "", /at most/i);

  const invalidRole = parseParallelTaskRequest({
    tasks: [
      {
        title: "Bad role",
        task: "Do the work.",
        role: "captain",
      },
    ],
  }, "coordinator");
  assert.match(invalidRole.error ?? "", /role must be/i);
});

test("formatParallelTaskResults returns a compact readable summary", () => {
  const text = formatParallelTaskResults([
    {
      title: "Security review",
      requestedRole: "inspector",
      activeRole: "inspector",
      providerName: "Local Qwen",
      modelId: "qwen-32b",
      content: "Found one weak cookie flag and confirmed the rest of the auth flow.",
      error: null,
    },
    {
      title: "Frontend slice",
      requestedRole: "director",
      activeRole: null,
      providerName: null,
      modelId: null,
      content: "Provider unavailable.",
      error: "Provider unavailable.",
    },
  ]);

  assert.match(text, /Parallel task results:/);
  assert.match(text, /\[1\] Security review/);
  assert.match(text, /Requested role: inspector/);
  assert.match(text, /Error: Provider unavailable/);
});
