/**
 * Cron/Scheduling Engine
 *
 * Supports cron expressions for recurring autonomous tasks.
 * Jobs are persisted to disk and executed through the chat pipeline.
 */

import { getDataRoot } from "@ember/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const JOBS_FILE = "scheduled-jobs.json";
const CHECK_INTERVAL_MS = 60_000; // Check every minute

export interface ScheduledJob {
  id: string;
  name: string;
  /** Cron expression: "minute hour day-of-month month day-of-week" */
  schedule: string;
  /** Natural language task description */
  task: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
  lastStatus: "ok" | "error" | null;
  createdAt: string;
  updatedAt: string;
}

export type JobExecutor = (job: ScheduledJob) => Promise<{ ok: boolean; result: string }>;

let jobs: ScheduledJob[] = [];
let checkInterval: NodeJS.Timeout | null = null;
let executor: JobExecutor | null = null;

function getJobsPath(): string {
  return path.join(getDataRoot(), JOBS_FILE);
}

export async function loadScheduledJobs(): Promise<ScheduledJob[]> {
  try {
    const raw = await readFile(getJobsPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      jobs = parsed.filter(isValidJob);
    }
  } catch {
    jobs = [];
  }
  return jobs;
}

async function saveJobs(): Promise<void> {
  try {
    const jobsPath = getJobsPath();
    await mkdir(path.dirname(jobsPath), { recursive: true });
    await writeFile(jobsPath, JSON.stringify(jobs, null, 2), "utf8");
  } catch {
    // Best-effort
  }
}

function isValidJob(value: unknown): value is ScheduledJob {
  if (!value || typeof value !== "object") return false;
  const j = value as Record<string, unknown>;
  return typeof j.id === "string" && typeof j.name === "string"
    && typeof j.schedule === "string" && typeof j.task === "string"
    && typeof j.enabled === "boolean";
}

export function getScheduledJobs(): ReadonlyArray<ScheduledJob> {
  return jobs;
}

export async function createScheduledJob(
  input: Pick<ScheduledJob, "name" | "schedule" | "task"> & { enabled?: boolean },
): Promise<ScheduledJob> {
  if (!parseCronExpression(input.schedule)) {
    throw new Error(`Invalid cron expression: "${input.schedule}"`);
  }
  const now = new Date().toISOString();
  const job: ScheduledJob = {
    id: randomUUID(),
    name: input.name,
    schedule: input.schedule,
    task: input.task,
    enabled: input.enabled ?? true,
    lastRunAt: null,
    lastResult: null,
    lastStatus: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.push(job);
  await saveJobs();
  return job;
}

export async function updateScheduledJob(
  id: string,
  updates: Partial<Pick<ScheduledJob, "name" | "schedule" | "task" | "enabled">>,
): Promise<ScheduledJob | null> {
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  if (updates.schedule && !parseCronExpression(updates.schedule)) {
    throw new Error(`Invalid cron expression: "${updates.schedule}"`);
  }
  if (updates.name !== undefined) job.name = updates.name;
  if (updates.schedule !== undefined) job.schedule = updates.schedule;
  if (updates.task !== undefined) job.task = updates.task;
  if (updates.enabled !== undefined) job.enabled = updates.enabled;
  job.updatedAt = new Date().toISOString();
  await saveJobs();
  return job;
}

export async function deleteScheduledJob(id: string): Promise<boolean> {
  const index = jobs.findIndex((j) => j.id === id);
  if (index < 0) return false;
  jobs.splice(index, 1);
  await saveJobs();
  return true;
}

export async function runJobManually(id: string): Promise<{ ok: boolean; result: string } | null> {
  const job = jobs.find((j) => j.id === id);
  if (!job || !executor) return null;
  return executeJob(job);
}

async function executeJob(job: ScheduledJob): Promise<{ ok: boolean; result: string }> {
  if (!executor) return { ok: false, result: "No executor configured" };
  try {
    const result = await executor(job);
    job.lastRunAt = new Date().toISOString();
    job.lastResult = result.result.slice(0, 2000);
    job.lastStatus = result.ok ? "ok" : "error";
    await saveJobs();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.lastRunAt = new Date().toISOString();
    job.lastResult = message.slice(0, 2000);
    job.lastStatus = "error";
    await saveJobs();
    return { ok: false, result: message };
  }
}

/**
 * Start the scheduler loop. Call once during server startup.
 */
export function startScheduler(jobExecutor: JobExecutor): void {
  executor = jobExecutor;
  if (checkInterval) return;
  checkInterval = setInterval(() => {
    void checkDueJobs();
  }, CHECK_INTERVAL_MS);
  // Don't prevent process exit
  if (checkInterval.unref) checkInterval.unref();
}

export function stopScheduler(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  executor = null;
}

async function checkDueJobs(): Promise<void> {
  const now = new Date();
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (isDue(job, now)) {
      console.log(`[scheduler] Running job "${job.name}" (${job.id})`);
      await executeJob(job);
    }
  }
}

function isDue(job: ScheduledJob, now: Date): boolean {
  const parsed = parseCronExpression(job.schedule);
  if (!parsed) return false;

  // Check if the job was already run this minute
  if (job.lastRunAt) {
    const lastRun = new Date(job.lastRunAt);
    if (
      lastRun.getFullYear() === now.getFullYear() &&
      lastRun.getMonth() === now.getMonth() &&
      lastRun.getDate() === now.getDate() &&
      lastRun.getHours() === now.getHours() &&
      lastRun.getMinutes() === now.getMinutes()
    ) {
      return false;
    }
  }

  return matchesCron(parsed, now);
}

// ─── Lightweight cron parser ─────────────────────────────────────────────────

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minute: parseField(parts[0]!, 0, 59),
      hour: parseField(parts[1]!, 0, 23),
      dayOfMonth: parseField(parts[2]!, 1, 31),
      month: parseField(parts[3]!, 1, 12),
      dayOfWeek: parseField(parts[4]!, 0, 6),
    };
  } catch {
    return null;
  }
}

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;
    const range = stepMatch ? stepMatch[1]! : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) result.add(i);
    } else if (range.includes("-")) {
      const [startStr, endStr] = range.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max) throw new Error("Invalid range");
      for (let i = start; i <= end; i += step) result.add(i);
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val) || val < min || val > max) throw new Error("Invalid value");
      result.add(val);
    }
  }
  return result;
}

function matchesCron(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.has(date.getMinutes()) &&
    fields.hour.has(date.getHours()) &&
    fields.dayOfMonth.has(date.getDate()) &&
    fields.month.has(date.getMonth() + 1) &&
    fields.dayOfWeek.has(date.getDay())
  );
}

// Export for testing
export { parseCronExpression, matchesCron, type CronFields };
