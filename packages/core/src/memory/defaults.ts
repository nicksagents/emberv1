import type {
  MemoryConfig,
  MemoryItem,
  MemorySession,
  MemoryStoreData,
  MemoryWriteCandidate,
} from "./types";
import { mergeMemoryInternalMetadata } from "./metadata";

export const defaultMemoryConfig = (): MemoryConfig => ({
  enabled: true,
  backend: "sqlite",
  storage: {
    fileName: "memory.json",
    sqliteFileName: "memory.sqlite",
  },
  embeddings: {
    enabled: true,
    model: "token-hash",
    dimensions: 192,
    maxCandidates: 48,
  },
  retrieval: {
    maxResults: 8,
    minScore: 0.18,
    maxInjectedItems: 5,
    maxInjectedChars: 1_800,
    lexicalWeight: 0.45,
    semanticWeight: 0.2,
    salienceWeight: 0.2,
    confidenceWeight: 0.15,
  },
  consolidation: {
    enabled: true,
    autoExtractUserFacts: true,
    autoExtractWorldFacts: true,
    autoSummarizeSessions: true,
    maxWriteCandidatesPerTurn: 6,
  },
  rollout: {
    traceCaptureEnabled: true,
    inspectionApiEnabled: true,
    cortexUiEnabled: true,
    replaySchedulerEnabled: true,
  },
});

export function normalizeMemoryConfig(value: Partial<MemoryConfig> | undefined): MemoryConfig {
  const defaults = defaultMemoryConfig();
  return {
    ...defaults,
    ...value,
    storage: {
      ...defaults.storage,
      ...value?.storage,
    },
    embeddings: {
      ...defaults.embeddings,
      ...value?.embeddings,
      dimensions: Math.max(32, Math.floor(value?.embeddings?.dimensions ?? defaults.embeddings.dimensions)),
      maxCandidates: Math.max(
        1,
        Math.floor(value?.embeddings?.maxCandidates ?? defaults.embeddings.maxCandidates),
      ),
    },
    retrieval: {
      ...defaults.retrieval,
      ...value?.retrieval,
      maxResults: Math.max(1, Math.floor(value?.retrieval?.maxResults ?? defaults.retrieval.maxResults)),
      minScore: Math.max(0, Math.min(1, value?.retrieval?.minScore ?? defaults.retrieval.minScore)),
      maxInjectedItems: Math.max(
        1,
        Math.floor(value?.retrieval?.maxInjectedItems ?? defaults.retrieval.maxInjectedItems),
      ),
      maxInjectedChars: Math.max(
        200,
        Math.floor(value?.retrieval?.maxInjectedChars ?? defaults.retrieval.maxInjectedChars),
      ),
      lexicalWeight: Math.max(
        0,
        Math.min(1, value?.retrieval?.lexicalWeight ?? defaults.retrieval.lexicalWeight),
      ),
      semanticWeight: Math.max(
        0,
        Math.min(1, value?.retrieval?.semanticWeight ?? defaults.retrieval.semanticWeight),
      ),
      salienceWeight: Math.max(
        0,
        Math.min(1, value?.retrieval?.salienceWeight ?? defaults.retrieval.salienceWeight),
      ),
      confidenceWeight: Math.max(
        0,
        Math.min(1, value?.retrieval?.confidenceWeight ?? defaults.retrieval.confidenceWeight),
      ),
    },
    consolidation: {
      ...defaults.consolidation,
      ...value?.consolidation,
      maxWriteCandidatesPerTurn: Math.max(
        1,
        Math.floor(
          value?.consolidation?.maxWriteCandidatesPerTurn ??
            defaults.consolidation.maxWriteCandidatesPerTurn,
        ),
      ),
    },
    rollout: {
      ...defaults.rollout,
      ...value?.rollout,
      traceCaptureEnabled: value?.rollout?.traceCaptureEnabled ?? defaults.rollout.traceCaptureEnabled,
      inspectionApiEnabled:
        value?.rollout?.inspectionApiEnabled ?? defaults.rollout.inspectionApiEnabled,
      cortexUiEnabled: value?.rollout?.cortexUiEnabled ?? defaults.rollout.cortexUiEnabled,
      replaySchedulerEnabled:
        value?.rollout?.replaySchedulerEnabled ?? defaults.rollout.replaySchedulerEnabled,
    },
  };
}

export function createEmptyMemoryStoreData(): MemoryStoreData {
  return {
    sessions: [],
    items: [],
    edges: [],
  };
}

export function createMemorySession(input: MemorySession): MemorySession {
  return {
    ...input,
    topics: uniqueStrings(input.topics),
    summary: input.summary.trim(),
  };
}

export function createMemoryItem(candidate: MemoryWriteCandidate, id: string, now: string): MemoryItem {
  return {
    id,
    sessionId: candidate.sessionId ?? null,
    createdAt: now,
    updatedAt: now,
    observedAt: candidate.observedAt ?? null,
    memoryType: candidate.memoryType,
    scope: candidate.scope,
    content: candidate.content.trim(),
    jsonValue: mergeMemoryInternalMetadata(candidate.jsonValue, {
      reinforcementCount: candidate.reinforcementCount ?? 1,
      lastReinforcedAt: candidate.lastReinforcedAt ?? candidate.observedAt ?? now,
      revalidationDueAt: candidate.revalidationDueAt ?? null,
      retrievalSuccessCount: 0,
      lastRetrievedAt: null,
    }),
    tags: uniqueStrings(candidate.tags ?? []),
    sourceType: candidate.sourceType,
    sourceRef: candidate.sourceRef ?? null,
    confidence: clamp01(candidate.confidence ?? 0.8),
    salience: clamp01(candidate.salience ?? 0.7),
    volatility: candidate.volatility ?? "stable",
    validFrom: candidate.validFrom ?? null,
    validUntil: candidate.validUntil ?? null,
    supersedesId: candidate.supersedesId ?? null,
    supersededById: null,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
