# Update Track List

This document tracks the upgrade plan for Ember using the strongest ideas from:
- Hermes Agent (`repos/hermes-agent`)
- MiroFish (`repos/MiroFish`)

It includes:
- What each project does better
- Why Ember needs it
- How to implement it in Ember
- A full checkbox TODO list
- A copy-paste execution prompt for Claude Opus 4.6 and ChatGPT 5.4

---

## 1) Hermes -> Ember Upgrade Track

### H1. Dangerous Command Approval Layer

**What Hermes does better**
- Detects risky shell commands and asks for explicit approval.
- Supports one-time, session, and persistent allowlist decisions.

**Why Ember needs it**
- Ember already has strong terminal tooling, but not full risk-gated execution control.
- This reduces accidental destructive actions and makes execution safer.

**How to implement in Ember**
- Add a command-risk detector before terminal execution.
- Add approval states (deny/once/session/always).
- Add config-backed allowlist storage.
- Add UI + API events for pending approvals and user decisions.

**TODO**
- [ ] Define risky command pattern list and severity tiers.
- [ ] Add pre-exec risk scan in terminal execution path.
- [ ] Add pending approval store keyed by conversation/session.
- [ ] Add `approve once` flow.
- [ ] Add `approve for session` flow.
- [ ] Add `always allow` flow with persisted allowlist.
- [ ] Add `deny` flow with clear user-visible error.
- [ ] Add audit logging for every approval decision.
- [ ] Add settings UI for reviewing/editing allowlist.
- [ ] Add tests for detection, approvals, and persistence.

---

### H2. Transparent Checkpoints + Rollback

**What Hermes does better**
- Automatically snapshots filesystem state before mutations.
- Supports rollback to earlier checkpoints.

**Why Ember needs it**
- Ember is agentic and can patch files quickly; safe rollback is essential.
- Improves trust and allows faster autonomous edits.

**How to implement in Ember**
- Add checkpoint manager triggered before write/patch tool calls.
- Use lightweight git-shadow or equivalent snapshot strategy.
- Add rollback endpoint + UI control.
- Ensure one-checkpoint-per-dir-per-turn dedupe.

**TODO**
- [ ] Define checkpoint storage location and retention policy.
- [ ] Add per-turn checkpoint dedupe logic.
- [ ] Trigger checkpoint creation before mutating tool calls.
- [ ] Record checkpoint metadata (time, reason, path, commit hash/id).
- [ ] Add API endpoints to list/restore checkpoints.
- [ ] Add UI in settings/projects to browse and restore checkpoints.
- [ ] Add guardrails for large directories / performance limits.
- [ ] Add tests for create/list/restore and edge cases.

---

### H3. Session Recall (SQLite + FTS + Summarized Retrieval)

**What Hermes does better**
- Fast full-text recall across prior sessions.
- Summarizes matched sessions so context stays compact.

**Why Ember needs it**
- Ember has memory systems, but cross-conversation semantic recall can be stronger.
- Helps long-running projects and reduces repeated user context.

**How to implement in Ember**
- Add searchable conversation/session index.
- Add `session_recall` tool/API.
- Summarize top matches into compact context blocks.
- Add filters (role/date/project/source).

**TODO**
- [ ] Define searchable session schema and indexes.
- [ ] Build FTS query path over archived conversations.
- [ ] Add grouped result ranking by session relevance.
- [ ] Add summarization pass for retrieved sessions.
- [ ] Add query filters (date/source/project/role).
- [ ] Add `session_recall` tool with safe limits.
- [ ] Add UI surface for recall results in chat and memory pages.
- [ ] Add tests for ranking, truncation, and summarization quality.

---

### H4. Delegation Hardening

**What Hermes does better**
- Child agents run with isolated context and restricted toolsets.
- Strong limits on recursion/depth and blocked tools.

**Why Ember needs it**
- Ember already supports parallel tasks/handoff; hardening avoids runaway complexity.
- Improves stability and cost control.

