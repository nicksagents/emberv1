import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { getDataRoot, readJsonFile } from "../store";
import { createEmptyMemoryStoreData, createMemoryItem, createMemorySession, defaultMemoryConfig } from "./defaults";
import { buildEmbedding, cosineSimilarity, parseEmbedding, serializeEmbedding } from "./embeddings";
import { extendMemoryValidity, getItemInternalMetadata, mergeMemoryInternalMetadata } from "./metadata";
import { buildMemoryPromptContext, scoreMemoryItems } from "./scoring";
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
  MemoryStoreData,
  MemoryWriteCandidate,
} from "./types";

type MemorySessionRow = {
  id: string;
  conversation_id: string | null;
  started_at: string;
  ended_at: string | null;
  summary: string;
  topics_json: string;
  message_count: number;
  last_message_at: string | null;
};

type MemoryItemRow = {
  id: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  observed_at: string | null;
  memory_type: MemoryItem["memoryType"];
  scope: MemoryItem["scope"];
  content: string;
  json_value: string | null;
  tags_json: string;
  source_type: MemoryItem["sourceType"];
  source_ref: string | null;
  confidence: number;
  salience: number;
  volatility: MemoryItem["volatility"];
  valid_from: string | null;
  valid_until: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
};

type MemoryEmbeddingRow = {
  memory_item_id: string;
  embedding_json: string;
};

type MemoryEdgeRow = {
  from_id: string;
  to_id: string;
  relation: string;
};

type SqlParam = string | number | bigint | Uint8Array | null;

const require = createRequire(import.meta.url);
type SqliteModule = typeof import("node:sqlite");
type DatabaseSyncCtor = SqliteModule["DatabaseSync"];
type DatabaseSyncInstance = InstanceType<DatabaseSyncCtor>;
let cachedDatabaseSync: DatabaseSyncCtor | null = null;

