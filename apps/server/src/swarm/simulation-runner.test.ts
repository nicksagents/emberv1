import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePersonaResponse, buildPersonaGenerationPrompt } from "./persona-generator.js";
import type { SimulationPersona, SimulationConfig, SimulationCancelSignal } from "./types.js";

// We test the pure parsing/extraction functions directly.
// Full simulation tests require file I/O; they use EMBER_TEST_MODE env var
// to skip persistence (see simulation-store.ts).

// Import runner functions — createSimulation/runFullSimulation use saveSimulationState
// which writes to disk. For unit tests of parsing, we only import the pure functions.
const { parsePersonaAction, extractProbabilities } = await import("./simulation-runner.js");

function makeConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    id: "sim_test",
    title: "Test Simulation",
    scenario: "Will AI agents become mainstream by 2027?",
    personaCount: 4,
    roundCount: 2,
    modelTier: "small",
    synthesisModelTier: "medium",
    domain: "technology",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePersona(id: string, name: string, role: string): SimulationPersona {
  return {
    id,
    name,
    role,
    background: "Test background",
    biases: ["test bias"],
    expertise: ["testing"],
    personality: "analytical",
    perspective: "Test perspective",
  };
}

// ─── parsePersonaAction tests ───────────────────────────────────────────────────

describe("parsePersonaAction", () => {
  const persona = makePersona("p1", "Alice", "Analyst");

  it("parses valid JSON response", () => {
    const response = '{"content":"AI will grow rapidly","confidence":0.85,"reasoning":"Strong trends"}';
    const { action, usedFallback } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.content, "AI will grow rapidly");
    assert.equal(action.confidence, 0.85);
    assert.equal(action.reasoning, "Strong trends");
    assert.equal(usedFallback, false);
  });

  it("parses JSON in code fences", () => {
    const response = '```json\n{"content":"Analysis here","confidence":0.7}\n```';
    const { action, usedFallback } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.content, "Analysis here");
    assert.equal(action.confidence, 0.7);
    assert.equal(usedFallback, false);
  });

  it("handles malformed JSON with trailing commas", () => {
    const response = '{"content":"Some analysis","confidence":0.6,}';
    const { action } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.content, "Some analysis");
    assert.equal(action.confidence, 0.6);
  });

  it("extracts confidence from plain text", () => {
    const response = "I think AI will grow significantly. My confidence is 0.8 on this.";
    const { action, usedFallback } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.confidence, 0.8);
    assert.equal(usedFallback, true);
  });

  it("extracts confidence from percentage", () => {
    const response = "Likely outcome with about 75% confidence.";
    const { action } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.confidence, 0.75);
  });

  it("handles response that is just a number", () => {
    const response = "0.72";
    const { action } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.confidence, 0.72);
  });

  it("handles confidence as string in JSON", () => {
    const response = '{"content":"test","confidence":"0.7"}';
    const { action } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.confidence, 0.7);
  });

  it("strips 'As a ...' preamble from fallback content", () => {
    const response = "As a Risk Analyst, I believe the market will recover.";
    const { action } = parsePersonaAction(response, persona, 1, "opinion");
    assert.ok(!action.content.startsWith("As a"));
  });

  it("handles empty/garbage response gracefully", () => {
    const response = "!!!***";
    const { action, usedFallback } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.confidence, 0.5); // default
    assert.equal(usedFallback, true);
  });

  it("clamps confidence to 0-1 range", () => {
    const response = '{"content":"test","confidence":1.5}';
    const { action } = parsePersonaAction(response, persona, 1, "opinion");
    assert.equal(action.confidence, 1);
  });
});

// ─── parsePersonaResponse tests ─────────────────────────────────────────────────

