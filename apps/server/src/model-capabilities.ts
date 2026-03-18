/**
 * Model Capability Profiles
 *
 * Infers a model's capabilities from its ID and context window size.
 * Used to adapt prompt budgets, tool counts, and instruction complexity
 * so that small models (0.8B–7B) work effectively while frontier models
 * get the full feature set.
 */

export type ModelTier = "tiny" | "small" | "medium" | "large" | "frontier";

export interface ModelCapabilityProfile {
  /** Effective context window in tokens. */
  contextWindow: number;
  /** 0–1: how well does this model follow complex, multi-step instructions? */
  instructionFollowing: number;
  /** 0–1: how well does this model use tool/function calling? */
  toolUseQuality: number;
  /** 0–1: reasoning and multi-step planning ability. */
  reasoningDepth: number;
  /** Maximum number of tools the model can handle effectively. */
  maxEffectiveTools: number;
  /** Can this model produce reliable structured JSON output? */
  reliableJsonOutput: boolean;
  /** Model size tier for prompt adaptation. */
  tier: ModelTier;
}

// ─── Tier Defaults ──────────────────────────────────────────────────────────

const TIER_DEFAULTS: Record<ModelTier, Omit<ModelCapabilityProfile, "contextWindow">> = {
  frontier: {
    instructionFollowing: 0.95,
    toolUseQuality: 0.95,
    reasoningDepth: 0.95,
    maxEffectiveTools: 40,
    reliableJsonOutput: true,
    tier: "frontier",
  },
  large: {
    instructionFollowing: 0.85,
    toolUseQuality: 0.85,
    reasoningDepth: 0.80,
    maxEffectiveTools: 30,
    reliableJsonOutput: true,
    tier: "large",
  },
  medium: {
    instructionFollowing: 0.70,
    toolUseQuality: 0.70,
    reasoningDepth: 0.60,
    maxEffectiveTools: 15,
    reliableJsonOutput: true,
    tier: "medium",
  },
  small: {
    instructionFollowing: 0.50,
    toolUseQuality: 0.40,
    reasoningDepth: 0.35,
    maxEffectiveTools: 8,
    reliableJsonOutput: false,
    tier: "small",
  },
  tiny: {
    instructionFollowing: 0.25,
    toolUseQuality: 0.15,
    reasoningDepth: 0.15,
    maxEffectiveTools: 3,
    reliableJsonOutput: false,
    tier: "tiny",
  },
};

// ─── Detection Patterns ─────────────────────────────────────────────────────

