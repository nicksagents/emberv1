import {
  estimateConversationTokens,
  estimatePromptInputTokens,
  estimateTextTokens,
} from "./token-estimation";
import { ageToolResults, deriveAgingOptionsForContext } from "./tool-result-aging";
import type { ChatMessage, PromptStack, ToolCall } from "./types";

export interface ConversationCompactionOptions {
  enabled?: boolean;
  maxPromptTokens?: number;
  targetPromptTokens?: number;
  extraPromptTokens?: number;
  preserveRecentMessages?: number;
  minimumRecentMessages?: number;
  promptStack?: PromptStack;
  currentUserContent?: string;
}

export interface ConversationCompactionResult {
  messages: ChatMessage[];
  didCompact: boolean;
  originalMessageCount: number;
  compactedMessageCount: number;
  originalTokenCount: number;
  compactedTokenCount: number;
}

const DEFAULT_ENABLED = true;
const DEFAULT_MAX_PROMPT_TOKENS = 35_000;
const DEFAULT_TARGET_PROMPT_TOKENS = 30_000;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 6;
const DEFAULT_MINIMUM_RECENT_MESSAGES = 4;
const MINIMUM_SUMMARY_TOKENS = 220;
const MAX_CONSTRAINTS = 6;
const MAX_OPEN_THREADS = 6;
const MAX_DECISIONS = 6;
const MAX_FAILURES = 5;
const MAX_TOOL_LINES = 8;
const MAX_TRANSCRIPT_LINES = 8;
const MAX_PRIOR_MEMORY_SEGMENTS = 2;

