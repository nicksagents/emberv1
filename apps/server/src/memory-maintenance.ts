import {
  createMemoryRepository,
  readSettings,
  runMemoryReplay,
  type MemoryReplayResult,
  type MemoryRepository,
  type MemorySession,
} from "@ember/core";

const REPLAY_INTERVAL_MS = parsePositiveMs(process.env.EMBER_MEMORY_REPLAY_INTERVAL_MS, 180_000);
const REPLAY_COOLDOWN_MS = parsePositiveMs(process.env.EMBER_MEMORY_REPLAY_COOLDOWN_MS, 60_000);

export interface MemoryReplayState {
  status: "idle" | "running" | "completed" | "skipped" | "failed";
  currentReason: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSkippedAt: string | null;
  lastFailedAt: string | null;
  lastSkipReason: string | null;
  lastError: string | null;
  runCount: number;
  skipCount: number;
  failureCount: number;
  archivedSessionCount: number;
  latestArchivedAt: string | null;
  lastProcessedArchiveAt: string | null;
  lastResult: Pick<MemoryReplayResult, "generatedAt" | "writtenItems" | "reinforcedItemIds" | "linkedEdges"> | null;
}

interface ReplayArchiveSummary {
  archivedSessionCount: number;
  latestArchivedAt: string | null;
}

let replayState: MemoryReplayState = createInitialReplayState();
let replayTimer: NodeJS.Timeout | null = null;

export function getMemoryReplayState(): MemoryReplayState {
  return structuredClone(replayState);
}

export function resetMemoryReplayState(): void {
  replayState = createInitialReplayState();
}

export function stopMemoryReplayScheduler(): void {
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
}

export function startMemoryReplayScheduler(): void {
  stopMemoryReplayScheduler();
  replayTimer = setInterval(() => {
    void runScheduledMemoryReplay({
      reason: "scheduled-interval",
    });
  }, REPLAY_INTERVAL_MS);
  replayTimer.unref?.();
  void runScheduledMemoryReplay({ reason: "startup-scan" });
}

export async function runScheduledMemoryReplay(options: {
  reason: string;
  force?: boolean;
  now?: string;
}): Promise<{ outcome: "ran" | "skipped"; replay?: MemoryReplayResult; state: MemoryReplayState }> {
  const settings = await readSettings();
  if (!settings.memory.enabled || !settings.memory.rollout.replaySchedulerEnabled) {
    const now = options.now ?? new Date().toISOString();
    markReplaySkipped(now, "replay scheduler disabled");
    return { outcome: "skipped", state: getMemoryReplayState() };
  }

  const repository = createMemoryRepository(settings.memory);
  try {
    return await maybeRunMemoryReplayWithRepository(repository, options);
  } finally {
    await repository.close?.();
  }
}

export async function maybeRunMemoryReplayWithRepository(
  repository: MemoryRepository,
  options: {
    reason: string;
    force?: boolean;
    now?: string;
  },
): Promise<{ outcome: "ran" | "skipped"; replay?: MemoryReplayResult; state: MemoryReplayState }> {
  const now = options.now ?? new Date().toISOString();
  if (replayState.status === "running") {
    markReplaySkipped(now, "replay already running");
    return { outcome: "skipped", state: getMemoryReplayState() };
  }

  const sessions = await repository.listSessions();
  const archiveSummary = summarizeArchivedSessions(sessions);
  replayState.archivedSessionCount = archiveSummary.archivedSessionCount;
  replayState.latestArchivedAt = archiveSummary.latestArchivedAt;

  const skipReason = getReplaySkipReason(archiveSummary, now, options.force === true);
  if (skipReason) {
    markReplaySkipped(now, skipReason);
    return { outcome: "skipped", state: getMemoryReplayState() };
  }

  replayState.status = "running";
  replayState.currentReason = options.reason;
  replayState.lastStartedAt = now;
  replayState.lastError = null;
  replayState.lastSkipReason = null;

  try {
    const replay = await runMemoryReplay(repository, { now });
    replayState.status = "completed";
    replayState.currentReason = options.reason;
    replayState.lastCompletedAt = now;
    replayState.lastProcessedArchiveAt = archiveSummary.latestArchivedAt;
    replayState.runCount += 1;
    replayState.lastResult = {
      generatedAt: replay.generatedAt,
      writtenItems: replay.writtenItems,
      reinforcedItemIds: replay.reinforcedItemIds,
      linkedEdges: replay.linkedEdges,
    };
    return { outcome: "ran", replay, state: getMemoryReplayState() };
  } catch (error) {
    replayState.status = "failed";
    replayState.currentReason = options.reason;
    replayState.lastFailedAt = now;
    replayState.failureCount += 1;
    replayState.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function getReplaySkipReason(
  summary: ReplayArchiveSummary,
  now: string,
  force: boolean,
): string | null {
  if (force) {
    return null;
  }

  if (summary.archivedSessionCount === 0 || !summary.latestArchivedAt) {
    return "no archived sessions";
  }

  const nowMs = new Date(now).getTime();
  const lastCompletedMs = replayState.lastCompletedAt ? new Date(replayState.lastCompletedAt).getTime() : NaN;
  const noNewArchives =
    replayState.lastProcessedArchiveAt !== null &&
    summary.latestArchivedAt <= replayState.lastProcessedArchiveAt;

  if (noNewArchives) {
    return "no new archived sessions";
  }

  if (Number.isFinite(lastCompletedMs) && nowMs - lastCompletedMs < REPLAY_COOLDOWN_MS) {
    return "replay cooldown active";
  }

  return null;
}

function summarizeArchivedSessions(sessions: MemorySession[]): ReplayArchiveSummary {
  let latestArchivedAt: string | null = null;
  let archivedSessionCount = 0;

  for (const session of sessions) {
    if (!session.endedAt) {
      continue;
    }
    archivedSessionCount += 1;
    if (!latestArchivedAt || session.endedAt > latestArchivedAt) {
      latestArchivedAt = session.endedAt;
    }
  }

  return {
    archivedSessionCount,
    latestArchivedAt,
  };
}

function markReplaySkipped(now: string, reason: string): void {
  replayState.status = "skipped";
  replayState.lastSkippedAt = now;
  replayState.lastSkipReason = reason;
  replayState.skipCount += 1;
}

function createInitialReplayState(): MemoryReplayState {
  return {
    status: "idle",
    currentReason: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSkippedAt: null,
    lastFailedAt: null,
    lastSkipReason: null,
    lastError: null,
    runCount: 0,
    skipCount: 0,
    failureCount: 0,
    archivedSessionCount: 0,
    latestArchivedAt: null,
    lastProcessedArchiveAt: null,
    lastResult: null,
  };
}

function parsePositiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(5_000, Math.floor(parsed));
}