**How to implement in Ember**
- Add strict child task sandbox profiles.
- Block sensitive tools in child contexts unless explicitly permitted.
- Add depth limits + inherited budgets.
- Add better child progress visibility.

**TODO**
- [ ] Define default blocked tools for delegated subtasks.
- [ ] Add max delegation depth and max child concurrency settings.
- [ ] Ensure child tasks inherit global token/iteration budgets.
- [ ] Add explicit child outcome schema (status, artifacts, errors, duration).
- [ ] Add child trace visibility in activity UI.
- [ ] Add tests for blocked tools, depth limits, and budget inheritance.

---

### H5. Runtime Resilience (Fallback Routing)

**What Hermes does better**
- Activates fallback provider/model on repeated hard failures.

**Why Ember needs it**
- Reduces dead-end runs when a provider/model fails mid-task.

**How to implement in Ember**
- Add fallback model/provider config.
- Add deterministic failover rules for error classes.
- Add telemetry for fallback activation.

**TODO**
- [ ] Define fallback config schema in settings.
- [ ] Add retry threshold and failover trigger logic.
- [ ] Add provider/model swap behavior preserving conversation/tool state.
- [ ] Add user-visible fallback event in stream/activity UI.
- [ ] Add tests for failover triggers and one-shot activation semantics.

---

## 2) MiroFish -> Ember Upgrade Track

### M1. Simulation Mode (Project-Level)

**What MiroFish does better**
- Structured end-to-end simulation workflow from source materials to world runs.

**Why Ember needs it**
- Adds a high-value capability beyond chat/task execution: scenario forecasting and sandbox experimentation.

**How to implement in Ember**
- Add project-scoped simulation mode with stages:
  - seed ingestion
  - entity extraction + graph build
  - persona synthesis
  - simulation execution
  - analysis/reporting

**TODO**
- [ ] Define simulation domain model (project, run, round, actor, event, artifact).
- [ ] Add simulation setup wizard under Projects.
- [ ] Add seed material ingestion APIs.
- [ ] Add entity extraction/typing pipeline.
- [ ] Add graph persistence + inspection APIs.
- [ ] Add persona/profile generation pipeline.
- [ ] Add configurable run parameters (rounds, activity rates, stop criteria).
- [ ] Add run lifecycle controls (start/pause/resume/stop).
- [ ] Add simulation data retention + cleanup policy.

---

### M2. Live Simulation Observability

**What MiroFish does better**
- Real-time timeline of agent actions with platform/run progress.

**Why Ember needs it**
- Users need inspectability for trust and debugging in complex multi-agent runs.

**How to implement in Ember**
- Stream structured run events to UI.
- Build timeline view with filters and drill-down.
- Expose per-run health + progress metrics.

**TODO**
- [ ] Define event schema (actor/action/round/timestamp/payload/result).
- [ ] Add event streaming endpoint(s) for live monitoring.
- [ ] Add timeline UI with search/filter/sort.
- [ ] Add per-run metrics cards (progress, throughput, error rate).
- [ ] Add artifact links from timeline entries.
- [ ] Add run replay mode for postmortem analysis.
- [ ] Add tests for event ordering and UI rendering performance.

---

### M3. Interview + Survey Interface for Simulated Actors

**What MiroFish does better**
- Lets users query specific simulated actors and run batch interviews/surveys.

**Why Ember needs it**
- Converts simulation output from opaque logs into actionable qualitative insights.

**How to implement in Ember**
- Add tools/APIs for actor interview and batch interview execution.
- Add chat panel bound to selected actor(s).
- Add survey templates and response aggregation.

**TODO**
- [ ] Add single-actor interview API.
- [ ] Add batch interview API with timeout/retry handling.
- [ ] Add actor selection + profile card UI.
- [ ] Add survey builder + target cohort selector.
- [ ] Add survey result aggregation and export.
- [ ] Add tests for interview command flow and response validation.

