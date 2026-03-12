import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeliveryWorkflowBlocks,
  createInitialDeliveryWorkflow,
  extractPersistedDeliveryWorkflow,
  resolveDeliveryWorkflowAfterHandoff,
} from "./delivery-workflow.js";
import { routeAutoRequestPolicy } from "./routing.js";
import { createToolHandler } from "./tools/index.js";
import type { ChatRequest } from "@ember/core";

function makeRequest(content: string): ChatRequest {
  return {
    mode: "auto",
    content,
    conversation: [],
    conversationId: "conv_delivery",
  };
}

test("product delivery requests start with an advisor-first fallback", () => {
  const result = routeAutoRequestPolicy(
    makeRequest("build me a file sharing web app from start to finish and make it production ready"),
  );

  assert.equal(result.decision.role, "advisor");
  assert.equal(result.shouldQueryDispatch, true);
});

test("initial delivery workflow is created for full app-build requests", () => {
  const workflow = createInitialDeliveryWorkflow(
    "build me a file sharing web app from start to finish and make it production ready",
  );

  assert.ok(workflow);
  assert.equal(workflow?.phase, "planning");
  assert.equal(workflow?.status, "planning-required");
});

test("inspector cannot approve delivery workflow below the quality threshold", () => {
  const current = createInitialDeliveryWorkflow(
    "build me a file sharing web app from start to finish and make it production ready",
  );
  const resolution = resolveDeliveryWorkflowAfterHandoff({
    current,
    sourceRole: "inspector",
    targetRole: "coordinator",
    message: [
      "WORKFLOW: product-delivery",
      "PHASE: finalization",
      "STATUS: approved",
      "SCORE: 8.2",
      "GOAL: ship the app",
      "DONE: reviewed the implementation",
      "TODO: summarize the result to the user",
      "FILES: apps/web/app/page.tsx",
      "NOTES: no further changes needed",
    ].join("\n"),
  });

  assert.equal(resolution.state, current);
  assert.match(String(resolution.error), /SCORE >= 8.5/);
});

test("delivery-mode handoff validation requires inspector score metadata", async () => {
  const workflow = createInitialDeliveryWorkflow(
    "build me a file sharing web app from start to finish and make it production ready",
  );
  const handler = createToolHandler({
    activeRole: "inspector",
    workflowState: workflow,
  });

  const result = await handler.onToolCall("handoff", {
    role: "director",
    message: [
      "WORKFLOW: product-delivery",
      "PHASE: implementation",
      "STATUS: needs-fixes",
      "GOAL: ship the app",
      "DONE: reviewed the implementation",
      "TODO: fix the auth issue",
      "FILES: apps/server/src/index.ts",
      "NOTES: found a blocking session bug",
    ].join("\n"),
  });

  assert.match(String(result), /must include SCORE/i);
});

test("delivery-mode advisor handoff carries workflow state forward", async () => {
  const workflow = createInitialDeliveryWorkflow(
    "build me a file sharing web app from start to finish and make it production ready",
  );
  const handler = createToolHandler({
    activeRole: "advisor",
    workflowState: workflow,
  });

  const result = await handler.onToolCall("handoff", {
    role: "director",
    message: [
      "WORKFLOW: product-delivery",
      "PHASE: implementation",
      "STATUS: plan-complete",
      "GOAL: ship the app",
      "DONE: wrote the architecture and build plan",
      "TODO: implement the app end-to-end",
      "FILES: TODO.md",
      "NOTES: use the plan as the implementation manual",
    ].join("\n"),
  });

  assert.match(String(result), /Handoff to director registered/);
  const pending = handler.getPendingHandoff();
  assert.equal(pending?.workflowState?.phase, "implementation");
  assert.equal(pending?.workflowState?.status, "plan-complete");
});

test("delivery workflow can be recovered from persisted assistant blocks", () => {
  const workflow = createInitialDeliveryWorkflow(
    "build me a file sharing web app from start to finish and make it production ready",
  );
  const conversation = [
    {
      id: "msg_delivery",
      role: "assistant" as const,
      authorRole: "director" as const,
      mode: "auto" as const,
      content: "Implementation pass complete.",
      createdAt: new Date().toISOString(),
      blocks: buildDeliveryWorkflowBlocks({
        ...workflow!,
        phase: "inspection",
        status: "ready-for-review",
        reviewRound: 1,
      }),
    },
  ];

  const restored = extractPersistedDeliveryWorkflow(conversation);
  assert.equal(restored?.phase, "inspection");
  assert.equal(restored?.status, "ready-for-review");
  assert.equal(restored?.reviewRound, 1);
});
