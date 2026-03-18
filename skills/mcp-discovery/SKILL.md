---
name: mcp-discovery
description: On-demand MCP server discovery and installation — find and activate new capabilities at runtime.
roles: [coordinator, advisor, director, inspector]
tools: [mcp_search, mcp_install]
---

## On-Demand MCP Discovery

You can extend your own capabilities at runtime by searching for and installing MCP servers that provide tools you don't currently have.

### When to use

- You need to interact with a service you don't have tools for (email, Jira, AWS, Discord, etc.)
- The user asks you to do something outside your current tool set
- You want to check if a better tool exists for a task

### Workflow

```
1. mcp_search query="what you need"     → find matching MCP servers
2. Review results — curated entries are tested and recommended
3. mcp_install package_name="..."        → install and activate
4. New tools are immediately available — use them right away
```

### Examples

**User wants you to send an email:**
```
1. mcp_search query="email gmail"
2. mcp_install package_name="gmail-mcp-imap" env={"GMAIL_EMAIL": "...", "GMAIL_APP_PASSWORD": "..."}
3. Use the new mcp__gmail__* tools to send email
```

**User wants database access:**
```
1. mcp_search query="postgres database"
2. mcp_install package_name="@modelcontextprotocol/server-postgres" args=["postgres://..."]
3. Use mcp__postgres__query to run SQL
```

### Key points

- **Search curated first** — the curated registry has tested, recommended servers
- **npm fallback** — if nothing curated matches, npm results may have community options
- **API keys** — some servers need credentials. Check if the user has them or ask
- **Scope** — use `scope="user"` (default) to persist globally, `scope="project"` for project-only
- **Roles** — default roles are coordinator, advisor, director, inspector. Adjust if needed
- **Don't install duplicates** — check your current mcp__* tools before searching

### Servers that need credentials

If a server requires API keys, either:
1. Ask the user for the keys and pass them via the `env` parameter
2. Tell the user to add them in Settings > MCP > Service Keys
3. Install anyway — the server will be saved but won't work until keys are added
