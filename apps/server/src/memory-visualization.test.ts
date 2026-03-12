import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryEdge, MemoryItem, MemoryPromptContext, MemorySession } from "@ember/core";

import { clearMemoryRetrievalTraces, listMemoryRetrievalTraces, recordMemoryRetrievalTrace } from "./memory-traces.js";
import { buildMemoryGraph, buildMemoryOverview } from "./memory-visualization.js";

function makeReplayState() {
  return {
    status: "idle" as const,
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

function makeItem(overrides: Partial<MemoryItem> & Pick<MemoryItem, "id" | "content" | "memoryType" | "scope" | "sourceType">): MemoryItem {
  return {
    sessionId: null,
    createdAt: "2026-03-12T10:00:00.000Z",
    updatedAt: "2026-03-12T10:00:00.000Z",
    observedAt: "2026-03-12T10:00:00.000Z",
    jsonValue: null,
    tags: [],
    sourceRef: null,
    confidence: 0.8,
    salience: 0.75,
    volatility: "stable",
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    supersededById: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<MemorySession> & Pick<MemorySession, "id" | "summary">): MemorySession {
  return {
    conversationId: overrides.id,
    startedAt: "2026-03-12T09:00:00.000Z",
    endedAt: null,
    topics: [],
    messageCount: 4,
    lastMessageAt: "2026-03-12T10:00:00.000Z",
    ...overrides,
  };
}

function makePromptContext(memoryIds: string[]): MemoryPromptContext {
  return {
    text: `Persistent memory:\n${memoryIds.map((id) => `- ${id}`).join("\n")}`,
    totalChars: 48,
    results: memoryIds.map((id, index) => ({
      item: makeItem({
        id,
        content: `Memory ${id}`,
        memoryType: index === 0 ? "user_profile" : "world_fact",
        scope: index === 0 ? "user" : "global",
        sourceType: index === 0 ? "user_message" : "web_page",
        tags: ["shared"],
      }),
      score: 0.82 - index * 0.1,
      matchedTerms: [],
      cueMatches: [],
      reason: "semantic similarity: 0.82",
    })),
  };
}

test("recordMemoryRetrievalTrace stores recent retrieval injections", () => {
  clearMemoryRetrievalTraces();

  recordMemoryRetrievalTrace({
    conversationId: "conv_trace",
    query: {
      text: "When is my birthday?",
      activeRole: "coordinator",
      workspaceTopics: ["profile"],
    },
    now: "2026-03-12T12:00:00.000Z",
    memoryContext: makePromptContext(["mem_a", "mem_b"]),
  });

  const traces = listMemoryRetrievalTraces(8);
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.conversationId, "conv_trace");
  assert.equal(traces[0]?.kind, "persistent");
  assert.equal(traces[0]?.results.length, 2);
  assert.equal(traces[0]?.queryCues.activeRole, "coordinator");
  assert.match(traces[0]?.promptText ?? "", /Persistent memory/);
});

test("buildMemoryOverview exposes stale memories and trace counts", () => {
  const items: MemoryItem[] = [
    makeItem({
      id: "mem_session",
      sessionId: "sess_archive",
      content: "Archived session summary.",
      memoryType: "episode_summary",
      scope: "workspace",
      sourceType: "session_summary",
    }),
    makeItem({
      id: "mem_profile",
      content: "User date of birth is 1997-06-16.",
      memoryType: "user_profile",
      scope: "user",
      sourceType: "user_message",
      jsonValue: {
        dateOfBirth: "1997-06-16",
        approvalStatus: "approved",
        approvedAt: "2026-03-12T09:00:00.000Z",
        _memory: {
          reinforcementCount: 2,
          lastReinforcedAt: "2026-03-12T10:00:00.000Z",
          revalidationDueAt: null,
        },
      },
    }),
    makeItem({
      id: "mem_world",
      content: "Transit fares increased for a temporary pilot.",
      memoryType: "world_fact",
      scope: "global",
      sourceType: "web_page",
      sourceRef: "https://news.example.test/transit",
      volatility: "volatile",
      validUntil: "2026-03-05T00:00:00.000Z",
      jsonValue: {
        _memory: {
          reinforcementCount: 1,
          lastReinforcedAt: "2026-03-02T00:00:00.000Z",
          revalidationDueAt: "2026-03-03T00:00:00.000Z",
        },
      },
    }),
  ];
  const sessions = [
    makeSession({
      id: "sess_archive",
      summary: "Archived implementation session.",
      endedAt: "2026-03-12T11:00:00.000Z",
    }),
  ];
  clearMemoryRetrievalTraces();
  recordMemoryRetrievalTrace({
    conversationId: "conv_trace",
    query: {
      text: "What changed in transit?",
      activeRole: "coordinator",
      preferredSourceTypes: ["web_page"],
    },
    now: "2026-03-12T12:00:00.000Z",
    memoryContext: makePromptContext(["mem_world"]),
  });

  const overview = buildMemoryOverview({
    items,
    sessions,
    edges: [],
    traces: listMemoryRetrievalTraces(8),
    maintenance: {
      replay: makeReplayState(),
    },
    now: "2026-03-12T12:00:00.000Z",
  });

  assert.equal(overview.summary.totalMemories, 2);
  assert.equal(overview.sessionMemories.length, 0);
  assert.equal(overview.sessions.length, 0);
  assert.equal(overview.summary.staleMemories, 1);
  assert.equal(overview.summary.recentTraceCount, 1);
  assert.equal(overview.summary.explicitEdgeCount, 0);
  assert.equal(overview.maintenance.replay.status, "idle");
  assert.equal(overview.staleMemories[0]?.id, "mem_world");
  assert.equal(overview.profileMemories[0]?.approvalStatus, "approved");
  assert.equal(overview.profileMemories[0]?.approvedAt, "2026-03-12T09:00:00.000Z");
});

test("buildMemoryGraph links co-fired correlated memories into visible clusters", () => {
  const items: MemoryItem[] = [
    makeItem({
      id: "mem_archive",
      sessionId: "sess_same",
      content: "Session archive summary.",
      memoryType: "episode_summary",
      scope: "workspace",
      sourceType: "session_summary",
      tags: ["session"],
    }),
    makeItem({
      id: "mem_pref",
      sessionId: "sess_same",
      content: "User prefers concise engineering responses.",
      memoryType: "user_preference",
      scope: "user",
      sourceType: "user_message",
      tags: ["style", "engineering"],
      jsonValue: {
        _memory: {
          reinforcementCount: 3,
          lastReinforcedAt: "2026-03-12T11:40:00.000Z",
          revalidationDueAt: null,
        },
      },
    }),
    makeItem({
      id: "mem_workspace",
      sessionId: "sess_same",
      content: "Workspace uses SQLite-backed long-term memory.",
      memoryType: "project_fact",
      scope: "workspace",
      sourceType: "assistant_message",
      tags: ["engineering", "sqlite"],
    }),
  ];
  clearMemoryRetrievalTraces();
  recordMemoryRetrievalTrace({
    conversationId: "conv_same",
    query: {
      text: "How should Ember answer and what backend does it use?",
      activeRole: "director",
      recentToolNames: ["git_inspect"],
      workspaceTopics: ["engineering", "sqlite"],
      taskState: "blocked",
    },
    now: "2026-03-12T12:00:00.000Z",
    memoryContext: {
      text: "Persistent memory:\n- User prefers concise engineering responses.\n- Workspace uses SQLite-backed long-term memory.",
      totalChars: 128,
      results: [
        {
          item: items[1]!,
          score: 0.92,
          matchedTerms: ["engineering"],
          cueMatches: ["role:director", "tool:git_inspect"],
          reason: "matched terms: engineering",
        },
        {
          item: items[2]!,
          score: 0.88,
          matchedTerms: ["sqlite"],
          cueMatches: ["topic:engineering"],
          reason: "matched terms: sqlite",
        },
      ],
    },
  });

  const graph = buildMemoryGraph({
    items,
    edges: [],
    sessions: [makeSession({ id: "sess_same", summary: "Workspace memory session." })],
    traces: listMemoryRetrievalTraces(8),
    limit: 40,
    now: "2026-03-12T12:00:00.000Z",
  });

  assert.equal(graph.nodes.length, 2);
  assert.ok(graph.nodes.every((node) => node.id !== "mem_archive"));
  assert.ok(graph.links.length >= 1);
  assert.ok(graph.links[0]!.reasons.some((reason) => reason === "session" || reason === "co-fire"));
  assert.ok(graph.nodes.some((node) => node.activation > 0));
});

test("buildMemoryGraph surfaces explicit replay links and procedure nodes", () => {
  const items: MemoryItem[] = [
    makeItem({
      id: "mem_constraint",
      sessionId: "sess_a",
      content: "Persistent project constraint: Use pnpm only for workspace commands.",
      memoryType: "project_fact",
      scope: "workspace",
      sourceType: "system",
      tags: ["project-constraint", "pnpm"],
    }),
    makeItem({
      id: "mem_episode",
      sessionId: "sess_b",
      content: "Keep using pnpm for the workspace build; do not use npm here.",
      memoryType: "warning_or_constraint",
      scope: "workspace",
      sourceType: "assistant_message",
      tags: ["project-constraint", "pnpm"],
    }),
    makeItem({
      id: "mem_procedure",
      sessionId: "sess_c",
      content: "Learned procedure. Trigger: When handling TypeScript build failures.",
      memoryType: "procedure",
      scope: "workspace",
      sourceType: "session_summary",
      tags: ["procedure", "typescript"],
      jsonValue: {
        published: true,
        successCount: 2,
      },
    }),
  ];
  const edges: MemoryEdge[] = [
    { fromId: "mem_episode", toId: "mem_constraint", relation: "reinforces" },
    { fromId: "mem_episode", toId: "mem_constraint", relation: "about_project" },
  ];

  const graph = buildMemoryGraph({
    items,
    sessions: [
      makeSession({ id: "sess_a", summary: "Constraint session." }),
      makeSession({ id: "sess_b", summary: "Episode session." }),
      makeSession({ id: "sess_c", summary: "Procedure session." }),
    ],
    edges,
    traces: [],
    limit: 40,
    now: "2026-03-12T12:00:00.000Z",
  });

  assert.ok(graph.nodes.some((node) => node.memoryType === "procedure"));
  const explicitLink = graph.links.find(
    (link) =>
      (link.source === "mem_constraint" && link.target === "mem_episode") ||
      (link.source === "mem_episode" && link.target === "mem_constraint"),
  );
  assert.ok(explicitLink);
  assert.ok(explicitLink?.reasons.includes("edge:reinforces"));
  assert.ok(explicitLink?.reasons.includes("edge:about_project"));
});
