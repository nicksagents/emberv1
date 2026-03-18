"use client";

import { useState, useEffect, useCallback } from "react";
import { SimulationCard } from "./simulation-card";

interface SimulationListItem {
  id: string;
  title: string;
  status: string;
  domain: string;
  personaCount: number;
  roundCount: number;
  currentRound: number;
  createdAt: string;
  updatedAt: string;
}

const DOMAIN_ICONS: Record<string, string> = {
  finance: "\u{1F4CA}",
  technology: "\u{1F4BB}",
  geopolitics: "\u{1F30D}",
  social: "\u{1F465}",
  business: "\u{1F4BC}",
  science: "\u{1F52C}",
  healthcare: "\u{1F3E5}",
  environment: "\u{1F33F}",
  other: "\u{1F52E}",
};

const STATUS_META: Record<string, { color: string; bg: string; label: string }> = {
  starting:  { color: "#0a84ff", bg: "rgba(10,132,255,0.1)", label: "Starting" },
  idle:      { color: "#888", bg: "rgba(136,136,136,0.1)", label: "Idle" },
  created:   { color: "#888", bg: "rgba(136,136,136,0.1)", label: "Created" },
  preparing: { color: "#ff9f0a", bg: "rgba(255,159,10,0.1)", label: "Preparing" },
  ready:     { color: "#0a84ff", bg: "rgba(10,132,255,0.1)", label: "Ready" },
  running:   { color: "#ff9f0a", bg: "rgba(255,159,10,0.1)", label: "Running" },
  paused:    { color: "#ff9500", bg: "rgba(255,149,0,0.1)", label: "Paused" },
  stopped:   { color: "#ff9500", bg: "rgba(255,149,0,0.1)", label: "Stopped" },
  completed: { color: "#30d158", bg: "rgba(48,209,88,0.1)", label: "Completed" },
  failed:    { color: "#ff453a", bg: "rgba(255,69,58,0.1)", label: "Failed" },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SimulationHistory() {
  const [simulations, setSimulations] = useState<SimulationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ domain?: string; status?: string }>({});

  const fetchSimulations = useCallback(async () => {
    try {
      const res = await fetch("/api/simulations");
      const data = (await res.json()) as { items: SimulationListItem[] };
      setSimulations(data.items);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSimulations();
  }, [fetchSimulations]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this simulation?")) return;
    await fetch(`/api/simulations/${id}`, { method: "DELETE" });
    setSimulations((prev) => prev.filter((s) => s.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const filtered = simulations.filter((s) => {
    if (filter.domain && s.domain !== filter.domain) return false;
    if (filter.status && s.status !== filter.status) return false;
    return true;
  });

  const domains = [...new Set(simulations.map((s) => s.domain))];
  const statuses = [...new Set(simulations.map((s) => s.status))];

  if (loading) {
    return (
      <div className="sim-history-empty">
        <span className="sim-history-empty-icon">...</span>
        Loading simulations
      </div>
    );
  }

  if (simulations.length === 0) {
    return (
      <div className="sim-history-empty">
        <span className="sim-history-empty-icon">{"\u{1F52E}"}</span>
        No simulations yet. Start one from the chat.
      </div>
    );
  }

  return (
    <div className="sim-history">
      {/* Filters */}
      <div className="sim-history-bar">
        <div className="sim-history-filters">
          <select
            className="sim-history-select"
            value={filter.domain ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, domain: e.target.value || undefined }))}
          >
            <option value="">All domains</option>
            {domains.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <select
            className="sim-history-select"
            value={filter.status ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value || undefined }))}
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <span className="sim-history-count">{filtered.length} of {simulations.length}</span>
      </div>

      {/* Expanded detail */}
      {selectedId && (
        <div className="sim-history-detail">
          <div className="sim-history-detail-bar">
            <button
              type="button"
              className="sim-history-close"
              onClick={() => setSelectedId(null)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              Close detail
            </button>
          </div>
          <SimulationCard simulationId={selectedId} />
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <div className="sim-history-empty">No simulations match filters.</div>
      ) : (
        <div className="sim-history-list">
          {filtered.map((sim) => {
            const sm = STATUS_META[sim.status] ?? STATUS_META.created;
            const icon = DOMAIN_ICONS[sim.domain] ?? DOMAIN_ICONS.other;
            const isSelected = selectedId === sim.id;
            const progress = sim.roundCount > 0
              ? Math.round((sim.currentRound / sim.roundCount) * 100)
              : 0;

            return (
              <button
                key={sim.id}
                type="button"
                className={`sim-history-item${isSelected ? " selected" : ""}`}
                onClick={() => setSelectedId(isSelected ? null : sim.id)}
              >
                {/* Domain icon */}
                <span className="sim-history-icon">{icon}</span>

                {/* Main content */}
                <div className="sim-history-body">
                  <div className="sim-history-title-row">
                    <span className="sim-history-title">{sim.title || "Untitled"}</span>
                    <span
                      className="sim-history-status"
                      style={{ color: sm.color, background: sm.bg }}
                    >
                      {sm.label}
                    </span>
                  </div>
                  <div className="sim-history-meta">
                    <span>{sim.personaCount} personas</span>
                    <span className="sim-history-dot" />
                    <span>{sim.currentRound}/{sim.roundCount} rounds</span>
                    <span className="sim-history-dot" />
                    <span>{formatDate(sim.createdAt)}</span>
                  </div>
                  {/* Progress bar for non-completed/failed */}
                  {(sim.status === "running" || sim.status === "preparing" || (sim.status !== "completed" && sim.status !== "failed" && progress > 0)) && (
                    <div className="sim-history-progress">
                      <div className="sim-history-progress-fill" style={{ width: `${progress}%`, background: sm.color }} />
                    </div>
                  )}
                </div>

                {/* Delete */}
                <button
                  type="button"
                  className="sim-history-delete"
                  title="Delete simulation"
                  onClick={(e) => handleDelete(sim.id, e)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
