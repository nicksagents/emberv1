import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";

import type { Conversation } from "../types";
import { consolidateConversationMemory, type MemoryToolObservation } from "./consolidation";
import { defaultMemoryConfig } from "./defaults";
import { buildProcedurePromptContext, isProcedurePublished } from "./procedures";
import { isNodeSqliteAvailable } from "./sqlite";
import { createMemoryRepository } from "./store";

const test = isNodeSqliteAvailable() ? nodeTest : nodeTest.skip;

function makeConversation(id: string, messages: Conversation["messages"]): Conversation {
  const lastMessage = messages.at(-1);
  return {
    id,
    title: "Procedure memory test",
    mode: "auto",
    createdAt: messages[0]?.createdAt ?? "2026-03-12T10:00:00.000Z",
    updatedAt: lastMessage?.createdAt ?? "2026-03-12T10:05:00.000Z",
    archivedAt: null,
    lastMessageAt: lastMessage?.createdAt ?? null,
    preview: lastMessage?.content ?? "",
    messageCount: messages.length,
    messages,
  };
}

function makeSuccessObservations(sessionOffsetMinutes: number): MemoryToolObservation[] {
  return [
    {
      toolName: "search_files",
      input: { query: "memory retrieval" },
      resultText: "Found matches in packages/core/src/memory/scoring.ts",
      createdAt: `2026-03-12T10:${String(sessionOffsetMinutes).padStart(2, "0")}:10.000Z`,
      sourceRef: null,
      sourceType: "tool_result",
      command: null,
      workingDirectory: "/workspace",
      targetPath: null,
      queryText: "memory retrieval",
      exitCode: null,
    },
    {
      toolName: "read_file",
      input: { path: "/workspace/packages/core/src/memory/scoring.ts" },
      resultText: "export function scoreMemoryItems() {}",
      createdAt: `2026-03-12T10:${String(sessionOffsetMinutes).padStart(2, "0")}:20.000Z`,
      sourceRef: "/workspace/packages/core/src/memory/scoring.ts",
      sourceType: "tool_result",
      command: null,
      workingDirectory: "/workspace",
      targetPath: "/workspace/packages/core/src/memory/scoring.ts",
      queryText: null,
      exitCode: null,
    },
    {
      toolName: "run_terminal_command",
      input: { command: "pnpm build", cwd: "/workspace" },
      resultText: "Exit code 0:\nBuild completed successfully.",
      createdAt: `2026-03-12T10:${String(sessionOffsetMinutes).padStart(2, "0")}:30.000Z`,
      sourceRef: null,
      sourceType: "tool_result",
      command: "pnpm build",
      workingDirectory: "/workspace",
      targetPath: null,
      queryText: null,
      exitCode: 0,
    },
  ];
}

function makeFailureObservations(sessionOffsetMinutes: number): MemoryToolObservation[] {
  return [
    {
      toolName: "search_files",
      input: { query: "memory retrieval" },
      resultText: "Found matches in packages/core/src/memory/scoring.ts",
      createdAt: `2026-03-13T10:${String(sessionOffsetMinutes).padStart(2, "0")}:10.000Z`,
      sourceRef: null,
      sourceType: "tool_result",
      command: null,
      workingDirectory: "/workspace",
      targetPath: null,
      queryText: "memory retrieval",
      exitCode: null,
    },
    {
      toolName: "read_file",
      input: { path: "/workspace/packages/core/src/memory/scoring.ts" },
      resultText: "export function scoreMemoryItems() {}",
      createdAt: `2026-03-13T10:${String(sessionOffsetMinutes).padStart(2, "0")}:20.000Z`,
      sourceRef: "/workspace/packages/core/src/memory/scoring.ts",
      sourceType: "tool_result",
      command: null,
      workingDirectory: "/workspace",
      targetPath: "/workspace/packages/core/src/memory/scoring.ts",
      queryText: null,
      exitCode: null,
    },
    {
      toolName: "run_terminal_command",
      input: { command: "pnpm build", cwd: "/workspace" },
      resultText: "Exit code 1:\nBuild failed.",
      createdAt: `2026-03-13T10:${String(sessionOffsetMinutes).padStart(2, "0")}:30.000Z`,
      sourceRef: null,
      sourceType: "tool_result",
      command: "pnpm build",
      workingDirectory: "/workspace",
      targetPath: null,
      queryText: null,
      exitCode: 1,
    },
  ];
}

async function withRepository(
  fn: (repository: ReturnType<typeof createMemoryRepository>, config: ReturnType<typeof defaultMemoryConfig>) => Promise<void>,
) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-memory-procedures-"));
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

