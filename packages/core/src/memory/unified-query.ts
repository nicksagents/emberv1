import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Conversation } from "../types";
import type { MemoryRepository } from "./types";

export type UnifiedMemorySource = "flat" | "graph" | "app" | "session";

export interface UnifiedMemoryQuery {
  query: string;
  maxResults?: number;
  maxTokens?: number;
  sources?: UnifiedMemorySource[];
  dateRange?: { from?: string; to?: string };
  project?: string;
}

export interface UnifiedMemoryItem {
  content: string;
  source: UnifiedMemorySource;
  relevanceScore: number;
  timestamp?: string;
  key?: string;
  metadata?: Record<string, unknown>;
}

export interface UnifiedMemoryResult {
  items: UnifiedMemoryItem[];
  sources: { flat: number; graph: number; app: number; session: number };
  totalTokens: number;
}

interface AppMemoryEntry {
  id: string;
  appName: string;
  title: string;
  description: string;
  tags?: string[];
  updatedAt?: string;
}

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_TOKENS = 2_000;
const ALL_SOURCES: UnifiedMemorySource[] = ["flat", "graph", "app", "session"];

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreText(queryTokens: string[], haystack: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const normalized = haystack.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (normalized.includes(token)) {
      score += 1;
    }
  }
  return score / queryTokens.length;
}

