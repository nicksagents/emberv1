import {
  MEMORY_SCOPES,
  MEMORY_SOURCE_TYPES,
  MEMORY_TYPES,
  createMemoryRepository,
  readSettings,
  type MemoryItem,
  type MemoryRepository,
  type MemoryScope,
  type MemorySourceType,
  type MemoryType,
} from "@ember/core";

import type { EmberTool } from "./types.js";

async function withMemoryRepository<T>(
  fn: (repository: MemoryRepository) => Promise<T>,
): Promise<T> {
  const settings = await readSettings();
  if (!settings.memory.enabled) {
    throw new Error("Long-term memory is disabled in settings.");
  }

  const repository = createMemoryRepository(settings.memory);
  try {
    return await fn(repository);
  } finally {
    await repository.close?.();
  }
}

function normalizeScope(value: unknown): MemoryScope | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "project") {
    return "workspace";
  }
  return MEMORY_SCOPES.includes(normalized as MemoryScope) ? (normalized as MemoryScope) : null;
}

function normalizeMemoryType(value: unknown, scope: MemoryScope): MemoryType {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (MEMORY_TYPES.includes(normalized as MemoryType)) {
      return normalized as MemoryType;
    }
  }

  switch (scope) {
    case "user":
      return "user_preference";
    case "workspace":
      return "project_fact";
    case "global":
      return "world_fact";
  }
}

function parseMemoryType(value: unknown): MemoryType | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return MEMORY_TYPES.includes(normalized as MemoryType) ? (normalized as MemoryType) : null;
}

function normalizeSourceType(value: unknown): MemorySourceType | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return MEMORY_SOURCE_TYPES.includes(normalized as MemorySourceType)
    ? (normalized as MemorySourceType)
    : null;
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function getMemoryInternalMetadata(item: MemoryItem): {
  reinforcementCount: number;
  lastReinforcedAt: string | null;
  revalidationDueAt: string | null;
  retrievalSuccessCount: number;
  lastRetrievedAt: string | null;
} {
  const nested =
    item.jsonValue &&
    typeof item.jsonValue === "object" &&
    !Array.isArray(item.jsonValue) &&
    item.jsonValue._memory &&
    typeof item.jsonValue._memory === "object" &&
    !Array.isArray(item.jsonValue._memory)
      ? (item.jsonValue._memory as Record<string, unknown>)
      : null;

  return {
    reinforcementCount:
      typeof nested?.reinforcementCount === "number" && Number.isFinite(nested.reinforcementCount)
        ? Math.max(1, Math.round(nested.reinforcementCount))
        : 1,
    lastReinforcedAt:
      typeof nested?.lastReinforcedAt === "string" ? nested.lastReinforcedAt : item.observedAt ?? item.updatedAt,
    revalidationDueAt: typeof nested?.revalidationDueAt === "string" ? nested.revalidationDueAt : null,
    retrievalSuccessCount:
      typeof nested?.retrievalSuccessCount === "number" && Number.isFinite(nested.retrievalSuccessCount)
        ? Math.max(0, Math.round(nested.retrievalSuccessCount))
        : 0,
    lastRetrievedAt: typeof nested?.lastRetrievedAt === "string" ? nested.lastRetrievedAt : null,
  };
}

function formatMemorySummary(item: MemoryItem): string {
  const status = describeMemoryStatus(item);
  const source = item.sourceRef ? ` source=${item.sourceRef}` : "";
  return `${item.id} [${item.memoryType}/${item.scope}] status=${status} ${item.content}${source}`;
}

function describeMemoryStatus(item: MemoryItem): string {
  if (item.supersededById) {
    return "superseded";
  }
  if (item.validUntil && new Date(item.validUntil).getTime() <= Date.now()) {
    return "forgotten";
  }
  return "active";
}