function resolveDatabaseSync(): DatabaseSyncCtor {
  if (cachedDatabaseSync) {
    return cachedDatabaseSync;
  }
  try {
    const sqliteModule = require("node:sqlite") as SqliteModule;
    cachedDatabaseSync = sqliteModule.DatabaseSync;
    return cachedDatabaseSync;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite memory backend requires Node.js runtime support for node:sqlite (Node 22+). Original error: ${message}`,
    );
  }
}

export function isNodeSqliteAvailable(): boolean {
  try {
    resolveDatabaseSync();
    return true;
  } catch {
    return false;
  }
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getMemorySqlitePath(config: MemoryConfig = defaultMemoryConfig()): string {
  return path.join(getDataRoot(), config.storage.sqliteFileName);
}

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly dbPath: string;
  private readonly db: DatabaseSyncInstance;
  private readonly initPromise: Promise<void>;
  private closed = false;
  private readonly ftsAvailable: boolean;

  constructor(private readonly config: MemoryConfig = defaultMemoryConfig()) {
    this.dbPath = getMemorySqlitePath(config);
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const DatabaseSync = resolveDatabaseSync();
    this.db = new DatabaseSync(this.dbPath);
    this.ftsAvailable = this.initializeSchema();
    this.initPromise = this.initializeData();
  }

  async listSessions(): Promise<MemorySession[]> {
    await this.ready();
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, started_at, ended_at, summary, topics_json, message_count, last_message_at
         FROM memory_sessions
         ORDER BY started_at DESC`,
      )
      .all() as MemorySessionRow[];
    return rows.map(mapSessionRow);
  }

  async getSession(id: string): Promise<MemorySession | null> {
    await this.ready();
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, started_at, ended_at, summary, topics_json, message_count, last_message_at
         FROM memory_sessions
         WHERE id = ?`,
      )
      .get(id) as MemorySessionRow | undefined;
    return row ? mapSessionRow(row) : null;
  }

  async upsertSession(session: MemorySession): Promise<MemorySession> {
    await this.ready();
    const next = createMemorySession(session);
    this.db
      .prepare(
        `INSERT INTO memory_sessions (
           id, conversation_id, started_at, ended_at, summary, topics_json, message_count, last_message_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           summary = excluded.summary,
           topics_json = excluded.topics_json,
           message_count = excluded.message_count,
           last_message_at = excluded.last_message_at`,
      )
      .run(
        next.id,
        next.conversationId,
        next.startedAt,
        next.endedAt,
        next.summary,
        JSON.stringify(next.topics),
        next.messageCount,
        next.lastMessageAt,
      );
    return next;
  }

  async listItems(filter: MemoryItemFilter = {}): Promise<MemoryItem[]> {
    await this.ready();
    const { clause, params } = buildItemWhereClause(filter);
    const rows = this.db
      .prepare(
        `SELECT
           id, session_id, created_at, updated_at, observed_at, memory_type, scope,
           content, json_value, tags_json, source_type, source_ref, confidence,
           salience, volatility, valid_from, valid_until, supersedes_id, superseded_by_id
         FROM memory_items
         ${clause}
         ORDER BY updated_at DESC`,
      )
      .all(...params) as MemoryItemRow[];
    return rows.map(mapItemRow);
  }

  async listEdges(filter: MemoryEdgeFilter = {}): Promise<MemoryEdge[]> {
    await this.ready();
    const { clause, params } = buildEdgeWhereClause(filter);
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, relation
         FROM memory_edges
         ${clause}
         ORDER BY from_id, to_id, relation`,
      )
      .all(...params) as MemoryEdgeRow[];
    return rows.map(mapEdgeRow);
  }

  async getItem(id: string): Promise<MemoryItem | null> {
    await this.ready();
    const row = this.db
      .prepare(
        `SELECT
           id, session_id, created_at, updated_at, observed_at, memory_type, scope,
           content, json_value, tags_json, source_type, source_ref, confidence,
           salience, volatility, valid_from, valid_until, supersedes_id, superseded_by_id
         FROM memory_items
         WHERE id = ?`,
      )
      .get(id) as MemoryItemRow | undefined;
    return row ? mapItemRow(row) : null;
  }

  async upsertItems(candidates: MemoryWriteCandidate[]): Promise<MemoryItem[]> {
    await this.ready();
    const now = new Date().toISOString();
    const written: MemoryItem[] = [];
    this.db.exec("BEGIN");
    try {
      for (const candidate of candidates) {
        const item = createMemoryItem(candidate, createId("mem"), now);
        this.db
          .prepare(
            `INSERT INTO memory_items (
               id, session_id, created_at, updated_at, observed_at, memory_type, scope,
               content, json_value, tags_json, source_type, source_ref, confidence,
               salience, volatility, valid_from, valid_until, supersedes_id, superseded_by_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.id,
            item.sessionId,
            item.createdAt,
            item.updatedAt,
            item.observedAt,
            item.memoryType,
            item.scope,
            item.content,
            item.jsonValue ? JSON.stringify(item.jsonValue) : null,
            JSON.stringify(item.tags),
            item.sourceType,
            item.sourceRef,
            item.confidence,
            item.salience,
            item.volatility,
            item.validFrom,
            item.validUntil,
            item.supersedesId,
            item.supersededById,
          );
        this.writeFtsRow(item);
        if (item.supersedesId) {
          this.db
            .prepare(
              `UPDATE memory_items
               SET superseded_by_id = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(item.id, now, item.supersedesId);
        }
        this.writeEmbeddingRow(item, now);
        written.push(item);
      }
      this.db.exec("COMMIT");
      return written;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async upsertEdges(edges: MemoryEdge[]): Promise<MemoryEdge[]> {
    await this.ready();
    if (edges.length === 0) {
      return [];
    }

    this.db.exec("BEGIN");
    try {
      for (const edge of edges) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_edges (from_id, to_id, relation)
             VALUES (?, ?, ?)`,
          )
          .run(edge.fromId, edge.toId, edge.relation);
      }
      this.db.exec("COMMIT");
      return edges;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async forgetItem(
    id: string,
    options: { reason?: string | null; now?: string } = {},
  ): Promise<MemoryItem | null> {
    await this.ready();
    const existing = await this.getItem(id);
    if (!existing) {
      return null;
    }

    const now = options.now ?? new Date().toISOString();
    const currentJsonValue =
      existing.jsonValue && typeof existing.jsonValue === "object" && !Array.isArray(existing.jsonValue)
        ? existing.jsonValue
        : {};
    const nextJsonValue = {
      ...currentJsonValue,
      forgotten: true,
      forgottenAt: now,
      forgetReason: options.reason ?? null,
    };
    const nextTags = [...new Set([...existing.tags, "forgotten"])];
    const validUntil = existing.validUntil ?? now;

    this.db
      .prepare(
        `UPDATE memory_items
         SET updated_at = ?, valid_until = ?, json_value = ?, tags_json = ?
         WHERE id = ?`,
      )
      .run(
        now,
        validUntil,
        JSON.stringify(nextJsonValue),
        JSON.stringify(nextTags),
        id,
      );

    return await this.getItem(id);
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    await this.ready();
    const candidates = this.loadSearchCandidates(query);
    const semanticSimilarityById = this.config.embeddings.enabled
      ? this.loadSemanticSimilarity(query)
      : undefined;
    return scoreMemoryItems(candidates, query, this.config, { semanticSimilarityById });
  }

  async buildPromptContext(query: MemorySearchQuery): Promise<MemoryPromptContext> {
    const results = await this.search(query);
    return buildMemoryPromptContext(results, this.config, {
      now: query.now,
      maxInjectedItems: query.maxInjectedItems,
      maxInjectedChars: query.maxInjectedChars,
    });
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
    await this.ready();
    const existing = await this.getItem(id);
    if (!existing || existing.supersededById) {
      return null;
    }

    const now = options.now ?? new Date().toISOString();
    const meta = getItemInternalMetadata(existing);
    const reinforcementDelta =
      options.reinforcementDelta === undefined ? 1 : Math.max(0, Math.round(options.reinforcementDelta));
    const retrievalSuccessDelta =
      options.retrievalSuccessDelta === undefined
        ? 0
        : Math.max(0, Math.round(options.retrievalSuccessDelta));
    const nextJsonValue = mergeMemoryInternalMetadata(existing.jsonValue, {
      reinforcementCount: meta.reinforcementCount + reinforcementDelta,
      lastReinforcedAt: reinforcementDelta > 0 ? now : meta.lastReinforcedAt,
      revalidationDueAt:
        options.revalidationDueAt === undefined ? meta.revalidationDueAt : options.revalidationDueAt,
      retrievalSuccessCount: meta.retrievalSuccessCount + retrievalSuccessDelta,
      lastRetrievedAt:
        options.lastRetrievedAt === undefined ? meta.lastRetrievedAt : options.lastRetrievedAt,
    });
    const nextConfidence = clamp01(existing.confidence + (options.confidenceDelta ?? 0.02));
    const nextSalience = clamp01(existing.salience + (options.salienceDelta ?? 0.03));
    const nextValidUntil =
      options.extendValidity === true
        ? extendMemoryValidity(existing.validUntil, existing.volatility, now)
        : existing.validUntil;

    this.db
      .prepare(
        `UPDATE memory_items
         SET updated_at = ?, confidence = ?, salience = ?, valid_until = ?, json_value = ?
         WHERE id = ?`,
      )
      .run(
        now,
        nextConfidence,
        nextSalience,
        nextValidUntil,
        JSON.stringify(nextJsonValue),
        id,
      );

    return await this.getItem(id);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  private async ready(): Promise<void> {
    if (this.closed) {
      throw new Error("SQLite memory repository is closed.");
    }
    await this.initPromise;
  }

  private initializeSchema(): boolean {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        last_message_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        observed_at TEXT,
        memory_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        json_value TEXT,
        tags_json TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        confidence REAL NOT NULL,
        salience REAL NOT NULL,
        volatility TEXT NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        supersedes_id TEXT,
        superseded_by_id TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_item_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_items_session_id ON memory_items(session_id);
      CREATE INDEX IF NOT EXISTS idx_memory_items_scope ON memory_items(scope);
      CREATE INDEX IF NOT EXISTS idx_memory_items_memory_type ON memory_items(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memory_items_source_type ON memory_items(source_type);
      CREATE INDEX IF NOT EXISTS idx_memory_items_observed_at ON memory_items(observed_at);
      CREATE INDEX IF NOT EXISTS idx_memory_items_valid_until ON memory_items(valid_until);
      CREATE INDEX IF NOT EXISTS idx_memory_items_superseded_by_id ON memory_items(superseded_by_id);
      CREATE INDEX IF NOT EXISTS idx_memory_sessions_conversation_id ON memory_sessions(conversation_id);
    `);

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
          id UNINDEXED,
          content,
          tags,
          source_ref
        );
      `);
      return true;
    } catch {
      return false;
    }
  }

  private async initializeData(): Promise<void> {
    const sessionCount = this.db.prepare("SELECT COUNT(*) AS count FROM memory_sessions").get() as { count: number };
    const itemCount = this.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as { count: number };
    if (sessionCount.count > 0 || itemCount.count > 0) {
      this.backfillEmbeddings();
      return;
    }

    const fileStore = await readJsonFile<MemoryStoreData>(
      this.config.storage.fileName,
      createEmptyMemoryStoreData(),
    );
    if (fileStore.sessions.length === 0 && fileStore.items.length === 0) {
      return;
    }

    this.db.exec("BEGIN");
    try {
      for (const session of fileStore.sessions) {
        const next = createMemorySession(session);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_sessions (
               id, conversation_id, started_at, ended_at, summary, topics_json, message_count, last_message_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            next.id,
            next.conversationId,
            next.startedAt,
            next.endedAt,
            next.summary,
            JSON.stringify(next.topics),
            next.messageCount,
            next.lastMessageAt,
          );
      }

      for (const item of fileStore.items) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_items (
               id, session_id, created_at, updated_at, observed_at, memory_type, scope,
               content, json_value, tags_json, source_type, source_ref, confidence,
               salience, volatility, valid_from, valid_until, supersedes_id, superseded_by_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.id,
            item.sessionId,
            item.createdAt,
            item.updatedAt,
            item.observedAt,
            item.memoryType,
            item.scope,
            item.content,
            item.jsonValue ? JSON.stringify(item.jsonValue) : null,
            JSON.stringify(item.tags),
            item.sourceType,
            item.sourceRef,
            item.confidence,
            item.salience,
            item.volatility,
            item.validFrom,
            item.validUntil,
            item.supersedesId,
            item.supersededById,
          );
        this.writeFtsRow(item);
        this.writeEmbeddingRow(item, item.updatedAt);
      }

      for (const edge of Array.isArray(fileStore.edges) ? fileStore.edges : []) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_edges (from_id, to_id, relation)
             VALUES (?, ?, ?)`,
          )
          .run(edge.fromId, edge.toId, edge.relation);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.backfillEmbeddings();
  }

  private writeFtsRow(item: MemoryItem): void {
    if (!this.ftsAvailable) {
      return;
    }
    this.db.prepare("DELETE FROM memory_items_fts WHERE id = ?").run(item.id);
    this.db
      .prepare("INSERT INTO memory_items_fts (id, content, tags, source_ref) VALUES (?, ?, ?, ?)")
      .run(item.id, item.content, item.tags.join(" "), item.sourceRef ?? "");
  }

  private writeEmbeddingRow(item: MemoryItem, updatedAt: string): void {
    if (!this.config.embeddings.enabled) {
      return;
    }
    const source = `${item.content}\n${item.tags.join(" ")}\n${item.sourceRef ?? ""}`;
    const embedding = buildEmbedding(source, this.config);
    this.db
      .prepare(
        `INSERT INTO memory_embeddings (memory_item_id, model, embedding_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_item_id) DO UPDATE SET
           model = excluded.model,
           embedding_json = excluded.embedding_json,
           updated_at = excluded.updated_at`,
      )
      .run(item.id, this.config.embeddings.model, serializeEmbedding(embedding), updatedAt);
  }

  private backfillEmbeddings(): void {
    if (!this.config.embeddings.enabled) {
      return;
    }

    const rows = this.db
      .prepare(
        `SELECT
           i.id, i.session_id, i.created_at, i.updated_at, i.observed_at, i.memory_type, i.scope,
           i.content, i.json_value, i.tags_json, i.source_type, i.source_ref, i.confidence,
           i.salience, i.volatility, i.valid_from, i.valid_until, i.supersedes_id, i.superseded_by_id
         FROM memory_items i
         LEFT JOIN memory_embeddings e ON e.memory_item_id = i.id
         WHERE e.memory_item_id IS NULL`,
      )
      .all() as MemoryItemRow[];

    for (const row of rows) {
      const item = mapItemRow(row);
      this.writeEmbeddingRow(item, item.updatedAt);
    }
  }

  private loadSearchCandidates(query: MemorySearchQuery): MemoryItem[] {
    const searchText = query.text.trim();
    const lexicalCandidateIds = searchText ? this.findCandidateIds(searchText) : [];
    const semanticCandidateIds =
      searchText && this.config.embeddings.enabled ? this.findSemanticCandidateIds(query) : [];
    const candidateIds = [...new Set([...lexicalCandidateIds, ...semanticCandidateIds])];
    const limit = Math.max(query.maxResults ?? this.config.retrieval.maxResults, 8) * 8;
    const { clause, params } = buildSearchWhereClause(query, candidateIds.length > 0 ? candidateIds : null);
    const rows = this.db
      .prepare(
        `SELECT
           id, session_id, created_at, updated_at, observed_at, memory_type, scope,
           content, json_value, tags_json, source_type, source_ref, confidence,
           salience, volatility, valid_from, valid_until, supersedes_id, superseded_by_id
         FROM memory_items
         ${clause}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as MemoryItemRow[];

    if (rows.length > 0 || !searchText) {
      return rows.map(mapItemRow);
    }

    const fallbackRows = this.db
      .prepare(
        `SELECT
           id, session_id, created_at, updated_at, observed_at, memory_type, scope,
           content, json_value, tags_json, source_type, source_ref, confidence,
           salience, volatility, valid_from, valid_until, supersedes_id, superseded_by_id
         FROM memory_items
         WHERE superseded_by_id IS NULL
         ORDER BY salience DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as MemoryItemRow[];
    return fallbackRows.map(mapItemRow);
  }

  private findCandidateIds(text: string): string[] {
    const exactMatches = this.db
      .prepare("SELECT id FROM memory_items WHERE content LIKE ? OR source_ref LIKE ? LIMIT 64")
      .all(`%${text}%`, `%${text}%`) as Array<{ id: string }>;

    const ids = new Set(exactMatches.map((row) => row.id));

    if (this.ftsAvailable) {
      const matchQuery = text
        .split(/[^a-zA-Z0-9]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .join(" OR ");
      if (matchQuery) {
        const ftsMatches = this.db
          .prepare("SELECT id FROM memory_items_fts WHERE memory_items_fts MATCH ? LIMIT 64")
          .all(matchQuery) as Array<{ id: string }>;
        for (const row of ftsMatches) {
          ids.add(row.id);
        }
      }
    }

    return [...ids];
  }

  private findSemanticCandidateIds(query: MemorySearchQuery): string[] {
    const searchText = query.text.trim();
    if (!searchText) {
      return [];
    }

    const queryEmbedding = buildEmbedding(searchText, this.config);
    const { clause, params } = buildEmbeddingCandidateWhereClause(query);
    const rows = this.db
      .prepare(
        `SELECT e.memory_item_id, e.embedding_json
         FROM memory_embeddings e
         JOIN memory_items i ON i.id = e.memory_item_id
         ${clause}`,
      )
      .all(...params) as MemoryEmbeddingRow[];

    return rows
      .map((row) => ({
        id: row.memory_item_id,
        similarity: cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding_json)),
      }))
      .filter((entry) => entry.similarity >= Math.max(0.12, this.config.retrieval.minScore * 0.5))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, this.config.embeddings.maxCandidates)
      .map((entry) => entry.id);
  }

  private loadSemanticSimilarity(query: MemorySearchQuery): Map<string, number> {
    const searchText = query.text.trim();
    if (!searchText) {
      return new Map();
    }

    const queryEmbedding = buildEmbedding(searchText, this.config);
    const { clause, params } = buildEmbeddingCandidateWhereClause(query);
    const rows = this.db
      .prepare(
        `SELECT e.memory_item_id, e.embedding_json
         FROM memory_embeddings e
         JOIN memory_items i ON i.id = e.memory_item_id
         ${clause}`,
      )
      .all(...params) as MemoryEmbeddingRow[];

    return new Map(
      rows
        .map((row) => [row.memory_item_id, cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding_json))] as const)
        .filter(([, similarity]) => similarity > 0),
    );
  }
}

