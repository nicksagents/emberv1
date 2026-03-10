import test from "node:test";
import assert from "node:assert/strict";

import {
  compactConversationHistory,
  getHistorySummaryMessage,
} from "./conversation-compaction.js";
import type { ChatMessage, ToolCall } from "./types.js";

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
  const conversation: ChatMessage[] = [
    makeMessage({
      id: "u1",
      role: "user",
      authorRole: "user",
      mode: "auto",
      content: "Implement a long-running auth migration without breaking tests.",
    }),
    makeMessage({
      id: "a1",
      role: "assistant",
      authorRole: "director",
      mode: "auto",
      content: "I reviewed the auth flow and mapped the affected files.",
      toolCalls: [makeToolCall()],
    }),
    makeMessage({
      id: "u2",
      role: "user",
      authorRole: "user",
      mode: "auto",
      content: "Please preserve the current CLI behavior and keep tool usage visible.",
    }),
    makeMessage({
      id: "a2",
      role: "assistant",
      authorRole: "inspector",
      mode: "auto",
      content: "I validated the current behavior and noted the regression risks.",
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
      content: "I updated the plan and still need to patch the provider formatting.",
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
    preserveRecentMessages: 4,
    triggerMessageCount: 6,
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
});

test("compactConversationHistory is idempotent once a summary exists", () => {
  const firstPass = compactConversationHistory(
    [
      makeMessage({
        id: "u1",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "First request.",
      }),
      makeMessage({
        id: "a1",
        role: "assistant",
        authorRole: "coordinator",
        mode: "auto",
        content: "First answer.",
      }),
      makeMessage({
        id: "u2",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Second request.",
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        authorRole: "director",
        mode: "auto",
        content: "Second answer.",
      }),
      makeMessage({
        id: "u3",
        role: "user",
        authorRole: "user",
        mode: "auto",
        content: "Third request.",
      }),
      makeMessage({
        id: "a3",
        role: "assistant",
        authorRole: "director",
        mode: "auto",
        content: "Third answer.",
      }),
    ],
    {
      preserveRecentMessages: 2,
      triggerMessageCount: 4,
    },
  );

  const secondPass = compactConversationHistory(firstPass.messages, {
    preserveRecentMessages: 2,
    triggerMessageCount: 4,
  });

  assert.equal(secondPass.didCompact, false);
  assert.deepEqual(secondPass.messages, firstPass.messages);
});
