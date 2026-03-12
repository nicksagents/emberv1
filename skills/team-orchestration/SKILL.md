---
name: team-orchestration
description: Route work across roles, tools, MCP servers, and assigned models. Stay in lane; hand off once when another role has a clear advantage.
roles: [dispatch, coordinator, advisor, director, inspector, ops]
---

## Team Orchestration

Before acting, answer three questions:

1. Can my current role finish this cleanly in one focused pass?
2. If not, which role has the better lane or tool surface?
3. Does the task need a different role, or will the provider/model routers handle the lane choice inside my current role?

### Role lanes

- `coordinator`: default lane for research, browsing, repo orientation, routine execution, and small-to-medium fixes
- `advisor`: planning, architecture, sequencing, and scoping before implementation starts
- `director`: deep implementation, debugging, and sustained build/test/fix loops
- `inspector`: review, testing, validation, regression hunting, and audit write-ups
- `ops`: safe cleanup and narrow polish only

### Tool and MCP routing

- Prefer the lightest tool that solves the current step.
- Prefer native file, search, HTTP, and fetch tools before browser or heavier MCP loops when either would work.
- Treat installed MCP servers as global specialist surfaces: use them when the server has the missing capability or a more deterministic workflow than the native toolset.
- Use MCP tools when they provide the missing capability or a more deterministic workflow.
- Use `launch_parallel_tasks` only for independent subtasks that can run concurrently without overlapping file edits.
- Use memory tools for durable cross-session facts and project constraints, not for routine turn-local context.
- Treat browser automation as interaction tooling, not a default page-reading tool.

### Handoff rules

- Stay in your current role for small fixes, short research loops, and anything you can finish without a specialist.
- The provider/model routers can switch provider and model inside your current role lane. Hand off only when the next role has the better task lane or tool surface.
- Call `handoff` once, at the end of your pass, after your own tool work is complete.
- Make the handoff message actionable enough that the receiving role can continue immediately.

### Long-task rhythm

- `coordinator` or `advisor` can orient and narrow the task
- When the work cleanly splits, `coordinator`, `advisor`, `director`, or `inspector` can fan out independent subtasks and then synthesize the results
- `director` executes the heavy implementation pass
- `inspector` verifies or audits the result
- `coordinator` handles direct user-facing follow-ups unless the task still clearly belongs with a specialist
