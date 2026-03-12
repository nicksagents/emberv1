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
      "Pass the current task to a specialist EMBER role when they are better suited to continue. " +
      "Call this AT MOST ONCE per response, and only after your own work is complete. " +
      "After calling handoff, write your final summary and stop using tools. " +
      "Valid roles: advisor (planning/architecture), coordinator (routine tasks), director (implementation/coding), inspector (review/testing), ops (polish/cleanup).",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description:
            "The role to hand off to. Must be one of: advisor, coordinator, director, inspector, ops",
        },
        message: {
          type: "string",
          description:
            "Context for the next role. Use this exact format:\n" +
            "GOAL: <what the user originally asked for>\n" +
            "DONE: <what you completed in this response>\n" +
            "TODO: <what the next role should do>\n" +
            "FILES: <key files created, modified, or relevant — list file paths>\n" +
            "NOTES: <warnings, blockers, or findings the next role must know>\n\n" +
            "For product-delivery workflows, also include:\n" +
            "WORKFLOW: product-delivery\n" +
            "PHASE: planning|implementation|inspection|finalization\n" +
            "STATUS: planning-required|plan-complete|ready-for-review|needs-fixes|approved\n" +
            "SCORE: <0.0-10.0>   # inspector handoffs only\n\n" +
            "If handing to inspector: specify exactly what to verify and what acceptance looks like.\n" +
            "If handing to director: list every issue to fix with file and location.",
        },
      },
      required: ["role", "message"],
    },
  },
  execute: async () => "Handoff acknowledged.",
};
