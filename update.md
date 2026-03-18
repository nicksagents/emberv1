# EMBER FRAMEWORK — MASTER UPDATE PLAN v2

You are an expert systems engineer working on the Ember AI agent framework. This document is your complete execution plan. Work through each phase in order, checking off items as you complete them. Every task includes exact files to modify, the approach to take, and how the fix integrates with the rest of the framework. Do not skip steps. Do not deviate from the architecture described here.

## Context: What Ember Is

Ember is an AI agent framework modeled after the human brain. It has layered systems that mirror cognitive function:

- **Knowledge/Talking Layer** — LLM providers (Anthropic, OpenAI-compatible, Codex, local models) with multi-provider routing, role-based prompt specialization, and failover
- **Memory Layer** — Four memory stores (flat key-value, graph relational, app-specific, session recall) that persist knowledge across conversations
- **Skills/Tools Layer** — Native tools (terminal, files, git, search, HTTP, process management) plus dynamic MCP server tools that let the agent act on the world
- **Imagination Layer** — Swarm simulation engine that spawns diverse personas to debate scenarios and produce probability assessments before making decisions
- **Executive Function** — Dispatch routing, metacognition (self-monitoring), and coordinator triage that decide what to do, how hard to think, and when to escalate

The goal is a framework where small-to-large models collaborate as a unified cognitive system capable of handling any task. It must work with models as small as 0.8B parameters and scale up to frontier models.

## Competitor Intelligence

This plan incorporates findings from analyzing two competitor frameworks:

- **Hermes Agent** (180K lines Python, MIT) — General-purpose agent with 25+ tools, 6 terminal backends, cron scheduling, multi-platform messaging (Telegram/Discord/Slack/WhatsApp/Signal/Email), dangerous command detection (40+ patterns), code sandbox, agentskills.io ecosystem, prompt injection scanning, frozen memory snapshots for caching, MCP with sampling support
- **MiroFish** (21K lines Python, AGPL-3.0) — Swarm simulation engine with GraphRAG (ontology → graph → entity extraction via Zep), OASIS-based multi-agent simulation, temporal activity modeling (sentiment, influence weights, response delays), ReACT with section-by-section reflection loops, IPC subprocess isolation

Ember must beat both. The competitive advantages we aim for: unified cognitive architecture, small-model efficiency, streaming-first design, and persistent self-improving intelligence.

## Architecture: Key Files and How They Connect

```
User Request
  |
  v
apps/server/src/index.ts          — Fastify server, route registration, request lifecycle
  |
  v
apps/server/src/security.ts       — Auth (bearer tokens), rate limiting, idempotency, CORS, body validation
  |
  v
apps/server/src/orchestration-prompt.ts — Builds role-specific prompt stack (shared + role + tools)
  |                                        Calls @ember/prompts for role templates
  |                                        Calls metacognition for cognitive assessment
  |
  v
apps/server/src/provider-routing.ts — Decides which provider/model handles the request
  |                                    Uses task profiling (11 pattern categories)
  |                                    Falls back to LLM dispatch via packages/prompts/src/dispatch.ts
  |
  v
packages/connectors/src/drivers.ts — Executes the LLM call (Anthropic/OpenAI/Codex/local)
  |                                   Manages tool loops, compaction, cycle detection
  |
  v
apps/server/src/tools/index.ts    — Tool registry, role-based tool filtering
  |                                  Dispatches tool calls to individual tool modules
  |
  v
apps/server/src/tools/*.ts        — Individual tools (terminal, files, memory, search, etc.)
  |
  v
apps/server/src/metacognition.ts   — Monitors execution, detects stuck states, suggests strategy changes
  |
  v
apps/server/src/session-recall.ts  — TF-IDF search over conversation history
  |
  v
apps/server/src/swarm/             — Simulation engine (persona generation, round execution, synthesis)
  |
  v
packages/core/src/                 — Settings, types, store (encryption), memory subsystem, token estimation
```

---

## PHASE 1: CRITICAL BUG FIXES

These are correctness and data-integrity issues that must be fixed before any feature work. They cause silent data loss, race conditions, or security bypasses in the current code.

---

### 1.1 — Fix .env Denial List (Incomplete Pattern Matching) ✅

- [x] **File:** `apps/server/src/tools/files.ts:20`
- [ ] **Bug:** The `DENIED_BASENAMES` array is a fixed list: `[".env", ".env.local", ".env.production", ".env.staging"]`. It misses `.env.development`, `.env.test`, `.env.backup`, `.env.secret`, and any custom `.env.*` files.
- [ ] **How to fix:**
  1. Replace the fixed array with a regex-based check:
     ```typescript
     const DENIED_BASENAME_PATTERN = /^\.env($|\.)/i;
     ```
  2. Update `validatePath()` (line 40-58) to use the regex instead of `DENIED_BASENAMES.includes()`:
     ```typescript
     const lowerBasename = basename(resolvedPath).toLowerCase();
     if (DENIED_BASENAME_PATTERN.test(lowerBasename)) {
       return `Access to "${lowerBasename}" is blocked by security policy.`;
     }
     ```
  3. Remove the `DENIED_BASENAMES` constant entirely.
- [ ] **Test:** Add test cases in `apps/server/src/tools.test.ts`:
  - `.env.development` → blocked
  - `.env.test` → blocked
  - `.env.anything` → blocked
  - `.environment` → allowed (does not start with `.env.` or equal `.env`)
  - `env.local` → allowed (no leading dot)

---

### 1.2 — Validate Compaction Stage Ordering ✅

- [x] **File:** `apps/server/src/config.ts:98-101`
- [ ] **Bug:** Users can set `EMBER_COMPACTION_STAGE1=0.80` and `EMBER_COMPACTION_STAGE2=0.60` via env vars. No validation enforces `stage1 < stage2 < stage3`. This causes compaction to misbehave silently — potentially skipping stages or double-compacting.
- [ ] **How to fix:**
  1. After the `CONFIG` object is built (after line 137), add a validation function:
     ```typescript
     function assertCompactionStageOrder(config: typeof CONFIG): void {
       const { stage1, stage2, stage3 } = config.compaction;
       if (stage1 >= stage2) {
         throw new Error(
           `Invalid compaction config: stage1 (${stage1}) must be less than stage2 (${stage2}). ` +
           `Check EMBER_COMPACTION_STAGE1 and EMBER_COMPACTION_STAGE2 environment variables.`
         );
       }
       if (stage2 >= stage3) {
         throw new Error(
           `Invalid compaction config: stage2 (${stage2}) must be less than stage3 (${stage3}). ` +
           `Check EMBER_COMPACTION_STAGE2 and EMBER_COMPACTION_STAGE3 environment variables.`
         );
       }
     }
     assertCompactionStageOrder(CONFIG);
     ```
  2. Also validate that `toolLoop.defaultLimit <= toolLoop.maxLimit` and `terminal.defaultTimeoutMs <= terminal.maxTimeoutMs`.
