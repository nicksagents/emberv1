function parseEnvInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEnvFloat(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min?: number, max?: number): number {
  const lower = min != null ? Math.max(min, value) : value;
  return max != null ? Math.min(max, lower) : lower;
}

export function envInt(
  name: string,
  fallback: number,
  options: {
    min?: number;
    max?: number;
  } = {},
): number {
  const parsed = parseEnvInt(process.env[name]);
  if (parsed == null) {
    return clamp(fallback, options.min, options.max);
  }
  return clamp(parsed, options.min, options.max);
}

export function envFloat(
  name: string,
  fallback: number,
  options: {
    min?: number;
    max?: number;
  } = {},
): number {
  const parsed = parseEnvFloat(process.env[name]);
  if (parsed == null) {
    return clamp(fallback, options.min, options.max);
  }
  return clamp(parsed, options.min, options.max);
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return fallback;
}

export const CONFIG = {
  contextWindow: {
    defaultTokens: envInt("EMBER_CONTEXT_WINDOW", 100_000, { min: 4_000 }),
    localTokens: envInt("EMBER_LOCAL_CONTEXT_WINDOW", 16_000, { min: 4_000 }),
    remoteCeilingTokens: envInt("EMBER_REMOTE_CONTEXT_CEILING", 300_000, { min: 4_000 }),
  },
  toolLoop: {
    defaultLimit: envInt("EMBER_TOOL_LOOP_LIMIT", 200, { min: 1 }),
    maxLimit: envInt("EMBER_MAX_TOOL_LOOP_LIMIT", 4_000, { min: 1 }),
  },
  parallel: {
    maxTasks: envInt("EMBER_MAX_PARALLEL_TASKS", 8, { min: 1, max: 12 }),
    maxDepth: envInt("EMBER_MAX_PARALLEL_DEPTH", 1, { min: 0, max: 4 }),
    maxConcurrency: envInt("EMBER_MAX_PARALLEL_CONCURRENCY", 4, { min: 1, max: 8 }),
    taskTimeoutMs: envInt("EMBER_PARALLEL_TASK_TIMEOUT", 180_000, { min: 5_000 }),
    minTaskTimeoutMs: envInt("EMBER_PARALLEL_TASK_TIMEOUT_MIN", 5_000, { min: 1_000 }),
    defaultTaskTimeoutMs: envInt("EMBER_PARALLEL_TASK_TIMEOUT_DEFAULT", 60_000, { min: 1_000 }),
    maxTraceCount: envInt("EMBER_PARALLEL_TRACE_COUNT", 120, { min: 8 }),
  },
  terminal: {
    sudoTtlMs: envInt("EMBER_SUDO_TTL_MS", 5 * 60_000, { min: 30_000 }),
    sudoRateWindowMs: envInt("EMBER_SUDO_RATE_WINDOW_MS", 60_000, { min: 1_000 }),
    sudoRateLimit: envInt("EMBER_SUDO_RATE_LIMIT", 3, { min: 1, max: 20 }),
    defaultTimeoutMs: envInt("EMBER_TERMINAL_TIMEOUT", 120_000, { min: 1_000 }),
    maxTimeoutMs: envInt("EMBER_TERMINAL_MAX_TIMEOUT", 600_000, { min: 5_000 }),
    maxOutputChars: envInt("EMBER_TERMINAL_MAX_OUTPUT", 4_000_000, { min: 10_000 }),
    sessionIdleTtlMs: envInt("EMBER_TERMINAL_SESSION_IDLE_TTL_MS", 15 * 60_000, { min: 10_000 }),
    approvalTtlMs: envInt("EMBER_TERMINAL_APPROVAL_TTL_MS", 30 * 60_000, { min: 30_000 }),
  },
  mcp: {
    defaultTimeoutMs: envInt("EMBER_MCP_TIMEOUT", 30_000, { min: 1_000 }),
  },
  compaction: {
    stage1: envFloat("EMBER_COMPACTION_STAGE1", 0.40, { min: 0.05, max: 0.95 }),
    stage2: envFloat("EMBER_COMPACTION_STAGE2", 0.60, { min: 0.05, max: 0.95 }),
    stage3: envFloat("EMBER_COMPACTION_STAGE3", 0.75, { min: 0.05, max: 0.98 }),
  },
  checkpoints: {
    retention: envInt("EMBER_CHECKPOINT_RETENTION", 50, { min: 1, max: 1_000 }),
  },
  failover: {
    enabled: envBool("EMBER_ENABLE_FAILOVER", true),
    failureThreshold: envInt("EMBER_FAILOVER_FAILURE_THRESHOLD", 2, { min: 1, max: 5 }),
    maxSwitchesPerTurn: envInt("EMBER_FAILOVER_MAX_SWITCHES_PER_TURN", 3, { min: 0, max: 8 }),
    circuitBreakerThreshold: envInt("EMBER_CB_THRESHOLD", 3, { min: 1, max: 10 }),
    circuitBreakerResetMs: envInt("EMBER_CB_RESET_MS", 60_000, { min: 1_000 }),
    maxEventHistory: envInt("EMBER_FAILOVER_EVENT_HISTORY", 240, { min: 8 }),
  },
  network: {
    webHost: process.env.EMBER_WEB_HOST || "127.0.0.1",
    webPort: envInt("EMBER_WEB_PORT", 3000, { min: 1 }),
    apiHost: process.env.EMBER_RUNTIME_HOST || "127.0.0.1",
    apiPort: envInt("EMBER_RUNTIME_PORT", 3005, { min: 1 }),
  },
  prompt: {
    preserveRecentMessages: envInt("EMBER_PRESERVE_RECENT", 8, { min: 1 }),
    minRecentMessages: envInt("EMBER_MIN_RECENT", 4, { min: 1 }),
  },
  request: {
    maxAgentLoop: envInt("EMBER_MAX_AGENT_LOOP", 16, { min: 1, max: 128 }),
    maxRoleVisits: envInt("EMBER_MAX_ROLE_VISITS", 5, { min: 1, max: 32 }),
    dispatchTimeoutMs: envInt("EMBER_DISPATCH_TIMEOUT_MS", 10_000, { min: 500 }),
    shutdownDrainMs: envInt("EMBER_SHUTDOWN_DRAIN_MS", 30_000, { min: 1_000 }),
  },
  memory: {
    consolidationIdleThresholdMs: envInt("EMBER_MEMORY_IDLE_CONSOLIDATION_MS", 4 * 60 * 60 * 1_000, { min: 60_000 }),
  },
  audit: {
    maxLogSizeBytes: envInt("EMBER_AUDIT_LOG_MAX_SIZE_BYTES", 50 * 1024 * 1024, { min: 1_024 }),
    maxRotatedLogs: envInt("EMBER_AUDIT_LOG_MAX_ROTATED", 5, { min: 1, max: 50 }),
  },
  tools: {
    maxReadChars: envInt("EMBER_MAX_READ_CHARS", 100_000, { min: 1_000 }),
    defaultDirectoryLimit: envInt("EMBER_DEFAULT_DIR_LIMIT", 200, { min: 10, max: 10_000 }),
    webSearchTimeoutMs: envInt("EMBER_WEB_SEARCH_TIMEOUT", 10_000, { min: 1_000 }),
  },
  attention: {
    maxContexts: envInt("EMBER_ATTENTION_MAX_CONTEXTS", 500, { min: 10, max: 10_000 }),
    maxCompletedSteps: envInt("EMBER_ATTENTION_MAX_STEPS", 24, { min: 4, max: 100 }),
    maxWorkingMemory: envInt("EMBER_ATTENTION_MAX_WORKING_MEMORY", 10, { min: 2, max: 50 }),
    maxItemLength: envInt("EMBER_ATTENTION_MAX_ITEM_LENGTH", 240, { min: 40, max: 1_000 }),
  },
  sessionRecall: {
    defaultMaxResults: envInt("EMBER_SESSION_RECALL_MAX_RESULTS", 4, { min: 1, max: 20 }),
    defaultMaxChars: envInt("EMBER_SESSION_RECALL_MAX_CHARS", 1_800, { min: 200, max: 10_000 }),
  },
} as const;

