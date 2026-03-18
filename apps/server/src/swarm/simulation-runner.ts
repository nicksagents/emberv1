/**
 * Simulation Runner
 *
 * Core execution engine for multi-perspective swarm simulations.
 * Fans out persona calls via the LLM execution infrastructure and
 * aggregates results into rounds with synthesis.
 *
 * Small-model optimizations:
 *   - Compact system/round prompts (< 150 tokens) for 0.8B-3B models
 *   - Extremely tolerant response parsing (JSON, regex, plain-text fallbacks)
 *   - Per-persona retry with simplified retry prompt
 *   - Graceful degradation: no single failure crashes the simulation
 *
 * Runtime safety:
 *   - Cooperative cancel/pause signal checked at round and batch boundaries
 *   - All lifecycle failures persist as status="failed"
 *   - Synthesis failures degrade gracefully (keep actions, fallback text)
 */

import { randomUUID } from "node:crypto";
import type {
  SimulationAction,
  SimulationCancelSignal,
  SimulationConfig,
  SimulationEvent,
  SimulationPersona,
  SimulationRound,
  SimulationState,
} from "./types.js";
import { buildPersonaGenerationPrompt, parsePersonaResponse } from "./persona-generator.js";
import { saveSimulationState } from "./simulation-store.js";
import { assignPersonaDeploymentSlots, buildPersonaDeploymentSlots } from "./simulation-planning.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface LlmCallResult {
  content: string;
  providerId?: string;
  modelId?: string;
}

export interface LlmCallMetadata {
  simulationId: string;
  phase: "persona-generation" | "persona" | "synthesis";
  round?: number;
  personaId?: string;
  personaName?: string;
  slotId?: string;
  providerIdHint?: string;
  modelIdHint?: string;
}

export type LlmCallFn = (
  systemPrompt: string,
  userPrompt: string,
  tier: "small" | "medium" | "large",
  metadata?: LlmCallMetadata,
) => Promise<string | LlmCallResult>;

/** Normalise the return of callLlm to always be an LlmCallResult. */
function normaliseLlmResult(raw: string | LlmCallResult): LlmCallResult {
  return typeof raw === "string" ? { content: raw } : raw;
}

export interface SwarmExecutionContext {
  callLlm: LlmCallFn;
  maxConcurrency: number;
  onProgress?: (message: string) => void;
  onEvent?: (event: SimulationEvent) => void;
  cancelSignal?: SimulationCancelSignal;
}

// ─── Simulation Lifecycle ───────────────────────────────────────────────────────

