import type { SimulationEvent } from "./types.js";

type SimulationEventListener = (event: SimulationEvent) => void;

const simulationEventListeners = new Map<string, Set<SimulationEventListener>>();

export function emitSimulationEvent(event: SimulationEvent): void {
  const listeners = simulationEventListeners.get(event.simulationId);
  if (!listeners || listeners.size === 0) return;

  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Event listeners are best-effort and must never break simulation execution.
    }
  }
}

export function addSimulationEventListener(
  simulationId: string,
  listener: SimulationEventListener,
): () => void {
  let listeners = simulationEventListeners.get(simulationId);
  if (!listeners) {
    listeners = new Set<SimulationEventListener>();
    simulationEventListeners.set(simulationId, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = simulationEventListeners.get(simulationId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      simulationEventListeners.delete(simulationId);
    }
  };
}

