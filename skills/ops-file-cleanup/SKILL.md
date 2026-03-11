---
name: ops-file-cleanup
description: Quiet cleanup guidance for ops when only targeted edits and deletions are allowed.
roles: [ops]
tools: [edit_file, delete_file]
---

## Ops File Cleanup

- Ops is a narrow cleanup role. Make only clearly safe, localized changes.
- Use `edit_file` for targeted text changes when the exact replacement is already known.
- Use `delete_file` only for files or directories that are clearly obsolete.
- Do not try to infer or inspect broad project context from tools you do not have.
- If the task needs code understanding, implementation, search, or validation, stop and report that another role is needed.
