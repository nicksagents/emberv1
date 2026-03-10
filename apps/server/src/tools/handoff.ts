import type { EmberTool } from "./types.js";

/**
 * The handoff tool lets any role pass work to another EMBER role.
 * The execute function here is a fallback — it is intercepted by the
 * per-execution tool handler in the server loop before it ever reaches this.
 */
export const handoffTool: EmberTool = {
  definition: {
    name: "handoff",
    description:
      "Pass the current task to another EMBER role when they are better suited to continue or complete the work. Call this when you have finished your part and another specialist should take over.",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description:
            "The role to pass to. One of: advisor, coordinator, director, inspector, ops",
        },
        message: {
          type: "string",
          description:
            "What to tell the next role. Include the goal, what you already did, what remains, and any files, commands, or findings they need.",
        },
      },
      required: ["role", "message"],
    },
  },
  systemPrompt:
    "handoff — Use only when another role is clearly better suited to continue. In message, include the goal, work completed, remaining work, and the key files, commands, or findings.",
  execute: async () => "Handoff acknowledged.",
};
