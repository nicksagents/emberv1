import test from "node:test";
import assert from "node:assert/strict";

import {
  clearParallelTaskTraces,
  executeParallelSubtasks,
  formatParallelResults,
  formatParallelTaskResults,
  getParallelTaskPolicy,
  listParallelTaskTraces,
  MAX_PARALLEL_TASKS,
  parseParallelTaskRequest,
  recordParallelTaskTrace,
  resolveParallelExecutionLimits,
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
      profile: "standard",
    },
    {
      title: "Compare providers",
      task: "Find the best provider lane for coding.",
      role: "auto",
      profile: "standard",
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

  const invalidProfile = parseParallelTaskRequest({
    tasks: [
      {
        title: "Bad profile",
        task: "Inspect logs.",
        profile: "unsafe",
      },
    ],
  }, "coordinator");
  assert.match(invalidProfile.error ?? "", /profile must be/i);
});

test("formatParallelTaskResults returns a compact readable summary", () => {
  const text = formatParallelTaskResults([
    {
      traceId: "ptask_1",
      profile: "investigation",
      title: "Security review",
      requestedRole: "inspector",
      activeRole: "inspector",
      providerName: "Local Qwen",
      modelId: "qwen-32b",
      content: "Found one weak cookie flag and confirmed the rest of the auth flow.",
      error: null,
      startedAt: "2026-03-16T10:00:00.000Z",
      endedAt: "2026-03-16T10:00:01.100Z",
      durationMs: 1_100,
    },
    {
      traceId: "ptask_2",
      profile: "read-only",
      title: "Frontend slice",
      requestedRole: "director",
      activeRole: null,
      providerName: null,
      modelId: null,
      content: "Provider unavailable.",
      error: "Provider unavailable.",
      startedAt: "2026-03-16T10:00:00.000Z",
      endedAt: "2026-03-16T10:00:01.500Z",
      durationMs: 1_500,
    },
  ]);

  assert.match(text, /Parallel Task Results/i);
  assert.match(text, /\[1\] "Security review"/);
  assert.match(text, /Trace: ptask_1/);
  assert.match(text, /Profile: investigation/);
  assert.match(text, /Duration: 1100ms/i);
  assert.match(text, /Role: inspector/);
  assert.match(text, /Provider unavailable/);
});

test("resolveParallelExecutionLimits honors bounded env overrides", () => {
  const limits = resolveParallelExecutionLimits({
    EMBER_PARALLEL_MAX_TASKS: "9",
    EMBER_PARALLEL_MAX_DEPTH: "2",
    EMBER_PARALLEL_MAX_CONCURRENCY: "3",
    EMBER_PARALLEL_CHILD_TIMEOUT_MS: "45000",
  } as NodeJS.ProcessEnv);
  assert.equal(limits.maxTasks, 9);
  assert.equal(limits.maxDepth, 2);
  assert.equal(limits.maxConcurrency, 3);
  assert.equal(limits.childTimeoutMs, 45_000);
});

test("getParallelTaskPolicy derives bounded policy fields", () => {
  const policy = getParallelTaskPolicy({
    EMBER_PARALLEL_MAX_TASKS: "7",
    EMBER_PARALLEL_MAX_DEPTH: "2",
    EMBER_PARALLEL_MAX_CONCURRENCY: "3",
    EMBER_PARALLEL_CHILD_TIMEOUT_MS: "45000",
  } as NodeJS.ProcessEnv);
  assert.equal(policy.maxTasks, 7);
  assert.equal(policy.maxDepth, 2);
  assert.equal(policy.maxConcurrency, 3);
  assert.equal(policy.defaultTimeoutMs, 45_000);
  assert.equal(policy.maxTimeoutMs >= policy.defaultTimeoutMs, true);
});

test("executeParallelSubtasks respects timeout and concurrency bounds", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const results = await executeParallelSubtasks({
    tasks: [
      { title: "A", instruction: "a", role: "coordinator", profile: "standard" },
      { title: "B", instruction: "b", role: "advisor", profile: "read-only" },
      { title: "C", instruction: "c", role: "director", profile: "investigation" },
    ],
    concurrency: 2,
    timeoutMs: 40,
    executeTask: async (task) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (task.title === "C") {
          await new Promise((resolve) => setTimeout(resolve, 80));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          traceId: `trace_${task.title}`,
          title: task.title,
          profile: task.profile,
          requestedRole: task.role,
          activeRole: task.role === "auto" ? null : task.role,
          providerName: "Provider",
          modelId: "model",
          output: `${task.title} done`,
          error: null,
          tokensUsed: 12,
        };
      } finally {
        inFlight -= 1;
      }
    },
  });

  assert.equal(results.length, 3);
  assert.equal(maxInFlight <= 2, true);
  assert.equal(results.some((item) => item.status === "timed_out"), true);
  assert.equal(results.filter((item) => item.status === "completed").length, 2);
});

test("formatParallelResults renders status-oriented summary", () => {
  const text = formatParallelResults([
    {
      traceId: "trace_a",
      title: "Task A",
      profile: "standard",
      requestedRole: "coordinator",
      activeRole: "coordinator",
      providerName: "P1",
      modelId: "m1",
      status: "completed",
      output: "Task A done",
      error: null,
      tokensUsed: 22,
      startedAt: "2026-03-17T10:00:00.000Z",
      endedAt: "2026-03-17T10:00:01.000Z",
      durationMs: 1000,
    },
    {
      traceId: "trace_b",
      title: "Task B",
      profile: "read-only",
      requestedRole: "advisor",
      activeRole: null,
      providerName: null,
      modelId: null,
      status: "timed_out",
      output: "Subtask timed out after 180000ms.",
      error: "Subtask timed out after 180000ms.",
      tokensUsed: 0,
      startedAt: "2026-03-17T10:00:00.000Z",
      endedAt: "2026-03-17T10:03:00.000Z",
      durationMs: 180000,
    },
  ]);
  assert.match(text, /Parallel Task Results/i);
  assert.match(text, /Task A/);
  assert.match(text, /timed out/i);
  assert.match(text, /Tokens: 22/);
});

test("parallel trace buffer records and limits visible child traces", () => {
  clearParallelTaskTraces();
  recordParallelTaskTrace({
    traceId: "ptask_trace_1",
    parentRole: "coordinator",
    parentDepth: 0,
    profile: "standard",
    requestedRole: "advisor",
    activeRole: "advisor",
    providerName: "Local Qwen",
    modelId: "qwen-32b",
    title: "Trace demo",
    status: "ok",
    startedAt: "2026-03-16T10:00:00.000Z",
    endedAt: "2026-03-16T10:00:01.000Z",
    durationMs: 1_000,
    error: null,
  });
  const traces = listParallelTaskTraces(4);
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.traceId, "ptask_trace_1");
});
