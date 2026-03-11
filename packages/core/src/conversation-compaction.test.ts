import test from "node:test";
import assert from "node:assert/strict";

import {
  compactConversationHistory,
  getHistorySummaryMessage,
} from "./conversation-compaction.js";
import type { ChatMessage, ToolCall } from "./types.js";

const PROMPT_STACK = {
  shared: "You are Ember. Keep strong long-term memory.",
  role: "Act as the coding role for this workspace.",
  tools: "Tool use is available.",
};

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: `tool_${Math.random().toString(36).slice(2, 8)}`,
    name: "search_files",
    arguments: { query: "auth" },
    result: "Found auth.ts and auth.test.ts",
    status: "complete",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "authorRole" | "mode" | "content">): ChatMessage {
  return {
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("compactConversationHistory preserves recent turns and summarizes tool history", () => {
  const longBody =
    "Implement a long-running auth migration without breaking tests. Preserve the API behavior, keep the CLI stable, and remember every tool result and regression note. ";
  const conversation: ChatMessage[] = [
    makeMessage({
      id: "u1",
      role: "user",
      authorRole: "user",
      mode: "auto",
      content: longBody.repeat(12),
    }),
    makeMessage({
      id: "a1",
      role: "assistant",
      authorRole: "director",
      mode: "auto",
      content: "I reviewed the auth flow and mapped the affected files. ".repeat(12),
      toolCalls: [makeToolCall()],
    }),
    makeMessage({
      id: "u2",
      role: "user",
      authorRole: "user",
      mode: "auto",
      content: "Please preserve the current CLI behavior and keep tool usage visible. ".repeat(10),
    }),
    makeMessage({
      id: "a2",
      role: "assistant",
      authorRole: "inspector",
      mode: "auto",
      content: "I validated the current behavior and noted the regression risks. ".repeat(10),
    }),
    makeMessage({
      id: "u3",
      role: "user",
      authorRole: "user",
      mode: "auto",
      content: "Continue.",
    }),
    makeMessage({
      id: "a3",
      role: "assistant",
      authorRole: "director",
      mode: "auto",
      content: "I updated the plan and still need to patch the provider formatting. ".repeat(8),
    }),
    makeMessage({
      id: "u4",
      role: "user",
      authorRole: "user",
      mode: "auto",
      content: "Also make sure the router still sees the old context.",
    }),
    makeMessage({
      id: "a4",
      role: "assistant",
      authorRole: "coordinator",
      mode: "auto",
      content: "I can do that next.",
    }),
  ];

  const result = compactConversationHistory(conversation, {
    promptStack: PROMPT_STACK,
    currentUserContent: "Continue the migration without losing earlier context.",
    maxPromptTokens: 1_200,
    targetPromptTokens: 700,
    preserveRecentMessages: 4,
    minimumRecentMessages: 4,
  });

  assert.equal(result.didCompact, true);
  assert.equal(result.messages.length, 5);
  assert.deepEqual(
    result.messages.slice(1).map((message) => message.id),
    ["u3", "a3", "u4", "a4"],
  );

  const summary = getHistorySummaryMessage(result.messages);
  assert.ok(summary);
  assert.match(summary.content, /Conversation memory summary/);
  assert.match(summary.content, /Goal:/);
  assert.match(summary.content, /Tool and action memory:/);
  assert.match(summary.content, /search_files/);
  assert.equal(summary.historySummary?.sourceMessageCount, 4);
  assert.ok(result.compactedTokenCount < result.originalTokenCount);
  assert.ok(result.compactedTokenCount <= 1_200);
});

test("compactConversationHistory can roll an existing summary forward with newer history", () => {
  const conversation: ChatMessage[] = [
    makeMessage({
      id: "summary_1",
      role: "assistant",
      authorRole: "coordinator",
      mode: "auto",
      content:
        "Conversation memory summary. Goal: migrate auth. Decisions: API behavior stays stable. Open threads: patch provider formatting.",
      historySummary: {
        kind: "history-summary",
        sourceMessageCount: 6,
        sourceToolCallCount: 2,
        generatedAt: new Date().toISOString(),
      },
    }),
    ...Array.from({ length: 6 }, (_, index): ChatMessage =>
      makeMessage({
        id: `roll_${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        authorRole: index % 2 === 0 ? "user" : "director",
        mode: "auto",
        content:
          `Rolling memory message ${index + 1}. ` +
          "Keep the prior summary merged forward and preserve old auth decisions. ".repeat(24),
      }),
    ),
  ];

  const secondPass = compactConversationHistory(conversation, {
    promptStack: PROMPT_STACK,
    currentUserContent: "Continue the implementation.",
    maxPromptTokens: 500,
    targetPromptTokens: 320,
    preserveRecentMessages: 2,
    minimumRecentMessages: 2,
  });

  assert.equal(secondPass.didCompact, true);
  const summary = getHistorySummaryMessage(secondPass.messages);
  assert.ok(summary);
  assert.ok((summary.historySummary?.sourceMessageCount ?? 0) >= 6);
  assert.match(summary.content, /Prior compacted memory|Open threads|Decisions and completed work/);
});

test("compactConversationHistory can reduce recent tail down to the configured minimum", () => {
  const conversation = Array.from({ length: 10 }, (_, index): ChatMessage =>
    makeMessage({
      id: `msg_${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      authorRole: index % 2 === 0 ? "user" : "director",
      mode: "auto",
      content: `Long message ${index + 1}. ${"Token heavy content. ".repeat(36)}`,
    }),
  );

  const result = compactConversationHistory(conversation, {
    promptStack: PROMPT_STACK,
    currentUserContent: "Continue with the current task.",
    maxPromptTokens: 700,
    targetPromptTokens: 420,
    preserveRecentMessages: 6,
    minimumRecentMessages: 4,
  });

  assert.equal(result.didCompact, true);
  assert.deepEqual(
    result.messages.slice(1).map((message) => message.id),
    ["msg_6", "msg_7", "msg_8", "msg_9"],
  );
  assert.ok(result.compactedTokenCount < result.originalTokenCount);
});
