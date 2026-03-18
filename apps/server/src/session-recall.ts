import type { Conversation, Role } from "@ember/core";
import { CONFIG } from "./config.js";

const SESSION_RECALL_SOURCES = ["user", "assistant", "system", "tool"] as const;
const SESSION_RECALL_ROLES = [
  "user",
  "dispatch",
  "coordinator",
  "advisor",
  "director",
  "inspector",
  "ops",
] as const;
const TOKEN_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "been",
  "chat",
  "code",
  "could",
  "from",
  "have",
  "into",
  "just",
  "know",
  "last",
  "more",
  "need",
  "please",
  "project",
  "session",
  "that",
  "this",
  "what",
  "when",
  "with",
  "work",
  "would",
]);
const DEFAULT_MAX_RESULTS = CONFIG.sessionRecall.defaultMaxResults;
const DEFAULT_MAX_CHARS = CONFIG.sessionRecall.defaultMaxChars;

export type SessionRecallSource = (typeof SESSION_RECALL_SOURCES)[number];
export type SessionRecallRole = (typeof SESSION_RECALL_ROLES)[number];

export interface SessionRecallQuery {
  query: string;
  project: string | null;
  role: SessionRecallRole | null;
  source: SessionRecallSource | null;
  dateFrom: string | null;
  dateTo: string | null;
  maxResults: number;
  maxChars: number;
}

export interface SessionRecallSnippet {
  source: SessionRecallSource;
  authorRole: SessionRecallRole;
  createdAt: string;
  messageId: string;
  score: number;
  text: string;
}

export interface SessionRecallItem {
  conversationId: string;
  title: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  preview: string;
  score: number;
  matchedRoles: SessionRecallRole[];
  matchedSources: SessionRecallSource[];
  snippets: SessionRecallSnippet[];
  summary: string;
}

export interface SessionRecallResult {
  query: SessionRecallQuery;
  items: SessionRecallItem[];
  generatedAt: string;
  truncated: boolean;
  recallBlock: string;
}

type IndexedSnippet = {
  id: string;
  conversationId: string;
  messageId: string;
  source: SessionRecallSource;
  authorRole: SessionRecallRole;
  createdAt: string;
  text: string;
  normalizedText: string;
  tokenCounts: Map<string, number>;
};

type IndexedConversation = {
  item: Conversation;
  searchableText: string;
  tokens: Set<string>;
  roles: Set<SessionRecallRole>;
};

type SessionRecallIndex = {
  conversations: Map<string, IndexedConversation>;
  snippets: IndexedSnippet[];
  postings: Map<string, Array<{ snippetIndex: number; tf: number }>>;
};

type SessionRecallAggregate = {
  item: SessionRecallItem;
  snippetById: Map<string, SessionRecallSnippet>;
};

export function normalizeSessionRecallQuery(input: Record<string, unknown>): SessionRecallQuery | null {
  const rawQuery = normalizeString(input.query);
  const project = normalizeString(input.project);
  const role = normalizeSessionRecallRole(input.role);
  const source = normalizeSessionRecallSource(input.source);
  const dateFrom = normalizeDateFilter(input.date_from);
  const dateTo = normalizeDateFilter(input.date_to);
  const maxResults = clampInteger(input.max_results, DEFAULT_MAX_RESULTS, 1, 10);
  const maxChars = clampInteger(input.max_chars, DEFAULT_MAX_CHARS, 400, 6_000);

  if (!rawQuery && !project && !role && !source && !dateFrom && !dateTo) {
    return null;
  }

  return {
    query: rawQuery,
    project,
    role,
    source,
    dateFrom,
    dateTo,
    maxResults,
    maxChars,
  };
}

export function searchSessionRecall(
  conversations: Conversation[],
  query: SessionRecallQuery,
  nowIso = new Date().toISOString(),
): SessionRecallResult {
  const index = buildSessionRecallIndex(conversations);
  const queryTokens = tokenizeSearchTerms(query.query);
  const filteredCandidates = searchIndexedConversations(index, query, queryTokens, nowIso);
  const sorted = filteredCandidates
    .map((aggregate) => finalizeAggregate(aggregate))
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, query.maxResults);
  const formatted = formatSessionRecallBlock(sorted, {
    query,
    maxChars: query.maxChars,
  });

  return {
    query,
    items: sorted,
    generatedAt: nowIso,
    truncated: formatted.truncated,
    recallBlock: formatted.text,
  };
}

