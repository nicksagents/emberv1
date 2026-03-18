/**
 * Persona Generator
 *
 * Generates diverse simulated personas for a given scenario using a single
 * LLM call. Supports both full prompts (medium/large models) and compact
 * prompts (small 0.8B-3B models). Parsing is extremely tolerant of
 * malformed output.
 */

import type { SimulationConfig, SimulationPersona } from "./types.js";

// ─── Prompt Generation ──────────────────────────────────────────────────────────

export function buildPersonaGenerationPrompt(config: SimulationConfig): string {
  const isCompact = config.compactMode || config.modelTier === "small";
  return isCompact
    ? buildPersonaGenerationPromptCompact(config)
    : buildPersonaGenerationPromptFull(config);
}

function buildPersonaGenerationPromptFull(config: SimulationConfig): string {
  return `You are generating ${config.personaCount} diverse personas for a multi-perspective simulation.

SCENARIO: ${config.scenario}
DOMAIN: ${config.domain}

Generate exactly ${config.personaCount} personas that represent DELIBERATELY DIVERSE perspectives on this scenario. Include:
- Bulls AND bears / optimists AND pessimists
- Specialists AND generalists
- Different professional backgrounds
- Different risk tolerances
- At least one contrarian/devil's advocate

For each persona, output a JSON object with these exact fields:
- id: "p1", "p2", etc.
- name: A realistic name
- role: Their professional role/title (e.g., "Risk Analyst", "Venture Capitalist", "Regulatory Expert")
- background: 2-3 sentences about their experience and worldview
- biases: Array of 2-3 known biases they carry (e.g., "confirmation bias toward tech disruption", "anchoring to historical patterns")
- expertise: Array of 2-3 areas of deep knowledge
- personality: One descriptor (e.g., "cautious", "aggressive", "analytical", "intuitive")
- perspective: One sentence summarizing their core lens for viewing this scenario

Output ONLY a JSON array of ${config.personaCount} persona objects. No commentary.`;
}

function buildPersonaGenerationPromptCompact(config: SimulationConfig): string {
  // 2-shot example + simplified fields for small models
  return `Generate ${config.personaCount} personas for: ${config.scenario}
Domain: ${config.domain}

Each persona needs: id, name, role, perspective.
Optional: background, biases, expertise, personality.

Example output:
[
  {"id":"p1","name":"Sarah Chen","role":"Risk Analyst","perspective":"Focuses on downside risks"},
  {"id":"p2","name":"Marcus Webb","role":"Optimist","perspective":"Sees growth opportunity"}
]

Now generate ${config.personaCount} DIVERSE personas (optimists, skeptics, specialists, contrarians). Output ONLY a JSON array.`;
}

// ─── Tolerant Parsing ───────────────────────────────────────────────────────────

export function parsePersonaResponse(response: string, config: SimulationConfig): SimulationPersona[] {
  let cleaned = response.trim();

  // Strip markdown code fences if present
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    cleaned = jsonMatch[1].trim();
  }

  // Strategy 1: Standard JSON parse
  const parsed = tryParseJsonArray(cleaned);
  if (parsed) {
    const personas = normalizePersonaArray(parsed, config);
    if (personas.length > 0) return personas;
  }

  // Strategy 2: Fix common small-model JSON errors
  const fixed = fixMalformedJson(cleaned);
  if (fixed !== cleaned) {
    const fixedParsed = tryParseJsonArray(fixed);
    if (fixedParsed) {
      const personas = normalizePersonaArray(fixedParsed, config);
      if (personas.length > 0) return personas;
    }
  }

  // Strategy 3: Try parsing as individual JSON objects separated by newlines
  const objects = extractJsonObjects(cleaned);
  if (objects.length > 0) {
    const personas = normalizePersonaArray(objects, config);
    if (personas.length > 0) return personas;
  }

  // Strategy 4: Regex extraction of name/role/perspective patterns from text
  const regexPersonas = extractPersonasFromText(cleaned, config);
  if (regexPersonas.length > 0) return regexPersonas;

  // Final fallback: generate archetype personas
  console.log("[swarm:persona-generator] All parsing strategies failed, generating fallback personas");
  return generateFallbackPersonas(config);
}

function tryParseJsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;
    // Single object wrapped — treat as array of one
    if (typeof parsed === "object" && parsed !== null) return [parsed];
    return null;
  } catch {
    return null;
  }
}

function fixMalformedJson(text: string): string {
  let fixed = text;
  // Remove trailing commas before ] or }
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");
  // Replace single quotes with double quotes (but not inside strings)
  fixed = fixed.replace(/'/g, '"');
  // Wrap bare objects in array brackets if missing
  if (!fixed.startsWith("[") && fixed.startsWith("{")) {
    // Multiple objects separated by newlines or commas
    fixed = "[" + fixed + "]";
  }
  // Fix unquoted keys: word: -> "word":
  fixed = fixed.replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');
  return fixed;
}

function extractJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  // Find all {...} blocks
  const regex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[0]) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        objects.push(obj as Record<string, unknown>);
      }
    } catch {
      // Try fixing this individual object
      try {
        const fixed = fixMalformedJson(match[0]);
        const obj = JSON.parse(fixed) as unknown;
        if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
          objects.push(obj as Record<string, unknown>);
        }
      } catch {
        // Skip unparseable object
      }
    }
  }
  return objects;
}

