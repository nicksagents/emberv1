import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveAttentionKey,
  getOrCreateAttentionContext,
  setAttentionFocus,
  recordRoleAttentionUpdate,
  buildAttentionPromptSection,
} from "./attention.js";
import type { ChatMessage } from "@ember/core";

// ─── deriveAttentionKey ──────────────────────────────────────────────────────

test("deriveAttentionKey prefers conversationId when available", () => {
  const key = deriveAttentionKey("conv_abc", [], "Do something");
  assert.equal(key, "conversation:conv_abc");
});

test("deriveAttentionKey falls back to first user message id", () => {
  const messages: ChatMessage[] = [
    { id: "msg_1", role: "user", mode: "auto", content: "Hello", createdAt: new Date().toISOString() },
  ];
  const key = deriveAttentionKey(null, messages, "Hello");
  assert.equal(key, "thread:msg_1");
});

test("deriveAttentionKey falls back to goal-based ephemeral key", () => {
  const key = deriveAttentionKey(null, [], "Plan the architecture");
  assert.ok(key.startsWith("ephemeral:"));
  assert.ok(key.includes("plan the architecture"));
});

test("deriveAttentionKey returns ephemeral default for empty inputs", () => {
  const key = deriveAttentionKey(null, [], "");
  assert.ok(key.startsWith("ephemeral:"));
});

// ─── getOrCreateAttentionContext ────────────────────────────────────────────

test("getOrCreateAttentionContext creates new context on first call", () => {
  const key = `test-create-${Date.now()}`;
  const ctx = getOrCreateAttentionContext({
    key,
    primaryGoal: "Build a REST API",
    currentFocus: "Design the schema",
  });
  assert.equal(ctx.primaryGoal, "Build a REST API");
  assert.equal(ctx.currentFocus, "Design the schema");
  assert.deepEqual(ctx.completedSteps, []);
  assert.deepEqual(ctx.blockers, []);
});

test("getOrCreateAttentionContext returns existing context on subsequent calls", () => {
  const key = `test-existing-${Date.now()}`;
  const ctx1 = getOrCreateAttentionContext({
    key,
    primaryGoal: "Goal A",
    currentFocus: "Focus A",
  });
  const ctx2 = getOrCreateAttentionContext({
    key,
    primaryGoal: "Goal B",
    currentFocus: "Focus B",
  });
  // Should retain original goal, not overwrite
  assert.equal(ctx2.primaryGoal, "Goal A");
});

test("getOrCreateAttentionContext seeds working memory from conversation", () => {
  const key = `test-seed-${Date.now()}`;
  const messages: ChatMessage[] = [
    {
      id: "m1",
      role: "user",
      mode: "auto",
      content: "We need to use PostgreSQL for the database. JWT auth is required. The API should have three main endpoints.",
      createdAt: new Date().toISOString(),
    },
  ];
  const ctx = getOrCreateAttentionContext({
    key,
    primaryGoal: "Build API",
    currentFocus: "Plan",
    conversation: messages,
  });
  assert.ok(ctx.workingMemory.length > 0, "should seed working memory from conversation");
});

// ─── setAttentionFocus ──────────────────────────────────────────────────────

test("setAttentionFocus updates currentFocus", () => {
  const key = `test-focus-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Original goal",
    currentFocus: "Original focus",
  });
  const updated = setAttentionFocus({
    key,
    currentFocus: "New focus after review",
  });
  assert.equal(updated.currentFocus, "New focus after review");
  assert.equal(updated.primaryGoal, "Original goal");
});

test("setAttentionFocus can also update primaryGoal", () => {
  const key = `test-focus-goal-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Old goal",
    currentFocus: "Old focus",
  });
  const updated = setAttentionFocus({
    key,
    primaryGoal: "Revised goal",
    currentFocus: "Revised focus",
  });
  assert.equal(updated.primaryGoal, "Revised goal");
  assert.equal(updated.currentFocus, "Revised focus");
});

// ─── recordRoleAttentionUpdate ──────────────────────────────────────────────

test("recordRoleAttentionUpdate adds completed step from role response", () => {
  const key = `test-role-update-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Build feature",
    currentFocus: "Plan",
  });
  const updated = recordRoleAttentionUpdate({
    key,
    role: "advisor",
    response: "Architecture plan is ready. We'll use three services.",
  });
  assert.ok(updated.completedSteps.length > 0, "should record a completed step");
  assert.ok(
    updated.completedSteps.some((s) => s.includes("advisor")),
    "completed step should reference the role",
  );
});

test("recordRoleAttentionUpdate updates currentFocus from handoff message", () => {
  const key = `test-handoff-focus-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Build feature",
    currentFocus: "Planning phase",
  });
  const updated = recordRoleAttentionUpdate({
    key,
    role: "advisor",
    response: "Plan complete.",
    handoffMessage: "Implement the database schema next.",
  });
  assert.equal(updated.currentFocus, "Implement the database schema next.");
});

