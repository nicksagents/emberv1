import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import {
  createFileMutationCheckpoint,
  listCheckpoints,
  rollbackCheckpoint,
} from "./checkpoints.js";

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-checkpoints-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;
  try {
    await fn(tempRoot);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("checkpoint rollback restores previous file contents", async () => {
  await withTempRoot(async (root) => {
    const filePath = path.join(root, "workspace", "notes.txt");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "before\n", "utf8");

    const checkpoint = await createFileMutationCheckpoint({
      paths: [filePath],
      reason: "write_file",
      turnKey: "turn-a",
    });
    assert.ok(checkpoint);

    await writeFile(filePath, "after\n", "utf8");
    const rollback = await rollbackCheckpoint(checkpoint!.id);
    assert.equal(rollback.ok, true);
    assert.equal(rollback.restoredCount >= 1, true);

    const restored = await readFile(filePath, "utf8");
    assert.equal(restored, "before\n");
  });
});

test("checkpoints reuse one checkpoint per directory per turn", async () => {
  await withTempRoot(async (root) => {
    const fileA = path.join(root, "workspace", "src", "a.txt");
    const fileB = path.join(root, "workspace", "src", "b.txt");
    await mkdir(path.dirname(fileA), { recursive: true });
    await writeFile(fileA, "a1\n", "utf8");
    await writeFile(fileB, "b1\n", "utf8");

    const first = await createFileMutationCheckpoint({
      paths: [fileA],
      reason: "edit_file",
      turnKey: "turn-shared",
    });
    const second = await createFileMutationCheckpoint({
      paths: [fileB],
      reason: "edit_file",
      turnKey: "turn-shared",
    });

    assert.ok(first);
    assert.ok(second);
    assert.equal(first!.id, second!.id);
    assert.equal(second!.snapshotCount, 2);
  });
});

test("checkpoint retention prunes oldest records", async () => {
  const previousRetention = process.env.EMBER_CHECKPOINT_RETENTION_COUNT;
  process.env.EMBER_CHECKPOINT_RETENTION_COUNT = "2";

  try {
    await withTempRoot(async (root) => {
      const filePath = path.join(root, "workspace", "retention.txt");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "seed\n", "utf8");

      for (const turn of ["turn-1", "turn-2", "turn-3"]) {
        const checkpoint = await createFileMutationCheckpoint({
          paths: [filePath],
          reason: "write_file",
          turnKey: turn,
        });
        assert.ok(checkpoint);
        await writeFile(filePath, `${turn}\n`, "utf8");
      }

      const items = await listCheckpoints(10);
      assert.equal(items.length, 2);
      assert.equal(items.every((item) => item.turnKey !== "turn-1"), true);
    });
  } finally {
    if (previousRetention === undefined) {
      delete process.env.EMBER_CHECKPOINT_RETENTION_COUNT;
    } else {
      process.env.EMBER_CHECKPOINT_RETENTION_COUNT = previousRetention;
    }
  }
});
