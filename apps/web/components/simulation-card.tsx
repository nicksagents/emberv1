"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface SimulationPersona {
  id: string;
  name: string;
  role: string;
  perspective: string;
  background?: string;
  biases?: string[];
  expertise?: string[];
  personality?: string;
}

interface SimulationAction {
  personaId: string;
  personaName: string;
  round: number;
  content: string;
  confidence: number;
  reasoning?: string;
  noResponse?: boolean;
  retryCount?: number;
  providerId?: string;
  modelId?: string;
}

interface SimulationRound {
  roundNumber: number;
  actions: SimulationAction[];
  synthesis: string | null;
  parseFailures?: number;
}

interface SimulationState {
  config: {
    id: string;
    title: string;
    scenario: string;
    domain: string;
    personaCount: number;
    roundCount: number;
  };
  status: string;
  personas: SimulationPersona[];
  rounds: SimulationRound[];
  currentRound: number;
  finalSynthesis: string | null;
  probabilities: Record<string, number> | null;
  error: string | null;
  startedAt?: string;
  updatedAt?: string;
}

interface SimulationRunState {
  simulationId: string;
  runnerStatus: string;
  currentRound: number;
  totalRounds: number;
  actionsCount: number;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

interface SimulationActionLogEntry {
  simulationId: string;
  timestamp: string;
  round: number;
  personaId: string;
  personaName: string;
  confidence: number;
  contentPreview: string;
}

interface SimulationEvent {
  type: string;
  simulationId: string;
  [key: string]: unknown;
}

// ─── Color System ───────────────────────────────────────────────────────────────

const PERSONA_COLORS = [
  { bg: "rgba(255, 149, 0, 0.15)", border: "rgba(255, 149, 0, 0.4)", text: "#ff9500", glow: "rgba(255, 149, 0, 0.2)" },
  { bg: "rgba(48, 209, 88, 0.15)", border: "rgba(48, 209, 88, 0.4)", text: "#30d158", glow: "rgba(48, 209, 88, 0.2)" },
  { bg: "rgba(10, 132, 255, 0.15)", border: "rgba(10, 132, 255, 0.4)", text: "#0a84ff", glow: "rgba(10, 132, 255, 0.2)" },
  { bg: "rgba(191, 90, 242, 0.15)", border: "rgba(191, 90, 242, 0.4)", text: "#bf5af2", glow: "rgba(191, 90, 242, 0.2)" },
  { bg: "rgba(255, 69, 58, 0.15)", border: "rgba(255, 69, 58, 0.4)", text: "#ff453a", glow: "rgba(255, 69, 58, 0.2)" },
  { bg: "rgba(100, 210, 255, 0.15)", border: "rgba(100, 210, 255, 0.4)", text: "#64d2ff", glow: "rgba(100, 210, 255, 0.2)" },
  { bg: "rgba(255, 214, 10, 0.15)", border: "rgba(255, 214, 10, 0.4)", text: "#ffd60a", glow: "rgba(255, 214, 10, 0.2)" },
  { bg: "rgba(172, 142, 104, 0.15)", border: "rgba(172, 142, 104, 0.4)", text: "#ac8e68", glow: "rgba(172, 142, 104, 0.2)" },
  { bg: "rgba(255, 55, 95, 0.15)", border: "rgba(255, 55, 95, 0.4)", text: "#ff375f", glow: "rgba(255, 55, 95, 0.2)" },
  { bg: "rgba(94, 92, 230, 0.15)", border: "rgba(94, 92, 230, 0.4)", text: "#5e5ce6", glow: "rgba(94, 92, 230, 0.2)" },
  { bg: "rgba(50, 215, 75, 0.15)", border: "rgba(50, 215, 75, 0.4)", text: "#32d74b", glow: "rgba(50, 215, 75, 0.2)" },
  { bg: "rgba(255, 159, 10, 0.15)", border: "rgba(255, 159, 10, 0.4)", text: "#ff9f0a", glow: "rgba(255, 159, 10, 0.2)" },
];

function getPersonaColor(index: number) {
  return PERSONA_COLORS[index % PERSONA_COLORS.length];
}

const STATUS_STYLES: Record<string, { color: string; label: string; pulse?: boolean }> = {
  idle: { color: "#666", label: "Idle" },
  starting: { color: "#0a84ff", label: "Starting", pulse: true },
  created: { color: "#666", label: "Created" },
  preparing: { color: "#ff9f0a", label: "Generating Personas", pulse: true },
  ready: { color: "#0a84ff", label: "Ready" },
  running: { color: "#ff9f0a", label: "Running", pulse: true },
  paused: { color: "#ff9500", label: "Paused" },
  stopped: { color: "#ff9500", label: "Stopped" },
  completed: { color: "#30d158", label: "Completed" },
  failed: { color: "#ff453a", label: "Failed" },
};

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

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── SSE Hook ───────────────────────────────────────────────────────────────────

function useSimulationSSE(simulationId: string | null, enabled: boolean) {
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!simulationId || !enabled) return;

