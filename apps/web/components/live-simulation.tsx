"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import type { SimulationStreamEvent } from "@ember/core/client";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface PersonaInfo {
  id: string;
  name: string;
  role: string;
  perspective: string;
  background: string;
}

interface PersonaResponse {
  round: number;
  content: string;
  confidence: number;
  providerId?: string;
  modelId?: string;
}

interface RoundData {
  round: number;
  totalRounds: number;
  responses: PersonaResponse[];
  synthesis: string | null;
  complete: boolean;
}

interface SimState {
  simulationId: string | null;
  title: string;
  scenario: string;
  domain: string;
  personaCount: number;
  roundCount: number;
  personas: PersonaInfo[];
  rounds: RoundData[];
  currentRound: number;
  finalSynthesis: string | null;
  probabilities: Record<string, number> | null;
  duration: number | null;
  phase: "starting" | "generating-personas" | "running" | "synthesizing" | "complete" | "error";
  error: string | null;
}

const DOMAIN_COLORS: Record<string, string> = {
  finance: "#0a84ff",
  technology: "#5e5ce6",
  geopolitics: "#ff6b35",
  social: "#ff375f",
  business: "#30d158",
  science: "#64d2ff",
  healthcare: "#ff453a",
  environment: "#32d74b",
  other: "#ac8e68",
};

const PERSONA_AVATARS = [
  "#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4",
  "#feca57", "#ff9ff3", "#54a0ff", "#5f27cd",
  "#00d2d3", "#ff6348", "#7bed9f", "#a29bfe",
];

function getInitials(name: string): string {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function ConfidenceMeter({ value, size = 32 }: { value: number; size?: number }) {
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - value);
  const color = value >= 0.7 ? "#30d158" : value >= 0.4 ? "#ff9f0a" : "#ff453a";

  return (
    <svg width={size} height={size} className="confidence-meter">
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="var(--border)" strokeWidth="2"
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={color} strokeWidth="2.5"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text
        x={size / 2} y={size / 2}
        textAnchor="middle" dominantBaseline="central"
        fill="var(--text)" fontSize={size * 0.3} fontWeight="600"
      >
        {Math.round(value * 100)}
      </text>
    </svg>
  );
}

