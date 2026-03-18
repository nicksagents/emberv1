import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { getDataRoot } from "@ember/core";
import { CONFIG } from "./config.js";

const CHECKPOINT_DIR = "checkpoints";
const INDEX_FILE = "index.json";
const MANIFEST_FILE = "manifest.json";
const DEFAULT_CHECKPOINT_RETENTION = CONFIG.checkpoints.retention;

type SnapshotKind = "missing" | "file" | "directory" | "symlink";

interface CheckpointSnapshot {
  targetPath: string;
  kind: SnapshotKind;
  backupPath: string | null;
  symlinkTarget: string | null;
}

interface CheckpointManifest {
  id: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
  turnKey: string | null;
  scopeDir: string;
  snapshots: CheckpointSnapshot[];
}

export interface CheckpointSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
  turnKey: string | null;
  scopeDir: string;
  snapshotCount: number;
}

export interface CheckpointRollbackResult {
  ok: boolean;
  id: string;
  restoredCount: number;
  message: string;
}

function resolveCheckpointsRoot(): string {
  return path.join(getDataRoot(), CHECKPOINT_DIR);
}

function resolveCheckpointDir(id: string): string {
  return path.join(resolveCheckpointsRoot(), id);
}

function resolveIndexPath(): string {
  return path.join(resolveCheckpointsRoot(), INDEX_FILE);
}

function resolveManifestPath(id: string): string {
  return path.join(resolveCheckpointDir(id), MANIFEST_FILE);
}

function isCheckpointEnabled(): boolean {
  const raw = process.env.EMBER_ENABLE_CHECKPOINTS?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function resolveCheckpointRetentionCount(): number {
  const parsed = Number.parseInt(
    process.env.EMBER_CHECKPOINT_RETENTION ?? process.env.EMBER_CHECKPOINT_RETENTION_COUNT ?? "",
    10,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CHECKPOINT_RETENTION;
  }
  return Math.max(1, Math.min(parsed, 1_000));
}

async function ensureCheckpointStore(): Promise<void> {
  const root = resolveCheckpointsRoot();
  await mkdir(root, { recursive: true });
  const indexPath = resolveIndexPath();
  if (!existsSync(indexPath)) {
    await writeFile(indexPath, "[]", "utf8");
  }
}

async function readCheckpointIndex(): Promise<CheckpointSummary[]> {
  await ensureCheckpointStore();
  const raw = await readFile(resolveIndexPath(), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is CheckpointSummary => {
    return Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as Record<string, unknown>).id === "string"
      && typeof (entry as Record<string, unknown>).createdAt === "string"
      && typeof (entry as Record<string, unknown>).updatedAt === "string"
      && typeof (entry as Record<string, unknown>).reason === "string"
      && typeof (entry as Record<string, unknown>).scopeDir === "string"
      && typeof (entry as Record<string, unknown>).snapshotCount === "number";
  });
}

async function writeCheckpointIndex(items: CheckpointSummary[]): Promise<void> {
  await ensureCheckpointStore();
  await writeFile(resolveIndexPath(), `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

async function loadCheckpointManifest(id: string): Promise<CheckpointManifest> {
  const raw = await readFile(resolveManifestPath(id), "utf8");
  return JSON.parse(raw) as CheckpointManifest;
}

async function writeCheckpointManifest(manifest: CheckpointManifest): Promise<void> {
  const dir = resolveCheckpointDir(manifest.id);
  await mkdir(dir, { recursive: true });
  await writeFile(resolveManifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(
    paths
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry)),
  )];
}

function commonAncestor(paths: string[]): string {
  if (paths.length === 0) {
    return process.cwd();
  }
  const splitPaths = paths.map((entry) => path.resolve(entry).split(path.sep).filter(Boolean));
  const minLength = Math.min(...splitPaths.map((entry) => entry.length));
  const commonSegments: string[] = [];
  for (let index = 0; index < minLength; index += 1) {
    const segment = splitPaths[0]?.[index];
    if (!segment) {
      break;
    }
    if (splitPaths.every((entry) => entry[index] === segment)) {
      commonSegments.push(segment);
    } else {
      break;
    }
  }

  const rootPrefix = path.parse(path.resolve(paths[0]!)).root;
  return path.join(rootPrefix, ...commonSegments);
}

function createCheckpointId(): string {
  return `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function createSnapshot(
  checkpointId: string,
  targetPath: string,
  snapshotIndex: number,
): Promise<CheckpointSnapshot> {
  if (!existsSync(targetPath)) {
    return {
      targetPath,
      kind: "missing",
      backupPath: null,
      symlinkTarget: null,
    };
  }

  const stats = await lstat(targetPath);
  if (stats.isDirectory()) {
    const backupPath = path.join("dirs", `${snapshotIndex}`);
    const fullBackupPath = path.join(resolveCheckpointDir(checkpointId), backupPath);
    await mkdir(path.dirname(fullBackupPath), { recursive: true });
    await cp(targetPath, fullBackupPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      preserveTimestamps: true,
    });
    return {
      targetPath,
      kind: "directory",
      backupPath,
      symlinkTarget: null,
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      targetPath,
      kind: "symlink",
      backupPath: null,
      symlinkTarget: await readlink(targetPath),
    };
  }

  const backupPath = path.join("files", `${snapshotIndex}.bin`);
  const fullBackupPath = path.join(resolveCheckpointDir(checkpointId), backupPath);
  await mkdir(path.dirname(fullBackupPath), { recursive: true });
  await copyFile(targetPath, fullBackupPath);
  return {
    targetPath,
    kind: "file",
    backupPath,
    symlinkTarget: null,
  };
}

function findReusableCheckpoint(
  index: CheckpointSummary[],
  scopeDir: string,
  turnKey: string | null,
): CheckpointSummary | null {
  if (!turnKey) {
    return null;
  }
  const match = [...index]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .find((entry) => entry.scopeDir === scopeDir && entry.turnKey === turnKey);
  return match ?? null;
}

async function pruneCheckpointRetention(index: CheckpointSummary[]): Promise<CheckpointSummary[]> {
  const retention = resolveCheckpointRetentionCount();
  if (index.length <= retention) {
    return index;
  }
  const sorted = [...index].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const toDelete = sorted.slice(0, sorted.length - retention);
  for (const item of toDelete) {
    await rm(resolveCheckpointDir(item.id), { recursive: true, force: true });
  }
  const toDeleteSet = new Set(toDelete.map((item) => item.id));
  return index.filter((item) => !toDeleteSet.has(item.id));
}

export async function listCheckpoints(limit = 50): Promise<CheckpointSummary[]> {
  const max = Math.max(1, Math.min(limit, 500));
  return (await readCheckpointIndex())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, max);
}

