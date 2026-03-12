import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "@ember/core";

import {
  buildProcedureMemorySearchQuery,
  buildStructuredMemorySearchQuery,
  hasProcedureMemorySearchCues,
} from "./memory-query.js";

function makeMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "authorRole" | "mode" | "content" | "createdAt">): ChatMessage {
  return {
    attachments: [],
    toolCalls: [],
    thinking: null,
    providerId: null,
    providerName: null,
    modelId: null,
    routedTo: null,
    blocks: [],
    historySummary: null,
    ...overrides,
  };
}

test("buildStructuredMemorySearchQuery derives role, tool, topic, and task-state cues", () => {
  const conversation: ChatMessage[] = [
    makeMessage({
      id: "msg_user",
      role: "user",
      authorRole: "user",
      mode: "auto",
      content: "The TypeScript build is failing in the memory pipeline.",
      createdAt: "2026-03-12T10:00:00.000Z",
    }),
    makeMessage({
      id: "msg_assistant",
      role: "assistant",
      authorRole: "director",
      mode: "auto",
      content: "I ran diagnostics.",
      createdAt: "2026-03-12T10:01:00.000Z",
      toolCalls: [
        {
          id: "tool_terminal",
          name: "run_terminal_command",
          arguments: { command: "pnpm build" },
          status: "error",
          result: "build failed",
          startedAt: "2026-03-12T10:01:00.000Z",
        },
        {
          id: "tool_git",
          name: "git_inspect",
          arguments: {},
          status: "complete",
          result: "dirty worktree",
          startedAt: "2026-03-12T10:01:10.000Z",
        },
      ],
    }),
  ];

  const query = buildStructuredMemorySearchQuery({
    content: "Fix the TypeScript build regression in memory retrieval.",
    conversation,
    activeRole: "director",
    activeSessionId: "conv_live",
    handoffSourceRole: "coordinator",
  });

  assert.equal(query.activeRole, "director");
  assert.equal(query.handoffSourceRole, "coordinator");
  assert.equal(query.activeSessionId, "conv_live");
  assert.ok(query.recentToolNames?.includes("run_terminal_command"));
  assert.ok(query.recentToolNames?.includes("git_inspect"));
  assert.ok(query.workspaceTopics?.includes("typescript"));
  assert.ok(query.workspaceTopics?.includes("memory"));
  assert.equal(query.taskState, "blocked");
  assert.ok(query.memoryTypes?.includes("project_fact"));
  assert.ok(!query.memoryTypes?.includes("procedure"));
  assert.deepEqual(query.preferredSourceTypes, ["tool_result", "assistant_message", "session_summary"]);
});

test("buildStructuredMemorySearchQuery prefers web provenance for latest-law questions", () => {
  const query = buildStructuredMemorySearchQuery({
    content: "What is the latest privacy law change and what source did we use?",
    conversation: [],
    activeRole: "coordinator",
    activeSessionId: "conv_world",
  });

  assert.deepEqual(query.preferredSourceTypes, ["web_page", "system"]);
  assert.equal(query.taskState, null);
});

test("buildProcedureMemorySearchQuery isolates procedure recall from fact recall", () => {
  const conversation: ChatMessage[] = [
    makeMessage({
      id: "msg_user",
      role: "user",
      authorRole: "user",
      mode: "auto",
      content: "Fix the TypeScript build in the memory package.",
      createdAt: "2026-03-12T10:00:00.000Z",
    }),
    makeMessage({
      id: "msg_assistant",
      role: "assistant",
      authorRole: "director",
      mode: "auto",
      content: "I used the repo tools to inspect the failure.",
      createdAt: "2026-03-12T10:01:00.000Z",
      toolCalls: [
        {
          id: "tool_search",
          name: "search_files",
          arguments: { query: "memory" },
          status: "complete",
          result: "matches",
          startedAt: "2026-03-12T10:01:00.000Z",
        },
      ],
    }),
  ];

  const query = buildProcedureMemorySearchQuery({
    content: "Fix the TypeScript build in the memory package.",
    conversation,
    activeRole: "director",
    activeSessionId: "conv_live",
  });

  assert.deepEqual(query.scopes, ["workspace"]);
  assert.deepEqual(query.memoryTypes, ["procedure"]);
  assert.ok(query.recentToolNames?.includes("search_files"));
  assert.ok(query.workspaceTopics?.includes("typescript"));
  assert.equal(hasProcedureMemorySearchCues(query), true);
});