test("procedural memory promotes a repeated successful tool sequence into a published procedure", async () => {
  await withRepository(async (repository, config) => {
    await consolidateConversationMemory(repository, {
      config,
      conversation: makeConversation("conv_proc_1", [
        {
          id: "msg_user_1",
          role: "user",
          authorRole: "user",
          mode: "auto",
          content: "Fix the TypeScript build in memory retrieval.",
          createdAt: "2026-03-12T10:00:00.000Z",
        },
        {
          id: "msg_assistant_1",
          role: "assistant",
          authorRole: "director",
          mode: "auto",
          content: "Completed the fix and verified the build succeeds.",
          createdAt: "2026-03-12T10:01:00.000Z",
        },
      ]),
      toolObservations: makeSuccessObservations(1),
      now: "2026-03-12T10:02:00.000Z",
    });

    let procedures = (await repository.listItems({ includeSuperseded: true })).filter(
      (item) => item.memoryType === "procedure",
    );
    assert.equal(procedures.length, 1);
    assert.equal(procedures[0]?.jsonValue?.published, false);
    assert.equal(procedures[0]?.jsonValue?.successCount, 1);

    await consolidateConversationMemory(repository, {
      config,
      conversation: makeConversation("conv_proc_2", [
        {
          id: "msg_user_2",
          role: "user",
          authorRole: "user",
          mode: "auto",
          content: "Fix the TypeScript build in memory retrieval again.",
          createdAt: "2026-03-12T11:00:00.000Z",
        },
        {
          id: "msg_assistant_2",
          role: "assistant",
          authorRole: "director",
          mode: "auto",
          content: "Completed the fix and verified the build succeeds.",
          createdAt: "2026-03-12T11:01:00.000Z",
        },
      ]),
      toolObservations: makeSuccessObservations(11),
      now: "2026-03-12T11:02:00.000Z",
    });

    procedures = (await repository.listItems({ includeSuperseded: true })).filter(
      (item) => item.memoryType === "procedure",
    );
    const activeProcedure = procedures.find((item) => !item.supersededById);
    assert.ok(activeProcedure);
    assert.equal(activeProcedure?.jsonValue?.published, true);
    assert.equal(activeProcedure?.jsonValue?.successCount, 2);
    assert.equal(procedures.filter((item) => item.supersededById).length, 1);
    assert.equal(isProcedurePublished(activeProcedure!), true);

    const results = await repository.search({
      text: "Fix the TypeScript build in memory retrieval.",
      activeSessionId: "conv_live",
      scopes: ["workspace"],
      memoryTypes: ["procedure"],
      activeRole: "director",
      recentToolNames: ["search_files", "read_file", "run_terminal_command"],
      workspaceTopics: ["typescript", "build", "memory", "retrieval"],
    });
    const context = buildProcedurePromptContext(results, {
      maxInjectedItems: 1,
      maxInjectedChars: 240,
    });

    assert.match(context.text, /^Learned procedures:/);
    assert.equal(context.results.length, 1);
    assert.equal(context.results[0]?.item.id, activeProcedure?.id);
  });
});

test("procedural memory retires a published procedure after repeated failure", async () => {
  await withRepository(async (repository, config) => {
    for (const [conversationId, minute] of [["conv_ok_1", 1], ["conv_ok_2", 11]] as const) {
      await consolidateConversationMemory(repository, {
        config,
        conversation: makeConversation(conversationId, [
          {
            id: `${conversationId}_user`,
            role: "user",
            authorRole: "user",
            mode: "auto",
            content: "Fix the TypeScript build in memory retrieval.",
            createdAt: `2026-03-12T${minute === 1 ? "10" : "11"}:00:00.000Z`,
          },
          {
            id: `${conversationId}_assistant`,
            role: "assistant",
            authorRole: "director",
            mode: "auto",
            content: "Completed the fix and verified the build succeeds.",
            createdAt: `2026-03-12T${minute === 1 ? "10" : "11"}:01:00.000Z`,
          },
        ]),
        toolObservations: makeSuccessObservations(minute),
        now: `2026-03-12T${minute === 1 ? "10" : "11"}:02:00.000Z`,
      });
    }

    for (const [conversationId, minute] of [["conv_fail_1", 1], ["conv_fail_2", 11]] as const) {
      await consolidateConversationMemory(repository, {
        config,
        conversation: makeConversation(conversationId, [
          {
            id: `${conversationId}_user`,
            role: "user",
            authorRole: "user",
            mode: "auto",
            content: "Fix the TypeScript build in memory retrieval.",
            createdAt: `2026-03-13T${minute === 1 ? "10" : "11"}:00:00.000Z`,
          },
          {
            id: `${conversationId}_assistant`,
            role: "assistant",
            authorRole: "director",
            mode: "auto",
            content: "The build failed again and the routine no longer works.",
            createdAt: `2026-03-13T${minute === 1 ? "10" : "11"}:01:00.000Z`,
          },
        ]),
        toolObservations: makeFailureObservations(minute),
        now: `2026-03-13T${minute === 1 ? "10" : "11"}:02:00.000Z`,
      });
    }

    const procedures = (await repository.listItems({ includeSuperseded: true })).filter(
      (item) => item.memoryType === "procedure",
    );
    const activeProcedure = procedures.find((item) => !item.supersededById);

    assert.ok(activeProcedure);
    assert.equal(activeProcedure?.jsonValue?.retired, true);
    assert.equal(activeProcedure?.jsonValue?.published, false);
    assert.equal(activeProcedure?.jsonValue?.failureCount, 2);
    assert.equal(isProcedurePublished(activeProcedure!), false);
  });
});
