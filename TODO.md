# Ember Memory Engine Roadmap

Build a two-layer memory system that makes Ember feel continuous inside a chat
and persistent across chats:

- `working memory`: the existing conversation compaction and rolling summary
  flow that preserves continuity inside one conversation.
- `long-term memory`: structured cross-session memory that stores user facts,
  project facts, environment facts, world observations, and prior session
  summaries, then retrieves the most relevant memories before prompt assembly.

This document is the execution plan for that work. Each phase states the goal,
what code changes are required, how the phase plugs into the current system,
and the acceptance criteria before moving forward.

## Design Principles

- Keep `working memory` and `long-term memory` separate. Compression is not the
  same thing as memory persistence.
- Store canonical facts, not brittle phrasing.
  Example: store `date_of_birth = 1997-06-16`, not only `I am 28`.
- Store provenance for unstable world facts.
  Any web-derived event or law change must have source and observed timestamp.
- Retrieve a small number of high-signal memories before the prompt.
  Small models degrade when memory injection is verbose or repetitive.
- Support contradiction and reconsolidation.
  New facts should supersede or invalidate old facts when they conflict.
- Design the memory engine as Ember infrastructure, not as a prompt hack.
  The LLM reasons over memory; it should not be the only thing shaping memory.

## Human Memory Model To Simulate

- `sensory buffer`
  Raw user turns, tool outputs, fetched pages, attachments, and live events.
- `voice layer`
  Deferred for now. Ember does not need ASR/TTS or speaker-prosody tagging
  until the text-and-tool memory path matches the target architecture.
- `working memory`
  Current conversation plus the existing history summary from
  `packages/core/src/conversation-compaction.ts`.
- `episodic memory`
  Session summaries, tasks completed, observed events, and notable tool actions.
- `semantic memory`
  Stable facts about the user, project, environment, and world state.
- `consolidation`
  Promotion of high-value signals from working memory into episodic or semantic
  memory after each turn or at session boundaries.
- `reconsolidation`
  Updating or superseding old memories when new evidence arrives.
- `forgetting`
  Decay or expiry for volatile memories that are no longer trustworthy.

## Current System Snapshot

- Ember already has working-memory compression in
  `packages/core/src/conversation-compaction.ts`.
- Conversations are persisted in `data/conversations.json` via
  `packages/core/src/store.ts`.
- Cross-session memory now exists in `packages/core/src/memory/` with a SQLite
  backend, hybrid retrieval, deterministic embeddings, and prompt-budgeted
  injection.
- The server prompt assembly path lives in `apps/server/src/index.ts`.
- Provider message formatting lives in `packages/connectors/src/drivers.ts`.
- Phases 1 through 9 are now complete end-to-end: consolidation, pre-prompt
  retrieval, explicit memory tools, lifecycle finalization, decay and
  revalidation, inspection APIs, and the cortex UI are all shipped.
- Phase 10 is now complete: retrieval is cue-aware, role/tool/task-state
  sensitive, retrieval success feeds back into ranking, and prompt-time memory
  injection stays compact for small-context providers.
- Phases 11 through 13 are now complete:
  - semantic distillation now promotes persistent project constraints and
    file-derived repo conventions into durable semantic memory
  - replay now runs after archival, writes associative `memory_edges`, and can
    derive cross-session abstractions
  - procedural memory now learns reusable tool/action routines and injects
    them as a separate compact prompt block
- The replay/governance hardening slice is now underway:
  - replay also runs on a background cadence with skip heuristics instead of
    only at archival time
  - the memory inspection UI now exposes operator controls to run replay,
    suppress memories, revalidate memories, and retire learned procedures
- The main remaining gaps against the target paper are:
  - governance is still thin: operators can suppress/revalidate/retire and run
    replay manually, but approval workflows and contradiction-driven confidence
    downgrades are still basic
  - semantic and procedural consolidation can still broaden to more subtle
    long-range user/project identity patterns

## Remaining Gap Against The Paper

Ember already matches the paper on:

- separating working memory from persistent memory
- keeping long-term memory outside compacted chat history
- supporting contradiction, supersession, decay, revalidation, and explicit
  forgetting
- storing episodic and semantic records with provenance and confidence

Ember does not yet match the paper on:

- `semantic abstraction breadth`
  Ember now distills persistent project constraints, repo conventions, and
  strong environment facts, but it still has room to widen abstraction for
  higher-level coding norms and long-range user/project identity patterns.
- `replay and associative memory`
  Ember now runs deterministic replay both after archival and on a background
  cadence with skip heuristics, but replay-specific operator approval policy
  and contradiction-aware confidence downgrades are still limited.
- `procedural memory`
  Ember now learns reusable procedures from repeated successful tool/action
  sequences, but governance around promotion thresholds, retirement, and manual
  approval is still basic.

## Reference Systems To Borrow From

