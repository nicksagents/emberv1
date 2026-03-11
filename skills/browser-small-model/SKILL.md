---
name: browser-small-model
description: Supplementary Playwright browser guidance for small/mid-size models — snapshot-first, ref-driven.
roles: [coordinator, advisor, director, inspector]
tools: [mcp__playwright__browser_navigate]
---

## Playwright Browser — Small-Model Rules

Small and mid-size models have limited context windows and are prone to hallucinating
element references. These rules prevent the most common failure modes.

### The snapshot-first loop

```
mcp__playwright__browser_navigate(url) → mcp__playwright__browser_snapshot() → act(ref) → mcp__playwright__browser_snapshot() → …
```

Never skip the post-action snapshot. State verification after each action
prevents wasted round-trips from acting on stale assumptions.

### Preferred input strategies (in priority order)

1. `mcp__playwright__browser_fill_form` with `ref` from snapshot — always try this first
2. `mcp__playwright__browser_fill_form` with accessible name / label — when ref is unavailable
3. `mcp__playwright__browser_click` the input first, then `mcp__playwright__browser_type` — only for OTP boxes that reject fill
4. `mcp__playwright__browser_evaluate` — absolute last resort; only when no accessible interaction works

### Preferred button strategies

1. `mcp__playwright__browser_click` with ref from snapshot
2. `mcp__playwright__browser_click` with visible text label — fallback when snapshot ref is gone

### Performance rules

| Rule | Why |
|---|---|
| Prefer `mcp__playwright__browser_snapshot` over `mcp__playwright__browser_evaluate` | Snapshot returns structured refs; much cheaper |
| Use `mcp__playwright__browser_wait_for` to verify navigation | Cheaper than screenshot; works for non-visual models |
| Fill multiple fields in one `mcp__playwright__browser_fill_form` call | Reduces round-trips; faster for small models |
| Use `http_request` for JSON APIs | Never open a browser for endpoints that return JSON |

### What small models must never do

- Do **not** use `mcp__playwright__browser_evaluate` when `mcp__playwright__browser_snapshot` can show the same info
- Do **not** assume a form submitted successfully without a follow-up `mcp__playwright__browser_snapshot`
  or `mcp__playwright__browser_wait_for`
- Do **not** re-navigate if already on the right page — check with `mcp__playwright__browser_snapshot` first
- Do **not** re-use stale refs — take a fresh `mcp__playwright__browser_snapshot` after any DOM change
