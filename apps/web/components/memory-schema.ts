export interface MemoryTraceView {
  id: string;
  kind: "persistent" | "procedure";
  conversationId: string | null;
  queryText: string;
  queryCues: {
    activeRole: string | null;
    handoffSourceRole: string | null;
    activeSubgoal: string | null;
    recentToolNames: string[];
    workspaceTopics: string[];
    taskState: string | null;
    preferredSourceTypes: string[];
  };
  promptText: string;
  createdAt: string;
  resultCount: number;
  totalChars: number;
  results: Array<{
    memoryId: string;
    memoryType: string;
    scope: string;
    content: string;
    sourceRef: string | null;
    score: number;
    reason: string;
    tags: string[];
    cueMatches: string[];
  }>;
}

export interface MemoryOverviewRecordView {
  id: string;
  sessionId: string | null;
  content: string;
  memoryType: string;
  scope: string;
  sourceType: string;
  sourceRef: string | null;
  sourceLabel: string;
  volatility: string;
  confidence: number;
  salience: number;
  status: "active" | "superseded" | "expired" | "forgotten";
  tags: string[];
  updatedAt: string;
  observedAt: string | null;
  validUntil: string | null;
  reinforcementCount: number;
  lastReinforcedAt: string | null;
  revalidationDueAt: string | null;
  needsRevalidation: boolean;
  approvalStatus: "implicit" | "pending" | "approved" | "disputed" | "rejected";
  contradictionCount: number;
  contradictionSessionCount: number;
  approvedAt: string | null;
  clusterId: string;
  clusterLabel: string;
  activation: number;
}

export interface MemoryOverviewPayloadView {
  generatedAt: string;
  summary: {
    totalMemories: number;
    activeMemories: number;
    staleMemories: number;
    supersededMemories: number;
    forgottenMemories: number;
    activeSessions: number;
    archivedSessions: number;
    recentTraceCount: number;
    explicitEdgeCount: number;
    replayEdgeCount: number;
  };
  maintenance: {
    replay: {
      status: "idle" | "running" | "completed" | "skipped" | "failed";
      currentReason: string | null;
      lastStartedAt: string | null;
      lastCompletedAt: string | null;
      lastSkippedAt: string | null;
      lastFailedAt: string | null;
      lastSkipReason: string | null;
      lastError: string | null;
      runCount: number;
      skipCount: number;
      failureCount: number;
      archivedSessionCount: number;
      latestArchivedAt: string | null;
      lastProcessedArchiveAt: string | null;
      lastResult: {
        generatedAt: string;
        writtenItems: Array<{
          id: string;
          memoryType: string;
          scope: string;
          content: string;
          sourceType: string;
          sourceRef: string | null;
        }>;
        reinforcedItemIds: string[];
        linkedEdges: Array<{
          fromId: string;
          toId: string;
          relation: string;
        }>;
      } | null;
    };
  };
  recentMemories: MemoryOverviewRecordView[];
  profileMemories: MemoryOverviewRecordView[];
  sessionMemories: MemoryOverviewRecordView[];
  staleMemories: MemoryOverviewRecordView[];
  sessions: Array<{
    id: string;
    summary: string;
    topics: string[];
    startedAt: string;
    endedAt: string | null;
    messageCount: number;
  }>;
  traces: MemoryTraceView[];
}

export interface MemoryGraphNodeView extends MemoryOverviewRecordView {
  label: string;
  size: number;
  energy: number;
  colorKey: string;
}

export interface MemoryGraphLinkView {
  source: string;
  target: string;
  weight: number;
  pulseRate: number;
  sharedTags: string[];
  reasons: string[];
}

export interface MemoryGraphClusterView {
  id: string;
  label: string;
  kind: "self" | "workspace" | "world" | "session" | "constraint";
  nodeCount: number;
  energy: number;
  dominantType: string;
}

export interface MemoryGraphPayloadView {
  generatedAt: string;
  stats: {
    totalMemories: number;
    visibleNodes: number;
    visibleLinks: number;
    staleNodes: number;
    activeNodes: number;
    clusterCount: number;
    activeTraceCount: number;
  };
  nodes: MemoryGraphNodeView[];
  links: MemoryGraphLinkView[];
  clusters: MemoryGraphClusterView[];
}