- `repos/qwen-code`
  Use as reference for explicit user-controlled memory writes and simple memory
  UX, especially `packages/core/src/tools/memoryTool.ts`.
- `repos/openclaw`
  Use as reference for memory indexing, retrieval, temporal decay, session
  filters, and search tools, especially:
  - `src/memory/manager.ts`
  - `src/memory/search-manager.ts`
  - `src/memory/temporal-decay.ts`
  - `src/agents/tools/memory-tool.ts`
  - `src/hooks/bundled/session-memory/handler.ts`

## Target Data Model

Primary records to support:

- `memory_sessions`
  Session-level summaries and metadata tied to Ember `conversationId`.
- `memory_items`
  Persistent semantic and episodic memory units.
- `memory_embeddings`
  Optional embedding payloads for semantic retrieval.
- `memory_edges`
  Relationships such as `derived_from`, `reinforces`, `contradicts`,
  `about_user`, `about_project`.

Every stored memory item must support at least:

- `id`
- `session_id`
- `created_at`
- `content`
- `memory_type`
- `tags`
- `scope`
- `source_type`
- `source_ref`
- `confidence`
- `salience`
- `volatility`
- `valid_from`
- `valid_until`
- `supersedes_id`

## Execution Phases

### Phase 1 — Foundation In `@ember/core`

Status:
- `[x]` Completed
- Verified on March 12, 2026

Delivered:

- `[x]` Added the shared memory module under `packages/core/src/memory/`
- `[x]` Added memory domain types for sessions, items, searches, write
  candidates, and prompt injection payloads
- `[x]` Added memory defaults and normalization
- `[x]` Added a backend-agnostic repository interface
- `[x]` Added the first deterministic file-backed repository implementation
- `[x]` Added retrieval scoring and prompt-budgeted memory injection helpers
- `[x]` Extended shared `Settings` with a `memory` config block
- `[x]` Exported the memory module from `packages/core/src/index.ts`
- `[x]` Bootstrapped `data/memory.json` in the shared data store
- `[x]` Added focused tests for session persistence, active-session exclusion,
  and prompt budget enforcement

Verification:

- `[x]` `node --import tsx --test packages/core/src/memory/store.test.ts`
- `[x]` `pnpm --filter @ember/core build`
- `[x]` `pnpm --filter @ember/server typecheck`
- `[x]` `pnpm --filter @ember/web typecheck`
- `[!]` `pnpm --filter @ember/core typecheck` is still blocked by a
  pre-existing unrelated error in `packages/core/src/defaults.test.ts`

Goal:
Create the memory domain model, configuration defaults, repository contracts,
and a first local storage layer so the rest of the system can build on stable
interfaces instead of ad hoc objects.

Why this phase exists:
The server, connector layer, consolidation logic, and future UI all need the
same shared memory vocabulary. If we skip this and wire memory directly into
`apps/server`, the system will become brittle immediately.

Deliverables:

- Add `packages/core/src/memory/` with:
  - types for memory sessions, items, retrieval queries, write candidates, and
    injection payloads
  - defaults for memory settings
  - repository interfaces
  - local storage helpers
  - basic retrieval scoring helpers
- Extend `Settings` with a `memory` config block.
- Export the new memory module from `packages/core/src/index.ts`.
- Add tests for the core memory data model and first retrieval rules.

How it plugs into the codebase:

- `packages/core` becomes the single source of truth for memory structures.
- `apps/server` will later import these types for retrieval and consolidation.
- `packages/connectors` will later consume the injection payload type for
  provider prompt assembly.

Implementation notes:

- Keep the storage contract backend-agnostic.
- Make the first storage layer deterministic and file-local for development.
- Preserve the ability to swap the storage implementation to SQLite without
  changing the rest of the call sites.

Acceptance criteria:

- `[x]` Core types and defaults compile through the shipped build path.
- `[x]` Memory records can be created, persisted, listed, and filtered by
  session.
- `[x]` Retrieval helpers can exclude the active session and rank matches.

### Phase 2 — Production Storage Backend And Search

Status:
- `[x]` Completed
- Verified on March 12, 2026

Delivered so far:

- `[x]` Added a SQLite-backed memory repository behind the same repository
  interface introduced in Phase 1
- `[x]` Switched the default memory backend to SQLite
- `[x]` Added durable tables for sessions, items, embeddings, and edges
- `[x]` Added indexes for session ownership, scope, memory type, source type,
  observed time, expiry, and supersession
- `[x]` Added FTS5-backed candidate search with lexical fallback
- `[x]` Added deterministic local embeddings using a built-in token-hash model
- `[x]` Added SQLite embedding persistence and startup backfill for missing
  embeddings on existing databases
- `[x]` Added hybrid retrieval by unioning lexical/FTS candidates with vector
  candidates, then ranking through the shared scoring layer
- `[x]` Preserved the Phase 1 retrieval scorer on top of SQLite candidates and
  extended it with semantic similarity weighting