---

### M4. Report Agent Workbench

**What MiroFish does better**
- Generates structured reports from simulation data and supports follow-up probing.

**Why Ember needs it**
- Bridges raw simulation activity to decision-ready output.

**How to implement in Ember**
- Add report planner/generator using simulation graph + event logs as evidence.
- Add report sections with generation progress tracking.
- Add post-report interactive Q&A.

**TODO**
- [ ] Define report schema (outline, sections, evidence citations, conclusions).
- [ ] Add async report generation jobs + status tracking.
- [ ] Add section-level progress updates and retries.
- [ ] Add evidence citation links back to run events/graph nodes.
- [ ] Add report chat mode for follow-up analysis.
- [ ] Add report export (Markdown/JSON/PDF later).
- [ ] Add tests for generation lifecycle and citation integrity.

---

## 3) Ember Core Integration Tasks (Cross-Cutting)

- [ ] Add feature flags for each major track (`safety`, `checkpoints`, `recall`, `simulation`, `reporting`).
- [ ] Add migration plan for config + data schema updates.
- [ ] Add observability (structured logs, metrics, tracing for tool loops/runs/reports).
- [ ] Add security review pass for new tools/routes.
- [ ] Add performance budgets and load-test targets.
- [ ] Add docs update plan (manual + API docs + UX docs).
- [ ] Add rollout plan (internal -> alpha -> beta -> default on).

---

## 4) Definition of Done (Global)

- [ ] All new APIs documented and versioned.
- [ ] All critical paths covered by tests.
- [ ] No regressions in existing chat/tool/memory behavior.
- [ ] Feature flags allow safe rollback by subsystem.
- [ ] End-to-end demo scenario passes for:
  - [ ] Safe terminal approvals
  - [ ] Checkpoint + rollback
  - [ ] Session recall
  - [ ] Delegation hardening
  - [ ] Simulation run + timeline
  - [ ] Actor interview + report generation

---

## 5) Execution Prompt (Claude Opus 4.6 + ChatGPT 5.4 Compatible)

Copy-paste this prompt into Claude Opus 4.6 or ChatGPT 5.4:

```text
You are a senior software engineer operating directly in this repository.

Project root: /home/agent_t560/Desktop/emberv1
Primary references:
- /home/agent_t560/Desktop/emberv1/update track list.md
- /home/agent_t560/Desktop/emberv1/repos/hermes-agent
- /home/agent_t560/Desktop/emberv1/repos/MiroFish

Goal:
Implement the upgrade tracks listed in update track list.md with production-quality code, tests, and docs.

Hard requirements:
1) Follow update track list.md as the source of truth.
2) Work in small, testable increments (one subsystem per change set).
3) Preserve current Ember behavior unless a checklist item explicitly changes it.
4) Gate all major additions behind feature flags.
5) Add/extend tests for each implemented item.
6) Do not remove existing memory, MCP, role-routing, or chat capabilities.
7) Keep architecture Ember-native (adapt ideas from Hermes/MiroFish; do not clone blindly).

Execution order:
Phase A: Hermes safety + reliability items (H1-H5)
Phase B: MiroFish simulation/reporting items (M1-M4)
Phase C: Cross-cutting integration + rollout + docs

For each implemented item:
- Mark the corresponding checkbox in update track list.md as done.
- Add a short "Implementation Notes" subsection under that item:
  - What changed
  - Files touched
  - Tests added/updated
  - Follow-ups

Output format after each phase:
1) Completed checklist items
2) Files changed
3) Tests run and results
4) Known risks
5) Next recommended item

Quality bar:
- Strong typing, clear interfaces, small composable functions
- Explicit error handling and user-visible failure states
- Good logs/telemetry for debugging
- No dead code, no TODO stubs without issue references

Start now with Phase A / H1 (Dangerous Command Approval Layer).
```