function buildItemWhereClause(filter: MemoryItemFilter): { clause: string; params: SqlParam[] } {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (!filter.includeSuperseded) {
    conditions.push("superseded_by_id IS NULL");
  }
  if (filter.sessionId !== undefined) {
    if (filter.sessionId === null) {
      conditions.push("session_id IS NULL");
    } else {
      conditions.push("session_id = ?");
      params.push(filter.sessionId);
    }
  }
  if (filter.scope !== undefined && filter.scope !== null) {
    conditions.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.memoryType !== undefined && filter.memoryType !== null) {
    conditions.push("memory_type = ?");
    params.push(filter.memoryType);
  }
  if (filter.sourceType !== undefined && filter.sourceType !== null) {
    conditions.push("source_type = ?");
    params.push(filter.sourceType);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function buildEdgeWhereClause(filter: MemoryEdgeFilter): { clause: string; params: SqlParam[] } {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filter.fromId !== undefined) {
    if (filter.fromId === null) {
      conditions.push("from_id IS NULL");
    } else {
      conditions.push("from_id = ?");
      params.push(filter.fromId);
    }
  }
  if (filter.toId !== undefined) {
    if (filter.toId === null) {
      conditions.push("to_id IS NULL");
    } else {
      conditions.push("to_id = ?");
      params.push(filter.toId);
    }
  }
  if (filter.relation !== undefined && filter.relation !== null) {
    conditions.push("relation = ?");
    params.push(filter.relation);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function buildSearchWhereClause(
  query: MemorySearchQuery,
  candidateIds: string[] | null,
): { clause: string; params: SqlParam[] } {
  const conditions: string[] = ["superseded_by_id IS NULL"];
  const params: SqlParam[] = [];
  const slicedCandidateIds = candidateIds?.slice(0, 64) ?? null;

  if (query.activeSessionId) {
    conditions.push("(session_id IS NULL OR session_id != ?)");
    params.push(query.activeSessionId);
  }
  if (query.scopes && query.scopes.length > 0) {
    conditions.push(`scope IN (${query.scopes.map(() => "?").join(", ")})`);
    params.push(...query.scopes);
  }
  if (query.memoryTypes && query.memoryTypes.length > 0) {
    conditions.push(`memory_type IN (${query.memoryTypes.map(() => "?").join(", ")})`);
    params.push(...query.memoryTypes);
  }
  if (query.sourceTypes && query.sourceTypes.length > 0) {
    conditions.push(`source_type IN (${query.sourceTypes.map(() => "?").join(", ")})`);
    params.push(...query.sourceTypes);
  }
  if (slicedCandidateIds && slicedCandidateIds.length > 0) {
    conditions.push(`id IN (${slicedCandidateIds.map(() => "?").join(", ")})`);
    params.push(...slicedCandidateIds);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function buildEmbeddingCandidateWhereClause(
  query: MemorySearchQuery,
): { clause: string; params: SqlParam[] } {
  const conditions: string[] = ["i.superseded_by_id IS NULL"];
  const params: SqlParam[] = [];

  if (query.activeSessionId) {
    conditions.push("(i.session_id IS NULL OR i.session_id != ?)");
    params.push(query.activeSessionId);
  }
  if (query.scopes && query.scopes.length > 0) {
    conditions.push(`i.scope IN (${query.scopes.map(() => "?").join(", ")})`);
    params.push(...query.scopes);
  }
  if (query.memoryTypes && query.memoryTypes.length > 0) {
    conditions.push(`i.memory_type IN (${query.memoryTypes.map(() => "?").join(", ")})`);
    params.push(...query.memoryTypes);
  }
  if (query.sourceTypes && query.sourceTypes.length > 0) {
    conditions.push(`i.source_type IN (${query.sourceTypes.map(() => "?").join(", ")})`);
    params.push(...query.sourceTypes);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function mapSessionRow(row: MemorySessionRow): MemorySession {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    topics: safeParseStringArray(row.topics_json),
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
  };
}

function mapEdgeRow(row: MemoryEdgeRow): MemoryEdge {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as MemoryEdge["relation"],
  };
}

function mapItemRow(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    observedAt: row.observed_at,
    memoryType: row.memory_type,
    scope: row.scope,
    content: row.content,
    jsonValue: row.json_value ? safeParseRecord(row.json_value) : null,
    tags: safeParseStringArray(row.tags_json),
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    confidence: row.confidence,
    salience: row.salience,
    volatility: row.volatility,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
  };
}

function safeParseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function safeParseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
