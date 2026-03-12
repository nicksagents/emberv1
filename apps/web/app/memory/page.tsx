import type { Settings } from "@ember/core/client";

import { MemoryLab } from "../../components/memory-lab";
import { PageIntro } from "../../components/page-intro";
import type {
  MemoryGraphPayloadView,
  MemoryOverviewPayloadView,
} from "../../components/memory-schema";
import { getJson } from "../../lib/api";

function createEmptyGraph(): MemoryGraphPayloadView {
  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalMemories: 0,
      visibleNodes: 0,
      visibleLinks: 0,
      staleNodes: 0,
      activeNodes: 0,
      clusterCount: 0,
      activeTraceCount: 0,
    },
    nodes: [],
    links: [],
    clusters: [],
  };
}

function createEmptyOverview(): MemoryOverviewPayloadView {
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalMemories: 0,
      activeMemories: 0,
      staleMemories: 0,
      supersededMemories: 0,
      forgottenMemories: 0,
      activeSessions: 0,
      archivedSessions: 0,
      recentTraceCount: 0,
      explicitEdgeCount: 0,
      replayEdgeCount: 0,
    },
    maintenance: {
      replay: {
        status: "idle",
        currentReason: null,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastSkippedAt: null,
        lastFailedAt: null,
        lastSkipReason: null,
        lastError: null,
        runCount: 0,
        skipCount: 0,
        failureCount: 0,
        archivedSessionCount: 0,
        latestArchivedAt: null,
        lastProcessedArchiveAt: null,
        lastResult: null,
      },
    },
    recentMemories: [],
    profileMemories: [],
    sessionMemories: [],
    staleMemories: [],
    sessions: [],
    traces: [],
  };
}

export default async function MemoryPage() {
  let initialGraph = createEmptyGraph();
  let initialOverview = createEmptyOverview();
  let settings: Settings | null = null;

  try {
    const settingsPayload = await getJson<{ item: Settings }>("/api/settings");
    settings = settingsPayload.item;
  } catch {
    settings = null;
  }

  if (!settings?.memory.enabled) {
    return (
      <div className="memory-page-shell">
        <PageIntro
          eyebrow="Phase 9 · Rollout"
          title="Memory Cortex Disabled"
          description="Long-term memory is disabled in settings, so the cortex visualizer and inspection APIs are offline."
        />
      </div>
    );
  }

  if (!settings.memory.rollout.cortexUiEnabled) {
    return (
      <div className="memory-page-shell">
        <PageIntro
          eyebrow="Phase 9 · Rollout"
          title="Cortex UI Gated"
          description="The memory cortex is built, but the UI is disabled by rollout settings. Enable `memory.rollout.cortexUiEnabled` to turn on the 3D visualizer."
        />
      </div>
    );
  }

  if (!settings.memory.rollout.inspectionApiEnabled) {
    return (
      <div className="memory-page-shell">
        <PageIntro
          eyebrow="Phase 9 · Rollout"
          title="Inspection APIs Gated"
          description="The 3D memory page is enabled, but inspection APIs are disabled by rollout settings. Enable `memory.rollout.inspectionApiEnabled` to expose graph and overview data."
        />
      </div>
    );
  }

  try {
    [initialGraph, initialOverview] = await Promise.all([
      getJson<MemoryGraphPayloadView>("/api/memory/graph?limit=220&trace_limit=24"),
      getJson<MemoryOverviewPayloadView>("/api/memory/overview?trace_limit=12"),
    ]);
  } catch {
    initialGraph = createEmptyGraph();
    initialOverview = createEmptyOverview();
  }

  return <MemoryLab initialGraph={initialGraph} initialOverview={initialOverview} />;
}
