import type { EmberTool } from "./types.js";
import { getParallelTaskPolicy, parseParallelTaskRequest } from "../parallel-tasks.js";

export const parallelTasksTool: EmberTool = {
  definition: {
    name: "launch_parallel_tasks",
    description:
      "Run independent EMBER subtasks concurrently with bounded depth/concurrency and child execution profiles. Use this only when tasks are independent and will not fight over the same file edits.",
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
              profile: {
                type: "string",
                enum: ["standard", "read-only", "investigation"],
                description:
                  "Optional child tool profile. standard allows normal tools, read-only blocks mutations/shell writes, investigation limits to analysis/research tools.",
              },
            },
            required: ["title", "task"],
            additionalProperties: false,
          },
        },
        max_concurrency: {
          type: "number",
          description: "Optional per-call concurrency cap (bounded by server policy).",
        },
        timeout_ms: {
          type: "number",
          description: "Optional per-child timeout budget in milliseconds (bounded by server policy).",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  execute: async (input) => {
    const policy = getParallelTaskPolicy();
    const parsed = parseParallelTaskRequest(input, "coordinator", {
      maxTasks: policy.maxTasks,
    });
    if (parsed.error) {
      return parsed.error;
    }

    return [
      "launch_parallel_tasks request parsed successfully.",
      `Tasks: ${parsed.tasks.length}`,
      `Policy max tasks: ${policy.maxTasks}`,
      "Execution is performed by the server tool-runtime coordinator.",
    ].join("\n");
  },
};
