/**
 * Swarm Simulation Tools
 *
 * Three tools for creating, running, and analyzing multi-perspective
 * scenario simulations using small-model swarms.
 *
 * Runtime safety:
 *   - All tool responses return stable payloads, never throw uncaught errors
 *   - Stop action sets cancel signal for cooperative interruption
 *   - Startup failures persist as status="failed"
 */

import type { EmberTool } from "./types.js";
import { readSettings } from "@ember/core";
import { VALID_DOMAINS, type SimulationCancelSignal } from "../swarm/types.js";
import {
  createSimulation,
  interviewPersona,
  type SwarmExecutionContext,
} from "../swarm/simulation-runner.js";
import {
  loadSimulationState,
  listSimulations,
  deleteSimulation,
  saveSimulationState,
} from "../swarm/simulation-store.js";
import { emitSimulationEvent } from "../swarm/simulation-events.js";
import { deleteSimulationRuntimeArtifacts } from "../swarm/runtime-store.js";
import {
  getSimulationRunState,
  isSimulationRunning,
  startSimulationBackground,
  stopSimulationRun,
} from "../swarm/simulation-runtime.js";
import {
  MAX_SWARM_PERSONAS,
  MAX_SWARM_ROUNDS,
  MIN_SWARM_PERSONAS,
  MIN_SWARM_ROUNDS,
  normalizeProviderModelPool,
  resolveSimulationPool,
  validateSwarmDeployment,
} from "../swarm/simulation-planning.js";
import { webSearchTool } from "./web-search.js";

// ─── LLM Call Stub ──────────────────────────────────────────────────────────────

let swarmLlmCall: SwarmExecutionContext["callLlm"] | null = null;
let swarmEventSink: ((event: import("@ember/core").SimulationStreamEvent) => void) | null = null;

export function setSwarmLlmCall(fn: SwarmExecutionContext["callLlm"]): void {
  swarmLlmCall = fn;
}

/** Set a sink that forwards simulation events through the chat SSE stream. */
export function setSwarmEventSink(fn: ((event: import("@ember/core").SimulationStreamEvent) => void) | null): void {
  swarmEventSink = fn;
}

// Track active simulation cancel signals for cooperative stop
const activeSimulations = new Map<string, SimulationCancelSignal>();

type SwarmLifecycleAction = "create" | "run" | "status" | "list" | "stop" | "delete";

interface NormalizedSwarmInput {
  action: SwarmLifecycleAction;
  scenario: string;
  title: string;
  personaCount: number;
  personaCountProvided: boolean;
  roundCount: number;
  roundCountProvided: boolean;
  domain: string;
  simulationId: string;
  confirm: boolean;
  providerModelPool: Array<{
    providerId: string;
    modelId: string;
    usage: "persona" | "synthesis" | "both";
    priority?: number;
    enabled?: boolean;
    replicas?: number;
  }>;
}

function readString(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return "";
}

function readNumber(input: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readBoolean(input: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
    }
  }
  return false;
}

