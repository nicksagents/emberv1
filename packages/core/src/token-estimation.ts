import type { ChatMessage, PromptStack, ToolDefinition } from "./types";

const MESSAGE_OVERHEAD_TOKENS = 12;
const TOOL_CALL_OVERHEAD_TOKENS = 24;
const IMAGE_ATTACHMENT_TOKENS = 1_200;
const TEXT_ATTACHMENT_OVERHEAD_TOKENS = 36;
const PROMPT_STACK_OVERHEAD_TOKENS = 24;
const REQUEST_OVERHEAD_TOKENS = 16;
const TOOL_DEFINITION_OVERHEAD_TOKENS = 28;
const TOOLS_ENVELOPE_OVERHEAD_TOKENS = 12;
const OPTIONAL_TEXT_SECTION_OVERHEAD_TOKENS = 6;

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
  const attachmentTokens = (message.attachments ?? []).reduce((total, attachment) => {
    if (attachment.kind === "image") {
      return total + IMAGE_ATTACHMENT_TOKENS;
    }

    return (
      total +
      TEXT_ATTACHMENT_OVERHEAD_TOKENS +
      estimateTextTokens(attachment.name) +
      estimateTextTokens(attachment.text)
    );
  }, 0);

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

export function estimateToolDefinitionTokens(tool: ToolDefinition): number {
  return (
    TOOL_DEFINITION_OVERHEAD_TOKENS +
    estimateTextTokens(tool.name) +
    estimateTextTokens(tool.description) +
    estimateTextTokens(JSON.stringify(tool.inputSchema))
  );
}

export function estimateToolDefinitionsTokens(tools: ToolDefinition[]): number {
  if (tools.length === 0) {
    return 0;
  }

  return (
    TOOLS_ENVELOPE_OVERHEAD_TOKENS +
    tools.reduce((total, tool) => total + estimateToolDefinitionTokens(tool), 0)
  );
}

export function estimatePromptExtraTokens(params: {
  tools?: ToolDefinition[];
  memoryContextText?: string | null;
  procedureContextText?: string | null;
}): number {
  let total = estimateToolDefinitionsTokens(params.tools ?? []);

  if (params.memoryContextText?.trim()) {
    total +=
      OPTIONAL_TEXT_SECTION_OVERHEAD_TOKENS +
      estimateTextTokens(params.memoryContextText);
  }

  if (params.procedureContextText?.trim()) {
    total +=
      OPTIONAL_TEXT_SECTION_OVERHEAD_TOKENS +
      estimateTextTokens(params.procedureContextText);
  }

  return total;
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