// Order matters: more specific patterns first.
const MODEL_TIER_PATTERNS: Array<{ pattern: RegExp; tier: ModelTier; defaultContext: number }> = [
  // ── Frontier ──
  { pattern: /claude-.*opus|claude-opus/i, tier: "frontier", defaultContext: 200_000 },
  { pattern: /gpt-4o(?!-mini)/i, tier: "frontier", defaultContext: 128_000 },
  { pattern: /gpt-4-turbo/i, tier: "frontier", defaultContext: 128_000 },
  { pattern: /gemini-.*ultra/i, tier: "frontier", defaultContext: 200_000 },
  { pattern: /o[134]-/i, tier: "frontier", defaultContext: 128_000 },
  { pattern: /deepseek-r1(?!.*(?:7b|8b|14b|1\.5b))/i, tier: "frontier", defaultContext: 128_000 },

  // ── Large ──
  { pattern: /claude-.*sonnet/i, tier: "large", defaultContext: 200_000 },
  { pattern: /gpt-4(?!o|-turbo)/i, tier: "large", defaultContext: 128_000 },
  { pattern: /gemini-.*pro/i, tier: "large", defaultContext: 128_000 },
  { pattern: /llama[- ]?3\.?[12]?[- ]?405b/i, tier: "large", defaultContext: 128_000 },
  { pattern: /qwen[- ]?2\.?5?[- ]?72b/i, tier: "large", defaultContext: 128_000 },
  { pattern: /mistral[- ]?large/i, tier: "large", defaultContext: 128_000 },
  { pattern: /command-r-plus/i, tier: "large", defaultContext: 128_000 },

  // ── Medium ──
  { pattern: /claude-.*haiku/i, tier: "medium", defaultContext: 200_000 },
  { pattern: /gpt-4o-mini/i, tier: "medium", defaultContext: 128_000 },
  { pattern: /gpt-3\.5/i, tier: "medium", defaultContext: 16_000 },
  { pattern: /gemini-.*flash/i, tier: "medium", defaultContext: 128_000 },
  { pattern: /llama[- ]?3\.?[12]?[- ]?70b/i, tier: "medium", defaultContext: 128_000 },
  { pattern: /qwen[- ]?2\.?5?[- ]?(32b|14b)/i, tier: "medium", defaultContext: 32_000 },
  { pattern: /mistral[- ]?(medium|nemo)/i, tier: "medium", defaultContext: 32_000 },
  { pattern: /mixtral/i, tier: "medium", defaultContext: 32_000 },
  { pattern: /command-r(?!-plus)/i, tier: "medium", defaultContext: 128_000 },
  { pattern: /deepseek-v[23]/i, tier: "medium", defaultContext: 128_000 },
  { pattern: /deepseek-r1[- ]?(14b|32b|70b)/i, tier: "medium", defaultContext: 64_000 },
  { pattern: /codestral/i, tier: "medium", defaultContext: 32_000 },

  // ── Small ──
  { pattern: /llama[- ]?3\.?[12]?[- ]?8b/i, tier: "small", defaultContext: 8_000 },
  { pattern: /mistral[- ]?7b/i, tier: "small", defaultContext: 8_000 },
  { pattern: /qwen[- ]?2\.?5?[- ]?7b/i, tier: "small", defaultContext: 8_000 },
  { pattern: /phi[- ]?[34]/i, tier: "small", defaultContext: 16_000 },
  { pattern: /gemma[- ]?2?[- ]?9b/i, tier: "small", defaultContext: 8_000 },
  { pattern: /deepseek-r1[- ]?(7b|8b)/i, tier: "small", defaultContext: 8_000 },
  { pattern: /yi[- ]?1?\.?5?[- ]?6b/i, tier: "small", defaultContext: 4_000 },
  { pattern: /codegemma/i, tier: "small", defaultContext: 8_000 },

  // ── Tiny ──
  { pattern: /llama[- ]?3\.?[12]?[- ]?(1b|3b)/i, tier: "tiny", defaultContext: 4_000 },
  { pattern: /qwen[- ]?2\.?5?[- ]?(0\.5b|1\.5b|3b)/i, tier: "tiny", defaultContext: 4_000 },
  { pattern: /phi[- ]?[34][- ]?mini/i, tier: "tiny", defaultContext: 4_000 },
  { pattern: /smollm/i, tier: "tiny", defaultContext: 2_000 },
  { pattern: /tinyllama/i, tier: "tiny", defaultContext: 2_000 },
  { pattern: /gemma[- ]?2?[- ]?2b/i, tier: "tiny", defaultContext: 4_000 },
  { pattern: /deepseek-r1[- ]?1\.5b/i, tier: "tiny", defaultContext: 4_000 },
];

// ─── Inference ──────────────────────────────────────────────────────────────

export function inferModelCapabilities(
  modelId: string,
  contextWindow?: number | null,
): ModelCapabilityProfile {
  const id = modelId.trim();
  if (!id) {
    const defaults = TIER_DEFAULTS.medium;
    return { ...defaults, contextWindow: contextWindow ?? 16_000 };
  }

  for (const entry of MODEL_TIER_PATTERNS) {
    if (entry.pattern.test(id)) {
      const defaults = TIER_DEFAULTS[entry.tier];
      return {
        ...defaults,
        contextWindow: contextWindow ?? entry.defaultContext,
      };
    }
  }

  // Fallback heuristic: check for size indicators in the model ID.
  const sizeMatch = id.match(/(\d+(?:\.\d+)?)\s*[bB]/);
  if (sizeMatch) {
    const sizeB = parseFloat(sizeMatch[1]);
    if (sizeB <= 3) {
      return { ...TIER_DEFAULTS.tiny, contextWindow: contextWindow ?? 4_000 };
    }
    if (sizeB <= 13) {
      return { ...TIER_DEFAULTS.small, contextWindow: contextWindow ?? 8_000 };
    }
    if (sizeB <= 40) {
      return { ...TIER_DEFAULTS.medium, contextWindow: contextWindow ?? 32_000 };
    }
    if (sizeB <= 100) {
      return { ...TIER_DEFAULTS.large, contextWindow: contextWindow ?? 128_000 };
    }
    return { ...TIER_DEFAULTS.frontier, contextWindow: contextWindow ?? 200_000 };
  }

  // Default: assume medium.
  return { ...TIER_DEFAULTS.medium, contextWindow: contextWindow ?? 16_000 };
}

