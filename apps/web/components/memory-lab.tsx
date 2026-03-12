"use client";

import { useRouter } from "next/navigation";
import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import type {
  MemoryGraphLinkView,
  MemoryGraphNodeView,
  MemoryGraphPayloadView,
  MemoryOverviewPayloadView,
  MemoryOverviewRecordView,
} from "./memory-schema";
import { MemoryConstellation } from "./memory-constellation";
import { clientApiPath } from "../lib/api";

type StatusFilter = "all" | "active" | "stale";

function formatRelativeDate(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatApprovalLabel(value: MemoryOverviewRecordView["approvalStatus"]): string {
  switch (value) {
    case "approved":
      return "approved";
    case "pending":
      return "pending review";
    case "disputed":
      return "disputed";
    case "rejected":
      return "rejected";
    case "implicit":
      return "implicit";
  }
}

function matchesSearch(node: MemoryGraphNodeView, query: string): boolean {
  if (!query) {
    return true;
  }

  const haystack = [
    node.label,
    node.content,
    node.memoryType,
    node.scope,
    node.clusterLabel,
    node.sourceLabel,
    ...node.tags,
  ].join(" ").toLowerCase();

  return haystack.includes(query);
}

function matchesStatus(node: MemoryGraphNodeView, filter: StatusFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "active") {
    return node.status === "active" && !node.needsRevalidation;
  }
  return node.status !== "active" || node.needsRevalidation;
}

function buildVisibleGraph(
  graph: MemoryGraphPayloadView,
  search: string,
  statusFilter: StatusFilter,
): MemoryGraphPayloadView {
  const nodes = graph.nodes.filter((node) => matchesStatus(node, statusFilter) && matchesSearch(node, search));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const links = graph.links.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));
  const clusterCounts = new Map<string, number>();
  for (const node of nodes) {
    clusterCounts.set(node.clusterId, (clusterCounts.get(node.clusterId) ?? 0) + 1);
  }

  return {
    ...graph,
    nodes,
    links,
    clusters: graph.clusters.filter((cluster) => (clusterCounts.get(cluster.id) ?? 0) > 0),
    stats: {
      ...graph.stats,
      visibleNodes: nodes.length,
      visibleLinks: links.length,
      staleNodes: nodes.filter((node) => node.status !== "active" || node.needsRevalidation).length,
      activeNodes: nodes.filter((node) => node.status === "active" && !node.needsRevalidation).length,
      clusterCount: graph.clusters.filter((cluster) => (clusterCounts.get(cluster.id) ?? 0) > 0).length,
    },
  };
}

function getConnectedLinks(links: MemoryGraphLinkView[], selectedId: string | null): MemoryGraphLinkView[] {
  if (!selectedId) {
    return [];
  }
  return links
    .filter((link) => link.source === selectedId || link.target === selectedId)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 8);
}

