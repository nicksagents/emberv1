import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDataRoot } from "@ember/core";
import type { ChatMessage, Role } from "@ember/core";
import { CONFIG } from "./config.js";

export interface AttentionContext {
  primaryGoal: string;
  currentFocus: string;
  completedSteps: string[];
  blockers: string[];
  workingMemory: string[];
  lastUpdated: number;
}

const ATTENTION_CONTEXTS = new Map<string, AttentionContext>();
const MAX_CONTEXTS = CONFIG.attention.maxContexts;
const MAX_COMPLETED_STEPS = CONFIG.attention.maxCompletedSteps;
const MAX_BLOCKERS = 8;
const MAX_WORKING_MEMORY = CONFIG.attention.maxWorkingMemory;
const MAX_ITEM_LENGTH = CONFIG.attention.maxItemLength;

function normalizeSnippet(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, MAX_ITEM_LENGTH);
}

function pushBounded(list: string[], value: string | null, limit: number): string[] {
  if (!value) {
    return list.slice(0, limit);
  }
  if (list.includes(value)) {
    return list.slice(0, limit);
  }
  const next = [...list, value];
  return next.slice(Math.max(0, next.length - limit));
}

function extractWorkingMemoryCandidates(source: string): string[] {
  const normalized = source.replace(/\r/g, "\n");
  const bulletLines = normalized
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line.length >= 12 && line.length <= MAX_ITEM_LENGTH);
  const sentenceMatches = normalized.match(/[^.!?]+[.!?]/g) ?? [];
  const sentences = sentenceMatches
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 18 && sentence.length <= MAX_ITEM_LENGTH);

  const deduped: string[] = [];
  for (const candidate of [...bulletLines, ...sentences]) {
    if (!deduped.includes(candidate)) {
      deduped.push(candidate);
    }
    if (deduped.length >= MAX_WORKING_MEMORY) {
      break;
    }
  }
  return deduped;
}

function deriveSeedWorkingMemory(conversation: ChatMessage[]): string[] {
  const latestUser = conversation
    .slice()
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUser) {
    return [];
  }
  return extractWorkingMemoryCandidates(latestUser.content).slice(0, MAX_WORKING_MEMORY);
}

function pruneAttentionContexts(): void {
  if (ATTENTION_CONTEXTS.size <= MAX_CONTEXTS) {
    return;
  }

  const sorted = [...ATTENTION_CONTEXTS.entries()].sort(
    (left, right) => left[1].lastUpdated - right[1].lastUpdated,
  );
  const excess = ATTENTION_CONTEXTS.size - MAX_CONTEXTS;
  for (let index = 0; index < excess; index += 1) {
    const key = sorted[index]?.[0];
    if (key) {
      ATTENTION_CONTEXTS.delete(key);
    }
  }
}

export function deriveAttentionKey(
  conversationId: string | null,
  conversation: ChatMessage[],
  primaryGoal: string,
): string {
  const normalizedConversationId = normalizeSnippet(conversationId);
  if (normalizedConversationId) {
    return `conversation:${normalizedConversationId}`;
  }

  const firstUserMessageId = conversation.find((message) => message.role === "user")?.id ?? null;
  const normalizedFirstUserMessageId = normalizeSnippet(firstUserMessageId);
  if (normalizedFirstUserMessageId) {
    return `thread:${normalizedFirstUserMessageId}`;
  }

  const goalSeed = normalizeSnippet(primaryGoal)?.toLowerCase() ?? "default";
  return `ephemeral:${goalSeed.slice(0, 80)}`;
}

export function getOrCreateAttentionContext(options: {
  key: string;
  primaryGoal: string;
  currentFocus: string;
  conversation?: ChatMessage[];
  now?: number;
}): AttentionContext {
  const now = options.now ?? Date.now();
  const existing = ATTENTION_CONTEXTS.get(options.key);
  if (existing) {
    const refreshed: AttentionContext = {
      ...existing,
      primaryGoal: normalizeSnippet(existing.primaryGoal) ?? normalizeSnippet(options.primaryGoal) ?? "Complete the user request.",
      currentFocus: normalizeSnippet(existing.currentFocus) ?? normalizeSnippet(options.currentFocus) ?? normalizeSnippet(options.primaryGoal) ?? "Continue the task.",
      completedSteps: existing.completedSteps.slice(-MAX_COMPLETED_STEPS),
      blockers: existing.blockers.slice(-MAX_BLOCKERS),
      workingMemory: existing.workingMemory.slice(0, MAX_WORKING_MEMORY),
      lastUpdated: now,
    };
    ATTENTION_CONTEXTS.set(options.key, refreshed);
    return refreshed;
  }

  const seededWorkingMemory = options.conversation
    ? deriveSeedWorkingMemory(options.conversation)
    : [];
  const created: AttentionContext = {
    primaryGoal: normalizeSnippet(options.primaryGoal) ?? "Complete the user request.",
    currentFocus: normalizeSnippet(options.currentFocus) ?? normalizeSnippet(options.primaryGoal) ?? "Continue the task.",
    completedSteps: [],
    blockers: [],
    workingMemory: seededWorkingMemory.slice(0, MAX_WORKING_MEMORY),
    lastUpdated: now,
  };
  ATTENTION_CONTEXTS.set(options.key, created);
  pruneAttentionContexts();
  return created;
}

