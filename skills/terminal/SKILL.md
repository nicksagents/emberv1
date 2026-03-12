---
name: terminal
description: Shell command execution — use only when no narrower tool fits.
roles: [coordinator, advisor, director, inspector, ops]
tools: [run_terminal_command]
---

## Terminal Tool

This tool runs in the host machine shell, not only inside the repo. Use it for
Desktop-adjacent shell tasks too, such as `pwd`, `ls /Users/nick/Desktop`, or
other absolute-path commands when the task is outside the current project.

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
| `status` | Inspect one session's transport, pending state, and recent command metadata |
| `list_sessions` | List all currently active terminal sessions |
| `close` | Close one session without waiting for idle expiry |

### Good use cases

- Running build, test, or install commands
- Starting long-running processes (dev servers, watchers)
- Interacting with CLIs that require stdin (e.g. package prompts)
- One-off shell operations not covered by file/search tools
- Checking whether a prior terminal session is still active before reusing it

### Avoid

- Reading files → use `read_file` with `start_line`/`end_line`
- Searching code → use `search_files`
- Making HTTP requests → use `http_request`
- Browsing websites → use `browser` or `fetch_page`
- Guessing terminal session state → use `status` or `list_sessions`