function inferVolatility(memoryType: MemoryType, expiresAt: string | null): MemoryItem["volatility"] {
  if (expiresAt) {
    return "volatile";
  }
  switch (memoryType) {
    case "user_profile":
      return "stable";
    case "user_preference":
    case "project_fact":
    case "environment_fact":
    case "procedure":
      return "slow-changing";
    case "world_fact":
    case "task_outcome":
    case "warning_or_constraint":
    case "episode_summary":
      return "event";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeJsonValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveMemoryExecute(input: Record<string, unknown>): Promise<string> {
  const content = typeof input.content === "string"
    ? input.content.trim()
    : typeof input.fact === "string"
      ? input.fact.trim()
      : "";
  if (!content) {
    return "Error: content is required.";
  }

  const scope = normalizeScope(input.scope) ?? "user";
  const memoryType = normalizeMemoryType(input.memory_type ?? input.type, scope);
  const tags = normalizeTags(input.tags);
  const validUntil = normalizeIsoTimestamp(input.valid_until ?? input.expires_at);
  if ((input.valid_until ?? input.expires_at) && !validUntil) {
    return "Error: valid_until must be an ISO-8601 timestamp.";
  }

  return await withMemoryRepository(async (repository) => {
    const items = await repository.listItems({ includeSuperseded: true });
    const existing = items.find(
      (item) =>
        !item.supersededById &&
        describeMemoryStatus(item) === "active" &&
        item.scope === scope &&
        item.memoryType === memoryType &&
        item.content.trim().toLowerCase() === content.toLowerCase(),
    );
    if (existing) {
      const reinforced = await repository.reinforceItem(existing.id, {
        extendValidity: validUntil !== null,
      });
      const next = reinforced ?? existing;
      return `Reinforced existing memory.\n${formatMemorySummary(next)}`;
    }

    const supersedesId =
      typeof input.supersedes_id === "string" && input.supersedes_id.trim()
        ? input.supersedes_id.trim()
        : null;
    if (supersedesId) {
      const previous = await repository.getItem(supersedesId);
      if (!previous) {
        return `Error: supersedes_id "${supersedesId}" was not found.`;
      }
    }

    const sourceType = normalizeSourceType(input.source_type) ?? "assistant_message";
    const sourceRef =
      typeof input.source_ref === "string" && input.source_ref.trim()
        ? input.source_ref.trim()
        : "tool:save_memory";
    const jsonValue = normalizeJsonValue(input.json_value ?? input.metadata);
    const confidence = typeof input.confidence === "number" ? input.confidence : undefined;
    const salience = typeof input.salience === "number" ? input.salience : undefined;

    const [created] = await repository.upsertItems([
      {
        sessionId: null,
        memoryType,
        scope,
        content,
        jsonValue,
        tags,
        sourceType,
        sourceRef,
        confidence,
        salience,
        volatility: inferVolatility(memoryType, validUntil),
        validUntil,
        supersedesId,
      },
    ]);

    return `Saved memory.\n${formatMemorySummary(created)}`;
  }).catch((error) => `Error: ${error instanceof Error ? error.message : String(error)}`);
}

async function memorySearchExecute(input: Record<string, unknown>): Promise<string> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    return "Error: query is required.";
  }

  const scope = normalizeScope(input.scope);
  const memoryType = parseMemoryType(input.memory_type);
  if (input.memory_type !== undefined && !memoryType) {
    return `Error: memory_type must be one of ${MEMORY_TYPES.join(", ")}.`;
  }
  const maxResults =
    typeof input.max_results === "number" && Number.isFinite(input.max_results)
      ? Math.max(1, Math.min(10, Math.floor(input.max_results)))
      : 5;

  return await withMemoryRepository(async (repository) => {
    const results = await repository.search({
      text: query,
      scopes: scope ? [scope] : undefined,
      memoryTypes: memoryType ? [memoryType] : undefined,
      maxResults,
    });

    if (results.length === 0) {
      return `No memory results found for "${query}".`;
    }

    const lines = results.map((result, index) => {
      const source = result.item.sourceRef ? ` source=${result.item.sourceRef}` : "";
      return `${index + 1}. ${result.item.id} [${result.item.memoryType}/${result.item.scope}] score=${result.score.toFixed(2)} ${result.item.content}${source}`;
    });
    return ["Memory search results:", ...lines].join("\n");
  }).catch((error) => `Error: ${error instanceof Error ? error.message : String(error)}`);
}

