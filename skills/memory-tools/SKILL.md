---
name: memory-tools
description: Cross-session memory workflow for unified recall, save, inspect, session search, and forget operations.
roles: [coordinator, advisor, director, inspector]
tools: [memory_recall, save_memory, memory_search, memory_get, session_recall, forget_memory]
---

## Memory Tools

Use Ember's explicit memory tools when the task depends on durable cross-session
recall or when the user directly asks you to remember or forget something.

- Use `memory_recall` first as the default recall path. It searches long-term
  memory, graph relations, app memory, and prior sessions in one call.
- Use `memory_search` before asking the user to repeat profile facts, project
  constraints, or earlier cross-session context.
- Use `session_recall` when you need broad prior chat history retrieval with
  filters (project/date/role/source) and compact snippet summaries.
- Use `memory_get` after `memory_search` when you need the full record,
  provenance, or current status of a memory.
- Use `save_memory` only for durable facts that should survive across chats:
  user profile facts, stable preferences, project constraints, environment
  facts, and sourced world facts worth keeping.
- Use `save_memory` with `memory_type: procedure` only for reusable non-secret
  workflows, such as repeatable browser or desktop steps that worked.
- Do not use `save_memory` for routine short-lived context that automatic
  conversation compression already handles.
- Do not use `save_memory` for passwords, login emails, OTP codes, API keys, or
  other secrets. Store those in the credential vault instead.
- Use `forget_memory` only when the user explicitly asks to delete or correct a
  stored fact. Identify the exact memory id first, then set `confirm=true`.
- If the user corrects a prior fact and you know the old memory id, prefer
  saving the corrected fact with `supersedes_id` so the correction path stays
  auditable.
