import { readConversations } from "@ember/core";
import { normalizeSessionRecallQuery, searchSessionRecall } from "../session-recall.js";
import type { EmberTool } from "./types.js";

async function sessionRecallExecute(input: Record<string, unknown>): Promise<string> {
  const query = normalizeSessionRecallQuery(input);
  if (!query) {
    return "Error: provide at least one session recall filter (query, project, role, source, date_from, or date_to).";
  }

  try {
    const conversations = await readConversations();
    const result = searchSessionRecall(conversations, query);
    return result.recallBlock;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const sessionRecallTool: EmberTool = {
  definition: {
    name: "session_recall",
    description:
      "Search prior conversation history with ranked snippets across sessions. Supports project/date/role/source filters and returns a compact recall block sized for prompt budgets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional free-text search query for prior chats.",
        },
        project: {
          type: "string",
          description: "Optional project name or token to scope recall.",
        },
        role: {
          type: "string",
          enum: ["user", "dispatch", "coordinator", "advisor", "director", "inspector", "ops"],
          description: "Optional author role filter.",
        },
        source: {
          type: "string",
          enum: ["user", "assistant", "system", "tool"],
          description: "Optional source filter for matched snippets.",
        },
        date_from: {
          type: "string",
          description: "Optional ISO-8601 lower bound for conversation updatedAt.",
        },
        date_to: {
          type: "string",
          description: "Optional ISO-8601 upper bound for conversation updatedAt.",
        },
        max_results: {
          type: "number",
          description: "Optional result count (default 4, max 10).",
        },
        max_chars: {
          type: "number",
          description: "Optional output size budget in characters (default 1800).",
        },
      },
    },
  },
  execute: sessionRecallExecute,
};
