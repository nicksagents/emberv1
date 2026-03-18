"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

const LIVE_STATUSES = new Set(["starting", "created", "preparing", "ready", "running"]);

function statusLabel(status: string): string {
  switch (status) {
    case "idle": return "Idle";
    case "stopped": return "Stopped";
    case "starting": return "Starting";
    case "preparing": return "Preparing";
    case "running": return "Running";
    case "ready": return "Ready";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "paused": return "Paused";
    case "created": return "Created";
    default: return status;
  }
}

export function ChatSimulationDock() {
  const [items, setItems] = useState<SimulationListItem[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/simulations", { cache: "no-store" });
      if (!res.ok) return;
      const payload = await res.json() as { items?: SimulationListItem[] };
      const next = (payload.items ?? []).slice(0, 12);
      setItems(next);

      if (!selectedId && next.length > 0) {
        const live = next.find((s) => LIVE_STATUSES.has(s.status));
        setSelectedId(live?.id ?? next[0].id);
      } else if (selectedId && !next.some((s) => s.id === selectedId)) {
        setSelectedId(next[0]?.id ?? null);
      }
    } catch {
      // best-effort background refresh
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasLive = useMemo(
    () => items.some((item) => LIVE_STATUSES.has(item.status)),
    [items],
  );

  useEffect(() => {
    const intervalMs = hasLive ? 2500 : 10000;
    const timer = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [hasLive, refresh]);

  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const runningCount = items.filter((item) => LIVE_STATUSES.has(item.status)).length;

  return (
    <div className={`chat-sim-dock${open ? " open" : ""}`}>
      <button
        type="button"
        className={`chat-sim-dock-toggle${hasLive ? " live" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Toggle swarm command center"
      >
        <span className="chat-sim-dock-toggle-title">Swarm</span>
        <span className="chat-sim-dock-toggle-meta">
          {runningCount > 0 ? `${runningCount} live` : `${items.length} runs`}
        </span>
      </button>

      {open && (
        <div className="chat-sim-dock-panel">
          <div className="chat-sim-dock-head">
            <h4>Swarm Command Center</h4>
            <button type="button" className="chat-sim-dock-refresh" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="chat-sim-dock-empty">Loading simulations...</div>
          ) : items.length === 0 ? (
            <div className="chat-sim-dock-empty">No simulations yet.</div>
          ) : (
            <>
              <div className="chat-sim-dock-list">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`chat-sim-dock-item${selected?.id === item.id ? " active" : ""}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="chat-sim-dock-item-title">{item.title || item.id}</span>
                    <span className={`chat-sim-dock-item-status status-${item.status}`}>
                      {statusLabel(item.status)}
                    </span>
                  </button>
                ))}
              </div>

              {selected && (
                <div className="chat-sim-dock-card">
                  <SimulationCard simulationId={selected.id} enableSSE={true} compact={true} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
