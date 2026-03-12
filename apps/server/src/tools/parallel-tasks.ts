import type { EmberTool } from "./types.js";

export const parallelTasksTool: EmberTool = {
  definition: {
    name: "launch_parallel_tasks",
    description:
      "Run up to 4 independent EMBER subtasks concurrently. Each subtask can stay in the current role lane, target a specific role, or use auto routing. Use this only when the tasks are independent and will not fight over the same file edits.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description:
            "Independent subtasks to run in parallel. Keep each task self-contained and explicit. Omit role to stay in the current role, or set role=auto to let EMBER route it.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Short label for this subtask.",
              },
              task: {
                type: "string",
                description: "Self-contained instruction for the subtask.",
              },
              role: {
                type: "string",
                description: "Optional role lane: auto, coordinator, advisor, director, inspector, or ops.",
              },
            },
            required: ["title", "task"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  execute: async () => "Parallel tasks acknowledged.",
};
