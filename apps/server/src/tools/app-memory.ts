import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { randomUUID } from "node:crypto";
import type { EmberTool } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface AppStep {
  order: number;
  action: string;
  target: string;
  value: string;
  note: string;
}

interface UILandmark {
  name: string;
  description: string;
  locationHint: string;
}

interface KeyboardShortcut {
  action: string;
  keys: string;
  platform: string;
}

interface AppMemoryEntry {
  id: string;
  appName: string;
  appIdentifier: string;
  platform: string;
  category: string;
  title: string;
  description: string;
  steps: AppStep[];
  shortcuts: KeyboardShortcut[];
  uiLandmarks: UILandmark[];
  tags: string[];
  confidence: number;
  lastVerified: string | null;
  lastUsed: string | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

interface AppMemoryStore {
  version: number;
  entries: AppMemoryEntry[];
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = [
  "workflow",
  "shortcut",
  "ui_layout",
  "quirk",
  "setup",
  "navigation",
  "preference",
  "automation",
] as const;

const VALID_STEP_ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "type",
  "shortcut",
  "wait",
  "navigate",
  "verify",
  "open",
  "focus",
  "scroll",
  "drag",
  "menu",
  "select",
  "toggle",
  "screenshot",
  "other",
] as const;

const VALID_PLATFORMS = ["linux", "darwin", "win32", "any"] as const;

// ─── Storage ────────────────────────────────────────────────────────────────────

function getStorePath(): string {
  const emberDir = join(homedir(), ".ember");
  mkdirSync(emberDir, { recursive: true });
  return join(emberDir, "app-memory.json");
}

function readStore(): AppMemoryStore {
  const storePath = getStorePath();
  if (!existsSync(storePath)) {
    return { version: 1, entries: [] };
  }
  try {
    const raw = readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as AppMemoryStore;
    return parsed && Array.isArray(parsed.entries)
      ? parsed
      : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeStore(store: AppMemoryStore): void {
  const storePath = getStorePath();
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function normalizeAppId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function detectPlatform(): string {
  return platform();
}

// ─── Scoring ────────────────────────────────────────────────────────────────────

function scoreMatch(entry: AppMemoryEntry, query: string, filters: {
  app?: string;
  category?: string;
  platform?: string;
}): number {
  const q = query.toLowerCase();
  let score = 0;

  // App name match
  if (filters.app) {
    const filterApp = normalizeAppId(filters.app);
    if (entry.appIdentifier === filterApp) score += 10;
    else if (entry.appIdentifier.includes(filterApp) || filterApp.includes(entry.appIdentifier)) score += 5;
    else return 0; // Hard filter: if app specified but doesn't match, skip
  }

  // Category match
  if (filters.category) {
    if (entry.category === filters.category) score += 3;
    else return 0; // Hard filter
  }

  // Platform match
  if (filters.platform) {
    if (entry.platform === filters.platform || entry.platform === "any") score += 2;
    else if (filters.platform === "any") score += 1;
    else return 0; // Hard filter
  }

  // Text relevance
  if (!q) return score > 0 ? score : 1;

  const words = q.split(/\s+/).filter(Boolean);
  const searchableText = [
    entry.title,
    entry.description,
    entry.appName,
    ...entry.tags,
    ...entry.steps.map((s) => `${s.target} ${s.value} ${s.note}`),
    ...entry.shortcuts.map((s) => `${s.action} ${s.keys}`),
    ...entry.uiLandmarks.map((l) => `${l.name} ${l.description}`),
  ]
    .join(" ")
    .toLowerCase();

  for (const word of words) {
    if (searchableText.includes(word)) score += 2;
    else if (searchableText.indexOf(word) !== -1) score += 1;
  }

  // Boost by use count and recency
  score += Math.min(entry.useCount * 0.1, 2);
  if (entry.lastVerified) {
    const daysSinceVerified = (Date.now() - new Date(entry.lastVerified).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceVerified < 7) score += 1;
  }

  return score;
}

// ─── Tool: app_memory_save ──────────────────────────────────────────────────────

function parseSteps(value: unknown): AppStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item, index) => ({
      order: typeof item.order === "number" ? item.order : index + 1,
      action: typeof item.action === "string" && (VALID_STEP_ACTIONS as readonly string[]).includes(item.action)
        ? item.action
        : "other",
      target: typeof item.target === "string" ? item.target : "",
      value: typeof item.value === "string" ? item.value : "",
      note: typeof item.note === "string" ? item.note : "",
    }));
}

function parseShortcuts(value: unknown): KeyboardShortcut[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      action: typeof item.action === "string" ? item.action : "",
      keys: typeof item.keys === "string" ? item.keys : "",
      platform: typeof item.platform === "string" ? item.platform : "any",
    }))
    .filter((s) => s.action && s.keys);
}

