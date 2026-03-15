import type { ChatMessage, ToolCall } from "./types";

export interface ToolResultAgingOptions {
  /** Messages from the end of conversation that keep full tool results */
  preserveRecentCount: number;
  /** Max chars for tool results in the "old" zone (middle of non-recent) */
  oldResultCharLimit: number;
  /** Max chars for tool results in the "ancient" zone (oldest third of non-recent) */
  ancientResultCharLimit: number;
  /** Tool names whose results are never truncated */
  protectedTools?: Set<string>;
}

const DEFAULT_OPTIONS: ToolResultAgingOptions = {
  preserveRecentCount: 8,
  oldResultCharLimit: 800,
  ancientResultCharLimit: 200,
  protectedTools: new Set(["handoff"]),
};

// ─── Context-scaled tool result budget ──────────────────────────────────────
// For small models, tool results must be capped proportionally to context window.
// A 35k model can't afford 2k tokens for a single file read.

/** Max fraction of context window a single tool result may consume. */
const TOOL_RESULT_CONTEXT_SHARE = 0.06;
/** Absolute minimum chars for any tool result (even tiny models). */
const MIN_TOOL_RESULT_CHARS = 300;
/** Absolute maximum chars for tool results (even huge models). */
const MAX_TOOL_RESULT_CHARS = 16_000;
/** Chars-to-tokens rough ratio for tool results. */
const TOOL_RESULT_CHARS_PER_TOKEN = 3.2;

/**
 * Compute the max chars a single tool result should occupy based on context window.
 * Use this to cap results at capture time — prevention, not just aging.
 */
export function resolveToolResultCharBudget(contextWindowTokens: number): number {
  const tokenBudget = Math.floor(contextWindowTokens * TOOL_RESULT_CONTEXT_SHARE);
  const charBudget = Math.floor(tokenBudget * TOOL_RESULT_CHARS_PER_TOKEN);
  return Math.max(MIN_TOOL_RESULT_CHARS, Math.min(MAX_TOOL_RESULT_CHARS, charBudget));
}

/**
 * Cap a tool result string to a context-appropriate length.
 * Called at tool execution time to prevent oversized results from entering history.
 */
export function capToolResult(
  result: string,
  contextWindowTokens: number,
): string {
  const budget = resolveToolResultCharBudget(contextWindowTokens);
  if (result.length <= budget) {
    return result;
  }
  return truncateResultPreservingEdges(result, budget);
}

/**
 * Derive aging options scaled to the context window size.
 * Small models get much tighter limits; large models get generous ones.
 */
export function deriveAgingOptionsForContext(
  contextWindowTokens: number,
  fillRatio: number,
): ToolResultAgingOptions {
  // Scale preserve count: tiny models keep fewer recent messages
  const basePreserve = contextWindowTokens < 32_000 ? 4
    : contextWindowTokens < 64_000 ? 6
    : contextWindowTokens < 128_000 ? 8
    : 10;

  // Scale char limits proportionally to context window
  const scale = Math.max(0.2, Math.min(1.0, contextWindowTokens / 100_000));

  // Tighten further based on fill ratio (higher pressure = tighter limits)
  const pressureMultiplier = Math.max(0.3, 1.0 - (fillRatio * 0.8));

  const preserveRecentCount = Math.max(2, Math.floor(basePreserve * pressureMultiplier));
  const oldResultCharLimit = Math.max(100, Math.floor(1200 * scale * pressureMultiplier));
  const ancientResultCharLimit = Math.max(60, Math.floor(400 * scale * pressureMultiplier));

  return {
    preserveRecentCount,
    oldResultCharLimit,
    ancientResultCharLimit,
    protectedTools: new Set(["handoff"]),
  };
}

const ERROR_CHAR_MULTIPLIER = 2;

function truncateResultPreservingEdges(
  result: string,
  limit: number,
): string {
  if (result.length <= limit) {
    return result;
  }

  // Preserve first and last lines (keeps file paths, exit codes, error messages)
  const lines = result.split("\n");
  if (lines.length <= 2) {
    return `${result.slice(0, limit - 20)}\n... [truncated]`;
  }

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const edgeChars = (firstLine?.length ?? 0) + (lastLine?.length ?? 0) + 30;

  if (edgeChars >= limit) {
    // Edges alone exceed limit — just take the start
    return `${result.slice(0, limit - 20)}\n... [truncated]`;
  }

  const middleBudget = limit - edgeChars;
  const middleContent = lines.slice(1, -1).join("\n");
  const truncatedMiddle = middleContent.slice(0, middleBudget);

  return `${firstLine}\n${truncatedMiddle}\n... [${result.length - limit} chars truncated]\n${lastLine}`;
}

