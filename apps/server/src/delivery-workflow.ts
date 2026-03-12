import type { ChatMessage, Role } from "@ember/core";
import type { UiBlock } from "@ember/ui-schema";

export type DeliveryWorkflowPhase = "planning" | "implementation" | "inspection" | "finalization";
export type DeliveryWorkflowStatus =
  | "planning-required"
  | "plan-complete"
  | "ready-for-review"
  | "needs-fixes"
  | "approved";

export interface DeliveryWorkflowState {
  kind: "product-delivery";
  goal: string;
  phase: DeliveryWorkflowPhase;
  status: DeliveryWorkflowStatus;
  reviewScore: number | null;
  reviewRound: number;
  updatedBy: Role | null;
}

export interface DeliveryWorkflowResolution {
  state: DeliveryWorkflowState | null;
  error: string | null;
}

interface ParsedWorkflowMetadata {
  workflow: string | null;
  phase: DeliveryWorkflowPhase | null;
  status: DeliveryWorkflowStatus | null;
  score: number | null;
}

const DELIVERY_ACTION_RE = /\b(build|create|make|develop|ship|launch)\b/i;
const DELIVERY_TARGET_RE = /\b(app|web app|website|site|service|api|dashboard|platform|tool|product)\b/i;
const DELIVERY_SCOPE_RE = /\b(from scratch|start to finish|full|complete|entire|whole|production ready|end to end)\b/i;
const SCORE_RE = /(?:^|\n)SCORE:\s*([0-9]+(?:\.[0-9]+)?)(?:\/10)?\s*$/im;
const IMPLIED_SCORE_RE = /([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/i;
const SECURITY_FINDING_RE = /\b(critical|vulnerability|security|exploit|unsafe|blocking finding|severe)\b/i;
const WORKFLOW_NOTE_PREFIX = "Workflow: product-delivery;";

function normalizeGoal(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function parsePhase(value: string | null): DeliveryWorkflowPhase | null {
  switch (value?.trim().toLowerCase()) {
    case "planning":
      return "planning";
    case "implementation":
      return "implementation";
    case "inspection":
      return "inspection";
    case "finalization":
    case "final":
      return "finalization";
    default:
      return null;
  }
}

function parseStatus(value: string | null): DeliveryWorkflowStatus | null {
  switch (value?.trim().toLowerCase()) {
    case "planning-required":
      return "planning-required";
    case "plan-complete":
      return "plan-complete";
    case "ready-for-review":
      return "ready-for-review";
    case "needs-fixes":
      return "needs-fixes";
    case "approved":
      return "approved";
    default:
      return null;
  }
}

function parseExplicitMetadata(message: string): ParsedWorkflowMetadata {
  const workflow = message.match(/(?:^|\n)WORKFLOW:\s*(.+?)\s*$/im)?.[1]?.trim().toLowerCase() ?? null;
  const phase = parsePhase(message.match(/(?:^|\n)PHASE:\s*(.+?)\s*$/im)?.[1] ?? null);
  const status = parseStatus(message.match(/(?:^|\n)STATUS:\s*(.+?)\s*$/im)?.[1] ?? null);
  const explicitScore = message.match(SCORE_RE)?.[1] ?? message.match(IMPLIED_SCORE_RE)?.[1] ?? null;
  const score = explicitScore === null ? null : Math.max(0, Math.min(10, Number(explicitScore)));

  return { workflow, phase, status, score: Number.isFinite(score) ? score : null };
}

function inferTransitionMetadata(sourceRole: Role, targetRole: string): Pick<ParsedWorkflowMetadata, "phase" | "status"> {
  if (sourceRole === "advisor" && targetRole === "director") {
    return { phase: "implementation", status: "plan-complete" };
  }
  if (sourceRole === "director" && targetRole === "inspector") {
    return { phase: "inspection", status: "ready-for-review" };
  }
  if (sourceRole === "inspector" && targetRole === "director") {
    return { phase: "implementation", status: "needs-fixes" };
  }
  if (sourceRole === "inspector" && targetRole === "coordinator") {
    return { phase: "finalization", status: "approved" };
  }
  if (sourceRole === "coordinator") {
    return { phase: "finalization", status: "approved" };
  }
  return { phase: null, status: null };
}

function formatRequiredWorkflowFields(includeScore: boolean): string {
  return [
    "Include these lines in the handoff message:",
    "WORKFLOW: product-delivery",
    "PHASE: planning|implementation|inspection|finalization",
    "STATUS: planning-required|plan-complete|ready-for-review|needs-fixes|approved",
    ...(includeScore ? ["SCORE: <0.0-10.0>"] : []),
  ].join(" ");
}

export function isProductDeliveryRequest(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    (/\bbuild me\b/.test(normalized) || DELIVERY_ACTION_RE.test(normalized)) &&
    DELIVERY_TARGET_RE.test(normalized) &&
    (DELIVERY_SCOPE_RE.test(normalized) || /\b(build me|for me|entire|full project|complete app|production ready)\b/.test(normalized))
  );
}

export function createInitialDeliveryWorkflow(content: string): DeliveryWorkflowState | null {
  if (!isProductDeliveryRequest(content)) {
    return null;
  }

  return {
    kind: "product-delivery",
    goal: normalizeGoal(content),
    phase: "planning",
    status: "planning-required",
    reviewScore: null,
    reviewRound: 0,
    updatedBy: null,
  };
}

export function buildDeliveryWorkflowBlocks(workflow: DeliveryWorkflowState | null): UiBlock[] {
  if (!workflow) {
    return [];
  }

  const tone =
    workflow.status === "approved"
      ? "success"
      : workflow.status === "needs-fixes"
        ? "warning"
        : "info";
  const scoreText = workflow.reviewScore === null ? "n/a" : workflow.reviewScore.toFixed(1);

  return [
    {
      type: "note",
      tone,
      body:
        `${WORKFLOW_NOTE_PREFIX} goal=${workflow.goal}; phase=${workflow.phase}; status=${workflow.status}; ` +
        `score=${scoreText}; round=${workflow.reviewRound}`,
    },
  ];
}

function parsePersistedWorkflowNote(body: string): DeliveryWorkflowState | null {
  if (!body.startsWith(WORKFLOW_NOTE_PREFIX)) {
    return null;
  }

  const goal = body.match(/goal=(.*?); phase=/)?.[1]?.trim() ?? "";
  const phase = parsePhase(body.match(/phase=([^;]+)/)?.[1] ?? null);
  const status = parseStatus(body.match(/status=([^;]+)/)?.[1] ?? null);
  const scoreRaw = body.match(/score=([^;]+)/)?.[1]?.trim() ?? "n/a";
  const roundRaw = body.match(/round=(\d+)/)?.[1] ?? "0";
  const parsedScore = scoreRaw === "n/a" ? null : Number(scoreRaw);
  const reviewScore = parsedScore === null || !Number.isFinite(parsedScore)
    ? null
    : Math.max(0, Math.min(10, parsedScore));
  const reviewRound = Number.parseInt(roundRaw, 10);

  if (!goal || !phase || !status || !Number.isFinite(reviewRound)) {
    return null;
  }

  return {
    kind: "product-delivery",
    goal,
    phase,
    status,
    reviewScore,
    reviewRound,
    updatedBy: null,
  };
}

export function extractPersistedDeliveryWorkflow(conversation: ChatMessage[]): DeliveryWorkflowState | null {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const blocks = conversation[index]?.blocks ?? [];
    for (const block of blocks) {
      if (block.type !== "note") {
        continue;
      }
      const parsed = parsePersistedWorkflowNote(block.body);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

export function buildDeliveryWorkflowPrompt(
  workflow: DeliveryWorkflowState | null,
  role: Role,
): string {
  if (!workflow) {
    return "";
  }

  const scoreText = workflow.reviewScore === null ? "n/a" : workflow.reviewScore.toFixed(1);
  const roleInstructions: Record<Role, string> = {
    dispatch:
      "For product-delivery requests, prefer advisor first unless there is already a complete plan and implementation is clearly underway.",
    coordinator:
      "Do not close the workflow early. Only give the final user-facing summary after inspector approval with score >= 8.5 and no critical security issues.",
    advisor:
      "Write the complete build manual first, then hand off to director. Do not implement. Your handoff should mark STATUS: plan-complete.",
    director:
      "Implement the plan. After a real implementation pass, hand off to inspector with STATUS: ready-for-review. If inspector sends it back, fix every blocking issue before returning it.",
    inspector:
      "Score the build from 0.0 to 10.0. If score < 8.5 or critical security/correctness findings remain, hand off to director with STATUS: needs-fixes. If score >= 8.5 and the build is production-ready, hand off to coordinator with STATUS: approved.",
    ops:
      "Ops should not drive product-delivery work unless explicitly asked for a narrow cleanup slice.",
  };

  return [
    "## Product Delivery Workflow",
    `Goal: ${workflow.goal}`,
    `Current phase: ${workflow.phase}`,
    `Current status: ${workflow.status}`,
    `Latest inspector score: ${scoreText}`,
    `Review rounds: ${workflow.reviewRound}`,
    roleInstructions[role],
    "Required sequence: advisor plan -> director implementation -> inspector review loops -> coordinator final summary.",
    formatRequiredWorkflowFields(role === "inspector"),
  ].join("\n");
}

export function buildDeliveryWorkflowReminder(
  workflow: DeliveryWorkflowState | null,
  role: Role,
): string | null {
  if (!workflow) {
    return null;
  }

  switch (role) {
    case "advisor":
      return [
        "Product-delivery workflow is still active.",
        "Do not stop after planning.",
        "Finish the complete implementation manual and call handoff to director.",
        "Include WORKFLOW: product-delivery, PHASE: implementation, STATUS: plan-complete.",
      ].join(" ");
    case "director":
      return [
        "Product-delivery workflow is still active.",
        "Do not stop after implementation.",
        "Either continue implementing, or when the pass is ready, call handoff to inspector.",
        "Include WORKFLOW: product-delivery, PHASE: inspection, STATUS: ready-for-review.",
      ].join(" ");
    case "inspector":
      return [
        "Product-delivery workflow is still active.",
        "Inspector must not stop without a scored handoff.",
        "If score < 8.5 or critical findings remain, hand off to director with STATUS: needs-fixes and SCORE.",
        "If score >= 8.5 and production readiness is met, hand off to coordinator with STATUS: approved and SCORE.",
      ].join(" ");
    default:
      return null;
  }
}

export function resolveDeliveryWorkflowAfterHandoff(options: {
  current: DeliveryWorkflowState | null;
  sourceRole: Role;
  targetRole: string;
  message: string;
}): DeliveryWorkflowResolution {
  const current = options.current;
  const explicit = parseExplicitMetadata(options.message);
  const workflowName = explicit.workflow;
  const workflowActive = current !== null || workflowName === "product-delivery";

  if (!workflowActive) {
    return { state: current, error: null };
  }

  if (workflowName !== null && workflowName !== "product-delivery") {
    return { state: current, error: 'Unsupported WORKFLOW value. Use "product-delivery".' };
  }

  const inferred = inferTransitionMetadata(options.sourceRole, options.targetRole);
  const phase = explicit.phase ?? inferred.phase;
  const status = explicit.status ?? inferred.status;
  const score = explicit.score;
  const base = current ?? {
    kind: "product-delivery" as const,
    goal: normalizeGoal(options.message),
    phase: "planning" as const,
    status: "planning-required" as const,
    reviewScore: null,
    reviewRound: 0,
    updatedBy: null,
  };

  if (!phase || !status) {
    return {
      state: current,
      error: formatRequiredWorkflowFields(options.sourceRole === "inspector"),
    };
  }

  if (options.sourceRole === "inspector") {
    if (score === null) {
      return {
        state: current,
        error: `Inspector handoffs in product-delivery mode must include SCORE. ${formatRequiredWorkflowFields(true)}`,
      };
    }

    if (options.targetRole === "coordinator") {
      if (score < 8.5) {
        return {
          state: current,
          error: "Inspector may hand off to coordinator only with SCORE >= 8.5.",
        };
      }
      if (SECURITY_FINDING_RE.test(options.message) && !/\bno critical\b/i.test(options.message)) {
        return {
          state: current,
          error: "Inspector approval cannot mention unresolved critical or security findings.",
        };
      }
    }

    if (options.targetRole === "director" && score >= 8.5 && !SECURITY_FINDING_RE.test(options.message)) {
      return {
        state: current,
        error: "Inspector should hand off to coordinator once SCORE >= 8.5 and no critical findings remain.",
      };
    }
  }

  return {
    state: {
      ...base,
      phase,
      status,
      reviewScore: score ?? base.reviewScore,
      reviewRound:
        options.sourceRole === "inspector"
          ? base.reviewRound + 1
          : base.reviewRound,
      updatedBy: options.sourceRole,
    },
    error: null,
  };
}
