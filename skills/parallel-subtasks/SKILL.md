---
name: parallel-subtasks
description: Fan out independent subtasks across EMBER roles and models with launch_parallel_tasks. Use for independent research, implementation slices, or review tracks that can run concurrently.
roles: [coordinator, advisor, director, inspector]
tools: [launch_parallel_tasks]
---

## Parallel Subtasks

Use `launch_parallel_tasks` when the work naturally splits into independent parts.
Each subtask gets its own routed EMBER execution lane, so this is a real fan-out
tool, not just a note-taking shortcut.

### Good fits

- Multiple independent research or comparison tracks
- Separate audit passes, such as security, correctness, and UX review
- Independent implementation slices that do not edit the same files
- Long tasks where one agent needs specialist reports before deciding the next step

### Bad fits

- A single blocking implementation path
- Tasks that depend on each other in sequence
- Overlapping file edits that will race or conflict
- Cases where one direct handoff is simpler

### Rules

- Keep each task self-contained and explicit.
- Prefer 2-4 tasks, not micro-fragmentation.
- Default role is your current role. Set `role=auto` only when EMBER should decide.
- Use `profile=read-only` or `profile=investigation` for audit/research subtasks that should not mutate files.
- Parallel fan-out depth/concurrency/time budgets are policy-limited and inherited by child runs.
- After the results come back, synthesize them and either continue or hand off once.
