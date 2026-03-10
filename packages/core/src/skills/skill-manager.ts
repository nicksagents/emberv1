/**
 * SkillManager — discovers, parses, and serves SKILL.md files at runtime.
 *
 * Three layers are scanned in ascending priority order:
 *   1. Bundled  — skills/ at the repo root (shipped with Ember)
 *   2. User     — ~/.ember/skills/  (personal overrides)
 *   3. Project  — .ember/skills/ inside the workspace root (highest priority)
 *
 * When two skills share the same `name`, the higher-priority layer wins.
 * This mirrors the precedence model used by Qwen-Code and OpenClaw.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  /** Unique kebab-case identifier. Used for precedence merging and lookups. */
  name: string;
  /** One-line human description shown in skill listings. */
  description: string;
  /**
   * Which Ember roles receive this skill.
   * Absent or empty = inject into all roles.
   * Valid: coordinator | advisor | director | inspector | ops | dispatch
   */
  roles?: string[];
  /**
   * Tool names that must be in the role's active tool set for the skill to
   * inject. Absent or empty = no tool-gating (pure role/prompt skill).
   */
  tools?: string[];
}

export interface Skill extends SkillFrontmatter {
  /** The markdown body injected verbatim into the role's system prompt. */
  body: string;
  /** Which discovery layer this skill came from. */
  source: "bundled" | "user" | "project";
  /** Absolute path to the SKILL.md file on disk. */
  filePath: string;
}

export interface SkillsConfig {
  /**
   * Absolute path to the bundled skills directory (repo-root `skills/`).
   * Defaults to <cwd>/skills if not provided.
   */
  bundledDir?: string;
  /**
   * Absolute path to the workspace root used to resolve `.ember/skills/`.
   * Defaults to process.cwd() if not provided.
   */
  workspaceDir?: string;
}

// ─── Inline YAML Frontmatter Parser ───────────────────────────────────────
// Handles the small subset of YAML needed for SKILL.md files:
//   key: scalar-value
//   key: [item1, item2]          ← inline array
//   key:
//     - item1                    ← block array
//   key: "quoted string"

function parseInlineArray(raw: string): string[] {
  // Strip surrounding [ ]
  return raw
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = line.match(/^([\w][\w-]*):\s*(.*)/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1];
    const rest = keyMatch[2].trim();

    if (rest === "") {
      // Possibly a block array — peek ahead for `  - item` lines
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s+-\s+/, "").trim());
        i++;
      }
      result[key] = items;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      result[key] = parseInlineArray(rest);
      i++;
    } else {
      // Scalar — strip optional quotes
      result[key] = rest.replace(/^["']|["']$/g, "");
      i++;
    }
  }

  return result;
}

function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { data: {}, body: content };
  }

  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return { data: {}, body: content };

  const afterOpener = content.slice(firstNewline + 1);
  // Find closing ---
  const closingMatch = afterOpener.match(/^---\s*$/m);
  if (!closingMatch || closingMatch.index === undefined) {
    return { data: {}, body: content };
  }

  const yamlStr = afterOpener.slice(0, closingMatch.index);
  const bodyStart = closingMatch.index + closingMatch[0].length;
  const rawBody = afterOpener.slice(bodyStart);
  // Trim leading newline after closing delimiter
  const body = rawBody.startsWith("\n") ? rawBody.slice(1) : rawBody;

  return { data: parseSimpleYaml(yamlStr), body: body.trim() };
}

// ─── Directory Scanner ─────────────────────────────────────────────────────

function scanSkillDir(
  dir: string,
  source: Skill["source"],
): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    let content: string;
    try {
      content = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }

    const { data, body } = parseFrontmatter(content);

    const name = typeof data.name === "string" ? data.name.trim() : entry;
    const description =
      typeof data.description === "string" ? data.description.trim() : "";
    const roles = Array.isArray(data.roles)
      ? (data.roles as string[]).filter(Boolean)
      : [];
    const tools = Array.isArray(data.tools)
      ? (data.tools as string[]).filter(Boolean)
      : [];

    if (!name) continue; // skip malformed entries

    skills.push({ name, description, roles, tools, body, source, filePath: skillFile });
  }

  return skills;
}

// ─── SkillManager class ────────────────────────────────────────────────────

class SkillManager {
  /** name → Skill (highest-priority layer wins) */
  private cache = new Map<string, Skill>();
  private ready = false;

  /**
   * Load skills from all three layers. Safe to call multiple times — the cache
   * is rebuilt on each call (useful for hot-reload in development).
   */
  initialize(config: SkillsConfig = {}): void {
    this.cache.clear();

    const cwd = process.cwd();
    const bundledDir = resolve(config.bundledDir ?? join(cwd, "skills"));
    const userDir = join(homedir(), ".ember", "skills");
    const projectDir = join(
      config.workspaceDir ?? cwd,
      ".ember",
      "skills",
    );

    // Load layers lowest → highest priority so higher-priority entries win
    const layers: Array<{ dir: string; source: Skill["source"] }> = [
      { dir: bundledDir, source: "bundled" },
      { dir: userDir,    source: "user" },
      { dir: projectDir, source: "project" },
    ];

    for (const { dir, source } of layers) {
      for (const skill of scanSkillDir(dir, source)) {
        this.cache.set(skill.name, skill); // later entries (higher priority) overwrite
      }
    }

    this.ready = true;
  }

  /**
   * Return all skills accessible to the given role.
   *
   * A skill is accessible when:
   *   - Its `roles` array is empty/absent (applies to all roles), OR
   *   - The given role is listed in `roles`.
   *
   * If `role` is omitted every skill is returned (useful for tooling/listings).
   * If `activeToolNames` is provided, skills that declare a `tools` dependency
   * are only returned when at least one of their tools is in the active set.
   */
  listSkills(
    role?: string,
    activeToolNames?: ReadonlySet<string>,
  ): Skill[] {
    if (!this.ready) this.initialize();

    return Array.from(this.cache.values()).filter((skill) => {
      // Role filter
      if (role && skill.roles && skill.roles.length > 0) {
        if (!skill.roles.includes(role)) return false;
      }

      // Tool-gating filter
      if (
        activeToolNames !== undefined &&
        skill.tools &&
        skill.tools.length > 0
      ) {
        const hasActiveTool = skill.tools.some((t) =>
          activeToolNames.has(t),
        );
        if (!hasActiveTool) return false;
      }

      return true;
    });
  }

  /**
   * Load a single skill by name. Returns null if not found.
   * Triggers initialization if it hasn't run yet.
   */
  loadSkill(name: string): Skill | null {
    if (!this.ready) this.initialize();
    return this.cache.get(name) ?? null;
  }

  /** True if initialize() has been called at least once. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Number of skills currently loaded. */
  get count(): number {
    return this.cache.size;
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────

/**
 * The process-wide SkillManager instance.
 * Call `skillManager.initialize(config)` once at server startup.
 * After that, `listSkills()` and `loadSkill()` can be called anywhere.
 */
export const skillManager = new SkillManager();
