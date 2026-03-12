import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultMemoryConfig } from "./defaults";
import {
  approveMemoryItem,
  downgradeContradictedMemoryItem,
  getMemoryGovernanceState,
  revalidateMemoryItem,
  retireProcedureMemory,
  suppressMemoryItem,
} from "./governance";
import { createMemoryRepository } from "./store";

async function withRepository(
  fn: (repository: ReturnType<typeof createMemoryRepository>, config: ReturnType<typeof defaultMemoryConfig>) => Promise<void>,
) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-governance-"));
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

test("suppressMemoryItem forgets an active memory with operator reason", async () => {
  await withRepository(async (repository) => {
    const [memory] = await repository.upsertItems([
      {
        sessionId: "sess_profile",
        memoryType: "user_preference",
        scope: "user",
        content: "User prefers concise responses.",
        tags: ["style"],
        sourceType: "user_message",
      },
    ]);

    const suppressed = await suppressMemoryItem(repository, memory!.id, {
      now: "2026-03-13T10:00:00.000Z",
      reason: "operator-suppressed",
    });

    assert.ok(suppressed);
    assert.equal(suppressed?.jsonValue?.forgotten, true);
    assert.equal(suppressed?.jsonValue?.forgetReason, "operator-suppressed");
    assert.ok(suppressed?.tags.includes("forgotten"));
  });
});

test("retireProcedureMemory supersedes the active procedure with a retired copy", async () => {
  await withRepository(async (repository) => {
    const [procedure] = await repository.upsertItems([
      {
        sessionId: "sess_proc",
        memoryType: "procedure",
        scope: "workspace",
        content: "Learned procedure. Trigger: When handling TypeScript build failures.",
        jsonValue: {
          key: "procedure:typescript-build:search>read>run",
          trigger: "When handling TypeScript build failures.",
          published: true,
          retired: false,
        },
        tags: ["procedure", "procedure:published", "procedure:active"],
        sourceType: "session_summary",
        salience: 0.82,
        confidence: 0.84,
        volatility: "slow-changing",
      },
    ]);

    const retired = await retireProcedureMemory(repository, procedure!.id, {
      now: "2026-03-13T11:00:00.000Z",
      reason: "operator retired after regression",
    });

    assert.ok(retired);
    assert.equal(retired?.jsonValue?.retired, true);
    assert.equal(retired?.jsonValue?.published, false);
    assert.equal(retired?.supersedesId, procedure?.id);
    assert.ok(retired?.tags.includes("procedure:retired"));
    assert.ok(!retired?.tags.includes("procedure:published"));
    const previous = await repository.getItem(procedure!.id);
    assert.equal(previous?.supersededById, retired?.id);
  });
});

test("revalidateMemoryItem creates a superseding revalidated copy with a new due date", async () => {
  await withRepository(async (repository) => {
    const [memory] = await repository.upsertItems([
      {
        sessionId: "sess_env",
        memoryType: "environment_fact",
        scope: "workspace",
        content: "Workspace Node version is v23.0.0.",
        jsonValue: {
          key: "environment:node_version",
          version: "v23.0.0",
          _memory: {
            reinforcementCount: 2,
            lastReinforcedAt: "2026-03-10T10:00:00.000Z",
            revalidationDueAt: "2026-03-11T10:00:00.000Z",
            retrievalSuccessCount: 1,
            lastRetrievedAt: "2026-03-10T11:00:00.000Z",
          },
        },
        tags: ["node", "runtime"],
        sourceType: "tool_result",
        salience: 0.84,
        confidence: 0.9,
        volatility: "slow-changing",
      },
    ]);

    const revalidated = await revalidateMemoryItem(repository, memory!.id, {
      now: "2026-03-13T12:00:00.000Z",
      reason: "operator verified with fresh terminal output",
    });

    assert.ok(revalidated);
    assert.equal(revalidated?.supersedesId, memory?.id);
    assert.equal(revalidated?.jsonValue?.revalidatedBy, "operator");
    assert.ok(typeof revalidated?.jsonValue?._memory === "object");
    assert.equal(revalidated?.tags.includes("revalidated"), true);
    assert.notEqual(
      (revalidated?.jsonValue?._memory as { revalidationDueAt?: string } | undefined)?.revalidationDueAt,
      "2026-03-11T10:00:00.000Z",
    );
  });
});

test("approveMemoryItem marks a pending memory as approved and supersedes the prior copy", async () => {
  await withRepository(async (repository) => {
    const [memory] = await repository.upsertItems([
      {
        sessionId: "sess_replay",
        memoryType: "project_fact",
        scope: "workspace",
        content: "Persistent project constraint: Use pnpm only for repo commands.",
        jsonValue: {
          key: "project:constraint:use-pnpm-only",
          approvalStatus: "pending",
        },
        tags: ["constraint", "approval:pending"],
        sourceType: "system",
        sourceRef: "memory:replay",
        salience: 0.84,
        confidence: 0.82,
        volatility: "slow-changing",
      },
    ]);

    const approved = await approveMemoryItem(repository, memory!.id, {
      now: "2026-03-13T13:00:00.000Z",
      reason: "operator approved replay promotion",
    });

    assert.ok(approved);
    assert.equal(approved?.supersedesId, memory?.id);
    assert.equal(approved?.jsonValue?.approvalStatus, "approved");
    assert.equal(approved?.jsonValue?.approvedBy, "operator");
    assert.ok(approved?.tags.includes("approval:approved"));
    assert.equal(getMemoryGovernanceState(approved!).approvalStatus, "approved");
  });
});

test("downgradeContradictedMemoryItem marks memory as disputed and lowers confidence", async () => {
  await withRepository(async (repository) => {
    const [memory] = await repository.upsertItems([
      {
        sessionId: "sess_env",
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
        volatility: "slow-changing",
      },
    ]);

    const downgraded = await downgradeContradictedMemoryItem(repository, memory!.id, {
      now: "2026-03-13T14:00:00.000Z",
      contradictionCount: 3,
      contradictionSessionCount: 2,
      reason: "replay observed conflicting support",
    });

    assert.ok(downgraded);
    assert.equal(downgraded?.jsonValue?.approvalStatus, "disputed");
    assert.equal(downgraded?.jsonValue?.contradictionSessionCount, 2);
    assert.ok((downgraded?.confidence ?? 1) < (memory?.confidence ?? 0));
    assert.ok(downgraded?.tags.includes("approval:disputed"));
    assert.ok(downgraded?.tags.includes("contradicted"));
  });
});
