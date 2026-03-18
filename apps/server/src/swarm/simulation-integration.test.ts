import assert from "node:assert/strict";
import test from "node:test";

import {
  assessTask,
  buildSimulationRecommendationHint,
  shouldAutoSimulate,
} from "../metacognition.js";
import { formatSimulationResultSummary } from "./simulation-runner.js";
import type { SimulationState } from "./types.js";

test("high-stakes simulation trigger enables auto-simulation", () => {
  const assessment = assessTask(
    "What if this critical production release fails under load before launch and causes legal compliance and revenue impact?",
    [],
    "director",
  );
  assert.equal(shouldAutoSimulate(assessment), true);
});

test("simulation hint includes suggested persona and round config", () => {
  const assessment = assessTask(
    "What if we launch this urgent user-facing migration this week with legal compliance and customer revenue risk?",
    [],
    "director",
  );
  const hint = buildSimulationRecommendationHint(assessment);

  assert.ok(hint);
  assert.match(hint!, /SIMULATION RECOMMENDED/);
  assert.match(hint!, /Suggested config:/);
  assert.match(hint!, /personas/i);
  assert.match(hint!, /rounds/i);
});

test("simulation summary formats as system-message friendly block", () => {
  const state: SimulationState = {
    config: {
      id: "sim_test",
      title: "Auto Sim",
      scenario: "Should the team ship the migration now?",
      personaCount: 8,
      roundCount: 3,
      modelTier: "small",
      synthesisModelTier: "medium",
      domain: "technology",
      createdAt: "2026-03-17T00:00:00.000Z",
    },
    status: "completed",
    personas: [],
    rounds: [],
    currentRound: 3,
    finalSynthesis: null,
    probabilities: {
      "Ship now": 0.58,
      "Delay one week": 0.42,
    },
    error: null,
    startedAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:01:00.000Z",
  };

  const summary = formatSimulationResultSummary(
    state,
    "Consensus: Delay one week for validation. Risk: release regression and rollback pain. Recommended action: stage rollout in phases.",
  );

  assert.match(summary, /^## Simulation Result:/);
  assert.match(summary, /\*\*Consensus:\*\*/);
  assert.match(summary, /\*\*Key Risks:\*\*/);
  assert.match(summary, /\*\*Recommended Action:\*\*/);
  assert.match(summary, /\*\*Dissenting Views:\*\*/);
});

test("low-stakes task does not trigger auto-simulation", () => {
  const assessment = assessTask("Should I rename this local variable?", [], "director");
  assert.equal(shouldAutoSimulate(assessment), false);
  assert.equal(buildSimulationRecommendationHint(assessment), null);
});
