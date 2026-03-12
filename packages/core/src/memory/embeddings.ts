import type { MemoryConfig } from "./types";

const SYNONYM_GROUPS = [
  ["birthday", "birthdate", "dob", "born", "dateofbirth"],
  ["preference", "prefer", "likes", "favorite", "favours"],
  ["law", "rule", "regulation", "policy", "statute"],
  ["event", "incident", "news", "happened", "occurred"],
  ["workspace", "project", "repo", "repository", "codebase"],
] as const;

const SYNONYM_MAP = new Map<string, string[]>(
  SYNONYM_GROUPS.flatMap((group) =>
    group.map((term) => [term, group.filter((candidate) => candidate !== term)] as const),
  ),
);

export function buildEmbedding(text: string, config: MemoryConfig): number[] {
  const dimensions = config.embeddings.dimensions;
  const vector = new Array<number>(dimensions).fill(0);
  const features = extractSemanticFeatures(text);

  for (const feature of features) {
    const { index, sign } = signedHash(feature, dimensions);
    vector[index] += sign;
  }

  return normalizeVector(vector);
}

export function serializeEmbedding(vector: number[]): string {
  return JSON.stringify(vector);
}

export function parseEmbedding(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  } catch {
    return [];
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function extractSemanticFeatures(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const features = new Set<string>();

  for (const token of tokens) {
    features.add(`tok:${token}`);
    for (const expanded of expandToken(token)) {
      features.add(`syn:${expanded}`);
    }
    const stem = stemToken(token);
    if (stem && stem !== token) {
      features.add(`stem:${stem}`);
    }
  }

  for (let index = 0; index < tokens.length - 1; index++) {
    features.add(`bi:${tokens[index]}_${tokens[index + 1]}`);
  }

  const dense = normalized.replace(/\s+/g, "_");
  for (let index = 0; index <= dense.length - 3; index++) {
    features.add(`tri:${dense.slice(index, index + 3)}`);
  }

  return [...features];
}

function expandToken(token: string): string[] {
  return SYNONYM_MAP.get(token) ?? [];
}

function stemToken(token: string): string {
  if (token.endsWith("ing") && token.length > 5) {
    return token.slice(0, -3);
  }
  if (token.endsWith("ed") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("es") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && token.length > 3) {
    return token.slice(0, -1);
  }
  if (token.endsWith("date")) {
    return token.replace(/date$/, "");
  }
  return token;
}

function signedHash(value: string, modulus: number): { index: number; sign: number } {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const positive = hash >>> 0;
  return {
    index: positive % modulus,
    sign: positive % 2 === 0 ? 1 : -1,
  };
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}
