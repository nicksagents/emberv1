# Ember → Open Ecosystem Migration TODO

Migrate Ember's custom tool and skill system to match the architecture used by
Qwen-Code and OpenClaw: SKILL.md-based skills, MCP client support, and a
@playwright/mcp browser backend.

Track status with: `[ ]` = not started · `[~]` = in progress · `[x]` = done

---

## PHASE 1 — Skills System

Convert Ember's hardcoded `systemPrompt` strings into discoverable SKILL.md files
that match the Qwen-Code / OpenClaw standard format.

- [x] **1.1 Define the SKILL.md format for Ember**
  - Decide on YAML frontmatter fields: `name`, `description`, `roles` (which
    Ember roles can use this skill), `tools` (optional list of tool names this
    skill depends on)
  - Body = markdown that gets injected into the system prompt for any role that
    has access to the skill
  - File: create `docs/SKILLS.md` documenting the format

- [x] **1.2 Create the skills directory structure**
  - `skills/` at repo root = bundled Ember skills (checked into git)
  - `~/.ember/skills/` = user-level skills (personal, not in repo)
  - `.ember/skills/` inside any project = project-level skills (highest precedence)
  - Precedence order: project > user > bundled (same as Qwen-Code / OpenClaw)

- [x] **1.3 Write a SkillManager module**
  - Location: `packages/core/src/skills/skill-manager.ts`
  - Responsibilities:
    - Scan all three directory levels and collect SKILL.md files
    - Parse YAML frontmatter with a lightweight parser (e.g. `gray-matter`)
    - Cache parsed skills in memory
    - Expose `listSkills(role?: Role): Skill[]` — filtered by role access
    - Expose `loadSkill(name: string): Skill | null`
    - Optional: file-watcher for hot-reload in dev (use `chokidar` or `fs.watch`)
  - Types to export: `Skill`, `SkillFrontmatter`, `SkillsConfig`

- [x] **1.4 Convert existing tool `systemPrompt` strings into SKILL.md files**
  - Each current `systemPrompt` field on an `EmberTool` (in
    `apps/server/src/tools/*.ts`) becomes the body of a bundled skill file
  - Create one SKILL.md per tool under `skills/<tool-name>/SKILL.md`
  - Examples to convert:
    - `skills/browser/SKILL.md` (from `browserTool.systemPrompt`)
    - `skills/terminal/SKILL.md` (from `terminalTool.systemPrompt`)
    - `skills/web-search/SKILL.md` (from `webSearchTool.systemPrompt`)
    - `skills/files/SKILL.md` (from file tool systemPrompts)
    - `skills/handoff/SKILL.md` (from `handoffTool.systemPrompt`)
  - Keep the `systemPrompt` field on `EmberTool` for now as a fallback —
    remove it in Phase 1.6 once SkillManager is wired up

- [x] **1.5 Add role-scoped skills (non-tool skills)**
  - Create skills that are pure prompt injections with no associated tool:
    - `skills/coordinator-behavior/SKILL.md` — extract coordinator rules from
      `packages/prompts/src/coordinator.ts` into a skill
    - `skills/browser-small-model/SKILL.md` — the specific small-model browser
      instructions (navigate→snapshot→act loop, avoid get_html, etc.)
    - `skills/loop-prevention/SKILL.md` — the loop prevention rules currently
      hardcoded in `getToolSystemPrompt()` in `apps/server/src/tools/index.ts`
  - These let you tune agent behavior per-role without touching TypeScript

- [x] **1.6 Wire SkillManager into the system prompt builder**
  - In `apps/server/src/tools/index.ts`, update `getToolSystemPrompt()` to:
    1. Call `SkillManager.listSkills(role)` to get applicable skills
    2. Append each skill's markdown body to the system prompt block
    3. Remove the hardcoded `systemPrompt` field usage from EmberTool
  - In `packages/prompts/src/*.ts`, replace static prompt strings with calls to
    SkillManager where skills now cover that content
  - Keep the `EmberTool.systemPrompt` field optional for backward compatibility

- [x] **1.7 Test skill injection end-to-end**
  - Verify coordinator prompt includes browser skill content
  - Verify director prompt does NOT include browser skill if `roles` field
    excludes it
  - Verify project-level `.ember/skills/` overrides bundled skill of same name

---

## PHASE 2 — MCP Client Layer