export function setAttentionFocus(options: {
  key: string;
  primaryGoal?: string | null;
  currentFocus: string;
  now?: number;
}): AttentionContext {
  const now = options.now ?? Date.now();
  const existing = getOrCreateAttentionContext({
    key: options.key,
    primaryGoal: normalizeSnippet(options.primaryGoal) ?? normalizeSnippet(options.currentFocus) ?? "Complete the user request.",
    currentFocus: options.currentFocus,
    now,
  });
  const next: AttentionContext = {
    ...existing,
    primaryGoal: normalizeSnippet(options.primaryGoal) ?? existing.primaryGoal,
    currentFocus: normalizeSnippet(options.currentFocus) ?? existing.currentFocus,
    lastUpdated: now,
  };
  ATTENTION_CONTEXTS.set(options.key, next);
  return next;
}

export function recordRoleAttentionUpdate(options: {
  key: string;
  role: Role;
  response: string;
  handoffMessage?: string | null;
  now?: number;
}): AttentionContext {
  const now = options.now ?? Date.now();
  const existing = getOrCreateAttentionContext({
    key: options.key,
    primaryGoal: "Complete the user request.",
    currentFocus: "Continue the task.",
    now,
  });
  const responseSummary = normalizeSnippet(options.response)?.split(/[.!?]/, 1)[0] ?? "Produced an update.";
  const completedEntry = normalizeSnippet(`${options.role}: ${responseSummary}`);
  const nextFocus =
    normalizeSnippet(options.handoffMessage) ??
    normalizeSnippet(options.response)?.split(/[.!?]/, 1)[0] ??
    existing.currentFocus;

  let workingMemory = [...existing.workingMemory];
  for (const candidate of extractWorkingMemoryCandidates(options.response)) {
    workingMemory = pushBounded(workingMemory, normalizeSnippet(candidate), MAX_WORKING_MEMORY);
  }
  for (const candidate of extractWorkingMemoryCandidates(options.handoffMessage ?? "")) {
    workingMemory = pushBounded(workingMemory, normalizeSnippet(candidate), MAX_WORKING_MEMORY);
  }

  const blockerPattern = /\b(blocked|cannot|can't|unable|error|failed|missing|denied|forbidden|timeout)\b/i;
  const blockerValue = blockerPattern.test(options.response)
    ? normalizeSnippet(`${options.role}: ${responseSummary}`)
    : null;

  const next: AttentionContext = {
    ...existing,
    currentFocus: nextFocus,
    completedSteps: pushBounded(existing.completedSteps, completedEntry, MAX_COMPLETED_STEPS),
    blockers: pushBounded(existing.blockers, blockerValue, MAX_BLOCKERS),
    workingMemory,
    lastUpdated: now,
  };
  ATTENTION_CONTEXTS.set(options.key, next);
  return next;
}

export function buildAttentionPromptSection(attention: AttentionContext): string {
  const completed = attention.completedSteps.length > 0
    ? attention.completedSteps.map((step, index) => `[${index + 1}] ${step}`).join("; ")
    : "none yet";
  const blockers = attention.blockers.length > 0
    ? attention.blockers.map((item, index) => `[${index + 1}] ${item}`).join("; ")
    : "none";
  const workingMemory = attention.workingMemory.length > 0
    ? attention.workingMemory.join("; ")
    : "none";

  return [
    "[ATTENTION CONTEXT]",
    `Primary Goal: ${attention.primaryGoal}`,
    `Current Focus: ${attention.currentFocus}`,
    `Completed: ${completed}`,
    `Blockers: ${blockers}`,
    `Working Memory: ${workingMemory}`,
  ].join("\n");
}

// ─── Persistence ────────────────────────────────────────────────────────────

const ATTENTION_PERSISTENCE_FILE = "attention-contexts.json";

function resolveAttentionPersistencePath(): string {
  return path.join(getDataRoot(), ATTENTION_PERSISTENCE_FILE);
}

export async function persistAttentionContexts(): Promise<void> {
  try {
    const entries: Record<string, AttentionContext> = {};
    for (const [key, value] of ATTENTION_CONTEXTS.entries()) {
      entries[key] = value;
    }
    const filePath = resolveAttentionPersistencePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(entries, null, 2), "utf8");
  } catch {
    // Best-effort persistence — do not crash on write failure.
  }
}

export async function restoreAttentionContexts(): Promise<number> {
  try {
    const raw = await readFile(resolveAttentionPersistencePath(), "utf8");
    const entries = JSON.parse(raw) as Record<string, AttentionContext>;
    let restored = 0;
    for (const [key, value] of Object.entries(entries)) {
      if (
        value &&
        typeof value === "object" &&
        typeof value.primaryGoal === "string" &&
        typeof value.lastUpdated === "number"
      ) {
        ATTENTION_CONTEXTS.set(key, value);
        restored++;
      }
    }
    pruneAttentionContexts();
    return restored;
  } catch {
    return 0;
  }
}

export function clearAllAttentionContexts(): void {
  ATTENTION_CONTEXTS.clear();
}

export function getAttentionContextCount(): number {
  return ATTENTION_CONTEXTS.size;
}

