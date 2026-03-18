import assert from "node:assert/strict";
import test from "node:test";

import type { Conversation } from "../types";
import { queryUnifiedMemory, type UnifiedMemoryQuery } from "./unified-query";
import type {
  MemoryEdge,
  MemoryEdgeFilter,
  MemoryItem,
  MemoryItemFilter,
  MemoryPromptContext,
  MemoryRepository,
  MemorySearchQuery,
  MemorySearchResult,
  MemorySession,
  MemoryWriteCandidate,
} from "./types";

class FakeMemoryRepository implements MemoryRepository {
  constructor(
    private readonly fixtures: {
      searchResults?: MemorySearchResult[];
      items?: MemoryItem[];
      edges?: MemoryEdge[];
      failGraph?: boolean;
    } = {},
  ) {}

  async listSessions(): Promise<MemorySession[]> { return []; }
  async getSession(_id: string): Promise<MemorySession | null> { return null; }
  async upsertSession(session: MemorySession): Promise<MemorySession> { return session; }
  async listItems(_filter?: MemoryItemFilter): Promise<MemoryItem[]> { return this.fixtures.items ?? []; }
  async listEdges(_filter?: MemoryEdgeFilter): Promise<MemoryEdge[]> {
    if (this.fixtures.failGraph) {
      throw new Error("graph unavailable");
    }
    return this.fixtures.edges ?? [];
  }
  async getItem(_id: string): Promise<MemoryItem | null> { return null; }
  async upsertItems(_candidates: MemoryWriteCandidate[]): Promise<MemoryItem[]> { return []; }
  async upsertEdges(edges: MemoryEdge[]): Promise<MemoryEdge[]> { return edges; }
  async forgetItem(_id: string): Promise<MemoryItem | null> { return null; }
  async reinforceItem(_id: string): Promise<MemoryItem | null> { return null; }
  async search(_query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    return this.fixtures.searchResults ?? [];
  }
  async buildPromptContext(_query: MemorySearchQuery): Promise<MemoryPromptContext> {
    return { text: "", totalChars: 0, results: [] };
  }
}

function makeMemoryItem(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: "mem_1",
    sessionId: null,
    createdAt: "2026-03-16T10:00:00.000Z",
    updatedAt: "2026-03-16T10:00:00.000Z",
    observedAt: null,
    memoryType: "project_fact",
    scope: "workspace",
    content: "default memory",
    jsonValue: null,
    tags: [],
    sourceType: "assistant_message",
    sourceRef: null,
    confidence: 0.8,
    salience: 0.7,
    volatility: "slow-changing",
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supersededById: null,
    ...overrides,
  };
}

function makeConversation(content: string): Conversation {
  return {
    id: "conv_1",
    title: "Auth planning",
    mode: "auto",
    createdAt: "2026-03-15T10:00:00.000Z",
    updatedAt: "2026-03-16T10:00:00.000Z",
    archivedAt: null,
    lastMessageAt: "2026-03-16T10:00:00.000Z",
    preview: "Discussed login flow",
    messageCount: 1,
    messages: [
      {
        id: "msg_1",
        role: "assistant",
        authorRole: "coordinator",
        mode: "auto",
        content,
        createdAt: "2026-03-16T10:00:00.000Z",
      },
    ],
  };
}

async function runQuery(
  query: UnifiedMemoryQuery,
  repo: MemoryRepository,
  conversations: Conversation[] = [],
) {
  return queryUnifiedMemory(query, repo, conversations);
}

test("queryUnifiedMemory returns flat-memory matches with source=flat", async () => {
  const repo = new FakeMemoryRepository({
    searchResults: [
      {
        item: makeMemoryItem({ id: "mem_flat", content: "Auth uses JWT refresh rotation." }),
        score: 0.91,
        matchedTerms: ["auth", "jwt"],
        cueMatches: [],
        reason: "lexical",
      },
    ],
  });
  const result = await runQuery(
    { query: "auth jwt", sources: ["flat"], maxResults: 5 },
    repo,
  );

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.source, "flat");
  assert.equal(result.items[0]?.key, "mem_flat");
});

test("queryUnifiedMemory returns session snippet matches with source=session", async () => {
  const repo = new FakeMemoryRepository();
  const result = await runQuery(
    { query: "login flow", sources: ["session"], maxResults: 5 },
    repo,
    [makeConversation("The login flow failed on OAuth callback handling.")],
  );

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.source, "session");
  assert.match(result.items[0]?.content ?? "", /OAuth callback/i);
});

test("queryUnifiedMemory merges multi-source results and ranks by relevance", async () => {
  const repo = new FakeMemoryRepository({
    searchResults: [
      {
        item: makeMemoryItem({ id: "flat_hi", content: "Critical auth migration checklist." }),
        score: 0.95,
        matchedTerms: [],
        cueMatches: [],
        reason: "score",
      },
    ],
    items: [
      makeMemoryItem({ id: "node_a", content: "Auth module" }),
      makeMemoryItem({ id: "node_b", content: "Database migration" }),
    ],
    edges: [{ fromId: "node_a", toId: "node_b", relation: "about_project" }],
  });
  const result = await runQuery(
    { query: "auth migration", sources: ["flat", "graph"], maxResults: 10 },
    repo,
  );

  assert.ok(result.items.length >= 2);
  const sources = new Set(result.items.map((item) => item.source));
  assert.ok(sources.has("flat"));
  assert.ok(sources.has("graph"));
  assert.ok(result.items[0]!.relevanceScore >= result.items[1]!.relevanceScore);
});

test("queryUnifiedMemory enforces token budget truncation", async () => {
  const repo = new FakeMemoryRepository({
    searchResults: [
      {
        item: makeMemoryItem({
          id: "long_1",
          content: "x".repeat(800),
        }),
        score: 0.9,
        matchedTerms: [],
        cueMatches: [],
        reason: "score",
      },
      {
        item: makeMemoryItem({
          id: "long_2",
          content: "y".repeat(800),
        }),
        score: 0.8,
        matchedTerms: [],
        cueMatches: [],
        reason: "score",
      },
    ],
  });
  const result = await runQuery(
    { query: "x", sources: ["flat"], maxResults: 10, maxTokens: 120 },
    repo,
  );

  assert.ok(result.items.length <= 1);
  assert.ok(result.totalTokens <= 120);
});

test("queryUnifiedMemory tolerates one failing source and returns others", async () => {
  const repo = new FakeMemoryRepository({
    failGraph: true,
    searchResults: [
      {
        item: makeMemoryItem({ id: "flat_ok", content: "Rollback plan documented." }),
        score: 0.77,
        matchedTerms: [],
        cueMatches: [],
        reason: "score",
      },
    ],
  });
  const result = await runQuery(
    { query: "rollback", sources: ["flat", "graph"], maxResults: 5 },
    repo,
  );

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.source, "flat");
});