function ProbabilityBar({ label, value, delay }: { label: string; value: number; delay: number }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  const pct = (value * 100).toFixed(1);
  return (
    <div className="sim-live-prob-row">
      <span className="sim-live-prob-label">{label}</span>
      <div className="sim-live-prob-track">
        <div
          className="sim-live-prob-fill"
          style={{ width: animated ? `${value * 100}%` : "0%", transition: "width 0.8s ease" }}
        />
      </div>
      <span className="sim-live-prob-pct">{pct}%</span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export function LiveSimulation({ events }: { events: SimulationStreamEvent[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedPersona, setExpandedPersona] = useState<string | null>(null);
  const [activeRound, setActiveRound] = useState<number>(1);

  // Build simulation state from accumulated events
  const state = useMemo<SimState>(() => {
    const s: SimState = {
      simulationId: null,
      title: "",
      scenario: "",
      domain: "other",
      personaCount: 0,
      roundCount: 0,
      personas: [],
      rounds: [],
      currentRound: 0,
      finalSynthesis: null,
      probabilities: null,
      duration: null,
      phase: "starting",
      error: null,
    };

    for (const e of events) {
      switch (e.type) {
        case "sim:start":
          s.simulationId = e.simulationId;
          s.title = e.title;
          s.scenario = e.scenario;
          s.domain = e.domain;
          s.personaCount = e.personaCount;
          s.roundCount = e.roundCount;
          s.phase = "generating-personas";
          break;
        case "sim:persona":
          if (!s.personas.find(p => p.id === e.persona.id)) {
            s.personas.push(e.persona);
          }
          s.phase = "generating-personas";
          break;
        case "sim:round-start": {
          s.currentRound = e.round;
          s.phase = "running";
          if (!s.rounds.find(r => r.round === e.round)) {
            s.rounds.push({ round: e.round, totalRounds: e.totalRounds, responses: [], synthesis: null, complete: false });
          }
          break;
        }
        case "sim:persona-response": {
          const round = s.rounds.find(r => r.round === e.round);
          if (round) {
            const existing = round.responses.find(r => r.round === e.round && r.content === e.content);
            if (!existing) {
              round.responses.push({
                round: e.round,
                content: e.content,
                confidence: e.confidence,
                providerId: e.providerId,
                modelId: e.modelId,
              });
            }
          }
          break;
        }
        case "sim:round-synthesis": {
          const round = s.rounds.find(r => r.round === e.round);
          if (round) round.synthesis = e.synthesis;
          s.phase = "running";
          break;
        }
        case "sim:round-complete": {
          const round = s.rounds.find(r => r.round === e.round);
          if (round) round.complete = true;
          break;
        }
        case "sim:final":
          s.finalSynthesis = e.synthesis;
          s.probabilities = e.probabilities;
          s.phase = "synthesizing";
          break;
        case "sim:complete":
          s.duration = e.duration;
          s.phase = "complete";
          break;
        case "sim:error":
          s.error = e.error;
          s.phase = "error";
          break;
      }
    }

    return s;
  }, [events]);

  // Auto-advance active round as rounds complete
  useEffect(() => {
    if (state.currentRound > 0) {
      setActiveRound(state.currentRound);
    }
  }, [state.currentRound]);

  if (!state.simulationId) return null;

  const domainColor = DOMAIN_COLORS[state.domain] ?? DOMAIN_COLORS.other;
  const currentRoundData = state.rounds.find(r => r.round === activeRound);
  const isLive = state.phase !== "complete" && state.phase !== "error";

  return (
    <div ref={containerRef} className="sim-live" data-phase={state.phase}>
      {/* Header */}
      <div className="sim-live-header" style={{ borderLeftColor: domainColor }}>
        <div className="sim-live-header-top">
          <div className="sim-live-title-area">
            {isLive && <span className="sim-live-pulse" style={{ background: domainColor }} />}
            <h3 className="sim-live-title">{state.title || "Simulation"}</h3>
          </div>
          <div className="sim-live-badges">
            <span className="sim-live-badge" style={{ color: domainColor, borderColor: domainColor }}>
              {state.domain}
            </span>
            <span className={`sim-live-phase ${state.phase}`}>
              {state.phase === "starting" && "Initializing..."}
              {state.phase === "generating-personas" && "Generating personas..."}
              {state.phase === "running" && `Round ${state.currentRound}/${state.roundCount}`}
              {state.phase === "synthesizing" && "Final synthesis..."}
              {state.phase === "complete" && "Complete"}
              {state.phase === "error" && "Error"}
            </span>
          </div>
        </div>
        <p className="sim-live-scenario">{state.scenario}</p>
      </div>

      {/* Personas Strip */}
      {state.personas.length > 0 && (
        <div className="sim-live-personas">
          <div className="sim-live-personas-label">Personas</div>
          <div className="sim-live-personas-grid">
            {state.personas.map((p, i) => {
              const color = PERSONA_AVATARS[i % PERSONA_AVATARS.length];
              const isExpanded = expandedPersona === p.id;
              const latestResponse = currentRoundData?.responses.find(
                (r, idx) => {
                  // Match by index since we don't have personaId in the response
                  const persona = state.personas[idx];
                  return persona?.id === p.id;
                }
              );

              return (
                <button
                  key={p.id}
                  type="button"
                  className={`sim-live-persona${isExpanded ? " expanded" : ""}`}
                  onClick={() => setExpandedPersona(isExpanded ? null : p.id)}
                  style={{ "--persona-color": color } as React.CSSProperties}
                >
                  <div className="sim-live-persona-avatar" style={{ background: color }}>
                    {getInitials(p.name)}
                  </div>
                  <div className="sim-live-persona-info">
                    <span className="sim-live-persona-name">{p.name}</span>
                    <span className="sim-live-persona-role">{p.role}</span>
                  </div>
                  {isExpanded && (
                    <div className="sim-live-persona-detail" onClick={(e) => e.stopPropagation()}>
                      <p className="sim-live-persona-bg">{p.background}</p>
                      <p className="sim-live-persona-persp">{p.perspective}</p>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Round Tabs */}
      {state.rounds.length > 0 && (
        <div className="sim-live-rounds">
          <div className="sim-live-round-tabs">
            {state.rounds.map(r => (
              <button
                key={r.round}
                type="button"
                className={`sim-live-round-tab${activeRound === r.round ? " active" : ""}${!r.complete && state.currentRound === r.round ? " live" : ""}`}
                onClick={() => setActiveRound(r.round)}
              >
                <span>R{r.round}</span>
                {!r.complete && state.currentRound === r.round && (
                  <span className="sim-live-round-dot" />
                )}
              </button>
            ))}
            {state.phase === "complete" && state.finalSynthesis && (
              <button
                type="button"
                className={`sim-live-round-tab final${activeRound === 0 ? " active" : ""}`}
                onClick={() => setActiveRound(0)}
              >
                Final
              </button>
            )}
          </div>
        </div>
      )}

      {/* Active Round Content */}
      {activeRound === 0 && state.finalSynthesis ? (
        <div className="sim-live-final">
          {state.probabilities && Object.keys(state.probabilities).length > 0 && (
            <div className="sim-live-probs">
              <h4 className="sim-live-section-title">Probability Assessment</h4>
              {Object.entries(state.probabilities)
                .sort(([, a], [, b]) => b - a)
                .map(([label, value], i) => (
                  <ProbabilityBar key={label} label={label} value={value} delay={i * 150} />
                ))}
            </div>
          )}
          <div className="sim-live-synthesis-text">
            <h4 className="sim-live-section-title">Final Synthesis</h4>
            <div className="sim-live-synthesis-content">{state.finalSynthesis}</div>
          </div>
          {state.duration !== null && (
            <div className="sim-live-duration">
              Completed in {(state.duration / 1000).toFixed(1)}s
            </div>
          )}
        </div>
      ) : currentRoundData ? (
        <div className="sim-live-round-content">
          {/* Responses as speech bubbles */}
          <div className="sim-live-responses">
            {currentRoundData.responses.map((resp, i) => {
              const persona = state.personas[i];
              const color = PERSONA_AVATARS[i % PERSONA_AVATARS.length];
              return (
                <div key={`${resp.round}-${i}`} className="sim-live-speech" style={{ animationDelay: `${i * 0.1}s` }}>
                  <div className="sim-live-speech-avatar" style={{ background: color }}>
                    {persona ? getInitials(persona.name) : "?"}
                  </div>
                  <div className="sim-live-speech-bubble">
                    <div className="sim-live-speech-header">
                      <span className="sim-live-speech-name">{persona?.name ?? `Persona ${i + 1}`}</span>
                      <ConfidenceMeter value={resp.confidence} size={28} />
                    </div>
                    <p className="sim-live-speech-text">{resp.content}</p>
                    {resp.modelId && (
                      <span className="sim-live-speech-model">{resp.modelId}</span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Waiting indicator for current round */}
            {!currentRoundData.complete && state.phase === "running" && (
              <div className="sim-live-waiting">
                <div className="sim-live-waiting-dots">
                  <span /><span /><span />
                </div>
                <span>
                  {currentRoundData.responses.length} of {state.personas.length} responses...
                </span>
              </div>
            )}
          </div>

          {/* Round Synthesis */}
          {currentRoundData.synthesis && (
            <div className="sim-live-round-synthesis">
              <h4 className="sim-live-section-title">Round {currentRoundData.round} Synthesis</h4>
              <div className="sim-live-synthesis-content">{currentRoundData.synthesis}</div>
            </div>
          )}
        </div>
      ) : state.phase === "generating-personas" ? (
        <div className="sim-live-generating">
          <div className="sim-live-generating-animation">
            {Array.from({ length: state.personaCount }).map((_, i) => (
              <div
                key={i}
                className={`sim-live-generating-dot${i < state.personas.length ? " filled" : ""}`}
                style={{
                  animationDelay: `${i * 0.15}s`,
                  background: i < state.personas.length ? PERSONA_AVATARS[i % PERSONA_AVATARS.length] : undefined,
                }}
              />
            ))}
          </div>
          <span className="sim-live-generating-text">
            Generating {state.personaCount} diverse personas...
          </span>
        </div>
      ) : null}

      {/* Error State */}
      {state.error && (
        <div className="sim-live-error">
          <span className="sim-live-error-icon">!</span>
          {state.error}
        </div>
      )}
    </div>
  );
}