- `[x]` Added search filters for active-session exclusion, scope, memory type,
  and source type
- `[x]` Added first-open migration from Phase 1 `memory.json` into SQLite
- `[x]` Added focused SQLite tests for persistence, search behavior, and
  migration
- `[x]` Added semantic recall tests using paraphrased queries rather than exact
  keyword overlap

Verification so far:

- `[x]` `node --import tsx --test packages/core/src/memory/store.test.ts packages/core/src/memory/sqlite.test.ts`
- `[x]` `pnpm --filter @ember/core build`
- `[x]` `pnpm --filter @ember/server typecheck`
- `[x]` `pnpm --filter @ember/web typecheck`

Goal:
Replace the phase-1 local store with a production memory backend backed by
SQLite, plus full-text and optional embedding-based retrieval.

Why this phase exists:
Long-term memory needs durable storage, inspectability, and efficient search.
We also need one place to support provenance, supersession, and recency.

Deliverables:

- Add SQLite-backed persistence for memory sessions and items.
- Add indexing for tags, timestamps, volatility, and session ownership.
- Add hybrid retrieval:
  - lexical / token overlap
  - full-text search
  - embedding similarity when enabled
- Add filtering support:
  - exclude active session
  - scope filters
  - source-type filters
  - volatility / expiry filters

How it plugs into the codebase:

- `packages/core/src/memory` keeps the same repository surface from Phase 1.
- Only the backing implementation changes.
- `apps/server` remains insulated from backend details.

Implementation notes:

- Start with SQLite as the source of truth.
- Embeddings should be optional and layered on top, not required for baseline
  correctness.
- Retrieval must degrade gracefully when embeddings are unavailable.

Acceptance criteria:

- `[x]` Memory persists across restarts.
- `[x]` Search returns relevant matches with active-session exclusion.
- `[x]` Time-sensitive memories can expire or rank lower over time.
- `[x]` Optional embedding similarity path when enabled.

### Phase 3 — Consolidation Pipeline

Status:
- `[x]` Completed
- Verified on March 12, 2026

Delivered:

- `[x]` Added a first consolidation engine in
  `packages/core/src/memory/consolidation.ts`
- `[x]` Added session summarization that rolls the current conversation into a
  durable `memory_sessions` record keyed by `conversationId`
- `[x]` Added canonical extraction for stable user facts, including
  date-of-birth normalization from natural language
- `[x]` Added response-style preference extraction for durable user
  preferences
- `[x]` Added sourced world-fact promotion from fetched web content with
  `source_ref` and `observed_at`
- `[x]` Added contradiction handling for canonical user facts via
  `supersedes_id` and `superseded_by_id`
- `[x]` Added tool-observation capture in `apps/server/src/tools/index.ts` so
  fetched pages can survive beyond the current reply
- `[x]` Added focused consolidation tests for canonical user memory updates and
  sourced world-fact promotion

Verification:

- `[x]` `node --import tsx --test packages/core/src/memory/consolidation.test.ts`
- `[x]` `node --import tsx --test packages/core/src/memory/consolidation.test.ts packages/core/src/memory/store.test.ts packages/core/src/memory/sqlite.test.ts`
- `[x]` `pnpm --filter @ember/core build`
- `[x]` `pnpm --filter @ember/server typecheck`
- `[x]` `pnpm --filter @ember/web typecheck`

Goal:
Teach Ember to decide what to remember after each turn and after each session.

Why this phase exists:
Without consolidation, memory becomes either empty or garbage. Human-like
memory needs selection, abstraction, and promotion.

Deliverables:

- Add candidate extraction from:
  - user messages
  - assistant tool results
  - fetched web/page content
  - session summaries
- Add classification into:
  - `discard`
  - `episodic`
  - `semantic`
- Add canonicalization for user facts.
  Example: normalize birthdays, dates, names, persistent preferences.
- Add confidence and salience scoring at write time.
- Add contradiction detection and supersession.

How it plugs into the codebase:

- The extraction pipeline will be called from the server after a response
  completes and when a conversation is finalized.
- Tool results and web reads become memory candidates instead of disappearing
  after the current session.

Implementation notes:

- Do not auto-promote every sentence.
- Stable user facts should receive higher salience than one-off conversational
  details.
- World facts must carry source and observed timestamp.

Acceptance criteria:

- `[x]` Ember can store a user birthday as a canonical durable fact.
- `[x]` Ember can store session summaries as episodic memory.
- `[x]` Contradictory memories produce a clean supersession path.

### Phase 4 — Pre-Prompt Retrieval Injection

Status:
- `[x]` Completed
- Verified on March 12, 2026

Delivered:

- `[x]` Added a dedicated `memoryContext` channel to
  `ProviderExecutionRequest` instead of faking long-term memory as chat turns
- `[x]` Added retrieval-query construction in
  `packages/core/src/memory/consolidation.ts` so working-memory signals can
  drive long-term recall
