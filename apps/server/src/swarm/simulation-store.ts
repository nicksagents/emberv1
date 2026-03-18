/**
 * Simulation Store
 *
 * Persistence for simulation states. Stores each simulation as a JSON file
 * in ~/.ember/simulations/.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SimulationState } from "./types.js";

function getSimulationsDir(): string {
  const dir = join(homedir(), ".ember", "simulations");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getSimulationPath(id: string): string {
  // Sanitize ID to prevent path traversal
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(getSimulationsDir(), `${safeId}.json`);
}

export function saveSimulationState(state: SimulationState): void {
  const filePath = getSimulationPath(state.config.id);
  state.updatedAt = new Date().toISOString();
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

export function loadSimulationState(id: string): SimulationState | null {
  const filePath = getSimulationPath(id);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as SimulationState;
  } catch {
    return null;
  }
}

export function listSimulations(): SimulationState[] {
  const dir = getSimulationsDir();
  // Keep simulation state files only; runtime sidecar files use `.run.json`.
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".run.json"));
  const states: SimulationState[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf8");
      states.push(JSON.parse(raw) as SimulationState);
    } catch {
      // Skip corrupted files
    }
  }
  return states.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function deleteSimulation(id: string): boolean {
  const filePath = getSimulationPath(id);
  if (!existsSync(filePath)) return false;
  rmSync(filePath);
  return true;
}
