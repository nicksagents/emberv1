import path from "node:path";

import { getDataRoot, readJsonFile, writeJson } from "../store";
import type { TaskOutcome } from "../types";
import {
  createEmptyMemoryStoreData,
  createMemoryItem,
  createMemorySession,
  defaultMemoryConfig,
} from "./defaults";
import { extendMemoryValidity, getItemInternalMetadata, mergeMemoryInternalMetadata } from "./metadata";
import { buildMemoryPromptContext, scoreMemoryItems } from "./scoring";
import { isNodeSqliteAvailable, SqliteMemoryRepository } from "./sqlite";
import type {
  MemoryConfig,
  MemoryEdge,
  MemoryEdgeFilter,
  MemoryItem,
  MemoryItemFilter,
  MemoryPromptContext,
  MemoryRepository,
  MemorySearchQuery,
  MemorySearchResult,
  MemorySession,
  MemoryScope,
  MemoryStoreData,
  MemoryWriteCandidate,
} from "./types";

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getMemoryDataPath(config: MemoryConfig = defaultMemoryConfig()): string {
  return path.join(getDataRoot(), config.storage.fileName);
}

export async function readMemoryStoreData(
  config: MemoryConfig = defaultMemoryConfig(),
): Promise<MemoryStoreData> {
  const store = await readJsonFile<MemoryStoreData>(config.storage.fileName, createEmptyMemoryStoreData());
  return {
    sessions: Array.isArray(store.sessions) ? store.sessions : [],
    items: Array.isArray(store.items) ? store.items : [],
    edges: Array.isArray(store.edges) ? store.edges : [],
  };
}

export async function writeMemoryStoreData(
  value: MemoryStoreData,
  config: MemoryConfig = defaultMemoryConfig(),
): Promise<void> {
  await writeJson(getMemoryDataPath(config), value);
}

export class FileMemoryRepository implements MemoryRepository {
  constructor(private readonly config: MemoryConfig = defaultMemoryConfig()) {}

