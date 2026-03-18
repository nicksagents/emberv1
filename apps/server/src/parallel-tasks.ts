import type { Role } from "@ember/core";
import { CONFIG } from "./config.js";

export const MAX_PARALLEL_TASKS = CONFIG.parallel.maxTasks;
const MAX_PARALLEL_DEPTH = CONFIG.parallel.maxDepth;
const MAX_PARALLEL_CONCURRENCY = CONFIG.parallel.maxConcurrency;
const MAX_PARALLEL_CHILD_TIMEOUT_MS = CONFIG.parallel.taskTimeoutMs;
const MIN_PARALLEL_CHILD_TIMEOUT_MS = CONFIG.parallel.minTaskTimeoutMs;
const DEFAULT_PARALLEL_CHILD_TIMEOUT_MS = CONFIG.parallel.defaultTaskTimeoutMs;
const MAX_PARALLEL_TRACE_COUNT = CONFIG.parallel.maxTraceCount;

export type ParallelTaskToolProfile = "standard" | "read-only" | "investigation" | "swarm-agent";

export interface ParallelTaskSpec {
  title: string;
  task: string;
  role: Role | "auto";
  profile: ParallelTaskToolProfile;
}

export interface ParallelTaskParseResult {
  tasks: ParallelTaskSpec[];
  error: string | null;
}

export interface ParallelTaskOutcome {
  traceId: string;
  profile: ParallelTaskToolProfile;
  title: string;
  requestedRole: Role | "auto";
  activeRole: Role | null;
  providerName: string | null;
  modelId: string | null;
  content: string;
  error: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface ParallelTaskTrace {
  traceId: string;
  parentRole: Role;
  parentDepth: number;
  profile: ParallelTaskToolProfile;
  requestedRole: Role | "auto";
  activeRole: Role | null;
  providerName: string | null;
  modelId: string | null;
  title: string;
  status: "ok" | "error";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error: string | null;
}

export interface ParallelExecutionLimits {
  maxTasks: number;
  maxDepth: number;
  maxConcurrency: number;
  childTimeoutMs: number;
}

export interface ParallelTaskPolicy {
  maxTasks: number;
  maxDepth: number;
  maxConcurrency: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  minTimeoutMs: number;
}

export interface ParallelSubtaskInput {
  title: string;
  instruction: string;
  role: Role | "auto";
  profile: ParallelTaskToolProfile;
}

export type ParallelSubtaskStatus = "completed" | "failed" | "timed_out";

export interface ParallelSubtaskResult {
  traceId: string;
  title: string;
  profile: ParallelTaskToolProfile;
  requestedRole: Role | "auto";
  activeRole: Role | null;
  providerName: string | null;
  modelId: string | null;
  status: ParallelSubtaskStatus;
  output: string;
  error: string | null;
  tokensUsed: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface ExecuteParallelSubtasksOptions {
  tasks: ParallelSubtaskInput[];
  concurrency: number;
  timeoutMs: number;
  executeTask: (task: ParallelSubtaskInput, index: number) => Promise<Omit<ParallelSubtaskResult, "status" | "startedAt" | "endedAt" | "durationMs">>;
  onTaskStart?: (task: ParallelSubtaskInput, index: number) => void;
  onTaskEnd?: (result: ParallelSubtaskResult, index: number) => void;
}

const VALID_TASK_ROLES = new Set<Role | "auto">([
  "auto",
  "coordinator",
  "advisor",
  "director",
  "inspector",
  "ops",
  "dispatch",
]);
const VALID_TOOL_PROFILES = new Set<ParallelTaskToolProfile>([
  "standard",
  "read-only",
  "investigation",
  "swarm-agent",
]);
const parallelTaskTraces: ParallelTaskTrace[] = [];

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTaskRole(value: unknown, defaultRole: Role): Role | "auto" | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return defaultRole;
  }
  return VALID_TASK_ROLES.has(normalized as Role | "auto")
    ? (normalized as Role | "auto")
    : null;
}

function normalizeTaskProfile(value: unknown): ParallelTaskToolProfile | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return "standard";
  }
  return VALID_TOOL_PROFILES.has(normalized as ParallelTaskToolProfile)
    ? (normalized as ParallelTaskToolProfile)
    : null;
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseEnvBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