function buildSessionRecallIndex(conversations: Conversation[]): SessionRecallIndex {
  const indexedConversations = new Map<string, IndexedConversation>();
  const snippets: IndexedSnippet[] = [];
  const postings = new Map<string, Array<{ snippetIndex: number; tf: number }>>();

  for (const conversation of conversations) {
    const roles = new Set<SessionRecallRole>();
    const conversationTokens = new Set<string>();
    const searchableFragments = [conversation.title, conversation.preview];
    for (const token of tokenizeSearchTerms(`${conversation.title} ${conversation.preview}`)) {
      conversationTokens.add(token);
    }

    for (let index = 0; index < conversation.messages.length; index += 1) {
      const message = conversation.messages[index];
      const authorRole = normalizeSessionRecallRole(message.authorRole) ?? "user";
      roles.add(authorRole);

      const content = normalizeSnippetText(message.content);
      if (content) {
        const snippetTokens = buildTokenCountMap(tokenizeSearchTerms(content));
        const snippetIndex = snippets.length;
        snippets.push({
          id: `${conversation.id}:${message.id}:content`,
          conversationId: conversation.id,
          messageId: message.id,
          source: normalizeSessionRecallSource(message.role) ?? "assistant",
          authorRole,
          createdAt: message.createdAt,
          text: content,
          normalizedText: content.toLowerCase(),
          tokenCounts: snippetTokens,
        });
        ingestPosting(postings, snippetTokens, snippetIndex);
        for (const token of snippetTokens.keys()) {
          conversationTokens.add(token);
        }
        searchableFragments.push(content);
      }

      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      for (const call of toolCalls) {
        const toolTextParts = [
          call.name,
          JSON.stringify(call.arguments ?? {}),
          call.result ?? "",
        ].filter(Boolean);
        const toolText = normalizeSnippetText(toolTextParts.join(" "));
        if (!toolText) {
          continue;
        }
        const snippetTokens = buildTokenCountMap(tokenizeSearchTerms(toolText));
        const snippetIndex = snippets.length;
        snippets.push({
          id: `${conversation.id}:${message.id}:tool:${call.id}`,
          conversationId: conversation.id,
          messageId: message.id,
          source: "tool",
          authorRole,
          createdAt: call.endedAt ?? call.startedAt ?? message.createdAt,
          text: toolText,
          normalizedText: toolText.toLowerCase(),
          tokenCounts: snippetTokens,
        });
        ingestPosting(postings, snippetTokens, snippetIndex);
        for (const token of snippetTokens.keys()) {
          conversationTokens.add(token);
        }
        searchableFragments.push(toolText);
      }
    }

    indexedConversations.set(conversation.id, {
      item: conversation,
      searchableText: searchableFragments.join("\n").toLowerCase(),
      tokens: conversationTokens,
      roles,
    });
  }

  return {
    conversations: indexedConversations,
    snippets,
    postings,
  };
}

