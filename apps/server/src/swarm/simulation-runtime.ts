import type { SimulationCancelSignal, SimulationEvent, SimulationState } from "./types.js";
import { emitSimulationEvent, addSimulationEventListener } from "./simulation-events.js";
import { runFullSimulation, type SwarmExecutionContext } from "./simulation-runner.js";
import {
  appendSimulationActionLog,
  loadSimulationRunState,
  readSimulationActionLog,
  saveSimulationRunState,
  type SimulationRunState,
} from "./runtime-store.js";

interface ActiveSimulationRun {
  cancelSignal: SimulationCancelSignal;
  removeListener: () => void;
}

const activeRuns = new Map<string, ActiveSimulationRun>();

function nowIso(): string {
  return new Date().toISOString();
}

function makeInitialRunState(state: SimulationState): SimulationRunState {
  return {
    simulationId: state.config.id,
    runnerStatus: "starting",
    currentRound: 0,
    totalRounds: state.config.roundCount,
    actionsCount: 0,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
    error: null,
  };
}

function updateRunStateWithEvent(runState: SimulationRunState, event: SimulationEvent): SimulationRunState {
  const next: SimulationRunState = {
    ...runState,
    updatedAt: nowIso(),
  };

  switch (event.type) {
    case "simulation:status":
      if (event.status === "preparing") next.runnerStatus = "starting";
      if (event.status === "running") next.runnerStatus = "running";
      if (event.status === "paused") {
        next.runnerStatus = "paused";
        next.completedAt = next.completedAt ?? nowIso();
      }
      break;
    case "simulation:round-start":
      next.runnerStatus = "running";
      next.currentRound = event.round;
      next.totalRounds = event.totalRounds;
      break;
    case "simulation:persona-response":
      next.actionsCount += 1;
      appendSimulationActionLog({
        simulationId: event.simulationId,
        timestamp: nowIso(),
        round: event.round,
        personaId: event.personaId,
        personaName: event.personaName,
        confidence: event.confidence,
        contentPreview: event.contentPreview,
      });
      break;
    case "simulation:complete":
      next.runnerStatus = "completed";
      next.completedAt = nowIso();
      break;
    case "simulation:error":
      next.runnerStatus = "failed";
      next.error = event.error;
      next.completedAt = nowIso();
      break;
  }

  return next;
}

export function getSimulationRunState(simulationId: string): SimulationRunState | null {
  return loadSimulationRunState(simulationId);
}

export function getSimulationRunActions(
  simulationId: string,
  options?: { limit?: number; offset?: number },
): { total: number; items: ReturnType<typeof readSimulationActionLog>["items"] } {
  return readSimulationActionLog(simulationId, options);
}

export function stopSimulationRun(simulationId: string): boolean {
  const active = activeRuns.get(simulationId);
  if (!active) return false;
  active.cancelSignal.cancelled = true;

  const current = loadSimulationRunState(simulationId);
  if (current && current.runnerStatus !== "completed" && current.runnerStatus !== "failed") {
    saveSimulationRunState({
      ...current,
      runnerStatus: "paused",
      completedAt: current.completedAt ?? nowIso(),
    });
  }
  return true;
}

export function isSimulationRunning(simulationId: string): boolean {
  return activeRuns.has(simulationId);
}

export async function startSimulationBackground(
  state: SimulationState,
  contextBase: Omit<SwarmExecutionContext, "cancelSignal">,
): Promise<SimulationRunState> {
  if (activeRuns.has(state.config.id)) {
    const current = loadSimulationRunState(state.config.id);
    if (current) return current;
  }

  let runState = makeInitialRunState(state);
  saveSimulationRunState(runState);

  const removeListener = addSimulationEventListener(state.config.id, (event) => {
    runState = updateRunStateWithEvent(runState, event);
    saveSimulationRunState(runState);
  });

  const cancelSignal: SimulationCancelSignal = { cancelled: false };
  activeRuns.set(state.config.id, { cancelSignal, removeListener });

  void (async () => {
    try {
      const context: SwarmExecutionContext = {
        ...contextBase,
        cancelSignal,
        onEvent: (event) => {
          emitSimulationEvent(event);
          contextBase.onEvent?.(event);
        },
      };
      const result = await runFullSimulation(state, context);

      const finished = loadSimulationRunState(state.config.id) ?? runState;
      if (result.status === "paused") {
        saveSimulationRunState({
          ...finished,
          runnerStatus: "paused",
          currentRound: result.currentRound,
          totalRounds: result.config.roundCount,
          completedAt: finished.completedAt ?? nowIso(),
        });
      } else if (result.status === "failed") {
        saveSimulationRunState({
          ...finished,
          runnerStatus: "failed",
          error: result.error ?? "Simulation failed.",
          completedAt: finished.completedAt ?? nowIso(),
        });
      } else if (result.status === "completed") {
        saveSimulationRunState({
          ...finished,
          runnerStatus: "completed",
          currentRound: result.currentRound,
          totalRounds: result.config.roundCount,
          completedAt: finished.completedAt ?? nowIso(),
        });
      }
    } catch (err) {
      const failed = loadSimulationRunState(state.config.id) ?? runState;
      saveSimulationRunState({
        ...failed,
        runnerStatus: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: failed.completedAt ?? nowIso(),
      });
    } finally {
      const active = activeRuns.get(state.config.id);
      if (active) {
        active.removeListener();
        activeRuns.delete(state.config.id);
      }
    }
  })();

  return runState;
}
