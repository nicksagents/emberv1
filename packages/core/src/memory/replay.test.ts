import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";

import { defaultMemoryConfig } from "./defaults";
import { runMemoryReplay } from "./replay";
import { isNodeSqliteAvailable } from "./sqlite";
import { createMemoryRepository } from "./store";

const test = isNodeSqliteAvailable() ? nodeTest : nodeTest.skip;

async function withRepository(
  fn: (repository: ReturnType<typeof createMemoryRepository>, config: ReturnType<typeof defaultMemoryConfig>) => Promise<void>,
) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-replay-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);
    try {
      await fn(repository, config);
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

test("runMemoryReplay promotes repeated cross-session project constraints into semantic memory", async () => {
  await withRepository(async (repository) => {
    await repository.upsertItems([
      {
        sessionId: "sess_a",
        memoryType: "warning_or_constraint",
        scope: "workspace",
        content: "Keep prompt memory compact for the workspace and use pnpm only for repo commands.",
        tags: ["constraint", "pnpm", "prompt"],
        sourceType: "assistant_message",
        salience: 0.8,
        confidence: 0.82,
      },
      {
        sessionId: "sess_b",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Keep prompt memory compact for the workspace and use pnpm only for repo commands.",
        tags: ["constraint", "pnpm", "prompt"],
        sourceType: "assistant_message",
        salience: 0.78,
        confidence: 0.8,
      },
    ]);

    const result = await runMemoryReplay(repository, {
      now: "2026-03-12T22:00:00.000Z",
    });

    const items = await repository.listItems({ includeSuperseded: true });
    const replayFact = items.find(
      (item) =>
        item.memoryType === "project_fact" &&
        item.sourceType === "system" &&
        item.jsonValue?.evidenceKind === "replay_constraint_cluster",
    );
    const edges = await repository.listEdges();

    assert.ok(replayFact);
    assert.equal(result.writtenItems.length, 1);
    assert.match(replayFact?.content ?? "", /Persistent project constraint:/);
    assert.equal(replayFact?.jsonValue?.approvalStatus, "pending");
    assert.ok(replayFact?.tags.includes("approval:pending"));
    assert.ok(edges.some((edge) => edge.fromId === replayFact?.id && edge.relation === "derived_from"));
    assert.ok(edges.some((edge) => edge.toId === replayFact?.id && edge.relation === "about_project"));
    assert.ok(edges.some((edge) => edge.toId === replayFact?.id && edge.relation === "reinforces"));
  });
});

test("runMemoryReplay links supported durable memories and records contradictions", async () => {
  await withRepository(async (repository) => {
    const [supportA, supportB, staleNode] = await repository.upsertItems([
      {
        sessionId: "sess_a",
        memoryType: "episode_summary",
        scope: "workspace",
        content: "Checked the local Node version in the workspace before the upgrade.",
        tags: ["node", "version", "environment"],
        sourceType: "session_summary",
        salience: 0.7,
        confidence: 0.78,
      },
      {
        sessionId: "sess_b",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Confirmed the workspace Node version again after the upgrade.",
        tags: ["node", "version", "environment"],
        sourceType: "assistant_message",
        salience: 0.74,
        confidence: 0.8,
      },
      {
        sessionId: "sess_old",
        memoryType: "environment_fact",
        scope: "workspace",
        content: "Workspace Node version is v22.1.0.",
        jsonValue: {
          key: "environment:node_version",
          version: "v22.1.0",
        },
        tags: ["node", "version"],
        sourceType: "tool_result",
        salience: 0.84,
        confidence: 0.9,
      },
    ]);
    const [activeNode] = await repository.upsertItems([
      {
        sessionId: "sess_new",
        memoryType: "environment_fact",
        scope: "workspace",
        content: "Workspace Node version is v23.0.0.",
        jsonValue: {
          key: "environment:node_version",
          version: "v23.0.0",
        },
        tags: ["node", "version"],
        sourceType: "tool_result",
        salience: 0.9,
        confidence: 0.94,
        supersedesId: staleNode?.id ?? null,
      },
    ]);
    await repository.upsertEdges([
      { fromId: activeNode!.id, toId: supportA!.id, relation: "derived_from" },
      { fromId: activeNode!.id, toId: supportB!.id, relation: "derived_from" },
    ]);

    const result = await runMemoryReplay(repository, {
      now: "2026-03-13T09:00:00.000Z",
    });
    const edges = await repository.listEdges();

    assert.ok(result.reinforcedItemIds.includes(activeNode!.id));
    assert.ok(edges.some((edge) => edge.fromId === supportA!.id && edge.toId === activeNode!.id && edge.relation === "about_project"));
    assert.ok(edges.some((edge) => edge.fromId === supportB!.id && edge.toId === activeNode!.id && edge.relation === "reinforces"));
    assert.ok(edges.some((edge) => edge.fromId === activeNode!.id && edge.toId === staleNode!.id && edge.relation === "contradicts"));
  });
});

test("runMemoryReplay downgrades durable memories with sustained contradictory history", async () => {
  await withRepository(async (repository) => {
    const [older, newer] = await repository.upsertItems([
      {
        sessionId: "sess_old_a",
        memoryType: "environment_fact",
        scope: "workspace",
        content: "Workspace Node version is v21.0.0.",
        jsonValue: {
          key: "environment:node_version",
          version: "v21.0.0",
        },
        tags: ["node", "version"],
        sourceType: "tool_result",
        salience: 0.82,
        confidence: 0.88,
      },
      {
        sessionId: "sess_old_b",
        memoryType: "environment_fact",
        scope: "workspace",
        content: "Workspace Node version is v22.0.0.",
        jsonValue: {
          key: "environment:node_version",
          version: "v22.0.0",
        },
        tags: ["node", "version"],
        sourceType: "tool_result",
        salience: 0.84,
        confidence: 0.9,
      },
    ]);
    const [latest] = await repository.upsertItems([
      {
        sessionId: "sess_new",
        memoryType: "environment_fact",
        scope: "workspace",
        content: "Workspace Node version is v23.0.0.",
        jsonValue: {
          key: "environment:node_version",
          version: "v23.0.0",
        },
        tags: ["node", "version"],
        sourceType: "tool_result",
        salience: 0.9,
        confidence: 0.94,
        supersedesId: newer?.id ?? null,
      },
    ]);
    await repository.upsertEdges([
      { fromId: latest!.id, toId: older!.id, relation: "contradicts" },
      { fromId: latest!.id, toId: newer!.id, relation: "contradicts" },
    ]);

    const result = await runMemoryReplay(repository, {
      now: "2026-03-13T10:00:00.000Z",
    });
    const disputed = result.writtenItems.find(
      (item) => item.memoryType === "environment_fact" && item.jsonValue?.approvalStatus === "disputed",
    );

    assert.ok(disputed);
    assert.equal(disputed?.jsonValue?.contradictionSessionCount, 2);
    assert.ok(disputed?.tags.includes("approval:disputed"));
  });
});