function parseProviderModelPoolInput(input: Record<string, unknown>): Array<{
  providerId: string;
  modelId: string;
  usage: "persona" | "synthesis" | "both";
  priority?: number;
  enabled?: boolean;
  replicas?: number;
}> {
  const raw =
    (Array.isArray(input.provider_model_pool) ? input.provider_model_pool : null)
    ?? (Array.isArray(input.providerModelPool) ? input.providerModelPool : null)
    ?? (Array.isArray(input.provider_instances) ? input.provider_instances : null)
    ?? (Array.isArray(input.providerInstances) ? input.providerInstances : null)
    ?? (Array.isArray(input.deployments) ? input.deployments : null);

  if (!raw) return [];

  const parsed = raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const obj = entry as Record<string, unknown>;
      const providerId = typeof obj.providerId === "string"
        ? obj.providerId.trim()
        : typeof obj.provider_id === "string"
          ? obj.provider_id.trim()
          : "";
      const modelId = typeof obj.modelId === "string"
        ? obj.modelId.trim()
        : typeof obj.model_id === "string"
          ? obj.model_id.trim()
          : "";
      if (!providerId || !modelId) return null;

      const usageRaw = typeof obj.usage === "string" ? obj.usage.trim().toLowerCase() : "persona";
      const usage: "persona" | "synthesis" | "both" =
        usageRaw === "synthesis" || usageRaw === "both" ? usageRaw : "persona";

      const replicasRaw = typeof obj.replicas === "number"
        ? obj.replicas
        : typeof obj.instances === "number"
          ? obj.instances
          : typeof obj.count === "number"
            ? obj.count
            : typeof obj.replicas === "string"
              ? Number(obj.replicas)
              : typeof obj.instances === "string"
                ? Number(obj.instances)
                : typeof obj.count === "string"
                  ? Number(obj.count)
                  : NaN;
      const replicas = Number.isFinite(replicasRaw) ? Math.max(1, Math.min(MAX_SWARM_PERSONAS, Math.floor(replicasRaw))) : 1;

      const priorityRaw = typeof obj.priority === "number"
        ? obj.priority
        : typeof obj.priority === "string"
          ? Number(obj.priority)
          : NaN;
      const priority = Number.isFinite(priorityRaw) ? Math.max(1, Math.min(999, Math.floor(priorityRaw))) : 50;

      const enabled = obj.enabled !== false;

      return {
        providerId,
        modelId,
        usage,
        priority,
        enabled,
        replicas,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return normalizeProviderModelPool(parsed);
}

function normalizeScenarioText(raw: string): string {
  if (!raw) return "";
  const stripped = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/^\s*reasoning\s*[:\-]\s*/i, " ")
    .replace(/\s+/g, " ")
    .trim();

  const labeled = stripped.match(/(?:scenario|question|task)\s*[:\-]\s*(.+)$/i);
  const base = labeled?.[1]?.trim() || stripped;
  return base.slice(0, 2000).trim();
}

function inferDomain(scenario: string): string {
  const lower = scenario.toLowerCase();
  if (/\b(bitcoin|btc|crypto|market|stocks?|fed|interest rates?)\b/.test(lower)) return "finance";
  if (/\b(ai|software|model|chip|cloud|engineering|platform|api)\b/.test(lower)) return "technology";
  if (/\b(election|war|policy|government|nation|geopolitic)\b/.test(lower)) return "geopolitics";
  if (/\b(startup|enterprise|revenue|pricing|sales|growth)\b/.test(lower)) return "business";
  if (/\b(climate|carbon|emissions?|energy|environment)\b/.test(lower)) return "environment";
  if (/\b(health|medical|drug|disease|hospital)\b/.test(lower)) return "healthcare";
  if (/\b(science|research|experiment|evidence)\b/.test(lower)) return "science";
  if (/\b(community|culture|society|social)\b/.test(lower)) return "social";
  return "other";
}

const ACTION_ALIASES: Readonly<Record<string, SwarmLifecycleAction>> = {
  create: "create",
  simulate: "create",
  start: "create",
  new: "create",
  run: "run",
  resume: "run",
  continue: "run",
  status: "status",
  check: "status",
  progress: "status",
  list: "list",
  ls: "list",
  stop: "stop",
  pause: "stop",
  cancel: "stop",
  delete: "delete",
  remove: "delete",
};

/**
 * MicroFish-style tolerant normalization:
 * accept flexible field names and infer lifecycle action when omitted.
 */
