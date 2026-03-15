import {
  deriveCompressionPromptBudget,
  estimateTextTokens,
  resolveProviderContextWindowTokens,
} from "@ember/core";
import type { MemoryConfig, MemorySearchQuery, Provider, Role, Settings } from "@ember/core";

const MEMORY_CONTEXT_SOFT_CAP_TOKENS = 64_000;
const MEMORY_CHAR_BUDGET_RATIO = 0.028;
const PROCEDURE_CHAR_BUDGET_RATIO = 0.014;
const MIN_MEMORY_INJECTION_CHARS = 220;
const MIN_PROCEDURE_INJECTION_CHARS = 140;
const MIN_MEMORY_RESERVE_TOKENS = 96;
const MIN_PROCEDURE_RESERVE_TOKENS = 48;
const MIN_PROMPT_TOKENS_AFTER_MEMORY_RESERVE = 1_000;
// Any model under 50k should always use compact prompts — every token counts.
// Models under 16k get ultra-compact (even fewer tools/workflows).
const COMPACT_CONTEXT_WINDOW_TOKENS = 50_000;
const ULTRA_COMPACT_CONTEXT_WINDOW_TOKENS = 16_000;

export interface AdaptiveMemoryRetrievalBudget {
  maxResults: number;
  minScore: number;
  maxInjectedItems: number;
  maxInjectedChars: number;
  reservedPromptTokens: number;
}

export interface ExecutionPromptBudget {
  contextWindowTokens: number;
  maxPromptTokens: number;
  targetPromptTokens: number;
  memory: AdaptiveMemoryRetrievalBudget;
  procedures: AdaptiveMemoryRetrievalBudget;
}

export interface ExecutionModelProfile {
  compactRolePrompt: boolean;
  compactToolPrompt: boolean;
  compactToolset: boolean;
  /** Ultra-compact: strip optional properties and descriptions from tool schemas. */
  ultraCompactToolset: boolean;
}

export function resolveAdaptiveMemoryRetrievalBudget(
  memory: MemoryConfig,
  contextWindowTokens: number,
): AdaptiveMemoryRetrievalBudget {
  const normalizedContextWindowTokens = Math.max(4_000, Math.floor(contextWindowTokens));
  const maxInjectedItems = Math.max(
    1,
    Math.min(memory.retrieval.maxInjectedItems, Math.floor(normalizedContextWindowTokens / 10_000) + 1),
  );
  const maxInjectedChars = Math.max(
    MIN_MEMORY_INJECTION_CHARS,
    Math.min(memory.retrieval.maxInjectedChars, Math.floor(normalizedContextWindowTokens * MEMORY_CHAR_BUDGET_RATIO)),
  );
  const maxResults = Math.max(
    maxInjectedItems,
    Math.min(memory.retrieval.maxResults, maxInjectedItems + 2),
  );
  const contextPressure =
    Math.max(0, MEMORY_CONTEXT_SOFT_CAP_TOKENS - normalizedContextWindowTokens) /
    MEMORY_CONTEXT_SOFT_CAP_TOKENS;
  const minScore = Math.min(0.6, memory.retrieval.minScore + contextPressure * 0.12);
  const approxPerItemChars = Math.max(48, Math.floor(maxInjectedChars / maxInjectedItems));
  const reserveText = [
    "Persistent memory:",
    ...Array.from({ length: maxInjectedItems }, () => `- Memory: ${"x".repeat(approxPerItemChars)}`),
  ].join("\n");
  const reservedPromptTokens = Math.max(
    MIN_MEMORY_RESERVE_TOKENS,
    estimateTextTokens(reserveText),
  );

  return {
    maxResults,
    minScore,
    maxInjectedItems,
    maxInjectedChars,
    reservedPromptTokens,
  };
}

export function toMemorySearchBudgetOverrides(
  budget: AdaptiveMemoryRetrievalBudget,
): Pick<MemorySearchQuery, "maxResults" | "minScore" | "maxInjectedItems" | "maxInjectedChars"> {
  return {
    maxResults: budget.maxResults,
    minScore: budget.minScore,
    maxInjectedItems: budget.maxInjectedItems,
    maxInjectedChars: budget.maxInjectedChars,
  };
}

