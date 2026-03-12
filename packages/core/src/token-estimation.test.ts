import assert from "node:assert/strict";
import test from "node:test";

import {
  estimatePromptExtraTokens,
  estimatePromptInputTokens,
  estimateToolDefinitionTokens,
  estimateToolDefinitionsTokens,
} from "./token-estimation.js";
import type { ToolDefinition } from "./types.js";

const TOOL_A: ToolDefinition = {
  name: "search_files",
  description: "Search the workspace for matching content.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text or regex to search for.",
      },
      includeHidden: {
        type: "boolean",
        description: "Whether to include dotfiles and ignored directories.",
      },
    },
    required: ["query"],
  },
};

const TOOL_B: ToolDefinition = {
  name: "read_file",
  description: "Read a file from the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or repo-relative file path.",
      },
    },
    required: ["path"],
  },
};

test("estimateToolDefinitionTokens counts schema-bearing tools", () => {
  const toolTokens = estimateToolDefinitionTokens(TOOL_A);

  assert.ok(toolTokens > 40);
});

test("estimatePromptExtraTokens includes tool schemas and injected memory text", () => {
  const toolTokens = estimateToolDefinitionsTokens([TOOL_A, TOOL_B]);
  const total = estimatePromptExtraTokens({
    tools: [TOOL_A, TOOL_B],
    memoryContextText: "Persistent memory:\n- Preference: use pnpm for this repo.",
    procedureContextText: "Learned procedures:\n- When testing, run pnpm --filter @ember/server build.",
  });

  assert.ok(toolTokens > 0);
  assert.ok(total > toolTokens);
});

test("estimatePromptExtraTokens can exceed the base prompt estimate for tool-heavy requests", () => {
  const basePromptTokens = estimatePromptInputTokens({
    promptStack: {
      shared: "You are Ember.",
      role: "Use tools carefully.",
      tools: "Tool use is available.",
    },
    conversation: [],
    content: "Check the workspace and summarize the result.",
  });
  const extraTokens = estimatePromptExtraTokens({
    tools: [TOOL_A, TOOL_B, TOOL_A, TOOL_B],
  });

  assert.ok(extraTokens > basePromptTokens);
});
