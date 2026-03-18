import type { ChatMessage } from "@ember/core";
import type { TaskAssessment } from "./metacognition.js";
import type { ModelTier } from "./model-capabilities.js";
import { shouldEnableReflection } from "./model-capabilities.js";

export interface ReflectionConfig {
  enabled: boolean;
  /** Maximum reflection rounds per response. Default 1. */
  maxReflectionRounds: number;
  /** Minimum complexity score to trigger reflection. Default 0.6. */
  triggerOnComplexity: number;
  /** Minimum tool error count to trigger reflection. Default 2. */
  triggerOnToolErrors: number;
}

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  enabled: false,
  maxReflectionRounds: 1,
  triggerOnComplexity: 0.6,
  triggerOnToolErrors: 2,
};

export interface ReflectionResult {
  revised: boolean;
  originalResponse: string;
  revisedResponse: string | null;
  reflectionNotes: string[];
  roundsUsed: number;
}

export interface ReflectionInput {
  response: string;
  assessment: TaskAssessment;
  errorCount: number;
  conversation: ChatMessage[];
  config: ReflectionConfig;
  modelTier: ModelTier;
  executeReflection: (prompt: string) => Promise<string>;
}

function buildReflectionPrompt(response: string, assessment: TaskAssessment): string {
  const truncatedResponse = response.length > 2000
    ? response.slice(0, 2000) + "\n... (truncated)"
    : response;
  return [
    "Review the following response for quality, correctness, and completeness.",
    "",
    `Task complexity: ${assessment.complexity.toFixed(2)}`,
    `Suggested tier: ${assessment.suggestedTier}`,
    "",
    "--- RESPONSE TO REVIEW ---",
    truncatedResponse,
    "--- END RESPONSE ---",
    "",
    "Evaluate:",
    "1. Does the response address the user's request fully?",
    "2. Are there factual errors, missing steps, or logical gaps?",
    "3. Is the response well-structured and clear?",
    "",
    "If the response needs revision, output EXACTLY:",
    "REVISE: <your improved version>",
    "",
    "If the response is good as-is, output EXACTLY:",
    "APPROVE",
    "",
    "If you have notes but no revision needed, output:",
    "NOTE: <your observation>",
  ].join("\n");
}

function parseReflectionOutput(output: string): {
  action: "approve" | "revise" | "note";
  content: string | null;
} {
  const trimmed = output.trim();
  if (trimmed.startsWith("REVISE:")) {
    return { action: "revise", content: trimmed.slice("REVISE:".length).trim() };
  }
  if (trimmed.startsWith("APPROVE")) {
    return { action: "approve", content: null };
  }
  if (trimmed.startsWith("NOTE:")) {
    return { action: "note", content: trimmed.slice("NOTE:".length).trim() };
  }
  // If the model doesn't follow the format, treat as approve
  return { action: "approve", content: null };
}

export function shouldReflect(input: {
  config: ReflectionConfig;
  assessment: TaskAssessment;
  errorCount: number;
  modelTier: ModelTier;
}): boolean {
  if (!input.config.enabled) {
    return false;
  }
  if (!shouldEnableReflection(input.modelTier)) {
    return false;
  }
  if (input.assessment.complexity >= input.config.triggerOnComplexity) {
    return true;
  }
  if (input.errorCount >= input.config.triggerOnToolErrors) {
    return true;
  }
  return false;
}

export async function reflectOnResponse(input: ReflectionInput): Promise<ReflectionResult> {
  const noRevision: ReflectionResult = {
    revised: false,
    originalResponse: input.response,
    revisedResponse: null,
    reflectionNotes: [],
    roundsUsed: 0,
  };

  if (!shouldReflect(input)) {
    return noRevision;
  }

  const notes: string[] = [];
  let currentResponse = input.response;
  let revised = false;
  let roundsUsed = 0;

  for (let round = 0; round < input.config.maxReflectionRounds; round++) {
    roundsUsed++;
    const prompt = buildReflectionPrompt(currentResponse, input.assessment);
    let reflectionOutput: string;
    try {
      reflectionOutput = await input.executeReflection(prompt);
    } catch {
      notes.push(`Reflection round ${round + 1} failed — using current response.`);
      break;
    }

    const parsed = parseReflectionOutput(reflectionOutput);
    if (parsed.action === "approve") {
      break;
    }
    if (parsed.action === "note" && parsed.content) {
      notes.push(parsed.content);
      break;
    }
    if (parsed.action === "revise" && parsed.content) {
      currentResponse = parsed.content;
      revised = true;
      notes.push(`Revised in round ${round + 1}.`);
    }
  }

  return {
    revised,
    originalResponse: input.response,
    revisedResponse: revised ? currentResponse : null,
    reflectionNotes: notes,
    roundsUsed,
  };
}