test("recordRoleAttentionUpdate detects blockers from error keywords", () => {
  const key = `test-blocker-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Deploy service",
    currentFocus: "Running deploy",
  });
  const updated = recordRoleAttentionUpdate({
    key,
    role: "director",
    response: "Failed to connect to the database. Connection timeout after 30 seconds.",
  });
  assert.ok(updated.blockers.length > 0, "should detect a blocker from 'failed' keyword");
});

test("recordRoleAttentionUpdate does not flag blockers for normal responses", () => {
  const key = `test-no-blocker-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Write docs",
    currentFocus: "Write introduction",
  });
  const updated = recordRoleAttentionUpdate({
    key,
    role: "coordinator",
    response: "Documentation has been written successfully. All sections are complete.",
  });
  assert.equal(updated.blockers.length, 0, "should not flag blockers for success messages");
});

test("recordRoleAttentionUpdate extracts working memory candidates", () => {
  const key = `test-working-memory-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Refactor auth",
    currentFocus: "Review current code",
  });
  const updated = recordRoleAttentionUpdate({
    key,
    role: "inspector",
    response: "The auth module has 3 critical issues. JWT tokens are not validated. Session storage uses plain text. Rate limiting is missing.",
  });
  assert.ok(updated.workingMemory.length > 0, "should extract working memory from response");
});

// ─── buildAttentionPromptSection ────────────────────────────────────────────

test("buildAttentionPromptSection formats context for prompt injection", () => {
  const key = `test-prompt-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Build user management API",
    currentFocus: "Implementing database schema",
  });
  recordRoleAttentionUpdate({
    key,
    role: "advisor",
    response: "Architecture plan approved.",
  });
  const ctx = recordRoleAttentionUpdate({
    key,
    role: "director",
    response: "Project scaffolded.",
    handoffMessage: "Now implement the schema.",
  });

  const section = buildAttentionPromptSection(ctx);
  assert.ok(section.includes("[ATTENTION CONTEXT]"), "should include header");
  assert.ok(section.includes("Primary Goal:"), "should include primary goal label");
  assert.ok(section.includes("Current Focus:"), "should include current focus label");
  assert.ok(section.includes("Build user management API"), "should include the actual goal");
  assert.ok(section.includes("Completed:"), "should include completed steps");
  assert.ok(section.includes("Working Memory:"), "should include working memory");
});

test("buildAttentionPromptSection shows 'none yet' for empty completed steps", () => {
  const ctx = getOrCreateAttentionContext({
    key: `test-empty-prompt-${Date.now()}`,
    primaryGoal: "Test goal",
    currentFocus: "Test focus",
  });
  const section = buildAttentionPromptSection(ctx);
  assert.ok(section.includes("none yet"), "should show 'none yet' when no steps completed");
});

// ─── Bounds and limits ──────────────────────────────────────────────────────

test("completedSteps respects maximum limit", () => {
  const key = `test-bounds-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Stress test",
    currentFocus: "Fill steps",
  });
  // Record 30 updates (exceeds MAX_COMPLETED_STEPS of 24)
  for (let i = 0; i < 30; i++) {
    recordRoleAttentionUpdate({
      key,
      role: "director",
      response: `Completed step ${i}. This is a unique step description.`,
    });
  }
  const ctx = getOrCreateAttentionContext({
    key,
    primaryGoal: "Stress test",
    currentFocus: "Check bounds",
  });
  assert.ok(ctx.completedSteps.length <= 24, `should cap completed steps at 24, got ${ctx.completedSteps.length}`);
});

test("workingMemory respects maximum limit of 10 items", () => {
  const key = `test-wm-bounds-${Date.now()}`;
  getOrCreateAttentionContext({
    key,
    primaryGoal: "Memory test",
    currentFocus: "Fill memory",
  });
  // Record updates with many bullet points to fill working memory
  for (let i = 0; i < 15; i++) {
    recordRoleAttentionUpdate({
      key,
      role: "coordinator",
      response: `- Important fact number ${i} that should be remembered. This is a unique piece of information that the agent needs to track.`,
    });
  }
  const ctx = getOrCreateAttentionContext({
    key,
    primaryGoal: "Memory test",
    currentFocus: "Check bounds",
  });
  assert.ok(ctx.workingMemory.length <= 10, `should cap working memory at 10, got ${ctx.workingMemory.length}`);
});
