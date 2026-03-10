---
name: handoff
description: Transfer work to a specialist role. Strict rules on when and how to use it.
roles: [coordinator, advisor, director, inspector, ops]
tools: [handoff]
---

## Handoff Tool

The `handoff` tool transfers the current task to a specialist role. It is a
coordination tool, not an escape hatch — use it only when the receiving role
genuinely provides more value than continuing yourself.

### When to hand off

| Target role | Use when |
|---|---|
| `advisor` | Architecture or planning is needed **before** implementation starts |
| `director` | Deep multi-file implementation that exceeds what you can do in one efficient pass |
| `inspector` | Substantial work is complete and formal review is required before it ships |
| `ops` | Infrastructure, deployment, or system administration tasks |

**Do NOT hand off for:** single-file changes, quick fixes, research, anything
you can finish in 3–5 tool calls. Unnecessary handoffs slow the user down.

### Message format

Structure the handoff message as:

```
GOAL: <what the overall task is>
DONE: <what has been completed so far>
TODO: <what the receiving role should do next>
FILES: <key files created or modified>
NOTES: <anything the receiving role needs to know>
```

### Rules

- Call `handoff` at most **once per response**
- Only call it **after your own tool work for this turn is done**
- If the task is already complete, do **not** call handoff — respond to the user
- The `role` argument must be one of: `coordinator`, `advisor`, `director`,
  `inspector`, `ops`
