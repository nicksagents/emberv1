---
name: product-delivery
description: End-to-end app and product delivery workflow. Plan with advisor first, implement with director, iterate with inspector until score >= 8.5, then finalize with coordinator.
roles: [dispatch, coordinator, advisor, director, inspector]
---

## Product Delivery

Use this workflow when the user asks to build a full app, web app, site, service, API, dashboard, or product from start to finish.

### Required role flow

1. `advisor` creates the full implementation manual and architecture plan
2. `director` executes the implementation
3. `inspector` reviews, scores, and finds security or production issues
4. `director` fixes inspector findings when needed
5. Repeat `director` <-> `inspector` until the build is at least `8.5/10` and production-ready
6. `coordinator` gives the final concise user-facing summary

### Delivery rules

- Do not skip the planning pass for a full product build.
- Let the provider/model routers choose the strongest connected provider and model inside each role lane; use handoff when the role itself should change.
- Do not let `coordinator` close the task before inspector approval.
- Inspector must be explicit about score, vulnerabilities, and blocking issues.
- Director must fix every blocking issue before sending the build back for review.
- Coordinator closes only after the inspector approval threshold is met.

### Handoff expectations

For delivery-mode handoffs, include explicit workflow state:

```text
WORKFLOW: product-delivery
PHASE: planning|implementation|inspection|finalization
STATUS: planning-required|plan-complete|ready-for-review|needs-fixes|approved
SCORE: <0.0-10.0>   # inspector handoffs only
```
