import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { defaultMemoryConfig } from "./defaults";
import { getItemInternalMetadata } from "./metadata";
import { createMemoryRepository, initializeMemoryInfrastructure, recordTaskOutcomeMemory } from "./store";
import { getMemorySqlitePath, isNodeSqliteAvailable } from "./sqlite";

const sqliteTest = isNodeSqliteAvailable() ? test : test.skip;

test("file memory repository stores sessions and items", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    const repository = createMemoryRepository(config);
    await repository.upsertSession({
      id: "sess_1",
      conversationId: "conv_1",
      startedAt: "2026-03-12T12:00:00.000Z",
      endedAt: null,
      summary: "User introduced themselves and shared profile facts.",
      topics: ["profile", "onboarding"],
      messageCount: 4,
      lastMessageAt: "2026-03-12T12:04:00.000Z",
    });

    await repository.upsertItems([
      {
        sessionId: "sess_1",
        memoryType: "user_profile",
        scope: "user",
        content: "User date of birth is 1997-06-16.",
        jsonValue: { dateOfBirth: "1997-06-16" },
        tags: ["birthday", "dob"],
        sourceType: "user_message",
      },
    ]);

    const sessions = await repository.listSessions();
    const items = await repository.listItems();

    assert.equal(sessions.length, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.sessionId, "sess_1");
    assert.equal(items[0]?.memoryType, "user_profile");
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("search excludes active session and returns relevant cross-session memory", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    const repository = createMemoryRepository(config);
    await repository.upsertItems([
      {
        sessionId: "sess_old",
        memoryType: "user_profile",
        scope: "user",
        content: "User date of birth is 1997-06-16.",
        jsonValue: { dateOfBirth: "1997-06-16" },
        tags: ["birthday", "dob"],
        sourceType: "user_message",
        salience: 0.95,
      },
      {
        sessionId: "sess_live",
        memoryType: "episode_summary",
        scope: "workspace",
        content: "Current conversation also mentions the user's birthday.",
        tags: ["birthday"],
        sourceType: "session_summary",
        salience: 0.5,
      },
    ]);

    const results = await repository.search({
      text: "What is my birthday?",
      activeSessionId: "sess_live",
    });

    assert.equal(results.length, 1);
    assert.match(results[0]?.item.content ?? "", /1997-06-16/);
    assert.equal(results[0]?.item.sessionId, "sess_old");
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prompt context stays inside configured memory budget", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    config.retrieval.maxInjectedItems = 2;
    config.retrieval.maxInjectedChars = 180;
    const repository = createMemoryRepository(config);

    await repository.upsertItems([
      {
        sessionId: "sess_1",
        memoryType: "user_preference",
        scope: "user",
        content: "User prefers concise engineering responses.",
        tags: ["style"],
        sourceType: "user_message",
      },
      {
        sessionId: "sess_2",
        memoryType: "project_fact",
        scope: "workspace",
        content: "Ember uses conversation compaction before provider calls.",
        tags: ["architecture"],
        sourceType: "assistant_message",
      },
      {
        sessionId: "sess_3",
        memoryType: "world_fact",
        scope: "global",
        content: "A law changed and this is a deliberately long sentence to overflow the budget.",
        tags: ["law"],
        sourceType: "web_page",
        volatility: "event",
      },
    ]);

    const context = await repository.buildPromptContext({
      text: "How should you answer and what does Ember do?",
    });

    assert.match(context.text, /^Persistent memory:/);
    assert.ok(context.results.length >= 1);
    assert.ok(context.results.length <= 2);
    assert.match(context.text, /User preference|Project fact/);
    assert.ok(context.totalChars <= 180);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prompt context clips oversized memories instead of dropping the block", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    const repository = createMemoryRepository(config);

    await repository.upsertItems([
      {
        sessionId: "sess_compact",
        memoryType: "project_fact",
        scope: "workspace",
        content:
          "Ember keeps prompt-time memory injection compact for smaller local models by clipping long prompt memories and limiting retrieval to a very small set of high-confidence items.",
        tags: ["memory", "compact", "prompt"],
        sourceType: "assistant_message",
        salience: 0.95,
        confidence: 0.95,
      },
    ]);

    const context = await repository.buildPromptContext({
      text: "How does Ember keep prompt memory compact?",
      maxInjectedItems: 1,
      maxInjectedChars: 110,
    });

    assert.equal(context.results.length, 1);
    assert.ok(context.totalChars <= 110);
    assert.match(context.text, /^Persistent memory:/);
    assert.match(context.text, /Project fact:/);
    assert.match(context.text, /…/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prompt context favors a small diverse set of directly relevant memories", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    config.retrieval.maxInjectedItems = 3;
    config.retrieval.maxInjectedChars = 320;
    const repository = createMemoryRepository(config);

    await repository.upsertItems([
      {
        sessionId: "sess_a",
        memoryType: "episode_summary",
        scope: "workspace",
        content: "Earlier session kept prompt memory compact for the repo and used pnpm.",
        tags: ["prompt", "compact", "pnpm"],
        sourceType: "session_summary",
        salience: 0.82,
        confidence: 0.82,
      },
      {
        sessionId: "sess_b",
        memoryType: "episode_summary",
        scope: "workspace",
        content: "Another session also kept prompt memory compact for the repo and used pnpm.",
        tags: ["prompt", "compact", "pnpm"],
        sourceType: "session_summary",
        salience: 0.8,
        confidence: 0.8,
      },
      {
        sessionId: "sess_c",
        memoryType: "project_fact",
        scope: "workspace",
        content: "Repository package manager is pnpm@10.9.0.",
        tags: ["pnpm", "package-manager"],
        sourceType: "tool_result",
        salience: 0.88,
        confidence: 0.9,
      },
      {
        sessionId: "sess_d",
        memoryType: "user_preference",
        scope: "user",
        content: "User prefers concise engineering responses.",
        tags: ["preference", "engineering"],
        sourceType: "user_message",
        salience: 0.86,
        confidence: 0.88,
      },
    ]);

    const context = await repository.buildPromptContext({
      text: "Keep prompt memory compact and use pnpm for repo commands.",
      maxInjectedItems: 3,
      maxInjectedChars: 320,
    });

    assert.ok(context.results.length <= 3);
    assert.equal(
      context.results.filter((result) => result.item.memoryType === "episode_summary").length <= 1,
      true,
    );
    assert.ok(context.results.some((result) => result.item.memoryType === "project_fact"));
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("search ignores generic conversational stop words when ranking memories", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    const repository = createMemoryRepository(config);

    await repository.upsertItems([
      {
        sessionId: "sess_world",
        memoryType: "world_fact",
        scope: "global",
        content: "Transit fares increased in Toronto.",
        tags: ["transit", "toronto"],
        sourceType: "web_page",
        salience: 0.92,
        confidence: 0.88,
      },
    ]);

    const results = await repository.search({
      text: "please continue with this work",
    });

    assert.equal(results.length, 0);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("file memory repository stores and filters provenance edges", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    const repository = createMemoryRepository(config);

    await repository.upsertEdges([
      {
        fromId: "mem_fact",
        toId: "mem_episode",
        relation: "derived_from",
      },
      {
        fromId: "mem_fact_new",
        toId: "mem_fact_old",
        relation: "supersedes",
      },
    ]);

    const derivedEdges = await repository.listEdges({ relation: "derived_from" });
    const allEdges = await repository.listEdges();

    assert.equal(derivedEdges.length, 1);
    assert.equal(derivedEdges[0]?.toId, "mem_episode");
    assert.equal(allEdges.length, 2);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cue-aware search changes ranking across role and tool context", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
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
    assert.ok(directorResults[0]?.cueMatches.includes("role:director"));
    assert.match(directorResults[0]?.reason ?? "", /matched cues/);
    assert.equal(inspectorResults[0]?.item.sessionId, "sess_inspector");
    assert.ok(inspectorResults[0]?.cueMatches.includes("role:inspector"));
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("file memory repository reinforces repeated facts and derives age from birthdate at retrieval time", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    const repository = createMemoryRepository(config);

    const [created] = await repository.upsertItems([
      {
        sessionId: "sess_profile",
        memoryType: "user_profile",
        scope: "user",
        content: "User date of birth is 1997-06-16.",
        jsonValue: { dateOfBirth: "1997-06-16" },
        tags: ["birthday", "dob"],
        sourceType: "user_message",
      },
    ]);

    await repository.reinforceItem(created!.id, {
      now: "2026-03-15T10:00:00.000Z",
      confidenceDelta: 0.01,
      salienceDelta: 0.02,
    });

    const reinforced = await repository.getItem(created!.id);
    const context = await repository.buildPromptContext({
      text: "What is my birthday?",
      now: "2026-06-20T00:00:00.000Z",
    });

    assert.equal(getItemInternalMetadata(reinforced!).reinforcementCount, 2);
    assert.match(context.text, /Current age: 29\./);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("retrieval success metadata boosts useful memories on future searches", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "file";
    const repository = createMemoryRepository(config);

    const [useful, baseline] = await repository.upsertItems([
      {
        sessionId: "sess_useful",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Reusable fix for the same blocked workflow.",
        tags: ["topic:build", "blocked"],
        sourceType: "assistant_message",
        confidence: 0.8,
        salience: 0.8,
      },
      {
        sessionId: "sess_baseline",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Reusable fix for the same blocked workflow.",
        tags: ["topic:build", "blocked"],
        sourceType: "assistant_message",
        confidence: 0.8,
        salience: 0.8,
      },
    ]);

    await repository.reinforceItem(useful!.id, {
      now: "2026-03-15T12:00:00.000Z",
      confidenceDelta: 0,
      salienceDelta: 0,
      reinforcementDelta: 0,
      retrievalSuccessDelta: 3,
      lastRetrievedAt: "2026-03-15T12:00:00.000Z",
    });

    const results = await repository.search({
      text: "How did we solve this blocked workflow?",
      workspaceTopics: ["build"],
      taskState: "blocked",
      maxResults: 2,
    });
    const usefulItem = await repository.getItem(useful!.id);
    const baselineItem = await repository.getItem(baseline!.id);
    const usefulMeta = getItemInternalMetadata(usefulItem!);
    const baselineMeta = getItemInternalMetadata(baselineItem!);

    assert.equal(usefulMeta.retrievalSuccessCount, 3);
    assert.equal(baselineMeta.retrievalSuccessCount, 0);
    assert.equal(results[0]?.item.id, useful!.id);
    assert.match(results[0]?.reason ?? "", /useful x3/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

sqliteTest("initializeMemoryInfrastructure creates the SQLite database before first chat", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";

    await initializeMemoryInfrastructure(config);

    assert.equal(existsSync(getMemorySqlitePath(config)), true);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

sqliteTest("recordTaskOutcomeMemory stores tagged task outcomes for feedback lookup", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const stored = await recordTaskOutcomeMemory(repository, {
      taskDescription: "Deploy OAuth refresh token changes",
      approach: "Patch the auth middleware and run integration checks",
      result: "failure",
      failureReason: "Expired token path was not refreshed.",
      toolsUsed: ["search_files", "run_terminal_command"],
      providerUsed: "provider_alpha",
      modelUsed: "gpt-5.3-codex",
      duration: 3_450,
      timestamp: "2026-03-17T12:30:00.000Z",
    });

    assert.equal(stored.memoryType, "task_outcome");
    assert.ok(stored.tags.includes("__task_outcome"));
    assert.match(stored.content, /Task outcome \(failure\)/);
    assert.equal(stored.jsonValue?.providerUsed, "provider_alpha");

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
