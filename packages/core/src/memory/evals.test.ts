import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";

import type { Conversation } from "../types";
import { consolidateConversationMemory } from "./consolidation";
import { defaultMemoryConfig } from "./defaults";
import { isNodeSqliteAvailable } from "./sqlite";
import { createMemoryRepository } from "./store";

const test = isNodeSqliteAvailable() ? nodeTest : nodeTest.skip;

function makeConversation(id: string, messages: Conversation["messages"]): Conversation {
  const lastMessage = messages.at(-1);
  return {
    id,
    title: "Memory eval",
    mode: "auto",
    createdAt: messages[0]?.createdAt ?? "2026-03-12T10:00:00.000Z",
    updatedAt: lastMessage?.createdAt ?? "2026-03-12T10:00:00.000Z",
    archivedAt: null,
    lastMessageAt: lastMessage?.createdAt ?? null,
    preview: lastMessage?.content ?? "",
    messageCount: messages.length,
    messages,
  };
}

async function withRepository(
  fn: (repository: ReturnType<typeof createMemoryRepository>, config: ReturnType<typeof defaultMemoryConfig>) => Promise<void>,
) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-evals-"));
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

test("eval: user profile recall survives across sessions", async () => {
  await withRepository(async (repository, config) => {
    await consolidateConversationMemory(repository, {
      config,
      conversation: makeConversation("conv_profile_a", [
        {
          id: "msg_user_a",
          role: "user",
          authorRole: "user",
          mode: "auto",
          content: "I'm Nick and my birthday is June 16 1997.",
          createdAt: "2026-03-12T10:00:00.000Z",
        },
      ]),
      now: "2026-03-12T10:01:00.000Z",
    });

    const context = await repository.buildPromptContext({
      text: "When was I born?",
      activeSessionId: "conv_profile_b",
      now: "2026-06-20T00:00:00.000Z",
    });

    assert.match(context.text, /Born 1997-06-16/);
    assert.match(context.text, /Current age: 29/);
  });
});

test("eval: project facts recall across sessions", async () => {
  await withRepository(async (repository) => {
    await repository.upsertItems([
      {
        sessionId: "conv_project_a",
        memoryType: "project_fact",
        scope: "workspace",
        content: "Ember uses SQLite-backed long-term memory and prompt-time retrieval injection.",
        tags: ["sqlite", "retrieval", "memory"],
        sourceType: "assistant_message",
        salience: 0.92,
        confidence: 0.94,
      },
    ]);

    const results = await repository.search({
      text: "What backend does Ember use for long-term memory?",
      activeSessionId: "conv_project_b",
    });

    assert.equal(results.length, 1);
    assert.match(results[0]?.item.content ?? "", /SQLite-backed long-term memory/);
  });
});