export function createSimulation(
  input: Omit<SimulationConfig, "id" | "createdAt">,
): SimulationState {
  const config: SimulationConfig = {
    ...input,
    id: `sim_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    compactMode: input.compactMode ?? input.modelTier === "small",
  };

  const state: SimulationState = {
    config,
    status: "created",
    personas: [],
    rounds: [],
    currentRound: 0,
    finalSynthesis: null,
    probabilities: null,
    error: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveSimulationState(state);
  return state;
}

export async function prepareSimulation(
  state: SimulationState,
  context: SwarmExecutionContext,
): Promise<SimulationState> {
  state.status = "preparing";
  saveSimulationState(state);
  emitEvent(context, state, { type: "simulation:status", simulationId: state.config.id, status: "preparing", message: "Generating personas..." });
  context.onProgress?.("Generating diverse personas...");

  try {
    const prompt = buildPersonaGenerationPrompt(state.config);
    const rawResponse = await context.callLlm(
      "You are a persona designer. Output only valid JSON.",
      prompt,
      state.config.modelTier === "small" ? "medium" : state.config.synthesisModelTier,
      {
        simulationId: state.config.id,
        phase: "persona-generation",
      },
    );
    const response = normaliseLlmResult(rawResponse).content;

    const generatedPersonas = parsePersonaResponse(response, state.config);
    const deploymentSlots = buildPersonaDeploymentSlots(state.config.providerModelPool ?? []);
    state.personas = assignPersonaDeploymentSlots(generatedPersonas, deploymentSlots);

    for (const persona of state.personas) {
      emitEvent(context, state, {
        type: "simulation:persona-generated",
        simulationId: state.config.id,
        persona: { id: persona.id, name: persona.name, role: persona.role },
      });
    }

    state.status = "ready";
    saveSimulationState(state);
    context.onProgress?.(`Generated ${state.personas.length} personas. Ready to run.`);
  } catch (err) {
    state.status = "failed";
    state.error = `Preparation failed: ${err instanceof Error ? err.message : String(err)}`;
    saveSimulationState(state);
    emitEvent(context, state, { type: "simulation:error", simulationId: state.config.id, error: state.error });
  }

  return state;
}

// ─── Prompt Building (Full + Compact) ───────────────────────────────────────────

function buildPersonaSystemPrompt(persona: SimulationPersona, config: SimulationConfig): string {
  if (config.compactMode || config.modelTier === "small") {
    return buildPersonaSystemPromptCompact(persona, config);
  }
  return buildPersonaSystemPromptFull(persona, config);
}

function buildPersonaSystemPromptFull(persona: SimulationPersona, config: SimulationConfig): string {
  return `You are ${persona.name}, a ${persona.role}.

Background: ${persona.background}
Personality: ${persona.personality}
Perspective: ${persona.perspective}
Expertise: ${persona.expertise.join(", ")}
Known biases: ${persona.biases.join(", ")}

You are participating in a multi-round analysis of a scenario in the ${config.domain} domain.
Stay in character. Provide your genuine perspective based on your background and biases.
Be specific and substantive — give actual analysis, not generic statements.

Format your response as JSON:
{
  "content": "Your detailed analysis (2-4 paragraphs)",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of your confidence level"
}`;
}

function buildPersonaSystemPromptCompact(persona: SimulationPersona, config: SimulationConfig): string {
  const biasStr = persona.biases.length > 0 ? ` Biases: ${persona.biases.join(", ")}.` : "";
  return `You are ${persona.name}, a ${persona.role}. Your view: ${persona.perspective}.${biasStr} Reply as JSON: {"content":"...","confidence":0.0-1.0}`;
}

function buildRoundPrompt(
  config: SimulationConfig,
  roundNumber: number,
  totalRounds: number,
  priorSynthesis: string | null,
): string {
  if (config.compactMode || config.modelTier === "small") {
    return buildRoundPromptCompact(config, roundNumber, priorSynthesis);
  }
  return buildRoundPromptFull(config, roundNumber, totalRounds, priorSynthesis);
}

function buildRoundPromptFull(
  config: SimulationConfig,
  roundNumber: number,
  totalRounds: number,
  priorSynthesis: string | null,
): string {
  const parts: string[] = [];
  parts.push(`SCENARIO: ${config.scenario}`);

  if (config.contextData && config.contextData.length > 0) {
    parts.push("\nRELEVANT DATA:");
    for (const data of config.contextData.slice(0, 5)) {
      parts.push(`- ${data.slice(0, 500)}`);
    }
  }

  parts.push(`ROUND ${roundNumber} of ${totalRounds}`);

  if (roundNumber === 1) {
    parts.push(
      "\nThis is the first round. Provide your independent analysis of this scenario. " +
      "What are the key factors? What is your prediction and confidence level?",
    );
  } else {
    parts.push(
      `\nPrior round synthesis:\n${priorSynthesis}\n\n` +
      "React to the group's synthesis above. Do you agree? Disagree? " +
      "What did others miss? Has your confidence changed? Provide updated analysis.",
    );
  }

  return parts.join("\n");
}

function buildRoundPromptCompact(
  config: SimulationConfig,
  roundNumber: number,
  priorSynthesis: string | null,
): string {
  const contextPreview = (config.contextData ?? [])
    .slice(0, 3)
    .map((line) => line.slice(0, 180))
    .join(" | ");
  const contextSection = contextPreview ? `\nContext: ${contextPreview}` : "";
  if (roundNumber === 1) {
    return `Analyze this scenario as your role: ${config.scenario}${contextSection}\nGive your opinion and confidence 0-1.`;
  }
  const synthPreview = priorSynthesis ? priorSynthesis.slice(0, 300) : "(no prior synthesis)";
  return `Prior group view: ${synthPreview}${contextSection}\nDo you agree? Update your analysis and confidence.`;
}

// ─── Tolerant Response Parsing ──────────────────────────────────────────────────

export function parsePersonaAction(
  response: string,
  persona: SimulationPersona,
  round: number,
  roundType: "opinion" | "reaction",
): { action: SimulationAction; usedFallback: boolean } {
  let content = response;
  let confidence = 0.5;
  let reasoning = "";
  let usedFallback = false;

  // Strategy 1: Standard JSON parse
  const jsonParsed = tryParseActionJson(response);
  if (jsonParsed) {
    content = jsonParsed.content ?? response;
    confidence = jsonParsed.confidence ?? 0.5;
    reasoning = jsonParsed.reasoning ?? "";
  } else {
    usedFallback = true;

    // Strategy 2: Extract confidence number from anywhere in text
    const confMatch = response.match(/(?:confidence|conf)[:\s]*([0-9]*\.?[0-9]+)/i)
      ?? response.match(/\b(0\.\d+)\b/)
      ?? response.match(/\b(\d{1,2})%/);

    if (confMatch) {
      const raw = parseFloat(confMatch[1]);
      confidence = raw > 1 ? raw / 100 : raw;
    }

    // Strategy 3: Response is just a number (interpret as confidence)
    const numOnly = response.trim().match(/^([0-9]*\.?[0-9]+)$/);
    if (numOnly) {
      const raw = parseFloat(numOnly[1]);
      confidence = raw > 1 ? raw / 100 : raw;
      content = "";
    }

    // Strip common preambles
    content = content.replace(/^As a [\w\s]+[,.:]\s*/i, "");
    content = content.replace(/^(Sure|Here|Certainly|Of course)[,!.]\s*/i, "");
  }

  return {
    action: {
      personaId: persona.id,
      personaName: persona.name,
      round,
      actionType: round === 1 ? "opinion" : roundType,
      content,
      confidence: Math.max(0, Math.min(1, confidence)),
      reasoning,
      timestamp: new Date().toISOString(),
    },
    usedFallback,
  };
}

function tryParseActionJson(response: string): { content?: string; confidence?: number; reasoning?: string } | null {
  const cleaned = response.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();

  // Try direct parse — must be an object (not a bare number/string)
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const fields = extractActionFields(parsed as Record<string, unknown>);
      if (fields.content !== undefined || fields.confidence !== undefined) return fields;
    }
  } catch {
    // noop
  }

  // Try extracting first JSON object
  const objMatch = cleaned.match(/\{[\s\S]*?\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]) as Record<string, unknown>;
      const fields = extractActionFields(parsed);
      if (fields.content !== undefined || fields.confidence !== undefined) return fields;
    } catch {
      // Try fixing malformed JSON
      try {
        let fixed = objMatch[0];
        fixed = fixed.replace(/,\s*\}/g, "}");
        fixed = fixed.replace(/'/g, '"');
        const parsed = JSON.parse(fixed) as Record<string, unknown>;
        const fields = extractActionFields(parsed);
        if (fields.content !== undefined || fields.confidence !== undefined) return fields;
      } catch {
        // noop
      }
    }
  }

  return null;
}

function extractActionFields(parsed: Record<string, unknown>): { content?: string; confidence?: number; reasoning?: string } {
  const result: { content?: string; confidence?: number; reasoning?: string } = {};
  if (typeof parsed.content === "string") result.content = parsed.content;
  if (typeof parsed.confidence === "number") {
    result.confidence = parsed.confidence;
  } else if (typeof parsed.confidence === "string") {
    const num = parseFloat(parsed.confidence);
    if (!isNaN(num)) result.confidence = num > 1 ? num / 100 : num;
  }
  if (typeof parsed.reasoning === "string") result.reasoning = parsed.reasoning;
  return result;
}

// ─── Persona Execution with Retry ───────────────────────────────────────────────

async function executePersonaBatch(
  personas: SimulationPersona[],
  roundPrompt: string,
  config: SimulationConfig,
  roundNumber: number,
  context: SwarmExecutionContext,
): Promise<{ actions: SimulationAction[]; parseFailures: number }> {
  const actions: SimulationAction[] = [];
  let parseFailures = 0;

  for (let i = 0; i < personas.length; i += context.maxConcurrency) {
    // Check cancel signal at batch boundaries
    if (context.cancelSignal?.cancelled) {
      break;
    }

    const batch = personas.slice(i, i + context.maxConcurrency);
    context.onProgress?.(
      `Round ${roundNumber}: running personas ${i + 1}-${Math.min(i + batch.length, personas.length)} of ${personas.length}`,
    );

    const results = await Promise.allSettled(
      batch.map(async (persona) => {
        const systemPrompt = buildPersonaSystemPrompt(persona, config);

        let response: string;
        let llmProviderId: string | undefined;
        let llmModelId: string | undefined;
        try {
          const raw = await context.callLlm(
            systemPrompt,
            roundPrompt,
            config.modelTier,
            {
              simulationId: config.id,
              phase: "persona",
              round: roundNumber,
              personaId: persona.id,
              personaName: persona.name,
              slotId: persona.slotId,
              providerIdHint: persona.providerId,
              modelIdHint: persona.modelId,
            },
          );
          const res = normaliseLlmResult(raw);
          response = res.content;
          llmProviderId = res.providerId;
          llmModelId = res.modelId;
        } catch (err) {
          console.log(`[swarm:runner] Persona ${persona.id} call failed: ${err}`);
          // Retry once with a simpler prompt
          try {
            const retryRaw = await context.callLlm(
              `You are ${persona.name}, a ${persona.role}.`,
              `In 2-3 sentences, what is your view on: ${config.scenario}? Rate confidence 0-10.`,
              config.modelTier,
              {
                simulationId: config.id,
                phase: "persona",
                round: roundNumber,
                personaId: persona.id,
                personaName: persona.name,
                slotId: persona.slotId,
                providerIdHint: persona.providerId,
                modelIdHint: persona.modelId,
              },
            );
            const retryRes = normaliseLlmResult(retryRaw);
            const { action } = parsePersonaAction(retryRes.content, persona, roundNumber, roundNumber === 1 ? "opinion" : "reaction");
            action.retryCount = 1;
            action.providerId = retryRes.providerId;
            action.modelId = retryRes.modelId;
            action.slotId = persona.slotId;
            return action;
          } catch {
            // Both attempts failed — return no-response action
            return makeNoResponseAction(persona, roundNumber);
          }
        }

        const { action, usedFallback } = parsePersonaAction(response, persona, roundNumber, roundNumber === 1 ? "opinion" : "reaction");
        action.providerId = llmProviderId;
        action.modelId = llmModelId;
        action.slotId = persona.slotId;

        if (usedFallback && (!action.content || action.content.length < 5)) {
          // Content is essentially empty after fallback parse — retry with simpler prompt
          try {
            const retryRaw = await context.callLlm(
              `You are ${persona.name}, a ${persona.role}.`,
              `In 2-3 sentences, what is your view on: ${config.scenario}? Rate confidence 0-10.`,
              config.modelTier,
              {
                simulationId: config.id,
                phase: "persona",
                round: roundNumber,
                personaId: persona.id,
                personaName: persona.name,
                slotId: persona.slotId,
                providerIdHint: persona.providerId,
                modelIdHint: persona.modelId,
              },
            );
            const retryRes = normaliseLlmResult(retryRaw);
            const { action: retryAction } = parsePersonaAction(retryRes.content, persona, roundNumber, roundNumber === 1 ? "opinion" : "reaction");
            retryAction.retryCount = 1;
            retryAction.providerId = retryRes.providerId;
            retryAction.modelId = retryRes.modelId;
            retryAction.slotId = persona.slotId;
            return retryAction;
          } catch {
            return makeNoResponseAction(persona, roundNumber);
          }
        }

        if (usedFallback) {
          return { ...action, _fallback: true };
        }
        return action;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const action = result.value as SimulationAction & { _fallback?: boolean };
        if (action._fallback) parseFailures++;
        delete action._fallback;
        actions.push(action);

        if (action.noResponse) {
          emitEvent(context, null, {
            type: "simulation:persona-error",
            simulationId: config.id,
            round: roundNumber,
            personaId: action.personaId,
            error: "No response after retries",
          });
        } else {
          emitEvent(context, null, {
            type: "simulation:persona-response",
            simulationId: config.id,
            round: roundNumber,
            personaId: action.personaId,
            personaName: action.personaName,
            confidence: action.confidence,
            contentPreview: action.content.slice(0, 200),
          });
        }
      } else {
        console.log(`[swarm:runner] Persona call rejected: ${result.reason}`);
      }
    }
  }

  return { actions, parseFailures };
}

function makeNoResponseAction(persona: SimulationPersona, round: number): SimulationAction {
  return {
    personaId: persona.id,
    personaName: persona.name,
    round,
    actionType: round === 1 ? "opinion" : "reaction",
    content: "(No response — persona was unable to provide analysis after retries.)",
    confidence: 0,
    reasoning: "Failed to generate response",
    timestamp: new Date().toISOString(),
    retryCount: 1,
    noResponse: true,
    slotId: persona.slotId,
  };
}

// ─── Synthesis ──────────────────────────────────────────────────────────────────

function buildSynthesisPrompt(
  config: SimulationConfig,
  roundNumber: number,
  totalRounds: number,
  actions: SimulationAction[],
): string {
  const isCompact = config.compactMode || config.modelTier === "small";

  // Filter out no-response actions for synthesis
  const validActions = actions.filter((a) => !a.noResponse);

  if (isCompact) {
    const bullets = validActions.map(
      (a, i) => `${i + 1}. ${a.personaName} (conf: ${a.confidence.toFixed(1)}): ${a.content.slice(0, 200)}`,
    );
    return `Synthesize these ${validActions.length} opinions on: ${config.scenario}

${bullets.join("\n")}

Reply with:
1. Consensus: ...
2. Disagreements: ...
3. Key factors: ...${roundNumber === totalRounds ? "\n4. Outcomes with probabilities: Outcome: XX%" : ""}`;
  }

  const perspectiveLines = validActions.map(
    (a) => `[${a.personaName}] (confidence: ${a.confidence.toFixed(2)})\n${a.content}`,
  );

  return `You are synthesizing round ${roundNumber} of ${totalRounds} in a multi-perspective simulation.

SCENARIO: ${config.scenario}
DOMAIN: ${config.domain}

${validActions.length} perspectives were collected:

${perspectiveLines.join("\n\n---\n\n")}

Synthesize these perspectives into a coherent summary:
1. What is the emerging consensus (if any)?
2. What are the key points of disagreement?
3. What factors are most frequently cited?
4. What is the range of confidence levels and what drives the variation?

${roundNumber === totalRounds
    ? "This is the FINAL round. Also provide a probability assessment for likely outcomes."
    : "Provide a balanced synthesis that will inform the next round of discussion."}

Be concise but substantive.`;
}

// ─── Round Execution ────────────────────────────────────────────────────────────

export async function runSimulationRound(
  state: SimulationState,
  roundNumber: number,
  context: SwarmExecutionContext,
): Promise<SimulationRound> {
  const priorSynthesis = roundNumber > 1 && state.rounds.length > 0
    ? state.rounds[state.rounds.length - 1].synthesis
    : null;

  const roundPrompt = buildRoundPrompt(
    state.config,
    roundNumber,
    state.config.roundCount,
    priorSynthesis,
  );

  const round: SimulationRound = {
    roundNumber,
    prompt: roundPrompt,
    actions: [],
    synthesis: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    parseFailures: 0,
  };

  emitEvent(context, state, {
    type: "simulation:round-start",
    simulationId: state.config.id,
    round: roundNumber,
    totalRounds: state.config.roundCount,
  });

  // Execute all persona calls with retry
  const { actions, parseFailures } = await executePersonaBatch(
    state.personas,
    roundPrompt,
    state.config,
    roundNumber,
    context,
  );
  round.actions = actions;
  round.parseFailures = parseFailures;

  // Synthesize round results (with graceful degradation)
  const validActions = round.actions.filter((a) => !a.noResponse);
  if (validActions.length > 0) {
    context.onProgress?.(`Round ${roundNumber}: synthesizing ${validActions.length} perspectives...`);
    try {
      const synthesisPrompt = buildSynthesisPrompt(
        state.config,
        roundNumber,
        state.config.roundCount,
        round.actions,
      );
      round.synthesis = normaliseLlmResult(await context.callLlm(
        "You are an expert synthesizer of diverse perspectives. Be balanced and analytical.",
        synthesisPrompt,
        state.config.synthesisModelTier === "large" ? "large" : "medium",
        {
          simulationId: state.config.id,
          phase: "synthesis",
          round: roundNumber,
        },
      )).content;

      emitEvent(context, state, {
        type: "simulation:round-synthesis",
        simulationId: state.config.id,
        round: roundNumber,
        synthesis: round.synthesis,
      });
    } catch (err) {
      console.log(`[swarm:runner] Round ${roundNumber} synthesis failed: ${err}`);
      // Fallback: basic concatenation of key points
      round.synthesis = `[Synthesis unavailable - ${validActions.length} perspectives collected. ` +
        `Average confidence: ${(validActions.reduce((s, a) => s + a.confidence, 0) / validActions.length).toFixed(2)}]`;
    }
  } else {
    round.synthesis = "[No valid persona responses in this round.]";
  }

  round.endedAt = new Date().toISOString();

  emitEvent(context, state, {
    type: "simulation:round-complete",
    simulationId: state.config.id,
    round: roundNumber,
    actionsCount: round.actions.length,
    parseFailures: round.parseFailures ?? 0,
  });

  return round;
}

// ─── Full Simulation ────────────────────────────────────────────────────────────

function buildFinalSynthesisPrompt(state: SimulationState): string {
  const isCompact = state.config.compactMode || state.config.modelTier === "small";

  const roundSummaries = state.rounds.map(
    (r) => `ROUND ${r.roundNumber}:\n${r.synthesis ?? "(no synthesis)"}`,
  );

  if (isCompact) {
    return `Simulation complete. ${state.config.roundCount} rounds, ${state.personas.length} personas.

Scenario: ${state.config.scenario}

${roundSummaries.join("\n\n")}

Provide:
1. Consensus view
2. Key disagreements
3. List outcomes with percentages, one per line: "Outcome: XX%"`;
  }

  return `You have completed a ${state.config.roundCount}-round multi-perspective simulation.

SCENARIO: ${state.config.scenario}
DOMAIN: ${state.config.domain}
PERSONAS: ${state.personas.length} diverse perspectives

Round summaries:
${roundSummaries.join("\n\n")}

Provide a FINAL SYNTHESIS with:

1. **Consensus View**: What did most perspectives converge on?
2. **Key Disagreements**: What remained contested and why?
3. **Probability Assessment**: For each distinct outcome discussed, assign a probability (0-100%). Output as JSON object mapping outcome labels to probabilities.
4. **Confidence Factors**: What would increase or decrease confidence in these probabilities?
5. **Blind Spots**: What perspectives or factors might be missing from this analysis?

Format the probability section as a JSON object:
\`\`\`json
{"outcome1": 0.XX, "outcome2": 0.XX, ...}
\`\`\``;
}

export function extractProbabilities(synthesis: string): Record<string, number> | null {
  // Strategy 1: JSON in code fences
  const jsonMatch = synthesis.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
      const result = normalizeProbs(parsed);
      if (result) return result;
    } catch {
      // noop
    }
  }

  // Strategy 2: Standalone JSON object
  const objMatch = synthesis.match(/\{[\s\S]*?\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]) as Record<string, unknown>;
      const result = normalizeProbs(parsed);
      if (result) return result;
    } catch {
      // noop
    }
  }

  // Strategy 3: Line-by-line "Outcome: XX%" or "Outcome - XX%"
  const lineResults: Record<string, number> = {};
  const lines = synthesis.split("\n");
  for (const line of lines) {
    // Match patterns: "Outcome: 45%", "Outcome - 0.45", "1. Outcome A - 60%"
    const match = line.match(/(?:\d+[.)]\s*)?(.+?)[\s:–—-]+\s*(\d+(?:\.\d+)?)\s*%/);
    if (match) {
      const outcome = match[1].trim().replace(/^\*\*|\*\*$/g, "").trim();
      const value = parseFloat(match[2]);
      if (outcome && !isNaN(value) && outcome.length < 200) {
        lineResults[outcome] = value / 100;
      }
    }
  }
  if (Object.keys(lineResults).length > 0) return lineResults;

  // Strategy 4: "Outcome: 0.45" format (no percent sign)
  for (const line of lines) {
    const match = line.match(/(?:\d+[.)]\s*)?(.+?)[\s:–—-]+\s*(0\.\d+)/);
    if (match) {
      const outcome = match[1].trim().replace(/^\*\*|\*\*$/g, "").trim();
      const value = parseFloat(match[2]);
      if (outcome && !isNaN(value) && outcome.length < 200) {
        lineResults[outcome] = value;
      }
    }
  }
  if (Object.keys(lineResults).length > 0) return lineResults;

  return null;
}