- `[x]` Wired pre-prompt retrieval into every live provider turn in
  `apps/server/src/index.ts`, including handoff loops and streaming execution
- `[x]` Preserved active-session exclusion by filtering on the active
  `conversationId`
- `[x]` Kept persistent memory separate from compacted history summary in
  `packages/connectors/src/drivers.ts`
- `[x]` Added prompt transport for OpenAI-compatible, Anthropic, Codex CLI,
  and generic CLI formatting paths
- `[x]` Added retrieval-time derived age formatting from stored date of birth
  so Ember stores canonical DOB while injecting current age
- `[x]` Added prompt-layer tests showing persistent memory stays in the system
  prompt rather than being mixed into compacted chat history

Verification:

- `[x]` `node --import tsx --test apps/server/src/provider-loop.test.ts`
- `[x]` `node --import tsx --test packages/core/src/memory/consolidation.test.ts packages/core/src/memory/store.test.ts packages/core/src/memory/sqlite.test.ts apps/server/src/provider-loop.test.ts`
- `[x]` `pnpm --filter @ember/core build`
- `[x]` `pnpm --filter @ember/server typecheck`
- `[x]` `pnpm --filter @ember/web typecheck`

Goal:
Retrieve the most relevant long-term memories before every provider call and
inject them as a compact, explicit memory block.

Why this phase exists:
Persistence only matters if the model sees the right memories at the right
time. The retrieval layer is what makes the agent feel continuous.

Deliverables:

- Build a retrieval query from:
  - current user message
  - recent turns
  - route / role context
- Retrieve relevant semantic and episodic memories.
- Rerank using:
  - relevance
  - salience
  - confidence
  - recency for volatile facts
- Add a compact memory injection format.
- Add per-request memory budgets by count and character size.

How it plugs into the codebase:

- Integrate retrieval into `apps/server/src/index.ts` before provider execution.
- Extend provider request formatting in `packages/connectors/src/drivers.ts` to
  include a dedicated long-term memory block distinct from conversation history.

Implementation notes:

- The injected memory block must stay separate from `history-summary`.
- Memory injection should be deterministic and easy to inspect in tests.
- The agent must never re-inject memories from the active session.

Acceptance criteria:

- `[x]` A user fact saved in one conversation can be recalled in another.
- `[x]` The same active conversation is not double-counted as memory.
- `[x]` Prompt growth stays bounded.

### Phase 5 — Explicit Memory Tools

Status:
- `[x]` Completed
- Verified on March 12, 2026

Delivered:

- `[x]` Added native memory tools in `apps/server/src/tools/memory.ts`:
  - `save_memory`
  - `memory_search`
  - `memory_get`
  - `forget_memory`
- `[x]` Reused the shared repository and retrieval pipeline from `@ember/core`
  instead of creating a separate tool-only storage path
- `[x]` Added soft-forget support to the memory repository so forgotten
  memories stop being retrieved while remaining auditable
- `[x]` Added bundled role guidance in `skills/memory-tools/SKILL.md`
- `[x]` Added workflow hints so roles search before asking the user to repeat
  stable facts
- `[x]` Added boot-time memory initialization in both
  `apps/server/src/index.ts` and `packages/cli/src/index.ts`
- `[x]` Added focused tests for the explicit memory tool flow and eager SQLite
  bootstrap before first chat

Verification:

- `[x]` `node --import tsx --test apps/server/src/tools.test.ts`
- `[x]` `node --import tsx --test apps/server/src/tools.test.ts apps/server/src/provider-loop.test.ts packages/core/src/memory/store.test.ts packages/core/src/memory/sqlite.test.ts packages/core/src/memory/consolidation.test.ts`
- `[x]` `pnpm --filter @ember/core build`
- `[x]` `pnpm --filter @ember/server typecheck`
- `[x]` `pnpm --filter @ember/web typecheck`
- `[x]` `pnpm --filter @ember/cli exec tsc --project tsconfig.json --noEmit`

Goal:
Give the agent and the user direct tools to save, inspect, and remove memory.

Why this phase exists:
Some memories should be explicit and user-controlled, not only inferred.

Deliverables:

- Add tools:
  - `save_memory`
  - `memory_search`
  - `memory_get`
  - `forget_memory`
- Add skill guidance for when to use each memory tool.
- Add safe confirmation paths for explicit memory writes or deletions.

How it plugs into the codebase:

- Tools register under `apps/server/src/tools/`.
- Skills live under `skills/`.
- Tool outputs should reuse the shared memory repository from `@ember/core`.

Implementation notes:

- Borrow Qwen’s explicit save behavior, but store structured entries instead of
  plain markdown appends.
- Borrow OpenClaw’s `memory_search` and `memory_get` split so retrieval stays
  small and composable.

Acceptance criteria:

- `[x]` Users can explicitly save a memory.
- `[x]` The agent can search memory when it needs to reason about prior facts.
- `[x]` Deletions and supersessions are auditable.

