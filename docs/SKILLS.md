# Ember Skills Format

Skills are markdown files that inject prompt content into an agent role's system
prompt at runtime. They replace hardcoded `systemPrompt` strings on `EmberTool`
objects and let you tune agent behavior without touching TypeScript.

The format is identical to the one used by Qwen-Code and OpenClaw so skills can
be shared across compatible frameworks.

---

## File layout

```
<skill-name>/
└── SKILL.md          ← the skill file (required)
```

Skills are discovered from three locations, in ascending priority order:

| Layer | Path | Who controls it |
|---|---|---|
| Bundled | `skills/<name>/SKILL.md` (repo root) | Ember core team |
| User | `~/.ember/skills/<name>/SKILL.md` | Individual user |
| Project | `.ember/skills/<name>/SKILL.md` | Per-project override |

**Precedence:** if two skill files share the same `name` field, the higher-priority
layer wins. Project > User > Bundled.

---

## File format

```
---
name: <identifier>
description: <one-line description>
roles: [coordinator, advisor, director, inspector, ops]
tools: [tool_name_1, tool_name_2]
---

# Skill Title

Markdown body injected verbatim into the role's system prompt.
```

### Frontmatter fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | **yes** | Unique identifier. Must be a slug (`kebab-case`). Used for precedence merging and `loadSkill()` lookup. |
| `description` | string | **yes** | One-line human description. Shown in skill listings. |
| `roles` | string[] | no | Which Ember roles receive this skill. **Omit or leave empty to inject into all roles.** Valid values: `coordinator`, `advisor`, `director`, `inspector`, `ops`, `dispatch`. |
| `tools` | string[] | no | Tool names that must be in the role's active tool set for this skill to inject. If present, the skill only injects when at least one of the listed tools is available to the role. Leave empty or omit for pure prompt-only skills. |

### Inline vs block array syntax

Both YAML forms are accepted:

```yaml
# inline
roles: [coordinator, director]
tools: [browser, fetch_page]

# block
roles:
  - coordinator
  - director
tools:
  - browser
  - fetch_page
```

---

## Skill body

The body (everything after the closing `---`) is raw markdown. It is appended
verbatim to the `tools` section of the role's `PromptStack`. Write it as if it
were part of the system prompt — use `##` headings, bullet lists, and code
blocks freely.

Keep skill bodies concise. Smaller models have limited context windows and every
token counts. Aim for < 400 tokens per skill body.

---

## Example: tool skill

```
---
name: web-search
description: Use for current or external information. Pair with fetch_page.
roles: [coordinator, advisor, director, inspector]
tools: [web_search]
---

## Web Search

Use `web_search` for current events, external documentation, or anything not
in the codebase.

- Always follow up with `fetch_page` on the most relevant result — snippets
  alone are not enough evidence.
- Use specific query terms. Prefer `"exact phrase"` quotes for precise matches.
- If the first result set is unhelpful, rephrase the query before giving up.
```

---

## Example: role-scoped skill (no tool dependency)

```
---
name: loop-prevention
description: Rules to stop the agent from reading or calling the same thing twice.
---

## Loop Prevention

- Do NOT call the same tool with the same input twice in a row unless the
  underlying state changed.
- After getting a tool result, decide: is the task done? If yes, respond.
- If you are going in circles, stop and respond with what you know.
- Once you have enough information, stop using tools and answer.
```

---

## How skills are injected

At request time the `SkillManager`:

1. Scans all three directory layers and merges by `name` (project wins).
2. Calls `listSkills(role)` — returns skills where:
   - `roles` is empty or includes the active role, **and**
   - `tools` is empty **or** at least one listed tool is in the role's active
     tool set.
3. Appends each skill's body to the `tools` field of `PromptStack`.

---

## Creating a new skill

1. Create `skills/<your-skill-name>/SKILL.md` at the repo root (bundled) or in
   `~/.ember/skills/` (personal) or `.ember/skills/` (project).
2. Add YAML frontmatter with at minimum `name` and `description`.
3. Write the markdown body.
4. Restart the Ember server — skills are loaded at startup.

No TypeScript changes required.
