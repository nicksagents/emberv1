/**
 * Schema normalization utilities for MCP ↔ Ember ↔ LLM provider mapping.
 *
 * MCP tools declare their inputs with standard JSON Schema (`inputSchema`).
 * The Anthropic API expects `input_schema`; OpenAI-compatible providers expect
 * `parameters`. The connectors package handles that final renaming — this
 * module ensures the schema object itself is well-formed and safe to pass
 * through either path.
 *
 * Design principle: preserve the full JSON Schema. Small models benefit from
 * the extra property metadata (enum values, descriptions, nested types). Only
 * patch what is structurally required.
 */

/** The minimum valid Ember input schema — always an object at the top level. */
export interface NormalizedInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Normalize an MCP tool's `inputSchema` into the shape expected by
 * `ToolDefinition.inputSchema`.
 *
 * Rules:
 *  - If the schema is missing or null, return an empty object schema.
 *  - If `type` is not "object", wrap the schema in an object with a single
 *    `input` property (unusual but valid for non-object MCP tools).
 *  - Strip the `$schema` meta-property — LLM APIs reject it.
 *  - Pass everything else through unchanged.
 */
export function normalizeToolSchema(rawSchema: unknown): NormalizedInputSchema {
  if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
    return { type: "object", properties: {} };
  }

  const schema = rawSchema as Record<string, unknown>;

  // Strip $schema — most LLM provider APIs reject it as an unknown field
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema: _stripped, ...rest } = schema;

  // Ensure the top level is always type: "object"
  if (rest.type !== "object") {
    // Rare: MCP tool has a non-object top-level schema. Wrap it gracefully
    // so the Ember/LLM layer always sees a uniform object schema.
    return {
      type: "object",
      properties: {
        input: {
          description: "Tool input",
          ...rest,
        },
      },
    };
  }

  return {
    type: "object",
    ...(rest.properties !== undefined && { properties: rest.properties as Record<string, unknown> }),
    ...(Array.isArray(rest.required) && { required: rest.required as string[] }),
    // Pass through additional JSON Schema keywords (allOf, anyOf, $defs, etc.)
    ...Object.fromEntries(
      Object.entries(rest).filter(
        ([k]) => k !== "type" && k !== "properties" && k !== "required",
      ),
    ),
  };
}

/**
 * Format a raw MCP CallToolResult into a string for the Ember ToolResult.
 * Returns the concatenated text of all text content blocks, or an error
 * string if the result is flagged as an error.
 *
 * Image content blocks are returned separately via `extractImageResult`.
 */
export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  content?: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Convert an MCP CallToolResult to the Ember string ToolResult.
 * Always produces a non-empty string — errors are surfaced as readable messages.
 */
export function formatMcpResult(result: McpCallToolResult, toolName: string): string {
  if (!result) return `[${toolName}] No result returned.`;

  if (result.isError) {
    const errorText = (result.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");
    return `[${toolName} error] ${errorText || "Unknown error from MCP server."}`;
  }

  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "image" || block.type === "audio") {
      parts.push(`[${block.type}: ${block.mimeType ?? "unknown"}]`);
    } else if (block.type === "resource") {
      const res = block.resource as { text?: string; mimeType?: string } | undefined;
      parts.push(res?.text ?? `[resource: ${res?.mimeType ?? "unknown"}]`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : `[${toolName}] (empty response)`;
}

/**
 * If the first content block of an MCP result is an image, extract it for
 * Ember's ToolImageResult format. Returns null if no image block is present.
 */
export function extractImageResult(
  result: McpCallToolResult,
): { imageBase64: string; imageMimeType: "image/png" | "image/jpeg" | "image/webp" } | null {
  const first = (result.content ?? []).find((c) => c.type === "image" && c.data && c.mimeType);
  if (!first) return null;

  const mime = first.mimeType as string;
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) return null;

  return {
    imageBase64: first.data as string,
    imageMimeType: mime as "image/png" | "image/jpeg" | "image/webp",
  };
}
