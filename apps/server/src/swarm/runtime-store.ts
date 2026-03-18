import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type SimulationRunnerStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export interface SimulationRunState {
  simulationId: string;
  runnerStatus: SimulationRunnerStatus;
  currentRound: number;
  totalRounds: number;
  actionsCount: number;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface SimulationActionLogEntry {
  simulationId: string;
  timestamp: string;
  round: number;
  personaId: string;
  personaName: string;
  confidence: number;
  contentPreview: string;
}

function getSimulationsDir(): string {
  const dir = join(homedir(), ".ember", "simulations");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeSimulationId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function getRunStatePath(id: string): string {
  return join(getSimulationsDir(), `${sanitizeSimulationId(id)}.run.json`);
}

function getActionsLogPath(id: string): string {
  return join(getSimulationsDir(), `${sanitizeSimulationId(id)}.actions.jsonl`);
}

export function saveSimulationRunState(state: SimulationRunState): void {
  const path = getRunStatePath(state.simulationId);
  const payload: SimulationRunState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
}

export function loadSimulationRunState(simulationId: string): SimulationRunState | null {
  const path = getRunStatePath(simulationId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SimulationRunState;
  } catch {
    return null;
  }
}

export function appendSimulationActionLog(entry: SimulationActionLogEntry): void {
  const path = getActionsLogPath(entry.simulationId);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readSimulationActionLog(
  simulationId: string,
  options?: { limit?: number; offset?: number },
): { total: number; items: SimulationActionLogEntry[] } {
  const path = getActionsLogPath(simulationId);
  if (!existsSync(path)) {
    return { total: 0, items: [] };
  }

  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const all = lines
      .map((line) => {
        try {
          return JSON.parse(line) as SimulationActionLogEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is SimulationActionLogEntry => entry !== null);

    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(1, options?.limit ?? 100);
    return {
      total: all.length,
      items: all.slice(offset, offset + limit),
    };
  } catch {
    return { total: 0, items: [] };
  }
}

export function deleteSimulationRuntimeArtifacts(simulationId: string): void {
  const runPath = getRunStatePath(simulationId);
  const actionsPath = getActionsLogPath(simulationId);
  if (existsSync(runPath)) rmSync(runPath);
  if (existsSync(actionsPath)) rmSync(actionsPath);
}