function normalizeProbs(parsed: Record<string, unknown>): Record<string, number> | null {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number") {
      result[key] = value > 1 ? value / 100 : Math.max(0, Math.min(1, value));
    } else if (typeof value === "string") {
      const num = parseFloat(value.replace("%", ""));
      if (!isNaN(num)) {
        result[key] = num > 1 ? num / 100 : Math.max(0, Math.min(1, num));
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeScenarioLabel(scenario: string): string {
  const trimmed = scenario.replace(/\s+/g, " ").trim();
  if (!trimmed) return "Scenario analysis";
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 117)}...`;
}

function pickConsensusLine(rawSynthesis: string): string {
  const lines = rawSynthesis.split("\n").map((line) => line.trim()).filter(Boolean);
  const consensusLine = lines.find((line) => /\b(consensus|most likely|majority|converge)\b/i.test(line));
  if (consensusLine) {
    return consensusLine.replace(/^[*-]\s*/, "");
  }
  return lines[0] ?? "No clear consensus emerged.";
}

function collectSignalLines(rawSynthesis: string, pattern: RegExp, limit: number): string[] {
  const lines = rawSynthesis
    .split("\n")
    .map((line) => line.trim().replace(/^[*-]\s*/, ""))
    .filter((line) => line.length > 0 && pattern.test(line));
  return [...new Set(lines)].slice(0, limit);
}

function buildConfidencePercent(state: SimulationState): number {
  if (state.probabilities && Object.keys(state.probabilities).length > 0) {
    const top = Math.max(...Object.values(state.probabilities));
    return Math.round(Math.max(0, Math.min(1, top)) * 100);
  }
  const actions = state.rounds.flatMap((round) => round.actions).filter((action) => !action.noResponse);
  if (actions.length === 0) {
    return 50;
  }
  const average = actions.reduce((sum, action) => sum + action.confidence, 0) / actions.length;
  return Math.round(Math.max(0, Math.min(1, average)) * 100);
}

export function formatSimulationResultSummary(
  state: SimulationState,
  rawSynthesis: string,
): string {
  const scenario = normalizeScenarioLabel(state.config.scenario);
  const confidencePercent = buildConfidencePercent(state);
  const consensus = pickConsensusLine(rawSynthesis);
  const keyRisks = collectSignalLines(
    rawSynthesis,
    /\b(risk|downside|failure|uncertain|threat|vulnerab|constraint|blind spot)\b/i,
    3,
  );
  const recommended = collectSignalLines(
    rawSynthesis,
    /\b(recommend|should|action|next step|plan)\b/i,
    1,
  )[0] ?? "Proceed in staged increments with explicit checkpoints.";
  const dissenting = collectSignalLines(
    rawSynthesis,
    /\b(disagree|dissent|contested|counter|minority|however)\b/i,
    2,
  );

  const riskText = keyRisks.length > 0 ? keyRisks.join("; ") : "No dominant single risk. Monitor execution drift.";
  const dissentText = dissenting.length > 0 ? dissenting.join("; ") : "No major dissent beyond normal uncertainty.";

  return [
    `## Simulation Result: ${scenario}`,
    `**Consensus:** ${consensus} (confidence: ${confidencePercent}%)`,
    `**Key Risks:** ${riskText}`,
    `**Recommended Action:** ${recommended}`,
    `**Dissenting Views:** ${dissentText}`,
  ].join("\n");
}