export function normalizeSwarmSimulateInput(input: Record<string, unknown>): NormalizedSwarmInput {
  const rawAction = readString(input, ["action", "operation", "command", "mode"]).toLowerCase();

  const rawScenario = readString(input, [
    "scenario",
    "prompt",
    "topic",
    "question",
    "query",
    "request",
    "description",
    "analysis",
    "reasoning",
    "REASONING",
  ]);
  const scenario = normalizeScenarioText(rawScenario);
  const title = readString(input, ["title", "name"]);
  const simulationId = readString(input, ["simulation_id", "simulationId", "sim_id", "id"]);

  let action: SwarmLifecycleAction | undefined = ACTION_ALIASES[rawAction];
  if (!action) {
    if (scenario) action = "create";
    else if (simulationId) action = "status";
    else action = "list";
  }

  const personaNum = readNumber(input, ["persona_count", "personaCount", "personas", "agents", "num_personas"]);
  const roundNum = readNumber(input, ["round_count", "roundCount", "rounds", "num_rounds"]);

  const personaCountProvided = personaNum !== null;
  const roundCountProvided = roundNum !== null;
  const personaCount = personaNum === null
    ? MIN_SWARM_PERSONAS
    : Math.max(MIN_SWARM_PERSONAS, Math.min(MAX_SWARM_PERSONAS, Math.floor(personaNum)));
  const roundCount = roundNum === null
    ? 3
    : Math.max(MIN_SWARM_ROUNDS, Math.min(MAX_SWARM_ROUNDS, Math.floor(roundNum)));

  const rawDomain = readString(input, ["domain", "category"]).toLowerCase();
  const domain = (VALID_DOMAINS as readonly string[]).includes(rawDomain)
    ? rawDomain
    : inferDomain(scenario || title);

  return {
    action,
    scenario: scenario || normalizeScenarioText(title),
    title,
    personaCount,
    personaCountProvided,
    roundCount,
    roundCountProvided,
    domain,
    simulationId,
    confirm: readBoolean(input, ["confirm", "force", "delete_confirm"]),
    providerModelPool: parseProviderModelPoolInput(input),
  };
}

function getSwarmContext(
  onProgress?: (msg: string) => void,
  options?: { emitToBus?: boolean; maxConcurrency?: number },
): SwarmExecutionContext {
  if (!swarmLlmCall) {
    throw new Error("Swarm simulation is not configured. No LLM provider is available.");
  }
  const emitToBus = options?.emitToBus !== false;
  const maxConcurrency = Math.max(1, Math.min(64, Math.floor(options?.maxConcurrency ?? 4)));
  return {
    callLlm: swarmLlmCall,
    maxConcurrency,
    onProgress,
    onEvent: swarmEventSink ? (event) => {
      // Forward internal simulation events to the chat SSE stream as SimulationStreamEvents
      try {
        if (emitToBus) emitSimulationEvent(event);
        const sink = swarmEventSink;
        if (!sink) return;
        switch (event.type) {
          case "simulation:persona-generated":
            // Full persona data is sent after prepareSimulation completes (see create action)
            break;
          case "simulation:round-start":
            sink({ type: "sim:round-start", simulationId: event.simulationId, round: event.round, totalRounds: event.totalRounds });
            break;
          case "simulation:persona-response":
            sink({ type: "sim:persona-response", simulationId: event.simulationId, round: event.round, personaId: event.personaId, personaName: event.personaName, confidence: event.confidence, content: event.contentPreview });
            break;
          case "simulation:round-synthesis":
            sink({ type: "sim:round-synthesis", simulationId: event.simulationId, round: event.round, synthesis: event.synthesis });
            break;
          case "simulation:round-complete":
            sink({ type: "sim:round-complete", simulationId: event.simulationId, round: event.round });
            break;
          case "simulation:final-synthesis":
            sink({ type: "sim:final", simulationId: event.simulationId, synthesis: event.synthesis, probabilities: event.probabilities });
            break;
          case "simulation:complete":
            sink({ type: "sim:complete", simulationId: event.simulationId, duration: event.duration });
            break;
          case "simulation:error":
            sink({ type: "sim:error", simulationId: event.simulationId, error: event.error });
            break;
        }
      } catch {
        // Never let sink errors crash the simulation
      }
    } : (event) => {
      if (emitToBus) emitSimulationEvent(event);
    },
  };
}

function buildResearchQueries(scenario: string, domain: string): string[] {
  const normalized = scenario.toLowerCase();
  const queries = [
    `${scenario} key drivers and baseline outcomes`,
    `${scenario} latest news and expert analysis`,
  ];

  if (/\b(fed|fomc|federal reserve|rate cut|interest rate)\b/.test(normalized)) {
    queries.push("next FOMC meeting date Federal Reserve calendar");
    queries.push("recent FOMC statement summary inflation unemployment growth");
    queries.push("fed funds futures probability next FOMC rate decision");
  } else if (domain === "finance") {
    queries.push(`${scenario} historical outcomes and comparable events`);
    queries.push(`${scenario} macroeconomic indicators latest data`);
  } else if (domain === "geopolitics") {
    queries.push(`${scenario} current diplomatic and military developments`);
    queries.push(`${scenario} historical analog scenarios and outcomes`);
  }

  return queries.slice(0, 5);
}

