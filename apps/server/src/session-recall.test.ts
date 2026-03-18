import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, Conversation } from "@ember/core";
import { normalizeSessionRecallQuery, searchSessionRecall } from "./session-recall.js";

function makeMessage(input: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "authorRole" | "content">): ChatMessage {
  return {
    id: input.id,
    role: input.role,
    authorRole: input.authorRole,
    mode: "auto",
    content: input.content,
    createdAt: input.createdAt ?? "2026-03-01T12:00:00.000Z",
    toolCalls: input.toolCalls ?? [],
  };
}

function makeConversation(
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    title: overrides.title ?? id,
    mode: overrides.mode ?? "auto",
    createdAt: overrides.createdAt ?? "2026-03-01T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-01T12:05:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    lastMessageAt: overrides.lastMessageAt ?? "2026-03-01T12:05:00.000Z",
    preview: overrides.preview ?? "",
    messageCount: overrides.messageCount ?? (overrides.messages?.length ?? 0),
    messages: overrides.messages ?? [],
  };
}

test("normalizeSessionRecallQuery rejects empty requests and normalizes valid input", () => {
  assert.equal(normalizeSessionRecallQuery({}), null);

  const query = normalizeSessionRecallQuery({
    query: "migration status",
    role: "director",
    source: "assistant",
    date_from: "2026-03-01",
    max_results: 50,
    max_chars: 50,
  });
  assert.ok(query);
  assert.equal(query!.query, "migration status");
  assert.equal(query!.role, "director");
  assert.equal(query!.source, "assistant");
  assert.equal(query!.dateFrom, "2026-03-01");
  assert.equal(query!.maxResults, 10);
  assert.equal(query!.maxChars, 400);
});

test("searchSessionRecall ranks matches and returns compact summaries", () => {
  const conversations: Conversation[] = [
    makeConversation("conv_auth", {
      title: "Auth migration",
      preview: "Moved API auth middleware to bearer tokens.",
      updatedAt: "2026-03-15T10:00:00.000Z",
      messages: [
        makeMessage({
          id: "m1",
          role: "user",
          authorRole: "user",
          content: "Please migrate API auth to bearer tokens.",
        }),
        makeMessage({
          id: "m2",
          role: "assistant",
          authorRole: "director",
          content: "Implemented auth middleware and validated all /api routes.",
        }),
      ],
    }),
    makeConversation("conv_ui", {
      title: "UI polish",
      preview: "Adjusted nav spacing and loading states.",
      updatedAt: "2026-03-14T10:00:00.000Z",
      messages: [
        makeMessage({
          id: "m3",
          role: "assistant",
          authorRole: "advisor",
          content: "We tuned spacing and button focus states.",
        }),
      ],
    }),
  ];
  const query = normalizeSessionRecallQuery({
    query: "auth middleware bearer token",
    max_results: 2,
    max_chars: 1200,
  });
  assert.ok(query);

  const result = searchSessionRecall(conversations, query!, "2026-03-16T10:00:00.000Z");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.conversationId, "conv_auth");
  assert.match(result.items[0]?.summary ?? "", /auth middleware/i);
  assert.match(result.recallBlock, /Session recall results/);
  assert.match(result.recallBlock, /conv_auth/);
});

test("searchSessionRecall applies project/date/role/source filters", () => {
  const conversations: Conversation[] = [
    makeConversation("conv_ember", {
      title: "Ember runtime hardening",
      preview: "Server security and route auth updates.",
      updatedAt: "2026-03-15T08:00:00.000Z",
      messages: [
        makeMessage({
          id: "e1",
          role: "assistant",
          authorRole: "director",
          content: "Added rate limiting and auth checks.",
          toolCalls: [
            {
              id: "tc1",
              name: "run_terminal_command",
              arguments: { command: "pnpm test" },
              status: "complete",
              startedAt: "2026-03-15T08:01:00.000Z",
              endedAt: "2026-03-15T08:02:00.000Z",
              result: "all tests passed",
            },
          ],
        }),
      ],
    }),
    makeConversation("conv_other", {
      title: "Travel planning",
      preview: "Booked flights and hotels.",
      updatedAt: "2026-02-20T08:00:00.000Z",
      messages: [
        makeMessage({
          id: "o1",
          role: "user",
          authorRole: "user",
          content: "Let's plan travel.",
        }),
      ],
    }),
  ];

  const filteredQuery = normalizeSessionRecallQuery({
    project: "ember",
    role: "director",
    source: "tool",
    date_from: "2026-03-01",
    date_to: "2026-03-31",
  });
  assert.ok(filteredQuery);

  const result = searchSessionRecall(conversations, filteredQuery!, "2026-03-16T10:00:00.000Z");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.conversationId, "conv_ember");
  assert.ok(result.items[0]?.matchedSources.includes("tool"));
});

test("searchSessionRecall truncates output when max_chars is tight", () => {
  const longText = "auth ".repeat(200);
  const conversations: Conversation[] = [
    makeConversation("conv_long", {
      title: "Long recall",
      preview: longText,
      updatedAt: "2026-03-15T08:00:00.000Z",
      messages: [
        makeMessage({
          id: "l1",
          role: "assistant",
          authorRole: "coordinator",
          content: longText,
        }),
      ],
    }),
  ];
  const query = normalizeSessionRecallQuery({
    query: "auth",
    max_chars: 420,
  });
  assert.ok(query);

  const result = searchSessionRecall(conversations, query!, "2026-03-16T10:00:00.000Z");
  assert.equal(result.truncated, true);
  assert.match(result.recallBlock, /truncated/i);
});