export async function runFullSimulation(
  state: SimulationState,
  context: SwarmExecutionContext,
): Promise<SimulationState> {
  const startTime = Date.now();

  // Prepare if not already done
  if (state.status === "created") {
    try {
      state = await prepareSimulation(state, context);
    } catch (err) {
      state.status = "failed";
      state.error = `Startup failure: ${err instanceof Error ? err.message : String(err)}`;
      saveSimulationState(state);
      emitEvent(context, state, { type: "simulation:error", simulationId: state.config.id, error: state.error });
      return state;
    }
  }

  if (state.status === "failed") {
    return state;
  }

  if (state.personas.length === 0) {
    state.status = "failed";
    state.error = "No personas were generated.";
    saveSimulationState(state);
    emitEvent(context, state, { type: "simulation:error", simulationId: state.config.id, error: state.error });
    return state;
  }

  state.status = "running";
  saveSimulationState(state);

  try {
    for (let r = 1; r <= state.config.roundCount; r++) {
      // Check cancel signal at round boundaries
      if (context.cancelSignal?.cancelled) {
        state.status = "paused";
        saveSimulationState(state);
        emitEvent(context, state, { type: "simulation:status", simulationId: state.config.id, status: "paused", message: "Simulation paused by user." });
        return state;
      }

      context.onProgress?.(`Starting round ${r} of ${state.config.roundCount}...`);
      const round = await runSimulationRound(state, r, context);
      state.rounds.push(round);
      state.currentRound = r;
      saveSimulationState(state);
    }

    // Check cancel before final synthesis
    if (context.cancelSignal?.cancelled) {
      state.status = "paused";
      saveSimulationState(state);
      return state;
    }

    // Final synthesis (with graceful degradation)
    context.onProgress?.("Generating final synthesis and probability assessment...");
    try {
      const finalPrompt = buildFinalSynthesisPrompt(state);
      const rawFinalSynthesis = normaliseLlmResult(await context.callLlm(
        "You are an expert analyst synthesizing a multi-perspective simulation into actionable insights.",
        finalPrompt,
        "large",
        {
          simulationId: state.config.id,
          phase: "synthesis",
          round: state.config.roundCount,
        },
      )).content;
      state.probabilities = extractProbabilities(rawFinalSynthesis);
      state.finalSynthesis = [
        formatSimulationResultSummary(state, rawFinalSynthesis),
        "",
        "### Detailed Synthesis",
        rawFinalSynthesis.trim(),
      ].join("\n");
    } catch (err) {
      console.log(`[swarm:runner] Final synthesis failed: ${err}`);
      // Keep whatever we have — don't crash the whole simulation
      state.finalSynthesis = state.finalSynthesis ?? "[Final synthesis unavailable due to error.]";
      state.probabilities = null;
    }

    state.status = "completed";

    emitEvent(context, state, {
      type: "simulation:final-synthesis",
      simulationId: state.config.id,
      synthesis: state.finalSynthesis ?? "",
      probabilities: state.probabilities,
    });
    emitEvent(context, state, {
      type: "simulation:complete",
      simulationId: state.config.id,
      status: "completed",
      duration: Date.now() - startTime,
    });
  } catch (err) {
    state.status = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    emitEvent(context, state, { type: "simulation:error", simulationId: state.config.id, error: state.error });
  }

  saveSimulationState(state);
  return state;
}

