# Ember Tool System

Tools give LLMs the ability to take actions — run commands, read files, search the web, call APIs.
Each role gets a specific subset of tools. The system composes a tight system prompt from only
the tools that role actually has access to, so no LLM sees more than it needs.

---

## How tools work end-to-end

```
User sends message
  → Role is selected (router or direct)
  → getToolsForRole(role) returns the ToolDefinition[] for that role
  → getToolSystemPrompt(tools) builds a "## Tools available" block injected into the system prompt
  → The LLM receives: shared prompt + role prompt + tools prompt + conversation
  → LLM responds and optionally requests a tool call
  → handleToolCall(name, input) dispatches to the tool's execute() function
  → Result is fed back to the LLM (this loops up to 10 times per request)
  → LLM produces a final text response
```

The tool loop streams in real time — text content is emitted as it arrives, and a status event
("Tool: web_search") is emitted before each tool execution so the UI can show progress.

---

## How to add a new tool

### 1. Create a tool file

Create `apps/server/src/tools/my-tool.ts` and export an `EmberTool`:

```ts
import type { EmberTool } from "./types.js";

async function execute(input: Record<string, unknown>): Promise<string> {
  const value = typeof input.my_param === "string" ? input.my_param : "";
  if (!value) return "Error: my_param is required.";

  // Do the work, return a plain string the LLM can read.
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
        my_param: {
          type: "string",
          description: "What this parameter is for.",
        },
      },
      required: ["my_param"],
    },
  },
  systemPrompt:
    "my_tool_name — One-liner injected into the role system prompt. Keep it under 20 words.",
  execute,
};
```

### 2. Register the tool

Open `apps/server/src/tools/index.ts` and add two things:

```ts
// 1. Import it
import { myTool } from "./my-tool.js";

// 2. Add it to REGISTRY
const REGISTRY: EmberTool[] = [
  terminalTool,
  readFileTool,
  // ...
  myTool,   // ← add here
];
```

### 3. Grant role access (optional)

In `ROLE_TOOLS` inside `index.ts`, add your tool to whichever roles should have it:

```ts
const ROLE_TOOLS: Record<Role, EmberTool[]> = {
  coder: [readFileTool, writeFileTool, editFileTool, terminalTool, webSearchTool, myTool],
  // ...
};
```

That's it. The system automatically:
- Sends the tool's JSON schema to the LLM
- Injects `myTool.systemPrompt` into the system prompt for roles that have it
- Routes `handleToolCall("my_tool_name", input)` to your `execute()` function

---

## How tools are sent to each provider

### Anthropic API
Tools are sent as the `tools` array in the request body using Anthropic's native format:
```json
{ "name": "...", "description": "...", "input_schema": { ... } }
```
Tool results come back as `tool_result` content blocks in a `user` message.
The streaming loop detects `stop_reason: "tool_use"` to know when to execute tools.

### OpenAI-compatible (local models, OpenAI, etc.)
Tools are sent as the `tools` array using OpenAI's function-calling format:
```json
{ "type": "function", "function": { "name": "...", "description": "...", "parameters": { ... } } }
```
Tool results come back as `role: "tool"` messages with `tool_call_id`.
The streaming loop detects `finish_reason: "tool_calls"` to know when to execute tools.

### Codex CLI
Codex CLI runs as a local process and receives the conversation as a text prompt.
EMBER exposes tools to Codex through a text-based tool protocol and executes the requested
tool server-side before continuing the loop.

---

## Per-role tool access

| Role      | Tools                                                                      |
|-----------|----------------------------------------------------------------------------|
| router    | none (classification only)                                                 |
| assistant | read_file, run_terminal_command, web_search, fetch_page                    |
| planner   | read_file, run_terminal_command, web_search, fetch_page                    |
| coder     | read_file, write_file, edit_file, run_terminal_command, web_search, fetch_page |
| auditor   | read_file, run_terminal_command, web_search, fetch_page                    |
| janitor   | read_file, write_file, edit_file (background only)                         |

---

## Tool design guidelines

- **Return plain text.** The LLM reads the return value directly. Avoid JSON unless the LLM
  specifically needs to parse it.
- **Fail loudly with a clear message.** Return `"Error: ..."` strings — don't throw. The LLM
  will see the error and can try a different approach.
- **Cap output size.** Large outputs waste context window. Truncate at ~100 KB for file reads,
  and summarize or paginate for API responses.
- **Log what you do.** Use `console.log(`[tool:name] ...`)` so server logs are useful.
- **Keep execute() focused.** One tool, one job. If you need two things, make two tools.
- **async is fine.** `execute` can be `async` — the system awaits it.
