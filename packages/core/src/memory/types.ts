export const MEMORY_TYPES = [
  "user_profile",
  "user_preference",
  "project_fact",
  "environment_fact",
  "procedure",
  "world_fact",
  "episode_summary",
  "task_outcome",
  "warning_or_constraint",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ["user", "workspace", "global"] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_SOURCE_TYPES = [
  "user_message",
  "assistant_message",
  "tool_result",
  "web_page",
  "session_summary",
  "system",
] as const;

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export const MEMORY_VOLATILITIES = [
  "stable",
  "slow-changing",
  "event",
  "volatile",
] as const;

export type MemoryVolatility = (typeof MEMORY_VOLATILITIES)[number];

export const MEMORY_EDGE_RELATIONS = [
  "derived_from",
  "reinforces",
  "contradicts",
  "about_user",
  "about_project",
  "supersedes",
] as const;

export type MemoryEdgeRelation = (typeof MEMORY_EDGE_RELATIONS)[number];

export const MEMORY_APPROVAL_STATUSES = [
  "implicit",
  "pending",
  "approved",
  "disputed",
  "rejected",
] as const;

export type MemoryApprovalStatus = (typeof MEMORY_APPROVAL_STATUSES)[number];

export interface MemoryConfig {
  enabled: boolean;
  backend: "file" | "sqlite";
  storage: {
    fileName: string;
    sqliteFileName: string;
  };
  embeddings: {
    enabled: boolean;
    model: "token-hash";
    dimensions: number;
    maxCandidates: number;
  };
  retrieval: {
    maxResults: number;
    minScore: number;
    maxInjectedItems: number;
    maxInjectedChars: number;
    lexicalWeight: number;
    semanticWeight: number;
    salienceWeight: number;
    confidenceWeight: number;
  };
  consolidation: {
    enabled: boolean;
    autoExtractUserFacts: boolean;
    autoExtractWorldFacts: boolean;
    autoSummarizeSessions: boolean;
    maxWriteCandidatesPerTurn: number;
  };
  rollout: {
    traceCaptureEnabled: boolean;
    inspectionApiEnabled: boolean;
    cortexUiEnabled: boolean;
    replaySchedulerEnabled: boolean;
  };
}

export interface MemorySession {
  id: string;
  conversationId: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: string;
  topics: string[];
  messageCount: number;
  lastMessageAt: string | null;
}

export interface MemoryItem {
  id: string;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  observedAt: string | null;
  memoryType: MemoryType;
  scope: MemoryScope;
  content: string;
  jsonValue?: Record<string, unknown> | null;
  tags: string[];
  sourceType: MemorySourceType;
  sourceRef: string | null;
  confidence: number;
  salience: number;
  volatility: MemoryVolatility;
  validFrom: string | null;
  validUntil: string | null;
  supersedesId: string | null;
  supersededById: string | null;
}

export interface MemoryEdge {
  fromId: string;
  toId: string;
  relation: MemoryEdgeRelation;
}

export interface MemoryStoreData {
  sessions: MemorySession[];
  items: MemoryItem[];
  edges: MemoryEdge[];
}

export interface MemoryItemFilter {
  sessionId?: string | null;
  scope?: MemoryScope | null;
  memoryType?: MemoryType | null;
  sourceType?: MemorySourceType | null;
  includeSuperseded?: boolean;
}

export interface MemoryEdgeFilter {
  fromId?: string | null;
  toId?: string | null;
  relation?: MemoryEdgeRelation | null;
}

export interface MemoryWriteCandidate {
  sessionId: string | null;
  memoryType: MemoryType;
  scope: MemoryScope;
  content: string;
  jsonValue?: Record<string, unknown> | null;
  tags?: string[];
  sourceType: MemorySourceType;
  sourceRef?: string | null;
  confidence?: number;
  salience?: number;
  volatility?: MemoryVolatility;
  observedAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  reinforcementCount?: number;
  lastReinforcedAt?: string | null;
  revalidationDueAt?: string | null;
  supersedesId?: string | null;
}

export type MemoryTaskState = "normal" | "blocked" | "failing";

export interface MemorySearchQuery {
  text: string;
  activeSessionId?: string | null;
  scopes?: MemoryScope[];
  memoryTypes?: MemoryType[];
  sourceTypes?: MemorySourceType[];
  tags?: string[];
  activeRole?: string | null;
  handoffSourceRole?: string | null;
  activeSubgoal?: string | null;
  recentToolNames?: string[];
  workspaceTopics?: string[];
  taskState?: MemoryTaskState | null;
  preferredSourceTypes?: MemorySourceType[];
  maxResults?: number;
  minScore?: number;
  maxInjectedItems?: number;
  maxInjectedChars?: number;
  now?: string;
}

export interface MemorySearchResult {
  item: MemoryItem;
  score: number;
  matchedTerms: string[];
  cueMatches: string[];
  reason: string;
}

export interface MemoryPromptContext {
  text: string;
  totalChars: number;
  results: MemorySearchResult[];
}

export interface MemoryRepository {
  listSessions(): Promise<MemorySession[]>;
  getSession(id: string): Promise<MemorySession | null>;
  upsertSession(session: MemorySession): Promise<MemorySession>;
  listItems(filter?: MemoryItemFilter): Promise<MemoryItem[]>;
  listEdges(filter?: MemoryEdgeFilter): Promise<MemoryEdge[]>;
  getItem(id: string): Promise<MemoryItem | null>;
  upsertItems(candidates: MemoryWriteCandidate[]): Promise<MemoryItem[]>;
  upsertEdges(edges: MemoryEdge[]): Promise<MemoryEdge[]>;
  forgetItem(id: string, options?: { reason?: string | null; now?: string }): Promise<MemoryItem | null>;
  reinforceItem(
    id: string,
    options?: {
      now?: string;
      confidenceDelta?: number;
      salienceDelta?: number;
      extendValidity?: boolean;
      revalidationDueAt?: string | null;
      reinforcementDelta?: number;
      retrievalSuccessDelta?: number;
      lastRetrievedAt?: string | null;
    },
  ): Promise<MemoryItem | null>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
  buildPromptContext(query: MemorySearchQuery): Promise<MemoryPromptContext>;
  close?(): Promise<void>;
}
