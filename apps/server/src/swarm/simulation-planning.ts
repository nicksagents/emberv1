import type { Settings } from "@ember/core";

import type { ProviderModelPoolEntry, SimulationPersona } from "./types.js";

export const MIN_SWARM_PERSONAS = 8;
export const MAX_SWARM_PERSONAS = 200;
export const MIN_SWARM_ROUNDS = 1;
export const MAX_SWARM_ROUNDS = 120;

export interface SwarmDeploymentSlot {
  slotId: string;
  providerId: string;
  modelId: string;
  usage: "persona" | "synthesis" | "both";
  priority: number;
}

export interface SwarmDeploymentValidation {
  ok: boolean;
  reason: string | null;
  personaSlots: SwarmDeploymentSlot[];
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeUsage(raw: string | undefined): "persona" | "synthesis" | "both" {
  if (raw === "persona" || raw === "synthesis" || raw === "both") return raw;
  return "both";
}

function sanitizePoolEntry(
  entry: Partial<ProviderModelPoolEntry>,
): ProviderModelPoolEntry | null {
  const providerId = typeof entry.providerId === "string" ? entry.providerId.trim() : "";
  const modelId = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
  if (!providerId || !modelId) return null;

  const priority = Number.isFinite(Number(entry.priority))
    ? clampInt(Number(entry.priority), 1, 999)
    : 50;
  const replicas = Number.isFinite(Number(entry.replicas))
    ? clampInt(Number(entry.replicas), 1, MAX_SWARM_PERSONAS)
    : 1;
  const weight = Number.isFinite(Number(entry.weight))
    ? clampInt(Number(entry.weight), 1, 1000)
    : 1;
  const minPersonaSlotsPerRound = Number.isFinite(Number(entry.minPersonaSlotsPerRound))
    ? clampInt(Number(entry.minPersonaSlotsPerRound), 0, MAX_SWARM_PERSONAS)
    : 0;

  return {
    providerId,
    modelId,
    usage: normalizeUsage(entry.usage),
    priority,
    enabled: entry.enabled !== false,
    replicas,
    weight,
    minPersonaSlotsPerRound,
  };
}

export function normalizeProviderModelPool(
  pool: Array<Partial<ProviderModelPoolEntry>> | undefined | null,
): ProviderModelPoolEntry[] {
  if (!Array.isArray(pool)) return [];
  const normalized = pool
    .map((entry) => sanitizePoolEntry(entry))
    .filter((entry): entry is ProviderModelPoolEntry => entry !== null);

  normalized.sort((a, b) => {
    const byPriority = (a.priority ?? 50) - (b.priority ?? 50);
    if (byPriority !== 0) return byPriority;
    const byProvider = a.providerId.localeCompare(b.providerId);
    if (byProvider !== 0) return byProvider;
    return a.modelId.localeCompare(b.modelId);
  });
  return normalized;
}

export function buildPersonaDeploymentSlots(pool: ProviderModelPoolEntry[]): SwarmDeploymentSlot[] {
  const slots: SwarmDeploymentSlot[] = [];
  for (const entry of pool) {
    if (entry.enabled === false) continue;
    if (entry.usage === "synthesis") continue;
    const replicas = clampInt(entry.replicas ?? 1, 1, MAX_SWARM_PERSONAS);
    const priority = clampInt(entry.priority ?? 50, 1, 999);
    for (let idx = 0; idx < replicas; idx += 1) {
      slots.push({
        slotId: `${entry.providerId}:${entry.modelId}:${idx + 1}`,
        providerId: entry.providerId,
        modelId: entry.modelId,
        usage: entry.usage ?? "both",
        priority,
      });
    }
  }
  return slots;
}

export function validateSwarmDeployment(
  personaCount: number,
  pool: ProviderModelPoolEntry[],
  strictMatch = true,
): SwarmDeploymentValidation {
  const personaSlots = buildPersonaDeploymentSlots(pool);
  if (personaSlots.length === 0) {
    return {
      ok: false,
      reason: "No persona deployment instances configured. Add provider/model entries with replicas in Simulation settings.",
      personaSlots,
    };
  }

  if (strictMatch && personaSlots.length !== personaCount) {
    return {
      ok: false,
      reason:
        `Deployment mismatch: persona_count=${personaCount}, configured_instances=${personaSlots.length}. ` +
        "Set provider instance replicas so the total equals persona_count.",
      personaSlots,
    };
  }

  if (!strictMatch && personaSlots.length < personaCount) {
    return {
      ok: false,
      reason:
        `Insufficient deployment instances: persona_count=${personaCount}, configured_instances=${personaSlots.length}. ` +
        "Increase provider replicas or lower persona_count.",
      personaSlots,
    };
  }

  return { ok: true, reason: null, personaSlots };
}

export function resolveSimulationPool(
  settings: Settings,
  inputPool?: Array<Partial<ProviderModelPoolEntry>> | null,
): ProviderModelPoolEntry[] {
  if (Array.isArray(inputPool) && inputPool.length > 0) {
    return normalizeProviderModelPool(inputPool);
  }
  return normalizeProviderModelPool(settings.simulation?.providerModelPool ?? []);
}

export function assignPersonaDeploymentSlots(
  personas: SimulationPersona[],
  personaSlots: SwarmDeploymentSlot[],
): SimulationPersona[] {
  if (personaSlots.length === 0) return personas;
  return personas.map((persona, index) => {
    const slot = personaSlots[index % personaSlots.length];
    return {
      ...persona,
      providerId: slot.providerId,
      modelId: slot.modelId,
      slotId: slot.slotId,
    };
  });
}