- [ ] **Test:** Add to `apps/server/src/config.test.ts`:
  - Set `EMBER_COMPACTION_STAGE1=0.80` and `EMBER_COMPACTION_STAGE2=0.60` → throws
  - Set valid ascending values → passes
  - Default values pass validation

---

### 1.3 — Add Concurrent Write Protection to Memory Store ✅ (ALREADY IMPLEMENTED)

- [x] **File:** `packages/core/src/memory/store.ts:49-53`
- [ ] **Bug:** `writeMemoryStoreData()` calls `writeJson()` directly with no file locking or atomic writes. When multiple roles run parallel tasks and save memory simultaneously, a race condition can corrupt the JSON file.
- [ ] **How to fix:**
  1. Implement atomic writes using a write-to-temp-then-rename pattern in `packages/core/src/store.ts`:
     ```typescript
     export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
       const tmpPath = `${filePath}.${Date.now()}.tmp`;
       await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
       await rename(tmpPath, filePath);
     }
     ```
  2. Add a per-file write lock using a simple async mutex:
     ```typescript
     const writeLocks = new Map<string, Promise<void>>();

     export async function writeJsonSafe(filePath: string, data: unknown): Promise<void> {
       const existing = writeLocks.get(filePath) ?? Promise.resolve();
       const next = existing.then(() => writeJsonAtomic(filePath, data)).finally(() => {
         if (writeLocks.get(filePath) === next) writeLocks.delete(filePath);
       });
       writeLocks.set(filePath, next);
       return next;
     }
     ```
  3. Update `writeJson()` calls in `store.ts` and `memory/store.ts` to use `writeJsonSafe()`.
  4. For the SQLite backend (`SqliteMemoryRepository`), this is already handled by SQLite's WAL mode — verify WAL is enabled.
- [ ] **Test:** Add to `packages/core/src/store.test.ts`:
  - Fire 10 concurrent writes to the same file → all data preserved, no corruption
  - Verify temp files are cleaned up after write

---

### 1.4 — Wrap All JSON.parse() Calls in Error Handling ✅ (ALREADY IMPLEMENTED)

- [x] **Files:** `apps/server/src/index.ts` (multiple locations), `packages/connectors/src/drivers.ts`
- [ ] **Bug:** Direct `JSON.parse()` calls on LLM provider responses without try-catch. Malformed responses cause unhandled promise rejections that crash the server.
- [ ] **How to fix:**
  1. Create a utility function in `apps/server/src/index.ts` or a shared utils file:
     ```typescript
     function safeJsonParse<T = unknown>(text: string, fallback: T): T {
       try {
         return JSON.parse(text) as T;
       } catch {
         return fallback;
       }
     }
     ```
  2. Search for all `JSON.parse()` calls in `apps/server/src/index.ts` and `packages/connectors/src/drivers.ts`. Replace raw `JSON.parse(text)` with `safeJsonParse(text, defaultValue)` where the default makes sense for the context (e.g., `null` for dispatch decisions, `{}` for tool arguments).
  3. Where parse failures should trigger a specific error path (e.g., provider dispatch), wrap in try-catch and return a typed error:
     ```typescript
     let decision: DispatchDecision;
     try {
       decision = JSON.parse(rawResponse);
     } catch {
       decision = { role: currentRole, reason: "Failed to parse dispatch response" };
     }
     ```
- [ ] **Test:** Add test cases for malformed JSON responses in routing and provider tests.

---

### 1.5 — Replace Synchronous File Operations in Checkpoints ✅

- [x] **File:** `apps/server/src/checkpoints.ts`
- [ ] **Bug:** Uses `writeFileSync` for checkpoint persistence. Large checkpoint files (many file mutation snapshots) block the Node.js event loop for potentially seconds, stalling all concurrent requests.
- [ ] **How to fix:**
  1. Replace all `writeFileSync` with `await writeFile` (from `node:fs/promises`).
  2. Replace all `readFileSync` with `await readFile`.
  3. Replace `mkdirSync` with `await mkdir`.
  4. Replace `rmSync` with `await rm`.
  5. Update all calling functions to be async if not already.
  6. For the `createFileMutationCheckpoint()` function used by `files.ts`, ensure the async version is awaited in the tool handler.
- [ ] **Integration:** The `files.ts` tools call `createFileMutationCheckpoint()` — their handlers are already async so just add `await`.

---

### 1.6 — Fix Attention Context Memory Leak and Persistence ✅

- [x] **File:** `apps/server/src/attention.ts:12`
- [ ] **Bug:** `ATTENTION_CONTEXTS` is a purely in-memory Map capped at 500 entries but never persisted. On server restart, all goal tracking, completed steps, blockers, and working memory are lost. For a "brain-like" framework, this is like amnesia on every restart.
- [ ] **How to fix:**
  1. Add periodic serialization of attention contexts to a JSON file:
     ```typescript
     const ATTENTION_PERSISTENCE_PATH = path.join(getDataRoot(), "attention-contexts.json");
     const PERSIST_INTERVAL_MS = 30_000; // every 30 seconds

     export async function persistAttentionContexts(): Promise<void> {
       const entries = Object.fromEntries(ATTENTION_CONTEXTS.entries());
       await writeJsonSafe(ATTENTION_PERSISTENCE_PATH, entries);
     }

     export async function restoreAttentionContexts(): Promise<void> {
       try {
         const data = await readJsonFile<Record<string, AttentionContext>>(ATTENTION_PERSISTENCE_PATH, {});
         for (const [key, value] of Object.entries(data)) {
           ATTENTION_CONTEXTS.set(key, value);
         }
       } catch {
         // First boot or corrupted file — start fresh
       }
     }
     ```
  2. Call `restoreAttentionContexts()` during server startup in `index.ts`.
  3. Call `persistAttentionContexts()` on a `setInterval` and also during graceful shutdown.
  4. Add a `clearAttentionContext(key: string)` export for manual cleanup.
- [ ] **Test:** Add to `apps/server/src/attention.test.ts`:
  - Create contexts, persist, clear Map, restore → contexts recovered
  - Verify pruning still works after restore

---

## PHASE 2: STATE PERSISTENCE

Nearly all runtime state is in-memory. A single restart wipes failover intelligence, idempotency protection, and terminal approvals. This phase makes Ember stateful across restarts.

---

### 2.1 — Persist Failover and Circuit Breaker State ✅

