import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultMemoryConfig, createMemoryRepository, isNodeSqliteAvailable } from "@ember/core";

import {
  getMemoryReplayState,
  maybeRunMemoryReplayWithRepository,
  resetMemoryReplayState,
} from "./memory-maintenance.js";

async function withRepository(
  fn: (repository: ReturnType<typeof createMemoryRepository>) => Promise<void>,
) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-maintenance-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;
  resetMemoryReplayState();

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);
    try {
      await fn(repository);
    } finally {
      await repository.close?.();
    }
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const sqliteTest = isNodeSqliteAvailable() ? test : test.skip;

sqliteTest("maybeRunMemoryReplayWithRepository skips when there are no archived sessions", async () => {
  await withRepository(async (repository) => {
    const result = await maybeRunMemoryReplayWithRepository(repository, {
      reason: "scheduled-interval",
      now: "2026-03-13T12:00:00.000Z",
    });

    assert.equal(result.outcome, "skipped");
    assert.equal(result.state.lastSkipReason, "no archived sessions");
    assert.equal(result.state.runCount, 0);
  });
});

sqliteTest("maybeRunMemoryReplayWithRepository runs once for new archived sessions and then skips until there is new archive input", async () => {
  await withRepository(async (repository) => {
    await repository.upsertSession({
      id: "sess_archive",
      conversationId: "conv_archive",
      startedAt: "2026-03-13T10:00:00.000Z",
      endedAt: "2026-03-13T10:30:00.000Z",
      summary: "Archived session.",
      topics: ["memory"],
      messageCount: 4,
      lastMessageAt: "2026-03-13T10:29:00.000Z",
    });
    await repository.upsertSession({
      id: "sess_archive_2",
      conversationId: "conv_archive_2",
      startedAt: "2026-03-13T10:40:00.000Z",
      endedAt: "2026-03-13T11:00:00.000Z",
      summary: "Second archived session.",
      topics: ["memory"],
      messageCount: 4,
      lastMessageAt: "2026-03-13T10:59:00.000Z",
    });
    await repository.upsertItems([
      {
        sessionId: "sess_archive",
        memoryType: "warning_or_constraint",
        scope: "workspace",
        content: "Keep prompt memory compact for the workspace and use pnpm only for repo commands.",
        tags: ["constraint", "pnpm", "prompt"],
        sourceType: "assistant_message",
      },
      {
        sessionId: "sess_archive_2",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Keep prompt memory compact for the workspace and use pnpm only for repo commands.",
        tags: ["constraint", "pnpm", "prompt"],
        sourceType: "assistant_message",
      },
    ]);

    const first = await maybeRunMemoryReplayWithRepository(repository, {
      reason: "scheduled-interval",
      now: "2026-03-13T12:00:00.000Z",
    });
    assert.equal(first.outcome, "ran");
    assert.equal(first.state.runCount, 1);
    assert.ok(first.state.lastProcessedArchiveAt);

    const second = await maybeRunMemoryReplayWithRepository(repository, {
      reason: "scheduled-interval",
      now: "2026-03-13T12:02:00.000Z",
    });
    assert.equal(second.outcome, "skipped");
    assert.equal(second.state.lastSkipReason, "no new archived sessions");
    assert.equal(getMemoryReplayState().runCount, 1);
  });
});

sqliteTest("maybeRunMemoryReplayWithRepository force-runs even when archive state has not changed", async () => {
  await withRepository(async (repository) => {
    await repository.upsertSession({
      id: "sess_archive",
      conversationId: "conv_archive",
      startedAt: "2026-03-13T10:00:00.000Z",
      endedAt: "2026-03-13T10:30:00.000Z",
      summary: "Archived session.",
      topics: ["memory"],
      messageCount: 2,
      lastMessageAt: "2026-03-13T10:29:00.000Z",
    });

    const first = await maybeRunMemoryReplayWithRepository(repository, {
      reason: "archive-finalization",
      force: true,
      now: "2026-03-13T12:00:00.000Z",
    });
    const second = await maybeRunMemoryReplayWithRepository(repository, {
      reason: "operator-manual",
      force: true,
      now: "2026-03-13T12:00:10.000Z",
    });

    assert.equal(first.outcome, "ran");
    assert.equal(second.outcome, "ran");
    assert.equal(second.state.runCount, 2);
    assert.equal(second.state.currentReason, "operator-manual");
  });
});
