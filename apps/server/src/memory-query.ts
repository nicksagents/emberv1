import {
  buildMemoryRetrievalQuery,
  isHistorySummaryMessage,
  type ChatMessage,
  type MemorySearchQuery,
  type MemorySourceType,
  type MemoryType,
  type Role,
} from "@ember/core";

const TOPIC_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "chat",
  "continue",
  "ember",
  "file",
  "from",
  "have",
  "into",
  "just",
  "need",
  "please",
  "project",
  "should",
  "that",
  "this",
  "tool",
  "when",
  "with",
  "work",
]);

const FACT_MEMORY_TYPES: MemoryType[] = [
  "user_profile",
  "user_preference",
  "project_fact",
  "environment_fact",
  "world_fact",
  "episode_summary",
  "task_outcome",
  "warning_or_constraint",
];

export interface StructuredMemoryQueryInput {
  content: string;
  conversation: ChatMessage[];
  activeRole: Role;
  activeSessionId?: string | null;
  handoffSourceRole?: Role | null;
}

export function buildStructuredMemorySearchQuery(
  input: StructuredMemoryQueryInput,
): MemorySearchQuery {
  const recentToolNames = extractRecentToolNames(input.conversation);
  return {
    text: buildMemoryRetrievalQuery(input.content, input.conversation),
    activeSessionId: input.activeSessionId ?? null,
    scopes: ["user", "workspace", "global"],
    memoryTypes: FACT_MEMORY_TYPES,
    activeRole: input.activeRole,
    handoffSourceRole: input.handoffSourceRole ?? null,
    activeSubgoal: summarizeText(input.content, 220),
    recentToolNames,
    workspaceTopics: extractWorkspaceTopics(input.content, input.conversation, recentToolNames),
    taskState: detectTaskState(input.content, input.conversation),
    preferredSourceTypes: derivePreferredSourceTypes(input.content, input.activeRole, recentToolNames),
  };
}

export function buildProcedureMemorySearchQuery(
  input: StructuredMemoryQueryInput,
): MemorySearchQuery {
  const recentToolNames = extractRecentToolNames(input.conversation);
  const workspaceTopics = extractWorkspaceTopics(input.content, input.conversation, recentToolNames);
  return {
    text: buildProcedureRetrievalQuery(input.content, input.conversation),
    activeSessionId: input.activeSessionId ?? null,
    scopes: ["workspace"],
    memoryTypes: ["procedure"],
    activeRole: input.activeRole,
    handoffSourceRole: input.handoffSourceRole ?? null,
    activeSubgoal: summarizeText(input.content, 160),
    recentToolNames,
    workspaceTopics,
    taskState: detectTaskState(input.content, input.conversation),
  };
}

export function hasStructuredMemorySearchCues(query: MemorySearchQuery): boolean {
  return Boolean(
    query.activeRole ||
      query.handoffSourceRole ||
      query.activeSubgoal?.trim() ||
      (query.recentToolNames ?? []).length > 0 ||
      (query.workspaceTopics ?? []).length > 0 ||
      query.taskState ||
      (query.preferredSourceTypes ?? []).length > 0,
  );
}

export function hasProcedureMemorySearchCues(query: MemorySearchQuery): boolean {
  return Boolean(
    (query.recentToolNames ?? []).length > 0 ||
      (query.workspaceTopics ?? []).length > 0 ||
      query.taskState ||
      /\b(build|test|fix|debug|repo|workspace|file|command|tool|code|memory|server|typescript)\b/i.test(query.text),
  );
}

function extractRecentToolNames(conversation: ChatMessage[]): string[] {
  const names = conversation
    .filter((message) => !isHistorySummaryMessage(message))
    .flatMap((message) => (message.toolCalls ?? []).map((toolCall) => toolCall.name.trim()))
    .filter(Boolean)
    .slice(-10)
    .reverse();

  return [...new Set(names)].slice(0, 6);
}

function extractWorkspaceTopics(
  content: string,
  conversation: ChatMessage[],
  recentToolNames: string[],
): string[] {
  const terms = [
    ...tokenizeTopics(content),
    ...conversation
      .filter((message) => !isHistorySummaryMessage(message))
      .slice(-6)
      .flatMap((message) => tokenizeTopics(message.content)),
    ...recentToolNames.flatMap((toolName) => tokenizeTopics(toolName)),
  ];
  const counts = new Map<string, number>();

  for (const term of terms) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([term]) => term);
}

function detectTaskState(
  content: string,
  conversation: ChatMessage[],
): MemorySearchQuery["taskState"] {
  const recentMessages = conversation.filter((message) => !isHistorySummaryMessage(message)).slice(-6);
  const hasToolFailure = recentMessages.some((message) =>
    (message.toolCalls ?? []).some((toolCall) => toolCall.status === "error"),
  );
  const contextText = [content, ...recentMessages.map((message) => message.content)].join(" ").toLowerCase();

  if (hasToolFailure || /\b(blocked|can't|cannot|cant|error|failed|failure|broken|regression)\b/.test(contextText)) {
    return "blocked";
  }

  if (/\b(debug|investigate|fix|repair|why did)\b/.test(contextText)) {
    return "failing";
  }

  return null;
}

function derivePreferredSourceTypes(
  content: string,
  activeRole: Role,
  recentToolNames: string[],
): MemorySourceType[] | undefined {
  const normalized = content.toLowerCase();

  if (/\b(latest|current|today|news|law|regulation|policy|source|cite|verify|website|web)\b/.test(normalized)) {
    return ["web_page", "system"];
  }

  if (/\b(birthday|born|name|preference|prefer|remember about me|my profile)\b/.test(normalized)) {
    return ["user_message", "assistant_message"];
  }

  if (/\b(repo|workspace|project|build|test|package|server|tool|code|sqlite|memory|prompt|tsconfig|file)\b/.test(normalized)) {
    return recentToolNames.length > 0
      ? ["tool_result", "assistant_message", "session_summary"]
      : ["assistant_message", "tool_result", "session_summary"];
  }

  if (activeRole === "director" || activeRole === "inspector") {
    return ["tool_result", "assistant_message", "session_summary"];
  }

  return undefined;
}

function buildProcedureRetrievalQuery(content: string, conversation: ChatMessage[]): string {
  const recentMessages = conversation.filter((message) => !isHistorySummaryMessage(message)).slice(-4);
  const candidateTexts = [
    content,
    ...recentMessages
      .filter((message) => message.role === "user" || message.authorRole === "director" || message.authorRole === "advisor")
      .map((message) => summarizeText(message.content, 180)),
  ];
  return [...new Set(candidateTexts.map((value) => summarizeText(value, 180)).filter(Boolean))].join("\n");
}

function tokenizeTopics(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !TOPIC_STOP_WORDS.has(term));
}

function summarizeText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
