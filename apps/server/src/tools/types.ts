import type { ToolDefinition, ToolResult } from "@ember/core";

export type { ToolResult };

/**
 * An EmberTool bundles everything needed to register a tool with the system:
 * - definition → the JSON schema sent to the LLM
 * - execute    → the handler called when the LLM invokes the tool
 *
 * Workflow guidance lives in skills/<tool-name>/SKILL.md — not on the tool itself.
 * See docs/SKILLS.md and apps/server/src/tools/TOOLS.md for the full architecture.
 */
export interface EmberTool {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
  /** Tool priority for model-adaptive filtering (1=essential, 5=specialized). Lower = included first. Default 3. */
  priority?: number;
}