function extractPersonasFromText(text: string, config: SimulationConfig): SimulationPersona[] {
  const personas: SimulationPersona[] = [];
  // Look for patterns like:
  //   Name: ..., Role: ..., Perspective: ...
  //   1. Name - Role - Perspective
  //   **Name** (Role): Perspective
  const lines = text.split("\n").filter((l) => l.trim().length > 10);

  for (const line of lines) {
    // Pattern: Name: X, Role: Y, Perspective: Z
    const kvMatch = line.match(/name[:\s]+([^,]+?)(?:,\s*|\s+)role[:\s]+([^,]+?)(?:,\s*|\s+)perspective[:\s]+(.+)/i);
    if (kvMatch) {
      personas.push(makePersona(personas.length, kvMatch[1].trim(), kvMatch[2].trim(), kvMatch[3].trim(), config));
      continue;
    }

    // Pattern: N. Name - Role - Perspective
    const numberedMatch = line.match(/^\d+[.)]\s*(.+?)\s*[-–—]\s*(.+?)\s*[-–—]\s*(.+)/);
    if (numberedMatch) {
      personas.push(makePersona(personas.length, numberedMatch[1].trim(), numberedMatch[2].trim(), numberedMatch[3].trim(), config));
      continue;
    }

    // Pattern: **Name** (Role): Perspective
    const mdMatch = line.match(/\*\*(.+?)\*\*\s*\((.+?)\)[:\s]+(.+)/);
    if (mdMatch) {
      personas.push(makePersona(personas.length, mdMatch[1].trim(), mdMatch[2].trim(), mdMatch[3].trim(), config));
      continue;
    }

    if (personas.length >= config.personaCount) break;
  }

  return personas;
}

function makePersona(index: number, name: string, role: string, perspective: string, config: SimulationConfig): SimulationPersona {
  return {
    id: `p${index + 1}`,
    name: name || `Persona ${index + 1}`,
    role: role || "Analyst",
    background: `A ${config.domain} ${role.toLowerCase()} who ${perspective.toLowerCase()}.`,
    biases: [],
    expertise: [config.domain],
    personality: "analytical",
    perspective,
  };
}

function normalizePersonaArray(items: unknown[], config: SimulationConfig): SimulationPersona[] {
  return items.slice(0, config.personaCount).map((item, index) => {
    const obj = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    return {
      id: typeof obj.id === "string" ? obj.id : `p${index + 1}`,
      name: typeof obj.name === "string" ? obj.name : `Persona ${index + 1}`,
      role: typeof obj.role === "string" ? obj.role : "Analyst",
      background: typeof obj.background === "string" ? obj.background : "",
      biases: Array.isArray(obj.biases)
        ? (obj.biases as unknown[]).filter((b): b is string => typeof b === "string")
        : typeof obj.biases === "string" ? [obj.biases] : [],
      expertise: Array.isArray(obj.expertise)
        ? (obj.expertise as unknown[]).filter((e): e is string => typeof e === "string")
        : typeof obj.expertise === "string" ? [obj.expertise] : [],
      personality: typeof obj.personality === "string" ? obj.personality : "analytical",
      perspective: typeof obj.perspective === "string" ? obj.perspective : "",
    };
  });
}

// ─── Fallback Personas ──────────────────────────────────────────────────────────

export function generateFallbackPersonas(config: SimulationConfig): SimulationPersona[] {
  const archetypes = [
    { role: "Optimist", personality: "enthusiastic", perspective: "sees opportunity" },
    { role: "Skeptic", personality: "cautious", perspective: "questions assumptions" },
    { role: "Analyst", personality: "analytical", perspective: "follows the data" },
    { role: "Strategist", personality: "pragmatic", perspective: "focuses on execution" },
    { role: "Contrarian", personality: "provocative", perspective: "challenges consensus" },
    { role: "Specialist", personality: "detail-oriented", perspective: "focuses on technical depth" },
    { role: "Generalist", personality: "broad-minded", perspective: "sees cross-domain connections" },
    { role: "Risk Analyst", personality: "conservative", perspective: "identifies downside risks" },
    { role: "Innovator", personality: "creative", perspective: "imagines novel solutions" },
    { role: "Realist", personality: "grounded", perspective: "anchors to historical patterns" },
    { role: "Ethicist", personality: "principled", perspective: "evaluates moral implications" },
    { role: "Futurist", personality: "visionary", perspective: "projects long-term trends" },
  ];

  return archetypes.slice(0, config.personaCount).map((arch, i) => ({
    id: `p${i + 1}`,
    name: `${arch.role} Agent`,
    role: arch.role,
    background: `A ${config.domain} ${arch.role.toLowerCase()} who ${arch.perspective}.`,
    biases: [`${arch.personality} bias`],
    expertise: [config.domain],
    personality: arch.personality,
    perspective: `${arch.perspective} in the context of ${config.domain}`,
  }));
}
