import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Role } from "@ember/core";
import { getDataRoot } from "@ember/core";
import { CONFIG } from "./config.js";

const MAX_FAILOVER_EVENT_HISTORY = CONFIG.failover.maxEventHistory;
const CIRCUIT_BREAKER_THRESHOLD = CONFIG.failover.circuitBreakerThreshold;
const CIRCUIT_BREAKER_RESET_MS = CONFIG.failover.circuitBreakerResetMs;

export type FailoverCause =
  | "timeout"
  | "rate-limit"
  | "auth"
  | "network"
  | "provider-status"
  | "model-error"
  | "unknown";

export interface FailoverEvent {
  id: string;
  createdAt: string;
  role: Role;
  fromProviderId: string | null;
  fromModelId: string | null;
  toProviderId: string | null;
  toModelId: string | null;
  cause: FailoverCause;
  reason: string;
}

export interface FailoverMetricsSnapshot {
  totalEvents: number;
  providerSwitches: number;
  modelSwitches: number;
  byCause: Record<FailoverCause, number>;
  byRole: Record<string, number>;
  recentEvents: FailoverEvent[];
  circuitBreakers: Record<string, CircuitBreakerSnapshot>;
}

export type CircuitBreakerStatus = "closed" | "open" | "half-open";

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: CircuitBreakerStatus;
  openedAt: number;
  halfOpenProbeInFlight: boolean;
}

export interface CircuitBreakerSnapshot {
  state: CircuitBreakerStatus;
  failures: number;
  lastFailure: number | null;
  openedAt: number | null;
  retryAfterMs: number;
  halfOpenProbeInFlight: boolean;
}

export interface CircuitBreakerTransitionEvent {
  providerId: string;
  fromState: CircuitBreakerStatus;
  toState: CircuitBreakerStatus;
  failures: number;
  reason: "threshold-reached" | "cooldown-expired" | "probe-success" | "probe-failed";
  timestamp: string;
}

const failoverEvents: FailoverEvent[] = [];
const failoverCauseCounts: Record<FailoverCause, number> = {
  timeout: 0,
  "rate-limit": 0,
  auth: 0,
  network: 0,
  "provider-status": 0,
  "model-error": 0,
  unknown: 0,
};
const failoverRoleCounts = new Map<string, number>();
let providerSwitchCount = 0;
let modelSwitchCount = 0;
let totalFailoverEvents = 0;
const circuitBreakers = new Map<string, CircuitBreakerState>();
let circuitBreakerEventSink: ((event: CircuitBreakerTransitionEvent) => void) | null = null;

