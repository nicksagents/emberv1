---
name: handoff
description: Transfer work to the right specialist role. Every role should know its lane and hand off proactively.
roles: [coordinator, advisor, director, inspector, ops]
tools: [handoff]
---

## Handoff Tool

The `handoff` tool transfers the current task to the role best suited for the
next phase of work. **Handoff is normal workflow, not an escalation.** Each role
has a defined lane — when the task falls outside your lane, hand off immediately
rather than attempting work you're not specialized for.

### Role lanes and routing

| You are | Hand off to | When |
|---|---|---|
| **coordinator** | `director` | Any code task touching 2+ files, any build/test/fix loop, any feature, any sustained development. **This is the most common handoff.** |
| **coordinator** | `advisor` | Complex task needs architecture or planning before anyone writes code |
| **coordinator** | `inspector` | Completed work needs formal review |
| **coordinator** | `ops` | Safe cleanup task (dead code, formatting) |
| **advisor** | `director` | Plan is complete, ready for implementation |
| **advisor** | `coordinator` | Task turned out to be trivially small |
| **director** | `inspector` | Substantial implementation is complete, needs review |
| **director** | `advisor` | Architecture needs rethinking before continuing |
| **director** | `coordinator` | Remaining work is just research or investigation |
| **inspector** | `director` | Issues found that need fixing |
| **inspector** | `coordinator` | Work approved, task complete |
| **ops** | `director` | Task needs real implementation beyond cosmetic cleanup |
| **ops** | `coordinator` | Task needs research or broader context |

### When NOT to hand off

- The task is **within your lane** and you can complete it yourself
- The task is already **complete** — respond to the user instead
- You are **mid-task** — finish your current work first, then hand off

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
- For end-to-end product delivery work, also include:
  `WORKFLOW: product-delivery`, `PHASE: ...`, `STATUS: ...`, and inspector
  `SCORE: ...`