// ─── Config Invariant Validation ────────────────────────────────────────────

function assertConfigInvariants(config: typeof CONFIG): void {
  const { stage1, stage2, stage3 } = config.compaction;
  if (stage1 >= stage2) {
    throw new Error(
      `Invalid compaction config: stage1 (${stage1}) must be less than stage2 (${stage2}). ` +
      `Check EMBER_COMPACTION_STAGE1 and EMBER_COMPACTION_STAGE2 environment variables.`,
    );
  }
  if (stage2 >= stage3) {
    throw new Error(
      `Invalid compaction config: stage2 (${stage2}) must be less than stage3 (${stage3}). ` +
      `Check EMBER_COMPACTION_STAGE2 and EMBER_COMPACTION_STAGE3 environment variables.`,
    );
  }
  if (config.toolLoop.defaultLimit > config.toolLoop.maxLimit) {
    throw new Error(
      `Invalid tool loop config: defaultLimit (${config.toolLoop.defaultLimit}) must not exceed maxLimit (${config.toolLoop.maxLimit}).`,
    );
  }
  if (config.terminal.defaultTimeoutMs > config.terminal.maxTimeoutMs) {
    throw new Error(
      `Invalid terminal config: defaultTimeoutMs (${config.terminal.defaultTimeoutMs}) must not exceed maxTimeoutMs (${config.terminal.maxTimeoutMs}).`,
    );
  }
}

assertConfigInvariants(CONFIG);