// ─── Prompt Budget ──────────────────────────────────────────────────────────

export interface PromptBudget {
  /** Total context window tokens. */
  totalTokens: number;
  /** Max tokens for the system prompt (role instructions, shared context). */
  systemPromptTokens: number;
  /** Max tokens for tool/function definitions. */
  toolSchemaTokens: number;
  /** Max tokens for memory context. */
  memoryTokens: number;
  /** Max tokens for conversation history. */
  conversationTokens: number;
  /** Tokens reserved for the model's response. */
  responseTokens: number;
}

export function calculatePromptBudget(profile: ModelCapabilityProfile): PromptBudget {
  const total = profile.contextWindow;
  const response = Math.min(4096, Math.floor(total * 0.20));
  const available = total - response;

  switch (profile.tier) {
    case "tiny":
      return {
        totalTokens: total,
        systemPromptTokens: Math.floor(available * 0.15),
        toolSchemaTokens: Math.floor(available * 0.10),
        memoryTokens: Math.floor(available * 0.05),
        conversationTokens: Math.floor(available * 0.50),
        responseTokens: response,
      };
    case "small":
      return {
        totalTokens: total,
        systemPromptTokens: Math.floor(available * 0.20),
        toolSchemaTokens: Math.floor(available * 0.15),
        memoryTokens: Math.floor(available * 0.10),
        conversationTokens: Math.floor(available * 0.35),
        responseTokens: response,
      };
    case "medium":
      return {
        totalTokens: total,
        systemPromptTokens: Math.floor(available * 0.25),
        toolSchemaTokens: Math.floor(available * 0.15),
        memoryTokens: Math.floor(available * 0.15),
        conversationTokens: Math.floor(available * 0.25),
        responseTokens: response,
      };
    default:
      // large + frontier get generous allocations.
      return {
        totalTokens: total,
        systemPromptTokens: Math.floor(available * 0.30),
        toolSchemaTokens: Math.floor(available * 0.15),
        memoryTokens: Math.floor(available * 0.15),
        conversationTokens: Math.floor(available * 0.20),
        responseTokens: response,
      };
  }
}

// ─── Tool Filtering ─────────────────────────────────────────────────────────

export interface PrioritizedTool {
  name: string;
  priority: number;
  [key: string]: unknown;
}

/**
 * Filter and sort tools by priority, capping at the model's effective tool limit.
 * Lower priority number = more essential (included first).
 */
export function filterToolsForModel<T extends PrioritizedTool>(
  tools: T[],
  profile: ModelCapabilityProfile,
): T[] {
  const sorted = [...tools].sort((a, b) => a.priority - b.priority);
  return sorted.slice(0, profile.maxEffectiveTools);
}

/**
 * Should metacognition, attention context, and procedure context be included
 * in the system prompt for this model tier?
 */
export function shouldIncludeAdvancedPromptSections(tier: ModelTier): boolean {
  return tier !== "tiny" && tier !== "small";
}

/**
 * Should reflection loops be enabled for this model?
 */
export function shouldEnableReflection(tier: ModelTier): boolean {
  return tier === "large" || tier === "frontier";
}

/**
 * Should simulation recommendations be shown for this model?
 */
export function shouldIncludeSimulationHints(tier: ModelTier): boolean {
  return tier !== "tiny" && tier !== "small";
}
