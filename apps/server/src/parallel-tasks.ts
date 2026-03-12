import type { Role } from "@ember/core";

export const MAX_PARALLEL_TASKS = 4;

export interface ParallelTaskSpec {
  title: string;
  task: string;
  role: Role | "auto";
}

export interface ParallelTaskParseResult {
  tasks: ParallelTaskSpec[];
  error: string | null;
}

export interface ParallelTaskOutcome {
  title: string;
  requestedRole: Role | "auto";
  activeRole: Role | null;
  providerName: string | null;
  modelId: string | null;
  content: string;
  error: string | null;
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

export function parseParallelTaskRequest(
  input: Record<string, unknown>,
  defaultRole: Role,
): ParallelTaskParseResult {
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (rawTasks.length === 0) {
    return {
      tasks: [],
      error: "launch_parallel_tasks requires at least one task.",
    };
  }
  if (rawTasks.length > MAX_PARALLEL_TASKS) {
    return {
      tasks: [],
      error: `launch_parallel_tasks accepts at most ${MAX_PARALLEL_TASKS} tasks per call.`,
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

    tasks.push({ title, task, role });
  }

  return { tasks, error: null };
}

function summarizeTaskContent(content: string, limit = 1_200): string {
  const normalized = content.replace(/\s+\n/g, "\n").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function formatParallelTaskResults(outcomes: ParallelTaskOutcome[]): string {
  return [
    "Parallel task results:",
    ...outcomes.map((outcome, index) => [
      "",
      `[${index + 1}] ${outcome.title}`,
      `Requested role: ${outcome.requestedRole}`,
      `Final role: ${outcome.activeRole ?? "n/a"}`,
      `Provider: ${outcome.providerName ?? "n/a"}`,
      `Model: ${outcome.modelId ?? "n/a"}`,
      outcome.error ? `Error: ${outcome.error}` : "Result:",
      summarizeTaskContent(outcome.content || outcome.error || "No output."),
    ].join("\n")),
  ].join("\n");
}