### Phase 6 — Session Lifecycle Memory

Status:
- `[x]` Completed
- Verified on March 12, 2026

Delivered:

- `[x]` Added archived-session lifecycle support in
  `packages/core/src/memory/consolidation.ts`
- `[x]` Session consolidation now distinguishes active sessions from archived
  sessions and writes `endedAt` on close
- `[x]` Final session summaries now include closure metadata and archive reason
- `[x]` Archived sessions now promote:
  - final task outcomes
  - unresolved open threads
  - notable failures and cautions
- `[x]` Added server-side lifecycle finalization hooks in
  `apps/server/src/index.ts`
- `[x]` Added `POST /api/conversations/:id/archive` for manual archive hooks
  before UI support exists
- `[x]` Deleting a conversation now finalizes its session memory before the chat
  history is removed
- `[x]` Added `archivedAt` to the shared conversation model and normalized older
  stored conversations that do not yet have the field
- `[x]` Added focused lifecycle tests for archived-session memory promotion

Verification:

- `[x]` `node --import tsx --test packages/core/src/memory/consolidation.test.ts packages/core/src/memory/store.test.ts packages/core/src/memory/sqlite.test.ts apps/server/src/provider-loop.test.ts apps/server/src/tools.test.ts`
- `[x]` `pnpm --filter @ember/core build`
- `[x]` `pnpm --filter @ember/server typecheck`
- `[x]` `pnpm --filter @ember/web typecheck`

Goal:
Capture full-session learning at boundaries such as conversation completion,
manual reset, or archival.

Why this phase exists:
Humans store episodes after an experience, not only moment-by-moment. Ember
needs the same post-session consolidation behavior.

Deliverables:

- Generate end-of-session summaries linked to `conversationId`.
- Persist task outcomes, unresolved threads, and notable failures.
- Add hooks to archive a conversation summary into episodic memory.

How it plugs into the codebase:

- Build on top of the conversation persistence flow in
  `apps/server/src/index.ts`.
- Optionally expose manual “archive this conversation” actions later in the UI.

Implementation notes:

- Keep session summaries short and structured.
- Reuse the existing conversation compaction logic where possible.

Acceptance criteria:

- `[x]` Closed conversations produce episodic summaries.
- `[x]` Future sessions can retrieve prior project work by topic.

### Phase 7 — Decay, Forgetting, And Derived Facts

Goal:
Make memory stay trustworthy over time by modeling volatility and decay.

Why this phase exists:
An immortal memory with no decay becomes wrong and noisy. A human-like memory
engine must know what stays true, what changes, and what should be derived.

Deliverables:

- Add decay policies by volatility:
  - stable
  - slow-changing
  - event
  - volatile
- Add expiry support for short-lived facts.
- Add derived facts at retrieval time.
  Example: compute age from birthdate instead of storing age as evergreen fact.
- Add reinforcement rules for memories mentioned repeatedly.

How it plugs into the codebase:

- Retrieval scoring uses decay multipliers.
- Consolidation updates reinforcement and supersession metadata.
- Explicit memory tools reinforce existing durable facts instead of duplicating them.

Implementation notes:

- `[x]` Stable profile facts keep full weight and derive time-sensitive views at retrieval.
- `[x]` Repeated facts increment reinforcement metadata instead of creating duplicates.
- `[x]` Sourced world facts now carry revalidation deadlines, and volatile facts can expire.

Acceptance criteria:

- `[x]` Date-of-birth based age stays current across time.
- `[x]` Old volatile world facts drop in rank or expire.

### Phase 8 — UI, Inspection, And Debugging

Goal:
Make memory observable so operators can trust and debug the system.

Why this phase exists:
Hidden memory systems are impossible to validate. We need to inspect what Ember
knows, why it retrieved it, and where it came from.

Deliverables:

- Add memory inspection endpoints on the API.
- Add a 3D memory cortex visualizer in the web UI:
  - colored memory nodes
  - clustered layout by memory domain
  - correlated links between related memories
  - pulsing retrieval traffic across active links
- Add operator panels around the visualizer:
  - recent memories
  - user profile facts
  - session summaries
  - superseded / expired entries
- Add retrieval debug output to show what was injected for a request.

How it plugs into the codebase:

- `apps/server` exposes memory overview, graph, and retrieval trace endpoints.
- `apps/web` renders both operator inspection panels and the live 3D cortex view.

Implementation notes:

- `[x]` Always show provenance for world facts.
- `[x]` Surface retrieval reasons and recent injection traces.
- `[x]` Use recent co-retrieval activity to drive visible activation in the graph.

Acceptance criteria:

- `[x]` Operators can inspect memory state without reading raw data files.
- `[x]` Retrieval behavior is explainable.
- `[x]` The web UI renders a live clustered memory graph with active pulse flow.

### Phase 9 — Evaluation And Rollout