function searchIndexedConversations(
  index: SessionRecallIndex,
  query: SessionRecallQuery,
  queryTokens: string[],
  nowIso: string,
): SessionRecallAggregate[] {
  const aggregates = new Map<string, SessionRecallAggregate>();
  const nowMs = new Date(nowIso).getTime();
  const queryTextLower = query.query.toLowerCase();
  const projectTokens = tokenizeSearchTerms(query.project ?? "");
  const lowerProject = (query.project ?? "").toLowerCase();
  const dateFromMs = parseDateFilterMs(query.dateFrom, "start");
  const dateToMs = parseDateFilterMs(query.dateTo, "end");

  const candidateSnippetIndexes = new Set<number>();
  if (queryTokens.length === 0) {
    for (let indexAt = 0; indexAt < index.snippets.length; indexAt += 1) {
      candidateSnippetIndexes.add(indexAt);
    }
  } else {
    for (const token of queryTokens) {
      const entries = index.postings.get(token) ?? [];
      for (const entry of entries) {
        candidateSnippetIndexes.add(entry.snippetIndex);
      }
    }
  }

  for (const snippetIndex of candidateSnippetIndexes) {
    const snippet = index.snippets[snippetIndex];
    if (!snippet) {
      continue;
    }

    const conversationMeta = index.conversations.get(snippet.conversationId);
    if (!conversationMeta) {
      continue;
    }

    if (!passesConversationFilters(conversationMeta, {
      role: query.role,
      projectTokens,
      projectText: lowerProject,
      dateFromMs,
      dateToMs,
    })) {
      continue;
    }
    if (query.source && snippet.source !== query.source) {
      continue;
    }

    const lexicalScore = scoreSnippetLexical(snippet, queryTokens, index.snippets.length, index.postings);
    const hasPhraseMatch = queryTextLower.length > 0 && snippet.normalizedText.includes(queryTextLower);
    if (queryTokens.length > 0 && lexicalScore <= 0 && !hasPhraseMatch) {
      continue;
    }

    const recencyBoost = calculateRecencyBoost(conversationMeta.item.updatedAt, nowMs);
    const score = lexicalScore + (hasPhraseMatch ? 1.2 : 0) + recencyBoost;
    const aggregate = getOrCreateAggregate(aggregates, conversationMeta.item);
    aggregate.item.score += score;
    aggregate.item.matchedRoles = dedupeValues([...aggregate.item.matchedRoles, snippet.authorRole]);
    aggregate.item.matchedSources = dedupeValues([...aggregate.item.matchedSources, snippet.source]);
    const existingSnippet = aggregate.snippetById.get(snippet.id);
    const displaySnippet: SessionRecallSnippet = {
      source: snippet.source,
      authorRole: snippet.authorRole,
      createdAt: snippet.createdAt,
      messageId: snippet.messageId,
      score,
      text: clipText(snippet.text, 220),
    };
    if (!existingSnippet || displaySnippet.score > existingSnippet.score) {
      aggregate.snippetById.set(snippet.id, displaySnippet);
    }
  }

  if (aggregates.size === 0 && queryTokens.length === 0) {
    for (const conversationMeta of index.conversations.values()) {
      const item = conversationMeta.item;
      if (!passesConversationFilters(conversationMeta, {
        role: query.role,
        projectTokens,
        projectText: lowerProject,
        dateFromMs,
        dateToMs,
      })) {
        continue;
      }
      const aggregate = getOrCreateAggregate(aggregates, item);
      aggregate.item.score = calculateRecencyBoost(item.updatedAt, nowMs);
    }
  }

  return [...aggregates.values()];
}

function finalizeAggregate(aggregate: SessionRecallAggregate): SessionRecallItem {
  const snippets = [...aggregate.snippetById.values()]
    .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt))
    .slice(0, 3);
  const summarySource = snippets.map((snippet) => snippet.text).join(" ");
  const summary = clipText(summarySource || aggregate.item.preview || aggregate.item.title, 240);
  return {
    ...aggregate.item,
    snippets,
    summary,
    score: Number(aggregate.item.score.toFixed(3)),
  };
}

export function formatSessionRecallBlock(
  items: SessionRecallItem[],
  options: {
    query: SessionRecallQuery;
    maxChars: number;
  },
): { text: string; truncated: boolean } {
  if (items.length === 0) {
    const reason = options.query.query
      ? `No matching sessions found for "${options.query.query}".`
      : "No matching sessions found for the supplied filters.";
    return { text: reason, truncated: false };
  }

  const lines = ["Session recall results:"];
  let totalChars = lines.join("\n").length;
  let truncated = false;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const snippetLines = item.snippets
      .slice(0, 2)
      .map((snippet) => `   - [${snippet.source}/${snippet.authorRole}] ${snippet.text}`);
    const blockLines = [
      `${index + 1}. ${item.title} (${item.conversationId})`,
      `   updated=${item.updatedAt} score=${item.score.toFixed(2)} roles=${item.matchedRoles.join(",") || "none"} sources=${item.matchedSources.join(",") || "none"}`,
      `   summary: ${item.summary}`,
      ...snippetLines,
    ];
    const block = blockLines.join("\n");
    const projectedLength = totalChars + 1 + block.length;
    if (projectedLength > options.maxChars) {
      truncated = true;
      break;
    }
    lines.push(block);
    totalChars = projectedLength;
  }

  if (truncated) {
    lines.push("…truncated to fit recall budget.");
  }

  return {
    text: lines.join("\n"),
    truncated,
  };
}

