import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSwarmSimulateInput } from "./swarm-simulation.js";

test("normalizeSwarmSimulateInput infers create when scenario is present", () => {
  const normalized = normalizeSwarmSimulateInput({
    scenario: "Will Bitcoin hit $100k by year-end?",
    persona_count: 8,
    round_count: 3,
    domain: "finance",
  });

  assert.equal(normalized.action, "create");
  assert.equal(normalized.scenario, "Will Bitcoin hit $100k by year-end?");
  assert.equal(normalized.personaCount, 8);
  assert.equal(normalized.roundCount, 3);
  assert.equal(normalized.domain, "finance");
});

test("normalizeSwarmSimulateInput accepts alias fields and strips think tags", () => {
  const normalized = normalizeSwarmSimulateInput({
    operation: "simulate",
    prompt: "<think>tool plan</think>Scenario: Bitcoin reaching 100k by Dec 31",
    personas: "9",
    rounds: "4",
  });

  assert.equal(normalized.action, "create");
  assert.equal(normalized.scenario, "Bitcoin reaching 100k by Dec 31");
  assert.equal(normalized.personaCount, 9);
  assert.equal(normalized.roundCount, 4);
  assert.equal(normalized.domain, "finance");
});

test("normalizeSwarmSimulateInput infers status when only simulation id is present", () => {
  const normalized = normalizeSwarmSimulateInput({
    simulationId: "sim_abc123",
  });

  assert.equal(normalized.action, "status");
  assert.equal(normalized.simulationId, "sim_abc123");
});

test("normalizeSwarmSimulateInput maps delete aliases and confirm aliases", () => {
  const normalized = normalizeSwarmSimulateInput({
    command: "remove",
    sim_id: "sim_deadbeef",
    force: "true",
  });

  assert.equal(normalized.action, "delete");
  assert.equal(normalized.simulationId, "sim_deadbeef");
  assert.equal(normalized.confirm, true);
});

test("normalizeSwarmSimulateInput enforces minimum 8 personas", () => {
  const normalized = normalizeSwarmSimulateInput({
    scenario: "Will the Fed cut rates next FOMC?",
    persona_count: 3,
  });

  assert.equal(normalized.personaCount, 8);
});

test("normalizeSwarmSimulateInput parses provider deployment instances", () => {
  const normalized = normalizeSwarmSimulateInput({
    scenario: "Will the Fed cut rates next FOMC?",
    persona_count: 20,
    provider_instances: [
      { provider_id: "codex", model_id: "gpt-5", usage: "persona", instances: 10 },
      { provider_id: "local", model_id: "qwen", usage: "persona", count: 5 },
      { provider_id: "deepseek", model_id: "deepseek-chat", usage: "persona", replicas: 5 },
    ],
  });

  assert.equal(normalized.providerModelPool.length, 3);
  assert.equal(normalized.providerModelPool[0]?.replicas, 10);
  assert.equal(normalized.providerModelPool[1]?.replicas, 5);
  assert.equal(normalized.providerModelPool[2]?.replicas, 5);
});
