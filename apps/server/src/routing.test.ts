import test from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, Role } from "@ember/core";

import {
  buildDispatchInput,
  parseDispatchDecision,
  routeAutoRequestPolicy,
} from "./routing.js";

function makeRequest(
  content: string,
  conversation: ChatRequest["conversation"] = [],
): ChatRequest {
  return {
    mode: "auto",
    content,
    conversation,
    conversationId: "conv_test",
  };
}

function makeAssistant(role: Extract<Role, "coordinator" | "advisor" | "director" | "inspector">, content: string) {
  return {
    id: `msg_${role}`,
    role: "assistant" as const,
    authorRole: role,
    mode: "auto" as const,
    content,
    createdAt: new Date().toISOString(),
  };
}

function makeUser(content: string) {
  return {
    id: `user_${Math.random().toString(36).slice(2, 8)}`,
    role: "user" as const,
    authorRole: "user" as const,
    mode: "auto" as const,
    content,
    createdAt: new Date().toISOString(),
  };
}

test("parseDispatchDecision accepts strict JSON", () => {
  const decision = parseDispatchDecision(
    '{"role":"director","confidence":0.91,"reason":"This is substantial implementation work."}',
  );

  assert.deepEqual(decision, {
    role: "director",
    confidence: 0.91,
    reason: "This is substantial implementation work.",
  });
});

test("parseDispatchDecision rejects prose", () => {
  assert.equal(
    parseDispatchDecision("director because this is clearly a coding-heavy request"),
    null,
  );
});

test("policy keeps browser navigation with coordinator", () => {
  const result = routeAutoRequestPolicy(
    makeRequest("go to this website, find the login page, and click sign in"),
  );

  assert.equal(result.decision.role, "coordinator");
  assert.equal(result.shouldQueryDispatch, true);
});

test("policy routes planning to advisor", () => {
  const result = routeAutoRequestPolicy(
    makeRequest("plan an auth migration and outline the rollout strategy before coding"),
  );

  assert.equal(result.decision.role, "advisor");
  assert.equal(result.shouldQueryDispatch, true);
});

test("policy routes substantial implementation to director", () => {
  const result = routeAutoRequestPolicy(
    makeRequest("implement this feature across backend and frontend, refactor the API, and debug the failing auth flow"),
  );

  assert.equal(result.decision.role, "director");
  assert.equal(result.shouldQueryDispatch, true);
});

test("policy routes browser-heavy findings work to inspector", () => {
  const result = routeAutoRequestPolicy(
    makeRequest("use the browser to inspect the site, validate the checkout flow, and write up the findings"),
  );

  assert.equal(result.decision.role, "inspector");
  assert.equal(result.shouldQueryDispatch, true);
});

test("policy preserves follow-up continuity when the task type has not changed", () => {
  const conversation = [
    makeUser("refactor the auth flow across the workspace"),
    makeAssistant("director", "I updated the main auth flow and still need to finish the API layer."),
  ];
  const result = routeAutoRequestPolicy(
    makeRequest("continue and update the remaining API files too", conversation),
  );

  assert.equal(result.decision.role, "director");
  assert.equal(result.shouldQueryDispatch, true);
});

test("policy marks smaller technical work as ambiguous coordinator-first routing", () => {
  const result = routeAutoRequestPolicy(
    makeRequest("fix this bug in the settings page"),
  );

  assert.equal(result.decision.role, "coordinator");
  assert.equal(result.shouldQueryDispatch, true);
});

test("dispatch input includes recent transcript and strict json instructions", () => {
  const request = makeRequest("fix this bug in the settings page", [
    makeUser("review the settings page"),
    makeAssistant("coordinator", "I found the failing control and narrowed it down to one component."),
  ]);

  const input = buildDispatchInput(request);
  assert.match(input, /routing_mode/);
  assert.match(input, /recent_conversation/);
  assert.match(input, /strict JSON only/);
  assert.match(input, /latest_user_request/);
});

test("dispatch input can include the policy fallback hint for the router model", () => {
  const request = makeRequest("fix this bug in the settings page");
  const policy = routeAutoRequestPolicy(request);
  const input = buildDispatchInput(request, policy.decision);

  assert.match(input, /policy_fallback/);
  assert.match(input, /role=coordinator/);
  assert.match(input, /reason=/);
});

test("dispatch input includes compacted history separately from recent turns", () => {
  const request = makeRequest("continue with the provider patch", [
    {
      id: "summary_1",
      role: "assistant",
      authorRole: "coordinator",
      mode: "auto",
      content: "Conversation memory summary. Earlier work covered provider selection and tool formatting.",
      createdAt: new Date().toISOString(),
      historySummary: {
        kind: "history-summary",
        sourceMessageCount: 14,
        sourceToolCallCount: 3,
        generatedAt: new Date().toISOString(),
      },
    },
    makeUser("patch the compact history path next"),
    makeAssistant("director", "I am updating the provider request formatter."),
  ]);

  const input = buildDispatchInput(request);
  assert.match(input, /compacted_history/);
  assert.match(input, /provider selection and tool formatting/);
  assert.match(input, /recent_conversation/);
});