function createFailoverId(): string {
  return `failover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function classifyFailoverCause(message: string): FailoverCause {
  const normalized = message.toLowerCase();
  if (/timeout|timed out|deadline/i.test(normalized)) {
    return "timeout";
  }
  if (/rate limit|429|too many requests/i.test(normalized)) {
    return "rate-limit";
  }
  if (/unauthoriz|forbidden|401|403|api key|token/i.test(normalized)) {
    return "auth";
  }
  if (/provider.*(missing|needs-auth|error|unavailable|disconnected|not ready)/i.test(normalized)) {
    return "provider-status";
  }
  if (/network|socket|connect|dns|econnrefused|econnreset|enotfound|ehostunreach/i.test(normalized)) {
    return "network";
  }
  if (/model|context window|invalid request|tool loop/i.test(normalized)) {
    return "model-error";
  }
  return "unknown";
}

function emitCircuitBreakerTransition(event: CircuitBreakerTransitionEvent): void {
  try {
    circuitBreakerEventSink?.(event);
  } catch {
    // No-op: sink failures should never affect runtime.
  }
}

export function setCircuitBreakerEventSink(
  sink: ((event: CircuitBreakerTransitionEvent) => void) | null,
): void {
  circuitBreakerEventSink = sink;
}

function toSnapshot(state: CircuitBreakerState, now: number): CircuitBreakerSnapshot {
  const retryAfterMs =
    state.state === "open"
      ? Math.max(0, CIRCUIT_BREAKER_RESET_MS - (now - state.openedAt))
      : 0;
  return {
    state: state.state,
    failures: state.failures,
    lastFailure: state.lastFailure > 0 ? state.lastFailure : null,
    openedAt: state.openedAt > 0 ? state.openedAt : null,
    retryAfterMs,
    halfOpenProbeInFlight: state.halfOpenProbeInFlight,
  };
}

function transitionCircuit(
  providerId: string,
  state: CircuitBreakerState,
  toState: CircuitBreakerStatus,
  reason: CircuitBreakerTransitionEvent["reason"],
  now: number,
): void {
  const fromState = state.state;
  if (fromState === toState) {
    return;
  }
  state.state = toState;
  if (toState === "open") {
    state.openedAt = now;
    state.halfOpenProbeInFlight = false;
  }
  if (toState === "closed") {
    state.openedAt = 0;
    state.halfOpenProbeInFlight = false;
  }
  if (toState === "half-open") {
    state.halfOpenProbeInFlight = false;
  }
  emitCircuitBreakerTransition({
    providerId,
    fromState,
    toState,
    failures: state.failures,
    reason,
    timestamp: new Date(now).toISOString(),
  });
  // Persist state asynchronously after every transition (fire-and-forget).
  void persistFailoverState();
}

function getOrCreateCircuit(providerId: string): CircuitBreakerState {
  const existing = circuitBreakers.get(providerId);
  if (existing) {
    return existing;
  }
  const created: CircuitBreakerState = {
    failures: 0,
    lastFailure: 0,
    state: "closed",
    openedAt: 0,
    halfOpenProbeInFlight: false,
  };
  circuitBreakers.set(providerId, created);
  return created;
}

function resolveAvailability(
  providerId: string,
  now: number,
  allowProbe: boolean,
): boolean {
  const state = circuitBreakers.get(providerId);
  if (!state || state.state === "closed") {
    return true;
  }

  if (state.state === "open") {
    if (now - state.openedAt > CIRCUIT_BREAKER_RESET_MS) {
      if (!allowProbe) {
        return true;
      }
      transitionCircuit(providerId, state, "half-open", "cooldown-expired", now);
    } else {
      return false;
    }
  }

  if (state.state === "half-open") {
    if (state.halfOpenProbeInFlight) {
      return false;
    }
    if (allowProbe) {
      state.halfOpenProbeInFlight = true;
    }
    return true;
  }

  return true;
}

export function isProviderAvailable(providerId: string, now = Date.now()): boolean {
  return resolveAvailability(providerId, now, true);
}

export function isProviderAvailablePassive(providerId: string, now = Date.now()): boolean {
  return resolveAvailability(providerId, now, false);
}

export function recordProviderSuccess(providerId: string, now = Date.now()): void {
  const state = circuitBreakers.get(providerId);
  if (!state) {
    return;
  }
  state.failures = 0;
  const wasNonClosed = state.state !== "closed";
  transitionCircuit(providerId, state, "closed", "probe-success", now);
  if (!wasNonClosed) {
    state.halfOpenProbeInFlight = false;
  }
}

export function recordProviderFailure(providerId: string, now = Date.now()): void {
  const state = getOrCreateCircuit(providerId);
  state.failures += 1;
  state.lastFailure = now;

  if (state.state === "half-open") {
    transitionCircuit(providerId, state, "open", "probe-failed", now);
    return;
  }

  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    transitionCircuit(providerId, state, "open", "threshold-reached", now);
    return;
  }

  state.halfOpenProbeInFlight = false;
}

export function getUnavailableProviderIds(providerIds: string[], now = Date.now()): string[] {
  return providerIds.filter((providerId) => !isProviderAvailablePassive(providerId, now));
}

export function recordFailoverEvent(input: Omit<FailoverEvent, "id" | "createdAt"> & { createdAt?: string }): FailoverEvent {
  const event: FailoverEvent = {
    id: createFailoverId(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    role: input.role,
    fromProviderId: input.fromProviderId ?? null,
    fromModelId: input.fromModelId ?? null,
    toProviderId: input.toProviderId ?? null,
    toModelId: input.toModelId ?? null,
    cause: input.cause,
    reason: input.reason,
  };
  failoverEvents.unshift(event);
  if (failoverEvents.length > MAX_FAILOVER_EVENT_HISTORY) {
    failoverEvents.length = MAX_FAILOVER_EVENT_HISTORY;
  }
  totalFailoverEvents += 1;
  failoverCauseCounts[event.cause] += 1;
  failoverRoleCounts.set(event.role, (failoverRoleCounts.get(event.role) ?? 0) + 1);
  if (event.fromProviderId !== event.toProviderId) {
    providerSwitchCount += 1;
  }
  if (event.fromModelId !== event.toModelId) {
    modelSwitchCount += 1;
  }
  return event;
}

export function getFailoverMetricsSnapshot(limit = 24): FailoverMetricsSnapshot {
  const now = Date.now();
  const recentEvents = failoverEvents.slice(0, Math.max(1, limit));
  return {
    totalEvents: totalFailoverEvents,
    providerSwitches: providerSwitchCount,
    modelSwitches: modelSwitchCount,
    byCause: { ...failoverCauseCounts },
    byRole: Object.fromEntries(
      [...failoverRoleCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    ),
    recentEvents,
    circuitBreakers: Object.fromEntries(
      [...circuitBreakers.entries()].map(([providerId, state]) => [providerId, toSnapshot(state, now)]),
    ),
  };
}

export function clearFailoverMetrics(): void {
  failoverEvents.length = 0;
  for (const key of Object.keys(failoverCauseCounts) as FailoverCause[]) {
    failoverCauseCounts[key] = 0;
  }
  failoverRoleCounts.clear();
  providerSwitchCount = 0;
  modelSwitchCount = 0;
  totalFailoverEvents = 0;
  circuitBreakers.clear();
}

// ─── State Persistence ──────────────────────────────────────────────────────

const FAILOVER_STATE_FILE = "failover-state.json";

interface PersistedFailoverState {
  circuitBreakers: Record<string, {
    failures: number;
    lastFailure: number;
    state: CircuitBreakerStatus;
    openedAt: number;
  }>;
  recentEvents: FailoverEvent[];
  causeCounts: Record<FailoverCause, number>;
  totalEvents: number;
  providerSwitches: number;
  modelSwitches: number;
  savedAt: string;
}

function resolveFailoverStatePath(): string {
  return path.join(getDataRoot(), FAILOVER_STATE_FILE);
}

export async function persistFailoverState(): Promise<void> {
  try {
    const state: PersistedFailoverState = {
      circuitBreakers: Object.fromEntries(
        [...circuitBreakers.entries()].map(([id, cb]) => [id, {
          failures: cb.failures,
          lastFailure: cb.lastFailure,
          state: cb.state,
          openedAt: cb.openedAt,
        }]),
      ),
      recentEvents: failoverEvents.slice(0, MAX_FAILOVER_EVENT_HISTORY),
      causeCounts: { ...failoverCauseCounts },
      totalEvents: totalFailoverEvents,
      providerSwitches: providerSwitchCount,
      modelSwitches: modelSwitchCount,
      savedAt: new Date().toISOString(),
    };
    const filePath = resolveFailoverStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Best-effort persistence.
  }
}

export async function restoreFailoverState(): Promise<void> {
  try {
    const raw = await readFile(resolveFailoverStatePath(), "utf8");
    const state = JSON.parse(raw) as PersistedFailoverState;

    // Check staleness: if saved more than 2x the circuit breaker reset period ago,
    // the breaker states are unreliable — start fresh.
    const savedAt = new Date(state.savedAt).getTime();
    const staleThreshold = CIRCUIT_BREAKER_RESET_MS * 2;
    const isStale = !Number.isFinite(savedAt) || Date.now() - savedAt > staleThreshold;

    if (!isStale && state.circuitBreakers) {
      for (const [id, cb] of Object.entries(state.circuitBreakers)) {
        if (cb && typeof cb.state === "string") {
          circuitBreakers.set(id, {
            failures: cb.failures ?? 0,
            lastFailure: cb.lastFailure ?? 0,
            state: cb.state,
            openedAt: cb.openedAt ?? 0,
            halfOpenProbeInFlight: false,
          });
        }
      }
    }

    if (Array.isArray(state.recentEvents)) {
      failoverEvents.push(...state.recentEvents.slice(0, MAX_FAILOVER_EVENT_HISTORY));
    }
    if (state.causeCounts) {
      for (const key of Object.keys(failoverCauseCounts) as FailoverCause[]) {
        failoverCauseCounts[key] = (state.causeCounts[key] ?? 0);
      }
    }
    totalFailoverEvents = state.totalEvents ?? 0;
    providerSwitchCount = state.providerSwitches ?? 0;
    modelSwitchCount = state.modelSwitches ?? 0;
  } catch {
    // No persisted state — start fresh.
  }
}