Goal:
Prove the system improves continuity and truthfulness without flooding prompts
or storing junk.

Why this phase exists:
Memory features tend to feel impressive in demos and fail in repeated use. We
need evals before calling the system “alive.”

Deliverables:

- Build eval cases:
  - user profile recall across sessions
  - project recall across sessions
  - web fact recall with provenance
  - contradiction handling
  - active-session exclusion
  - prompt budget control
- Add regression tests for consolidation and retrieval.
- Add rollout flags for enabling memory incrementally.

How it plugs into the codebase:

- Tests live in `packages/core` and `apps/server`.
- Runtime feature flags live in settings/config defaults.
- The memory page and inspection APIs respect rollout gates independently of the core memory engine.

Implementation notes:

- `[x]` Success is not “stored a lot.”
- `[x]` Success is “retrieved the right thing, at the right time, without clutter.”
- `[x]` Retrieval tracing, inspection APIs, and the cortex UI can now be toggled independently.
- `[x]` Eval coverage now exercises cross-session recall, provenance, contradiction handling, exclusion, and prompt budget limits.

Acceptance criteria:

- `[x]` Cross-session recall works reliably.
- `[x]` Memory noise stays controlled.
- `[x]` Prompt size remains bounded.

### Phase 10 — Multi-Cue Retrieval And State-Dependent Recall

Status:
- `[x]` Completed

Goal:
Make retrieval behave more like cue-based human recall instead of relying
mostly on text similarity plus salience.

Why this phase exists:
The paper's strongest retrieval claim is not "use embeddings." It is "retrieve
based on overlapping cues from the current state." Ember needs richer retrieval
signals so the right memory appears for the right task, role, and tool context.

Deliverables:

- Extend `MemorySearchQuery` with explicit retrieval cues:
  - active role
  - route / handoff source
  - active subgoal
  - recent tool names
  - current workspace topics
  - failure / blocked state
  - source-trust preference
- Update retrieval scoring to weight cue overlap separately from free-text
  similarity.
- Track retrieval success signals so memories that repeatedly help can rank
  higher on future similar tasks.
- Expand retrieval traces to show which cues caused each memory to rank.

How it plugs into the codebase:

- `apps/server/src/index.ts` builds richer retrieval queries before each live
  provider turn.
- `packages/core/src/memory/types.ts` and
  `packages/core/src/memory/scoring.ts` gain cue-aware query and scoring
  structures.
- `apps/server/src/memory-traces.ts` records cue-level debug output.

Implementation notes:

- Keep prompt injection compact even if retrieval becomes richer.
- Do not encode cues as one giant text string when structured fields will do.
- Active-session exclusion remains mandatory.

Acceptance criteria:

- `[x]` Retrieval can distinguish the same user message under different roles
  or tool contexts.
- `[x]` Retrieval traces explain why a memory was selected in terms of explicit
  cues, not only keyword overlap.
- `[x]` Prompt growth remains bounded after adding cue-aware ranking.

### Phase 11 — Semantic Distillation For Project And Environment Knowledge

Status:
- `Complete`
- `[x]` Strong-evidence distillation now promotes:
  - repository package-manager facts from `project_overview`
  - workspace layout facts from `project_overview`
  - successful build / test / typecheck / runtime commands
  - local environment version facts such as Node / pnpm / npm / Python
- `[x]` `memory_edges` now store semantic provenance via `derived_from` and
  `supersedes`.
- `[x]` Semantic facts now supersede older conflicting environment/project
  values cleanly.
- `[x]` Distill message-level persistent project constraints into canonical
  `project_fact` records instead of leaving them only as warnings/session text.
- `[x]` Expand repo-convention extraction beyond `project_overview` and simple
  terminal evidence.

Goal:
Promote repeated project facts and environment facts into durable semantic
memory instead of leaving them trapped inside episodic summaries.

Why this phase exists:
The paper argues for slow semantic abstraction from repeated episodes. Ember's
schema already supports `project_fact` and `environment_fact`, but automatic
distillation is still too narrow.

Deliverables:

- Add candidate extraction for:
  - repository structure and conventions
  - build/runtime commands that repeatedly succeed
  - persistent project constraints
  - local environment facts that matter across sessions
- Require repetition, confirmation, or strong evidence before promoting a
  project/environment fact to durable semantic memory.
- Link semantic items back to supporting episodes or observations.
- Add reconsolidation rules so newer evidence can revise older distilled facts
  cleanly.

How it plugs into the codebase:

- `packages/core/src/memory/consolidation.ts` expands semantic candidate
  extraction.
- `packages/core/src/memory/sqlite.ts` starts using `memory_edges` to connect
  distilled facts to supporting episodes.
- `apps/server/src/tools/index.ts` captures more structured tool-observation
  metadata for consolidation.

Implementation notes:

- Distillation should prefer canonical statements over raw assistant phrasing.
- Promotion rules should be stricter for identity-level or workspace-level
  facts than for short-lived observations.