describe("parsePersonaResponse", () => {
  const config = makeConfig({ personaCount: 3 });

  it("parses valid JSON array", () => {
    const response = JSON.stringify([
      { id: "p1", name: "Alice", role: "Analyst", perspective: "Data-driven" },
      { id: "p2", name: "Bob", role: "Strategist", perspective: "Execution-focused" },
      { id: "p3", name: "Carol", role: "Skeptic", perspective: "Risk-aware" },
    ]);
    const personas = parsePersonaResponse(response, config);
    assert.equal(personas.length, 3);
    assert.equal(personas[0].name, "Alice");
  });

  it("handles JSON with trailing commas", () => {
    const response = `[{"id":"p1","name":"Alice","role":"Analyst","perspective":"test",},]`;
    const personas = parsePersonaResponse(response, config);
    assert.ok(personas.length > 0);
  });

  it("handles single-quoted JSON", () => {
    const response = `[{'id':'p1','name':'Alice','role':'Analyst','perspective':'test'}]`;
    const personas = parsePersonaResponse(response, config);
    assert.ok(personas.length > 0);
  });

  it("handles bare objects without array brackets", () => {
    const response = `{"id":"p1","name":"Alice","role":"Analyst","perspective":"test"}
{"id":"p2","name":"Bob","role":"Strategist","perspective":"growth"}`;
    const personas = parsePersonaResponse(response, config);
    assert.ok(personas.length >= 1);
  });

  it("extracts personas from structured text", () => {
    const response = `1. Alice Chen - Risk Analyst - Focuses on downside risks
2. Bob Webb - Optimist - Sees growth opportunity
3. Carol Kim - Contrarian - Challenges consensus`;
    const personas = parsePersonaResponse(response, config);
    assert.equal(personas.length, 3);
    assert.equal(personas[0].role, "Risk Analyst");
  });

  it("fills defaults for missing fields", () => {
    const response = JSON.stringify([{ id: "p1", name: "Alice" }]);
    const personas = parsePersonaResponse(response, config);
    assert.equal(personas[0].role, "Analyst"); // default
    assert.equal(personas[0].personality, "analytical"); // default
  });

  it("generates fallback personas on garbage input", () => {
    const response = "This is not valid at all!!!";
    const personas = parsePersonaResponse(response, config);
    assert.equal(personas.length, 3); // fallback archetypes
    assert.ok(personas[0].name.includes("Agent"));
  });

  it("handles JSON in code fences", () => {
    const response = '```json\n[{"id":"p1","name":"Test","role":"Analyst","perspective":"data"}]\n```';
    const personas = parsePersonaResponse(response, config);
    assert.equal(personas.length, 1);
    assert.equal(personas[0].name, "Test");
  });
});

// ─── extractProbabilities tests ─────────────────────────────────────────────────

describe("extractProbabilities", () => {
  it("extracts from JSON in code fences", () => {
    const synthesis = 'Analysis...\n```json\n{"bullish": 0.65, "bearish": 0.35}\n```';
    const probs = extractProbabilities(synthesis);
    assert.ok(probs);
    assert.equal(probs.bullish, 0.65);
    assert.equal(probs.bearish, 0.35);
  });

  it("extracts from standalone JSON object", () => {
    const synthesis = 'Probabilities: {"outcome_a": 0.4, "outcome_b": 0.6}';
    const probs = extractProbabilities(synthesis);
    assert.ok(probs);
    assert.equal(probs.outcome_a, 0.4);
  });

  it("extracts from 'Outcome: XX%' format", () => {
    const synthesis = `Key outcomes:
Growth scenario: 65%
Stagnation: 25%
Decline: 10%`;
    const probs = extractProbabilities(synthesis);
    assert.ok(probs);
    assert.equal(probs["Growth scenario"], 0.65);
    assert.equal(probs["Stagnation"], 0.25);
  });

  it("extracts from numbered list format", () => {
    const synthesis = `1. Strong growth - 55%
2. Moderate growth - 30%
3. Decline - 15%`;
    const probs = extractProbabilities(synthesis);
    assert.ok(probs);
    assert.equal(probs["Strong growth"], 0.55);
  });

  it("handles percentage values > 1 in JSON (treats as percentage)", () => {
    const synthesis = '```json\n{"high": 65, "low": 35}\n```';
    const probs = extractProbabilities(synthesis);
    assert.ok(probs);
    assert.equal(probs.high, 0.65);
    assert.equal(probs.low, 0.35);
  });

  it("handles string percentages in JSON", () => {
    const synthesis = '```json\n{"high": "65%", "low": "35%"}\n```';
    const probs = extractProbabilities(synthesis);
    assert.ok(probs);
    assert.equal(probs.high, 0.65);
  });

  it("returns null when no probabilities found", () => {
    const synthesis = "This is just a summary with no probability data.";
    const probs = extractProbabilities(synthesis);
    assert.equal(probs, null);
  });
});

// ─── Compact prompt tests ───────────────────────────────────────────────────────

describe("compact mode prompts", () => {
  it("compact persona generation prompt is shorter", () => {
    const fullConfig = makeConfig({ modelTier: "medium", compactMode: false });
    const compactConfig = makeConfig({ modelTier: "small", compactMode: true });

    const fullPrompt = buildPersonaGenerationPrompt(fullConfig);
    const compactPrompt = buildPersonaGenerationPrompt(compactConfig);

    assert.ok(compactPrompt.length < fullPrompt.length, "Compact prompt should be shorter");
  });
});
