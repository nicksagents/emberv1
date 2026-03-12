# Ember Tool System

Tools give roles the ability to take actions: run commands, inspect files, search the web,
call APIs, and automate browsers. Each role gets a specific subset of tools.
The system composes a tight system prompt from only the tools that role has access to,
so no model sees more than it needs.

---

## How tools work end-to-end

```
User sends message
  → Role is selected (router or direct)
  → getToolsForRole(role) returns the ToolDefinition[] for that role
  → getToolSystemPrompt(tools, role) builds the tools section of the system prompt:
      - Tool-gated skill bodies (from skills/<tool-name>/SKILL.md)
      - Role-scoped skill bodies (loop-prevention, coordinator-behavior, etc.)
      - Dynamic workflow hints based on the active tool set
  → The LLM receives: shared prompt + role prompt + tools prompt + conversation
  → LLM responds and optionally requests a tool call
  → handleToolCall(name, input) dispatches to the tool's execute() function
  → Result is fed back to the LLM (loops up to the configured tool-turn limit)
  → LLM produces a final text response
```

The tool loop streams in real time — text content is emitted as it arrives, and a
status event ("Tool: web_search") is emitted before each tool call so the UI can
show progress.

---

## Two ways to expose tools

### Option A: Native EmberTool (TypeScript)

For tools that need custom Node.js logic — file I/O, terminal management, etc.

**1. Create a tool file** at `apps/server/src/tools/my-tool.ts`:

```ts
import type { EmberTool } from "./types.js";

async function execute(input: Record<string, unknown>): Promise<string> {
  const value = typeof input.my_param === "string" ? input.my_param : "";
  if (!value) return "Error: my_param is required.";
  return `Result: ${value}`;
}

export const myTool: EmberTool = {
  definition: {
    name: "my_tool_name",          // snake_case, unique across all tools
    description:
      "One or two sentences the LLM reads to decide when to call this tool. " +
      "Be specific about what it does and when NOT to use it.",
    inputSchema: {
      type: "object",
      properties: {
        my_param: { type: "string", description: "What this parameter is for." },
      },
      required: ["my_param"],
    },
  },
  execute,
};
```

**2. Register it** in `apps/server/src/tools/index.ts`:

```ts
import { myTool } from "./my-tool.js";

const REGISTRY: EmberTool[] = [...existingTools, myTool];

const ROLE_TOOLS: Record<Role, EmberTool[]> = {
  coordinator: [...existingTools, myTool],
  // ...
};
```

**3. Add a skill file** at `skills/my-tool-name/SKILL.md`:

```markdown
---
name: my-tool-name
description: What this tool does and when to use it.
roles: [coordinator, director]
tools: [my_tool_name]
---

## My Tool

Guidance that gets injected into the system prompt whenever my_tool_name
is in the active tool set for the role...
```

### Option B: MCP Server

For tools backed by an external MCP server — browser automation, databases, APIs, etc.
No TypeScript needed. Declare the server in a config file; Ember discovers tools at startup.

**1. Add to the config file** for the appropriate scope:

| File | Scope |
|------|-------|
| `apps/server/mcp.default.json` | Bundled default (shipped with Ember) |
| `~/.ember/mcp.json` | User-level override |
| `.ember/mcp.json` | Project-level override (highest priority) |

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-package"],
      "roles": ["coordinator", "director"],
      "timeout": 30000
    }
  }
}
```

The `roles` field controls which Ember roles receive the server's tools in their tool list.
Omit it (or use `[]`) to make tools callable but not auto-listed for any role.

Bundled defaults currently include:

- `playwright` → browser automation for coordinator/advisor/director/inspector
- `scaffold` → deterministic project scaffolding for coordinator/director/ops

**2. Tools are auto-discovered** at startup and registered as `mcp__<serverName>__<toolName>`.
No code changes needed — restart the server to pick up config changes.

**3. Add a skill file** at `skills/<skill-name>/SKILL.md` gated on one of the tool names:

```markdown
---
name: my-mcp-skill
description: Workflow guide for my-server tools.
roles: [coordinator, director]
tools: [mcp__my-server__main_tool]
---

## My MCP Server Tools

Workflow guidance...
```

---

## How tools are sent to each provider

### Anthropic API
```json
{ "name": "...", "description": "...", "input_schema": { ... } }
```
Tool results come back as `tool_result` content blocks. The loop detects
`stop_reason: "tool_use"` to know when to execute.

### OpenAI-compatible (local Qwen, OpenAI, etc.)
```json
{ "type": "function", "function": { "name": "...", "description": "...", "parameters": { ... } } }
```
Tool results come back as `role: "tool"` messages. The loop detects
`finish_reason: "tool_calls"`.

---

## Per-role tool access

Browser automation is provided by the bundled `@playwright/mcp` server and registered
as `mcp__playwright__browser_*` tools at startup. The table below shows native tools only;
MCP tools from `mcp.default.json` and user/project overrides are appended at boot.

Project scaffolding is provided by the bundled `@ember/project-scaffold-mcp` server and
registered as `mcp__scaffold__*`. Coordinator and Director now share that same scaffold
tool surface; the difference between the roles is execution strategy, not tool access.

| Role        | Native tools                                                                                                              |
|-------------|---------------------------------------------------------------------------------------------------------------------------|
| dispatch    | none (classification only)                                                                                                |
| coordinator | project_overview, git_inspect, list_directory, search_files, read_file, write_file, edit_file, run_terminal_command, web_search, http_request, fetch_page, save_memory, memory_search, memory_get, forget_memory, handoff + MCP |
| advisor     | project_overview, git_inspect, list_directory, search_files, read_file, run_terminal_command, web_search, http_request, fetch_page, save_memory, memory_search, memory_get, forget_memory, handoff + MCP |
| director    | project_overview, git_inspect, list_directory, search_files, read_file, write_file, edit_file, run_terminal_command, web_search, http_request, fetch_page, save_memory, memory_search, memory_get, forget_memory, handoff + MCP |
| inspector   | project_overview, git_inspect, list_directory, search_files, read_file, run_terminal_command, web_search, http_request, fetch_page, save_memory, memory_search, memory_get, forget_memory, handoff + MCP |
| ops         | edit_file, delete_file |

---

## Skill files

Every tool should have a companion `skills/<name>/SKILL.md` that documents the
workflow. Skills are injected into the system prompt at runtime — no code changes
needed to update model guidance.

- **Tool-gated skills** (`tools: [...]`) — injected when any listed tool is active for the role
- **Role-scoped skills** (no `tools` field) — always injected for the listed roles

See `docs/SKILLS.md` for the full skill format specification and examples.

---

## Tool design guidelines

- **Return plain text.** The LLM reads the return value directly. Avoid JSON unless the LLM
  specifically needs to parse it.
- **Optimize for small models.** Prefer compact output, stable IDs, and a few high-leverage
  parameters over large raw dumps.
- **Fail loudly with a clear message.** Return `"Error: ..."` strings — don't throw. The LLM
  will see the error and can try a different approach.
- **Cap output size.** Large outputs waste context window. Truncate at reasonable limits and
  offer pagination (offset/limit) for large resources.
- **Design for cross-platform execution.** Prefer Node APIs or well-supported binaries with
  clear fallbacks so tools behave on macOS, Linux, and Windows.
- **Log what you do.** Use `console.log('[tool:name] ...')` so server logs are useful.
- **Keep execute() focused.** One tool, one job. If you need two things, make two tools.
- **async is fine.** `execute` can be `async` — the system awaits it.