- [x] **File:** `apps/server/src/failover.ts:67-81`
- [ ] **Problem:** All failover events, circuit breaker states, and cause counts are module-level variables. A restart wipes them, so Ember may immediately route to a known-broken provider.
- [ ] **How to fix:**
  1. Create a `FailoverStateStore` that serializes to a JSON file at `getDataRoot()/failover-state.json`:
     ```typescript
     interface PersistedFailoverState {
       circuitBreakers: Record<string, {
         failures: number;
         lastFailure: number;
         state: CircuitBreakerStatus;
         openedAt: number;
       }>;
       recentEvents: FailoverEvent[];  // last MAX_FAILOVER_EVENT_HISTORY events
       causeCounts: Record<FailoverCause, number>;
       savedAt: string;
     }
     ```
  2. Save state after every circuit breaker transition (not every event — that's too frequent).
  3. Load state on server startup, hydrating the in-memory maps.
  4. Add a staleness check: if `savedAt` is older than `CIRCUIT_BREAKER_RESET_MS * 2`, reset all breakers to closed (stale data is worse than no data).
  5. Export `persistFailoverState()` and `restoreFailoverState()`.
- [ ] **Integration:** Call `restoreFailoverState()` during startup in `index.ts`. Call `persistFailoverState()` inside `recordCircuitBreakerTransition()`.
- [ ] **Test:** Add to `apps/server/src/failover.test.ts`:
  - Trip a circuit breaker, persist, clear, restore → breaker still open
  - Stale state (2x reset period) → breaker reset to closed

---

### 2.2 — Persist Idempotency Store ✅

- [x] **File:** `apps/server/src/security.ts:29-36`
- [ ] **Problem:** Idempotency entries are in-memory. Server restart allows duplicate mutations.
- [ ] **How to fix:**
  1. On completed requests, persist the idempotency key + fingerprint + response to a SQLite table (reuse the store's SQLite infrastructure) or a JSON file.
  2. On startup, load entries that haven't expired (`expiresAt > Date.now()`).
  3. Keep the in-memory Map as a hot cache, backed by the persistent store.
  4. Prune expired entries from the persistent store on a `setInterval`.
- [ ] **Integration:** This is self-contained within `security.ts`. No other files need changes.

---

### 2.3 — Persist Terminal Approval State ✅

- [x] **File:** `apps/server/src/tools/terminal.ts`
- [ ] **Problem:** The `APPROVAL_SECRET` is regenerated via `randomBytes(32)` on every server restart. All previously approved terminal commands become invalid.
- [ ] **How to fix:**
  1. Store the approval secret in the encrypted data store (`packages/core/src/store.ts`) using the existing credential vault infrastructure.
  2. On startup, read the stored secret. If none exists, generate one and persist it.
  3. Also persist the approval state (approved command patterns + TTLs) so they survive restarts.
     ```typescript
     async function getOrCreateApprovalSecret(): Promise<Buffer> {
       const stored = await readEncryptedValue("terminal-approval-secret");
       if (stored) return Buffer.from(stored, "hex");
       const secret = randomBytes(32);
       await writeEncryptedValue("terminal-approval-secret", secret.toString("hex"));
       return secret;
     }
     ```
- [ ] **Integration:** The `APPROVAL_SECRET` is used in `generateApprovalId()` and `verifyApprovalId()`. Make both async or cache the secret after first load.

---

## PHASE 3: SMALL MODEL EFFICIENCY

This is Ember's biggest competitive gap and the stated goal. Nothing in the codebase currently adapts to small models. Hermes doesn't do this either — this is where Ember can differentiate.

---

### 3.1 — Create Model Capability Profile System ✅

- [x] **File:** `apps/server/src/model-routing.ts` (integrated into existing file)
- [ ] **Problem:** The routing system treats all models as equal. A 0.8B local model gets the same bloated system prompt as Claude Opus 4.6. Small models choke on long prompts, complex tool schemas, and multi-step instructions.
- [ ] **How to fix:**
  1. Define a capability profile:
     ```typescript
     export interface ModelCapabilityProfile {
       /** Effective context window in tokens */
       contextWindow: number;
       /** 0-1 score: how well does this model follow complex instructions? */
       instructionFollowing: number;
       /** 0-1 score: how well does this model use tools/function calling? */
       toolUseQuality: number;
       /** 0-1 score: reasoning and multi-step planning ability */
       reasoningDepth: number;
       /** Maximum number of tools the model can handle effectively */
       maxEffectiveTools: number;
       /** Can this model handle structured JSON output reliably? */
       reliableJsonOutput: boolean;
       /** Model size tier for prompt adaptation */
       tier: "tiny" | "small" | "medium" | "large" | "frontier";
     }
     ```
  2. Build a detection function that infers the profile from model ID strings:
     ```typescript
     export function inferModelCapabilities(modelId: string, contextWindow?: number): ModelCapabilityProfile {
       const id = modelId.toLowerCase();
       // Frontier models
       if (/claude-.*opus|gpt-4o|gemini-.*ultra/i.test(id)) {
         return { tier: "frontier", contextWindow: contextWindow ?? 200000, instructionFollowing: 0.95, toolUseQuality: 0.95, reasoningDepth: 0.95, maxEffectiveTools: 40, reliableJsonOutput: true };
       }
       // Large models
       if (/claude-.*sonnet|gpt-4|gemini-.*pro/i.test(id)) {
         return { tier: "large", contextWindow: contextWindow ?? 128000, instructionFollowing: 0.85, toolUseQuality: 0.85, reasoningDepth: 0.80, maxEffectiveTools: 30, reliableJsonOutput: true };
       }
       // Medium models
       if (/claude-.*haiku|gpt-3\.5|gemini-.*flash|llama.*70b|qwen.*72b/i.test(id)) {
         return { tier: "medium", contextWindow: contextWindow ?? 32000, instructionFollowing: 0.70, toolUseQuality: 0.70, reasoningDepth: 0.60, maxEffectiveTools: 15, reliableJsonOutput: true };
       }
       // Small models
       if (/llama.*8b|mistral.*7b|qwen.*7b|phi.*3|gemma.*9b/i.test(id)) {
         return { tier: "small", contextWindow: contextWindow ?? 8000, instructionFollowing: 0.50, toolUseQuality: 0.40, reasoningDepth: 0.35, maxEffectiveTools: 8, reliableJsonOutput: false };
       }
       // Tiny models (0.5B-3B)
       if (/llama.*1b|llama.*3b|qwen.*0\.5b|qwen.*1\.5b|phi.*mini|smollm|tinyllama/i.test(id)) {
         return { tier: "tiny", contextWindow: contextWindow ?? 4000, instructionFollowing: 0.25, toolUseQuality: 0.15, reasoningDepth: 0.15, maxEffectiveTools: 3, reliableJsonOutput: false };
       }
       // Default: assume medium
       return { tier: "medium", contextWindow: contextWindow ?? 16000, instructionFollowing: 0.65, toolUseQuality: 0.60, reasoningDepth: 0.55, maxEffectiveTools: 12, reliableJsonOutput: true };
     }
     ```
  3. Allow overrides via settings: `settings.modelCapabilities[modelId] = { ... partial overrides ... }`.
  4. Export a `getModelCapabilities(modelId: string, provider: Provider): ModelCapabilityProfile` that checks overrides first, then infers.
- [ ] **Integration:** This becomes the foundation for Phases 3.2-3.5.

---

### 3.2 — Adaptive Prompt Budget System ✅

- [x] **File:** `apps/server/src/prompt-budget.ts` (new) and `apps/server/src/orchestration-prompt.ts`
- [ ] **Problem:** System prompts are built the same way regardless of model size. For an 8K context model, the prompt alone could consume 60-80% of the window, leaving almost nothing for conversation and tools.
- [ ] **How to fix:**
  1. Define budget allocation:
     ```typescript
     export interface PromptBudget {
       totalTokens: number;        // model's context window
       systemPromptTokens: number; // max for system prompt (typically 20-40% of total)
       toolSchemaTokens: number;   // max for tool definitions
       memoryTokens: number;       // max for memory context
       conversationTokens: number; // remaining for conversation history
       responseTokens: number;     // reserved for model output
     }

     export function calculatePromptBudget(profile: ModelCapabilityProfile): PromptBudget {
       const total = profile.contextWindow;
       const response = Math.min(4096, Math.floor(total * 0.2));
       const available = total - response;

       if (profile.tier === "tiny") {
         return {
           totalTokens: total,
           systemPromptTokens: Math.floor(available * 0.15), // minimal prompt
           toolSchemaTokens: Math.floor(available * 0.10),    // very few tools
           memoryTokens: Math.floor(available * 0.05),        // almost no memory
           conversationTokens: Math.floor(available * 0.50),  // maximize conversation
           responseTokens: response,
         };
       }
       if (profile.tier === "small") {
         return {
           totalTokens: total,
           systemPromptTokens: Math.floor(available * 0.20),
           toolSchemaTokens: Math.floor(available * 0.15),
           memoryTokens: Math.floor(available * 0.10),
           conversationTokens: Math.floor(available * 0.35),
           responseTokens: response,
         };
       }
       // medium/large/frontier get standard allocation
       return {
         totalTokens: total,
         systemPromptTokens: Math.floor(available * 0.25),
         toolSchemaTokens: Math.floor(available * 0.15),
         memoryTokens: Math.floor(available * 0.15),
         conversationTokens: Math.floor(available * 0.25),
         responseTokens: response,
       };
     }
     ```
  2. In `orchestration-prompt.ts`, use the budget to truncate sections:
     - If system prompt exceeds budget, strip metacognition section first, then attention context, then procedure context, then trim role-specific instructions.
     - If memory context exceeds budget, reduce `maxItems` in the memory query.
     - If tool schemas exceed budget, reduce tool count (see 3.3).
- [ ] **Integration:** The budget is calculated once per request using the resolved model's capabilities. It flows into prompt building and tool filtering.

---

### 3.3 — Tool Filtering by Model Capability ✅

- [x] **File:** `apps/server/src/tools/index.ts`
- [ ] **Problem:** Every model gets every tool. Small models receiving 30+ tool definitions perform poorly — they hallucinate tool calls, pick wrong tools, or stall.
- [ ] **How to fix:**
  1. Add a tool priority system. Each tool gets a `priority` field (1-10, where 1 is essential):
     ```typescript
     // Priority 1: Essential (always included)
     // handoff, read_file, write_file, terminal_execute

     // Priority 2: Core workflow
     // edit_file, list_directory, search_files, memory_save, memory_search

     // Priority 3: Extended capabilities
     // web_search, fetch_page, git_inspect, http_request

     // Priority 4: Advanced features
     // launch_parallel_tasks, swarm_simulate, session_recall

     // Priority 5: Specialized
     // ssh_execute, credential_vault, mcp_manage, tool_maker
     ```
  2. Filter tools based on `maxEffectiveTools` from the capability profile:
     ```typescript
     export function filterToolsForModel(
       tools: EmberTool[],
       profile: ModelCapabilityProfile,
     ): EmberTool[] {
       const sorted = [...tools].sort((a, b) => a.priority - b.priority);
       return sorted.slice(0, profile.maxEffectiveTools);
     }
     ```
  3. For `reliableJsonOutput === false` models, simplify tool input schemas — remove optional properties, flatten nested objects.
- [ ] **Integration:** Called in `getExecutionToolsForRole()` after role-based filtering.

---

### 3.4 — Simplified Instruction Templates for Small Models ✅ (ALREADY IMPLEMENTED)

- [x] **Files:** `packages/prompts/src/coordinator.ts`, `advisor.ts`, `director.ts`, `inspector.ts`, `ops.ts`, `dispatch.ts`
- [ ] **Problem:** Role prompts use sophisticated multi-paragraph instructions. Small models need shorter, more direct instructions — bullet points instead of prose, explicit examples instead of abstract rules.
- [ ] **How to fix:**
  1. Add a `buildCompactPrompt(role: Role): string` function for each role that returns a drastically shortened version (under 500 tokens).
  2. Example for coordinator:
     ```typescript
     export function buildCompactCoordinatorPrompt(): string {
       return `You are a coordinator. Your job:
     - Understand the user's request
     - Use tools to gather information
     - If the task is complex, use handoff to send it to the right specialist
     - Specialists: advisor (planning), director (coding), inspector (review), ops (cleanup)
     - Always respond concisely`;
     }
     ```
  3. In `orchestration-prompt.ts`, select compact vs. full prompt based on model tier:
     ```typescript
     const rolePrompt = profile.tier === "tiny" || profile.tier === "small"
       ? buildCompactPrompt(role)
       : buildFullPrompt(role, ...);
     ```
- [ ] **Integration:** This is called from `orchestration-prompt.ts` during prompt stack assembly.

---

### 3.5 — Skip Metacognition for Small Models ✅

- [x] **File:** `apps/server/src/orchestration-prompt.ts` and `apps/server/src/index.ts`
- [ ] **Problem:** Metacognition adds thinking plans, complexity scores, and past outcome analysis to the prompt. This is valuable for frontier models but wastes precious context on small models that can't use it.
- [ ] **How to fix:**
  1. In `metacognition.ts`, the `buildMetacognitivePromptSection()` already skips for `reflexive` tier. Extend this to also skip when model tier is `"tiny"` or `"small"`:
     ```typescript
     export function buildMetacognitivePromptSection(
       assessment: TaskAssessment,
       profile: CognitiveProfile,
       role?: string,
       modelTier?: "tiny" | "small" | "medium" | "large" | "frontier",
     ): string {
       if (profile.tier === "reflexive") return "";
       if (modelTier === "tiny" || modelTier === "small") return "";
       // ... existing logic
     }
     ```
  2. Similarly skip attention context (`buildAttentionPromptSection`) and procedure context for tiny/small models.
  3. Skip simulation recommendations for models below `medium` tier.
- [ ] **Integration:** Pass `modelTier` from the resolved capability profile into the prompt builder.

---

## PHASE 4: ERROR RECOVERY & RESILIENCE

Ember currently has no retry logic for transient failures and no self-healing capabilities. Hermes Agent does this better — we need to match and exceed them.

---

### 4.1 — MCP Server Retry with Exponential Backoff ✅

- [x] **File:** `apps/server/src/mcp/mcp-client-manager.ts`
- [ ] **Problem:** If an MCP server fails to start (transient DNS failure, slow npm install, race condition), it's permanently disabled. Hermes retries up to 5 times with exponential backoff.
- [ ] **How to fix:**
  1. Add a retry wrapper:
     ```typescript
     const MAX_MCP_RETRIES = 3;
     const MCP_RETRY_BASE_MS = 2000;

     async function connectWithRetry(
       serverId: string,
       config: McpServerConfig,
     ): Promise<McpClient | null> {
       for (let attempt = 0; attempt <= MAX_MCP_RETRIES; attempt++) {
         try {
           const client = await connectMcpServer(serverId, config);
           return client;
         } catch (error) {
           if (attempt === MAX_MCP_RETRIES) {
             console.error(`[mcp] ${serverId}: Failed after ${MAX_MCP_RETRIES + 1} attempts:`, error);
             return null;
           }
           const delay = MCP_RETRY_BASE_MS * Math.pow(2, attempt);
           console.warn(`[mcp] ${serverId}: Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
           await new Promise(resolve => setTimeout(resolve, delay));
         }
       }
       return null;
     }
     ```
  2. Replace the direct connection call in `initializeMcpServers()` with `connectWithRetry()`.
  3. Add a `reconnectMcpServer(serverId: string)` export for manual retry from the API.
  4. Make retry count and base delay configurable via `CONFIG.mcp.maxRetries` and `CONFIG.mcp.retryBaseMs`.
- [ ] **Integration:** The existing `POST /api/mcp/reload` endpoint should use the same retry logic.

---

### 4.2 — Dangerous Command Detection Library ✅

- [x] **File:** `apps/server/src/tools/terminal.ts`
- [ ] **Problem:** Terminal safety relies only on a sudo approval flow with TTL. There's no pattern-based detection of dangerous commands like Hermes Agent's 40+ regex patterns.
- [ ] **How to fix:**
  1. Add a `DANGEROUS_COMMAND_PATTERNS` constant:
     ```typescript
     const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string; severity: "warn" | "block" }> = [
       { pattern: /\brm\s+(-[a-z]*r[a-z]*\s+|.*-rf\s)/i, reason: "Recursive deletion", severity: "block" },
       { pattern: /\brm\s+(-[a-z]*f[a-z]*\s)/i, reason: "Forced deletion", severity: "warn" },
       { pattern: /\bchmod\s+777\b/, reason: "World-writable permissions", severity: "block" },
       { pattern: /\bchown\s+-R\s+root\b/, reason: "Recursive ownership change to root", severity: "block" },
       { pattern: /\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i, reason: "Destructive SQL operation", severity: "block" },
       { pattern: /\bmkfs\b/, reason: "Filesystem format", severity: "block" },
       { pattern: /\bdd\s+.*of=\/dev\//i, reason: "Direct disk write", severity: "block" },
       { pattern: />\s*\/dev\/(sd|hd|nvme)/i, reason: "Direct disk write via redirect", severity: "block" },
       { pattern: /\bcurl\s+.*\|\s*(sudo\s+)?bash\b/i, reason: "Piped remote execution", severity: "block" },
       { pattern: /\bwget\s+.*\|\s*(sudo\s+)?bash\b/i, reason: "Piped remote execution", severity: "block" },
       { pattern: /\b:(){ :|:& };:/i, reason: "Fork bomb", severity: "block" },
       { pattern: /\bgit\s+push\s+.*--force\b/i, reason: "Force push", severity: "warn" },
       { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Hard reset", severity: "warn" },
       { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: "Git clean with force", severity: "warn" },
       { pattern: /\bkill\s+-9\s+-1\b/, reason: "Kill all processes", severity: "block" },
       { pattern: /\bshutdown\b|\breboot\b|\binit\s+[06]\b/i, reason: "System shutdown/reboot", severity: "block" },
       { pattern: /\biptables\s+-F\b/i, reason: "Firewall flush", severity: "block" },
       { pattern: /\bufw\s+disable\b/i, reason: "Firewall disable", severity: "block" },
       { pattern: /\bnpm\s+publish\b/i, reason: "Package publish", severity: "warn" },
       { pattern: /\bdocker\s+system\s+prune\s+-a/i, reason: "Docker full prune", severity: "warn" },
     ];
     ```
  2. Add a `classifyCommand(command: string): { safe: boolean; warnings: string[]; blocked: string[] }` function.
  3. Call it before executing any terminal command. If any `"block"` patterns match, require explicit approval (using the existing approval flow). If `"warn"` patterns match, log to audit trail and proceed but include warning in tool result.
  4. Allow a per-workspace allowlist in settings: `settings.terminal.allowedPatterns`.
- [ ] **Test:** Add comprehensive tests for each pattern category.

---

### 4.3 — Structured Reflection Loops ✅

- [x] **File:** `apps/server/src/reflection.ts` (new)
- [ ] **Problem:** Ember's metacognition detects "stuck" states but can only inject prompt hints. It has no actual reflection loop — where the agent reviews its own output, critiques it, and revises. MiroFish's ReACT with section-by-section reflection is superior here.
- [ ] **How to fix:**
  1. Add a reflection step that runs after the main tool loop completes (before returning to the user):
     ```typescript
     export interface ReflectionConfig {
       enabled: boolean;
       maxReflectionRounds: number;  // default 1
       triggerOnComplexity: number;  // minimum complexity score to trigger (default 0.6)
       triggerOnToolErrors: number;  // minimum error count to trigger (default 2)
     }

     export interface ReflectionResult {
       revised: boolean;
       originalResponse: string;
       revisedResponse: string | null;
       reflectionNotes: string[];
     }

     export async function reflectOnResponse(options: {
       response: string;
       assessment: TaskAssessment;
       monitor: ExecutionMonitorState;
       conversation: ChatMessage[];
       config: ReflectionConfig;
       executeReflection: (prompt: string) => Promise<string>;
     }): Promise<ReflectionResult> {
       // Only reflect for complex/high-stakes tasks or tasks with errors
       if (options.assessment.complexity < options.config.triggerOnComplexity &&
           options.monitor.errorCount < options.config.triggerOnToolErrors) {
         return { revised: false, originalResponse: options.response, revisedResponse: null, reflectionNotes: [] };
       }

       const reflectionPrompt = buildReflectionPrompt(options.response, options.assessment);
       const reflection = await options.executeReflection(reflectionPrompt);
       // Parse reflection for revision suggestions
       // If revision recommended, return revised response
     }
     ```
  2. Integrate into the tool loop in `index.ts` — after the final assistant message is generated but before it's saved.
  3. Only use reflection for `"deliberate"` and `"deep"` cognitive tiers.
  4. For small models, never trigger reflection (they can't self-critique effectively).
- [ ] **Integration:** Opt-in via `settings.agent.reflection.enabled`. Default off for now. The reflection call uses the same provider as the main response.

---

## PHASE 5: ADVANCED MEMORY

Ember's memory system has the infrastructure for graph edges but doesn't use them for retrieval. This phase activates the graph and adds features both competitors lack.

---

### 5.1 — Activate Graph Memory for Retrieval ✅

- [x] **File:** `packages/core/src/memory/scoring.ts` (new functions: `applyGraphBoost`, `scoreMemoryItemsWithGraph`)
- [ ] **Problem:** Memory edges exist (`MemoryEdge` type, `addEdge`, `listEdges`) but are never used during memory search/scoring. The memory system is effectively flat key-value despite having graph infrastructure.
- [ ] **How to fix:**
  1. In `scoring.ts`, add graph-aware scoring:
     ```typescript
     export function scoreWithGraphContext(
       items: MemoryItem[],
       edges: MemoryEdge[],
       query: MemorySearchQuery,
     ): ScoredMemoryItem[] {
       const baseScores = scoreMemoryItems(items, query);

       // Build adjacency map
       const adjacency = new Map<string, Set<string>>();
       for (const edge of edges) {
         if (!adjacency.has(edge.sourceId)) adjacency.set(edge.sourceId, new Set());
         if (!adjacency.has(edge.targetId)) adjacency.set(edge.targetId, new Set());
         adjacency.get(edge.sourceId)!.add(edge.targetId);
         adjacency.get(edge.targetId)!.add(edge.sourceId);
       }

       // Boost items that are connected to high-scoring items
       for (const scored of baseScores) {
         const neighbors = adjacency.get(scored.item.id);
         if (!neighbors) continue;
         const neighborScores = baseScores
           .filter(s => neighbors.has(s.item.id))
           .map(s => s.score);
         if (neighborScores.length > 0) {
           const avgNeighborScore = neighborScores.reduce((a, b) => a + b, 0) / neighborScores.length;
           scored.score += avgNeighborScore * 0.3; // 30% graph boost
         }
       }

       return baseScores.sort((a, b) => b.score - a.score);
     }
     ```
  2. Use `scoreWithGraphContext` in `buildMemoryPromptContext` when edges are available.
  3. Add automatic edge creation: when the agent saves a memory item that references another item's content (detected via TF-IDF similarity), create a "related-to" edge.
- [ ] **Integration:** The existing `MemoryRepository` interface already has `addEdge` and `listEdges`. This just needs to be wired into the scoring pipeline.

---

### 5.2 — Memory TTL and Eviction Policy ✅ (PARTIALLY — TTL filtering exists, cleanup sweep needed)

- [x] **File:** `packages/core/src/memory/store.ts`, `packages/core/src/memory/scoring.ts`
- [ ] **Problem:** App memory has CRUD operations but no TTL or eviction policy. Items accumulate forever. No automatic cleanup of stale memories.
- [ ] **How to fix:**
  1. Add optional TTL to memory items:
     ```typescript
     interface MemoryItem {
       // ... existing fields
       expiresAt?: string | null;  // ISO date string, null = never expires
     }
     ```
  2. Add eviction logic to memory reads:
     ```typescript
     function filterExpiredItems(items: MemoryItem[]): MemoryItem[] {
       const now = Date.now();
       return items.filter(item => {
         if (!item.expiresAt) return true;
         return new Date(item.expiresAt).getTime() > now;
       });
     }
     ```
  3. Add a periodic cleanup sweep (runs during memory consolidation) that removes expired items.
  4. Add capacity limits per scope: if a scope exceeds N items, retire the lowest-scored items.
  5. Expose TTL in the `memory_save` tool's schema so the agent can set expiry.
- [ ] **Integration:** TTL filtering should happen during `readMemoryStoreData()` and during memory query.

---

### 5.3 — Frozen Memory Snapshots for Prompt Caching ✅

- [x] **File:** `apps/server/src/index.ts` (memory loading section)
- [ ] **Problem:** Memory is loaded fresh on every tool loop iteration, which invalidates Anthropic's prompt cache. Hermes Agent solves this with "frozen snapshots" — memory is loaded once at session start and not updated until the next session.
- [ ] **How to fix:**
  1. At the start of a chat request, load memory and freeze it:
     ```typescript
     const frozenMemory = await buildMemoryPromptContext(memoryRepo, {
       sessionId: conversationId,
       role: activeRole,
       // ... existing params
     });
     // Store in request context — reuse for all tool loop iterations
     ```
  2. The frozen memory is used for the system prompt throughout the request. Tool results from `memory_save` and `memory_search` still show live data (they read from the store directly), but the system prompt doesn't change.
  3. This preserves Anthropic's prompt cache (the system prompt stays identical across turns).
  4. On the NEXT request for the same conversation, reload fresh memory.
- [ ] **Integration:** Modify the tool loop in `index.ts` to pass `frozenMemory` instead of rebuilding memory context each iteration.

---

## PHASE 6: TOOL SYSTEM IMPROVEMENTS

---

### 6.1 — Dynamic Tool Plugin Interface ✅

- [x] **File:** `apps/server/src/tools/plugin-loader.ts` (new), `apps/server/src/tools/index.ts`, `apps/server/src/index.ts`
- [ ] **Problem:** Tools are statically imported and manually registered. Adding a new tool requires editing `tools/index.ts`. Hermes Agent uses self-registering decorators which is more modular.
- [ ] **How to fix:**
  1. Add a tool plugin loader that scans a directory for tool definitions:
     ```typescript
     export interface EmberToolPlugin {
       name: string;
       version: string;
       tools: EmberTool[];
       initialize?: () => Promise<void>;
       cleanup?: () => Promise<void>;
     }

     const PLUGIN_DIR = path.join(getDataRoot(), "plugins");

     export async function loadToolPlugins(): Promise<EmberToolPlugin[]> {
       // Scan PLUGIN_DIR for .js files that export EmberToolPlugin
       // Each plugin is dynamically imported
       // Validate tool schemas before registration
     }
     ```
  2. Add `POST /api/plugins/install` and `DELETE /api/plugins/:id` API endpoints.
  3. Plugins are loaded at server startup and can be reloaded via `POST /api/plugins/reload`.
  4. Each plugin's tools are added to the tool registry with a namespace prefix (e.g., `plugin:tool_name`).
- [ ] **Integration:** The existing tool filtering in `getExecutionToolsForRole()` should also apply to plugin tools.

---

### 6.2 — Code Execution Sandbox ✅

- [x] **File:** `apps/server/src/tools/code-sandbox.ts` (new), `apps/server/src/tools/index.ts`
- [ ] **Problem:** Ember has no way to safely run untrusted code. Hermes Agent has a Python sandbox with tool-call allowlists. This is critical for agentic workflows that need to test code.
- [ ] **How to fix:**
  1. Add a `execute_code` tool that runs code in an isolated environment:
     ```typescript
     const codeSandboxTool: EmberTool = {
       name: "execute_code",
       description: "Execute code in a sandboxed environment. Supports JavaScript/TypeScript. Output is captured.",
       priority: 3,
       inputSchema: {
         type: "object",
         properties: {
           language: { type: "string", enum: ["javascript", "typescript", "python"] },
           code: { type: "string", description: "The code to execute" },
           timeout_ms: { type: "number", description: "Execution timeout in ms (default 10000, max 30000)" },
         },
         required: ["language", "code"],
       },
       execute: async (args) => { /* ... */ },
     };
     ```
  2. Implementation options (in order of preference):
     - **Node.js `vm` module** with restricted context for JavaScript (no `require`, no `process`, no `fs`)
     - **Docker container** if available (spawn disposable container, copy code, execute, capture output)
     - **Worker thread** with `--no-experimental-network` and restricted imports
  3. Hard limits: 30s timeout, 256MB memory, no network access, no filesystem access.
  4. Capture stdout, stderr, and return value.
- [ ] **Integration:** Added to tool registry with priority 3. Available to `director` and `inspector` roles.

---

## PHASE 7: OBSERVABILITY & MONITORING

---

### 7.1 — Per-Conversation Token Cost Tracking ✅

- [x] **File:** `packages/core/src/types.ts` (ConversationUsage), `apps/server/src/index.ts`
- [ ] **Problem:** Token usage is reported per-message but not aggregated per-conversation or per-session. Users can't see how much a conversation costs.
- [ ] **How to fix:**
  1. Add cumulative usage tracking to the `Conversation` type:
     ```typescript
     interface Conversation {
       // ... existing fields
       usage?: {
         totalInputTokens: number;
         totalOutputTokens: number;
         messageCount: number;
         toolCallCount: number;
         providerUsage: Record<string, { inputTokens: number; outputTokens: number }>;
       };
     }
     ```
  2. After each chat response, update the cumulative counters.
  3. Expose via `GET /api/conversations/:id` response.
  4. Add a summary to the UI.
- [ ] **Integration:** Updated during `persistConversationFromResult()`.

---

### 7.2 — Structured Logging with Request Tracing ✅

- [x] **File:** `apps/server/src/logger.ts`
- [ ] **Problem:** Logging uses scattered `console.log` and `console.warn` calls. No request IDs, no structured format, no correlation between related log entries.
- [ ] **How to fix:**
  1. Ensure all log entries include:
     - `requestId` (UUID generated at request start)
     - `conversationId`
     - `role` (active role)
     - `timestamp` (ISO 8601)
     - `level` (debug/info/warn/error)
     - `component` (routing/tool/memory/mcp/etc.)
  2. Replace all `console.log/warn/error` in `index.ts` with structured logger calls.
  3. Add a `GET /api/logs/stream` SSE endpoint for real-time log monitoring.
  4. Use Fastify's built-in request logging hook to automatically attach `requestId`.
- [ ] **Integration:** The existing `systemLogger` in `logger.ts` should be enhanced, not replaced.

---

### 7.3 — Audit Log Timestamp-Based Rotation ✅

- [x] **File:** `apps/server/src/audit-log.ts`
- [ ] **Problem:** Only size-based rotation. No daily/weekly rotation means compliance audits can't easily pull logs by date range.
- [ ] **How to fix:**
  1. Add date-based log file naming: `audit-YYYY-MM-DD.jsonl`
  2. On each write, check if the current date has changed. If so, close the current file and open a new one.
  3. Keep the existing size-based rotation as a secondary check within a single day.
  4. Add a `maxAgeDays` config option to auto-delete logs older than N days (default 90).
- [ ] **Integration:** Self-contained in `audit-log.ts`. No other files need changes.

---

## PHASE 8: PLATFORM & DEPLOYMENT

---

### 8.1 — Process Isolation for Parallel Tasks ✅

- [x] **File:** `apps/server/src/parallel-tasks.ts` (memory guard + abort controller)
- [ ] **Problem:** Parallel tasks run in the same Node.js process. A misbehaving tool (infinite loop, memory leak) affects all concurrent requests. Hermes uses subprocess isolation. MiroFish uses IPC.
- [ ] **How to fix:**
  1. For parallel task execution, spawn a worker thread per task:
     ```typescript
     import { Worker } from "node:worker_threads";

     async function executeParallelTaskIsolated(
       task: ParallelSubtaskInput,
       context: ParallelTaskContext,
     ): Promise<ParallelTaskOutcome> {
       return new Promise((resolve, reject) => {
         const worker = new Worker("./parallel-task-worker.js", {
           workerData: { task, context },
           resourceLimits: {
             maxOldGenerationSizeMb: 256,
             maxYoungGenerationSizeMb: 64,
           },
         });

         const timeout = setTimeout(() => {
           worker.terminate();
           reject(new Error(`Parallel task timed out after ${context.timeoutMs}ms`));
         }, context.timeoutMs);

         worker.on("message", (result) => {
           clearTimeout(timeout);
           resolve(result);
         });

         worker.on("error", (error) => {
           clearTimeout(timeout);
           reject(error);
         });
       });
     }
     ```
  2. Create `apps/server/src/parallel-task-worker.ts` that:
     - Receives task and context via `workerData`
     - Executes the tool loop in isolation
     - Sends result back via `parentPort.postMessage()`
  3. Falls back to in-process execution if worker creation fails.
- [ ] **Integration:** Replace the direct execution call in the parallel task handler in `index.ts`.

---

### 8.2 — Cron/Scheduling Engine ✅

- [x] **File:** `apps/server/src/scheduler.ts` (new)
- [ ] **Problem:** Ember has no way to run autonomous background tasks. Hermes Agent has a full cron engine with natural language tasks and platform delivery.
- [ ] **How to fix:**
  1. Add a job scheduler:
     ```typescript
     export interface ScheduledJob {
       id: string;
       name: string;
       schedule: string;        // cron expression ("0 9 * * 1-5")
       task: string;            // natural language task description
       mode: ChatMode;          // which role handles it
       enabled: boolean;
       lastRunAt: string | null;
       lastResult: string | null;
       createdAt: string;
     }
     ```
  2. Use a lightweight cron parser (no heavy dependency — can use `node-cron` or a simple expression parser).
  3. Jobs are stored in `getDataRoot()/scheduled-jobs.json`.
  4. A `setInterval` loop checks every minute if any jobs are due.
  5. When a job fires, it creates a new conversation with the task as the user message and executes it through the normal chat flow.
  6. Results are saved to `lastResult` and optionally pushed to a webhook URL.
  7. API endpoints:
     - `POST /api/jobs` — create job
     - `GET /api/jobs` — list jobs
     - `PATCH /api/jobs/:id` — update job
     - `DELETE /api/jobs/:id` — delete job
     - `POST /api/jobs/:id/run` — manual trigger
- [ ] **Integration:** Started during server initialization. Jobs execute through the existing chat pipeline.

---

### 8.3 — Platform Gateway Adapters ✅

- [x] **File:** `apps/server/src/gateway/` (new: types.ts, telegram.ts, index.ts)
- [ ] **Problem:** Ember only has a web UI. Hermes Agent supports Telegram, Discord, Slack, WhatsApp, Signal, and Email — letting users interact with their agent from anywhere.
- [ ] **How to fix:**
  1. Define a platform adapter interface:
     ```typescript
     export interface PlatformAdapter {
       id: string;
       name: string;
       initialize(config: Record<string, string>): Promise<void>;
       onMessage(handler: (message: IncomingMessage) => Promise<string>): void;
       sendMessage(channelId: string, content: string): Promise<void>;
       shutdown(): Promise<void>;
     }
     ```
  2. Start with Telegram (most common for personal agents):
     - Use the Telegram Bot API (HTTP polling, no webhook needed)
     - Map each Telegram chat to an Ember conversation
     - Support text, images (as attachments), and commands
  3. Add Discord as second adapter (popular for team use).
  4. Gateway is opt-in via settings: `settings.gateway.telegram.enabled`, `settings.gateway.telegram.botToken`.
  5. Each platform adapter runs as part of the server process.
- [ ] **Priority:** Lower than other phases. Implement after core improvements are solid.

---

## PHASE 9: TEST COVERAGE

Current coverage: 60% of files have tests, but only 17% of tool implementations and 32% of server features are tested. This phase fills the critical gaps.

---

### 9.1 — Critical Path Tests

- [ ] **Add tests for `prompt-budget.ts`** — affects every request. Test budget calculation for each tier, verify sections are trimmed correctly.
- [ ] **Add tests for token estimation** — calibrate against known model tokenizers. Test accuracy within 10% for English text.
- [ ] **Add tests for all tool execute() functions** — at minimum: `fetch-page`, `git-inspect`, `http-request`, `web-search`, `ssh-execute`, `credentials`, `handoff`, `mcp-manage`, `app-memory`, `agent-identity`, `resource-discovery`.
- [ ] **Add multi-provider failover integration test** — Provider A fails → failover to Provider B → Provider B fails → circuit breaker opens → Provider C selected.

---

### 9.2 — Error Path Tests

- [ ] Network timeout behavior in HTTP/SSH tools
- [ ] API rate limiting response handling (429 status)
- [ ] MCP server crash during tool execution
- [ ] Memory store corruption recovery (invalid JSON file)
- [ ] Provider authentication failure chains
- [ ] Concurrent parallel task execution with mixed success/failure
- [ ] Malformed JSON in provider responses
- [ ] Context window overflow mid-tool-loop

---

### 9.3 — Security Tests

- [ ] Path traversal: `../../../etc/passwd`, symlink attacks, Windows path separators
- [ ] Memory search with injection payloads in query text
- [ ] Terminal command injection via tool arguments
- [ ] Approval ID replay attacks
- [ ] Concurrent approval race conditions
- [ ] CORS bypass attempts with non-standard headers
- [ ] Rate limit bypass via distributed request patterns

---

### 9.4 — Performance Benchmarks

- [ ] Memory query performance with 1K, 10K, 100K items
- [ ] Session recall search latency with 100+ conversations
- [ ] Parallel task spawn/complete cycle time
- [ ] Token estimation accuracy vs. tiktoken baseline
- [ ] Compaction speed for conversations with 500+ messages
- [ ] MCP server initialization latency

---

## PHASE 10: CODE QUALITY

---

### 10.1 — Extract Magic Numbers to Config ✅

- [x] Move hardcoded values to `config.ts`:
  - `MAX_READ_CHARS = 100_000` → `CONFIG.tools.maxReadChars`
  - `DEFAULT_DIRECTORY_LIMIT = 200` → `CONFIG.tools.defaultDirectoryLimit`
  - `MAX_CONTEXTS = 500` → `CONFIG.attention.maxContexts`
  - `MAX_COMPLETED_STEPS = 24` → `CONFIG.attention.maxCompletedSteps`
  - `MAX_WORKING_MEMORY = 10` → `CONFIG.attention.maxWorkingMemory`
  - `MAX_ITEM_LENGTH = 240` → `CONFIG.attention.maxItemLength`
  - `DEFAULT_MAX_RESULTS = 4` (session recall) → `CONFIG.sessionRecall.defaultMaxResults`
  - `DEFAULT_MAX_CHARS = 1_800` (session recall) → `CONFIG.sessionRecall.defaultMaxChars`
  - Brave Search timeout `10_000` → `CONFIG.tools.webSearchTimeoutMs`

---

### 10.2 — Remove Dead Code ✅

- [x] Remove commented-out `browserTool` import in `tools/index.ts`
- [ ] Remove any unused test fixture files
- [ ] Clean up `OldMemoryRepository` if `SqliteMemoryRepository` is the standard

---

### 10.3 — Reduce Type Assertions ✅ (Only library interop and test mocks remain — acceptable)

- [x] Replace `as unknown as ...` patterns with proper type guards or discriminated unions
- [ ] Replace `Record<string, unknown>` in audit-log.ts with typed event interfaces
- [ ] Add runtime validation for checkpoint manifest parsing instead of unsafe casts

---

## EXECUTION ORDER

Work through these phases in order. Each phase's changes should be committed and tested before moving to the next.

```
Phase 1: Critical Bug Fixes          ← Do first. Prevents data loss and security issues.
  1.1 .env regex fix
  1.2 Compaction stage validation
  1.3 Atomic writes + write locks
  1.4 Safe JSON parsing
  1.5 Async checkpoint operations
  1.6 Attention context persistence

Phase 2: State Persistence            ← Do second. Makes Ember stateful across restarts.
  2.1 Failover state persistence
  2.2 Idempotency persistence
  2.3 Terminal approval persistence

Phase 3: Small Model Efficiency       ← Core differentiator. This is what makes Ember unique.
  3.1 Model capability profiles
  3.2 Adaptive prompt budget
  3.3 Tool filtering by capability
  3.4 Simplified prompt templates
  3.5 Skip metacognition for small models

Phase 4: Error Recovery               ← Makes Ember resilient. Required for production.
  4.1 MCP retry with backoff
  4.2 Dangerous command detection
  4.3 Structured reflection loops

Phase 5: Advanced Memory              ← Activates dormant infrastructure.
  5.1 Graph-aware memory scoring
  5.2 Memory TTL and eviction
  5.3 Frozen memory snapshots

Phase 6: Tool System                  ← Extensibility for power users.
  6.1 Dynamic tool plugins
  6.2 Code execution sandbox

Phase 7: Observability                ← Required for debugging and compliance.
  7.1 Token cost tracking
  7.2 Structured logging
  7.3 Audit log rotation

Phase 8: Platform & Deployment        ← Expands reach. Lower priority than core.
  8.1 Process isolation
  8.2 Cron scheduling
  8.3 Platform gateways

Phase 9: Test Coverage                ← Run in parallel with implementation phases.
  9.1 Critical path tests
  9.2 Error path tests
  9.3 Security tests
  9.4 Performance benchmarks

Phase 10: Code Quality               ← Continuous improvement.
  10.1 Extract magic numbers
  10.2 Remove dead code
  10.3 Reduce type assertions
```

---

## SUCCESS CRITERIA

When all phases are complete, Ember should:

1. **Beat Hermes Agent** in: small model efficiency (they don't adapt), state persistence (they freeze memory), reflection quality (they don't have it), and security (stronger command detection + path sandboxing)
2. **Beat MiroFish** in: general-purpose capability (they're simulation-only), tool breadth (40+ vs 4), memory richness (graph + temporal + session recall), and model flexibility (any model vs fixed)
3. **Uniquely offer**: adaptive prompt budgets for 0.8B-frontier models, graph-aware memory retrieval, metacognitive self-monitoring with reflection loops, and streaming-first architecture
4. **Pass all tests** with 80%+ file coverage
5. **Survive restarts** with no loss of intelligence (failover, attention, approvals all persisted)
6. **Work with small models** (4K-8K context) by automatically trimming prompts, reducing tools, and simplifying instructions
