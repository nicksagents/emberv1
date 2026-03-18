---
name: team-orchestration
description: Route work across roles — each role has a strict lane and should hand off proactively when the task belongs elsewhere.
roles: [dispatch, coordinator, advisor, director, inspector, ops]
---

## Team Orchestration

Before acting, answer two questions:

1. **Is this task in my lane?** If not, hand off immediately after brief orientation.
2. **Can I finish the in-lane portion in one focused pass?** If yes, do it. If not, do what you can and hand off.

### Role lanes (strict)

- `coordinator`: triage, research, investigation, repo orientation, and lightweight single-file edits. **Not an implementation role.** Routes work to specialists.
- `advisor`: planning, architecture, sequencing, and scoping. **Never implements.** Produces plans for director to execute.
- `director`: **primary implementation role** — writing code, building features, fixing bugs, refactoring, sustained build/test/fix loops. This is where development happens.
- `inspector`: review, testing, validation, regression hunting, and audit write-ups. **Never implements fixes** — sends issues back to director.
- `ops`: safe cosmetic cleanup only — dead code, naming, formatting. **Never changes behavior.**

### Common routing patterns

| User request pattern | Correct role |
|---|---|
| "build", "implement", "create", "code", "fix", "refactor", "add feature" | → **director** |
| "plan", "design", "architect", "what approach" | → **advisor** |
| "review", "check", "verify", "QA", "test" | → **inspector** |
| "clean up", "format", "remove dead code" | → **ops** |
| "research", "investigate", "what is", "show me", "find" | → **coordinator** |
| "simulate", "what would happen if", "predict", "what are the odds", "model outcomes" | → **coordinator** or current role (all 4 main roles have `swarm_simulate`) |

### Tool and MCP routing

- Prefer the lightest tool that solves the current step.
- Prefer native file, search, HTTP, and fetch tools before browser or heavier MCP loops when either would work.
- Use MCP tools when they provide a missing capability or a more deterministic workflow.
- Use `launch_parallel_tasks` only for independent subtasks that can run concurrently without overlapping file edits.
- Use memory tools for durable cross-session facts and project constraints, not for routine turn-local context.
- Treat browser automation as interaction tooling, not a default page-reading tool.
- **Swarm simulation** (`swarm_simulate`, `swarm_interview`, `swarm_report`): Use for uncertain outcomes, risk analysis, predictions, or multi-perspective decision-making. Any main role (coordinator, advisor, director, inspector) can run simulations directly — no handoff needed. Workflow: `swarm_simulate action=create scenario="..."` (auto-runs) → `swarm_report` → optionally `swarm_interview`.

### Handoff rules

- **Hand off proactively** when the task belongs to another role's lane. Don't attempt out-of-lane work.
- Stay in your current role only for work that clearly fits your lane.
- Call `handoff` once, at the end of your pass, after your own tool work is complete.
- Make the handoff message actionable enough that the receiving role can continue immediately.

### Long-task rhythm

- `coordinator` orients and triages — hands off to the right specialist
- `advisor` plans complex work — hands off to director for implementation
- `director` executes the implementation pass — hands off to inspector for review
- `inspector` verifies — hands back to director if issues, or declares done
- `coordinator` handles direct user-facing follow-ups after work is complete