function createTraceId(): string {
  return `ptask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveParallelExecutionLimits(env = process.env): ParallelExecutionLimits {
  const enabled = parseEnvBoolean(env.EMBER_ENABLE_PARALLEL_TASKS);
  if (enabled === false) {
    return {
      maxTasks: 0,
      maxDepth: 0,
      maxConcurrency: 0,
      childTimeoutMs: 0,
    };
  }

  const maxTasks = clampInteger(env.EMBER_PARALLEL_MAX_TASKS, MAX_PARALLEL_TASKS, 1, 12);
  const maxDepth = clampInteger(env.EMBER_PARALLEL_MAX_DEPTH, MAX_PARALLEL_DEPTH, 0, 4);
  const maxConcurrency = clampInteger(env.EMBER_PARALLEL_MAX_CONCURRENCY, MAX_PARALLEL_CONCURRENCY, 1, 8);
  const childTimeoutMs = clampInteger(
    env.EMBER_PARALLEL_CHILD_TIMEOUT_MS,
    DEFAULT_PARALLEL_CHILD_TIMEOUT_MS,
    MIN_PARALLEL_CHILD_TIMEOUT_MS,
    MAX_PARALLEL_CHILD_TIMEOUT_MS,
  );

  return {
    maxTasks,
    maxDepth,
    maxConcurrency,
    childTimeoutMs,
  };
}

export function getParallelTaskPolicy(env = process.env): ParallelTaskPolicy {
  const limits = resolveParallelExecutionLimits(env);
  return {
    maxTasks: limits.maxTasks,
    maxDepth: limits.maxDepth,
    maxConcurrency: limits.maxConcurrency,
    defaultTimeoutMs: limits.childTimeoutMs,
    maxTimeoutMs: MAX_PARALLEL_CHILD_TIMEOUT_MS,
    minTimeoutMs: MIN_PARALLEL_CHILD_TIMEOUT_MS,
  };
}

export function listParallelTaskTraces(limit = 24): ParallelTaskTrace[] {
  return parallelTaskTraces.slice(0, Math.max(1, limit));
}

export function recordParallelTaskTrace(trace: Omit<ParallelTaskTrace, "traceId"> & { traceId?: string }): string {
  const traceId = trace.traceId?.trim() || createTraceId();
  parallelTaskTraces.unshift({
    ...trace,
    traceId,
  });
  if (parallelTaskTraces.length > MAX_PARALLEL_TRACE_COUNT) {
    parallelTaskTraces.length = MAX_PARALLEL_TRACE_COUNT;
  }
  return traceId;
}

export function clearParallelTaskTraces(): void {
  parallelTaskTraces.length = 0;
}

export function parseParallelTaskRequest(
  input: Record<string, unknown>,
  defaultRole: Role,
  options: {
    maxTasks?: number;
  } = {},
): ParallelTaskParseResult {
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  const maxTasks = clampInteger(options.maxTasks, MAX_PARALLEL_TASKS, 1, 12);
  if (rawTasks.length === 0) {
    return {
      tasks: [],
      error: "launch_parallel_tasks requires at least one task.",
    };
  }
  if (rawTasks.length > maxTasks) {
    return {
      tasks: [],
      error: `launch_parallel_tasks accepts at most ${maxTasks} tasks per call.`,
    };
  }

  const tasks: ParallelTaskSpec[] = [];
  for (const rawTask of rawTasks) {
    if (!rawTask || typeof rawTask !== "object") {
      return {
        tasks: [],
        error: "Each parallel task must be an object with title and task fields.",
      };
    }
    const record = rawTask as Record<string, unknown>;
    const title = normalizeText(record.title);
    const task = normalizeText(record.task);
    const role = normalizeTaskRole(record.role, defaultRole);
    const profile = normalizeTaskProfile(record.profile);

    if (!title || !task) {
      return {
        tasks: [],
        error: "Each parallel task must include non-empty title and task fields.",
      };
    }
    if (!role) {
      return {
        tasks: [],
        error: "Parallel task role must be auto, coordinator, advisor, director, inspector, ops, or dispatch.",
      };
    }
    if (!profile) {
      return {
        tasks: [],
        error: "Parallel task profile must be standard, read-only, or investigation.",
      };
    }

    tasks.push({ title, task, role, profile });
  }

  return { tasks, error: null };
}

function summarizeTaskContent(content: string, limit = 1_200): string {
  const normalized = content.replace(/\s+\n/g, "\n").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

async function runWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results: TResult[] = new Array(items.length);
  let cursor = 0;

  async function workerLoop() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: normalizedConcurrency }, () => workerLoop()));
  return results;
}

/**
 * Memory guard: abort parallel tasks if heap usage exceeds threshold.
 * Prevents a runaway subtask from starving the main process.
 */
const HEAP_LIMIT_RATIO = 0.85; // 85% of max heap

function checkMemoryPressure(): boolean {
  const heap = process.memoryUsage();
  // v8.getHeapStatistics() gives heap_size_limit but isn't always available
  // Use a conservative 1.5GB default if we can't detect
  const maxHeap = (globalThis as { __v8_heap_limit?: number }).__v8_heap_limit ?? 1_536 * 1_024 * 1_024;
  return heap.heapUsed / maxHeap > HEAP_LIMIT_RATIO;
}

async function withSubtaskTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: "ok"; value: T } | { kind: "timed_out"; message: string }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let memoryTimer: NodeJS.Timeout | null = null;
  try {
    const winner = await Promise.race([
      task.then((value) => ({ kind: "ok" as const, value })),
      new Promise<{ kind: "timed_out"; message: string }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({
            kind: "timed_out",
            message: `Subtask timed out after ${timeoutMs}ms.`,
          });
        }, timeoutMs);
        // Check memory pressure every 5 seconds during subtask execution
        memoryTimer = setInterval(() => {
          if (checkMemoryPressure()) {
            controller.abort();
            resolve({
              kind: "timed_out",
              message: `Subtask aborted: heap memory pressure exceeded ${Math.round(HEAP_LIMIT_RATIO * 100)}% threshold.`,
            });
          }
        }, 5_000);
      }),
    ]);
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
    if (memoryTimer) clearInterval(memoryTimer);
  }
}

export async function executeParallelSubtasks(
  options: ExecuteParallelSubtasksOptions,
): Promise<ParallelSubtaskResult[]> {
  if (options.tasks.length === 0) {
    return [];
  }

  const outcomes = await runWithConcurrency(options.tasks, options.concurrency, async (task, index) => {
    options.onTaskStart?.(task, index);
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    try {
      const timed = await withSubtaskTimeout(options.executeTask(task, index), options.timeoutMs);
      if (timed.kind === "timed_out") {
        const timedOut: ParallelSubtaskResult = {
          traceId: `ptask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          title: task.title,
          profile: task.profile,
          requestedRole: task.role,
          activeRole: null,
          providerName: null,
          modelId: null,
          status: "timed_out",
          output: timed.message,
          error: timed.message,
          tokensUsed: 0,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedMs),
        };
        options.onTaskEnd?.(timedOut, index);
        return timedOut;
      }

      const completed: ParallelSubtaskResult = {
        ...timed.value,
        status: timed.value.error ? "failed" : "completed",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedMs),
      };
      options.onTaskEnd?.(completed, index);
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Subtask failed.";
      const failed: ParallelSubtaskResult = {
        traceId: `ptask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: task.title,
        profile: task.profile,
        requestedRole: task.role,
        activeRole: null,
        providerName: null,
        modelId: null,
        status: "failed",
        output: message,
        error: message,
        tokensUsed: 0,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedMs),
      };
      options.onTaskEnd?.(failed, index);
      return failed;
    }
  });

  return outcomes;
}

export function formatParallelResults(results: ParallelSubtaskResult[]): string {
  const completedCount = results.filter((result) => result.status === "completed").length;
  const lines = [`## Parallel Task Results (${completedCount}/${results.length} completed)`];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    const statusLabel =
      result.status === "timed_out"
        ? `timed out (${Math.round(result.durationMs / 1000)}s)`
        : result.status;
    lines.push("", `### [${index + 1}] "${result.title}" — ${statusLabel}`);
    lines.push(`Trace: ${result.traceId}`);
    lines.push(`Profile: ${result.profile}`);
    lines.push(`Role: ${result.requestedRole} → ${result.activeRole ?? "n/a"}`);
    lines.push(`Provider/Model: ${result.providerName ?? "n/a"} / ${result.modelId ?? "n/a"}`);
    lines.push(`Tokens: ${result.tokensUsed}`);
    lines.push(`Duration: ${result.durationMs}ms`);
    lines.push(summarizeTaskContent(result.output || result.error || "No output."));
  }
  return lines.join("\n");
}

export function formatParallelTaskResults(outcomes: ParallelTaskOutcome[]): string {
  const translated: ParallelSubtaskResult[] = outcomes.map((outcome) => ({
    traceId: outcome.traceId,
    title: outcome.title,
    profile: outcome.profile,
    requestedRole: outcome.requestedRole,
    activeRole: outcome.activeRole,
    providerName: outcome.providerName,
    modelId: outcome.modelId,
    status: outcome.error ? "failed" : "completed",
    output: outcome.content,
    error: outcome.error,
    tokensUsed: 0,
    startedAt: outcome.startedAt,
    endedAt: outcome.endedAt,
    durationMs: outcome.durationMs,
  }));
  return formatParallelResults(translated);
}