function getOrCreateAggregate(
  aggregates: Map<string, SessionRecallAggregate>,
  conversation: Conversation,
): SessionRecallAggregate {
  const existing = aggregates.get(conversation.id);
  if (existing) {
    return existing;
  }
  const created: SessionRecallAggregate = {
    item: {
      conversationId: conversation.id,
      title: conversation.title,
      mode: conversation.mode,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      archivedAt: conversation.archivedAt,
      preview: conversation.preview,
      score: 0,
      matchedRoles: [],
      matchedSources: [],
      snippets: [],
      summary: "",
    },
    snippetById: new Map(),
  };
  aggregates.set(conversation.id, created);
  return created;
}

function scoreSnippetLexical(
  snippet: IndexedSnippet,
  queryTokens: string[],
  totalSnippetCount: number,
  postings: Map<string, Array<{ snippetIndex: number; tf: number }>>,
): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  let score = 0;
  for (const token of queryTokens) {
    const tf = snippet.tokenCounts.get(token) ?? 0;
    if (tf <= 0) {
      continue;
    }
    const df = postings.get(token)?.length ?? 0;
    const idf = Math.log((totalSnippetCount + 1) / (df + 1)) + 1;
    score += (1 + Math.log(tf)) * idf;
  }
  return score;
}

function passesConversationFilters(
  conversation: IndexedConversation,
  filters: {
    role: SessionRecallRole | null;
    projectTokens: string[];
    projectText: string;
    dateFromMs: number | null;
    dateToMs: number | null;
  },
): boolean {
  if (filters.role && !conversation.roles.has(filters.role)) {
    return false;
  }
  if (filters.projectText) {
    const hasExact = conversation.searchableText.includes(filters.projectText);
    const hasTokens =
      filters.projectTokens.length > 0 &&
      filters.projectTokens.every((token) => conversation.tokens.has(token));
    if (!hasExact && !hasTokens) {
      return false;
    }
  }
  const updatedMs = new Date(conversation.item.updatedAt).getTime();
  if (filters.dateFromMs !== null && Number.isFinite(updatedMs) && updatedMs < filters.dateFromMs) {
    return false;
  }
  if (filters.dateToMs !== null && Number.isFinite(updatedMs) && updatedMs > filters.dateToMs) {
    return false;
  }
  return true;
}

function parseDateFilterMs(value: string | null, mode: "start" | "end"): number | null {
  if (!value) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const base = new Date(`${value.trim()}T00:00:00.000Z`).getTime();
    if (!Number.isFinite(base)) {
      return null;
    }
    if (mode === "end") {
      return base + (24 * 60 * 60 * 1_000) - 1;
    }
    return base;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function calculateRecencyBoost(updatedAt: string, nowMs: number): number {
  const updatedMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  const ageDays = Math.max(0, (nowMs - updatedMs) / (24 * 60 * 60 * 1_000));
  return Math.max(0, 1 - ageDays / 120) * 0.35;
}

function ingestPosting(
  postings: Map<string, Array<{ snippetIndex: number; tf: number }>>,
  tokenCounts: Map<string, number>,
  snippetIndex: number,
): void {
  for (const [token, tf] of tokenCounts.entries()) {
    const existing = postings.get(token) ?? [];
    existing.push({ snippetIndex, tf });
    postings.set(token, existing);
  }
}

function tokenizeSearchTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !TOKEN_STOP_WORDS.has(token));
}

function buildTokenCountMap(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function normalizeSnippetText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDateFilter(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value.trim());
  return Number.isFinite(parsed.getTime()) ? value.trim() : null;
}

function normalizeSessionRecallSource(value: unknown): SessionRecallSource | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return SESSION_RECALL_SOURCES.includes(normalized as SessionRecallSource)
    ? (normalized as SessionRecallSource)
    : null;
}

function normalizeSessionRecallRole(value: unknown): SessionRecallRole | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return SESSION_RECALL_ROLES.includes(normalized as SessionRecallRole)
    ? (normalized as SessionRecallRole)
    : null;
}

function dedupeValues<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function clipText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(numericValue)));
}

export function isSessionRecallRole(value: string): value is SessionRecallRole {
  return SESSION_RECALL_ROLES.includes(value as SessionRecallRole);
}

export function isSessionRecallSource(value: string): value is SessionRecallSource {
  return SESSION_RECALL_SOURCES.includes(value as SessionRecallSource);
}

export function toSessionRecallRole(value: Role | "user"): SessionRecallRole {
  const normalized = value.toLowerCase();
  if (isSessionRecallRole(normalized)) {
    return normalized;
  }
  return "user";
}