async function memoryGetExecute(input: Record<string, unknown>): Promise<string> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) {
    return "Error: id is required.";
  }

  return await withMemoryRepository(async (repository) => {
    const item = await repository.getItem(id);
    if (!item) {
      return `Error: memory "${id}" was not found.`;
    }
    const meta = getMemoryInternalMetadata(item);

    return [
      `Memory: ${item.id}`,
      `Status: ${describeMemoryStatus(item)}`,
      `Type: ${item.memoryType}`,
      `Scope: ${item.scope}`,
      `Content: ${item.content}`,
      `Tags: ${item.tags.join(", ") || "(none)"}`,
      `Source type: ${item.sourceType}`,
      `Source ref: ${item.sourceRef ?? "(none)"}`,
      `Session: ${item.sessionId ?? "(none)"}`,
      `Confidence: ${item.confidence.toFixed(2)}`,
      `Salience: ${item.salience.toFixed(2)}`,
      `Volatility: ${item.volatility}`,
      `Created: ${item.createdAt}`,
      `Updated: ${item.updatedAt}`,
      `Valid until: ${item.validUntil ?? "(none)"}`,
      `Reinforcement count: ${meta.reinforcementCount}`,
      `Last reinforced: ${meta.lastReinforcedAt ?? "(none)"}`,
      `Retrieval success count: ${meta.retrievalSuccessCount}`,
      `Last retrieved: ${meta.lastRetrievedAt ?? "(none)"}`,
      `Revalidation due: ${meta.revalidationDueAt ?? "(none)"}`,
      `Supersedes: ${item.supersedesId ?? "(none)"}`,
      `Superseded by: ${item.supersededById ?? "(none)"}`,
      `Metadata: ${item.jsonValue ? JSON.stringify(item.jsonValue, null, 2) : "(none)"}`,
    ].join("\n");
  }).catch((error) => `Error: ${error instanceof Error ? error.message : String(error)}`);
}

async function forgetMemoryExecute(input: Record<string, unknown>): Promise<string> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) {
    return "Error: id is required.";
  }
  if (input.confirm !== true) {
    return "Error: set confirm=true to forget a memory.";
  }

  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;

  return await withMemoryRepository(async (repository) => {
    const item = await repository.getItem(id);
    if (!item) {
      return `Error: memory "${id}" was not found.`;
    }
    if (describeMemoryStatus(item) === "forgotten") {
      return `Memory is already forgotten.\n${formatMemorySummary(item)}`;
    }

    const forgotten = await repository.forgetItem(id, { reason });
    if (!forgotten) {
      return `Error: memory "${id}" could not be forgotten.`;
    }

    return `Forgot memory.\n${formatMemorySummary(forgotten)}`;
  }).catch((error) => `Error: ${error instanceof Error ? error.message : String(error)}`);
}

export const saveMemoryTool: EmberTool = {
  definition: {
    name: "save_memory",
    description:
      "Persist a durable fact into Ember's long-term memory. Use when the user explicitly asks you to remember something, or when you need to pin an important stable fact instead of relying on automatic consolidation.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The durable fact to save.",
        },
        memory_type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description: "The memory category to store.",
        },
        scope: {
          type: "string",
          enum: ["user", "workspace", "global", "project"],
          description: "Where the memory should apply. project is accepted as an alias for workspace.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags to improve retrieval.",
        },
        source_ref: {
          type: "string",
          description: "Optional provenance URL or reference.",
        },
        valid_until: {
          type: "string",
          description: "Optional ISO timestamp after which the memory should expire.",
        },
        supersedes_id: {
          type: "string",
          description: "Optional prior memory id this new fact replaces.",
        },
      },
      required: ["content"],
    },
  },
  execute: saveMemoryExecute,
};

export const memorySearchTool: EmberTool = {
  definition: {
    name: "memory_search",
    description:
      "Search Ember's long-term memory across prior sessions. Use this before asking the user to repeat stable facts or when they refer to something remembered from earlier chats.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query.",
        },
        scope: {
          type: "string",
          enum: ["user", "workspace", "global", "project"],
          description: "Optional memory scope filter. project is an alias for workspace.",
        },
        memory_type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description: "Optional memory type filter.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return. Default 5, maximum 10.",
        },
      },
      required: ["query"],
    },
  },
  execute: memorySearchExecute,
};

export const memoryGetTool: EmberTool = {
  definition: {
    name: "memory_get",
    description:
      "Retrieve one stored memory by id, including provenance and status metadata. Use this after memory_search when you need the full record.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory id to inspect.",
        },
      },
      required: ["id"],
    },
  },
  execute: memoryGetExecute,
};

export const forgetMemoryTool: EmberTool = {
  definition: {
    name: "forget_memory",
    description:
      "Soft-delete a memory by expiring it so it stops being retrieved while remaining auditable. Use only when the user explicitly asks to delete or correct a remembered fact.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory id to forget.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm the forget operation.",
        },
        reason: {
          type: "string",
          description: "Optional reason for forgetting the memory.",
        },
      },
      required: ["id", "confirm"],
    },
  },
  execute: forgetMemoryExecute,
};
