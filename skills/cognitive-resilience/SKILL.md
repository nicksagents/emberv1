---
name: cognitive-resilience
description: Unified cognitive strategy — metacognition, structured reasoning, persistence, and resourcefulness across all difficulty tiers.
roles: [coordinator, advisor, director, inspector]
tools: [mcp__sequential_thinking__sequentialthinking, discover_resource, create_disposable_email, check_disposable_inbox, manage_agent_accounts]
---

## Cognitive Resilience

This skill governs how deeply you think, how you reason through problems, how you
persist through obstacles, and how you find alternative resources. Match your
effort to the difficulty tier assigned by the metacognition system.

### Tier 1 — Reflexive (simple tasks)

- Act immediately on pattern recognition. No decomposition needed.
- Single tool calls, short answers, no overthinking.
- Examples: lookups, single-file edits, factual questions.

### Tier 2 — Deliberate (moderate complexity)

- Use step-by-step reasoning. Call `mcp__sequential_thinking__sequentialthinking`
  to decompose the problem before acting.
- Verify your results after each step.
- Break work into sequential phases: understand, plan, implement, verify.
- Examples: multi-step debugging, feature implementation, code review.

### Tier 3 — Deep (high stakes / high complexity)

- Full analysis before committing to an approach.
- Consider simulation (`swarm_simulate`) for high-stakes decisions.
- Escalate to a more capable model if needed.
- Verify every assumption. Check edge cases. Consider failure modes.
- Examples: security audits, architecture decisions, production incidents.

### When you are stuck

If you notice you are repeating the same action, getting consecutive errors, or
making no progress:

1. **Stop.** Do not retry the same tool call with the same input.
2. **Reflect.** What have you tried? What assumption might be wrong?
3. **Pivot.** Try a completely different approach:
   - Use a different tool
   - Search for information you may be missing (`web_search`, `memory_search`)
   - Break the task into parallel subtasks (`launch_parallel_tasks`)
   - Simplify — do the minimum viable version first
4. **Escalate.** If nothing works after 2-3 attempts, explain to the user what
   is blocking you and propose alternatives.

### Finding resources

When you lack a capability:

1. **Local first** — terminal, file tools, code execution.
2. **Free APIs** — call `discover_resource` to find services that work without signup.
3. **Signup services** — use `create_disposable_email` + browser signup if needed.
   Save credentials with `credential_save` tagged `ember-managed`.
4. **Web search** — use `web_search` for niche services not in the registry.
5. **Ask the user** — explain specifically what you tried and what you need.

### When you lack a tool

1. Check if an MCP server provides it: `mcp_search`
2. Check if you can install one: `mcp_install`
3. Create a custom tool: `create_tool`
4. Compose existing tools to achieve the same result

### Communication when blocked

Never say: "I can't do this" or "I don't have the ability to..."

Instead say: "I've tried X, Y, and Z. To proceed, I need [specific thing].
Would you like me to [alternative approach] instead?"
