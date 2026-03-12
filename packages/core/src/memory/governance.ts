import { extendMemoryValidity, mergeMemoryInternalMetadata } from "./metadata";
import type {
  MemoryApprovalStatus,
  MemoryItem,
  MemoryRepository,
  MemoryWriteCandidate,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface MemoryGovernanceState {
  approvalStatus: MemoryApprovalStatus;
  approvedAt: string | null;
  approvedBy: string | null;
  lastReviewedAt: string | null;
  lastReviewedBy: string | null;
  contradictionCount: number;
  contradictionSessionCount: number;
}

export function getMemoryGovernanceState(
  source:
    | Pick<MemoryItem, "jsonValue" | "tags">
    | Record<string, unknown>
    | null
    | undefined,
): MemoryGovernanceState {
  const jsonValue =
    source && "jsonValue" in source ? asRecord(source.jsonValue) : asRecord(source);
  const tags = source && "tags" in source && Array.isArray(source.tags) ? source.tags : [];
  const approvalStatus = getApprovalStatus(jsonValue, tags);

  return {
    approvalStatus,
    approvedAt: getOptionalString(jsonValue?.approvedAt),
    approvedBy: getOptionalString(jsonValue?.approvedBy),
    lastReviewedAt: getOptionalString(jsonValue?.lastReviewedAt),
    lastReviewedBy: getOptionalString(jsonValue?.lastReviewedBy),
    contradictionCount: Math.max(0, getFiniteNumber(jsonValue?.contradictionCount) ?? 0),
    contradictionSessionCount: Math.max(0, getFiniteNumber(jsonValue?.contradictionSessionCount) ?? 0),
  };
}

export function mergeMemoryGovernanceState(
  jsonValue: Record<string, unknown> | null | undefined,
  patch: Partial<MemoryGovernanceState>,
): Record<string, unknown> {
  const base = asRecord(jsonValue) ?? {};
  const current = getMemoryGovernanceState(base);

  return {
    ...base,
    approvalStatus: patch.approvalStatus ?? current.approvalStatus,
    approvedAt: patch.approvedAt === undefined ? current.approvedAt : patch.approvedAt,
    approvedBy: patch.approvedBy === undefined ? current.approvedBy : patch.approvedBy,
    lastReviewedAt:
      patch.lastReviewedAt === undefined ? current.lastReviewedAt : patch.lastReviewedAt,
    lastReviewedBy:
      patch.lastReviewedBy === undefined ? current.lastReviewedBy : patch.lastReviewedBy,
    contradictionCount: Math.max(
      0,
      Math.round(patch.contradictionCount ?? current.contradictionCount),
    ),
    contradictionSessionCount: Math.max(
      0,
      Math.round(patch.contradictionSessionCount ?? current.contradictionSessionCount),
    ),
  };
}

export function updateGovernanceTags(
  tags: string[],
  approvalStatus: MemoryApprovalStatus,
  contradictionCount = 0,
): string[] {
  const approvalTags = new Set([
    "approval:pending",
    "approval:approved",
    "approval:disputed",
    "approval:rejected",
  ]);
  const nextTags = tags.filter((tag) => !approvalTags.has(tag) && tag !== "contradicted");
  if (approvalStatus !== "implicit") {
    nextTags.push(`approval:${approvalStatus}`);
  }
  if (contradictionCount > 0 || approvalStatus === "disputed") {
    nextTags.push("contradicted");
  }
  return [...new Set(nextTags)];
}

export async function suppressMemoryItem(
  repository: MemoryRepository,
  id: string,
  options: {
    now?: string;
    reason?: string | null;
  } = {},
): Promise<MemoryItem | null> {
  const now = options.now ?? new Date().toISOString();
  const reason = options.reason?.trim() ? options.reason.trim() : "operator-suppressed";
  return await repository.forgetItem(id, { now, reason });
}

export async function revalidateMemoryItem(
  repository: MemoryRepository,
  id: string,
  options: {
    now?: string;
    reason?: string | null;
  } = {},
): Promise<MemoryItem | null> {
  const existing = await repository.getItem(id);
  if (!existing || existing.supersededById) {
    return null;
  }

  const now = options.now ?? new Date().toISOString();
  const currentJson = asRecord(existing.jsonValue) ?? {};
  const nextJson = mergeMemoryInternalMetadata(currentJson, {
    revalidationDueAt: buildNextRevalidationDueAt(existing, now),
  });

  const notes = options.reason?.trim() ? [options.reason.trim()] : [];
  const [next] = await repository.upsertItems([
    copyMemoryAsSupersedingCandidate(existing, {
      sessionId: null,
      sourceType: "system",
      sourceRef: "memory:governance",
      jsonValue: {
        ...nextJson,
        revalidatedAt: now,
        revalidatedBy: "operator",
        revalidationNotes: notes,
      },
      tags: updateTags(existing.tags, ["revalidated", "governed"], []),
      confidence: Math.min(1, existing.confidence + 0.02),
      salience: existing.salience,
      validUntil: existing.validUntil ? extendMemoryValidity(existing.validUntil, existing.volatility, now) : null,
      supersedesId: existing.id,
    }),
  ]);

  return next ?? null;
}

export async function retireProcedureMemory(
  repository: MemoryRepository,
  id: string,
  options: {
    now?: string;
    reason?: string | null;
  } = {},
): Promise<MemoryItem | null> {
  const existing = await repository.getItem(id);
  if (!existing || existing.supersededById || existing.memoryType !== "procedure") {
    return null;
  }
  if (existing.jsonValue?.retired === true) {
    return existing;
  }

  const now = options.now ?? new Date().toISOString();
  const currentJson = asRecord(existing.jsonValue) ?? {};
  const [next] = await repository.upsertItems([
    copyMemoryAsSupersedingCandidate(existing, {
      sessionId: null,
      sourceType: "system",
      sourceRef: "memory:governance",
      content: buildRetiredProcedureContent(existing),
      jsonValue: {
        ...currentJson,
        published: false,
        retired: true,
        retiredAt: now,
        retiredBy: "operator",
        retireReason: options.reason?.trim() || "operator-retired",
      },
      tags: updateTags(existing.tags, ["procedure:retired", "governed"], [
        "procedure:active",
        "procedure:published",
        "procedure:draft",
      ]),
      confidence: existing.confidence,
      salience: Math.min(existing.salience, 0.42),
      supersedesId: existing.id,
    }),
  ]);

  return next ?? null;
}

export async function approveMemoryItem(
  repository: MemoryRepository,
  id: string,
  options: {
    now?: string;
    reason?: string | null;
  } = {},
): Promise<MemoryItem | null> {
  const existing = await repository.getItem(id);
  if (!existing || existing.supersededById) {
    return null;
  }

  const now = options.now ?? new Date().toISOString();
  const currentState = getMemoryGovernanceState(existing);
  const [next] = await repository.upsertItems([
    copyMemoryAsSupersedingCandidate(existing, {
      sessionId: null,
      sourceType: "system",
      sourceRef: "memory:governance",
      jsonValue: mergeMemoryGovernanceState(existing.jsonValue, {
        approvalStatus: "approved",
        approvedAt: now,
        approvedBy: "operator",
        lastReviewedAt: now,
        lastReviewedBy: "operator",
        contradictionCount: currentState.contradictionCount,
        contradictionSessionCount: currentState.contradictionSessionCount,
      }),
      tags: updateGovernanceTags(
        updateTags(existing.tags, ["governed"], []),
        "approved",
        currentState.contradictionCount,
      ),
      confidence: Math.min(1, existing.confidence + 0.03),
      supersedesId: existing.id,
    }),
  ]);

  return next ?? null;
}

export async function downgradeContradictedMemoryItem(
  repository: MemoryRepository,
  id: string,
  options: {
    now?: string;
    contradictionCount: number;
    contradictionSessionCount: number;
    reason?: string | null;
  },
): Promise<MemoryItem | null> {
  const existing = await repository.getItem(id);
  if (!existing || existing.supersededById) {
    return null;
  }

  const currentState = getMemoryGovernanceState(existing);
  const contradictionCount = Math.max(
    currentState.contradictionCount,
    Math.max(0, Math.round(options.contradictionCount)),
  );
  const contradictionSessionCount = Math.max(
    currentState.contradictionSessionCount,
    Math.max(0, Math.round(options.contradictionSessionCount)),
  );
  const now = options.now ?? new Date().toISOString();
  const confidencePenalty = Math.min(
    0.16,
    contradictionCount * 0.02 + contradictionSessionCount * 0.03,
  );
  const saliencePenalty = Math.min(0.1, contradictionCount * 0.015);

  const [next] = await repository.upsertItems([
    copyMemoryAsSupersedingCandidate(existing, {
      sessionId: null,
      sourceType: "system",
      sourceRef: "memory:replay",
      jsonValue: {
        ...mergeMemoryGovernanceState(existing.jsonValue, {
          approvalStatus: "disputed",
          lastReviewedAt: now,
          lastReviewedBy: "replay",
          contradictionCount,
          contradictionSessionCount,
        }),
        disputeReason: options.reason?.trim() || "cross-session contradiction",
        disputedAt: now,
      },
      tags: updateGovernanceTags(
        updateTags(existing.tags, ["governed"], []),
        "disputed",
        contradictionCount,
      ),
      confidence: Math.max(0.2, existing.confidence - confidencePenalty),
      salience: Math.max(0.18, existing.salience - saliencePenalty),
      supersedesId: existing.id,
    }),
  ]);

  return next ?? null;
}

function buildRetiredProcedureContent(item: MemoryItem): string {
  const trigger =
    typeof item.jsonValue?.trigger === "string"
      ? item.jsonValue.trigger
      : item.content.trim();
  return `Retired learned procedure. Trigger: ${trigger}`;
}

function buildNextRevalidationDueAt(item: MemoryItem, now: string): string {
  const nowMs = new Date(now).getTime();
  const extensionDays = getRevalidationDays(item);
  return new Date(nowMs + extensionDays * DAY_MS).toISOString();
}

function getRevalidationDays(item: MemoryItem): number {
  switch (item.volatility) {
    case "stable":
      return 365;
    case "slow-changing":
      return 180;
    case "event":
      return 45;
    case "volatile":
      return 7;
  }
}

function copyMemoryAsSupersedingCandidate(
  item: MemoryItem,
  overrides: Partial<MemoryWriteCandidate>,
): MemoryWriteCandidate {
  return {
    sessionId: item.sessionId,
    memoryType: item.memoryType,
    scope: item.scope,
    content: item.content,
    jsonValue: item.jsonValue ? { ...item.jsonValue } : null,
    tags: [...item.tags],
    sourceType: item.sourceType,
    sourceRef: item.sourceRef,
    confidence: item.confidence,
    salience: item.salience,
    volatility: item.volatility,
    observedAt: item.observedAt,
    validFrom: item.validFrom,
    validUntil: item.validUntil,
    supersedesId: item.id,
    ...overrides,
  };
}

function updateTags(tags: string[], additions: string[], removals: string[]): string[] {
  const removalSet = new Set(removals);
  return [...new Set([...tags.filter((tag) => !removalSet.has(tag)), ...additions])];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getApprovalStatus(
  jsonValue: Record<string, unknown> | null,
  tags: string[],
): MemoryApprovalStatus {
  const explicit = getOptionalString(jsonValue?.approvalStatus);
  if (
    explicit === "implicit" ||
    explicit === "pending" ||
    explicit === "approved" ||
    explicit === "disputed" ||
    explicit === "rejected"
  ) {
    return explicit;
  }
  if (tags.includes("approval:approved")) {
    return "approved";
  }
  if (tags.includes("approval:pending")) {
    return "pending";
  }
  if (tags.includes("approval:disputed")) {
    return "disputed";
  }
  if (tags.includes("approval:rejected")) {
    return "rejected";
  }
  return "implicit";
}

function getOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