  async listSessions(): Promise<MemorySession[]> {
    const store = await readMemoryStoreData(this.config);
    return [...store.sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async getSession(id: string): Promise<MemorySession | null> {
    const store = await readMemoryStoreData(this.config);
    return store.sessions.find((session) => session.id === id) ?? null;
  }

  async upsertSession(session: MemorySession): Promise<MemorySession> {
    const store = await readMemoryStoreData(this.config);
    const next = createMemorySession(session);
    const sessions = upsertById(store.sessions, next);
    await writeMemoryStoreData({ ...store, sessions }, this.config);
    return next;
  }

  async listItems(filter: MemoryItemFilter = {}): Promise<MemoryItem[]> {
    const store = await readMemoryStoreData(this.config);
    return store.items.filter((item) => {
      if (!filter.includeSuperseded && item.supersededById) {
        return false;
      }
      if (filter.sessionId !== undefined && item.sessionId !== filter.sessionId) {
        return false;
      }
      if (filter.scope !== undefined && filter.scope !== null && item.scope !== filter.scope) {
        return false;
      }
      if (
        filter.memoryType !== undefined &&
        filter.memoryType !== null &&
        item.memoryType !== filter.memoryType
      ) {
        return false;
      }
      if (
        filter.sourceType !== undefined &&
        filter.sourceType !== null &&
        item.sourceType !== filter.sourceType
      ) {
        return false;
      }
      return true;
    });
  }

  async listEdges(filter: MemoryEdgeFilter = {}): Promise<MemoryEdge[]> {
    const store = await readMemoryStoreData(this.config);
    return getStoreEdges(store).filter((edge) => {
      if (filter.fromId !== undefined && edge.fromId !== filter.fromId) {
        return false;
      }
      if (filter.toId !== undefined && edge.toId !== filter.toId) {
        return false;
      }
      if (filter.relation !== undefined && filter.relation !== null && edge.relation !== filter.relation) {
        return false;
      }
      return true;
    });
  }

  async getItem(id: string): Promise<MemoryItem | null> {
    const store = await readMemoryStoreData(this.config);
    return store.items.find((item) => item.id === id) ?? null;
  }

  async upsertItems(candidates: MemoryWriteCandidate[]): Promise<MemoryItem[]> {
    const store = await readMemoryStoreData(this.config);
    const now = new Date().toISOString();
    const items = [...store.items];
    const written: MemoryItem[] = [];

    for (const candidate of candidates) {
      const next = createMemoryItem(candidate, createId("mem"), now);
      items.push(next);
      written.push(next);

      if (next.supersedesId) {
        const superseded = items.find((item) => item.id === next.supersedesId);
        if (superseded) {
          superseded.supersededById = next.id;
          superseded.updatedAt = now;
        }
      }
    }

    await writeMemoryStoreData({ ...store, items }, this.config);
    return written;
  }

  async upsertEdges(edges: MemoryEdge[]): Promise<MemoryEdge[]> {
    if (edges.length === 0) {
      return [];
    }

    const store = await readMemoryStoreData(this.config);
    const existingEdges = getStoreEdges(store);
    const edgeMap = new Map(existingEdges.map((edge) => [buildEdgeKey(edge), edge]));

    for (const edge of edges) {
      edgeMap.set(buildEdgeKey(edge), edge);
    }

    const nextEdges = [...edgeMap.values()];
    await writeMemoryStoreData({ ...store, edges: nextEdges }, this.config);
    return edges;
  }

  async forgetItem(
    id: string,
    options: { reason?: string | null; now?: string } = {},
  ): Promise<MemoryItem | null> {
    const store = await readMemoryStoreData(this.config);
    const item = store.items.find((candidate) => candidate.id === id) ?? null;
    if (!item) {
      return null;
    }

    const now = options.now ?? new Date().toISOString();
    const currentJsonValue =
      item.jsonValue && typeof item.jsonValue === "object" && !Array.isArray(item.jsonValue)
        ? item.jsonValue
        : {};
    item.updatedAt = now;
    item.validUntil = item.validUntil ?? now;
    item.jsonValue = {
      ...currentJsonValue,
      forgotten: true,
      forgottenAt: now,
      forgetReason: options.reason ?? null,
    };
    item.tags = [...new Set([...item.tags, "forgotten"])];

    await writeMemoryStoreData(store, this.config);
    return item;
  }

  async reinforceItem(
    id: string,
    options: {
      now?: string;
      confidenceDelta?: number;
      salienceDelta?: number;
      extendValidity?: boolean;
      revalidationDueAt?: string | null;
      reinforcementDelta?: number;
      retrievalSuccessDelta?: number;
      lastRetrievedAt?: string | null;
    } = {},
  ): Promise<MemoryItem | null> {
    const store = await readMemoryStoreData(this.config);
    const item = store.items.find((candidate) => candidate.id === id && !candidate.supersededById) ?? null;
    if (!item) {
      return null;
    }

    const now = options.now ?? new Date().toISOString();
    const meta = getItemInternalMetadata(item);
    const reinforcementDelta =
      options.reinforcementDelta === undefined ? 1 : Math.max(0, Math.round(options.reinforcementDelta));
    const retrievalSuccessDelta =
      options.retrievalSuccessDelta === undefined
        ? 0
        : Math.max(0, Math.round(options.retrievalSuccessDelta));
    item.updatedAt = now;
    item.confidence = clamp01(item.confidence + (options.confidenceDelta ?? 0.02));
    item.salience = clamp01(item.salience + (options.salienceDelta ?? 0.03));
    item.validUntil =
      options.extendValidity === true ? extendMemoryValidity(item.validUntil, item.volatility, now) : item.validUntil;
    item.jsonValue = mergeMemoryInternalMetadata(item.jsonValue, {
      reinforcementCount: meta.reinforcementCount + reinforcementDelta,
      lastReinforcedAt: reinforcementDelta > 0 ? now : meta.lastReinforcedAt,
      revalidationDueAt:
        options.revalidationDueAt === undefined ? meta.revalidationDueAt : options.revalidationDueAt,
      retrievalSuccessCount: meta.retrievalSuccessCount + retrievalSuccessDelta,
      lastRetrievedAt:
        options.lastRetrievedAt === undefined ? meta.lastRetrievedAt : options.lastRetrievedAt,
    });

    await writeMemoryStoreData(store, this.config);
    return item;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const items = await this.listItems();
    return scoreMemoryItems(items, query, this.config);
  }

  async buildPromptContext(query: MemorySearchQuery): Promise<MemoryPromptContext> {
    const results = await this.search(query);
    return buildMemoryPromptContext(results, this.config, {
      now: query.now,
      maxInjectedItems: query.maxInjectedItems,
      maxInjectedChars: query.maxInjectedChars,
    });
  }
}

export function createMemoryRepository(config: MemoryConfig = defaultMemoryConfig()): MemoryRepository {
  if (config.backend === "sqlite") {
    if (isNodeSqliteAvailable()) {
      return new SqliteMemoryRepository(config);
    }
    // Fall back to file backend when node:sqlite is not available (Node < 22)
    return new FileMemoryRepository({ ...config, backend: "file" });
  }
  return new FileMemoryRepository(config);
}

function summarizeTaskOutcomeText(value: string, limit = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export async function recordTaskOutcomeMemory(
  repository: MemoryRepository,
  outcome: TaskOutcome,
  options: {
    sessionId?: string | null;
    scope?: MemoryScope;
  } = {},
): Promise<MemoryItem> {
  const taskSummary = summarizeTaskOutcomeText(outcome.taskDescription, 160);
  const approachSummary = summarizeTaskOutcomeText(outcome.approach, 120);
  const failureReason = summarizeTaskOutcomeText(outcome.failureReason ?? "", 160);
  const content = [
    `Task outcome (${outcome.result}): ${taskSummary || "Task summary unavailable."}`,
    approachSummary ? `Approach: ${approachSummary}` : "",
    failureReason ? `Failure reason: ${failureReason}` : "",
  ].filter(Boolean).join(" ");

  const [item] = await repository.upsertItems([
    {
      sessionId: options.sessionId ?? null,
      memoryType: "task_outcome",
      scope: options.scope ?? "workspace",
      content,
      jsonValue: {
        taskDescription: outcome.taskDescription,
        approach: outcome.approach,
        result: outcome.result,
        failureReason: outcome.failureReason ?? null,
        toolsUsed: outcome.toolsUsed,
        providerUsed: outcome.providerUsed,
        modelUsed: outcome.modelUsed,
        duration: outcome.duration,
        timestamp: outcome.timestamp,
      },
      tags: [
        "__task_outcome",
        "task-outcome",
        outcome.result,
        ...(outcome.toolsUsed.slice(0, 4).map((tool) => `tool:${tool}`)),
      ],
      sourceType: "system",
      sourceRef: "system:task-outcome",
      confidence: outcome.result === "failure" ? 0.9 : outcome.result === "partial" ? 0.8 : 0.72,
      salience: outcome.result === "failure" ? 0.88 : 0.72,
      volatility: "event",
      observedAt: outcome.timestamp,
    },
  ]);
  return item;
}

export async function initializeMemoryInfrastructure(
  config: MemoryConfig = defaultMemoryConfig(),
): Promise<void> {
  const repository = createMemoryRepository(config);
  try {
    await repository.listSessions();
  } finally {
    await repository.close?.();
  }
}

function upsertById<T extends { id: string }>(values: T[], next: T): T[] {
  const index = values.findIndex((value) => value.id === next.id);
  if (index === -1) {
    return [next, ...values];
  }
  return values.map((value, currentIndex) => (currentIndex === index ? next : value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function getStoreEdges(store: MemoryStoreData): MemoryEdge[] {
  return Array.isArray(store.edges) ? store.edges : [];
}

function buildEdgeKey(edge: MemoryEdge): string {
  return `${edge.fromId}::${edge.toId}::${edge.relation}`;
}
