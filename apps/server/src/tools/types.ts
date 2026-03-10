import type { ToolDefinition, ToolResult } from "@ember/core";

export type { ToolResult };

/**
 * An EmberTool bundles everything needed to register a tool with the system:
 * - definition   → the JSON schema sent to the LLM
 * - systemPrompt → one-liner injected into the role's system prompt
 * - execute      → the handler called when the LLM invokes the tool
 */
export interface EmberTool {
  definition: ToolDefinition;
  systemPrompt: string;
  execute: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}
