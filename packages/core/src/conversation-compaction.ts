import type { ChatMessage, ToolCall } from "./types";

export interface ConversationCompactionOptions {
  preserveRecentMessages?: number;
  triggerMessageCount?: number;
  triggerCharBudget?: number;
  summaryCharBudget?: number;
}

export interface ConversationCompactionResult {
  messages: ChatMessage[];
  didCompact: boolean;
  originalMessageCount: number;
  compactedMessageCount: number;
}

const DEFAULT_PRESERVE_RECENT_MESSAGES = 8;
const DEFAULT_TRIGGER_MESSAGE_COUNT = 14;
const DEFAULT_TRIGGER_CHAR_BUDGET = 12_000;
const DEFAULT_SUMMARY_CHAR_BUDGET = 2_400;
const MAX_CONSTRAINTS = 3;
const MAX_REQUESTS = 3;
const MAX_TOOL_LINES = 6;
const MAX_TRANSCRIPT_LINES = 6;

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

function estimateConversationSize(conversation: ChatMessage[]): number {
  return conversation.reduce((total, message) => {
    const toolSize = (message.toolCalls ?? []).reduce((toolTotal, toolCall) => {
      const resultLength = toolCall.result?.length ?? 0;
      return toolTotal + toolCall.name.length + JSON.stringify(toolCall.arguments).length + resultLength;
    }, 0);
    const attachmentSize = (message.attachments ?? []).reduce(
      (attachmentTotal, attachment) => attachmentTotal + attachment.name.length + attachment.dataUrl.length,
      0,
    );
    return total + message.content.length + toolSize + attachmentSize;
  }, 0);
}

function extractGoal(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
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

function extractRequestCandidates(messages: ChatMessage[], goal: string): string[] {
  return uniqueLines(
    [...messages]
      .reverse()
      .filter((message) => message.role === "user")
      .map((message) => summarizeText(message.content, 150))
      .filter((content) => content && content !== goal),
    MAX_REQUESTS,
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
  summaryCharBudget: number,
): { content: string; toolCallCount: number } {
  const toolCallCount = messagesToCompress.reduce(
    (total, message) => total + (message.toolCalls?.length ?? 0),
    0,
  );
  const goal = extractGoal(messagesToCompress);
  const constraints = extractConstraintCandidates(messagesToCompress);
  const requests = extractRequestCandidates(messagesToCompress, goal);
  let toolLines = extractToolLines(messagesToCompress);
  let transcriptLines = extractTranscriptLines(messagesToCompress);

  const build = () =>
    [
      `Conversation memory summary. This compresses ${messagesToCompress.length} earlier messages from the same chat.`,
      buildSection("Goal", [goal]),
      buildSection("Constraints and preferences", constraints),
      buildSection("Important prior requests", requests),
      buildSection("Tool and action memory", toolLines),
      buildSection("Compacted transcript", transcriptLines),
    ]
      .filter(Boolean)
      .join("\n\n");

  let content = build();

  while (content.length > summaryCharBudget && transcriptLines.length > 3) {
    transcriptLines = transcriptLines.slice(1);
    content = build();
  }

  while (content.length > summaryCharBudget && toolLines.length > 3) {
    toolLines = toolLines.slice(0, toolLines.length - 1);
    content = build();
  }

  if (content.length > summaryCharBudget) {
    content = summarizeText(content, summaryCharBudget);
  }

  return { content, toolCallCount };
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
  if (conversation.length === 0 || getHistorySummaryMessage(conversation)) {
    return {
      messages: conversation,
      didCompact: false,
      originalMessageCount: conversation.length,
      compactedMessageCount: conversation.length,
    };
  }

  const preserveRecentMessages = Math.max(
    2,
    Math.floor(options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES),
  );
  const triggerMessageCount = Math.max(
    preserveRecentMessages + 2,
    Math.floor(options.triggerMessageCount ?? DEFAULT_TRIGGER_MESSAGE_COUNT),
  );
  const triggerCharBudget = Math.max(
    1_000,
    Math.floor(options.triggerCharBudget ?? DEFAULT_TRIGGER_CHAR_BUDGET),
  );
  const summaryCharBudget = Math.max(
    800,
    Math.floor(options.summaryCharBudget ?? DEFAULT_SUMMARY_CHAR_BUDGET),
  );
  const estimatedSize = estimateConversationSize(conversation);

  if (
    conversation.length <= triggerMessageCount &&
    estimatedSize <= triggerCharBudget
  ) {
    return {
      messages: conversation,
      didCompact: false,
      originalMessageCount: conversation.length,
      compactedMessageCount: conversation.length,
    };
  }

  if (conversation.length <= preserveRecentMessages + 1) {
    return {
      messages: conversation,
      didCompact: false,
      originalMessageCount: conversation.length,
      compactedMessageCount: conversation.length,
    };
  }

  const splitIndex = Math.max(1, conversation.length - preserveRecentMessages);
  const messagesToCompress = conversation.slice(0, splitIndex);
  const preservedMessages = conversation.slice(splitIndex);
  const { content, toolCallCount } = buildSummaryContent(messagesToCompress, summaryCharBudget);
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
      sourceMessageCount: messagesToCompress.length,
      sourceToolCallCount: toolCallCount,
      generatedAt,
    },
  };

  return {
    messages: [summaryMessage, ...preservedMessages],
    didCompact: true,
    originalMessageCount: conversation.length,
    compactedMessageCount: preservedMessages.length + 1,
  };
}
