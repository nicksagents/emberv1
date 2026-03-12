import {
  estimateConversationTokens,
  estimatePromptInputTokens,
  estimateTextTokens,
} from "./token-estimation";
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

function buildSummaryContent(
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