async function gatherSimulationResearchContext(
  scenario: string,
  domain: string,
): Promise<string[]> {
  const now = new Date();
  const currentDateLine = `Current date (UTC): ${now.toISOString()}. Current date (local): ${now.toLocaleString("en-US")}.`;
  const queries = buildResearchQueries(scenario, domain);
  const contextData: string[] = [currentDateLine];

  for (const query of queries) {
    try {
      const freshness = /\b(latest|today|this week|current|fomc|fed|rate)\b/i.test(query) ? "pm" : undefined;
      const result = await webSearchTool.execute({
        query,
        max_results: 5,
        auto_fetch: 2,
        freshness,
      });
      const text = typeof result === "string" ? result : result.text;
      contextData.push(`Research query: ${query}\n${text.slice(0, 5000)}`);
    } catch (err) {
      contextData.push(`Research query failed: ${query}\n${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return contextData;
}

// ─── Tool: swarm_simulate ───────────────────────────────────────────────────────

async function swarmSimulateExecute(input: Record<string, unknown>): Promise<string> {
  const normalized = normalizeSwarmSimulateInput(input);
  const action = normalized.action;

  try {
    switch (action) {
      case "create": {
        const scenario = normalized.scenario;
        if (!scenario) {
          return 'Error: scenario is required for create. Accepted fields: scenario, prompt, topic, question, or description.';
        }

        const settings = await readSettings();
        const title = normalized.title || scenario.slice(0, 60);
        const personaCount = normalized.personaCountProvided
          ? normalized.personaCount
          : Math.max(
            MIN_SWARM_PERSONAS,
            Math.min(MAX_SWARM_PERSONAS, settings.simulation?.defaultPersonaCount ?? MIN_SWARM_PERSONAS),
          );
        const roundCount = normalized.roundCountProvided
          ? normalized.roundCount
          : Math.max(
            MIN_SWARM_ROUNDS,
            Math.min(MAX_SWARM_ROUNDS, settings.simulation?.defaultRoundCount ?? 3),
          );
        const domain = normalized.domain;
        const providerPool = resolveSimulationPool(settings, normalized.providerModelPool);
        const deploymentCheck = validateSwarmDeployment(personaCount, providerPool, true);
        if (!deploymentCheck.ok) {
          return `Error: ${deploymentCheck.reason}`;
        }

        console.log(`[tool:swarm_simulate] create+queue "${title}" ${personaCount} personas, ${roundCount} rounds`);
        console.log(`[tool:swarm_simulate] deployment slots=${deploymentCheck.personaSlots.length}`);

        const researchContext = await gatherSimulationResearchContext(scenario, domain);

        const state = createSimulation({
          title,
          scenario,
          personaCount,
          roundCount,
          modelTier: "small",
          synthesisModelTier: "medium",
          domain,
          providerModelPool: providerPool,
          compactMode: settings.simulation?.compactMode ?? true,
          contextData: researchContext,
        });

        // Emit sim:start so the frontend can show the simulation shell immediately
        swarmEventSink?.({ type: "sim:start", simulationId: state.config.id, title, scenario, personaCount, roundCount, domain });

        const context = getSwarmContext(
          (msg) => console.log(`[swarm:progress] ${msg}`),
          { emitToBus: false, maxConcurrency: settings.simulation?.maxConcurrency ?? 4 },
        );
        const origOnEvent = context.onEvent;
        context.onEvent = (event) => {
          origOnEvent?.(event);
          // When preparation finishes, emit full persona data for the live visualization.
          if (event.type === "simulation:status" && event.status === "ready" && swarmEventSink) {
            const currentState = loadSimulationState(state.config.id);
            if (!currentState) return;
            for (const p of currentState.personas) {
              swarmEventSink({
                type: "sim:persona",
                simulationId: state.config.id,
                persona: {
                  id: p.id,
                  name: p.name,
                  role: p.role,
                  perspective: p.perspective,
                  background: p.background,
                },
              });
            }
          }
        };

        const runState = await startSimulationBackground(state, {
          callLlm: context.callLlm,
          maxConcurrency: context.maxConcurrency,
          onProgress: context.onProgress,
          onEvent: context.onEvent,
        });

        return [
          `Simulation started: ${state.config.id}`,
          `Title: ${title}`,
          `Runner: ${runState.runnerStatus}`,
          `Rounds: ${runState.currentRound}/${runState.totalRounds}`,
          "",
          `Use swarm_simulate action=status simulation_id="${state.config.id}" to monitor progress.`,
          "Use swarm_report after completion for the full synthesis.",
        ].join("\n");
      }

      case "run": {
        const simId = normalized.simulationId;
        if (!simId) return "Error: simulation_id is required for run.";

        const state = loadSimulationState(simId);
        if (!state) return `Error: simulation "${simId}" not found.`;

        if (state.status === "completed") return `Simulation "${simId}" is already completed. Use swarm_report to view results.`;
        if (isSimulationRunning(simId)) return `Simulation "${simId}" is already running.`;
        const settings = await readSettings();
        const resolvedPool = normalizeProviderModelPool(
          (state.config.providerModelPool && state.config.providerModelPool.length > 0)
            ? state.config.providerModelPool
            : resolveSimulationPool(settings, normalized.providerModelPool),
        );
        const deploymentCheck = validateSwarmDeployment(state.config.personaCount, resolvedPool, true);
        if (!deploymentCheck.ok) {
          return `Error: ${deploymentCheck.reason}`;
        }
        state.config.providerModelPool = resolvedPool;
        saveSimulationState(state);

        console.log(`[tool:swarm_simulate] run ${simId}`);

        const context = getSwarmContext(
          (msg) => console.log(`[swarm:progress] ${msg}`),
          { emitToBus: false, maxConcurrency: settings.simulation?.maxConcurrency ?? 4 },
        );
        const runState = await startSimulationBackground(state, {
          callLlm: context.callLlm,
          maxConcurrency: context.maxConcurrency,
          onProgress: context.onProgress,
          onEvent: context.onEvent,
        });

        return [
          `Simulation started: ${simId}`,
          `Runner: ${runState.runnerStatus}`,
          `Rounds: ${runState.currentRound}/${runState.totalRounds}`,
          "",
          `Use swarm_simulate action=status simulation_id="${simId}" to monitor progress.`,
        ].join("\n");
      }

      case "status": {
        const simId = normalized.simulationId;
        if (!simId) return "Error: simulation_id is required for status.";

        const state = loadSimulationState(simId);
        if (!state) return `Error: simulation "${simId}" not found.`;
        const runState = getSimulationRunState(simId);
        const deploymentSlots = validateSwarmDeployment(
          state.config.personaCount,
          normalizeProviderModelPool(state.config.providerModelPool ?? []),
          false,
        ).personaSlots.length;

        const totalActions = state.rounds.reduce((sum, r) => sum + r.actions.length, 0);

        return [
          `Simulation: ${state.config.id}`,
          `Title: ${state.config.title}`,
          `Status: ${state.status}`,
          runState ? `Runner: ${runState.runnerStatus}` : "",
          `Personas: ${state.personas.length}`,
          `Rounds: ${state.currentRound}/${state.config.roundCount}`,
          `Total actions: ${totalActions}`,
          runState ? `Runner actions logged: ${runState.actionsCount}` : "",
          `Deployment slots: ${deploymentSlots}`,
          `Created: ${state.config.createdAt}`,
          `Updated: ${state.updatedAt}`,
          runState?.startedAt ? `Started: ${runState.startedAt}` : "",
          runState?.completedAt ? `Completed: ${runState.completedAt}` : "",
          state.error ? `Error: ${state.error}` : "",
          runState?.error ? `Runner error: ${runState.error}` : "",
        ].filter(Boolean).join("\n");
      }

      case "list": {
        const sims = listSimulations();
        if (sims.length === 0) return "No simulations found. Create one with swarm_simulate action=create.";

        console.log(`[tool:swarm_simulate] list (${sims.length} simulations)`);

        const lines = sims.slice(0, 20).map((s, i) => {
          const runState = getSimulationRunState(s.config.id);
          const actions = s.rounds.reduce((sum, r) => sum + r.actions.length, 0);
          return [
            `${i + 1}. [${s.config.id}] ${s.config.title}`,
            `   Status: ${runState?.runnerStatus ?? s.status} | Personas: ${s.personas.length} | Rounds: ${runState?.currentRound ?? s.currentRound}/${s.config.roundCount} | Actions: ${runState?.actionsCount ?? actions}`,
            `   Domain: ${s.config.domain} | Created: ${s.config.createdAt}`,
          ].join("\n");
        });

        return [`Simulations (${sims.length}):`, "", ...lines].join("\n");
      }

      case "stop": {
        const simId = normalized.simulationId;
        if (!simId) return "Error: simulation_id is required for stop.";

        // First try global background runner stop (API/background architecture).
        if (stopSimulationRun(simId)) {
          return `Simulation "${simId}" stop signal sent to runner. It will pause at the next round/batch boundary.`;
        }

        // Set cancel signal for cooperative interruption of active runs
        const cancelSignal = activeSimulations.get(simId);
        if (cancelSignal) {
          cancelSignal.cancelled = true;
          return `Simulation "${simId}" stop signal sent. It will pause at the next round/batch boundary.`;
        }

        const state = loadSimulationState(simId);
        if (!state) return `Error: simulation "${simId}" not found.`;

        if (state.status === "completed" || state.status === "failed") {
          return `Simulation "${simId}" is already ${state.status}.`;
        }

        state.status = "paused";
        saveSimulationState(state);
        return `Simulation "${simId}" paused at round ${state.currentRound}.`;
      }

      case "delete": {
        const simId = normalized.simulationId;
        if (!simId) return "Error: simulation_id is required for delete.";
        if (!normalized.confirm) return "Error: set confirm=true to delete a simulation.";

        stopSimulationRun(simId);
        const deleted = deleteSimulation(simId);
        if (deleted) {
          deleteSimulationRuntimeArtifacts(simId);
        }
        return deleted
          ? `Deleted simulation "${simId}".`
          : `Error: simulation "${simId}" not found.`;
      }

      default:
        return `Error: unknown action "${action}". Use: create, run, status, list, stop, delete.`;
    }
  } catch (err) {
    // Never let an uncaught error escape the tool
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[tool:swarm_simulate] uncaught error: ${message}`);
    return `Error: ${message}`;
  }
}

// ─── Tool: swarm_interview ──────────────────────────────────────────────────────

async function swarmInterviewExecute(input: Record<string, unknown>): Promise<string> {
  const simId = typeof input.simulation_id === "string" ? input.simulation_id.trim() : "";
  const personaId = typeof input.persona_id === "string" ? input.persona_id.trim() : "";
  const question = typeof input.question === "string" ? input.question.trim() : "";

  if (!simId) return "Error: simulation_id is required.";
  if (!personaId) return "Error: persona_id is required.";
  if (!question) return "Error: question is required.";

  try {
    const state = loadSimulationState(simId);
    if (!state) return `Error: simulation "${simId}" not found.`;

    const persona = state.personas.find((p) => p.id === personaId);
    if (!persona) {
      const available = state.personas.map((p) => `${p.id}: ${p.name} (${p.role})`).join("\n  ");
      return `Error: persona "${personaId}" not found.\nAvailable personas:\n  ${available}`;
    }

    console.log(`[tool:swarm_interview] ${simId} persona=${personaId} "${question.slice(0, 50)}..."`);

    const context = getSwarmContext();
    const response = await interviewPersona(state, personaId, question, context);

    return [
      `Interview with ${persona.name} (${persona.role}):`,
      `Simulation: ${state.config.title}`,
      "",
      response,
    ].join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

// ─── Tool: swarm_report ─────────────────────────────────────────────────────────

async function swarmReportExecute(input: Record<string, unknown>): Promise<string> {
  const simId = typeof input.simulation_id === "string" ? input.simulation_id.trim() : "";
  if (!simId) return "Error: simulation_id is required.";

  const format = typeof input.format === "string" ? input.format.trim() : "summary";

  try {
    const state = loadSimulationState(simId);
    if (!state) return `Error: simulation "${simId}" not found.`;

    console.log(`[tool:swarm_report] ${simId} format=${format}`);

    switch (format) {
      case "summary": {
        const sections = [
          `# Simulation Report: ${state.config.title}`,
          `ID: ${state.config.id} | Status: ${state.status} | Domain: ${state.config.domain}`,
          `Personas: ${state.personas.length} | Rounds: ${state.rounds.length}`,
          "",
          `## Scenario`,
          state.config.scenario,
          "",
        ];

        if (state.personas.length > 0) {
          sections.push("## Personas");
          for (const p of state.personas) {
            sections.push(`- **${p.name}** (${p.role}): ${p.perspective}`);
          }
          sections.push("");
        }

        if (state.probabilities) {
          sections.push("## Probability Assessment");
          for (const [outcome, prob] of Object.entries(state.probabilities)) {
            const bar = "\u2588".repeat(Math.round(prob * 20)) + "\u2591".repeat(20 - Math.round(prob * 20));
            sections.push(`${outcome}: ${bar} ${(prob * 100).toFixed(1)}%`);
          }
          sections.push("");
        }

        if (state.finalSynthesis) {
          sections.push("## Final Synthesis");
          sections.push(state.finalSynthesis);
        }

        return sections.join("\n");
      }

      case "detailed": {
        const sections = [
          `# Detailed Simulation Report: ${state.config.title}`,
          `ID: ${state.config.id} | Status: ${state.status}`,
          "",
          `## Scenario`,
          state.config.scenario,
          "",
          "## Personas",
        ];

        for (const p of state.personas) {
          sections.push(`### ${p.name} (${p.role})`);
          sections.push(`Background: ${p.background}`);
          sections.push(`Personality: ${p.personality}`);
          sections.push(`Perspective: ${p.perspective}`);
          sections.push(`Biases: ${p.biases.join(", ")}`);
          sections.push("");
        }

        for (const round of state.rounds) {
          sections.push(`## Round ${round.roundNumber}`);
          if (round.parseFailures) {
            sections.push(`*(${round.parseFailures} parse fallback(s) in this round)*`);
          }
          for (const action of round.actions) {
            const flags = [];
            if (action.noResponse) flags.push("NO RESPONSE");
            if (action.retryCount) flags.push(`retried ${action.retryCount}x`);
            const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
            sections.push(`### ${action.personaName} (confidence: ${action.confidence.toFixed(2)})${flagStr}`);
            sections.push(action.content);
            if (action.reasoning) sections.push(`*Reasoning: ${action.reasoning}*`);
            sections.push("");
          }
          if (round.synthesis) {
            sections.push("### Round Synthesis");
            sections.push(round.synthesis);
            sections.push("");
          }
        }

        if (state.finalSynthesis) {
          sections.push("## Final Synthesis");
          sections.push(state.finalSynthesis);
        }

        return sections.join("\n");
      }

      case "probability-table": {
        if (!state.probabilities) {
          return "No probability assessment available. Run the simulation to completion first.";
        }

        const sorted = Object.entries(state.probabilities)
          .sort(([, a], [, b]) => b - a);

        const lines = ["Outcome Probability Table:", ""];
        for (const [outcome, prob] of sorted) {
          const pct = (prob * 100).toFixed(1).padStart(5);
          const bar = "\u2588".repeat(Math.round(prob * 30));
          lines.push(`${pct}%  ${bar}  ${outcome}`);
        }

        return lines.join("\n");
      }

      case "arguments": {
        if (state.rounds.length === 0) return "No rounds completed yet.";

        const sections = ["# Key Arguments by Persona", ""];

        for (const persona of state.personas) {
          sections.push(`## ${persona.name} (${persona.role})`);
          const actions = state.rounds
            .flatMap((r) => r.actions.filter((a) => a.personaId === persona.id));
          if (actions.length === 0) {
            sections.push("(no contributions recorded)");
          } else {
            for (const action of actions) {
              sections.push(`**Round ${action.round}** (confidence: ${action.confidence.toFixed(2)}):`);
              sections.push(action.content);
              sections.push("");
            }
          }
          sections.push("");
        }

        return sections.join("\n");
      }

      default:
        return `Error: unknown format "${format}". Use: summary, detailed, probability-table, arguments.`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

// ─── Tool Exports ───────────────────────────────────────────────────────────────

export const swarmSimulateTool: EmberTool = {
  definition: {
    name: "swarm_simulate",
    description:
      "Launch a multi-perspective simulation. Creates and starts the simulation in one call — " +
      "fans out small models as diverse personas to analyze scenarios, debate outcomes " +
      "across multiple rounds, and synthesize probability assessments. " +
      "Use for: decision analysis, market scenarios, technical trade-offs, world events, risk assessment. " +
      "Use action=create with a scenario to launch in the background. If action is omitted, scenario implies create and simulation_id implies status.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "run", "status", "list", "stop", "delete"],
          description: "Optional lifecycle action. 'create' starts a background simulation run. 'run' resumes a paused simulation.",
        },
        scenario: {
          type: "string",
          description: "Scenario to simulate. Aliases also accepted: prompt, topic, question, query, request, description.",
        },
        title: {
          type: "string",
          description: "Short title for the simulation.",
        },
        persona_count: {
          type: "number",
          description: `Number of simulated perspectives (${MIN_SWARM_PERSONAS}-${MAX_SWARM_PERSONAS}). Must match configured provider deployment instance total.`,
        },
        round_count: {
          type: "number",
          description: `Number of deliberation rounds (${MIN_SWARM_ROUNDS}-${MAX_SWARM_ROUNDS}, default from settings).`,
        },
        domain: {
          type: "string",
          enum: [...VALID_DOMAINS],
          description: "Domain context for persona generation.",
        },
        simulation_id: {
          type: "string",
          description: "Simulation ID (required for run/status/stop/delete).",
        },
        confirm: {
          type: "boolean",
          description: "Required for delete action.",
        },
        provider_model_pool: {
          type: "array",
          description:
            "Optional per-simulation provider deployment. Total persona/both replicas must equal persona_count. " +
            "Each item: {providerId, modelId, usage, replicas}.",
        },
      },
    },
  },
  execute: swarmSimulateExecute,
};

export const swarmInterviewTool: EmberTool = {
  definition: {
    name: "swarm_interview",
    description:
      "Interview a specific simulated persona from a running or completed simulation. " +
      "Ask them to elaborate, challenge their reasoning, or explore edge cases. " +
      "The persona responds in character with their established background and biases.",
    inputSchema: {
      type: "object",
      properties: {
        simulation_id: {
          type: "string",
          description: "The simulation to query.",
        },
        persona_id: {
          type: "string",
          description: "Which persona to interview (e.g., 'p1', 'p2').",
        },
        question: {
          type: "string",
          description: "Your question to the persona.",
        },
      },
      required: ["simulation_id", "persona_id", "question"],
    },
  },
  execute: swarmInterviewExecute,
};

export const swarmReportTool: EmberTool = {
  definition: {
    name: "swarm_report",
    description:
      "Generate a structured report from a completed simulation. Formats: " +
      "summary (overview + probabilities), detailed (all rounds + actions), " +
      "probability-table (sorted outcomes), arguments (per-persona positions).",
    inputSchema: {
      type: "object",
      properties: {
        simulation_id: {
          type: "string",
          description: "The simulation to report on.",
        },
        format: {
          type: "string",
          enum: ["summary", "detailed", "probability-table", "arguments"],
          description: "Report format. Default: summary.",
        },
      },
      required: ["simulation_id"],
    },
  },
  execute: swarmReportExecute,
};
