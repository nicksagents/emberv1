/**
 * Swarm Simulation Types
 *
 * Core data model for the multi-perspective simulation engine.
 * Adapted from MicroFish's simulation architecture.
 */

export type SimulationStatus =
  | "created"
  | "preparing"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export interface SimulationPersona {
  id: string;
  name: string;
  role: string;
  background: string;
  biases: string[];
  expertise: string[];
  personality: string;
  perspective: string;
  /** Fixed deployment assignment for this persona (provider/model instance). */
  providerId?: string;
  modelId?: string;
  slotId?: string;
}

export interface SimulationAction {
  personaId: string;
  personaName: string;
  round: number;
  actionType: "opinion" | "prediction" | "reaction" | "analysis" | "challenge" | "synthesis";
  content: string;
  confidence: number;
  reasoning: string;
  timestamp: string;
  /** Provider/model used for this action (routing transparency). */
  providerId?: string;
  modelId?: string;
  slotId?: string;
  /** Number of retries needed before getting a parseable response. */
  retryCount?: number;
  /** True if this action was a no-response fallback after retries failed. */
  noResponse?: boolean;
}

export interface SimulationRound {
  roundNumber: number;
  prompt: string;
  actions: SimulationAction[];
  synthesis: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Number of persona responses that required fallback parsing. */
  parseFailures?: number;
}

export interface ProviderModelPoolEntry {
  providerId: string;
  modelId: string;
  usage: "persona" | "synthesis" | "both";
  priority?: number;
  enabled?: boolean;
  replicas?: number;
  weight?: number;
  minPersonaSlotsPerRound?: number;
}

export interface ProviderUsePolicy {
  strategy?: "use-all-selected" | "weighted-distribution" | "tier-strict";
  enforceAllProvidersPerRun?: boolean;
  allowReplicaBurst?: boolean;
  fallbackStrategy?: "continue-with-remaining" | "retry-on-same-tier" | "fail-fast";
  minDistinctProviders?: number;
}

export interface SimulationConfig {
  id: string;
  title: string;
  scenario: string;
  personaCount: number;
  roundCount: number;
  modelTier: "small" | "medium";
  synthesisModelTier: "medium" | "large";
  domain: string;
  createdAt: string;
  /** Auto-set when modelTier === "small"; forces compact prompts. */
  compactMode?: boolean;
  /** Optional data context for personas to reference. */
  contextData?: string[];
  /** Parent simulation for iterative/chained simulations. */
  parentSimulationId?: string;
  /** Provider/model pool for persona distribution. */
  providerModelPool?: ProviderModelPoolEntry[];
  /** Policy for distributing personas across providers. */
  providerUsePolicy?: ProviderUsePolicy;
}

export interface SimulationState {
  config: SimulationConfig;
  status: SimulationStatus;
  personas: SimulationPersona[];
  rounds: SimulationRound[];
  currentRound: number;
  finalSynthesis: string | null;
  probabilities: Record<string, number> | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

export const VALID_DOMAINS = [
  "finance",
  "technology",
  "geopolitics",
  "social",
  "business",
  "science",
  "healthcare",
  "environment",
  "other",
] as const;

export type SimulationDomain = (typeof VALID_DOMAINS)[number];

// ─── Simulation Events (SSE streaming) ──────────────────────────────────────

export type SimulationEvent =
  | { type: "simulation:status"; simulationId: string; status: SimulationStatus; message: string }
  | { type: "simulation:persona-generated"; simulationId: string; persona: { id: string; name: string; role: string } }
  | { type: "simulation:round-start"; simulationId: string; round: number; totalRounds: number }
  | { type: "simulation:persona-response"; simulationId: string; round: number; personaId: string; personaName: string; confidence: number; contentPreview: string }
  | { type: "simulation:persona-error"; simulationId: string; round: number; personaId: string; error: string }
  | { type: "simulation:round-synthesis"; simulationId: string; round: number; synthesis: string }
  | { type: "simulation:round-complete"; simulationId: string; round: number; actionsCount: number; parseFailures: number }
  | { type: "simulation:final-synthesis"; simulationId: string; synthesis: string; probabilities: Record<string, number> | null }
  | { type: "simulation:complete"; simulationId: string; status: "completed"; duration: number }
  | { type: "simulation:error"; simulationId: string; error: string };

// ─── Cancel Signal ──────────────────────────────────────────────────────────

export interface SimulationCancelSignal {
  cancelled: boolean;
}