function summarizeText(content: string, limit: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function formatJsonPreview(value: unknown, limit: number): string {
  try {
    return summarizeText(JSON.stringify(value), limit);
  } catch {
    return summarizeText(String(value), limit);
  }
}

function uniqueLines(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function getAttachmentLabel(message: ChatMessage): string {
  const attachments = (message.attachments ?? [])
    .map((attachment) => attachment.name.trim() || attachment.id)
    .filter(Boolean);
  return attachments.length > 0 ? ` [attachments: ${attachments.join(", ")}]` : "";
}

function summarizeToolCall(toolCall: ToolCall): string {
  const args = formatJsonPreview(toolCall.arguments, 84);
  const result = toolCall.result ? `: ${summarizeText(toolCall.result, 120)}` : "";
  return `\`${toolCall.name}(${args})\` -> ${toolCall.status}${result}`;
}

function summarizeMessageLine(message: ChatMessage): string {
  const speaker =
    message.role === "user"
      ? "User"
      : message.role === "system"
        ? "System"
        : `Assistant (${message.authorRole})`;
  const base = summarizeText(message.content, 150) || "(no text)";
  const tools = (message.toolCalls ?? []).slice(0, 2).map(summarizeToolCall);
  const toolSuffix = tools.length > 0 ? ` [tools: ${tools.join("; ")}]` : "";
  return `${speaker}: ${base}${getAttachmentLabel(message)}${toolSuffix}`;
}

function getSummarySourceMessageCount(message: ChatMessage): number {
  return message.historySummary?.sourceMessageCount ?? 0;
}

function getSummarySourceToolCallCount(message: ChatMessage): number {
  return message.historySummary?.sourceToolCallCount ?? 0;
}

function extractGoal(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find(
    (message) => message.role === "user" && !isHistorySummaryMessage(message),
  );
  return summarizeText(firstUserMessage?.content ?? "Continue the existing task.", 180);
}

function extractConstraintCandidates(messages: ChatMessage[]): string[] {
  const constraintPattern =
    /\b(must|should|need to|needs to|please|do not|don't|avoid|without|keep|use|only|never|always|required)\b/i;
  return uniqueLines(
    messages
      .filter((message) => message.role === "user")
      .map((message) => summarizeText(message.content, 140))
      .filter((content) => constraintPattern.test(content)),
    MAX_CONSTRAINTS,
  );
}

function extractOpenThreadCandidates(messages: ChatMessage[], goal: string): string[] {
  return uniqueLines(
    [...messages]
      .reverse()
      .filter((message) => message.role === "user")
      .map((message) => summarizeText(message.content, 150))
      .filter((content) => content && content !== goal),
    MAX_OPEN_THREADS,
  );
}

function extractDecisionCandidates(messages: ChatMessage[]): string[] {
  return uniqueLines(
    [...messages]
      .reverse()
      .filter((message) => message.role === "assistant" && !isHistorySummaryMessage(message))
      .map((message) => summarizeText(message.content, 150))
      .filter(Boolean),
    MAX_DECISIONS,
  );
}

function extractFailureCandidates(messages: ChatMessage[]): string[] {
  const toolFailures = messages.flatMap((message) =>
    (message.toolCalls ?? [])
      .filter((toolCall) => toolCall.status === "error")
      .map((toolCall) => summarizeToolCall(toolCall)),
  );
  const messageFailures = messages
    .filter((message) => /\b(error|failed|failure|regression|broken|blocked)\b/i.test(message.content))
    .map((message) => summarizeMessageLine(message));

  return uniqueLines([...toolFailures.reverse(), ...messageFailures.reverse()], MAX_FAILURES);
}

function extractPriorMemory(messages: ChatMessage[]): string[] {
  return uniqueLines(
    messages
      .filter(isHistorySummaryMessage)
      .map((message) => summarizeText(message.content, 220))
      .filter(Boolean),
    MAX_PRIOR_MEMORY_SEGMENTS,
  );
}

function extractToolLines(messages: ChatMessage[]): string[] {
  return uniqueLines(
    messages
      .flatMap((message) => message.toolCalls ?? [])
      .map(summarizeToolCall)
      .reverse(),
    MAX_TOOL_LINES,
  );
}

function extractTranscriptLines(messages: ChatMessage[]): string[] {
  return messages.slice(-MAX_TRANSCRIPT_LINES).map(summarizeMessageLine);
}

function buildSection(title: string, items: string[]): string {
  if (items.length === 0) {
    return "";
  }

  return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function buildSummaryContent(
  messagesToCompress: ChatMessage[],
  summaryTokenBudget: number,
): { content: string; toolCallCount: number; estimatedTokens: number } {
  const priorSummaryMessageCount = messagesToCompress.reduce(
    (total, message) => total + getSummarySourceMessageCount(message),
    0,
  );
  const priorSummaryToolCallCount = messagesToCompress.reduce(
    (total, message) => total + getSummarySourceToolCallCount(message),
    0,
  );
  const rawMessages = messagesToCompress.filter((message) => !isHistorySummaryMessage(message));
  const toolCallCount =
    priorSummaryToolCallCount +
    rawMessages.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0);
  const goal = extractGoal(rawMessages);
  const constraints = extractConstraintCandidates(rawMessages);
  let openThreads = extractOpenThreadCandidates(rawMessages, goal);
  let decisions = extractDecisionCandidates(rawMessages);
  let failures = extractFailureCandidates(rawMessages);
  let toolLines = extractToolLines(rawMessages);
  let transcriptLines = extractTranscriptLines(rawMessages);
  const priorMemory = extractPriorMemory(messagesToCompress);
  const sourceMessageCount = priorSummaryMessageCount + rawMessages.length;

  const build = () =>
    [
      `Conversation memory summary. This compresses ${sourceMessageCount} earlier messages from the same chat.`,
      buildSection("Goal", [goal]),
      buildSection("Prior compacted memory", priorMemory),
      buildSection("Constraints and preferences", constraints),
      buildSection("Open threads", openThreads),
      buildSection("Decisions and completed work", decisions),
      buildSection("Failures and cautions", failures),
      buildSection("Tool and action memory", toolLines),
      buildSection("Compacted transcript", transcriptLines),
    ]
      .filter(Boolean)
      .join("\n\n");

  let content = build();
  let estimatedTokens = estimateTextTokens(content);

  while (estimatedTokens > summaryTokenBudget && transcriptLines.length > 2) {
    transcriptLines = transcriptLines.slice(1);
    content = build();
    estimatedTokens = estimateTextTokens(content);
  }

  while (estimatedTokens > summaryTokenBudget && toolLines.length > 2) {
    toolLines = toolLines.slice(0, toolLines.length - 1);
    content = build();
    estimatedTokens = estimateTextTokens(content);
  }

  while (estimatedTokens > summaryTokenBudget && decisions.length > 2) {
    decisions = decisions.slice(0, decisions.length - 1);
    content = build();
    estimatedTokens = estimateTextTokens(content);
  }

  while (estimatedTokens > summaryTokenBudget && openThreads.length > 2) {
    openThreads = openThreads.slice(0, openThreads.length - 1);
    content = build();
    estimatedTokens = estimateTextTokens(content);
  }

  while (estimatedTokens > summaryTokenBudget && failures.length > 1) {
    failures = failures.slice(0, failures.length - 1);
    content = build();
    estimatedTokens = estimateTextTokens(content);
  }

  if (estimatedTokens > summaryTokenBudget) {
    const roughCharBudget = Math.max(600, Math.floor(summaryTokenBudget * 3));
    content = summarizeText(content, roughCharBudget);
    estimatedTokens = estimateTextTokens(content);
  }

  return { content, toolCallCount, estimatedTokens };
}

export function isHistorySummaryMessage(message: ChatMessage): boolean {
  return message.historySummary?.kind === "history-summary";
}

export function getHistorySummaryMessage(conversation: ChatMessage[]): ChatMessage | null {
  return conversation.find(isHistorySummaryMessage) ?? null;
}

export function compactConversationHistory(
  conversation: ChatMessage[],
  options: ConversationCompactionOptions = {},
): ConversationCompactionResult {
  const promptStack = options.promptStack ?? { shared: "", role: "", tools: "" };
  const currentUserContent = options.currentUserContent ?? "";
  const enabled = options.enabled ?? DEFAULT_ENABLED;
  const extraPromptTokens = Math.max(
    0,
    Math.floor(options.extraPromptTokens ?? 0),
  );
  const maxPromptTokens = Math.max(
    1_000,
    Math.floor(options.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS),
  );
  const targetPromptTokens = Math.max(
    1_000,
    Math.min(
      maxPromptTokens,
      Math.floor(options.targetPromptTokens ?? DEFAULT_TARGET_PROMPT_TOKENS),
    ),
  );
  const preserveRecentMessages = Math.max(
    1,
    Math.floor(options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES),
  );
  const minimumRecentMessages = Math.max(
    1,
    Math.min(
      preserveRecentMessages,
      Math.floor(options.minimumRecentMessages ?? DEFAULT_MINIMUM_RECENT_MESSAGES),
    ),
  );
  const originalTokenCount =
    extraPromptTokens +
    estimatePromptInputTokens({
      promptStack,
      conversation,
      content: currentUserContent,
    });

  if (!enabled || conversation.length === 0) {
    return {
      messages: conversation,
      didCompact: false,
      originalMessageCount: conversation.length,
      compactedMessageCount: conversation.length,
      originalTokenCount,
      compactedTokenCount: originalTokenCount,
    };
  }

  if (originalTokenCount <= targetPromptTokens) {
    return {
      messages: conversation,
      didCompact: false,
      originalMessageCount: conversation.length,
      compactedMessageCount: conversation.length,
      originalTokenCount,
      compactedTokenCount: originalTokenCount,
    };
  }

  if (conversation.length <= minimumRecentMessages + 1) {
    return {
      messages: conversation,
      didCompact: false,
      originalMessageCount: conversation.length,
      compactedMessageCount: conversation.length,
      originalTokenCount,
      compactedTokenCount: originalTokenCount,
    };
  }

  const promptOverheadTokens =
    extraPromptTokens +
    estimatePromptInputTokens({
      promptStack,
      conversation: [],
      content: currentUserContent,
    });

  let bestResult: ConversationCompactionResult | null = null;

  for (
    let recentCount = Math.min(preserveRecentMessages, conversation.length - 1);
    recentCount >= minimumRecentMessages;
    recentCount -= 1
  ) {
    const splitIndex = Math.max(1, conversation.length - recentCount);
    const messagesToCompress = conversation.slice(0, splitIndex);
    const preservedMessages = conversation.slice(splitIndex);
    const preservedTokens = estimateConversationTokens(preservedMessages);
    const summaryTokenBudget = Math.max(
      MINIMUM_SUMMARY_TOKENS,
      targetPromptTokens - promptOverheadTokens - preservedTokens,
    );

    if (messagesToCompress.length === 0) {
      continue;
    }

    const { content, toolCallCount, estimatedTokens } = buildSummaryContent(
      messagesToCompress,
      summaryTokenBudget,
    );
    const sourceMessageCount = messagesToCompress.reduce((total, message) => {
      return total + (isHistorySummaryMessage(message) ? getSummarySourceMessageCount(message) : 1);
    }, 0);
    const generatedAt = new Date().toISOString();
    const summaryMessage: ChatMessage = {
      id: `msg_history_summary_${Date.now()}`,
      role: "assistant",
      authorRole: "coordinator",
      mode: preservedMessages.at(-1)?.mode ?? messagesToCompress.at(-1)?.mode ?? "auto",
      content,
      createdAt: generatedAt,
      historySummary: {
        kind: "history-summary",
        sourceMessageCount,
        sourceToolCallCount: toolCallCount,
        generatedAt,
      },
    };

    const messages = [summaryMessage, ...preservedMessages];
    const compactedTokenCount =
      extraPromptTokens +
      estimatePromptInputTokens({
        promptStack,
        conversation: messages,
        content: currentUserContent,
      });
    const result: ConversationCompactionResult = {
      messages,
      didCompact: true,
      originalMessageCount: conversation.length,
      compactedMessageCount: messages.length,
      originalTokenCount,
      compactedTokenCount,
    };

    if (compactedTokenCount <= targetPromptTokens) {
      return result;
    }

    if (
      compactedTokenCount < originalTokenCount &&
      (!bestResult || compactedTokenCount < bestResult.compactedTokenCount)
    ) {
      bestResult = result;
    }

    if (
      estimatedTokens <= summaryTokenBudget &&
      compactedTokenCount <= maxPromptTokens &&
      recentCount === minimumRecentMessages
    ) {
      return result;
    }
  }

  if (bestResult) {
    return bestResult;
  }

  return {
    messages: conversation,
    didCompact: false,
    originalMessageCount: conversation.length,
    compactedMessageCount: conversation.length,
    originalTokenCount,
    compactedTokenCount: originalTokenCount,
  };
}

// ─── Progressive Compaction ──────────────────────────────────────────────────
// Applied BEFORE full compaction. Gradually compresses conversation at lower
// fill ratios to delay catastrophic all-or-nothing compaction.

export interface ProgressiveCompactionOptions {
  /** Current estimated total prompt tokens (conversation + prompt stack + extras) */
  currentPromptTokens: number;
  /** The maxPromptTokens budget */
  maxPromptTokens: number;
  /** The targetPromptTokens budget */
  targetPromptTokens: number;
  /** Context window size — used to scale aging limits for small models */
  contextWindowTokens?: number;
}

export interface ProgressiveCompactionResult {
  messages: ChatMessage[];
  stage: number;
}

// Stage thresholds scale with context window size.
// Small models (< 50k) start compacting earlier because every token matters.
const LARGE_CONTEXT_THRESHOLD = 100_000;
const SMALL_CONTEXT_THRESHOLD = 50_000;

function resolveStageThresholds(contextWindowTokens: number) {
  if (contextWindowTokens >= LARGE_CONTEXT_THRESHOLD) {
    return { stage1: 0.40, stage2: 0.60, stage3: 0.75 };
  }
  if (contextWindowTokens >= SMALL_CONTEXT_THRESHOLD) {
    return { stage1: 0.30, stage2: 0.50, stage3: 0.65 };
  }
  // Small models: start compacting very early
  return { stage1: 0.20, stage2: 0.35, stage3: 0.50 };
}

const STAGE_3_MIN_MESSAGES_FOR_INTERMEDIATE_SUMMARY = 12;
const INTERMEDIATE_SUMMARY_FRACTION = 3; // summarize oldest 1/3

function stripThinkingFromMessages(
  messages: ChatMessage[],
  preserveRecentCount: number,
): ChatMessage[] {
  if (messages.length <= preserveRecentCount) {
    return messages;
  }

  const cutoff = messages.length - preserveRecentCount;
  return messages.map((message, index) => {
    if (index >= cutoff) return message;
    if (!message.thinking) return message;
    return { ...message, thinking: null };
  });
}

function stripOldTextAttachments(
  messages: ChatMessage[],
  preserveRecentCount: number,
): ChatMessage[] {
  if (messages.length <= preserveRecentCount) {
    return messages;
  }

  const cutoff = messages.length - preserveRecentCount;
  return messages.map((message, index) => {
    if (index >= cutoff) return message;
    if (!message.attachments?.length) return message;

    const stripped = message.attachments.map((att) => {
      if (att.kind === "text") {
        return { ...att, text: `[attachment: ${att.name} removed for context savings]` };
      }
      return att;
    });

    return { ...message, attachments: stripped };
  });
}

function buildIntermediateSummary(
  messagesToCompress: ChatMessage[],
  summaryTokenBudget: number,
): ChatMessage | null {
  if (messagesToCompress.length === 0) return null;

  const { content, toolCallCount } = buildSummaryContent(
    messagesToCompress,
    summaryTokenBudget,
  );

  const sourceMessageCount = messagesToCompress.reduce((total, message) => {
    return total + (isHistorySummaryMessage(message) ? getSummarySourceMessageCount(message) : 1);
  }, 0);

  const generatedAt = new Date().toISOString();
  return {
    id: `msg_history_summary_${Date.now()}`,
    role: "assistant",
    authorRole: "coordinator",
    mode: messagesToCompress.at(-1)?.mode ?? "auto",
    content,
    createdAt: generatedAt,
    historySummary: {
      kind: "history-summary",
      sourceMessageCount,
      sourceToolCallCount: toolCallCount,
      generatedAt,
    },
  };
}

/**
 * Progressive conversation compaction — applied before full compaction.
 *
 * Gradually compresses conversation history at fill ratios that scale with
 * context window size. Small models (< 50k) start compacting at 20% fill;
 * large models (100k+) wait until 40%.
 *
 * Aging limits also scale: a 35k model gets much tighter char limits than
 * a 200k model, ensuring tool results stay proportional to available space.
 *
 * Returns the processed messages and the stage that was applied.
 */
export function progressiveCompactConversation(
  conversation: ChatMessage[],
  options: ProgressiveCompactionOptions,
): ProgressiveCompactionResult {
  const { currentPromptTokens, maxPromptTokens } = options;
  const contextWindowTokens = options.contextWindowTokens ?? 100_000;

  if (maxPromptTokens <= 0 || conversation.length === 0) {
    return { messages: conversation, stage: 0 };
  }

  const fillRatio = currentPromptTokens / maxPromptTokens;
  const thresholds = resolveStageThresholds(contextWindowTokens);

  // Stage 0: No action needed
  if (fillRatio < thresholds.stage1) {
    return { messages: conversation, stage: 0 };
  }

  // Use context-scaled aging options instead of hardcoded values
  const agingOptions = deriveAgingOptionsForContext(contextWindowTokens, fillRatio);

  // Stage 1: Context-scaled tool result aging
  if (fillRatio < thresholds.stage2) {
    const aged = ageToolResults(conversation, agingOptions);
    return { messages: aged, stage: 1 };
  }

  // Stage 2: Tighter aging + strip thinking from old messages
  if (fillRatio < thresholds.stage3) {
    // Tighten the already-scaled options further
    const tighterOptions = {
      ...agingOptions,
      oldResultCharLimit: Math.max(80, Math.floor(agingOptions.oldResultCharLimit * 0.5)),
      ancientResultCharLimit: Math.max(50, Math.floor(agingOptions.ancientResultCharLimit * 0.4)),
    };
    let messages = ageToolResults(conversation, tighterOptions);
    // Small models: strip thinking immediately; large models: keep last 6
    const thinkingPreserve = contextWindowTokens < SMALL_CONTEXT_THRESHOLD ? 2 : 6;
    messages = stripThinkingFromMessages(messages, thinkingPreserve);
    return { messages, stage: 2 };
  }

  // Stage 3: Aggressive aging + strip attachments + intermediate summary
  const aggressiveOptions = {
    ...agingOptions,
    preserveRecentCount: Math.max(2, Math.floor(agingOptions.preserveRecentCount * 0.5)),
    oldResultCharLimit: Math.max(60, Math.floor(agingOptions.oldResultCharLimit * 0.25)),
    ancientResultCharLimit: Math.max(40, Math.floor(agingOptions.ancientResultCharLimit * 0.2)),
  };
  let messages = ageToolResults(conversation, aggressiveOptions);
  messages = stripThinkingFromMessages(messages, 0);
  const attachmentPreserve = contextWindowTokens < SMALL_CONTEXT_THRESHOLD ? 2 : 4;
  messages = stripOldTextAttachments(messages, attachmentPreserve);

  // Summarize oldest 1/3 into intermediate summary (lower threshold for small models)
  if (messages.length >= STAGE_3_MIN_MESSAGES_FOR_INTERMEDIATE_SUMMARY) {
    const splitIndex = Math.max(1, Math.floor(messages.length / INTERMEDIATE_SUMMARY_FRACTION));
    const oldMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);

    const tokenSavingsTarget = Math.max(300, Math.floor((currentPromptTokens - options.targetPromptTokens) / 4));
    const summary = buildIntermediateSummary(oldMessages, tokenSavingsTarget);

    if (summary) {
      messages = [summary, ...recentMessages];
    }
  }

  return { messages, stage: 3 };
}