    let retries = 0;
    const maxRetries = 5;
    const baseDelay = 1000;
    let currentEs: EventSource | null = null;
    let cancelled = false;

    const EVENT_TYPES = [
      "simulation:status", "simulation:persona-generated",
      "simulation:round-start", "simulation:persona-response",
      "simulation:persona-error", "simulation:round-synthesis",
      "simulation:round-complete", "simulation:final-synthesis",
      "simulation:complete", "simulation:error",
    ];

    function connect() {
      if (cancelled) return;
      const es = new EventSource(`/api/simulations/${simulationId}/stream`);
      currentEs = es;

      es.onopen = () => {
        retries = 0;
        setConnected(true);
        setReconnecting(false);
      };

      es.onerror = () => {
        es.close();
        currentEs = null;
        setConnected(false);
        if (!cancelled && retries < maxRetries) {
          setReconnecting(true);
          const delay = baseDelay * Math.pow(2, retries);
          retries++;
          setTimeout(connect, delay);
        } else {
          setReconnecting(false);
        }
      };

      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (e) => {
          try {
            setEvents((prev) => [...prev, JSON.parse((e as MessageEvent).data) as SimulationEvent]);
          } catch { /* skip */ }
        });
      }
    }

    connect();

    return () => {
      cancelled = true;
      currentEs?.close();
    };
  }, [simulationId, enabled]);

  return { events, connected, reconnecting };
}

// ─── Sub-Components ─────────────────────────────────────────────────────────────