- Current slice uses strong deterministic evidence first:
  `project_overview` output, successful terminal commands, and explicit version
  checks.
- Remaining work in this phase should widen the evidence base without
  weakening promotion thresholds.

Acceptance criteria:

- `[x]` Repeated or strongly evidenced repo facts consolidate into
  `project_fact` instead of only
  reappearing as session summaries.
- `[x]` Environment assumptions can be updated or superseded cleanly.
- `[x]` Distilled semantic memories retain provenance links to supporting
  episodes.

### Phase 12 — Replay, Association, And Generalization

Status:
- `Complete`
- `[x]` Replay now runs after archived-session finalization.
- `[x]` Replay derives `reinforces`, `contradicts`, `about_user`, and
  `about_project` links from multi-session support.
- `[x]` Replay can promote repeated cross-session project constraints into new
  semantic facts with provenance.
- `[x]` The inspection graph now surfaces explicit replay edges and procedure
  nodes instead of only co-fire correlations.

Goal:
Add an offline/background replay pass that clusters episodes, strengthens
useful associations, and derives higher-level knowledge.

Why this phase exists:
The paper's replay story is missing from Ember today. Without replay, memory
improves only at write time and retrieval time; it does not self-organize
between sessions.

Deliverables:

- Add a replay job that scans recent episodes and:
  - clusters related sessions
  - writes `memory_edges` such as `derived_from`, `reinforces`,
    `contradicts`, `about_user`, and `about_project`
  - proposes new semantic abstractions from repeated support
- Add replay safety rules so one-off noisy episodes do not over-consolidate.
- Surface replay-derived links in the inspection UI and trace data.

How it plugs into the codebase:

- New replay logic lives under `packages/core/src/memory/`.
- `apps/server` can trigger replay after session archival and optionally on a
  background interval later.
- `apps/web` can visualize durable links rather than only co-retrieval
  correlations.

Implementation notes:

- Start with deterministic clustering before adding any model-written
  abstractions.
- Replay should optimize for generalization, not maximum retention.

Acceptance criteria:

- `[x]` Repeated related episodes create durable memory links.
- `[x]` Replay can propose a semantic abstraction only when supported by
  multiple episodes.
- `[x]` Operators can inspect replay-derived links and supporting evidence.

### Phase 13 — Procedural Memory And Learned Skills

Status:
- `Complete`
- `[x]` Consolidation now extracts draft procedures from verified multi-step
  tool/action traces.
- `[x]` Procedures publish only after repeated success and retire after
  repeated failure.
- `[x]` Runtime prompt assembly now injects learned procedures in a separate
  compact block from persistent fact memory.

Goal:
Teach Ember to learn reusable procedures from repeated successful action
sequences instead of relying only on static prompt-authored skills.

Why this phase exists:
The paper treats procedural memory as separate from declarative fact memory.
Ember currently has strong static skills and tools, but not learned procedural
routines.

Deliverables:

- Add a procedural-memory store for successful tool/action traces with:
  - trigger conditions
  - preconditions
  - ordered steps
  - verification checks
  - success/failure counts
- Promote a procedure only after repeated success on similar tasks.
- Retrieve procedures separately from fact memory during planning/execution.
- Distinguish static `skills/` instructions from learned runtime procedures.

How it plugs into the codebase:

- New procedural-memory modules live under `packages/core/src/memory/` or a
  sibling runtime-memory package.
- `apps/server/src/tools/index.ts` and handoff execution paths provide the
  action traces needed for promotion.
- Provider prompt assembly includes a compact "procedure recall" block distinct
  from persistent fact memory.

Implementation notes:

- Do not infer procedures from a single success.
- Failed or low-confidence routines must decay or remain unpublished.

Acceptance criteria:

- `[x]` Ember can reuse a previously learned multi-step procedure on a similar
  task without re-deriving every step from scratch.
- `[x]` Procedures remain auditable and can be retired after repeated failure.
- `[x]` Fact retrieval and procedure retrieval stay separate in prompt
  assembly.

### Phase 14 — Replay Cadence And Governance Hardening

Status:
- `Completed`
- `[x]` Replay now runs on a background cadence with skip heuristics instead of
  only at archived-session finalization.
- `[x]` Replay state is visible in the memory overview and can be triggered
  manually from the inspection UI.
- `[x]` Operators can suppress memories, revalidate memories, and retire
  learned procedures from the inspection UI.
- `[x]` Add approval workflows for promoted semantic facts and learned
  procedures instead of relying only on suppression/retirement after the fact.
- `[x]` Add contradiction-aware confidence downgrades when replay finds
  conflicting cross-session support.
- `[x]` Tighten selectivity so small-context local models are not bogged down:
  active session summaries now ignore generic continuation churn, one-off
  terminal commands are not promoted into semantic memory, and write-time
  consolidation prioritizes a compact high-signal set of durable memories.
