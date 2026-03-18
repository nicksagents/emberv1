import type { FastifyRequest } from "fastify";
import { getDataRoot } from "@ember/core";
import { appendFile, chmod, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";

const AUDIT_LOG_DIR = "audit-logs";
const AUDIT_LOG_FILE = "audit.log"; // Fallback for size-based rotation
const SENSITIVE_KEY_PATTERN =
  /(password|passcode|passwd|secret|token|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|authorization|bearer|cookie|session)/i;
let auditWriteQueue: Promise<void> = Promise.resolve();
let currentDateTag: string | null = null;

export interface AuditEvent {
  action: string;
  method: string;
  path: string;
  ip: string;
  requestId?: string | null;
  status: "ok" | "denied" | "error";
  details?: Record<string, unknown>;
}

export function buildRequestAuditEvent(
  request: FastifyRequest,
  action: string,
  status: AuditEvent["status"],
  details?: Record<string, unknown>,
): AuditEvent {
  const pathname = request.url.split("?")[0] ?? request.url;
  return {
    action,
    method: request.method,
    path: pathname,
    ip: request.ip,
    requestId: request.id,
    status,
    details,
  };
}

function getDateTag(date = new Date()): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getDateBasedLogPath(dataRoot: string, dateTag: string): string {
  return path.join(dataRoot, AUDIT_LOG_DIR, `audit-${dateTag}.jsonl`);
}

export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  const writeTask = async () => {
    const dataRoot = getDataRoot();
    const now = new Date();
    const dateTag = getDateTag(now);
    const logDir = path.join(dataRoot, AUDIT_LOG_DIR);
    await mkdir(logDir, { recursive: true });

    const logPath = getDateBasedLogPath(dataRoot, dateTag);

    // If the date changed, trigger cleanup of old logs
    if (currentDateTag !== null && currentDateTag !== dateTag) {
      void pruneOldAuditLogs(logDir).catch(() => { /* Best-effort */ });
    }
    currentDateTag = dateTag;

    // Size-based rotation within a single day's file
    await rotateIfNeeded(logPath);

    const payload = {
      timestamp: now.toISOString(),
      ...event,
      details: sanitizeForLog(event.details ?? {}),
    };
    await appendFile(logPath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await chmod(logPath, 0o600);
    } catch {
      // Best-effort only on non-POSIX environments.
    }
  };

  const next = auditWriteQueue.then(writeTask, writeTask);
  auditWriteQueue = next.then(() => undefined, () => undefined);
  await next;
}

export async function flushAuditLog(): Promise<void> {
  await auditWriteQueue;
}

async function rotateIfNeeded(logPath: string): Promise<void> {
  const maxAuditLogSize = resolveAuditLogMaxSizeBytes();
  const maxRotatedLogs = resolveAuditLogMaxRotated();
  try {
    const current = await stat(logPath);
    if (current.size < maxAuditLogSize) {
      return;
    }
  } catch {
    return;
  }

  const oldest = `${logPath}.${maxRotatedLogs}`;
  await rm(oldest, { force: true }).catch(() => {
    // Best-effort cleanup.
  });

  for (let index = maxRotatedLogs - 1; index >= 1; index -= 1) {
    const from = `${logPath}.${index}`;
    const to = `${logPath}.${index + 1}`;
    await rename(from, to).catch(() => {
      // Missing generation is fine.
    });
  }

  await rename(logPath, `${logPath}.1`).catch(() => {
    // Rotation can race with other writes; skip if rename fails.
  });
}

function resolveAuditLogMaxSizeBytes(): number {
  const raw = Number.parseInt(process.env.EMBER_AUDIT_LOG_MAX_SIZE_BYTES ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return CONFIG.audit.maxLogSizeBytes;
  }
  return Math.max(1_024, raw);
}

function resolveAuditLogMaxRotated(): number {
  const raw = Number.parseInt(process.env.EMBER_AUDIT_LOG_MAX_ROTATED ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return CONFIG.audit.maxRotatedLogs;
  }
  return Math.max(1, Math.min(raw, 50));
}

/**
 * Remove audit log files older than maxAgeDays.
 * Default 90 days, configurable via EMBER_AUDIT_MAX_AGE_DAYS env var.
 */
async function pruneOldAuditLogs(logDir: string): Promise<number> {
  const maxAgeDays = resolveAuditMaxAgeDays();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let pruned = 0;

  try {
    const entries = await readdir(logDir);
    for (const entry of entries) {
      // Match audit-YYYY-MM-DD.jsonl or audit-YYYY-MM-DD.jsonl.N (rotated)
      const match = entry.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl/);
      if (!match) continue;
      const fileDate = new Date(match[1]!).getTime();
      if (Number.isNaN(fileDate) || fileDate >= cutoff) continue;
      try {
        await unlink(path.join(logDir, entry));
        pruned++;
      } catch {
        // Best-effort
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }
  return pruned;
}

function resolveAuditMaxAgeDays(): number {
  const raw = Number.parseInt(process.env.EMBER_AUDIT_MAX_AGE_DAYS ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 90;
  return Math.max(1, Math.min(raw, 365));
}

function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 10) {
    return "[nested]";
  }
  if (typeof value === "string") {
    if (value.length > 1_000) {
      return `${value.slice(0, 200)}...[truncated]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForLog(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = sanitizeForLog(entry, depth + 1);
  }
  return sanitized;
}
