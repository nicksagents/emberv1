---
name: project-scaffold
description: Deterministic project scaffolding workflow for small roles. Scaffold first, then hand off implementation to director.
roles: [coordinator, ops]
tools: [mcp__scaffold__list_templates, mcp__scaffold__scaffold_project]
---

## Project Scaffolding

Use the scaffold MCP tools when the user wants a new repo, starter, boilerplate,
template, or fresh project setup.

- Prefer curated templates over hand-writing starter files.
- Keep the loop tight: `list_templates` → `get_template_options` →
  `scaffold_project` → `post_setup`.
- Ask only for high-impact missing inputs like target directory, stack, app vs.
  library, or package manager.
- Do not spend time manually polishing scaffold code beyond obvious placeholders.
- After scaffolding, hand off to `director` for the real implementation pass.

### Director Handoff

Your handoff message should include:

- template id
- target directory
- main entrypoints created
- the user's actual product goal
- any setup commands or follow-up commands returned by the scaffold tool