function parseLandmarks(value: unknown): UILandmark[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      description: typeof item.description === "string" ? item.description : "",
      locationHint: typeof item.location_hint === "string"
        ? item.location_hint
        : typeof item.locationHint === "string"
          ? item.locationHint
          : "",
    }))
    .filter((l) => l.name);
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

async function appMemorySaveExecute(input: Record<string, unknown>): Promise<string> {
  const appName = typeof input.app_name === "string" ? input.app_name.trim() : "";
  if (!appName) return "Error: app_name is required.";

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return "Error: title is required (short description of this workflow or knowledge).";

  const description = typeof input.description === "string" ? input.description.trim() : "";
  const rawCategory = typeof input.category === "string" ? input.category.trim().toLowerCase() : "workflow";
  const category = (VALID_CATEGORIES as readonly string[]).includes(rawCategory) ? rawCategory : "workflow";

  const rawPlatform = typeof input.platform === "string" ? input.platform.trim().toLowerCase() : detectPlatform();
  const entryPlatform = (VALID_PLATFORMS as readonly string[]).includes(rawPlatform) ? rawPlatform : "any";

  const steps = parseSteps(input.steps);
  const shortcuts = parseShortcuts(input.shortcuts);
  const uiLandmarks = parseLandmarks(input.ui_landmarks);
  const tags = parseTags(input.tags);

  const confidence = typeof input.confidence === "number" && input.confidence >= 0 && input.confidence <= 1
    ? input.confidence
    : 0.8;

  const appIdentifier = normalizeAppId(appName);
  const now = new Date().toISOString();

  const store = readStore();

  // Check for duplicate (same app + same title)
  const existing = store.entries.find(
    (e) => e.appIdentifier === appIdentifier && e.title.toLowerCase() === title.toLowerCase(),
  );

  if (existing) {
    // Update the existing entry
    existing.description = description || existing.description;
    existing.category = category;
    existing.platform = entryPlatform;
    if (steps.length > 0) existing.steps = steps;
    if (shortcuts.length > 0) existing.shortcuts = [...existing.shortcuts, ...shortcuts];
    if (uiLandmarks.length > 0) existing.uiLandmarks = [...existing.uiLandmarks, ...uiLandmarks];
    if (tags.length > 0) existing.tags = [...new Set([...existing.tags, ...tags])];
    existing.confidence = confidence;
    existing.updatedAt = now;
    existing.lastVerified = now;

    writeStore(store);
    return `Updated existing app memory: ${existing.id}\nApp: ${existing.appName}\nTitle: ${existing.title}\nCategory: ${existing.category}\nSteps: ${existing.steps.length} | Shortcuts: ${existing.shortcuts.length} | Landmarks: ${existing.uiLandmarks.length}`;
  }

  const entry: AppMemoryEntry = {
    id: `app-${randomUUID().slice(0, 8)}`,
    appName,
    appIdentifier,
    platform: entryPlatform,
    category,
    title,
    description,
    steps,
    shortcuts,
    uiLandmarks,
    tags,
    confidence,
    lastVerified: now,
    lastUsed: null,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  store.entries.push(entry);
  writeStore(store);

  console.log(`[tool:app_memory_save] ${appName} — ${title}`);

  return `Saved app memory: ${entry.id}\nApp: ${appName}\nTitle: ${title}\nCategory: ${category}\nPlatform: ${entryPlatform}\nSteps: ${steps.length} | Shortcuts: ${shortcuts.length} | Landmarks: ${uiLandmarks.length}`;
}

// ─── Tool: app_memory_search ────────────────────────────────────────────────────

async function appMemorySearchExecute(input: Record<string, unknown>): Promise<string> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const appFilter = typeof input.app_name === "string" ? input.app_name.trim() : undefined;
  const categoryFilter = typeof input.category === "string" ? input.category.trim().toLowerCase() : undefined;
  const platformFilter = typeof input.platform === "string"
    ? input.platform.trim().toLowerCase()
    : undefined;
  const maxResults = typeof input.max_results === "number" && Number.isFinite(input.max_results)
    ? Math.max(1, Math.min(20, Math.floor(input.max_results)))
    : 10;

  if (!query && !appFilter && !categoryFilter) {
    return "Error: provide at least one of query, app_name, or category.";
  }

  const store = readStore();
  if (store.entries.length === 0) {
    return "No app memories stored yet. Use app_memory_save to record workflows after learning how to use an app.";
  }

  console.log(`[tool:app_memory_search] query="${query}" app="${appFilter ?? ""}" category="${categoryFilter ?? ""}"`);

  const scored = store.entries
    .map((entry) => ({
      entry,
      score: scoreMatch(entry, query, {
        app: appFilter,
        category: categoryFilter,
        platform: platformFilter,
      }),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  if (scored.length === 0) {
    const hint = appFilter ? ` for app "${appFilter}"` : "";
    return `No app memories found${hint}${query ? ` matching "${query}"` : ""}. Try a broader search or save new knowledge with app_memory_save.`;
  }

  const lines = scored.map((s, i) => {
    const e = s.entry;
    const parts = [
      `${i + 1}. [${e.id}] ${e.appName} — ${e.title}`,
      `   Category: ${e.category} | Platform: ${e.platform} | Score: ${s.score.toFixed(1)}`,
      `   Steps: ${e.steps.length} | Shortcuts: ${e.shortcuts.length} | Uses: ${e.useCount}`,
    ];
    if (e.description) {
      parts.push(`   ${e.description.length > 120 ? e.description.slice(0, 117) + "..." : e.description}`);
    }
    return parts.join("\n");
  });

  return [`App memory results (${scored.length}):`, "", ...lines].join("\n");
}

// ─── Tool: app_memory_get ───────────────────────────────────────────────────────

async function appMemoryGetExecute(input: Record<string, unknown>): Promise<string> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return "Error: id is required.";

  const store = readStore();
  const entry = store.entries.find((e) => e.id === id);

  if (!entry) {
    return `Error: app memory "${id}" not found.`;
  }

  // Mark as used
  entry.lastUsed = new Date().toISOString();
  entry.useCount += 1;
  writeStore(store);

  console.log(`[tool:app_memory_get] ${entry.appName} — ${entry.title}`);

  const sections: string[] = [
    `App Memory: ${entry.id}`,
    `App: ${entry.appName} (${entry.appIdentifier})`,
    `Title: ${entry.title}`,
    `Category: ${entry.category}`,
    `Platform: ${entry.platform}`,
    `Confidence: ${entry.confidence.toFixed(2)}`,
    `Use count: ${entry.useCount}`,
    `Created: ${entry.createdAt}`,
    `Updated: ${entry.updatedAt}`,
    `Last verified: ${entry.lastVerified ?? "(never)"}`,
    `Last used: ${entry.lastUsed ?? "(never)"}`,
    `Tags: ${entry.tags.join(", ") || "(none)"}`,
    "",
  ];

  if (entry.description) {
    sections.push(`Description:\n${entry.description}`, "");
  }

  if (entry.steps.length > 0) {
    sections.push("Steps:");
    for (const step of entry.steps) {
      const parts = [`  ${step.order}. [${step.action}]`];
      if (step.target) parts.push(`target: "${step.target}"`);
      if (step.value) parts.push(`value: "${step.value}"`);
      sections.push(parts.join(" "));
      if (step.note) sections.push(`     Note: ${step.note}`);
    }
    sections.push("");
  }

  if (entry.shortcuts.length > 0) {
    sections.push("Keyboard Shortcuts:");
    for (const sc of entry.shortcuts) {
      sections.push(`  ${sc.keys} — ${sc.action}${sc.platform !== "any" ? ` (${sc.platform})` : ""}`);
    }
    sections.push("");
  }

  if (entry.uiLandmarks.length > 0) {
    sections.push("UI Landmarks:");
    for (const lm of entry.uiLandmarks) {
      sections.push(`  ${lm.name}: ${lm.description}${lm.locationHint ? ` [${lm.locationHint}]` : ""}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

// ─── Tool: app_memory_delete ────────────────────────────────────────────────────

async function appMemoryDeleteExecute(input: Record<string, unknown>): Promise<string> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return "Error: id is required.";
  if (input.confirm !== true) return "Error: set confirm=true to delete an app memory.";

  const store = readStore();
  const index = store.entries.findIndex((e) => e.id === id);

  if (index === -1) {
    return `Error: app memory "${id}" not found.`;
  }

  const removed = store.entries.splice(index, 1)[0];
  writeStore(store);

  console.log(`[tool:app_memory_delete] ${removed.appName} — ${removed.title}`);

  return `Deleted app memory: ${removed.id}\nApp: ${removed.appName}\nTitle: ${removed.title}`;
}

// ─── Tool: app_memory_list ──────────────────────────────────────────────────────

async function appMemoryListExecute(input: Record<string, unknown>): Promise<string> {
  const appFilter = typeof input.app_name === "string" ? input.app_name.trim() : "";
  const store = readStore();

  if (store.entries.length === 0) {
    return "No app memories stored yet.";
  }

  console.log(`[tool:app_memory_list] ${appFilter || "(all)"}`);

  // Group by app
  const byApp = new Map<string, AppMemoryEntry[]>();
  for (const entry of store.entries) {
    if (appFilter && entry.appIdentifier !== normalizeAppId(appFilter)) continue;
    const existing = byApp.get(entry.appIdentifier);
    if (existing) {
      existing.push(entry);
    } else {
      byApp.set(entry.appIdentifier, [entry]);
    }
  }

  if (byApp.size === 0) {
    return appFilter
      ? `No app memories found for "${appFilter}".`
      : "No app memories stored yet.";
  }

  const sections: string[] = [`App Memory Index (${store.entries.length} total across ${byApp.size} apps):`, ""];

  for (const [appId, entries] of byApp) {
    const appName = entries[0].appName;
    const categories = new Map<string, number>();
    for (const e of entries) {
      categories.set(e.category, (categories.get(e.category) ?? 0) + 1);
    }
    const catSummary = [...categories.entries()]
      .map(([cat, count]) => `${count} ${cat}`)
      .join(", ");

    const platforms = [...new Set(entries.map((e) => e.platform))].join(", ");

    sections.push(`${appName} (${appId}): ${entries.length} memories`);
    sections.push(`  Categories: ${catSummary}`);
    sections.push(`  Platforms: ${platforms}`);

    // Show up to 5 most recent per app
    const recent = entries
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5);
    for (const e of recent) {
      sections.push(`  - [${e.id}] ${e.title} (${e.category}, uses: ${e.useCount})`);
    }
    if (entries.length > 5) {
      sections.push(`  ... and ${entries.length - 5} more`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

// ─── Tool Exports ───────────────────────────────────────────────────────────────

export const appMemorySaveTool: EmberTool = {
  definition: {
    name: "app_memory_save",
    description:
      "Save knowledge about how to use a desktop or CLI application: workflows, shortcuts, UI layout, quirks, or setup steps. " +
      "Records structured steps, keyboard shortcuts, and UI landmarks so the agent can recall how to operate the app in future sessions. " +
      "Automatically detects the current OS platform. Updates existing entries if the same app+title already exists.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Display name of the application (e.g. 'GIMP', 'Firefox', 'VS Code', 'LibreOffice Calc').",
        },
        title: {
          type: "string",
          description: "Short title describing this workflow or knowledge (e.g. 'Export image as PNG', 'Navigate to Extensions panel').",
        },
        description: {
          type: "string",
          description: "Longer explanation of the workflow, when to use it, or why it matters.",
        },
        category: {
          type: "string",
          enum: [...VALID_CATEGORIES],
          description: "Type of knowledge. Default: workflow.",
        },
        platform: {
          type: "string",
          enum: [...VALID_PLATFORMS],
          description: "Which OS this applies to. Default: current platform. Use 'any' for cross-platform workflows.",
        },
        steps: {
          type: "array",
          description: "Ordered list of actions to perform.",
          items: {
            type: "object",
            properties: {
              order: { type: "number", description: "Step number (auto-assigned if omitted)." },
              action: {
                type: "string",
                enum: [...VALID_STEP_ACTIONS],
                description: "The type of action.",
              },
              target: { type: "string", description: "UI element or location to act on." },
              value: { type: "string", description: "Text to type, key combo, menu path, etc." },
              note: { type: "string", description: "Tip or observation about this step." },
            },
          },
        },
        shortcuts: {
          type: "array",
          description: "Keyboard shortcuts for the app.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", description: "What the shortcut does." },
              keys: { type: "string", description: "Key combination (e.g. 'Ctrl+Shift+E')." },
              platform: { type: "string", description: "OS this applies to. Default: any." },
            },
            required: ["action", "keys"],
          },
        },
        ui_landmarks: {
          type: "array",
          description: "Notable UI elements and where to find them.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Name of the UI element." },
              description: { type: "string", description: "What it does." },
              location_hint: { type: "string", description: "Where on screen (e.g. 'top menu bar', 'left panel')." },
            },
            required: ["name"],
          },
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for retrieval (e.g. 'image-editing', 'export', 'batch').",
        },
        confidence: {
          type: "number",
          description: "How confident this workflow is correct (0.0 to 1.0). Default: 0.8.",
        },
      },
      required: ["app_name", "title"],
    },
  },
  execute: appMemorySaveExecute,
};

export const appMemorySearchTool: EmberTool = {
  definition: {
    name: "app_memory_search",
    description:
      "Search stored app memories by app name, text query, category, or platform. " +
      "Use before attempting desktop automation to recall known workflows, shortcuts, and UI layouts. " +
      "Returns ranked results with IDs for detailed retrieval via app_memory_get.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text search across titles, descriptions, steps, and tags.",
        },
        app_name: {
          type: "string",
          description: "Filter by application name.",
        },
        category: {
          type: "string",
          enum: [...VALID_CATEGORIES],
          description: "Filter by category.",
        },
        platform: {
          type: "string",
          enum: [...VALID_PLATFORMS],
          description: "Filter by platform.",
        },
        max_results: {
          type: "number",
          description: "Maximum results to return. Default 10, max 20.",
        },
      },
    },
  },
  execute: appMemorySearchExecute,
};

export const appMemoryGetTool: EmberTool = {
  definition: {
    name: "app_memory_get",
    description:
      "Retrieve full details of an app memory by ID, including all steps, shortcuts, UI landmarks, and metadata. " +
      "Use after app_memory_search to get the complete workflow before replaying it. " +
      "Automatically tracks use count and last-used timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The app memory ID to retrieve.",
        },
      },
      required: ["id"],
    },
  },
  execute: appMemoryGetExecute,
};

export const appMemoryDeleteTool: EmberTool = {
  definition: {
    name: "app_memory_delete",
    description:
      "Delete an app memory entry. Use when a workflow is outdated, the app has changed, or the user asks to remove it. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The app memory ID to delete.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm deletion.",
        },
      },
      required: ["id", "confirm"],
    },
  },
  execute: appMemoryDeleteExecute,
};

export const appMemoryListTool: EmberTool = {
  definition: {
    name: "app_memory_list",
    description:
      "List all applications that have stored memories, with counts by category and recent entries. " +
      "Optionally filter to a single app. Use to get an overview of what the agent already knows how to do.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Optional: filter to a specific application.",
        },
      },
    },
  },
  execute: appMemoryListExecute,
};