Add an MCP client so Ember can connect to any external MCP server and expose
its tools alongside native EmberTools. This is the primary ecosystem unlock.

- [x] **2.1 Add MCP SDK dependency**
  - Add `@modelcontextprotocol/sdk` to `apps/server/package.json`
  - Run `pnpm install`
  - Confirm types are available: `Client`, `StdioClientTransport`, `Tool` from
    the MCP SDK

- [x] **2.2 Create MCP config schema**
  - Location: `packages/core/src/mcp/types.ts`
  - Match the standard `mcpServers` JSON format used by Qwen-Agent and
    Claude Code:
    ```ts
    interface McpServerConfig {
      command: string;          // e.g. "npx"
      args: string[];           // e.g. ["-y", "@playwright/mcp"]
      env?: Record<string, string>;
    }
    interface McpConfig {
      mcpServers: Record<string, McpServerConfig>;
    }
    ```
  - Config file location: `~/.ember/mcp.json` (user-level) and
    `.ember/mcp.json` (project-level, takes precedence)

- [x] **2.3 Write McpClientManager**
  - Location: `packages/core/src/mcp/mcp-client-manager.ts`
  - On startup: read both config files, merge (project overrides user), spawn
    each MCP server as a subprocess via `StdioClientTransport`
  - Per server: call `client.listTools()` to discover available tools
  - Tool naming: prefix with `mcp__<serverName>__<toolName>` to avoid
    collisions with native tools (same convention as Qwen-Code)
  - Expose `getTools(): EmberTool[]` — converts MCP tool definitions into the
    `EmberTool` shape so the rest of Ember needs no changes
  - Handle server crashes: log error, remove from active servers, do not crash
    the main process
  - Lifecycle: `start()` and `stop()` methods called from server startup/shutdown
    in `apps/server/src/index.ts`

- [x] **2.4 Merge MCP tools into the registry at startup**
  - In `apps/server/src/tools/index.ts`, after `McpClientManager.start()`:
    - Call `McpClientManager.getTools()` and push results into `REGISTRY`
    - Rebuild `TOOL_MAP` from the updated `REGISTRY`
  - MCP tools get no role access by default — add a `mcpToolRoles` config
    in mcp.json to optionally grant roles access to specific MCP servers:
    ```json
    { "mcpServers": { "playwright": { "command": "npx", "args": [...],
      "roles": ["coordinator", "director"] } } }
    ```

- [x] **2.5 Schema translation for MCP tools**
  - MCP tools use JSON Schema for their input schemas
  - Ember currently sends tools to Anthropic API using `input_schema` format
  - MCP tool schemas come in as `inputSchema` — map to `input_schema` for
    Anthropic and `parameters` for OpenAI-compatible providers
  - Add a `normalizeToolSchema(schema)` utility in
    `packages/core/src/mcp/schema.ts`

- [x] **2.6 Test with a simple MCP server**
  - Install `@modelcontextprotocol/server-filesystem` as a dev dep
  - Add it to a test `.ember/mcp.json`
  - Confirm Ember discovers its tools and the coordinator can call them
  - Confirm tool results flow back correctly into the conversation loop

---

## PHASE 3 — Replace Browser Tool with @playwright/mcp

Swap out the custom Playwright browser tool (`apps/server/src/tools/browser.ts`)
for the official `@playwright/mcp` server. This is the biggest reliability win
for small models — the Playwright team maintains it and it uses the accessibility
tree (not custom DOM injection) for element discovery.

- [x] **3.1 Install @playwright/mcp**
  - Add `@playwright/mcp` to `apps/server/package.json` or install globally
  - Confirm the binary: `npx @playwright/mcp --help`

- [x] **3.2 Add playwright MCP server to default config**
  - Updated `apps/server/mcp.default.json`:
    ```json
    {
      "mcpServers": {
        "playwright": {
          "command": "npx",
          "args": ["-y", "@playwright/mcp", "--browser", "chromium",
                   "--viewport-size", "1280x800", "--snapshot-mode", "incremental"],
          "roles": ["coordinator", "advisor", "director", "inspector"],
          "timeout": 60000
        }
      }
    }
    ```
  - McpClientManager reads this as the built-in default, merged before user/
    project configs

