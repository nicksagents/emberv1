---
name: mcp-usage
description: MCP (Model Context Protocol) awareness — how to discover and use tools, resources, and prompts from connected MCP servers.
roles: [coordinator, advisor, director, inspector, ops]
tools: [mcp_resources, mcp_prompts]
---

## Model Context Protocol (MCP)

You have access to MCP servers that extend your capabilities beyond native tools. MCP is a standard protocol that lets external servers expose **tools**, **resources**, and **prompts** to you.

### What MCP gives you

| Capability | What it is | How you access it |
|------------|-----------|-------------------|
| **Tools** | Actions the server can perform (browse, query, control) | Call directly via `mcp__<server>__<tool>` |
| **Resources** | Data the server exposes (files, configs, live state, DB records) | `mcp_resources` action=list/read |
| **Prompts** | Pre-built instruction templates from the server | `mcp_prompts` action=list/get |

### MCP tool naming

All MCP tools follow the pattern: `mcp__<serverName>__<toolName>`

Examples:
- `mcp__playwright__browser_navigate` = Playwright server, navigate tool
- `mcp__filesystem__read_file` = Filesystem server, read_file tool
- `mcp__scaffold__scaffold_project` = Scaffold server, scaffold_project tool

### Using MCP resources

Resources are contextual data exposed by MCP servers. Unlike tools (which perform actions), resources provide read-only data — files, configuration, database records, API state, etc.

**Workflow:**
1. `mcp_resources` action=list — discover what's available across all servers
2. `mcp_resources` action=read, server=`<name>`, uri=`<uri>` — fetch specific content

Resource URIs follow standard schemes:
- `file:///path/to/file` — file content
- `db://table/id` — database records
- Custom schemes defined by the server

**When to use resources vs. native file tools:**
- Use `mcp_resources` when the data comes from an MCP server's domain (database, API state, server-managed configs)
- Use native `read_file` / `search_files` for workspace files you can access directly
- If both could work, prefer the native tool (faster, no server round-trip)

### Using MCP prompts

Prompts are reusable instruction templates provided by MCP servers. They contain pre-built workflows, context, or guidance for specific tasks.

**Workflow:**
1. `mcp_prompts` action=list — discover available prompt templates
2. `mcp_prompts` action=get, server=`<name>`, name=`<promptName>`, arguments={...} — retrieve a prompt

Prompt arguments marked with `*` are required. Fill them to get a complete template.

**When to use prompts:**
- When a server offers domain-specific guidance you don't have natively
- When the task aligns with a prompt's description
- To bootstrap a workflow the server was designed to support

### Discovery pattern

When working with an unfamiliar MCP server or uncertain what's available:

```
1. Check your tool list — MCP tools (mcp__*) tell you what actions are available
2. mcp_resources action=list — check if the server exposes data you can read
3. mcp_prompts action=list — check if the server has workflow templates
4. Use the most specific capability for your task
```

### Best practices

- **Prefer specific tools over generic ones** — if `mcp__server__search` exists, use it instead of reading every resource manually
- **Check resources before asking the user** — the server may already expose the data you need
- **Use prompts for unfamiliar domains** — if a server provides a prompt for your task, use it as guidance
- **Handle errors gracefully** — MCP servers can timeout or disconnect; if a call fails, report the error and suggest alternatives
- **Don't assume capabilities** — not all servers support resources or prompts; use list actions to discover what's available