- `[x]` Tighten prompt injection so retrieval stays small and relevant:
  lexical stop-word filtering now suppresses generic conversational matches,
  approved/disputed state affects ranking, and prompt assembly caps redundant
  memory types instead of dumping multiple similar episodic items.
- `[x]` Add a compact coordinator execution profile for small local models:
  when coordinator is assigned to a ~15k to 25k context provider, Ember now
  narrows the active tool list to task-relevant tools and swaps the giant
  skill-heavy tool prompt for a compact version so the 9B-class coordinator
  spends context on work instead of instructions.

Goal:
Turn replay and memory governance into an ongoing maintenance system instead of
just a write-time/inspect-time mechanism.

Why this phase exists:
The paper's memory story includes replay, pruning, and selective stabilization.
Ember now has those ingredients, but the control loop still needs better
operator governance and contradiction handling.

Deliverables:

- Run replay on a scheduler with skip heuristics to avoid pointless repeated
  scans.
- Expose replay state and manual replay controls in the inspection UI.
- Expose operator actions to suppress, revalidate, or retire memory records.
- Add explicit approval and contradiction-resolution policies on top of those
  manual controls.

How it plugs into the codebase:

- `apps/server/src/memory-maintenance.ts` manages replay cadence and state.
- `apps/server/src/index.ts` exposes replay and governance endpoints.
- `packages/core/src/memory/governance.ts` holds repository-level mutation
  helpers for suppression, revalidation, and retirement.
- `apps/web/app/memory/` and `apps/web/components/memory-lab.tsx` surface the
  controls to operators.

Implementation notes:

- The scheduler should skip when there are no new archived sessions rather than
  replaying blindly.
- Manual controls should be explicit and auditable, not hidden behind prompt
  behavior.
- Retirement should supersede a procedure rather than mutating history in
  place, so the system keeps an inspectable lineage.
- Replay-promoted semantic facts and published learned procedures should enter
  the system in a pending-review state rather than being treated as
  automatically blessed.
- Contradicted durable memories should remain inspectable, but replay should
  lower their confidence/salience and mark them disputed so recall stays
  selective.

Acceptance criteria:

- `[x]` Replay can run in the background without hammering the repository when
  nothing new has been archived.
- `[x]` Operators can manually trigger replay and see its current status.
- `[x]` Operators can suppress or retire low-value memories without touching
  the underlying database manually.
- `[x]` Promoted knowledge can be explicitly approved or downgraded when
  replay finds contradictory support.

### Phase 15 — Memory Precision Telemetry And Eval Hardening

Status:
- `Next`

Goal:
Measure whether the memory system is actually helping small local models feel
smarter over time without inflating prompt cost.

Why this phase exists:
The paper argues for selective reconstruction, not indiscriminate replay. Ember
now has the core layered memory machinery, but the next bottleneck is empirical
precision: knowing when memory helped, when it was ignored, and when it was
needlessly injected.

Deliverables:

- Record compacted-chat chars, persistent-memory chars, and procedure-memory
  chars per request in retrieval traces.
- Add memory precision/recall evals focused on 25k-context local models and
  small retrieval budgets.
- Measure how often replay-promoted facts and learned procedures are later
  approved, disputed, or suppressed.
- Tune promotion and retrieval thresholds from observed false positives and
  misses instead of intuition alone.

## File Map To Change

- `TODO.md`
  This roadmap.
- `packages/core/src/types.ts`
  Add memory settings to shared configuration types.
- `packages/core/src/defaults.ts`
  Add memory defaults and normalization.
- `packages/core/src/store.ts`
  Add memory storage bootstrap helpers.
- `packages/core/src/index.ts`
  Export memory modules.
- `packages/core/src/memory/*`
  New core memory system foundation.
- `packages/core/src/memory/consolidation.ts`
  Consolidation, summarization, and retrieval-query construction.
- `packages/core/src/memory/scoring.ts`
  Cue-aware retrieval ranking, replay-aware boosts, and procedure recall
  ranking.
- `packages/core/src/memory/sqlite.ts`
  Durable storage for replay links, semantic support edges, and procedural
  traces.
- `apps/server/src/index.ts`
  Retrieval and consolidation wiring for sync and streaming execution.
- `packages/connectors/src/drivers.ts`
  Provider memory injection path.
- `apps/server/src/tools/*`
  Tool observation capture today, explicit memory tools next.
- `apps/web/*`
  Future memory inspection UI.
- `apps/server/src/memory-traces.ts`
  Retrieval trace detail for multi-cue ranking and replay visibility.

## Immediate Next Step

Start Phase 15 and instrument memory quality for small local models:

- log compacted conversation chars, persistent-memory chars, and procedure
  chars per request in memory traces
- add eval cases that verify a 25k-context local model only receives a tiny
  high-signal memory set
- tune promotion/retrieval thresholds from those measurements
