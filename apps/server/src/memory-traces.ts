import type { MemoryPromptContext, MemorySearchQuery } from "@ember/core";

type MemoryTraceResult = {
  memoryId: string;
  memoryType: string;
  scope: string;
  content: string;
  sourceRef: string | null;
  score: number;
  reason: string;
  tags: string[];
  cueMatches: string[];
};

type MemoryTraceQueryCues = {
  activeRole: string | null;
  handoffSourceRole: string | null;
  activeSubgoal: string | null;
  recentToolNames: string[];
  workspaceTopics: string[];
  taskState: string | null;
  preferredSourceTypes: string[];
};

export interface MemoryRetrievalTrace {
  id: string;
  kind: "persistent" | "procedure";
  conversationId: string | null;
  queryText: string;
  queryCues: MemoryTraceQueryCues;
  promptText: string;
  createdAt: string;
  resultCount: number;
  totalChars: number;
  results: MemoryTraceResult[];
}

const MAX_TRACE_COUNT = 72;
const traces: MemoryRetrievalTrace[] = [];

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function recordMemoryRetrievalTrace(input: {
  conversationId?: string | null;
  kind?: "persistent" | "procedure";
  query: MemorySearchQuery;
  memoryContext: MemoryPromptContext;
  now?: string;
}): MemoryRetrievalTrace | null {
  const promptText = input.memoryContext.text.trim();
  if (!promptText || input.memoryContext.results.length === 0) {
    return null;
  }

  const trace: MemoryRetrievalTrace = {
    id: createId("memtrace"),
    kind: input.kind ?? "persistent",
    conversationId: input.conversationId ?? null,
    queryText: input.query.text.trim(),
    queryCues: {
      activeRole: input.query.activeRole ?? null,
      handoffSourceRole: input.query.handoffSourceRole ?? null,
      activeSubgoal: input.query.activeSubgoal?.trim() ?? null,
      recentToolNames: [...new Set((input.query.recentToolNames ?? []).map((toolName) => toolName.trim()).filter(Boolean))],
      workspaceTopics: [...new Set((input.query.workspaceTopics ?? []).map((topic) => topic.trim()).filter(Boolean))],
      taskState: input.query.taskState ?? null,
      preferredSourceTypes: [...new Set(input.query.preferredSourceTypes ?? [])],
    },
    promptText,
    createdAt: input.now ?? new Date().toISOString(),
    resultCount: input.memoryContext.results.length,
    totalChars: input.memoryContext.totalChars,
    results: input.memoryContext.results.map((result) => ({
      memoryId: result.item.id,
      memoryType: result.item.memoryType,
      scope: result.item.scope,
      content: result.item.content,
      sourceRef: result.item.sourceRef,
      score: result.score,
      reason: result.reason,
      tags: [...result.item.tags],
      cueMatches: [...result.cueMatches],
    })),
  };

  traces.unshift(trace);
  if (traces.length > MAX_TRACE_COUNT) {
    traces.length = MAX_TRACE_COUNT;
  }
  return trace;
}

export function listMemoryRetrievalTraces(limit = 16): MemoryRetrievalTrace[] {
  return traces.slice(0, Math.max(1, limit));
}

export function clearMemoryRetrievalTraces(): void {
  traces.length = 0;
}