function clipText(value: string, maxChars = 360): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function parseDate(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function inDateRange(timestamp: string | undefined, dateRange: UnifiedMemoryQuery["dateRange"]): boolean {
  if (!dateRange || (!dateRange.from && !dateRange.to)) {
    return true;
  }
  const at = parseDate(timestamp);
  if (at === null) {
    return false;
  }
  const from = parseDate(dateRange.from);
  const to = parseDate(dateRange.to);
  if (from !== null && at < from) {
    return false;
  }
  if (to !== null && at > to) {
    return false;
  }
  return true;
}

async function searchFlatMemory(
  query: UnifiedMemoryQuery,
  memoryRepo: MemoryRepository,
): Promise<UnifiedMemoryItem[]> {
  const maxResults = clampInt(query.maxResults, DEFAULT_MAX_RESULTS, 1, 50);
  const results = await memoryRepo.search({
    text: query.query,
    maxResults: Math.max(maxResults * 2, maxResults),
  });
  return results
    .filter((result) => inDateRange(result.item.updatedAt ?? result.item.createdAt, query.dateRange))
    .map((result) => ({
      content: clipText(result.item.content),
      source: "flat" as const,
      relevanceScore: result.score,
      timestamp: result.item.updatedAt ?? result.item.createdAt,
      key: result.item.id,
      metadata: {
        memoryType: result.item.memoryType,
        scope: result.item.scope,
        sourceRef: result.item.sourceRef,
      },
    }));
}

async function searchGraphMemory(
  query: UnifiedMemoryQuery,
  memoryRepo: MemoryRepository,
): Promise<UnifiedMemoryItem[]> {
  const [items, edges] = await Promise.all([
    memoryRepo.listItems({ includeSuperseded: false }),
    memoryRepo.listEdges(),
  ]);
  const queryTokens = tokenize(query.query);
  const itemById = new Map(items.map((item) => [item.id, item] as const));
  const graphItems: UnifiedMemoryItem[] = [];
  for (const edge of edges) {
    const from = itemById.get(edge.fromId);
    const to = itemById.get(edge.toId);
    if (!from || !to) {
      continue;
    }
    const timestamp = to.updatedAt ?? to.createdAt ?? from.updatedAt ?? from.createdAt;
    if (!inDateRange(timestamp, query.dateRange)) {
      continue;
    }
    const content = `${from.content} --${edge.relation}--> ${to.content}`;
    const relevanceScore = scoreText(queryTokens, `${content} ${from.tags.join(" ")} ${to.tags.join(" ")}`);
    if (relevanceScore <= 0) {
      continue;
    }
    graphItems.push({
      content: clipText(content),
      source: "graph",
      relevanceScore,
      timestamp,
      key: `${edge.fromId}:${edge.relation}:${edge.toId}`,
      metadata: {
        fromId: edge.fromId,
        toId: edge.toId,
        relation: edge.relation,
      },
    });
  }
  return graphItems.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function readAppMemoryEntries(): AppMemoryEntry[] {
  const path = join(homedir(), ".ember", "app-memory.json");
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: AppMemoryEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function searchAppMemory(query: UnifiedMemoryQuery): Promise<UnifiedMemoryItem[]> {
  const entries = readAppMemoryEntries();
  const queryTokens = tokenize(query.query);
  const projectTokens = tokenize(query.project ?? "");
  return entries
    .filter((entry) => inDateRange(entry.updatedAt, query.dateRange))
    .map((entry) => {
      const searchable = [
        entry.appName,
        entry.title,
        entry.description,
        ...(entry.tags ?? []),
      ]
        .filter(Boolean)
        .join(" ");
      const projectBoost =
        projectTokens.length > 0 && scoreText(projectTokens, searchable) > 0 ? 0.2 : 0;
      const relevanceScore = scoreText(queryTokens, searchable) + projectBoost;
      return {
        content: clipText(`${entry.appName}: ${entry.title} — ${entry.description}`),
        source: "app" as const,
        relevanceScore,
        timestamp: entry.updatedAt,
        key: entry.id,
        metadata: { appName: entry.appName, title: entry.title },
      };
    })
    .filter((entry) => entry.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

async function searchSessionMemory(
  query: UnifiedMemoryQuery,
  conversations: Conversation[],
): Promise<UnifiedMemoryItem[]> {
  const queryTokens = tokenize(query.query);
  const projectTokens = tokenize(query.project ?? "");
  const out: UnifiedMemoryItem[] = [];
  for (const conversation of conversations) {
    if (!inDateRange(conversation.updatedAt, query.dateRange)) {
      continue;
    }
    if (projectTokens.length > 0) {
      const projectText = `${conversation.title} ${conversation.preview}`;
      if (scoreText(projectTokens, projectText) <= 0) {
        continue;
      }
    }
    for (const message of conversation.messages) {
      const searchable = `${conversation.title} ${conversation.preview} ${message.content}`;
      const relevanceScore = scoreText(queryTokens, searchable);
      if (relevanceScore <= 0) {
        continue;
      }
      out.push({
        content: clipText(message.content),
        source: "session",
        relevanceScore,
        timestamp: message.createdAt,
        key: `${conversation.id}:${message.id}`,
        metadata: {
          conversationId: conversation.id,
          role: message.authorRole,
        },
      });
    }
  }
  return out.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function truncateToTokenBudget(items: UnifiedMemoryItem[], maxTokens: number, maxResults: number): UnifiedMemoryResult {
  const sources = { flat: 0, graph: 0, app: 0, session: 0 };
  for (const item of items) {
    sources[item.source] += 1;
  }

  const selected: UnifiedMemoryItem[] = [];
  let totalTokens = 0;
  for (const item of items) {
    if (selected.length >= maxResults) {
      break;
    }
    const itemTokens = estimateTokens(item.content);
    if (totalTokens + itemTokens > maxTokens) {
      break;
    }
    selected.push(item);
    totalTokens += itemTokens;
  }

  return {
    items: selected,
    sources,
    totalTokens,
  };
}

export async function queryUnifiedMemory(
  query: UnifiedMemoryQuery,
  memoryRepo: MemoryRepository,
  conversations: Conversation[],
): Promise<UnifiedMemoryResult> {
  const normalizedQuery = query.query.trim();
  if (!normalizedQuery) {
    return {
      items: [],
      sources: { flat: 0, graph: 0, app: 0, session: 0 },
      totalTokens: 0,
    };
  }
  const maxResults = clampInt(query.maxResults, DEFAULT_MAX_RESULTS, 1, 50);
  const maxTokens = clampInt(query.maxTokens, DEFAULT_MAX_TOKENS, 50, 20_000);
  const sources = query.sources && query.sources.length > 0 ? query.sources : ALL_SOURCES;

  const searches: Array<Promise<UnifiedMemoryItem[]>> = [];
  if (sources.includes("flat")) {
    searches.push(searchFlatMemory({ ...query, query: normalizedQuery }, memoryRepo));
  }
  if (sources.includes("graph")) {
    searches.push(searchGraphMemory({ ...query, query: normalizedQuery }, memoryRepo));
  }
  if (sources.includes("app")) {
    searches.push(searchAppMemory({ ...query, query: normalizedQuery }));
  }
  if (sources.includes("session")) {
    searches.push(searchSessionMemory({ ...query, query: normalizedQuery }, conversations));
  }

  const settled = await Promise.allSettled(searches);
  const merged: UnifiedMemoryItem[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      merged.push(...result.value);
    }
  }
  merged.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    const leftTs = parseDate(a.timestamp) ?? 0;
    const rightTs = parseDate(b.timestamp) ?? 0;
    return rightTs - leftTs;
  });

  return truncateToTokenBudget(merged, maxTokens, maxResults);
}