test("eval: web facts retain provenance and remain searchable", async () => {
  await withRepository(async (repository) => {
    await repository.upsertItems([
      {
        sessionId: "conv_world_a",
        memoryType: "world_fact",
        scope: "global",
        content: "Ontario passed a new privacy reporting rule for data breaches.",
        tags: ["privacy", "law", "ontario"],
        sourceType: "web_page",
        sourceRef: "https://news.example.com/privacy-rule",
        volatility: "event",
        observedAt: "2026-03-01T08:00:00.000Z",
        revalidationDueAt: "2026-05-30T08:00:00.000Z",
      },
    ]);

    const results = await repository.search({
      text: "What privacy law changed in Ontario?",
      activeSessionId: "conv_world_b",
      sourceTypes: ["web_page"],
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.item.sourceRef, "https://news.example.com/privacy-rule");
    assert.equal(results[0]?.item.sourceType, "web_page");
  });
});

test("eval: contradictions supersede older facts instead of stacking duplicates", async () => {
  await withRepository(async (repository, config) => {
    await repository.upsertItems([
      {
        sessionId: "conv_old",
        memoryType: "user_profile",
        scope: "user",
        content: "User date of birth is 1996-06-16.",
        jsonValue: {
          key: "date_of_birth",
          dateOfBirth: "1996-06-16",
        },
        tags: ["birthday", "dob"],
        sourceType: "user_message",
        salience: 0.98,
        confidence: 0.98,
      },
    ]);

    await consolidateConversationMemory(repository, {
      config,
      conversation: makeConversation("conv_new", [
        {
          id: "msg_user_new",
          role: "user",
          authorRole: "user",
          mode: "auto",
          content: "Correction: my birthday is June 16 1997.",
          createdAt: "2026-03-12T11:00:00.000Z",
        },
      ]),
      now: "2026-03-12T11:01:00.000Z",
    });

    const items = await repository.listItems({ includeSuperseded: true });
    const active = items.find((item) => item.memoryType === "user_profile" && !item.supersededById);
    const superseded = items.find((item) => item.memoryType === "user_profile" && item.supersededById);

    assert.equal(active?.jsonValue?.dateOfBirth, "1997-06-16");
    assert.equal(superseded?.jsonValue?.dateOfBirth, "1996-06-16");
  });
});

test("eval: active-session exclusion prevents duplicate self-recall", async () => {
  await withRepository(async (repository) => {
    await repository.upsertItems([
      {
        sessionId: "conv_old",
        memoryType: "user_preference",
        scope: "user",
        content: "User prefers concise engineering responses.",
        tags: ["style", "engineering"],
        sourceType: "user_message",
      },
      {
        sessionId: "conv_live",
        memoryType: "episode_summary",
        scope: "workspace",
        content: "Current live session also mentions concise responses.",
        tags: ["style"],
        sourceType: "session_summary",
      },
    ]);

    const results = await repository.search({
      text: "How should you respond?",
      activeSessionId: "conv_live",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.item.sessionId, "conv_old");
  });
});

test("eval: prompt budget stays bounded under memory pressure", async () => {
  await withRepository(async (repository, config) => {
    config.retrieval.maxInjectedItems = 3;
    config.retrieval.maxInjectedChars = 220;

    await repository.upsertItems([
      {
        sessionId: "conv_a",
        memoryType: "user_profile",
        scope: "user",
        content: "User date of birth is 1997-06-16.",
        jsonValue: { dateOfBirth: "1997-06-16" },
        tags: ["birthday"],
        sourceType: "user_message",
      },
      {
        sessionId: "conv_b",
        memoryType: "project_fact",
        scope: "workspace",
        content: "Ember injects long-term memory as a separate prompt block.",
        tags: ["prompt", "memory"],
        sourceType: "assistant_message",
      },
      {
        sessionId: "conv_c",
        memoryType: "world_fact",
        scope: "global",
        content: "A long world fact sentence that exists mainly to pressure the injection budget and should be clipped out when the budget is exhausted.",
        tags: ["world", "long"],
        sourceType: "web_page",
        volatility: "event",
      },
      {
        sessionId: "conv_d",
        memoryType: "user_preference",
        scope: "user",
        content: "User prefers concise engineering answers.",
        tags: ["style"],
        sourceType: "user_message",
      },
    ]);

    const context = await repository.buildPromptContext({
      text: "How should Ember answer and what should it remember?",
      activeSessionId: "conv_live",
      now: "2026-03-12T12:00:00.000Z",
    });

    assert.ok(context.results.length <= 3);
    assert.ok(context.totalChars <= 220);
    assert.match(context.text, /^Persistent memory:/);
  });
});

test("eval: role and tool context steer recall toward the right prior fix", async () => {
  await withRepository(async (repository) => {
    await repository.upsertItems([
      {
        sessionId: "conv_director_fix",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Past fix for a blocked workflow.",
        tags: ["role:director", "tool:run_terminal_command", "topic:typescript", "topic:build", "blocked"],
        sourceType: "assistant_message",
        salience: 0.82,
        confidence: 0.82,
      },
      {
        sessionId: "conv_inspector_fix",
        memoryType: "task_outcome",
        scope: "workspace",
        content: "Past fix for a blocked workflow.",
        tags: ["role:inspector", "tool:git_inspect", "topic:routing", "topic:prompt", "blocked"],
        sourceType: "assistant_message",
        salience: 0.82,
        confidence: 0.82,
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

    assert.equal(directorResults[0]?.item.sessionId, "conv_director_fix");
    assert.ok(directorResults[0]?.cueMatches.includes("role:director"));
  });
});

test("eval: semantic distillation turns strong workspace evidence into durable project and environment facts", async () => {
  await withRepository(async (repository, config) => {
    await consolidateConversationMemory(repository, {
      config,
      conversation: makeConversation("conv_semantic_a", [
        {
          id: "msg_user_semantic",
          role: "user",
          authorRole: "user",
          mode: "auto",
          content: "Remember the durable repo setup and environment details.",
          createdAt: "2026-03-12T13:00:00.000Z",
        },
      ]),
      toolObservations: [
        {
          toolName: "project_overview",
          input: { path: "." },
          sourceType: "tool_result",
          sourceRef: "/workspace",
          createdAt: "2026-03-12T13:00:30.000Z",
          resultText: [
            "Path: /workspace",
            "Package manager: pnpm@10.9.0",
            "Workspace globs: apps/*, packages/*",
          ].join("\n"),
          command: null,
          workingDirectory: null,
          targetPath: ".",
          queryText: null,
          exitCode: null,
        },
        {
          toolName: "run_terminal_command",
          input: { command: "node --version", cwd: "/workspace" },
          sourceType: "tool_result",
          sourceRef: null,
          createdAt: "2026-03-12T13:01:00.000Z",
          resultText: "Exit code 0:\nv25.6.1",
          command: "node --version",
          workingDirectory: "/workspace",
          targetPath: null,
          queryText: null,
          exitCode: 0,
        },
      ],
      now: "2026-03-12T13:02:00.000Z",
    });

    const results = await repository.search({
      text: "What package manager does this repo use and what local Node version do we have?",
      activeSessionId: "conv_semantic_b",
      scopes: ["workspace"],
    });

    assert.ok(results.some((result) => /package manager is pnpm@10\.9\.0/i.test(result.item.content)));
    assert.ok(results.some((result) => /Local node version is v25\.6\.1/i.test(result.item.content)));
  });
});
