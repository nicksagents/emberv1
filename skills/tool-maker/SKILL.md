---
name: tool-maker
description: Create custom tools at runtime when existing tools don't cover a needed capability.
roles: [coordinator, advisor, director, inspector]
tools: [create_tool]
---

## Custom Tool Creation

You can create new tools at runtime when no existing tool covers what you need.

### When to use

- You need to do a specific data transformation repeatedly
- An API you need to call has a pattern that would benefit from a dedicated tool
- A calculation or validation would be cleaner as a reusable tool
- The user asks you to create a tool for a recurring task

### When NOT to use

- A native tool or MCP server already does what you need
- The task is a one-off that's simpler to do with existing tools (terminal, http_request, etc.)
- You need filesystem write access, child processes, or Node.js built-ins (use terminal tool instead)

### Workflow

```
1. Identify the gap — what capability is missing?
2. Check existing tools first (mcp_search if unsure)
3. create_tool action=create with name, description, input_schema, and code
4. The tool is immediately available as custom__<name>
5. Use it right away in your current task
```

### Code sandbox

Custom tool code runs in a V8 sandbox with these globals:
- **HTTP**: `fetch`, `URL`, `URLSearchParams`, `AbortController`
- **Data**: `JSON`, `Buffer`, `TextEncoder`, `TextDecoder`, `crypto`
- **Basics**: `Math`, `Date`, `RegExp`, `console`, `setTimeout`/`setInterval`
- **Collections**: `Array`, `Object`, `Map`, `Set`, `Promise`

**Not available**: `require`, `import()`, `fs`, `child_process`, `process`

For operations that need Node.js built-ins, use the terminal tool instead.

### Example: JSON-to-CSV converter

```
create_tool action=create
  name="json_to_csv"
  description="Convert a JSON array of objects to CSV format"
  input_schema={
    "type": "object",
    "properties": {
      "data": { "type": "array", "description": "Array of objects to convert" },
      "delimiter": { "type": "string", "description": "Column delimiter (default: comma)" }
    },
    "required": ["data"]
  }
  code="
    const rows = input.data;
    if (!Array.isArray(rows) || rows.length === 0) return 'No data to convert.';
    const delim = input.delimiter || ',';
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(delim)];
    for (const row of rows) {
      lines.push(headers.map(h => String(row[h] ?? '')).join(delim));
    }
    return lines.join('\\n');
  "
```

### Managing tools

- `create_tool action=list` — see all custom tools
- `create_tool action=view name="tool_name"` — see a tool's code and schema
- `create_tool action=delete name="tool_name"` — remove a tool

### Persistence

- `scope=user` (default): saved to `~/.ember/custom-tools/` — available in all projects
- `scope=project`: saved to `.ember/custom-tools/` — only this project