// ─── Interview ──────────────────────────────────────────────────────────────────

export async function interviewPersona(
  state: SimulationState,
  personaId: string,
  question: string,
  context: SwarmExecutionContext,
): Promise<string> {
  const persona = state.personas.find((p) => p.id === personaId);
  if (!persona) return `Error: persona "${personaId}" not found.`;

  const history = state.rounds
    .flatMap((r) => r.actions.filter((a) => a.personaId === personaId))
    .map((a) => `Round ${a.round}: ${a.content}`)
    .join("\n\n");

  const systemPrompt = buildPersonaSystemPrompt(persona, state.config);
  const interviewPrompt = `You previously participated in a simulation about: ${state.config.scenario}

Your prior analysis across rounds:
${history || "(no prior actions recorded)"}

Now answer this follow-up question:
${question}

Stay in character. Reference your prior analysis where relevant.`;

  return normaliseLlmResult(await context.callLlm(
    systemPrompt,
    interviewPrompt,
    state.config.modelTier,
    {
      simulationId: state.config.id,
      phase: "persona",
      personaId: persona.id,
      personaName: persona.name,
      slotId: persona.slotId,
      providerIdHint: persona.providerId,
      modelIdHint: persona.modelId,
    },
  )).content;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function emitEvent(context: SwarmExecutionContext, _state: SimulationState | null, event: SimulationEvent): void {
  try {
    context.onEvent?.(event);
  } catch {
    // Never let event emission crash the simulation
  }
}
