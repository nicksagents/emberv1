# Ember

A multi-role AI agent framework that runs a team of specialised agents — coordinator, advisor, director, inspector, ops, and dispatch — powered by any LLM you connect.

---

## Getting Started

### Prerequisites

- **Node.js** v20 or later — [nodejs.org](https://nodejs.org)
- **pnpm** — installed automatically by the setup script if missing
- **Git**

### 1. Clone the repo

```bash
git clone https://github.com/your-org/ember.git
cd ember
```

### 2. Install

```bash
bash scripts/install.sh
```

This script will:

- Verify Node.js ≥ 20 and install pnpm if needed
- Install all workspace dependencies
- Create a `.env` file from `.env.example`
- Initialise the `data/` directory with empty JSON files
- Build all packages (`core`, `ui-schema`, `connectors`, `prompts`)
- Install Playwright Chromium (used for browser automation)
- Install the global `ember` command to `~/.local/bin/ember`

> If your shell does not pick up the `ember` command after install, run `source ~/.zshrc` (or `~/.bashrc`) to reload your PATH.

### 3. Run

```bash
ember
```

This starts the API server (`http://localhost:3005`) and the web UI (`http://localhost:3000`) and opens the UI in your browser automatically.

To stop, press **Ctrl-C**.

### Update an existing install

```bash
ember update
```

This command:

- Stops managed Ember services before updating
- Pulls the latest code from the tracked GitHub branch
- Reapplies your local repo changes
- Reinstalls dependencies and rebuilds packages
- Preserves local `.env`, chats, memories, providers, and other files in `data/`

Local files such as `.env` and everything in `data/` are user-owned state and should stay out of git. Ember recreates missing local state files on install/startup.

---

## UI Setup

Once Ember is running, open **http://localhost:3000** and complete the following steps.

### Add a provider

1. Go to **Settings → Providers**.
2. Click **Add Provider** and choose your LLM backend (e.g. OpenAI, Anthropic, Ollama, or a custom OpenAI-compatible endpoint).
3. Enter the required credentials (API key, base URL, etc.) and save.

### Assign models to roles

1. Go to **Settings → Roles**.
2. For each role (coordinator, advisor, director, inspector, ops, dispatch) select the model you want it to use from the provider you just added.
3. Save the assignments.

Ember will now route agent messages through the correct models automatically.

### Configure connectors (optional)

Connectors let agents interact with external services (GitHub, Jira, Slack, etc.).

1. Go to **Settings → Connectors**.
2. Enable the connectors you want and supply any required credentials.

---

## Developer Guide

### Adding custom skills

Skills are Markdown files that inject instructions and tool permissions into an agent's system prompt. Ember loads skills from three locations, in order of precedence (highest first):

| Location | Scope |
|---|---|
| `.ember/skills/<skill-name>/SKILL.md` | Project-local (repo root) |
| `~/.ember/skills/<skill-name>/SKILL.md` | User-global |
| `skills/<skill-name>/SKILL.md` | Built-in (shipped with Ember) |

A local skill overrides a built-in skill with the same directory name.

#### SKILL.md format

```markdown
---
name: my-skill
description: One-line description shown in the UI and used for skill discovery.
roles: [coordinator, advisor]   # which roles load this skill
tools: [my_tool, web_search]    # tool names that must be available (gates the skill)
---

## My Skill

Write plain Markdown instructions here. The agent reads this as part of its
system prompt when all listed tools are available.

### Example

Use `my_tool` to do X, then call `web_search` to verify Y.
```

**Frontmatter fields:**

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique identifier for the skill |
| `description` | yes | Short description (used for discovery) |
| `roles` | yes | Array of role names that load this skill |
| `tools` | no | Array of tool names; skill is omitted if any tool is missing |

#### Creating a project-local skill

```bash
mkdir -p .ember/skills/my-skill
cat > .ember/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: Does something useful.
roles: [coordinator]
tools: [web_search]
---

## My Skill

Instructions for the coordinator agent...
EOF
```

The skill is picked up on the next request — no restart required.

---

### Adding custom tools

There are two ways to expose new tools to Ember agents.

#### Option A — Native EmberTool (TypeScript)

Native tools are defined in `apps/server/src/tools/` and run in-process.

1. Create a new file, e.g. `apps/server/src/tools/my-tool.ts`:

```typescript
import { z } from "zod";
import type { EmberTool } from "./types";

export const myTool: EmberTool = {
  name: "my_tool",
  description: "Does something useful.",
  inputSchema: z.object({
    query: z.string().describe("The input to process"),
  }),
  async execute({ query }) {
    // your implementation
    return { result: `Processed: ${query}` };
  },
};
```

2. Register the tool in `apps/server/src/tools/index.ts` by importing and adding it to the `TOOL_MAP`.

3. Restart the server — the tool is now available to any skill that lists `my_tool` in its `tools` frontmatter.

#### Option B — MCP server

Ember speaks the [Model Context Protocol](https://modelcontextprotocol.io/). Any MCP-compatible server can expose tools to Ember agents.

Create or edit `.ember/mcp.json` in your project root (or `~/.ember/mcp.json` for user-global config):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/absolute/path/to/my-mcp-server/index.js"]
    }
  }
}
```

Or for an npm package:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-package"]
    }
  }
}
```

Ember merges configs from three layers (highest precedence first):

1. `.ember/mcp.json` — project-local
2. `~/.ember/mcp.json` — user-global
3. `mcp.default.json` — built-in defaults

Tools from the MCP server will be available under the name `mcp__<server-name>__<tool-name>`. Reference them in skill frontmatter using that full name:

```markdown
---
name: my-skill
tools: [mcp__my-server__some_tool]
---
```

---

## Environment variables

The `.env` file (created from `.env.example` during install) controls ports and hostnames:

| Variable | Default | Description |
|---|---|---|
| `EMBER_WEB_PORT` | `3000` | Port for the web UI |
| `EMBER_RUNTIME_PORT` | `3005` | Port for the API server |
| `EMBER_WEB_HOST` | `127.0.0.1` | Bind address for the web UI |
| `EMBER_RUNTIME_HOST` | `127.0.0.1` | Bind address for the API server |

---

## Project structure

```
ember/
├── apps/
│   ├── server/          # API server (Node.js / TypeScript)
│   └── web/             # Web UI (Next.js)
├── packages/
│   ├── core/            # Shared types and utilities
│   ├── connectors/      # External service connectors
│   ├── prompts/         # System prompt builders
│   └── ui-schema/       # Shared UI component schemas
├── skills/              # Built-in skills (SKILL.md files)
├── scripts/
│   └── install.sh       # One-time setup script
├── ember                # Start script (run `./ember` or `ember`)
└── .env.example         # Environment variable template
```
