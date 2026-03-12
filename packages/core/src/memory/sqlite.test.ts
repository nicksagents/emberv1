import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultMemoryConfig } from "./defaults";
import { getItemInternalMetadata } from "./metadata";
import { createMemoryRepository } from "./store";

test("sqlite memory repository persists records across repository instances", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-sqlite-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";

    const repository = createMemoryRepository(config);
    await repository.upsertSession({
      id: "sess_sql_1",
      conversationId: "conv_sql_1",
      startedAt: "2026-03-12T18:00:00.000Z",
      endedAt: null,
      summary: "SQLite memory session.",
      topics: ["sqlite", "memory"],
      messageCount: 2,
      lastMessageAt: "2026-03-12T18:01:00.000Z",
    });
    await repository.upsertItems([
      {
        sessionId: "sess_sql_1",
        memoryType: "project_fact",
        scope: "workspace",
        content: "SQLite is the default long-term memory backend.",
        tags: ["sqlite", "backend"],
        sourceType: "system",
      },
    ]);
    await repository.close?.();

    const reopened = createMemoryRepository(config);
    const sessions = await reopened.listSessions();
    const items = await reopened.listItems();

    assert.equal(sessions.length, 1);
    assert.equal(items.length, 1);
    assert.match(items[0]?.content ?? "", /SQLite is the default/);
    await reopened.close?.();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sqlite search supports active-session exclusion and source-type filtering", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-sqlite-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    await repository.upsertItems([
      {
        sessionId: "sess_old",
        memoryType: "world_fact",
        scope: "global",
        content: "A law changed on 2026-03-01 according to the article.",
        tags: ["law", "article"],
        sourceType: "web_page",
        volatility: "event",
        observedAt: "2026-03-01T09:00:00.000Z",
      },
      {
        sessionId: "sess_live",
        memoryType: "world_fact",
        scope: "global",
        content: "Current session also mentions the law change.",
        tags: ["law"],
        sourceType: "user_message",
      },
    ]);

    const results = await repository.search({
      text: "What law changed?",
      activeSessionId: "sess_live",
      sourceTypes: ["web_page"],
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.item.sessionId, "sess_old");
    assert.equal(results[0]?.item.sourceType, "web_page");
    await repository.close?.();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sqlite search supports semantic recall for paraphrased queries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-sqlite-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    await repository.upsertItems([
      {
        sessionId: "sess_profile",
        memoryType: "user_profile",
        scope: "user",
        content: "User date of birth is 1997-06-16.",
        jsonValue: { dateOfBirth: "1997-06-16" },
        tags: ["birthday", "dob"],
        sourceType: "user_message",
        salience: 0.95,
        confidence: 0.98,
      },
    ]);

    const results = await repository.search({
      text: "When was I born?",
      activeSessionId: "sess_live",
    });

    assert.equal(results.length, 1);
    assert.match(results[0]?.item.content ?? "", /1997-06-16/);
    assert.match(results[0]?.reason ?? "", /semantic|matched/);
    await repository.close?.();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sqlite search uses structured cues to disambiguate similar episodic memories", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-sqlite-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    await repository.upsertItems([
      {
        sessionId: "sess_director",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Past fix for a blocked workflow.",
        tags: ["role:director", "tool:run_terminal_command", "topic:typescript", "topic:build", "blocked"],
        sourceType: "assistant_message",
        confidence: 0.82,
        salience: 0.82,
      },
      {
        sessionId: "sess_inspector",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Past fix for a blocked workflow.",
        tags: ["role:inspector", "tool:git_inspect", "topic:routing", "topic:prompt", "blocked"],
        sourceType: "assistant_message",
        confidence: 0.82,
        salience: 0.82,
      },
    ]);

    const directorResults = await repository.search({
      text: "How did we fix this issue?",
      activeRole: "director",
      recentToolNames: ["run_terminal_command"],
      workspaceTopics: ["typescript", "build"],
      taskState: "blocked",
      maxResults: 2,
    });
    const inspectorResults = await repository.search({
      text: "How did we fix this issue?",
      activeRole: "inspector",
      recentToolNames: ["git_inspect"],
      workspaceTopics: ["routing", "prompt"],
      taskState: "blocked",
      maxResults: 2,
    });

    assert.equal(directorResults[0]?.item.sessionId, "sess_director");
    assert.ok(directorResults[0]?.cueMatches.includes("tool:run_terminal_command"));
    assert.equal(inspectorResults[0]?.item.sessionId, "sess_inspector");
    assert.ok(inspectorResults[0]?.cueMatches.includes("tool:git_inspect"));
    await repository.close?.();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sqlite repository persists reinforcement metadata across reopen", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-sqlite-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";

    const repository = createMemoryRepository(config);
    const [created] = await repository.upsertItems([
      {
        sessionId: "sess_pref",
        memoryType: "user_preference",
        scope: "user",
        content: "User prefers concise engineering answers.",
        tags: ["preference", "style"],
        sourceType: "user_message",
      },
    ]);
    await repository.reinforceItem(created!.id, {
      now: "2026-03-12T20:00:00.000Z",
      salienceDelta: 0.02,
      confidenceDelta: 0.01,
    });
    await repository.reinforceItem(created!.id, {
      now: "2026-03-12T20:05:00.000Z",
      salienceDelta: 0,
      confidenceDelta: 0,
      reinforcementDelta: 0,
      retrievalSuccessDelta: 2,
      lastRetrievedAt: "2026-03-12T20:05:00.000Z",
    });
    await repository.close?.();

    const reopened = createMemoryRepository(config);
    const reinforced = await reopened.getItem(created!.id);

    assert.equal(getItemInternalMetadata(reinforced!).reinforcementCount, 2);
    assert.equal(getItemInternalMetadata(reinforced!).retrievalSuccessCount, 2);
    assert.equal(
      getItemInternalMetadata(reinforced!).lastReinforcedAt,
      "2026-03-12T20:00:00.000Z",
    );
    assert.equal(
      getItemInternalMetadata(reinforced!).lastRetrievedAt,
      "2026-03-12T20:05:00.000Z",
    );
    await reopened.close?.();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sqlite repository persists memory edges across reopen", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-sqlite-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";

    const repository = createMemoryRepository(config);
    await repository.upsertEdges([
      {
        fromId: "mem_fact",
        toId: "mem_episode",
        relation: "derived_from",
      },
      {
        fromId: "mem_new",
        toId: "mem_old",
        relation: "supersedes",
      },
    ]);
    await repository.close?.();

    const reopened = createMemoryRepository(config);
    const edges = await reopened.listEdges();
    const derived = await reopened.listEdges({ relation: "derived_from" });

    assert.equal(edges.length, 2);
    assert.equal(derived.length, 1);
    assert.equal(derived[0]?.toId, "mem_episode");
    await reopened.close?.();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sqlite search excludes expired volatile world facts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-sqlite-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    await repository.upsertItems([
      {
        sessionId: "sess_old",
        memoryType: "world_fact",
        scope: "global",
        content: "Transit fares increased for a temporary pilot program.",
        tags: ["transit", "fares"],
        sourceType: "web_page",
        volatility: "volatile",
        observedAt: "2026-03-01T08:00:00.000Z",
        validUntil: "2026-03-05T08:00:00.000Z",
        revalidationDueAt: "2026-03-03T08:00:00.000Z",
      },
    ]);

    const results = await repository.search({
      text: "What happened to transit fares?",
      now: "2026-03-12T12:00:00.000Z",
    });

    assert.equal(results.length, 0);
    await repository.close?.();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("sqlite repository imports phase-1 file memory into the database on first open", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-sqlite-"));
  await mkdir(path.join(tempRoot, "data"), { recursive: true });
  await writeFile(
    path.join(tempRoot, "data", "memory.json"),
    JSON.stringify(
      {
        sessions: [],
        items: [
          {
            id: "mem_import_1",
            sessionId: "sess_import",
            createdAt: "2026-03-10T10:00:00.000Z",
            updatedAt: "2026-03-10T10:00:00.000Z",
            observedAt: null,
            memoryType: "user_profile",
            scope: "user",
            content: "User date of birth is 1997-06-16.",
            jsonValue: { dateOfBirth: "1997-06-16" },
            tags: ["birthday"],
            sourceType: "user_message",
            sourceRef: null,
            confidence: 0.95,
            salience: 0.95,
            volatility: "stable",
            validFrom: null,
            validUntil: null,
            supersedesId: null,
            supersededById: null,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);
    const items = await repository.listItems();

    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, "mem_import_1");
    assert.match(items[0]?.content ?? "", /1997-06-16/);
    await repository.close?.();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
