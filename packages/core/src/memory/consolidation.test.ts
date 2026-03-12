import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Conversation } from "../types";
import { defaultMemoryConfig } from "./defaults";
import { consolidateConversationMemory } from "./consolidation";
import { getItemInternalMetadata } from "./metadata";
import { createMemoryRepository } from "./store";

function makeConversation(messages: Conversation["messages"]): Conversation {
  return {
    id: "conv_memory_test",
    title: "Memory test",
    mode: "auto",
    createdAt: "2026-03-12T18:00:00.000Z",
    updatedAt: "2026-03-12T18:05:00.000Z",
    archivedAt: null,
    lastMessageAt: "2026-03-12T18:05:00.000Z",
    preview: messages.at(-1)?.content ?? "",
    messageCount: messages.length,
    messages,
  };
}

test("consolidation canonicalizes date of birth and supersedes stale profile values", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const [oldDob] = await repository.upsertItems([
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
        confidence: 0.98,
        salience: 0.98,
        volatility: "stable",
      },
    ]);

    const conversation = makeConversation([
      {
        id: "msg_user",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "I'm 28 and my birthday is June 16 1997.",
        createdAt: "2026-03-12T18:01:00.000Z",
      },
      {
        id: "msg_assistant",
        role: "assistant",
        authorRole: "coordinator",
        mode: "auto",
        content: "I'll remember that across sessions.",
        createdAt: "2026-03-12T18:02:00.000Z",
      },
    ]);

    await consolidateConversationMemory(repository, {
      conversation,
      config,
    });

    const items = await repository.listItems({ includeSuperseded: true });
    const activeDob = items.find(
      (item) =>
        item.memoryType === "user_profile" &&
        item.jsonValue?.dateOfBirth === "1997-06-16" &&
        !item.supersededById,
    );
    const supersededDob = items.find((item) => item.id === oldDob?.id);

    assert.ok(activeDob);
    assert.equal(activeDob?.supersedesId, oldDob?.id);
    assert.equal(supersededDob?.supersededById, activeDob?.id);

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

