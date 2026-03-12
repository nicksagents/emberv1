import type { MemoryItem, MemoryVolatility } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const MEMORY_INTERNAL_METADATA_KEY = "_memory";

export interface MemoryInternalMetadata {
  reinforcementCount: number;
  lastReinforcedAt: string | null;
  revalidationDueAt: string | null;
  retrievalSuccessCount: number;
  lastRetrievedAt: string | null;
}

export function getMemoryInternalMetadata(
  jsonValue: Record<string, unknown> | null | undefined,
  fallback: {
    createdAt?: string;
    updatedAt?: string;
    observedAt?: string | null;
  } = {},
): MemoryInternalMetadata {
  const nested = asRecord(jsonValue?.[MEMORY_INTERNAL_METADATA_KEY]);
  const reinforcementCount = Math.max(
    1,
    getFiniteNumber(nested?.reinforcementCount) ??
      getFiniteNumber(jsonValue?.reinforcementCount) ??
      1,
  );
  const lastReinforcedAt =
    getIsoString(nested?.lastReinforcedAt) ??
    getIsoString(jsonValue?.lastReinforcedAt) ??
    fallback.observedAt ??
    fallback.updatedAt ??
    fallback.createdAt ??
    null;
  const revalidationDueAt =
    getIsoString(nested?.revalidationDueAt) ??
    getIsoString(jsonValue?.revalidationDueAt) ??
    null;
  const retrievalSuccessCount = Math.max(
    0,
    getFiniteNumber(nested?.retrievalSuccessCount) ??
      getFiniteNumber(jsonValue?.retrievalSuccessCount) ??
      0,
  );
  const lastRetrievedAt =
    getIsoString(nested?.lastRetrievedAt) ??
    getIsoString(jsonValue?.lastRetrievedAt) ??
    null;

  return {
    reinforcementCount,
    lastReinforcedAt,
    revalidationDueAt,
    retrievalSuccessCount,
    lastRetrievedAt,
  };
}

export function mergeMemoryInternalMetadata(
  jsonValue: Record<string, unknown> | null | undefined,
  patch: Partial<MemoryInternalMetadata>,
): Record<string, unknown> {
  const base = asRecord(jsonValue) ?? {};
  const current = getMemoryInternalMetadata(base);
  const next: MemoryInternalMetadata = {
    reinforcementCount: Math.max(1, Math.round(patch.reinforcementCount ?? current.reinforcementCount)),
    lastReinforcedAt:
      patch.lastReinforcedAt === undefined ? current.lastReinforcedAt : patch.lastReinforcedAt,
    revalidationDueAt:
      patch.revalidationDueAt === undefined ? current.revalidationDueAt : patch.revalidationDueAt,
    retrievalSuccessCount: Math.max(
      0,
      Math.round(patch.retrievalSuccessCount ?? current.retrievalSuccessCount),
    ),
    lastRetrievedAt:
      patch.lastRetrievedAt === undefined ? current.lastRetrievedAt : patch.lastRetrievedAt,
  };

  return {
    ...base,
    [MEMORY_INTERNAL_METADATA_KEY]: next,
  };
}

export function getItemInternalMetadata(item: Pick<MemoryItem, "jsonValue" | "createdAt" | "updatedAt" | "observedAt">): MemoryInternalMetadata {
  return getMemoryInternalMetadata(item.jsonValue, {
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    observedAt: item.observedAt,
  });
}

export function extendMemoryValidity(
  validUntil: string | null,
  volatility: MemoryVolatility,
  now: string,
): string | null {
  if (!validUntil) {
    return null;
  }

  const baseMs = new Date(validUntil).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(baseMs) || !Number.isFinite(nowMs)) {
    return validUntil;
  }

  const startMs = Math.max(baseMs, nowMs);
  const extensionDays = getValidityExtensionDays(volatility);
  return new Date(startMs + extensionDays * DAY_MS).toISOString();
}

function getValidityExtensionDays(volatility: MemoryVolatility): number {
  switch (volatility) {
    case "stable":
      return 365;
    case "slow-changing":
      return 60;
    case "event":
      return 30;
    case "volatile":
      return 7;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getIsoString(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}