function ConfidenceBar({ value, color, animate = false }: { value: number; color?: string; animate?: boolean }) {
  const pct = Math.round(value * 100);
  const barColor = color ?? (value < 0.3 ? "#ff453a" : value < 0.7 ? "#ff9f0a" : "#30d158");

  return (
    <div className="swarm-confidence-track">
      <div
        className={`swarm-confidence-fill${animate ? " animate" : ""}`}
        style={{ width: `${pct}%`, background: barColor }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.created;
  return (
    <span className="swarm-status-badge" style={{ color: s.color, borderColor: s.color }}>
      {s.pulse && <span className="swarm-pulse" style={{ background: s.color }} />}
      {s.label}
    </span>
  );
}

function PersonaAvatar({ persona, index, size = 36 }: { persona: SimulationPersona; index: number; size?: number }) {
  const c = getPersonaColor(index);
  const initials = persona.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div
      className="swarm-persona-avatar"
      style={{
        width: size, height: size,
        background: c.bg, borderColor: c.border, color: c.text,
        fontSize: size * 0.35,
        boxShadow: `0 0 12px ${c.glow}`,
      }}
      title={`${persona.name} (${persona.role})`}
    >
      {initials}
    </div>
  );
}

function PersonaNode({
  persona,
  index,
  action,
  priorAction,
  isActive,
  onClick,
}: {
  persona: SimulationPersona;
  index: number;
  action?: SimulationAction;
  priorAction?: SimulationAction;
  isActive: boolean;
  onClick: () => void;
}) {
  const c = getPersonaColor(index);
  const conf = action?.confidence ?? 0;
  const delta = priorAction ? conf - priorAction.confidence : null;

  return (
    <button
      className={`swarm-persona-node${isActive ? " active" : ""}${action?.noResponse ? " no-response" : ""}`}
      style={{ borderColor: isActive ? c.border : "var(--border)", background: isActive ? c.bg : "transparent" }}
      onClick={onClick}
      type="button"
    >
      <PersonaAvatar persona={persona} index={index} size={32} />
      <div className="swarm-persona-info">
        <span className="swarm-persona-name" style={{ color: c.text }}>{persona.name}</span>
        <span className="swarm-persona-role">{persona.role}</span>
        {action?.modelId && (
          <span className="swarm-persona-model">{action.modelId}</span>
        )}
      </div>
      {action && (
        <div className="swarm-persona-conf">
          <span className="swarm-conf-value">{(conf * 100).toFixed(0)}%</span>
          {delta !== null && delta !== 0 && (
            <span className={`swarm-conf-delta ${delta > 0 ? "up" : "down"}`}>
              {delta > 0 ? "\u2191" : "\u2193"}{Math.abs(delta * 100).toFixed(0)}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function ProbabilityChart({ probabilities }: { probabilities: Record<string, number> }) {
  const sorted = useMemo(
    () => Object.entries(probabilities).sort(([, a], [, b]) => b - a),
    [probabilities],
  );
  const max = sorted.length > 0 ? sorted[0][1] : 1;

  return (
    <div className="swarm-prob-chart">
      {sorted.map(([outcome, prob]) => (
        <div key={outcome} className="swarm-prob-row">
          <div className="swarm-prob-label">{outcome}</div>
          <div className="swarm-prob-bar-track">
            <div
              className="swarm-prob-bar-fill"
              style={{
                width: `${(prob / Math.max(max, 0.01)) * 100}%`,
                background: prob >= 0.5
                  ? `linear-gradient(90deg, rgba(48, 209, 88, 0.6), rgba(48, 209, 88, 0.9))`
                  : prob >= 0.25
                    ? `linear-gradient(90deg, rgba(255, 159, 10, 0.6), rgba(255, 159, 10, 0.9))`
                    : `linear-gradient(90deg, rgba(255, 69, 58, 0.5), rgba(255, 69, 58, 0.8))`,
              }}
            />
          </div>
          <span className="swarm-prob-pct">{(prob * 100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

function ConsensusGauge({ actions }: { actions: SimulationAction[] }) {
  const valid = actions.filter((a) => !a.noResponse);
  if (valid.length < 2) return null;

  const confidences = valid.map((a) => a.confidence);
  const mean = confidences.reduce((s, c) => s + c, 0) / confidences.length;
  const variance = confidences.reduce((s, c) => s + (c - mean) ** 2, 0) / confidences.length;
  const stdDev = Math.sqrt(variance);

  const consensus = Math.max(0, 1 - stdDev * 3); // 0 = total disagreement, 1 = perfect consensus
  const label = consensus > 0.8 ? "Strong consensus" : consensus > 0.5 ? "Moderate agreement" : consensus > 0.25 ? "Mixed views" : "Contested";
  const color = consensus > 0.5 ? "#30d158" : consensus > 0.25 ? "#ff9f0a" : "#ff453a";

  return (
    <div className="swarm-consensus">
      <div className="swarm-consensus-label">
        <span>{label}</span>
        <span style={{ color }}>{(consensus * 100).toFixed(0)}%</span>
      </div>
      <ConfidenceBar value={consensus} color={color} />
    </div>
  );
}

function RoundTimeline({
  rounds,
  currentRound,
  totalRounds,
  activeRound,
  onSelectRound,
}: {
  rounds: SimulationRound[];
  currentRound: number;
  totalRounds: number;
  activeRound: number;
  onSelectRound: (r: number) => void;
}) {
  return (
    <div className="swarm-timeline">
      {Array.from({ length: totalRounds }, (_, i) => i + 1).map((r) => {
        const completed = r <= rounds.length;
        const active = r === activeRound;
        const running = r === currentRound && !completed;

        return (
          <button
            key={r}
            type="button"
            className={`swarm-timeline-node${active ? " active" : ""}${completed ? " completed" : ""}${running ? " running" : ""}`}
            onClick={() => completed && onSelectRound(r)}
            disabled={!completed}
          >
            <span className="swarm-timeline-dot">
              {completed ? "\u2713" : running ? "\u25CF" : r}
            </span>
            <span className="swarm-timeline-label">R{r}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Detail Panels ──────────────────────────────────────────────────────────────

function PersonaDetail({ persona, index, actions }: { persona: SimulationPersona; index: number; actions: SimulationAction[] }) {
  const c = getPersonaColor(index);
  const personaActions = actions.filter((a) => a.personaId === persona.id);

  return (
    <div className="swarm-detail-panel" style={{ borderColor: c.border }}>
      <div className="swarm-detail-header">
        <PersonaAvatar persona={persona} index={index} size={44} />
        <div>
          <h4 style={{ color: c.text }}>{persona.name}</h4>
          <span className="swarm-detail-role">{persona.role}</span>
        </div>
      </div>

      {persona.perspective && (
        <p className="swarm-detail-perspective">{persona.perspective}</p>
      )}

      {persona.biases && persona.biases.length > 0 && (
        <div className="swarm-detail-tags">
          {persona.biases.map((b, i) => (
            <span key={i} className="swarm-tag" style={{ borderColor: c.border, color: c.text }}>{b}</span>
          ))}
        </div>
      )}

      {personaActions.length > 0 && (
        <div className="swarm-detail-history">
          <h5>Confidence trajectory</h5>
          <div className="swarm-spark-row">
            {personaActions.map((a) => (
              <div key={a.round} className="swarm-spark-point" style={{ height: `${a.confidence * 100}%`, background: c.text }} title={`R${a.round}: ${(a.confidence * 100).toFixed(0)}%`} />
            ))}
          </div>
          {personaActions.map((a) => (
            <div key={a.round} className="swarm-detail-round-entry">
              <div className="swarm-detail-round-head">
                <span>Round {a.round}{a.modelId ? ` \u00B7 ${a.modelId}` : ""}</span>
                <span style={{ color: c.text }}>{(a.confidence * 100).toFixed(0)}%</span>
              </div>
              <p>{a.content.slice(0, 400)}{a.content.length > 400 ? "..." : ""}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SynthesisPanel({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 300 && !expanded ? text.slice(0, 297) + "..." : text;

  return (
    <div className="swarm-synthesis-panel">
      <div className="swarm-synthesis-head">
        <span>{label}</span>
      </div>
      <div className="swarm-synthesis-body">
        <p>{preview}</p>
        {text.length > 300 && (
          <button type="button" className="swarm-expand-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Visualizer ────────────────────────────────────────────────────────────

export function SimulationCard({
  simulationId,
  initialState,
  enableSSE = false,
  compact = false,
}: {
  simulationId: string;
  initialState?: SimulationState;
  enableSSE?: boolean;
  compact?: boolean;
}) {
  const [state, setState] = useState<SimulationState | null>(initialState ?? null);
  const [runState, setRunState] = useState<SimulationRunState | null>(null);
  const [recentActions, setRecentActions] = useState<SimulationActionLogEntry[]>([]);
  const [loading, setLoading] = useState(!initialState);
  const [activeRound, setActiveRound] = useState(0);
  const [selectedPersona, setSelectedPersona] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"start" | "stop" | null>(null);
  const [showRunDetail, setShowRunDetail] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  const displayStatus = runState?.runnerStatus ?? state?.status ?? "created";
  const isLive = displayStatus === "starting" || displayStatus === "running" || displayStatus === "preparing";
  const { events, reconnecting } = useSimulationSSE(simulationId, enableSSE && isLive);

  // Fetch state
  const fetchState = useCallback(async () => {
    try {
      const response = await fetch(`/api/simulations/${simulationId}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as SimulationState;
      setState(data);
      if (activeRound === 0 && data.rounds.length > 0) {
        setActiveRound(data.rounds.length);
      }
    } finally {
      setLoading(false);
    }
  }, [simulationId, activeRound]);

  const fetchRunStatus = useCallback(async (includeDetail = false) => {
    try {
      if (includeDetail) {
        const response = await fetch(`/api/simulations/${simulationId}/run-status/detail`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          runState?: SimulationRunState;
          recentActions?: SimulationActionLogEntry[];
        };
        if (payload.runState) setRunState(payload.runState);
        setRecentActions(payload.recentActions ?? []);
      } else {
        const response = await fetch(`/api/simulations/${simulationId}/run-status`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as SimulationRunState;
        setRunState(payload);
      }
    } catch {
      // best effort polling
    }
  }, [simulationId]);

  useEffect(() => {
    if (!initialState) {
      void fetchState();
    }
    void fetchRunStatus(false);
  }, [fetchRunStatus, fetchState, initialState]);

  // Refresh on SSE events
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (["simulation:complete", "simulation:error", "simulation:round-complete", "simulation:persona-generated"].includes(last.type)) {
      void fetchState();
      void fetchRunStatus(showRunDetail);
    }
  }, [events, fetchRunStatus, fetchState, showRunDetail]);

  useEffect(() => {
    const intervalMs = isLive ? 2500 : 10000;
    const timer = setInterval(() => {
      void fetchRunStatus(showRunDetail);
      if (!enableSSE || !isLive) {
        void fetchState();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enableSSE, fetchRunStatus, fetchState, isLive, showRunDetail]);

  // Auto-advance round view
  useEffect(() => {
    if (state && state.rounds.length > 0 && activeRound < state.rounds.length) {
      setActiveRound(state.rounds.length);
    }
  }, [state?.rounds.length]);

  const handleRunAction = useCallback(async (action: "start" | "stop") => {
    setBusyAction(action);
    setControlError(null);
    try {
      const endpoint = action === "start" ? "run" : "stop";
      const response = await fetch(`/api/simulations/${simulationId}/${endpoint}`, {
        method: "POST",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Request failed." }));
        throw new Error(
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error ?? "Request failed.")
            : "Request failed.",
        );
      }
      await Promise.all([fetchState(), fetchRunStatus(true)]);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }, [fetchRunStatus, fetchState, simulationId]);

  if (loading) {
    return (
      <div className="swarm-card swarm-loading">
        <div className="swarm-loading-pulse" />
        <span>Loading simulation...</span>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="swarm-card swarm-error-card">
        Simulation {simulationId} not found
      </div>
    );
  }

  const currentRoundData = state.rounds[activeRound - 1] ?? null;
  const priorRoundData = activeRound > 1 ? state.rounds[activeRound - 2] : null;
  const allActions = state.rounds.flatMap((r) => r.actions);
  const selectedPersonaObj = state.personas.find((p) => p.id === selectedPersona);
  const selectedPersonaIndex = state.personas.findIndex((p) => p.id === selectedPersona);

  const domainIcon = DOMAIN_ICONS[state.config.domain] ?? DOMAIN_ICONS.other;
  const displayCurrentRound = Math.max(state.currentRound, runState?.currentRound ?? 0);
  const displayTotalRounds = runState?.totalRounds ?? state.config.roundCount;
  const actionsLogged = runState?.actionsCount ?? allActions.length;
  const canStart = !isLive && displayStatus !== "completed" && state.status !== "completed";
  const canStop = isLive;
  const displayError = controlError ?? runState?.error ?? state.error;

  // Compact mode for inline chat rendering
  if (compact) {
    const avgConf = allActions.length > 0
      ? allActions.reduce((s, a) => s + a.confidence, 0) / allActions.length
      : null;

    return (
      <div className={`swarm-card swarm-compact${isLive ? " swarm-live" : ""}`}>
        <div className="swarm-compact-top">
          <div className="swarm-compact-header">
            <span className="swarm-compact-icon">{domainIcon}</span>
            <div className="swarm-compact-header-text">
              <span className="swarm-compact-title">{state.config.title}</span>
              <span className="swarm-compact-scenario">{state.config.scenario}</span>
            </div>
          </div>
          <StatusBadge status={displayStatus} />
        </div>

        {/* Persona strip + stats */}
        <div className="swarm-compact-stats">
          {state.personas.length > 0 && (
            <div className="swarm-compact-personas">
              {state.personas.slice(0, 8).map((p, i) => (
                <PersonaAvatar key={p.id} persona={p} index={i} size={22} />
              ))}
              {state.personas.length > 8 && (
                <span className="swarm-compact-more">+{state.personas.length - 8}</span>
              )}
            </div>
          )}
          <div className="swarm-compact-chips">
            <span className="swarm-compact-chip">
              {displayCurrentRound}/{displayTotalRounds} rounds
            </span>
            {avgConf !== null && (
              <span className="swarm-compact-chip">
                avg {(avgConf * 100).toFixed(0)}%
              </span>
            )}
            <span className="swarm-compact-chip">{actionsLogged} actions</span>
            <span className="swarm-compact-chip">{state.config.domain}</span>
          </div>
        </div>

        {(canStart || canStop || showRunDetail || recentActions.length > 0) && (
          <div className="swarm-compact-controls">
            {canStart && (
              <button
                type="button"
                className="swarm-control-btn"
                disabled={busyAction !== null}
                onClick={() => void handleRunAction("start")}
              >
                {busyAction === "start" ? "Starting..." : "Start"}
              </button>
            )}
            {canStop && (
              <button
                type="button"
                className="swarm-control-btn danger"
                disabled={busyAction !== null}
                onClick={() => void handleRunAction("stop")}
              >
                {busyAction === "stop" ? "Stopping..." : "Stop"}
              </button>
            )}
            <button
              type="button"
              className="swarm-control-btn ghost"
              onClick={() => {
                const next = !showRunDetail;
                setShowRunDetail(next);
                if (next) void fetchRunStatus(true);
              }}
            >
              {showRunDetail ? "Hide Log" : "Run Log"}
            </button>
          </div>
        )}

        {showRunDetail && (
          <div className="swarm-run-detail compact">
            <div className="swarm-run-meta">
              <span>Status: {displayStatus}</span>
              <span>Actions: {actionsLogged}</span>
            </div>
            {recentActions.length === 0 ? (
              <div className="swarm-run-empty">No action logs yet.</div>
            ) : (
              recentActions.slice(0, 3).map((entry, index) => (
                <div key={`${entry.timestamp}-${index}`} className="swarm-run-action-row">
                  <span className="swarm-run-action-head">
                    R{entry.round} {entry.personaName} {(entry.confidence * 100).toFixed(0)}%
                  </span>
                  <span className="swarm-run-action-text">{entry.contentPreview}</span>
                </div>
              ))
            )}
          </div>
        )}

        {reconnecting && <div className="swarm-reconnecting">Reconnecting...</div>}
        {displayError && <div className="swarm-error">{displayError}</div>}

        {/* Probability bars inline */}
        {state.probabilities && (
          <div className="swarm-compact-probs">
            {Object.entries(state.probabilities)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 3)
              .map(([outcome, prob]) => (
                <div key={outcome} className="swarm-compact-prob-row">
                  <span className="swarm-compact-prob-label">{outcome}</span>
                  <div className="swarm-compact-prob-track">
                    <div
                      className="swarm-compact-prob-fill"
                      style={{
                        width: `${prob * 100}%`,
                        background: prob >= 0.5 ? "#30d158" : prob >= 0.25 ? "#ff9f0a" : "#ff453a",
                      }}
                    />
                  </div>
                  <span className="swarm-compact-prob-pct">{(prob * 100).toFixed(0)}%</span>
                </div>
              ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`swarm-card${isLive ? " swarm-live" : ""}`}>
      {/* ── Header ── */}
      <div className="swarm-header">
        <div className="swarm-header-top">
          <div className="swarm-header-title">
            <span className="swarm-domain-icon">{domainIcon}</span>
            <h3>{state.config.title}</h3>
          </div>
          <StatusBadge status={displayStatus} />
        </div>
        <p className="swarm-scenario">{state.config.scenario}</p>
        <div className="swarm-header-meta">
          <span>{state.personas.length} personas</span>
          <span className="swarm-meta-sep">/</span>
          <span>{displayCurrentRound}/{displayTotalRounds} rounds</span>
          <span className="swarm-meta-sep">/</span>
          <span>{actionsLogged} actions</span>
          <span className="swarm-meta-sep">/</span>
          <span>{state.config.domain}</span>
        </div>

        <div className="swarm-controls">
          {canStart && (
            <button
              type="button"
              className="swarm-control-btn"
              disabled={busyAction !== null}
              onClick={() => void handleRunAction("start")}
            >
              {busyAction === "start" ? "Starting..." : "Start Run"}
            </button>
          )}
          {canStop && (
            <button
              type="button"
              className="swarm-control-btn danger"
              disabled={busyAction !== null}
              onClick={() => void handleRunAction("stop")}
            >
              {busyAction === "stop" ? "Stopping..." : "Stop Run"}
            </button>
          )}
          <button
            type="button"
            className="swarm-control-btn ghost"
            onClick={() => {
              const next = !showRunDetail;
              setShowRunDetail(next);
              if (next) void fetchRunStatus(true);
            }}
          >
            {showRunDetail ? "Hide Run Log" : "Show Run Log"}
          </button>
          <button
            type="button"
            className="swarm-control-btn ghost"
            onClick={() => {
              void Promise.all([fetchState(), fetchRunStatus(showRunDetail)]);
            }}
          >
            Refresh
          </button>
        </div>

        {showRunDetail && (
          <div className="swarm-run-detail">
            <div className="swarm-run-meta">
              <span>Runner: {displayStatus}</span>
              <span>Actions logged: {actionsLogged}</span>
              {runState?.startedAt && <span>Started: {formatRelativeTime(runState.startedAt)}</span>}
              {runState?.updatedAt && <span>Updated: {formatRelativeTime(runState.updatedAt)}</span>}
            </div>
            {recentActions.length === 0 ? (
              <div className="swarm-run-empty">No action logs yet.</div>
            ) : (
              recentActions.slice(0, 8).map((entry, index) => (
                <div key={`${entry.timestamp}-${index}`} className="swarm-run-action-row">
                  <span className="swarm-run-action-head">
                    R{entry.round} {entry.personaName} {(entry.confidence * 100).toFixed(0)}% {formatRelativeTime(entry.timestamp)}
                  </span>
                  <span className="swarm-run-action-text">{entry.contentPreview}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Persona Swarm Grid ── */}
      {state.personas.length > 0 && (
        <div className="swarm-section">
          <div className="swarm-section-head">
            <h4>Swarm Agents</h4>
            {currentRoundData && <ConsensusGauge actions={currentRoundData.actions} />}
          </div>
          <div className="swarm-persona-grid">
            {state.personas.map((p, i) => {
              const action = currentRoundData?.actions.find((a) => a.personaId === p.id);
              const priorAction = priorRoundData?.actions.find((a) => a.personaId === p.id);
              return (
                <PersonaNode
                  key={p.id}
                  persona={p}
                  index={i}
                  action={action}
                  priorAction={priorAction}
                  isActive={selectedPersona === p.id}
                  onClick={() => setSelectedPersona(selectedPersona === p.id ? null : p.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* ── Round Timeline ── */}
      {state.config.roundCount > 0 && (
        <div className="swarm-section">
          <RoundTimeline
            rounds={state.rounds}
            currentRound={displayCurrentRound}
            totalRounds={displayTotalRounds}
            activeRound={activeRound}
            onSelectRound={setActiveRound}
          />
        </div>
      )}

      {/* ── Selected Round Detail ── */}
      {currentRoundData && (
        <div className="swarm-section">
          <div className="swarm-section-head">
            <h4>Round {activeRound} Results</h4>
            <span className="swarm-section-meta">
              {currentRoundData.actions.length} responses
              {currentRoundData.parseFailures ? ` \u00B7 ${currentRoundData.parseFailures} fallback` : ""}
            </span>
          </div>

          {/* Confidence heatmap */}
          <div className="swarm-heatmap">
            {currentRoundData.actions.map((a) => {
              const pIdx = state.personas.findIndex((p) => p.id === a.personaId);
              const c = getPersonaColor(pIdx);
              return (
                <div
                  key={a.personaId}
                  className="swarm-heat-cell"
                  style={{
                    background: c.bg,
                    borderColor: selectedPersona === a.personaId ? c.border : "transparent",
                    opacity: a.noResponse ? 0.3 : 0.4 + a.confidence * 0.6,
                  }}
                  onClick={() => setSelectedPersona(selectedPersona === a.personaId ? null : a.personaId)}
                  title={`${a.personaName}: ${(a.confidence * 100).toFixed(0)}%`}
                >
                  <span style={{ color: c.text }}>{(a.confidence * 100).toFixed(0)}</span>
                </div>
              );
            })}
          </div>

          {currentRoundData.synthesis && (
            <SynthesisPanel text={currentRoundData.synthesis} label={`Round ${activeRound} Synthesis`} />
          )}
        </div>
      )}

      {/* ── Selected Persona Detail ── */}
      {selectedPersonaObj && (
        <div className="swarm-section">
          <PersonaDetail
            persona={selectedPersonaObj}
            index={selectedPersonaIndex}
            actions={allActions}
          />
        </div>
      )}

      {/* ── Probabilities ── */}
      {state.probabilities && (
        <div className="swarm-section">
          <div className="swarm-section-head">
            <h4>Outcome Probabilities</h4>
          </div>
          <ProbabilityChart probabilities={state.probabilities} />
        </div>
      )}

      {/* ── Final Synthesis ── */}
      {state.finalSynthesis && (
        <div className="swarm-section">
          <SynthesisPanel text={state.finalSynthesis} label="Final Synthesis" />
        </div>
      )}

      {/* ── Reconnecting ── */}
      {reconnecting && (
        <div className="swarm-reconnecting">Reconnecting...</div>
      )}

      {/* ── Error ── */}
      {displayError && (
        <div className="swarm-error">
          {displayError}
        </div>
      )}
    </div>
  );
}

// ─── Chat Message Integration Helpers ───────────────────────────────────────────

export function extractSimulationIdFromToolResult(toolResult: string): string | null {
  const labeled = toolResult.match(/(?:Simulation (?:created|started|completed|failed|paused):\s*)(sim_[a-zA-Z0-9_-]+)/i);
  if (labeled) return labeled[1];

  const generic = toolResult.match(/\b(sim_[a-zA-Z0-9_-]{4,})\b/);
  return generic ? generic[1] : null;
}

export function isSimulationToolCall(toolName: string): boolean {
  return toolName === "swarm_simulate" || toolName === "swarm_report" || toolName === "swarm_interview";
}