export async function createFileMutationCheckpoint(input: {
  paths: string[];
  reason: string;
  turnKey?: string | null;
}): Promise<CheckpointSummary | null> {
  if (!isCheckpointEnabled()) {
    return null;
  }

  const paths = uniqueResolvedPaths(input.paths);
  if (paths.length === 0) {
    return null;
  }
  const scopeDir = commonAncestor(paths.map((entry) => path.dirname(entry)));
  const turnKey = input.turnKey?.trim() ? input.turnKey.trim() : null;

  const index = await readCheckpointIndex();
  const existing = findReusableCheckpoint(index, scopeDir, turnKey);
  const id = existing?.id ?? createCheckpointId();
  const nowIso = new Date().toISOString();
  const manifest = existing
    ? await loadCheckpointManifest(existing.id)
    : {
        id,
        createdAt: nowIso,
        updatedAt: nowIso,
        reason: input.reason,
        turnKey,
        scopeDir,
        snapshots: [],
      } satisfies CheckpointManifest;

  const captured = new Set(manifest.snapshots.map((item) => item.targetPath));
  for (const targetPath of paths) {
    if (captured.has(targetPath)) {
      continue;
    }
    const snapshot = await createSnapshot(manifest.id, targetPath, manifest.snapshots.length);
    manifest.snapshots.push(snapshot);
    captured.add(targetPath);
  }
  manifest.updatedAt = new Date().toISOString();
  await writeCheckpointManifest(manifest);

  const summary: CheckpointSummary = {
    id: manifest.id,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    reason: manifest.reason,
    turnKey: manifest.turnKey,
    scopeDir: manifest.scopeDir,
    snapshotCount: manifest.snapshots.length,
  };

  const nextIndex = [...index.filter((entry) => entry.id !== summary.id), summary];
  await writeCheckpointIndex(await pruneCheckpointRetention(nextIndex));
  return summary;
}

async function restoreSnapshot(id: string, snapshot: CheckpointSnapshot): Promise<void> {
  await rm(snapshot.targetPath, { recursive: true, force: true });
  if (snapshot.kind === "missing") {
    return;
  }

  if (snapshot.kind === "file") {
    if (!snapshot.backupPath) {
      throw new Error(`Checkpoint ${id} has missing backup path for file snapshot.`);
    }
    await mkdir(path.dirname(snapshot.targetPath), { recursive: true });
    await copyFile(path.join(resolveCheckpointDir(id), snapshot.backupPath), snapshot.targetPath);
    return;
  }

  if (snapshot.kind === "directory") {
    if (!snapshot.backupPath) {
      throw new Error(`Checkpoint ${id} has missing backup path for directory snapshot.`);
    }
    await mkdir(path.dirname(snapshot.targetPath), { recursive: true });
    await cp(path.join(resolveCheckpointDir(id), snapshot.backupPath), snapshot.targetPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      preserveTimestamps: true,
    });
    return;
  }

  if (!snapshot.symlinkTarget) {
    throw new Error(`Checkpoint ${id} has missing symlink target for symlink snapshot.`);
  }
  await mkdir(path.dirname(snapshot.targetPath), { recursive: true });
  await symlink(snapshot.symlinkTarget, snapshot.targetPath);
}

export async function rollbackCheckpoint(id: string): Promise<CheckpointRollbackResult> {
  const trimmed = id.trim();
  if (!trimmed) {
    return {
      ok: false,
      id,
      restoredCount: 0,
      message: "Checkpoint id is required.",
    };
  }

  const manifestPath = resolveManifestPath(trimmed);
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      id: trimmed,
      restoredCount: 0,
      message: "Checkpoint not found.",
    };
  }

  const manifest = await loadCheckpointManifest(trimmed);
  for (const snapshot of manifest.snapshots.slice().reverse()) {
    await restoreSnapshot(trimmed, snapshot);
  }

  return {
    ok: true,
    id: trimmed,
    restoredCount: manifest.snapshots.length,
    message: `Rolled back checkpoint ${trimmed}.`,
  };
}
