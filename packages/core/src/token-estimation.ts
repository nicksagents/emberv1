import type { ChatMessage, PromptStack } from "./types";

const MESSAGE_OVERHEAD_TOKENS = 12;
const TOOL_CALL_OVERHEAD_TOKENS = 24;
const IMAGE_ATTACHMENT_TOKENS = 1_200;
const PROMPT_STACK_OVERHEAD_TOKENS = 24;
const REQUEST_OVERHEAD_TOKENS = 16;

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function estimateTextTokens(value: string): number {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }

  const bytes = Buffer.byteLength(normalized, "utf8");
  const segments =
    normalized.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g)?.length ?? 0;

  return Math.max(1, Math.ceil(Math.max(bytes / 3.6, segments * 0.85)));
}

export function estimateChatMessageTokens(message: ChatMessage): number {
  const contentTokens = estimateTextTokens(message.content);
  const thinkingTokens = estimateTextTokens(message.thinking ?? "");
  const toolTokens = (message.toolCalls ?? []).reduce((total, toolCall) => {
    return (
      total +
      TOOL_CALL_OVERHEAD_TOKENS +
      estimateTextTokens(toolCall.name) +
      estimateTextTokens(JSON.stringify(toolCall.arguments)) +
      estimateTextTokens(toolCall.result ?? "") +
      estimateTextTokens(toolCall.status)
    );
  }, 0);
  const attachmentTokens =
    ((message.attachments ?? []).length ?? 0) * IMAGE_ATTACHMENT_TOKENS;

  return (
    MESSAGE_OVERHEAD_TOKENS +
    contentTokens +
    thinkingTokens +
    toolTokens +
    attachmentTokens
  );
}

export function estimateConversationTokens(conversation: ChatMessage[]): number {
  return conversation.reduce(
    (total, message) => total + estimateChatMessageTokens(message),
    0,
  );
}

export function estimatePromptStackTokens(promptStack: PromptStack): number {
  return (
    PROMPT_STACK_OVERHEAD_TOKENS +
    estimateTextTokens(promptStack.shared) +
    estimateTextTokens(promptStack.role) +
    estimateTextTokens(promptStack.tools)
  );
}

export function estimatePromptInputTokens(params: {
  promptStack: PromptStack;
  conversation: ChatMessage[];
  content: string;
}): number {
  return (
    estimatePromptStackTokens(params.promptStack) +
    estimateConversationTokens(params.conversation) +
    REQUEST_OVERHEAD_TOKENS +
    estimateTextTokens(params.content)
  );
}
