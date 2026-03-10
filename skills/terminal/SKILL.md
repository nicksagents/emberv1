---
name: terminal
description: Shell command execution — use only when no narrower tool fits.
roles: [coordinator, advisor, director, inspector, ops]
tools: [run_terminal_command]
---

## Terminal Tool

Use `run_terminal_command` only when a more specific tool (`read_file`,
`search_files`, `http_request`, etc.) cannot accomplish the task. The terminal
is the most powerful and most dangerous tool — prefer narrow tools first.

### Actions

| Action | When to use |
|---|---|
| `run` (default) | Launch a new command |
| `read` | Read buffered output from a running command |
| `input` | Send text to stdin of a running interactive process |
| `interrupt` | Send Ctrl-C to stop a running command |

### Good use cases

- Running build, test, or install commands
- Starting long-running processes (dev servers, watchers)
- Interacting with CLIs that require stdin (e.g. package prompts)
- One-off shell operations not covered by file/search tools

### Avoid

- Reading files → use `read_file` with `start_line`/`end_line`
- Searching code → use `search_files`
- Making HTTP requests → use `http_request`
- Browsing websites → use `browser` or `fetch_page`