test("consolidation promotes sourced world facts from fetched pages", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const conversation = makeConversation([
      {
        id: "msg_user",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Remember any important law changes from the article I read.",
        createdAt: "2026-03-12T18:01:00.000Z",
      },
      {
        id: "msg_assistant",
        role: "assistant",
        authorRole: "coordinator",
        mode: "auto",
        content: "I'll store durable world facts with provenance.",
        createdAt: "2026-03-12T18:02:00.000Z",
      },
    ]);

    await consolidateConversationMemory(repository, {
      conversation,
      config,
      toolObservations: [
        {
          toolName: "fetch_page",
          input: { url: "https://news.example.com/law-update" },
          sourceType: "web_page",
          sourceRef: "https://news.example.com/law-update",
          createdAt: "2026-03-12T18:03:00.000Z",
          resultText: [
            "Title: New Data Privacy Law Takes Effect",
            "URL: https://news.example.com/law-update",
            "Content-Type: text/html",
            "",
            "The province passed a new data privacy law on 2026-03-01, changing how companies must report breaches within 72 hours.",
            "Officials said the regulation will be enforced starting next quarter.",
          ].join("\n"),
          command: null,
          workingDirectory: null,
          targetPath: null,
          queryText: null,
          exitCode: null,
        },
      ],
    });

    const results = await repository.search({
      text: "What law changed about data privacy?",
      activeSessionId: "other_conversation",
    });
    const worldFact = (await repository.listItems()).find((item) => item.memoryType === "world_fact");

    assert.ok(results.some((result) => result.item.memoryType === "world_fact"));
    assert.ok(
      results.some(
        (result) =>
          result.item.sourceRef === "https://news.example.com/law-update" &&
          /data privacy law/i.test(result.item.content),
      ),
    );
    assert.equal(worldFact?.validUntil, null);
    assert.equal(getItemInternalMetadata(worldFact!).revalidationDueAt, "2026-06-10T18:03:00.000Z");

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

test("consolidation distills project facts from strong tool evidence and records support edges", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const conversation = makeConversation([
      {
        id: "msg_user",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Remember how this repo is structured and how we build it.",
        createdAt: "2026-03-12T18:01:00.000Z",
      },
      {
        id: "msg_assistant",
        role: "assistant",
        authorRole: "director",
        mode: "auto",
        content: "I'll distill the durable repo facts instead of leaving them in chat history.",
        createdAt: "2026-03-12T18:02:00.000Z",
      },
    ]);

    await consolidateConversationMemory(repository, {
      conversation,
      config,
      now: "2026-03-12T18:04:00.000Z",
      toolObservations: [
        {
          toolName: "project_overview",
          input: { path: "." },
          sourceType: "tool_result",
          sourceRef: "/workspace",
          createdAt: "2026-03-12T18:03:00.000Z",
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
          input: { command: "pnpm build", cwd: "/workspace" },
          sourceType: "tool_result",
          sourceRef: null,
          createdAt: "2026-03-12T18:03:30.000Z",
          resultText: "Exit code 0:\nBuild completed successfully.",
          command: "pnpm build",
          workingDirectory: "/workspace",
          targetPath: null,
          queryText: null,
          exitCode: 0,
        },
      ],
    });

    const items = await repository.listItems();
    const packageManager = items.find((item) => item.jsonValue?.key === "project:package_manager");
    const summaryItem = items.find(
      (item) =>
        item.memoryType === "episode_summary" &&
        item.sourceType === "session_summary" &&
        item.sessionId === "conv_memory_test",
    );
    const edges = await repository.listEdges({ relation: "derived_from" });

    assert.match(packageManager?.content ?? "", /pnpm@10\.9\.0/);
    assert.equal(items.some((item) => item.jsonValue?.key === "project:build_command"), false);
    assert.ok(edges.some((edge) => edge.fromId === packageManager?.id && edge.toId === summaryItem?.id));

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

test("consolidation promotes repeated successful terminal commands instead of single one-off commands", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const conversation = makeConversation([
      {
        id: "msg_user_repeat",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Figure out the main build command for this repo.",
        createdAt: "2026-03-12T18:01:00.000Z",
      },
    ]);

    await consolidateConversationMemory(repository, {
      conversation,
      config,
      now: "2026-03-12T18:05:00.000Z",
      toolObservations: [
        {
          toolName: "run_terminal_command",
          input: { command: "pnpm build", cwd: "/workspace" },
          sourceType: "tool_result",
          sourceRef: null,
          createdAt: "2026-03-12T18:02:00.000Z",
          resultText: "Exit code 0:\nBuild completed successfully.",
          command: "pnpm build",
          workingDirectory: "/workspace",
          targetPath: null,
          queryText: null,
          exitCode: 0,
        },
        {
          toolName: "run_terminal_command",
          input: { command: "pnpm build", cwd: "/workspace" },
          sourceType: "tool_result",
          sourceRef: null,
          createdAt: "2026-03-12T18:04:00.000Z",
          resultText: "Exit code 0:\nBuild completed successfully.",
          command: "pnpm build",
          workingDirectory: "/workspace",
          targetPath: null,
          queryText: null,
          exitCode: 0,
        },
      ],
    });

    const items = await repository.listItems();
    const buildCommand = items.find((item) => item.jsonValue?.key === "project:build_command");

    assert.match(buildCommand?.content ?? "", /`pnpm build`/);

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

test("consolidation skips active session summary rewrites when the summary changed only marginally", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const firstConversation = makeConversation([
      {
        id: "msg_user_summary_1",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Keep the memory engine compact and use pnpm for repo commands.",
        createdAt: "2026-03-12T18:01:00.000Z",
      },
      {
        id: "msg_assistant_summary_1",
        role: "assistant",
        authorRole: "director",
        mode: "auto",
        content: "I will keep the prompt lean.",
        createdAt: "2026-03-12T18:02:00.000Z",
      },
    ]);

    await consolidateConversationMemory(repository, {
      conversation: firstConversation,
      config,
      now: "2026-03-12T18:03:00.000Z",
    });

    const secondConversation = {
      ...firstConversation,
      messages: [
        ...firstConversation.messages,
        {
          id: "msg_user_summary_2",
          role: "user" as const,
          authorRole: "user" as const,
          mode: "auto" as const,
          content: "Please continue.",
          createdAt: "2026-03-12T18:04:00.000Z",
        },
        {
          id: "msg_assistant_summary_2",
          role: "assistant" as const,
          authorRole: "director" as const,
          mode: "auto" as const,
          content: "Continuing with the same plan.",
          createdAt: "2026-03-12T18:05:00.000Z",
        },
      ],
      messageCount: firstConversation.messages.length + 2,
      lastMessageAt: "2026-03-12T18:05:00.000Z",
      updatedAt: "2026-03-12T18:05:00.000Z",
    };

    await consolidateConversationMemory(repository, {
      conversation: secondConversation,
      config,
      now: "2026-03-12T18:06:00.000Z",
    });

    const items = await repository.listItems({ includeSuperseded: true });
    const sessionSummaries = items.filter(
      (item) =>
        item.sessionId === "conv_memory_test" &&
        item.memoryType === "episode_summary" &&
        item.sourceType === "session_summary",
    );

    assert.equal(sessionSummaries.length, 1);

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

test("consolidation supersedes stale environment facts when stronger evidence updates them", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const firstConversation = makeConversation([
      {
        id: "msg_user_1",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Check the local Node version.",
        createdAt: "2026-03-12T18:01:00.000Z",
      },
    ]);

    await consolidateConversationMemory(repository, {
      conversation: firstConversation,
      config,
      now: "2026-03-12T18:02:00.000Z",
      toolObservations: [
        {
          toolName: "run_terminal_command",
          input: { command: "node --version", cwd: "/workspace" },
          sourceType: "tool_result",
          sourceRef: null,
          createdAt: "2026-03-12T18:01:30.000Z",
          resultText: "Exit code 0:\nv22.1.0",
          command: "node --version",
          workingDirectory: "/workspace",
          targetPath: null,
          queryText: null,
          exitCode: 0,
        },
      ],
    });

    const secondConversation = {
      ...makeConversation([
        {
          id: "msg_user_2",
          role: "user" as const,
          authorRole: "user" as const,
          mode: "auto" as const,
          content: "Node changed after the upgrade, remember the new version.",
          createdAt: "2026-03-13T09:01:00.000Z",
        },
      ]),
      id: "conv_memory_test_2",
      createdAt: "2026-03-13T09:00:00.000Z",
      updatedAt: "2026-03-13T09:01:00.000Z",
      lastMessageAt: "2026-03-13T09:01:00.000Z",
    };

    await consolidateConversationMemory(repository, {
      conversation: secondConversation,
      config,
      now: "2026-03-13T09:02:00.000Z",
      toolObservations: [
        {
          toolName: "run_terminal_command",
          input: { command: "node --version", cwd: "/workspace" },
          sourceType: "tool_result",
          sourceRef: null,
          createdAt: "2026-03-13T09:01:30.000Z",
          resultText: "Exit code 0:\nv23.0.0",
          command: "node --version",
          workingDirectory: "/workspace",
          targetPath: null,
          queryText: null,
          exitCode: 0,
        },
      ],
    });

    const items = await repository.listItems({ includeSuperseded: true });
    const activeNode = items.find(
      (item) => item.jsonValue?.key === "environment:node_version" && !item.supersededById,
    );
    const staleNode = items.find(
      (item) => item.jsonValue?.key === "environment:node_version" && item.supersededById,
    );
    const edges = await repository.listEdges({ relation: "supersedes" });

    assert.match(activeNode?.content ?? "", /v23\.0\.0/);
    assert.match(staleNode?.content ?? "", /v22\.1\.0/);
    assert.ok(edges.some((edge) => edge.fromId === activeNode?.id && edge.toId === staleNode?.id));

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

test("consolidation distills repeated project constraints from conversation text", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const conversation = makeConversation([
      {
        id: "msg_user",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Keep prompt memory compact for this workspace and use pnpm only for repo commands.",
        createdAt: "2026-03-12T20:01:00.000Z",
      },
      {
        id: "msg_assistant",
        role: "assistant",
        authorRole: "director",
        mode: "auto",
        content: "Understood. Keep prompt memory compact for this workspace and use pnpm only for repo commands.",
        createdAt: "2026-03-12T20:02:00.000Z",
      },
    ]);

    await consolidateConversationMemory(repository, {
      conversation,
      config,
      now: "2026-03-12T20:03:00.000Z",
    });

    const constraint = (await repository.listItems()).find(
      (item) =>
        item.memoryType === "project_fact" &&
        typeof item.jsonValue?.key === "string" &&
        item.jsonValue.key.startsWith("project:constraint:"),
    );

    assert.ok(constraint);
    assert.match(constraint?.content ?? "", /Persistent project constraint:/);
    assert.match(constraint?.content ?? "", /pnpm only/i);

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

test("consolidation distills repo conventions from files and directory structure", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    await consolidateConversationMemory(repository, {
      conversation: makeConversation([
        {
          id: "msg_user",
          role: "user",
          authorRole: "user",
          mode: "auto",
          content: "Remember the repo conventions from the files I inspected.",
          createdAt: "2026-03-12T21:01:00.000Z",
        },
      ]),
      config,
      now: "2026-03-12T21:04:00.000Z",
      toolObservations: [
        {
          toolName: "read_file",
          input: { path: "/workspace/package.json" },
          sourceType: "tool_result",
          sourceRef: "/workspace/package.json",
          createdAt: "2026-03-12T21:02:00.000Z",
          resultText: JSON.stringify({
            packageManager: "pnpm@10.9.0",
            scripts: {
              build: "pnpm -r build",
              test: "pnpm test",
            },
          }),
          command: null,
          workingDirectory: "/workspace",
          targetPath: "/workspace/package.json",
          queryText: null,
          exitCode: null,
        },
        {
          toolName: "read_file",
          input: { path: "/workspace/tsconfig.json" },
          sourceType: "tool_result",
          sourceRef: "/workspace/tsconfig.json",
          createdAt: "2026-03-12T21:02:20.000Z",
          resultText: JSON.stringify({
            compilerOptions: {
              module: "NodeNext",
            },
          }),
          command: null,
          workingDirectory: "/workspace",
          targetPath: "/workspace/tsconfig.json",
          queryText: null,
          exitCode: null,
        },
        {
          toolName: "list_directory",
          input: { path: "/workspace" },
          sourceType: "tool_result",
          sourceRef: "/workspace",
          createdAt: "2026-03-12T21:02:40.000Z",
          resultText: [
            "Directory: /workspace",
            "Entries: 3",
            "",
            "apps/  /workspace/apps",
            "packages/  /workspace/packages",
            "README.md  /workspace/README.md",
          ].join("\n"),
          command: null,
          workingDirectory: "/workspace",
          targetPath: "/workspace",
          queryText: null,
          exitCode: null,
        },
      ],
    });

    const items = await repository.listItems();
    assert.ok(items.some((item) => item.jsonValue?.key === "project:package_manager" && /pnpm@10\.9\.0/.test(item.content)));
    assert.ok(items.some((item) => item.jsonValue?.key === "project:build_command" && /pnpm -r build/.test(item.content)));
    assert.ok(items.some((item) => item.jsonValue?.key === "project:typescript_workspace" && /NodeNext/.test(item.content)));

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

test("consolidation reinforces repeated user facts instead of duplicating them", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const [existingDob] = await repository.upsertItems([
      {
        sessionId: "conv_old",
        memoryType: "user_profile",
        scope: "user",
        content: "User date of birth is 1997-06-16.",
        jsonValue: {
          key: "date_of_birth",
          dateOfBirth: "1997-06-16",
        },
        tags: ["birthday", "dob"],
        sourceType: "user_message",
        confidence: 0.98,
        salience: 0.98,
        volatility: "stable",
      },
    ]);

    const conversation = makeConversation([
      {
        id: "msg_user",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Remember this across chats: my birthday is June 16 1997.",
        createdAt: "2026-03-12T19:01:00.000Z",
      },
      {
        id: "msg_assistant",
        role: "assistant",
        authorRole: "coordinator",
        mode: "auto",
        content: "I already have that stored and will keep it fresh.",
        createdAt: "2026-03-12T19:02:00.000Z",
      },
    ]);

    const result = await consolidateConversationMemory(repository, {
      conversation,
      config,
      now: "2026-03-12T19:03:00.000Z",
    });

    const items = await repository.listItems({ includeSuperseded: true });
    const profileItems = items.filter((item) => item.memoryType === "user_profile");
    const refreshedDob = await repository.getItem(existingDob!.id);

    assert.equal(profileItems.length, 1);
    assert.equal(result.reinforcedItems.length >= 1, true);
    assert.equal(getItemInternalMetadata(refreshedDob!).reinforcementCount, 2);

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

test("archived session consolidation records outcomes, open threads, and closure metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-consolidation-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    const config = defaultMemoryConfig();
    config.backend = "sqlite";
    const repository = createMemoryRepository(config);

    const conversation = {
      ...makeConversation([
        {
          id: "summary_1",
          role: "assistant" as const,
          authorRole: "coordinator" as const,
          mode: "auto" as const,
          content: [
            "Conversation memory summary. This compresses 8 earlier messages from the same chat.",
            "",
            "Open threads:",
            "- Wire the archive button in the UI.",
            "",
            "Decisions and completed work:",
            "- Implemented the SQLite session lifecycle path.",
            "",
            "Failures and cautions:",
            "- The previous provider run timed out while indexing a large page.",
          ].join("\n"),
          createdAt: "2026-03-12T18:01:00.000Z",
          historySummary: {
            kind: "history-summary",
            sourceMessageCount: 8,
            sourceToolCallCount: 2,
            generatedAt: "2026-03-12T18:01:00.000Z",
          },
        },
        {
          id: "msg_user",
          role: "user",
          authorRole: "user",
          mode: "auto",
          content: "Wrap this up and remember what remains.",
          createdAt: "2026-03-12T18:04:00.000Z",
        },
        {
          id: "msg_assistant",
          role: "assistant",
          authorRole: "director",
          mode: "auto",
          content: "I finished the lifecycle backend work, but the archive button in the UI is still pending.",
          createdAt: "2026-03-12T18:05:00.000Z",
        },
      ]),
      archivedAt: "2026-03-12T18:06:00.000Z",
    };

    const result = await consolidateConversationMemory(repository, {
      conversation,
      config,
      lifecycle: "archived",
      endReason: "archived",
      now: "2026-03-12T18:06:00.000Z",
    });

    assert.equal(result.session.endedAt, "2026-03-12T18:06:00.000Z");

    const items = await repository.listItems();
    assert.ok(items.some((item) => item.memoryType === "task_outcome" && /Final task outcome:/i.test(item.content)));
    assert.ok(
      items.some(
        (item) =>
          item.memoryType === "warning_or_constraint" &&
          /Open threads from archived session/i.test(item.content),
      ),
    );
    assert.ok(
      items.some(
        (item) =>
          item.memoryType === "warning_or_constraint" &&
          /Failure or caution from archived session/i.test(item.content),
      ),
    );

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