function getConnectedNodes(
  nodes: MemoryGraphNodeView[],
  links: MemoryGraphLinkView[],
  selectedId: string | null,
): Array<MemoryGraphNodeView & { linkWeight: number }> {
  if (!selectedId) {
    return [];
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return getConnectedLinks(links, selectedId)
    .map((link) => {
      const relatedId = link.source === selectedId ? link.target : link.source;
      const node = nodesById.get(relatedId);
      return node ? { ...node, linkWeight: link.weight } : null;
    })
    .filter((node): node is MemoryGraphNodeView & { linkWeight: number } => Boolean(node));
}

function buildNodeIndex(nodes: MemoryGraphNodeView[]): Map<string, MemoryGraphNodeView> {
  return new Map(nodes.map((node) => [node.id, node]));
}

export function MemoryLab({
  initialGraph,
  initialOverview,
}: {
  initialGraph: MemoryGraphPayloadView;
  initialOverview: MemoryOverviewPayloadView;
}) {
  const router = useRouter();
  const [graph, setGraph] = useState(initialGraph);
  const [overview, setOverview] = useState(initialOverview);
  const [selectedId, setSelectedId] = useState<string | null>(initialGraph.nodes[0]?.id ?? null);
  const [nodeLimit, setNodeLimit] = useState(String(Math.max(120, initialGraph.stats.visibleNodes || 220)));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [isControlsOpen, setControlsOpen] = useState(false);
  const [isInspectorOpen, setInspectorOpen] = useState(false);
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const menuRef = useRef<HTMLDivElement>(null);

  async function refresh(nextLimit = nodeLimit) {
    setLoading(true);
    setError(null);

    try {
      const [graphResponse, overviewResponse] = await Promise.all([
        fetch(clientApiPath(`/memory/graph?limit=${encodeURIComponent(nextLimit)}&trace_limit=24`), {
          cache: "no-store",
        }),
        fetch(clientApiPath("/memory/overview?trace_limit=12"), {
          cache: "no-store",
        }),
      ]);

      if (!graphResponse.ok || !overviewResponse.ok) {
        throw new Error("Failed to refresh the memory cortex.");
      }

      const [nextGraph, nextOverview] = (await Promise.all([
        graphResponse.json(),
        overviewResponse.json(),
      ])) as [MemoryGraphPayloadView, MemoryOverviewPayloadView];

      startTransition(() => {
        setGraph(nextGraph);
        setOverview(nextOverview);
        setSelectedId((current) => current ?? nextGraph.nodes[0]?.id ?? null);
      });
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh the memory cortex.");
    } finally {
      setLoading(false);
    }
  }

  async function runReplayNow() {
    setActionBusy("replay");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(clientApiPath("/memory/replay"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: true }),
      });
      const payload = (await response.json()) as { error?: string; outcome?: "ran" | "skipped" };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to run replay.");
      }
      setNotice(payload.outcome === "ran" ? "Replay completed." : "Replay skipped.");
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to run replay.");
    } finally {
      setActionBusy(null);
    }
  }

  async function postMemoryAction(
    path: string,
    successMessage: string,
  ): Promise<{ item?: { id?: string } }> {
    setActionBusy(path);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(clientApiPath(path), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const payload = (await response.json()) as { error?: string; item?: { id?: string } };
      if (!response.ok) {
        throw new Error(payload.error ?? "Memory action failed.");
      }
      setNotice(successMessage);
      await refresh();
      return payload;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Memory action failed.");
      return {};
    } finally {
      setActionBusy(null);
    }
  }

  async function suppressSelectedMemory() {
    if (!activeNode) {
      return;
    }
    if (!window.confirm("Suppress this memory? It will stop being recalled.")) {
      return;
    }
    await postMemoryAction(`/memory/items/${encodeURIComponent(activeNode.id)}/suppress`, "Memory suppressed.");
  }

  async function revalidateSelectedMemory() {
    if (!activeNode) {
      return;
    }
    const payload = await postMemoryAction(
      `/memory/items/${encodeURIComponent(activeNode.id)}/revalidate`,
      "Memory revalidated.",
    );
    if (payload.item?.id) {
      setSelectedId(payload.item.id);
    }
  }

  async function approveSelectedMemory() {
    if (!activeNode) {
      return;
    }
    const payload = await postMemoryAction(
      `/memory/items/${encodeURIComponent(activeNode.id)}/approve`,
      "Memory approved.",
    );
    if (payload.item?.id) {
      setSelectedId(payload.item.id);
    }
  }

  async function retireSelectedProcedure() {
    if (!activeNode) {
      return;
    }
    if (!window.confirm("Retire this learned procedure? Ember will stop recalling it as an active routine.")) {
      return;
    }
    const payload = await postMemoryAction(
      `/memory/items/${encodeURIComponent(activeNode.id)}/retire`,
      "Procedure retired.",
    );
    if (payload.item?.id) {
      setSelectedId(payload.item.id);
    }
  }

  useEffect(() => {
    const handle = window.setInterval(() => {
      void refresh();
    }, 20_000);
    return () => window.clearInterval(handle);
  }, [nodeLimit]);

  const visibleGraph = useMemo(
    () => buildVisibleGraph(graph, deferredQuery, statusFilter),
    [deferredQuery, graph, statusFilter],
  );
  const visibleNodesById = useMemo(() => buildNodeIndex(visibleGraph.nodes), [visibleGraph.nodes]);
  const selectedNode = selectedId ? visibleNodesById.get(selectedId) ?? null : null;
  const selectedFallback = selectedNode ?? visibleGraph.nodes[0] ?? null;
  const effectiveSelectedId = selectedNode ? selectedId : selectedFallback?.id ?? null;
  const activeNode = effectiveSelectedId ? visibleNodesById.get(effectiveSelectedId) ?? null : null;
  const connectedLinks = getConnectedLinks(visibleGraph.links, effectiveSelectedId);
  const connectedNodes = getConnectedNodes(visibleGraph.nodes, visibleGraph.links, effectiveSelectedId);
  const topClusters = visibleGraph.clusters.slice(0, 6);
  const hasVisibleMemories = visibleGraph.nodes.length > 0;
  const persistentCountLabel =
    visibleGraph.stats.visibleNodes === 1
      ? "1 persistent memory"
      : `${visibleGraph.stats.visibleNodes} persistent memories`;

  useEffect(() => {
    if (!effectiveSelectedId && visibleGraph.nodes[0]) {
      setSelectedId(visibleGraph.nodes[0].id);
      return;
    }

    if (effectiveSelectedId && !visibleNodesById.has(effectiveSelectedId) && visibleGraph.nodes[0]) {
      setSelectedId(visibleGraph.nodes[0].id);
    }
  }, [effectiveSelectedId, visibleGraph.nodes, visibleNodesById]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      setControlsOpen(false);
      setInspectorOpen(false);
      setMenuOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Click-outside handler for menu
  useEffect(() => {
    if (!isMenuOpen) return;

    let isProcessing = false;

    const handleClickOutside = (event: MouseEvent) => {
      if (isProcessing) return;
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        isProcessing = true;
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMenuOpen]);

  function jumpToMemory(record: MemoryOverviewRecordView) {
    setSelectedId(record.id);
    setInspectorOpen(true);
  }

  function handleSelectMemory(id: string | null) {
    setSelectedId(id);
    if (id) {
      setInspectorOpen(true);
    }
  }

  return (
    <div className="memory-page-shell">
      {error ? <div className="notice-strip danger">{error}</div> : null}
      {notice ? <div className="notice-strip">{notice}</div> : null}

      <section className="memory-visualizer-stage">
        <div className="memory-overlay memory-overlay-minibar">
          <div className="memory-menu-dropdown" ref={menuRef}>
            <button
              type="button"
              className={`memory-menu-btn memory-menu-trigger ${isMenuOpen ? "is-open" : ""}`}
              onClick={() => setMenuOpen((current) => !current)}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
            >
              <span>Menu</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M2.5 4.5L6 8L9.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {isMenuOpen && (
              <div
                className="memory-menu-popover"
                role="menu"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="memory-menu-item"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    router.push("/chat");
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path
                      d="M8.5 3.5L5 7L8.5 10.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Back to Chat</span>
                </button>
                <button
                  type="button"
                  className="memory-menu-item"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    setControlsOpen(true);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.5" />
                    <path
                      d="M12 7C12 9.76142 9.76142 12 7 12C4.23858 12 2 9.76142 2 7C2 4.23858 4.23858 2 7 2C9.76142 2 12 4.23858 12 7Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeDasharray="1.5 2"
                    />
                  </svg>
                  <span>Explore</span>
                </button>
                <button
                  type="button"
                  className="memory-menu-item"
                  role="menuitem"
                  disabled={!hasVisibleMemories}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    setInspectorOpen(true);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path
                      d="M6 11C8.76142 11 11 8.76142 11 6C11 3.23858 8.76142 1 6 1C3.23858 1 1 3.23858 1 6C1 8.76142 3.23858 11 6 11Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <span>Inspect</span>
                </button>
              </div>
            )}
          </div>

          <div className="memory-stage-pill">
            <span className="memory-title-kicker">Persistent cortex</span>
            <strong>{persistentCountLabel}</strong>
          </div>
        </div>

        <div className="memory-overlay memory-overlay-hintbar">
          <div className="memory-stage-hint">Pre-prompt long-term memory only</div>
          <div className="memory-stage-hint">Drag to rotate. Tap a node to inspect.</div>
        </div>

        {visibleGraph.nodes.length > 0 ? (
          <MemoryConstellation
            graph={visibleGraph}
            selectedId={effectiveSelectedId}
            onSelectId={handleSelectMemory}
          />
        ) : (
          <div className="memory-empty-state">
            <h2>No memories match this filter.</h2>
            <p>Try broadening the search or switching back to all persistent memories.</p>
          </div>
        )}

        <button
          type="button"
          className={`memory-drawer-scrim ${isControlsOpen || isInspectorOpen ? "is-open" : ""}`}
          aria-label="Close memory panels"
          onClick={() => {
            setControlsOpen(false);
            setInspectorOpen(false);
          }}
        />

        <aside className={`memory-drawer memory-drawer-left ${isControlsOpen ? "is-open" : ""}`}>
          <div className="memory-drawer-head">
            <div>
              <span className="memory-title-kicker">Explore</span>
              <strong>Persistent memory filters</strong>
            </div>
            <button type="button" className="memory-drawer-close" onClick={() => setControlsOpen(false)}>
              Close
            </button>
          </div>

          <div className="memory-drawer-body">
            <label className="memory-control memory-search">
              <span>Search</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="birthday, dog, next.js..."
              />
            </label>

            <div className="memory-inline-grid">
              <label className="memory-control">
                <span>State</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                  <option value="all">All</option>
                  <option value="active">Active</option>
                  <option value="stale">Stale</option>
                </select>
              </label>

              <label className="memory-control">
                <span>Nodes</span>
                <select
                  value={nodeLimit}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setNodeLimit(nextValue);
                    void refresh(nextValue);
                  }}
                >
                  <option value="120">120</option>
                  <option value="180">180</option>
                  <option value="220">220</option>
                  <option value="280">280</option>
                  <option value="320">320</option>
                </select>
              </label>
            </div>

            <button type="button" className="memory-refresh-btn" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh cortex"}
            </button>

            <div className="memory-mini-stat-grid">
              {[
                ["Total", overview.summary.totalMemories],
                ["Active", overview.summary.activeMemories],
                ["Stale", overview.summary.staleMemories],
                ["Clusters", visibleGraph.stats.clusterCount],
              ].map(([label, value]) => (
                <div key={String(label)} className="memory-mini-stat">
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>

            <div className="memory-drawer-section">
              <div className="memory-section-head">
                <span>Replay maintenance</span>
                <strong>{overview.maintenance.replay.status}</strong>
              </div>
              <div className="memory-domain-list">
                <div className="memory-domain-item">
                  <strong>Runs</strong>
                  <span>{overview.maintenance.replay.runCount}</span>
                  <em>
                    {overview.maintenance.replay.lastCompletedAt
                      ? `Last ${formatRelativeDate(overview.maintenance.replay.lastCompletedAt)}`
                      : "No completed replay yet"}
                  </em>
                </div>
                <div className="memory-domain-item">
                  <strong>Archived sessions</strong>
                  <span>{overview.maintenance.replay.archivedSessionCount}</span>
                  <em>
                    {overview.maintenance.replay.lastSkipReason
                      ? `Skip: ${overview.maintenance.replay.lastSkipReason}`
                      : overview.maintenance.replay.currentReason ?? "Waiting"}
                  </em>
                </div>
                <div className="memory-domain-item">
                  <strong>Replay edges</strong>
                  <span>{overview.summary.replayEdgeCount}</span>
                  <em>{overview.summary.explicitEdgeCount} total explicit links</em>
                </div>
              </div>
              <button
                type="button"
                className="memory-refresh-btn"
                onClick={() => void runReplayNow()}
                disabled={actionBusy === "replay"}
              >
                {actionBusy === "replay" ? "Running replay..." : "Run replay now"}
              </button>
            </div>

            <div className="memory-drawer-section">
              <div className="memory-section-head">
                <span>Domains</span>
                <strong>{topClusters.length}</strong>
              </div>
              <div className="memory-domain-list">
                {topClusters.map((cluster) => (
                  <div key={cluster.id} className="memory-domain-item">
                    <strong>{cluster.label}</strong>
                    <span>{cluster.nodeCount} memories</span>
                    <em>{cluster.energy.toFixed(2)} energy</em>
                  </div>
                ))}
              </div>
            </div>

            <div className="memory-drawer-section">
              <div className="memory-section-head">
                <span>Legend</span>
                <strong>Types</strong>
              </div>
              <div className="memory-legend memory-legend-compact">
                {[
                  ["user_profile", "Self"],
                  ["user_preference", "Preference"],
                  ["project_fact", "Workspace"],
                  ["environment_fact", "Environment"],
                  ["world_fact", "World"],
                  ["warning_or_constraint", "Constraint"],
                ].map(([key, label]) => (
                  <div key={key} className="memory-legend-item">
                    <span className={`memory-legend-dot ${key}`} />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <aside className={`memory-drawer memory-drawer-right ${isInspectorOpen ? "is-open" : ""}`}>
          <div className="memory-drawer-head">
            <div>
              <span className="memory-title-kicker">Inspect</span>
              <strong>{activeNode ? activeNode.label : "Select a memory"}</strong>
            </div>
            <button type="button" className="memory-drawer-close" onClick={() => setInspectorOpen(false)}>
              Close
            </button>
          </div>

          {activeNode ? (
            <div className="memory-drawer-body">
              <div className="memory-badges">
                <span>{activeNode.memoryType}</span>
                <span>{activeNode.scope}</span>
                <span className={`status-${activeNode.status}`}>{activeNode.status}</span>
                {activeNode.approvalStatus !== "implicit" ? (
                  <span>{formatApprovalLabel(activeNode.approvalStatus)}</span>
                ) : null}
              </div>

              <p className="memory-detail-content">{activeNode.content}</p>

              <dl className="memory-metadata">
                <div>
                  <dt>Cluster</dt>
                  <dd>{activeNode.clusterLabel}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{activeNode.sourceLabel || activeNode.sourceType}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>{formatPercent(activeNode.confidence)}</dd>
                </div>
                <div>
                  <dt>Salience</dt>
                  <dd>{formatPercent(activeNode.salience)}</dd>
                </div>
                <div>
                  <dt>Activation</dt>
                  <dd>{activeNode.activation.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>Reinforced</dt>
                  <dd>{activeNode.reinforcementCount}x</dd>
                </div>
                <div>
                  <dt>Approval</dt>
                  <dd>{formatApprovalLabel(activeNode.approvalStatus)}</dd>
                </div>
                <div>
                  <dt>Contradictions</dt>
                  <dd>
                    {activeNode.contradictionCount} / {activeNode.contradictionSessionCount} sessions
                  </dd>
                </div>
              </dl>

              {activeNode.tags.length > 0 ? (
                <div className="memory-tags">
                  {activeNode.tags.slice(0, 8).map((tag) => (
                    <span key={`${activeNode.id}-${tag}`}>{tag}</span>
                  ))}
                </div>
              ) : null}

              <div className="memory-focus-meta">
                <span>{formatRelativeDate(activeNode.observedAt ?? activeNode.updatedAt)}</span>
                {activeNode.needsRevalidation ? <span>Needs revalidation</span> : null}
                {activeNode.revalidationDueAt ? <span>Due {formatRelativeDate(activeNode.revalidationDueAt)}</span> : null}
                {activeNode.approvedAt ? <span>Approved {formatRelativeDate(activeNode.approvedAt)}</span> : null}
              </div>

              <div className="memory-action-row">
                <button
                  type="button"
                  className="memory-refresh-btn"
                  onClick={() => void approveSelectedMemory()}
                  disabled={
                    Boolean(actionBusy) ||
                    activeNode.status !== "active" ||
                    activeNode.approvalStatus === "approved"
                  }
                >
                  {actionBusy === `/memory/items/${activeNode.id}/approve` ? "Approving..." : "Approve memory"}
                </button>
                <button
                  type="button"
                  className="memory-refresh-btn"
                  onClick={() => void suppressSelectedMemory()}
                  disabled={Boolean(actionBusy) || activeNode.status === "forgotten" || activeNode.status === "superseded"}
                >
                  {actionBusy === `/memory/items/${activeNode.id}/suppress` ? "Suppressing..." : "Suppress memory"}
                </button>
                <button
                  type="button"
                  className="memory-refresh-btn"
                  onClick={() => void revalidateSelectedMemory()}
                  disabled={Boolean(actionBusy) || activeNode.status !== "active"}
                >
                  {actionBusy === `/memory/items/${activeNode.id}/revalidate` ? "Revalidating..." : "Mark revalidated"}
                </button>
                {activeNode.memoryType === "procedure" ? (
                  <button
                    type="button"
                    className="memory-refresh-btn"
                    onClick={() => void retireSelectedProcedure()}
                    disabled={Boolean(actionBusy) || activeNode.status !== "active"}
                  >
                    {actionBusy === `/memory/items/${activeNode.id}/retire` ? "Retiring..." : "Retire procedure"}
                  </button>
                ) : null}
              </div>

              {connectedNodes.length > 0 ? (
                <div className="memory-drawer-section">
                  <div className="memory-section-head">
                    <span>Related memories</span>
                    <strong>{Math.min(4, connectedNodes.length)}</strong>
                  </div>
                  <div className="memory-related-inline">
                    {connectedNodes.slice(0, 4).map((node) => (
                      <button key={node.id} type="button" onClick={() => jumpToMemory(node)}>
                        {node.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {connectedLinks.length > 0 ? (
                <div className="memory-caption">
                  Strongest link: {connectedLinks[0]?.weight.toFixed(2)} via {connectedLinks[0]?.reasons.join(", ")}.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="memory-drawer-body">
              <p className="memory-panel-copy">
                Tap a persistent memory in the constellation to inspect the stored fact that Ember can inject before a reply.
              </p>
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