export function resolveAdaptiveProcedureRetrievalBudget(
  memory: MemoryConfig,
  contextWindowTokens: number,
): AdaptiveMemoryRetrievalBudget {
  const normalizedContextWindowTokens = Math.max(4_000, Math.floor(contextWindowTokens));
  const maxInjectedItems = Math.max(
    1,
    Math.min(2, Math.min(memory.retrieval.maxInjectedItems, Math.floor(normalizedContextWindowTokens / 32_000) + 1)),
  );
  const maxInjectedChars = Math.max(
    MIN_PROCEDURE_INJECTION_CHARS,
    Math.min(memory.retrieval.maxInjectedChars, Math.floor(normalizedContextWindowTokens * PROCEDURE_CHAR_BUDGET_RATIO)),
  );
  const maxResults = Math.max(maxInjectedItems, Math.min(memory.retrieval.maxResults, maxInjectedItems + 1));
  const contextPressure =
    Math.max(0, MEMORY_CONTEXT_SOFT_CAP_TOKENS - normalizedContextWindowTokens) /
    MEMORY_CONTEXT_SOFT_CAP_TOKENS;
  const minScore = Math.min(0.72, memory.retrieval.minScore + 0.24 + contextPressure * 0.18);
  const approxPerItemChars = Math.max(64, Math.floor(maxInjectedChars / maxInjectedItems));
  const reserveText = [
    "Learned procedures:",
    ...Array.from({ length: maxInjectedItems }, () => `- Procedure: ${"x".repeat(approxPerItemChars)}`),
  ].join("\n");
  const reservedPromptTokens = Math.max(
    MIN_PROCEDURE_RESERVE_TOKENS,
    estimateTextTokens(reserveText),
  );

  return {
    maxResults,
    minScore,
    maxInjectedItems,
    maxInjectedChars,
    reservedPromptTokens,
  };
}

export function resolveExecutionPromptBudget(
  settings: Settings,
  provider: Provider | null,
): ExecutionPromptBudget {
  const contextWindowTokens = resolveProviderContextWindowTokens(provider, settings);
  const compressionBudget = deriveCompressionPromptBudget(
    settings.compression,
    contextWindowTokens,
  );
  const memoryBudget = resolveAdaptiveMemoryRetrievalBudget(settings.memory, contextWindowTokens);
  const procedureBudget = resolveAdaptiveProcedureRetrievalBudget(settings.memory, contextWindowTokens);
  const reservedPromptTokens = settings.memory.enabled
    ? Math.min(
        Math.max(0, compressionBudget.maxPromptTokens - MIN_PROMPT_TOKENS_AFTER_MEMORY_RESERVE),
        memoryBudget.reservedPromptTokens + procedureBudget.reservedPromptTokens,
      )
    : 0;
  const maxPromptTokens = Math.max(
    1_000,
    compressionBudget.maxPromptTokens - reservedPromptTokens,
  );
  const targetPromptTokens = Math.max(
    1_000,
    Math.min(maxPromptTokens, compressionBudget.targetPromptTokens - reservedPromptTokens),
  );

  return {
    contextWindowTokens,
    maxPromptTokens,
    targetPromptTokens,
    memory: {
      ...memoryBudget,
      reservedPromptTokens: memoryBudget.reservedPromptTokens,
    },
    procedures: {
      ...procedureBudget,
      reservedPromptTokens: procedureBudget.reservedPromptTokens,
    },
  };
}

/**
 * Pressure-based prompt compaction threshold.
 * When conversation fill ratio exceeds this, compact prompts activate
 * regardless of context window size — saves 3-5k tokens per turn.
 */
const PRESSURE_COMPACT_FILL_RATIO = 0.70;

export function resolveExecutionModelProfile(
  settings: Settings,
  provider: Provider | null,
  role: Role,
  contextPressure?: number,
): ExecutionModelProfile {
  const contextWindowTokens = resolveProviderContextWindowTokens(provider, settings);
  // All models under 50k get compact prompts — a 35k model can't afford 3.7k of prompt overhead
  const compactProfile = contextWindowTokens <= COMPACT_CONTEXT_WINDOW_TOKENS;
  const ultraCompactProfile = contextWindowTokens <= ULTRA_COMPACT_CONTEXT_WINDOW_TOKENS;
  const pressureCompact = (contextPressure ?? 0) >= PRESSURE_COMPACT_FILL_RATIO;
  const compactRolePrompt = compactProfile || ultraCompactProfile || pressureCompact;

  return {
    compactRolePrompt,
    compactToolPrompt: compactRolePrompt,
    compactToolset: compactRolePrompt,
    ultraCompactToolset: ultraCompactProfile || (pressureCompact && compactProfile),
  };
}