function summarizeToolResult(
  toolCall: ToolCall,
  limit: number,
): string {
  const result = toolCall.result ?? "";
  if (result.length <= limit) {
    return result;
  }

  const argsPreview = formatArgsPreview(toolCall.arguments, 60);
  const summary = `[truncated: ${toolCall.name}(${argsPreview}) -> ${toolCall.status}, originally ${result.length} chars]`;

  if (summary.length <= limit) {
    return summary;
  }

  return summary.slice(0, limit);
}

function formatArgsPreview(
  args: Record<string, unknown>,
  limit: number,
): string {
  try {
    const text = JSON.stringify(args);
    const normalized = text.replace(/\s+/g, " ");
    return normalized.length > limit
      ? `${normalized.slice(0, limit - 1)}…`
      : normalized;
  } catch {
    return "...";
  }
}

function getEffectiveCharLimit(
  toolCall: ToolCall,
  baseLimit: number,
): number {
  // Error results get 2x the char limit — errors are more valuable than success output
  if (toolCall.status === "error") {
    return baseLimit * ERROR_CHAR_MULTIPLIER;
  }
  return baseLimit;
}

function ageToolCall(
  toolCall: ToolCall,
  zone: "old" | "ancient",
  options: ToolResultAgingOptions,
): ToolCall {
  if (!toolCall.result || toolCall.result.length === 0) {
    return toolCall;
  }

  if (options.protectedTools?.has(toolCall.name)) {
    return toolCall;
  }

  const baseLimit =
    zone === "old" ? options.oldResultCharLimit : options.ancientResultCharLimit;
  const effectiveLimit = getEffectiveCharLimit(toolCall, baseLimit);

  if (toolCall.result.length <= effectiveLimit) {
    return toolCall;
  }

  const agedResult =
    zone === "old"
      ? truncateResultPreservingEdges(toolCall.result, effectiveLimit)
      : summarizeToolResult(toolCall, effectiveLimit);

  return { ...toolCall, result: agedResult };
}

function ageMessageAttachments(message: ChatMessage): ChatMessage {
  if (!message.attachments?.length) {
    return message;
  }

  const agedAttachments = message.attachments.map((attachment) => {
    if (attachment.kind === "image") {
      return {
        ...attachment,
        dataUrl: "[image removed for context savings]",
      };
    }
    return attachment;
  });

  return { ...message, attachments: agedAttachments };
}

/**
 * Compresses old tool results in conversation history based on their age
 * (position from the end of the conversation).
 *
 * Messages are divided into three zones:
 * - Recent (last N): untouched
 * - Old (middle third of non-recent): tool results truncated, preserving edges
 * - Ancient (oldest third of non-recent): tool results replaced with one-line summaries
 *
 * Returns a new array — does not mutate the input.
 */
export function ageToolResults(
  conversation: ChatMessage[],
  options: Partial<ToolResultAgingOptions> = {},
): ChatMessage[] {
  const opts: ToolResultAgingOptions = { ...DEFAULT_OPTIONS, ...options };

  if (conversation.length <= opts.preserveRecentCount) {
    return conversation;
  }

  const recentStart = conversation.length - opts.preserveRecentCount;
  const nonRecentCount = recentStart;
  const ancientEnd = Math.floor(nonRecentCount / 3);
  const oldEnd = Math.floor((nonRecentCount * 2) / 3);

  return conversation.map((message, index) => {
    // Recent zone: untouched
    if (index >= recentStart) {
      return message;
    }

    let aged = message;

    // Age tool calls
    if (message.toolCalls?.length) {
      const zone: "old" | "ancient" = index < ancientEnd ? "ancient" : "old";
      const agedToolCalls = message.toolCalls.map((tc) =>
        ageToolCall(tc, zone, opts),
      );

      // Only create new object if something changed
      const hasChanges = agedToolCalls.some(
        (tc, i) => tc !== message.toolCalls![i],
      );
      if (hasChanges) {
        aged = { ...aged, toolCalls: agedToolCalls };
      }
    }

    // Ancient zone: also strip image attachments
    if (index < ancientEnd) {
      aged = ageMessageAttachments(aged);
    }

    return aged;
  });
}
