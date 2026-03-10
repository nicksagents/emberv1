---
name: git-inspect
description: Inspect git state, diffs, and history without raw shell parsing.
roles: [coordinator, advisor, director, inspector, ops]
tools: [git_inspect]
---

## Git Inspect

Use `git_inspect` to check repository state, view diffs, and read commit
history without writing shell commands. It returns structured output that is
easier to process than raw `git` output.

### When to use

- Before editing: check if the working tree is dirty and what has changed
- For code review: view diffs between branches or commits
- For history: find when a change was introduced and by whom
- When the user asks about git state, recent commits, or file changes

### Modes

| Mode | Use for |
|---|---|
| `status` | Working tree status (staged, unstaged, untracked files) |
| `diff` | Show changes — optionally scoped to a file or commit range |
| `log` | Commit history with messages and authors |
| `show` | Full details of a specific commit |

### Prefer this over terminal for git

`git_inspect` returns parsed, safe output. Use `run_terminal_command` for
git operations that write state (`git add`, `git commit`, `git push`, etc.).