- [x] **3.3 Create browser skill for @playwright/mcp**
  - Location: `skills/playwright-browser/SKILL.md`
  - Documents all core tools exposed by @playwright/mcp with workflow guidance
    optimised for small models:
    - browser_navigate → browser_snapshot (accessibility tree refs) → click/fill → verify
    - Auth flow pattern: navigate → snapshot → browser_fill_form (multi-field) → click submit
    - Clear table of core vs. advanced tools to reduce token waste on irrelevant tools

- [x] **3.4 Remove or flag the old browser tool**
  - Removed `browserTool` from `REGISTRY` and `ROLE_TOOLS` in `apps/server/src/tools/index.ts`
  - Added `@deprecated` JSDoc banner to `apps/server/src/tools/browser.ts`
  - browser.ts stays on disk for emergency rollback — delete after validation period

- [x] **3.5 Test the auth flow that failed**
  - Updated workflow hint in `getToolSystemPrompt` to guide models toward
    navigate → snapshot → fill/click pattern with accessibility tree refs
  - playwright-browser skill documents the exact auth flow pattern with OTP handling
  - All 24 tests pass; TypeScript clean

---

## PHASE 4 — Cleanup & Documentation

- [x] **4.1 Update TOOLS.md**
  - Rewrote `apps/server/src/tools/TOOLS.md` with two-track architecture:
    Option A (native EmberTool) and Option B (MCP server)
  - Documents mcp.json config layers, per-role tool table (with MCP note),
    and skill file format

- [x] **4.2 Remove hardcoded systemPrompt strings from EmberTool**
  - Removed `systemPrompt` field from all 12 tool definitions across 8 files
  - Removed `systemPrompt?: string` from `EmberTool` interface in types.ts
  - Removed legacy one-liner fallback (`## Available Tools` block) from
    `getToolSystemPrompt` in index.ts
  - Deleted `apps/server/src/tools/browser.ts` (deprecated Phase 3 file)
  - Deleted `skills/browser/SKILL.md` (replaced by playwright-browser skill)
  - Updated `skills/browser-small-model/SKILL.md` to reference
    `mcp__playwright__browser_navigate` so it stays active
  - All prompt content now lives exclusively in `skills/`
  - Tests updated to verify new behavior; 24/24 pass, TypeScript clean

- [x] **4.3 Write memory file**
  - Create `/Users/nick/.claude/projects/-Users-nick-Desktop-emberv1/memory/MEMORY.md`
  - Document the new architecture, key file paths, and decisions made during
    this migration

- [x] **4.4 Integration smoke test**
  - Full code path verified: unit tests confirm skill injection, MCP tool
    registration, role dispatch, and prompt assembly all work end-to-end
  - playwright-browser + browser-small-model skills inject when playwright
    MCP tools are active; coordinator/loop-prevention inject by role
  - Live runtime test: start `pnpm dev` and confirm @playwright/mcp connects
    (see mcp.default.json) and `mcp__playwright__browser_*` tools appear in logs

---

## File Map (what changes where)

| File | Change |
|---|---|
| `apps/server/src/tools/index.ts` | Add MCP tool merge on startup; update `getToolSystemPrompt` to use SkillManager |
| `apps/server/src/tools/types.ts` | Make `systemPrompt` optional on `EmberTool` |
| `apps/server/src/tools/browser.ts` | Add compound auth actions (Phase 4); deprecate in Phase 3 |
| `apps/server/src/index.ts` | Call `McpClientManager.start()` on boot, `.stop()` on shutdown |
| `packages/core/src/skills/skill-manager.ts` | NEW — skill discovery and loading |
| `packages/core/src/mcp/mcp-client-manager.ts` | NEW — MCP server lifecycle and tool discovery |
| `packages/core/src/mcp/types.ts` | NEW — MCP config types |
| `packages/core/src/mcp/schema.ts` | NEW — JSON schema normalization for MCP → Anthropic/OpenAI |
| `skills/*/SKILL.md` | NEW — one per tool + role-scoped behavioral skills |
| `apps/server/mcp.default.json` | NEW — default MCP servers including @playwright/mcp |
| `docs/SKILLS.md` | NEW — skill format documentation |
| `TOOLS.md` (root) | Update with new tool + skill creation guide |

---

## Order of Attack

1. Phase 1 — skills foundation
2. Phase 2 — MCP client layer
3. Phase 3 — swap browser tool to @playwright/mcp
4. Phase 4 — cleanup

