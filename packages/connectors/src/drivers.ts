import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import {
  compactConversationHistory,
  deriveCompressionPromptBudget,
  estimateTextTokens,
  type ChatAttachment,
  type ChatImageAttachment,
  type ChatTextAttachment,
  getHistorySummaryMessage,
  isHistorySummaryMessage,
  type ConnectorTypeId,
  getProviderCapabilities,
  type ChatMessage,
  type PromptStack,
  type Provider,
  type ToolDefinition,
  type ToolResult,
  type ProviderExecutionRequest,
  type ProviderExecutionResult,
  type ProviderSecrets,
  type ProviderStatus,
} from "@ember/core";

/** Extract plain text from a ToolResult (used for providers that don't support image content). */
function toolResultToText(result: ToolResult): string {
  return typeof result === "string" ? result : result.text;
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJsonValue(item)]),
    );
  }

  return value;
}

function buildToolCallSignature(name: string, input: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(normalizeJsonValue(input))}`;
}

function truncateToolText(value: string, limit = 8_000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n\n[truncated at ${limit} chars]` : value;
}

async function buildProviderHttpError(
  response: Response,
  fallback: string,
): Promise<string> {
  const bodyText = (await response.text().catch(() => "")).trim();
  if (!bodyText) {
    return fallback;
  }

  try {
    const payload = JSON.parse(bodyText) as {
      error?: string | { message?: string };
      message?: string;
    };
    const detail =
      typeof payload.error === "string"
        ? payload.error
        : payload.error?.message ?? payload.message ?? "";
    if (detail.trim()) {
      return `${fallback} ${detail.trim()}`;
    }
  } catch {
    // Fall back to raw response text.
  }

  return `${fallback} ${truncateToolText(bodyText, 280)}`;
}

const DEFAULT_PROVIDER_TOOL_LOOP_LIMIT = 200;
const MAX_PROVIDER_TOOL_LOOP_LIMIT = 4_000;
const DEFAULT_LOCAL_PROVIDER_CONTEXT_WINDOW_TOKENS = 16_000;
const DEFAULT_REMOTE_PROVIDER_CONTEXT_WINDOW_TOKENS = 300_000;
const TOOL_LOOP_ESTIMATED_TOKENS_PER_TURN = 180;

// ─── Tool loop repetition detection ──────────────────────────────────────────
// Instead of hard-capping tool turns, monitor for repetitive patterns and
// warn the agent before stopping. This lets productive agents keep working
// while catching stuck loops.

/** How many recent tool signatures to track for cycle detection. */
const TOOL_LOOP_WINDOW_SIZE = 12;
/** A cycle must repeat this many times before being flagged. */
const TOOL_LOOP_CYCLE_THRESHOLD = 3;
/** After this many warnings, force-stop the loop. */
const TOOL_LOOP_MAX_WARNINGS = 2;

/**
 * Tracks tool call patterns during a provider tool loop and detects
 * when the agent is stuck in a repetitive cycle.
 *
 * Detection: maintains a sliding window of tool call signatures.
 * If any subsequence of length 1-4 repeats >= CYCLE_THRESHOLD times
 * consecutively, a warning is issued. After MAX_WARNINGS warnings
 * the monitor signals a hard stop.
 */
class ToolLoopMonitor {
  private signatures: string[] = [];
  private warningCount = 0;

  /**
   * Record a tool call. Returns null if no issue, or a feedback string
   * if the agent appears stuck. Returns "stop" if it should be force-stopped.
   */
  record(signature: string): { action: "ok" } | { action: "warn"; message: string } | { action: "stop"; message: string } {
    this.signatures.push(signature);

    // Check for immediate duplicate (same tool+input back-to-back)
    if (this.signatures.length >= 2 && this.signatures[this.signatures.length - 1] === this.signatures[this.signatures.length - 2]) {
      return this.issueWarning(signature.split(":")[0] ?? "tool", "immediate duplicate");
    }

    // Check for cycles in the recent window
    const window = this.signatures.slice(-TOOL_LOOP_WINDOW_SIZE);
    const cycle = this.detectCycle(window);
    if (cycle) {
      const toolNames = cycle.map((s) => s.split(":")[0] ?? "tool");
      return this.issueWarning(toolNames.join(" → "), "repeating cycle");
    }

    return { action: "ok" };
  }

  private issueWarning(pattern: string, kind: string): { action: "warn"; message: string } | { action: "stop"; message: string } {
    this.warningCount++;
    if (this.warningCount > TOOL_LOOP_MAX_WARNINGS) {
      return {
        action: "stop",
        message: `Stopping: detected ${kind} (${pattern}) after ${this.warningCount} warnings. ` +
          "Summarize your progress so far and respond with what you have.",
      };
    }
    return {
      action: "warn",
      message: `Warning: you appear to be in a ${kind} (${pattern}). ` +
        "Step back and try a different approach, or respond with what you have so far. " +
        `(warning ${this.warningCount}/${TOOL_LOOP_MAX_WARNINGS})`,
    };
  }

  /**
   * Detect repeating subsequences of length 1-4 in the window.
   * Returns the cycle pattern if found, null otherwise.
   */
  private detectCycle(window: string[]): string[] | null {
    const len = window.length;
    // Try cycle lengths from 1 to 4
    for (let cycleLen = 1; cycleLen <= Math.min(4, Math.floor(len / TOOL_LOOP_CYCLE_THRESHOLD)); cycleLen++) {
      const pattern = window.slice(len - cycleLen);
      let repeats = 1;
      for (let offset = len - cycleLen * 2; offset >= 0; offset -= cycleLen) {
        const segment = window.slice(offset, offset + cycleLen);
        if (segment.every((s, i) => s === pattern[i])) {
          repeats++;
        } else {
          break;
        }
      }
      if (repeats >= TOOL_LOOP_CYCLE_THRESHOLD) {
        return pattern;
      }
    }
    return null;
  }
}
const LOOP_COMPACTION_SUMMARY_PREFIX = "Tool-loop memory summary (auto-compacted).";
const LOOP_COMPACTION_SUMMARY_LINE_LIMIT = 20;
const LOOP_MIN_RECENT_MESSAGES = 4;
const LOOP_MAX_RECENT_MESSAGES = 20;
const FINAL_ANSWER_NUDGE = "Based on the information above, please provide your final answer.";
const FALLBACK_USER_QUERY_PROMPT = "Continue with the latest user request in this conversation.";

function isLikelyLocalBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "127.0.0.1" ||
      host === "host.docker.internal" ||
      host.endsWith(".local")
    ) {
      return true;
    }

    if (/^10\./.test(host) || /^192\.168\./.test(host)) {
      return true;
    }

    const private172 = host.match(/^172\.(\d{1,3})\./);
    if (private172) {
      const second = Number(private172[1]);
      return second >= 16 && second <= 31;
    }

    return false;
  } catch {
    return false;
  }
}

function resolveProviderToolContextWindowTokens(provider: Provider): number {
  if (provider.typeId === "openai-compatible") {
    const configured = Number(provider.config.contextWindowTokens ?? "");
    if (Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }

    if (isLikelyLocalBaseUrl(provider.config.baseUrl)) {
      return DEFAULT_LOCAL_PROVIDER_CONTEXT_WINDOW_TOKENS;
    }
  }

  return DEFAULT_REMOTE_PROVIDER_CONTEXT_WINDOW_TOKENS;
}

function resolveProviderToolLoopPromptBudget(
  provider: Provider,
  requestContextWindow?: number | null,
) {
  // Prefer the context window resolved by the server (from settings + provider config),
  // then fall back to the driver's own resolution.
  const contextWindowTokens = (requestContextWindow && requestContextWindow > 0)
    ? Math.floor(requestContextWindow)
    : resolveProviderToolContextWindowTokens(provider);
  // Scale headroom/safety with context size — small models can't afford 32% headroom.
  const isSmallModel = contextWindowTokens < 50_000;
  const responseHeadroomTokens = Math.max(512, Math.floor(contextWindowTokens * (isSmallModel ? 0.15 : 0.25)));
  const safetyMarginTokens = Math.max(512, Math.floor(contextWindowTokens * (isSmallModel ? 0.05 : 0.08)));
  const compressionBudget = deriveCompressionPromptBudget({
    contextWindowTokens,
    responseHeadroomTokens,
    safetyMarginTokens,
  });

  return {
    contextWindowTokens,
    maxPromptTokens: compressionBudget.maxPromptTokens,
    targetPromptTokens: compressionBudget.targetPromptTokens,
  };
}

function getProviderToolLoopLimit(
  provider: Provider,
  requestedLimit: number | null | undefined,
  contextWindowTokens?: number | null,
): number {
  const raw = Number(process.env.EMBER_PROVIDER_TOOL_LOOP_LIMIT ?? "");
  if (Number.isFinite(raw)) {
    const normalized = Math.floor(raw);
    if (normalized === 0) {
      return MAX_PROVIDER_TOOL_LOOP_LIMIT;
    }
    if (normalized > 0) {
      return Math.max(1, Math.min(normalized, MAX_PROVIDER_TOOL_LOOP_LIMIT));
    }
  }

  const requested = Number(requestedLimit ?? "");
  if (Number.isFinite(requested)) {
    const normalized = Math.floor(requested);
    if (normalized > 0) {
      return Math.max(1, Math.min(normalized, MAX_PROVIDER_TOOL_LOOP_LIMIT));
    }
  }

  const promptBudget = resolveProviderToolLoopPromptBudget(provider, contextWindowTokens);
  const adaptiveLimit = Math.floor(
    promptBudget.maxPromptTokens / TOOL_LOOP_ESTIMATED_TOKENS_PER_TURN,
  );

  return Math.max(
    DEFAULT_PROVIDER_TOOL_LOOP_LIMIT,
    Math.min(adaptiveLimit, MAX_PROVIDER_TOOL_LOOP_LIMIT),
  );
}

interface TextBasedToolCall {
  name: string;
  args: Record<string, unknown>;
}

function collectTextToolCalls(...contentBlocks: Array<string | null | undefined>): TextBasedToolCall[] {
  const calls: TextBasedToolCall[] = [];
  const seen = new Set<string>();

  for (const block of contentBlocks) {
    if (!block) {
      continue;
    }

    for (const call of parseTextToolCalls(block)) {
      const signature = buildToolCallSignature(call.name, call.args);
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      calls.push(call);
    }
  }

  return calls;
}

/**
 * Parse text-based tool calls emitted by local models (e.g. Qwen/Hermes) that don't use the
 * OpenAI structured tool_calls protocol. Handles two formats:
 *   Hermes/Qwen JSON: <tool_call>{"name":"x","arguments":{...}}</tool_call>
 *   XML-style:        <tool_call><function=x><parameter=k>v</parameter>...</function></tool_call>
 */
function parseTextToolCalls(content: string): TextBasedToolCall[] {
  const calls: TextBasedToolCall[] = [];
  const blockRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(content)) !== null) {
    const inner = match[1].trim();
    // Try Hermes/Qwen JSON format: {"name": "...", "arguments": {...}}
    try {
      const parsed = JSON.parse(inner) as Record<string, unknown>;
      if (parsed.name && typeof parsed.name === "string") {
        calls.push({
          name: parsed.name,
          args: (parsed.arguments ?? parsed.parameters ?? parsed.args ?? {}) as Record<string, unknown>,
        });
        continue;
      }
    } catch {
      // fall through to XML format
    }
    // Try XML-style: <function=name><parameter=key>value</parameter>...</function>
    const funcMatch = inner.match(/<function=(\w+)>([\s\S]*?)<\/function>/);
    if (funcMatch) {
      const name = funcMatch[1];
      const args: Record<string, unknown> = {};
      const paramRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(funcMatch[2])) !== null) {
        args[paramMatch[1]] = paramMatch[2].trim();
      }
      calls.push({ name, args });
    }
  }
  return calls;
}

function stripTextToolCalls(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
}

/**
 * Streaming filter that suppresses <tool_call>...</tool_call> blocks from being
 * forwarded to the client as visible content. Buffers input characters from the
 * moment a <tool_call> open tag is detected; only flushes safe content to the caller.
 */
class ToolCallStreamFilter {
  private buffer = "";

  /** Feed a content delta. Returns the portion safe to emit to the client. */
  push(delta: string): string {
    this.buffer += delta;
    return this.flush_safe();
  }

  /** Call after the stream ends to release any remaining buffered content. */
  drain(): string {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining;
  }

  private flush_safe(): string {
    const OPEN = "<tool_call>";
    const CLOSE = "</tool_call>";
    let safe = "";

    while (this.buffer.length > 0) {
      const openIdx = this.buffer.indexOf(OPEN);

      if (openIdx === -1) {
        // No open tag in buffer — emit everything except a trailing partial-tag window.
        const windowSize = OPEN.length - 1;
        if (this.buffer.length > windowSize) {
          safe += this.buffer.slice(0, this.buffer.length - windowSize);
          this.buffer = this.buffer.slice(this.buffer.length - windowSize);
        }
        break;
      }

      // Emit content before the opening tag.
      if (openIdx > 0) {
        safe += this.buffer.slice(0, openIdx);
        this.buffer = this.buffer.slice(openIdx);
      }

      // We're now at the start of a <tool_call> block — wait for the close tag.
      const closeIdx = this.buffer.indexOf(CLOSE);
      if (closeIdx === -1) {
        // Close tag not yet received — keep buffering.
        break;
      }

      // Skip over the complete <tool_call>...</tool_call> block.
      this.buffer = this.buffer.slice(closeIdx + CLOSE.length);
    }

    return safe;
  }
}

/**
 * Convert a ToolResult to Anthropic's tool_result content format.
 * If the result includes an image, returns a multi-block content array so
 * vision-capable models can see the screenshot alongside the text description.
 */
function toolResultToAnthropicContent(
  result: ToolResult,
): string | Array<{ type: string; [key: string]: unknown }> {
  if (typeof result === "string") return result;
  return [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: result.imageMimeType,
        data: result.imageBase64,
      },
    },
    { type: "text", text: result.text },
  ];
}

interface ProviderStreamHandlers {
  onStatus?: (message: string) => void;
  onThinking?: (text: string) => void;
  onContent?: (text: string) => void;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function shouldSurfaceCodexStatus(value: string): boolean {
  const normalized = stripAnsi(value).trim();
  if (!normalized) {
    return false;
  }

  if (
    /(?:^|\s)(TRACE|DEBUG|INFO|WARN|ERROR)\b/.test(normalized) ||
    /\bcodex_core::|\bsqlx::|\bdatabase is locked\b|\bslow statement\b|\bstate db\b/i.test(
      normalized,
    ) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(normalized)
  ) {
    return false;
  }

  return normalized.length <= 240;
}

function cliNeedsFullAccess(request: ProviderExecutionRequest): boolean {
  return request.role === "director";
}

function getCodexSandboxMode(request: ProviderExecutionRequest): "workspace-write" | "danger-full-access" {
  return cliNeedsFullAccess(request) ? "danger-full-access" : "workspace-write";
}

export interface RecheckResult {
  status: ProviderStatus;
  lastError: string | null;
  availableModels: string[];
}

interface CodexModelsCache {
  models?: Array<{
    slug?: string;
    visibility?: string | null;
    priority?: number | null;
    shell_type?: string | null;
  }>;
}

function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

function resolveCommandPath(command: string): string | null {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }

  const commandPath = result.stdout.trim();
  if (!commandPath) {
    return null;
  }

  try {
    return realpathSync(commandPath);
  } catch {
    return commandPath;
  }
}

function runStatusCommand(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: "utf8",
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readCodexModels(): string[] {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  const cache = readJsonFile<CodexModelsCache>(cachePath);

  if (!cache?.models?.length) {
    return [];
  }

  return cache.models
    .filter(
      (model) =>
        typeof model.slug === "string" &&
        model.slug.trim().length > 0 &&
        (model.visibility ?? "list") === "list" &&
        (model.shell_type ?? "shell_command") === "shell_command",
    )
    .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))
    .map((model) => model.slug!.trim());
}

export function getConnectorModelCatalog(): Partial<Record<ConnectorTypeId, string[]>> {
  return {
    "codex-cli": unique(readCodexModels()),
  };
}

function readCodexCliStatus(): RecheckResult {
  const availableModels = unique(readCodexModels());

  if (!commandExists("codex")) {
    return {
      status: "missing",
      lastError: "codex is not installed locally.",
      availableModels,
    };
  }

  const statusChecks = [
    ["login", "status"],
    ["auth", "status"],
  ];

  for (const args of statusChecks) {
    const authResult = runStatusCommand("codex", args);

    if (authResult.status === 0) {
      return {
        status: "connected",
        lastError: null,
        availableModels,
      };
    }

    const stderr = authResult.stderr?.trim() ?? "";
    const stdout = authResult.stdout?.trim() ?? "";
    const combined = `${stdout}\n${stderr}`.trim();
    if (/Logged in|authenticated|ChatGPT|Anthropic/i.test(combined)) {
      return {
        status: "connected",
        lastError: null,
        availableModels,
      };
    }

    if (!/unrecognized subcommand|unknown command|help/i.test(combined)) {
      return {
        status: "needs-auth",
        lastError:
          combined || "codex is installed but not authenticated.",
        availableModels,
      };
    }
  }

  return {
    status: "needs-auth",
    lastError: "codex is installed but EMBER could not confirm the login state with this CLI version.",
    availableModels,
  };
}

function resolveOpenAiBaseUrl(provider: Provider): string | null {
  const baseUrl = provider.config.baseUrl?.trim();
  if (!baseUrl) {
    return null;
  }
  return baseUrl.replace(/\/$/, "");
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return typeof item.text === "string" ? item.text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function parseModelsResponse(response: Response): Promise<string[]> {
  const payload = (await response.json()) as {
    data?: Array<{ id?: string }>;
  };
  return (payload.data ?? [])
    .map((item) => item.id?.trim() ?? "")
    .filter(Boolean);
}

async function testOpenAiCompatible(provider: Provider, secrets: ProviderSecrets): Promise<RecheckResult> {
  const baseUrl = resolveOpenAiBaseUrl(provider);
  if (!baseUrl) {
    return {
      status: "error",
      lastError: "Base URL is required.",
      availableModels: [],
    };
  }

  try {
    const headers: Record<string, string> = {};
    const apiKey = secrets[provider.id]?.apiKey || provider.config.apiKey;
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl}/models`, {
      headers,
    });

    if (!response.ok) {
      return {
        status: "error",
        lastError: `Endpoint responded with ${response.status}.`,
        availableModels: [],
      };
    }

    const availableModels = await parseModelsResponse(response);

    return {
      status: "connected",
      lastError: null,
      availableModels,
    };
  } catch (error) {
    return {
      status: "error",
      lastError:
        error instanceof Error ? error.message : "Unable to reach endpoint.",
      availableModels: [],
    };
  }
}

async function testAnthropicApi(
  provider: Provider,
  secrets: ProviderSecrets,
): Promise<RecheckResult> {
  const apiKey = secrets[provider.id]?.apiKey?.trim();
  if (!apiKey) {
    return {
      status: "error",
      lastError: "API key is required.",
      availableModels: [],
    };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (!response.ok) {
      return {
        status: "error",
        lastError: `Anthropic responded with ${response.status}.`,
        availableModels: [],
      };
    }

    return {
      status: "connected",
      lastError: null,
      availableModels: await parseModelsResponse(response),
    };
  } catch (error) {
    return {
      status: "error",
      lastError:
        error instanceof Error ? error.message : "Unable to reach Anthropic.",
      availableModels: [],
    };
  }
}

function buildSystemPrompt(
  stack: PromptStack,
  memoryContextText?: string | null,
  procedureContextText?: string | null,
): string {
  return [stack.shared, stack.role, stack.tools, memoryContextText?.trim() ?? "", procedureContextText?.trim() ?? ""]
    .filter(Boolean)
    .join("\n\n");
}

function toOpenAiMessages(
  conversation: ChatMessage[],
  promptStack: PromptStack,
  content: string,
  memoryContextText?: string | null,
  procedureContextText?: string | null,
  purpose: "chat" | "route" = "chat",
) {
  const systemContent = buildSystemPrompt(
    promptStack,
    purpose === "route" ? null : memoryContextText,
    purpose === "route" ? null : procedureContextText,
  );

  if (purpose === "route") {
    return [
      { role: "system", content: systemContent },
      { role: "user", content },
    ];
  }

  const historySummary = getHistorySummaryMessage(conversation);
  const recentConversation = conversation.filter((message) => !isHistorySummaryMessage(message)).slice(-12);
  const alreadyHasLatest =
    recentConversation.at(-1)?.role === "user" &&
    recentConversation.at(-1)?.content.trim() === content.trim();

  return [
    { role: "system", content: systemContent },
    ...(historySummary ? [toOpenAiMessage(historySummary)] : []),
    ...recentConversation.map((message) => toOpenAiMessage(message)),
    ...(alreadyHasLatest ? [] : [{ role: "user", content }]),
  ];
}

function toAnthropicMessages(
  conversation: ChatMessage[],
  content: string,
) {
  const historySummary = getHistorySummaryMessage(conversation);
  const recentConversation = conversation.filter((message) => !isHistorySummaryMessage(message)).slice(-12);
  const alreadyHasLatest =
    recentConversation.at(-1)?.role === "user" &&
    recentConversation.at(-1)?.content.trim() === content.trim();

  return [
    ...(historySummary ? [toAnthropicMessage(historySummary)] : []),
    ...recentConversation.map((message) => toAnthropicMessage(message)),
    ...(alreadyHasLatest
      ? []
      : [
          {
            role: "user",
            content,
          },
        ]),
  ];
}

function getImageAttachments(message: ChatMessage): ChatImageAttachment[] {
  return (message.attachments ?? []).filter(
    (attachment): attachment is ChatImageAttachment => attachment.kind === "image",
  );
}

function getTextAttachments(message: ChatMessage): ChatTextAttachment[] {
  return (message.attachments ?? []).filter(
    (attachment): attachment is ChatTextAttachment => attachment.kind === "text",
  );
}

function formatTextAttachmentForModel(attachment: ChatTextAttachment): string {
  const label = attachment.sourceName?.trim() || attachment.name.trim() || attachment.id;
  const header = `Attached file: ${label}`;
  const body = attachment.text.trim();
  if (!body) {
    return `${header}\n(The file was empty.)`;
  }

  if (attachment.language?.trim()) {
    return `${header}\n\`\`\`${attachment.language}\n${body}\n\`\`\``;
  }

  return `${header}\n${body}`;
}

function withCliAttachmentLabels(message: ChatMessage): string {
  const imageAttachments = getImageAttachments(message);
  const textAttachments = getTextAttachments(message);
  const parts = [message.content.trim()].filter(Boolean);

  if (textAttachments.length > 0) {
    parts.push(...textAttachments.map((attachment) => formatTextAttachmentForModel(attachment)));
  }

  if (imageAttachments.length > 0) {
    const label = `Attached images: ${imageAttachments
      .map((attachment) => attachment.name.trim() || attachment.id)
      .join(", ")}`;
    parts.push(`[${label}]`);
  }

  return parts.join("\n\n");
}

function toOpenAiUserContent(message: ChatMessage) {
  const imageAttachments = getImageAttachments(message);
  const textAttachments = getTextAttachments(message);
  if (imageAttachments.length === 0 && textAttachments.length === 0) {
    return message.content;
  }

  return [
    ...(message.content.trim()
      ? [{ type: "text", text: message.content }]
      : []),
    ...textAttachments.map((attachment) => ({
      type: "text",
      text: formatTextAttachmentForModel(attachment),
    })),
    ...imageAttachments.map((attachment) => ({
      type: "image_url",
      image_url: {
        url: attachment.dataUrl,
      },
    })),
  ];
}

function toOpenAiMessage(message: ChatMessage) {
  return {
    role: message.role === "user" ? "user" : "assistant",
    content: message.role === "user" ? toOpenAiUserContent(message) : message.content,
  };
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mediaType: match[1],
    data: match[2],
  };
}

function toAnthropicUserContent(message: ChatMessage) {
  const imageAttachments = getImageAttachments(message);
  const textAttachments = getTextAttachments(message);
  if (imageAttachments.length === 0 && textAttachments.length === 0) {
    return message.content;
  }

  return [
    ...(message.content.trim()
      ? [{ type: "text", text: message.content }]
      : []),
    ...textAttachments.map((attachment) => ({
      type: "text" as const,
      text: formatTextAttachmentForModel(attachment),
    })),
    ...imageAttachments.flatMap((attachment) => {
      const parsed = parseDataUrl(attachment.dataUrl);
      if (!parsed) {
        return [];
      }

      return [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data,
          },
        },
      ];
    }),
  ];
}

function toAnthropicMessage(message: ChatMessage) {
  return {
    role: message.role === "user" ? "user" : "assistant",
    content: message.role === "user" ? toAnthropicUserContent(message) : message.content,
  };
}

function pickModelId(provider: Provider, requestedModelId: string | null): string | null {
  return (
    requestedModelId?.trim() ||
    provider.config.defaultModelId?.trim() ||
    provider.availableModels[0] ||
    null
  );
}

function formatCliConversation(
  conversation: ChatMessage[],
  promptStack: PromptStack,
  content: string,
  memoryContextText?: string | null,
  procedureContextText?: string | null,
  purpose: "chat" | "route" = "chat",
): string {
  const systemParts = [promptStack.shared, promptStack.role, promptStack.tools].filter(Boolean);

  if (purpose === "route") {
    return [...systemParts, `User: ${content}`].join("\n\n");
  }

  const historySummary = getHistorySummaryMessage(conversation);
  const recentConversation = conversation.filter((message) => !isHistorySummaryMessage(message)).slice(-10);
  const alreadyHasLatest =
    recentConversation.at(-1)?.role === "user" &&
    recentConversation.at(-1)?.content.trim() === content.trim();
  const transcript = recentConversation
    .map((message) => {
      const speaker = message.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${withCliAttachmentLabels(message)}`;
    })
    .join("\n\n");

  return [
    ...systemParts,
    ...(memoryContextText?.trim() ? [memoryContextText.trim()] : []),
    ...(procedureContextText?.trim() ? [procedureContextText.trim()] : []),
    ...(historySummary ? [`Conversation memory:\n${historySummary.content}`] : []),
    transcript ? `Conversation so far:\n${transcript}` : "",
    ...(alreadyHasLatest ? [] : [`User: ${content}`]),
    "Respond as the assigned role. Keep the answer direct and user-facing.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const CODEX_TOOL_CALL_TAG = "ember_tool_call";

function extractCodexToolCallPayload(content: string): string | null {
  const matches = [
    ...content.matchAll(
      new RegExp(`<${CODEX_TOOL_CALL_TAG}>\\s*([\\s\\S]*?)\\s*</${CODEX_TOOL_CALL_TAG}>`, "gi"),
    ),
  ];
  return matches.at(-1)?.[1]?.trim() ?? null;
}

function parseCodexToolCallPreview(content: string): { name: string; input: Record<string, unknown> } | null {
  const rawPayload = extractCodexToolCallPayload(content);
  if (!rawPayload) {
    return null;
  }

  try {
    const payload = JSON.parse(rawPayload) as Record<string, unknown>;
    const name =
      typeof payload.name === "string"
        ? payload.name.trim()
        : typeof payload.tool === "string"
          ? payload.tool.trim()
          : "";
    const input = payload.input ?? payload.arguments ?? {};
    if (!name || !input || typeof input !== "object" || Array.isArray(input)) {
      return null;
    }
    return { name, input: input as Record<string, unknown> };
  } catch {
    return null;
  }
}

function stripCodexToolCallBlocks(content: string): string {
  return content
    .replace(new RegExp(`<${CODEX_TOOL_CALL_TAG}>[\\s\\S]*?</${CODEX_TOOL_CALL_TAG}>`, "gi"), "")
    .trim();
}

interface ParsedCliToolCall {
  name: string;
  input: Record<string, unknown>;
}

function buildCodexToolProtocol(tools: ToolDefinition[]): string {
  if (!tools.length) {
    return "";
  }

  const toolLines = tools.map((tool) => {
    const fields = Object.entries(tool.inputSchema.properties ?? {})
      .map(([name, spec]) => `${name}: ${typeof spec === "object" && spec !== null && "type" in spec ? String((spec as Record<string, unknown>).type) : "unknown"}`)
      .join(", ");
    return `- ${tool.name}(${fields || "no arguments"}) — ${tool.description}`;
  });

  return [
    "## EMBER tool protocol",
    "When you need an EMBER tool, you may include one brief sentence explaining what you are checking or about to do.",
    "Then output exactly one tool call block:",
    `<${CODEX_TOOL_CALL_TAG}>`,
    '{"name":"read_file","input":{"path":"packages/core/src/types.ts"}}',
    `</${CODEX_TOOL_CALL_TAG}>`,
    "Use only the tool names listed below and ensure the JSON is valid.",
    "Keep any sentence before the tool call short and user-readable.",
    "Do not repeat the exact same tool call with identical input immediately after receiving its result.",
    "After the tool result appears in the conversation, continue the task. When the work is complete, reply normally to the user.",
    "Available tools:",
    ...toolLines,
  ].join("\n");
}

function formatCodexConversation(request: ProviderExecutionRequest): string {
  const basePrompt = formatCliConversation(
    request.conversation,
    request.promptStack,
    request.content,
    request.memoryContext?.text ?? null,
    request.procedureContext?.text ?? null,
    request.purpose,
  );
  const toolProtocol = buildCodexToolProtocol(request.tools ?? []);
  return [basePrompt, toolProtocol].filter(Boolean).join("\n\n");
}

function summarizeLoopText(value: string, limit = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function buildLoopCompactionSummary(lines: string[], charBudget: number): string {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const normalized = summarizeLoopText(line, 220);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= LOOP_COMPACTION_SUMMARY_LINE_LIMIT) {
      break;
    }
  }

  if (deduped.length === 0) {
    return LOOP_COMPACTION_SUMMARY_PREFIX;
  }

  const summary = `${LOOP_COMPACTION_SUMMARY_PREFIX}\n${deduped.map((line) => `- ${line}`).join("\n")}`;
  if (summary.length <= charBudget) {
    return summary;
  }
  return `${summary.slice(0, Math.max(48, charBudget - 1)).trimEnd()}…`;
}

function summarizeOpenAiLoopMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "message";
  const content = summarizeLoopText(extractTextContent(record.content), 160);
  const toolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          const fn = (item as { function?: { name?: string } }).function;
          return typeof fn?.name === "string" ? fn.name : "";
        })
        .filter(Boolean)
    : [];
  const toolSuffix = toolCalls.length > 0 ? ` tool_calls=${toolCalls.join(",")}` : "";
  return `${role}${toolSuffix}: ${content || "(no text)"}`;
}

function summarizeAnthropicContent(content: unknown): string {
  if (typeof content === "string") {
    return summarizeLoopText(content, 160);
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type === "text") {
      lines.push(summarizeLoopText(typeof entry.text === "string" ? entry.text : "", 120));
      continue;
    }
    if (type === "tool_use") {
      const name = typeof entry.name === "string" ? entry.name : "tool";
      lines.push(`tool_use ${name}`);
      continue;
    }
    if (type === "tool_result") {
      lines.push(`tool_result ${summarizeLoopText(extractTextContent(entry.content), 120) || "(no text)"}`);
    }
  }

  return lines.filter(Boolean).join(" | ");
}

function summarizeAnthropicLoopMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "message";
  const content = summarizeAnthropicContent(record.content);
  return `${role}: ${content || "(no text)"}`;
}

function getMessageRole(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : "";
}

function isToolResponseEnvelope(content: string): boolean {
  return /^<tool_response>\s*[\s\S]*<\/tool_response>$/i.test(content.trim());
}

function isRealUserQueryText(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) {
    return false;
  }
  if (normalized === FINAL_ANSWER_NUDGE) {
    return false;
  }
  if (isToolResponseEnvelope(normalized)) {
    return false;
  }
  return true;
}

function extractAnthropicTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const entry = item as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function findLastOpenAiUserQueryText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (getMessageRole(message) !== "user") {
      continue;
    }
    const content = extractTextContent((message as { content?: unknown }).content);
    if (isRealUserQueryText(content)) {
      return summarizeLoopText(content, 480);
    }
  }
  return null;
}

function hasOpenAiUserQuery(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (getMessageRole(message) !== "user") {
      return false;
    }
    return isRealUserQueryText(extractTextContent((message as { content?: unknown }).content));
  });
}

function hasOpenAiPlainTextUserQuery(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (getMessageRole(message) !== "user") {
      return false;
    }
    const content = (message as { content?: unknown }).content;
    return typeof content === "string" && isRealUserQueryText(content);
  });
}

function getLastOpenAiUserMessage(messages: unknown[]): { content?: unknown } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (getMessageRole(message) !== "user" || !message || typeof message !== "object") {
      continue;
    }
    return message as { content?: unknown };
  }
  return null;
}

function normalizeFallbackUserQueryText(fallbackUserQueryText: string | null): string {
  const normalized = fallbackUserQueryText?.trim() ?? "";
  return isRealUserQueryText(normalized) ? normalized : FALLBACK_USER_QUERY_PROMPT;
}

function ensureOpenAiHasUserQuery(messages: unknown[], fallbackUserQueryText: string | null): unknown[] {
  const fallbackText = normalizeFallbackUserQueryText(fallbackUserQueryText);
  let ensured = messages;

  // Some OpenAI-compatible Jinja templates require at least one plain-text user query.
  if (!hasOpenAiUserQuery(ensured) || !hasOpenAiPlainTextUserQuery(ensured)) {
    const insertIndex = getMessageRole(ensured[0]) === "system" ? 1 : 0;
    ensured = [...ensured];
    ensured.splice(insertIndex, 0, {
      role: "user",
      content: fallbackText,
    });
  }

  const lastUser = getLastOpenAiUserMessage(ensured);
  const lastUserHasPlainTextQuery =
    typeof lastUser?.content === "string" && isRealUserQueryText(lastUser.content);

  // Keep the latest user message as a real plain-text query for strict templates
  // that inspect only the most recent user turn when tools are enabled.
  if (!lastUserHasPlainTextQuery) {
    ensured = [...ensured, { role: "user", content: fallbackText }];
  }

  return ensured;
}

function findLastAnthropicUserQueryText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (getMessageRole(message) !== "user") {
      continue;
    }
    const content = extractAnthropicTextContent((message as { content?: unknown }).content);
    if (isRealUserQueryText(content)) {
      return summarizeLoopText(content, 480);
    }
  }
  return null;
}

function hasAnthropicUserQuery(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (getMessageRole(message) !== "user") {
      return false;
    }
    return isRealUserQueryText(extractAnthropicTextContent((message as { content?: unknown }).content));
  });
}

function ensureAnthropicHasUserQuery(messages: unknown[], fallbackUserQueryText: string | null): unknown[] {
  if (hasAnthropicUserQuery(messages)) {
    return messages;
  }

  return [
    {
      role: "user",
      content: fallbackUserQueryText?.trim() || FALLBACK_USER_QUERY_PROMPT,
    },
    ...messages,
  ];
}

function estimateOpenAiPromptTokensForLoop(
  messages: unknown[],
  tools: ToolDefinition[] | undefined,
): number {
  const payload: Record<string, unknown> = { messages };
  if (tools?.length) {
    payload.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  return estimateTextTokens(JSON.stringify(payload));
}

function compactOpenAiMessagesForLoop(options: {
  messages: unknown[];
  tools: ToolDefinition[] | undefined;
  promptBudget: { maxPromptTokens: number; targetPromptTokens: number };
}): { messages: unknown[]; didCompact: boolean; beforeTokens: number; afterTokens: number } {
  const fallbackUserQueryText = findLastOpenAiUserQueryText(options.messages);
  const beforeTokens = estimateOpenAiPromptTokensForLoop(options.messages, options.tools);
  if (beforeTokens <= options.promptBudget.targetPromptTokens) {
    const ensured = ensureOpenAiHasUserQuery(options.messages, fallbackUserQueryText);
    const afterTokens = ensured === options.messages
      ? beforeTokens
      : estimateOpenAiPromptTokensForLoop(ensured, options.tools);
    return { messages: ensured, didCompact: ensured !== options.messages, beforeTokens, afterTokens };
  }

  const source = [...options.messages];
  const hasSystemLead =
    source.length > 0 &&
    typeof (source[0] as { role?: unknown })?.role === "string" &&
    (source[0] as { role: string }).role === "system";
  const lead = hasSystemLead ? [source[0]] : [];
  let working = hasSystemLead ? source.slice(1) : source.slice();
  let keepRecent = Math.max(
    LOOP_MIN_RECENT_MESSAGES,
    Math.min(LOOP_MAX_RECENT_MESSAGES, Math.floor(options.promptBudget.targetPromptTokens / 700)),
  );
  let summaryCharBudget = Math.max(900, Math.floor(options.promptBudget.targetPromptTokens * 1.6));
  let didCompact = false;

  while (working.length > keepRecent + 1) {
    const splitIndex = Math.max(1, working.length - keepRecent);
    const older = working.slice(0, splitIndex);
    const recent = working.slice(splitIndex);
    const summary = buildLoopCompactionSummary(
      older.map((message) => summarizeOpenAiLoopMessage(message)).filter(Boolean).reverse(),
      summaryCharBudget,
    );
    working = [{ role: "assistant", content: summary }, ...recent];
    didCompact = true;

    const candidate = [...lead, ...working];
    const candidateTokens = estimateOpenAiPromptTokensForLoop(candidate, options.tools);
    if (candidateTokens <= options.promptBudget.targetPromptTokens) {
      const ensured = ensureOpenAiHasUserQuery(candidate, fallbackUserQueryText);
      const afterTokens = ensured === candidate
        ? candidateTokens
        : estimateOpenAiPromptTokensForLoop(ensured, options.tools);
      return {
        messages: ensured,
        didCompact: didCompact || ensured !== candidate,
        beforeTokens,
        afterTokens,
      };
    }

    if (keepRecent > LOOP_MIN_RECENT_MESSAGES) {
      keepRecent = Math.max(LOOP_MIN_RECENT_MESSAGES, keepRecent - 2);
      continue;
    }
    if (summaryCharBudget > 480) {
      summaryCharBudget = Math.max(480, summaryCharBudget - 220);
      continue;
    }
    break;
  }

  const compacted = [...lead, ...working];
  let afterTokens = estimateOpenAiPromptTokensForLoop(compacted, options.tools);
  if (afterTokens > options.promptBudget.maxPromptTokens && compacted.length > LOOP_MIN_RECENT_MESSAGES + 1) {
    const aggressivelyTrimmed = [...compacted];
    while (aggressivelyTrimmed.length > LOOP_MIN_RECENT_MESSAGES + 1) {
      aggressivelyTrimmed.splice(1, 1);
      didCompact = true;
      afterTokens = estimateOpenAiPromptTokensForLoop(aggressivelyTrimmed, options.tools);
      if (afterTokens <= options.promptBudget.targetPromptTokens) {
        break;
      }
      if (afterTokens <= options.promptBudget.maxPromptTokens) {
        break;
      }
    }
    const ensured = ensureOpenAiHasUserQuery(aggressivelyTrimmed, fallbackUserQueryText);
    const ensuredTokens = ensured === aggressivelyTrimmed
      ? afterTokens
      : estimateOpenAiPromptTokensForLoop(ensured, options.tools);
    return {
      messages: ensured,
      didCompact: didCompact || ensured !== aggressivelyTrimmed,
      beforeTokens,
      afterTokens: ensuredTokens,
    };
  }

  const ensured = ensureOpenAiHasUserQuery(compacted, fallbackUserQueryText);
  const ensuredTokens = ensured === compacted
    ? afterTokens
    : estimateOpenAiPromptTokensForLoop(ensured, options.tools);
  return {
    messages: ensured,
    didCompact: didCompact || ensured !== compacted,
    beforeTokens,
    afterTokens: ensuredTokens,
  };
}

function estimateAnthropicPromptTokensForLoop(options: {
  systemPrompt: string;
  messages: unknown[];
  tools: ToolDefinition[] | undefined;
}): number {
  const payload: Record<string, unknown> = {
    system: options.systemPrompt,
    messages: options.messages,
  };
  if (options.tools?.length) {
    payload.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
  return estimateTextTokens(JSON.stringify(payload));
}

function compactAnthropicMessagesForLoop(options: {
  systemPrompt: string;
  messages: unknown[];
  tools: ToolDefinition[] | undefined;
  promptBudget: { maxPromptTokens: number; targetPromptTokens: number };
}): { messages: unknown[]; didCompact: boolean; beforeTokens: number; afterTokens: number } {
  const fallbackUserQueryText = findLastAnthropicUserQueryText(options.messages);
  const beforeTokens = estimateAnthropicPromptTokensForLoop({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    tools: options.tools,
  });
  if (beforeTokens <= options.promptBudget.targetPromptTokens) {
    const ensured = ensureAnthropicHasUserQuery(options.messages, fallbackUserQueryText);
    const afterTokens = ensured === options.messages
      ? beforeTokens
      : estimateAnthropicPromptTokensForLoop({
          systemPrompt: options.systemPrompt,
          messages: ensured,
          tools: options.tools,
        });
    return { messages: ensured, didCompact: ensured !== options.messages, beforeTokens, afterTokens };
  }

  let working = [...options.messages];
  let keepRecent = Math.max(
    LOOP_MIN_RECENT_MESSAGES,
    Math.min(LOOP_MAX_RECENT_MESSAGES, Math.floor(options.promptBudget.targetPromptTokens / 700)),
  );
  let summaryCharBudget = Math.max(900, Math.floor(options.promptBudget.targetPromptTokens * 1.6));
  let didCompact = false;

  while (working.length > keepRecent + 1) {
    const splitIndex = Math.max(1, working.length - keepRecent);
    const older = working.slice(0, splitIndex);
    const recent = working.slice(splitIndex);
    const summary = buildLoopCompactionSummary(
      older.map((message) => summarizeAnthropicLoopMessage(message)).filter(Boolean).reverse(),
      summaryCharBudget,
    );
    working = [{ role: "user", content: summary }, ...recent];
    didCompact = true;

    const candidateTokens = estimateAnthropicPromptTokensForLoop({
      systemPrompt: options.systemPrompt,
      messages: working,
      tools: options.tools,
    });
    if (candidateTokens <= options.promptBudget.targetPromptTokens) {
      const ensured = ensureAnthropicHasUserQuery(working, fallbackUserQueryText);
      const afterTokens = ensured === working
        ? candidateTokens
        : estimateAnthropicPromptTokensForLoop({
            systemPrompt: options.systemPrompt,
            messages: ensured,
            tools: options.tools,
          });
      return {
        messages: ensured,
        didCompact: didCompact || ensured !== working,
        beforeTokens,
        afterTokens,
      };
    }

    if (keepRecent > LOOP_MIN_RECENT_MESSAGES) {
      keepRecent = Math.max(LOOP_MIN_RECENT_MESSAGES, keepRecent - 2);
      continue;
    }
    if (summaryCharBudget > 480) {
      summaryCharBudget = Math.max(480, summaryCharBudget - 220);
      continue;
    }
    break;
  }

  let afterTokens = estimateAnthropicPromptTokensForLoop({
    systemPrompt: options.systemPrompt,
    messages: working,
    tools: options.tools,
  });

  if (afterTokens > options.promptBudget.maxPromptTokens && working.length > LOOP_MIN_RECENT_MESSAGES + 1) {
    const aggressivelyTrimmed = [...working];
    while (aggressivelyTrimmed.length > LOOP_MIN_RECENT_MESSAGES + 1) {
      aggressivelyTrimmed.splice(1, 1);
      didCompact = true;
      afterTokens = estimateAnthropicPromptTokensForLoop({
        systemPrompt: options.systemPrompt,
        messages: aggressivelyTrimmed,
        tools: options.tools,
      });
      if (afterTokens <= options.promptBudget.targetPromptTokens) {
        break;
      }
      if (afterTokens <= options.promptBudget.maxPromptTokens) {
        break;
      }
    }
    const ensured = ensureAnthropicHasUserQuery(aggressivelyTrimmed, fallbackUserQueryText);
    const ensuredTokens = ensured === aggressivelyTrimmed
      ? afterTokens
      : estimateAnthropicPromptTokensForLoop({
          systemPrompt: options.systemPrompt,
          messages: ensured,
          tools: options.tools,
        });
    return {
      messages: ensured,
      didCompact: didCompact || ensured !== aggressivelyTrimmed,
      beforeTokens,
      afterTokens: ensuredTokens,
    };
  }

  const ensured = ensureAnthropicHasUserQuery(working, fallbackUserQueryText);
  const ensuredTokens = ensured === working
    ? afterTokens
    : estimateAnthropicPromptTokensForLoop({
        systemPrompt: options.systemPrompt,
        messages: ensured,
        tools: options.tools,
      });
  return {
    messages: ensured,
    didCompact: didCompact || ensured !== working,
    beforeTokens,
    afterTokens: ensuredTokens,
  };
}

function compactCodexConversationForLoop(options: {
  conversation: ChatMessage[];
  content: string;
  request: ProviderExecutionRequest;
  promptBudget: { maxPromptTokens: number; targetPromptTokens: number };
}): ReturnType<typeof compactConversationHistory> {
  const extraPromptTokens = estimateTextTokens(
    [
      options.request.memoryContext?.text ?? "",
      options.request.procedureContext?.text ?? "",
      buildCodexToolProtocol(options.request.tools ?? []),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );

  return compactConversationHistory(options.conversation, {
    enabled: true,
    maxPromptTokens: options.promptBudget.maxPromptTokens,
    targetPromptTokens: options.promptBudget.targetPromptTokens,
    preserveRecentMessages: 8,
    minimumRecentMessages: 4,
    promptStack: options.request.promptStack,
    currentUserContent: options.content,
    extraPromptTokens,
  });
}

function parseCodexToolCall(content: string): { call: ParsedCliToolCall | null; error: string | null } {
  const rawPayload = extractCodexToolCallPayload(content);
  if (!rawPayload) {
    return { call: null, error: null };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return {
      call: null,
      error: `Error: malformed ${CODEX_TOOL_CALL_TAG} JSON. Return valid JSON with "name" and "input".`,
    };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      call: null,
      error: `Error: ${CODEX_TOOL_CALL_TAG} must contain a JSON object.`,
    };
  }

  const record = payload as Record<string, unknown>;
  const name =
    typeof record.name === "string"
      ? record.name.trim()
      : typeof record.tool === "string"
        ? record.tool.trim()
        : "";
  const input = record.input ?? record.arguments ?? {};

  if (!name) {
    return {
      call: null,
      error: `Error: ${CODEX_TOOL_CALL_TAG} is missing a tool name.`,
    };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      call: null,
      error: `Error: ${CODEX_TOOL_CALL_TAG} input must be a JSON object.`,
    };
  }

  return {
    call: {
      name,
      input: input as Record<string, unknown>,
    },
    error: null,
  };
}

function buildSyntheticCliMessage(
  role: "user" | "assistant",
  content: string,
  request: ProviderExecutionRequest,
): ChatMessage {
  return {
    id: `cli-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    role,
    authorRole: role === "user" ? "user" : (request.role ?? "coordinator"),
    mode: (request.role ?? "coordinator") as ChatMessage["mode"],
    content,
    createdAt: new Date().toISOString(),
  };
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "img";
  }
}

function collectRecentCliImages(conversation: ChatMessage[]): ChatImageAttachment[] {
  return conversation.slice(-10).flatMap((message) => getImageAttachments(message));
}

async function materializeCliImages(
  conversation: ChatMessage[],
): Promise<{ dirPath: string | null; filePaths: string[]; cleanup: () => Promise<void> }> {
  const attachments = collectRecentCliImages(conversation);
  if (attachments.length === 0) {
    return {
      dirPath: null,
      filePaths: [],
      cleanup: async () => {},
    };
  }

  const dirPath = await mkdtemp(path.join(os.tmpdir(), "ember-codex-images-"));
  const filePaths = await Promise.all(
    attachments.map(async (attachment, index) => {
      const parsed = parseDataUrl(attachment.dataUrl);
      if (!parsed) {
        throw new Error(`Unsupported image attachment format for ${attachment.name}.`);
      }

      const filePath = path.join(
        dirPath,
        `${String(index + 1).padStart(2, "0")}-${attachment.id}.${extensionForMediaType(
          parsed.mediaType,
        )}`,
      );
      await writeFile(filePath, Buffer.from(parsed.data, "base64"));
      return filePath;
    }),
  );

  return {
    dirPath,
    filePaths,
    cleanup: async () => {
      if (dirPath) {
        await rm(dirPath, { recursive: true, force: true });
      }
    },
  };
}

function parseCodexExecJson(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.reverse()) {
    if (!line.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        const text = event.item.text?.trim() ?? "";
        if (text) {
          return text;
        }
      }
    } catch {
      continue;
    }
  }

  return "";
}

function parseCodexExecEvent(
  line: string,
): {
  type?: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    exit_code?: number | null;
    status?: string;
  };
} | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as {
      type?: string;
      item?: { type?: string; text?: string };
    };
  } catch {
    return null;
  }
}

function summarizeCodexCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "command";
  }

  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function flushPendingCodexNote(
  state: { pendingNote: string | null },
  handlers?: Pick<ProviderStreamHandlers, "onThinking">,
): void {
  const note = state.pendingNote?.trim();
  if (!note) {
    state.pendingNote = null;
    return;
  }

  handlers?.onThinking?.(`${note}\n\n`);
  state.pendingNote = null;
}

function processCodexStdoutChunk(
  chunk: string,
  state: {
    buffer: string;
    content: string;
    pendingNote: string | null;
  },
  handlers?: Pick<ProviderStreamHandlers, "onStatus" | "onThinking">,
): void {
  state.buffer += chunk;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";

  for (const line of lines) {
    const event = parseCodexExecEvent(line);
    if (!event) {
      continue;
    }

    if (event.type === "turn.started") {
      handlers?.onStatus?.("Codex is working...");
      continue;
    }

    if (event.type === "item.started" && event.item?.type === "command_execution") {
      flushPendingCodexNote(state, handlers);
      handlers?.onStatus?.(`Running command: ${summarizeCodexCommand(event.item.command ?? "")}`);
      continue;
    }

    if (event.type === "item.completed" && event.item?.type === "command_execution") {
      const exitCode =
        typeof event.item.exit_code === "number" && Number.isFinite(event.item.exit_code)
          ? event.item.exit_code
          : null;
      const suffix = exitCode === null ? "completed" : exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
      handlers?.onStatus?.(`Command ${suffix}: ${summarizeCodexCommand(event.item.command ?? "")}`);
      continue;
    }

    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      const text = event.item.text?.trim() ?? "";
      if (text) {
        const prose = stripCodexToolCallBlocks(text);
        const toolPreview = parseCodexToolCallPreview(text);
        const displayNote =
          prose ||
          (toolPreview
            ? `Requesting tool: ${toolPreview.name}`
            : "");
        if (state.pendingNote) {
          flushPendingCodexNote(state, handlers);
        }
        state.pendingNote = displayNote || null;
        if (toolPreview) {
          handlers?.onStatus?.(`Tool request: ${toolPreview.name}`);
        }
        state.content = text;
      }
    }
  }
}

function processCodexStderrChunk(
  chunk: string,
  state: { buffer: string },
  handlers?: Pick<ProviderStreamHandlers, "onStatus">,
): void {
  state.buffer += chunk;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";

  for (const line of lines) {
    const status = stripAnsi(line).trim();
    if (status && shouldSurfaceCodexStatus(status)) {
      handlers?.onStatus?.(status);
    }
  }
}

function extractClaudeMessageText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const block = item as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("");
}

function parseClaudeExecJson(stdout: string): { content: string; isError: boolean } {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.reverse()) {
    if (!line.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(line) as {
        type?: string;
        result?: unknown;
        is_error?: boolean;
        message?: { content?: unknown };
        error?: unknown;
      };

      if (event.type === "result") {
        const content =
          typeof event.result === "string"
            ? event.result.trim()
            : extractClaudeMessageText(event.message?.content);
        return { content, isError: Boolean(event.is_error) };
      }

      if (event.type === "assistant") {
        const content = extractClaudeMessageText(event.message?.content);
        if (content) {
          return { content, isError: Boolean(event.error) };
        }
      }
    } catch {
      continue;
    }
  }

  return { content: "", isError: false };
}

function extractNestedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractNestedText(item)).filter(Boolean).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const candidateKeys = ["text", "content", "value", "delta", "thinking", "reasoning_content"];
  for (const key of candidateKeys) {
    if (key in value) {
      const extracted = extractNestedText((value as Record<string, unknown>)[key]);
      if (extracted) {
        return extracted;
      }
    }
  }

  return "";
}

function extractBlockTextByType(value: unknown, allowedTypes: string[]): string {
  if (!value) {
    return "";
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractBlockTextByType(item, allowedTypes))
      .filter(Boolean)
      .join("");
  }

  if (typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const blockType = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const normalizedAllowedTypes = allowedTypes.map((item) => item.toLowerCase());

  if (blockType && normalizedAllowedTypes.includes(blockType)) {
    return extractNestedText(record.text ?? record.content ?? record.value ?? record.delta);
  }

  return extractNestedText(record.content);
}

function extractOpenAiDeltaContent(delta: Record<string, unknown> | undefined): string {
  if (!delta) {
    return "";
  }

  const blockContent = extractBlockTextByType(delta.content, [
    "text",
    "output_text",
    "input_text",
  ]);
  if (blockContent) {
    return blockContent;
  }

  return extractNestedText(delta.content);
}

function extractOpenAiDeltaThinking(delta: Record<string, unknown> | undefined): string {
  if (!delta) {
    return "";
  }

  const candidates = [
    delta.reasoning_content,
    delta.reasoning,
    delta.thinking,
    delta.reasoningText,
    delta.reasoning_text,
    delta.reasoningContent,
    delta.thinking_content,
  ];

  for (const candidate of candidates) {
    const extracted = extractNestedText(candidate);
    if (extracted) {
      return extracted;
    }
  }

  const blockThinking = extractBlockTextByType(delta.content, [
    "reasoning",
    "thinking",
    "reasoning_content",
    "thinking_content",
  ]);
  if (blockThinking) {
    return blockThinking;
  }

  return "";
}

function extractOpenAiMessageThinking(message: Record<string, unknown> | undefined): string {
  if (!message) {
    return "";
  }

  const candidates = [
    message.reasoning_content,
    message.reasoning,
    message.thinking,
    message.reasoningText,
    message.reasoning_text,
    message.reasoningContent,
    message.thinking_content,
  ];

  for (const candidate of candidates) {
    const extracted = extractNestedText(candidate);
    if (extracted) {
      return extracted;
    }
  }

  return extractBlockTextByType(message.content, [
    "reasoning",
    "thinking",
    "reasoning_content",
    "thinking_content",
  ]);
}

function processSseChunk(
  buffer: string,
  onEvent: (data: string, eventName: string | null) => void,
): string {
  let remaining = buffer;

  while (true) {
    const separatorIndex = remaining.indexOf("\n\n");
    if (separatorIndex === -1) {
      return remaining;
    }

    const rawEvent = remaining.slice(0, separatorIndex);
    remaining = remaining.slice(separatorIndex + 2);

    const lines = rawEvent.split("\n");
    let eventName: string | null = null;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length > 0) {
      onEvent(dataLines.join("\n"), eventName);
    }
  }
}

async function readResponseStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      onChunk(decoder.decode(value, { stream: true }));
    }

    const trailing = decoder.decode();
    if (trailing) {
      onChunk(trailing);
    }
  } finally {
    reader.releaseLock();
  }
}

async function runCodexCliTurn(
  provider: Provider,
  request: ProviderExecutionRequest,
  handlers?: Pick<ProviderStreamHandlers, "onStatus" | "onThinking">,
): Promise<ProviderExecutionResult> {
  if (!commandExists("codex")) {
    throw new Error("codex is not installed locally.");
  }

  const modelId = request.modelId?.trim() || provider.config.defaultModelId?.trim() || null;
  const prompt = formatCodexConversation(request);
  const repoRoot = process.env.EMBER_ROOT
    ? path.resolve(process.env.EMBER_ROOT)
    : process.cwd();
  const imageFiles = await materializeCliImages(request.conversation);
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    getCodexSandboxMode(request),
    "--json",
    ...(modelId ? ["-m", modelId] : []),
    ...imageFiles.filePaths.flatMap((filePath) => ["--image", filePath]),
    prompt,
  ];

  try {
    handlers?.onStatus?.("Launching Codex CLI...");
    const child = spawn("codex", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        OTEL_SDK_DISABLED: "true",
      },
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    const stdoutState = { buffer: "", content: "", pendingNote: null as string | null };
    const stderrState = { buffer: "" };

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      processCodexStdoutChunk(chunk, stdoutState, handlers);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      processCodexStderrChunk(chunk, stderrState, handlers);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    if (stderrState.buffer.trim()) {
      const status = stripAnsi(stderrState.buffer).trim();
      if (status && shouldSurfaceCodexStatus(status)) {
        handlers?.onStatus?.(status);
      }
    }

    if (stdoutState.buffer.trim()) {
      processCodexStdoutChunk(`${stdoutState.buffer}\n`, stdoutState, handlers);
      stdoutState.buffer = "";
    }

    flushPendingCodexNote(stdoutState, handlers);

    const content = stdoutState.content || parseCodexExecJson(stdout);

    if (exitCode !== 0 && !content) {
      throw new Error(stderr.trim() || stdout.trim() || "Codex exec failed.");
    }

    if (!content) {
      throw new Error("Codex returned an empty response.");
    }

    return {
      content,
      modelId,
    };
  } finally {
    await imageFiles.cleanup();
  }
}

async function executeCodexCli(
  provider: Provider,
  request: ProviderExecutionRequest,
  handlers?: Pick<ProviderStreamHandlers, "onStatus" | "onThinking">,
): Promise<ProviderExecutionResult> {
  let conversation = [...request.conversation];
  let currentContent = request.content;
  let lastContent = "";
  let modelId = request.modelId?.trim() || provider.config.defaultModelId?.trim() || null;
  let lastToolResultText = "";
  const promptBudget = resolveProviderToolLoopPromptBudget(provider, request.contextWindowTokens);
  const maxToolTurns = getProviderToolLoopLimit(provider, request.toolLoopLimit, request.contextWindowTokens);
  const monitor = new ToolLoopMonitor();
  let reportedCompaction = false;

  for (let turn = 0; turn < maxToolTurns; turn++) {
    const compactedConversation = compactCodexConversationForLoop({
      conversation,
      content: currentContent,
      request,
      promptBudget,
    });
    if (compactedConversation.didCompact && !reportedCompaction) {
      handlers?.onStatus?.("Compacting tool-loop history to stay within context window...");
      reportedCompaction = true;
    }
    conversation = compactedConversation.messages;

    const result = await runCodexCliTurn(provider, {
      ...request,
      conversation,
      content: currentContent,
    }, handlers);
    lastContent = result.content;
    modelId = result.modelId;

    if (!request.tools?.length || !request.onToolCall) {
      return result;
    }

    const parsed = parseCodexToolCall(result.content);
    if (!parsed.call && !parsed.error) {
      return result;
    }

    conversation = [
      ...conversation,
      buildSyntheticCliMessage("assistant", result.content, request),
    ];

    if (parsed.error) {
      currentContent = parsed.error;
      conversation.push(buildSyntheticCliMessage("user", currentContent, request));
      continue;
    }

    handlers?.onStatus?.(`Tool: ${parsed.call!.name}`);
    const toolSignature = buildToolCallSignature(parsed.call!.name, parsed.call!.input);
    const loopCheck = monitor.record(toolSignature);
    if (loopCheck.action === "stop") {
      currentContent = loopCheck.message;
      conversation.push(buildSyntheticCliMessage("user", currentContent, request));
      // Give the model one last chance to respond with what it has
      const finalResult = await runCodexCliTurn(provider, { ...request, conversation, content: currentContent }, handlers);
      if (finalResult.content.trim()) return finalResult;
      break;
    }
    if (loopCheck.action === "warn") {
      // Don't execute the duplicate tool — feed back the warning
      currentContent = loopCheck.message;
      conversation.push(buildSyntheticCliMessage("user", currentContent, request));
      continue;
    }

    const toolResult = await request.onToolCall(parsed.call!.name, parsed.call!.input);
    lastToolResultText = toolResultToText(toolResult);
    currentContent = `Tool result for ${parsed.call!.name}:\n${lastToolResultText}`;
    conversation.push(buildSyntheticCliMessage("user", currentContent, request));
  }

  if (lastContent.trim()) {
    return { content: lastContent, modelId };
  }

  throw new Error(
    `Codex tool loop reached the turn limit (${maxToolTurns}) without a final response. ` +
    "Increase Settings → Context Compression → Tool loop limit, or set EMBER_PROVIDER_TOOL_LOOP_LIMIT (0 = very high cap).",
  );
}

async function streamCodexCli(
  provider: Provider,
  request: ProviderExecutionRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderExecutionResult> {
  const result = await executeCodexCli(provider, request, {
    onStatus: handlers.onStatus,
    onThinking: handlers.onThinking,
  });
  handlers.onContent?.(result.content);
  return result;
}

async function executeOpenAiCompatible(
  provider: Provider,
  secrets: ProviderSecrets,
  request: ProviderExecutionRequest,
): Promise<ProviderExecutionResult> {
  const baseUrl = resolveOpenAiBaseUrl(provider);
  if (!baseUrl) {
    throw new Error("OpenAI-compatible providers require a base URL.");
  }

  const modelId = pickModelId(provider, request.modelId);
  if (!modelId) {
    throw new Error("No model is assigned or discovered for this provider.");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const apiKey = secrets[provider.id]?.apiKey || provider.config.apiKey;
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  let messages: unknown[] = toOpenAiMessages(
    request.conversation,
    request.promptStack,
    request.content,
    request.memoryContext?.text ?? null,
    request.procedureContext?.text ?? null,
    request.purpose,
  );

  let lastTextContent = "";
  let nudged = false;
  let lastToolResultText = "";
  const promptBudget = resolveProviderToolLoopPromptBudget(provider, request.contextWindowTokens);
  const maxToolTurns = getProviderToolLoopLimit(provider, request.toolLoopLimit, request.contextWindowTokens);
  const monitor = new ToolLoopMonitor();

  for (let turn = 0; turn < maxToolTurns; turn++) {
    messages = compactOpenAiMessagesForLoop({
      messages,
      tools: request.tools,
      promptBudget,
    }).messages;

    const body: Record<string, unknown> = { model: modelId, messages };

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        await buildProviderHttpError(
          response,
          `Provider responded with ${response.status}.`,
        ),
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: unknown;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    };

    const message = payload.choices?.[0]?.message;
    const toolCalls = message?.tool_calls;

    // Capture any text the model produced alongside or instead of tool calls.
    const turnText = extractTextContent(message?.content);
    const turnThinking = extractOpenAiMessageThinking(message as Record<string, unknown> | undefined);
    if (turnText.trim()) lastTextContent = turnText;

    if (!toolCalls?.length || !request.onToolCall) {
      // Fallback: parse text-based tool calls for models that don't use the OpenAI protocol.
      if (request.onToolCall && (turnText || turnThinking)) {
        const textCalls = collectTextToolCalls(turnText, turnThinking);
        if (textCalls.length > 0) {
          const cleanText = stripTextToolCalls(turnText);
          if (cleanText) lastTextContent = cleanText;
          const toolMessages: unknown[] = [];
          for (const tc of textCalls) {
            const toolSignature = buildToolCallSignature(tc.name, tc.args);
            const loopCheck = monitor.record(toolSignature);
            if (loopCheck.action === "stop") {
              if (lastTextContent.trim()) return { content: lastTextContent, modelId };
              return { content: loopCheck.message, modelId };
            }
            const toolResultText = loopCheck.action === "warn"
              ? loopCheck.message
              : toolResultToText(await request.onToolCall(tc.name, tc.args));
            if (loopCheck.action === "ok") {
              lastToolResultText = toolResultText;
            }
            toolMessages.push({ role: "user", content: `<tool_response>\n${toolResultText}\n</tool_response>` });
          }
          messages = [...messages, { role: "assistant", content: cleanText || turnText }, ...toolMessages];
          nudged = false;
          continue;
        }
      }

      if (!lastTextContent.trim()) {
        // Model returned empty after tool use — nudge it once to synthesize a response.
        if (!nudged) {
          nudged = true;
          messages = [
            ...messages,
            { role: "user", content: FINAL_ANSWER_NUDGE },
          ];
          continue;
        }
        throw new Error("Provider returned an empty completion.");
      }
      return { content: lastTextContent, modelId };
    }

    // Execute the first tool call and loop back with result.
    const toolCall = toolCalls[0];
    let toolInput: Record<string, unknown> = {};
    try {
      toolInput = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch {
      // Leave input empty on parse failure.
    }
    const toolSignature = buildToolCallSignature(toolCall.function.name, toolInput);
    const loopCheck = monitor.record(toolSignature);
    let toolResultText: string;
    if (loopCheck.action === "stop") {
      if (lastTextContent.trim()) return { content: lastTextContent, modelId };
      return { content: loopCheck.message, modelId };
    } else if (loopCheck.action === "warn") {
      toolResultText = loopCheck.message;
    } else {
      toolResultText = toolResultToText(await request.onToolCall(toolCall.function.name, toolInput));
      lastToolResultText = toolResultText;
    }
    messages = [
      ...messages,
      { role: "assistant", content: message?.content ?? null, tool_calls: toolCalls },
      { role: "tool", tool_call_id: toolCall.id, content: toolResultText },
    ];
    nudged = false; // reset so the model gets a clean nudge opportunity after each tool round
  }

  // Turn limit reached — return the last text the model produced, if any.
  if (lastTextContent.trim()) return { content: lastTextContent, modelId };
  throw new Error(
    `Tool call limit reached without a final response after ${maxToolTurns} tool turns. ` +
    "Increase Settings → Context Compression → Tool loop limit, or set EMBER_PROVIDER_TOOL_LOOP_LIMIT (0 = very high cap).",
  );
}

async function streamOpenAiCompatible(
  provider: Provider,
  secrets: ProviderSecrets,
  request: ProviderExecutionRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderExecutionResult> {
  const baseUrl = resolveOpenAiBaseUrl(provider);
  if (!baseUrl) {
    throw new Error("OpenAI-compatible providers require a base URL.");
  }

  const modelId = pickModelId(provider, request.modelId);
  if (!modelId) {
    throw new Error("No model is assigned or discovered for this provider.");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const apiKey = secrets[provider.id]?.apiKey || provider.config.apiKey;
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  let messages: unknown[] = toOpenAiMessages(
    request.conversation,
    request.promptStack,
    request.content,
    request.memoryContext?.text ?? null,
    request.procedureContext?.text ?? null,
    request.purpose,
  );
  let totalContent = "";
  let totalThinking = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let nudged = false;
  let lastToolResultText = "";
  const promptBudget = resolveProviderToolLoopPromptBudget(provider, request.contextWindowTokens);
  const maxToolTurns = getProviderToolLoopLimit(provider, request.toolLoopLimit, request.contextWindowTokens);
  const monitor = new ToolLoopMonitor();
  let reportedCompaction = false;
  handlers.onStatus?.("Streaming response...");

  for (let turn = 0; turn < maxToolTurns; turn++) {
    const compacted = compactOpenAiMessagesForLoop({
      messages,
      tools: request.tools,
      promptBudget,
    });
    if (compacted.didCompact && !reportedCompaction) {
      handlers.onStatus?.("Compacting tool-loop history to stay within context window...");
      reportedCompaction = true;
    }
    messages = compacted.messages;

    const body: Record<string, unknown> = {
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
      messages,
    };

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        await buildProviderHttpError(
          response,
          `Provider responded with ${response.status}.`,
        ),
      );
    }

    if (!response.body) {
      throw new Error("No response body from provider.");
    }

    let buffer = "";
    let turnContent = "";
    let turnThinking = "";
    let finishReason = "";
    const contentFilter = new ToolCallStreamFilter();
    const thinkingFilter = new ToolCallStreamFilter();

    // Accumulate tool call fragments: stream index → accumulated call data.
    const toolCallAcc: Record<number, { id: string; name: string; arguments: string }> = {};

    await readResponseStream(response.body, (chunk) => {
      buffer += chunk.replace(/\r\n/g, "\n");
      buffer = processSseChunk(buffer, (data) => {
        if (data === "[DONE]") return;
        try {
          const payload = JSON.parse(data) as {
            choices?: Array<{
              delta?: Record<string, unknown>;
              finish_reason?: string | null;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
            };
          };

          // OpenAI sends usage in a final chunk when stream_options.include_usage is set
          if (payload.usage) {
            if (payload.usage.prompt_tokens) totalInputTokens += payload.usage.prompt_tokens;
            if (payload.usage.completion_tokens) totalOutputTokens += payload.usage.completion_tokens;
          }

          const choice = payload.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;

          // Accumulate streamed tool call fragments.
          const toolCallDeltas = delta?.tool_calls as Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }> | undefined;

          if (toolCallDeltas) {
            for (const tc of toolCallDeltas) {
              if (!toolCallAcc[tc.index]) {
                toolCallAcc[tc.index] = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
              } else {
                if (tc.id) toolCallAcc[tc.index].id = tc.id;
                if (tc.function?.name) toolCallAcc[tc.index].name += tc.function.name;
              }
              if (tc.function?.arguments) toolCallAcc[tc.index].arguments += tc.function.arguments;
            }
          }

          const thinkingDelta = extractOpenAiDeltaThinking(delta);
          if (thinkingDelta) {
            turnThinking += thinkingDelta;
            totalThinking += thinkingDelta;
            const safeThinking = thinkingFilter.push(thinkingDelta);
            if (safeThinking) handlers.onThinking?.(safeThinking);
          }

          const contentDelta = extractOpenAiDeltaContent(delta);
          if (contentDelta) {
            turnContent += contentDelta;
            // Filter out <tool_call> blocks before emitting to the client.
            const safe = contentFilter.push(contentDelta);
            if (safe) handlers.onContent?.(safe);
          }
        } catch {
          // Ignore malformed stream chunks.
        }
      });
    });

    // Flush any buffered content that turned out not to be a tool call.
    const drained = contentFilter.drain();
    if (drained) handlers.onContent?.(drained);
    const drainedThinking = thinkingFilter.drain();
    if (drainedThinking) handlers.onThinking?.(drainedThinking);

    totalContent += turnContent;

    // Emit usage after each turn
    if ((totalInputTokens > 0 || totalOutputTokens > 0) && handlers.onUsage) {
      handlers.onUsage(totalInputTokens, totalOutputTokens);
    }

    const toolCalls = Object.values(toolCallAcc);
    if (finishReason !== "tool_calls" || !toolCalls.length || !request.onToolCall) {
      // Fallback: parse text-based tool calls for models that don't use the OpenAI protocol.
      if (request.onToolCall && (turnContent || turnThinking)) {
        const textCalls = collectTextToolCalls(turnContent, turnThinking);
        if (textCalls.length > 0) {
          const cleanContent = stripTextToolCalls(turnContent);
          // Replace raw turn content in totalContent with the stripped version.
          totalContent = totalContent.slice(0, -turnContent.length) + cleanContent;
          const toolMessages: unknown[] = [];
          for (const tc of textCalls) {
            handlers.onStatus?.(`Tool: ${tc.name}`);
            const toolSignature = buildToolCallSignature(tc.name, tc.args);
            const loopCheck = monitor.record(toolSignature);
            if (loopCheck.action === "stop") {
              if (totalContent.trim()) {
                const cleanThinking = stripTextToolCalls(totalThinking).trim();
                const usage = (totalInputTokens > 0 || totalOutputTokens > 0) ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } : null;
                return { content: totalContent, modelId, thinking: cleanThinking || null, usage };
              }
              return { content: loopCheck.message, modelId };
            }
            const toolResultText = loopCheck.action === "warn"
              ? loopCheck.message
              : toolResultToText(await request.onToolCall(tc.name, tc.args));
            if (loopCheck.action === "ok") {
              lastToolResultText = toolResultText;
            }
            toolMessages.push({ role: "user", content: `<tool_response>\n${toolResultText}\n</tool_response>` });
          }
          messages = [...messages, { role: "assistant", content: cleanContent || null }, ...toolMessages];
          nudged = false;
          continue;
        }
      }

      if (!totalContent.trim()) {
        if (!nudged) {
          nudged = true;
          messages = [
            ...messages,
            { role: "user", content: FINAL_ANSWER_NUDGE },
          ];
          continue;
        }
        throw new Error("Provider returned an empty completion.");
      }
      const cleanThinking = stripTextToolCalls(totalThinking).trim();
      const usage = (totalInputTokens > 0 || totalOutputTokens > 0)
        ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
        : null;
      return { content: totalContent, modelId, thinking: cleanThinking || null, usage };
    }

    // Append assistant message with tool_calls, then execute each tool.
    const assistantMessage = {
      role: "assistant",
      content: turnContent || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };

    const toolMessages: unknown[] = [];
    for (const tc of toolCalls) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.arguments); } catch { /* leave empty on parse failure */ }
      handlers.onStatus?.(`Tool: ${tc.name}`);
      const toolSignature = buildToolCallSignature(tc.name, input);
      const loopCheck = monitor.record(toolSignature);
      if (loopCheck.action === "stop") {
        if (totalContent.trim()) {
          const cleanThinking = stripTextToolCalls(totalThinking).trim();
          const usage = (totalInputTokens > 0 || totalOutputTokens > 0) ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } : null;
          return { content: totalContent, modelId, thinking: cleanThinking || null, usage };
        }
        return { content: loopCheck.message, modelId };
      }
      let toolResultText: string;
      if (loopCheck.action === "warn") {
        toolResultText = loopCheck.message;
      } else {
        toolResultText = toolResultToText(await request.onToolCall(tc.name, input));
        lastToolResultText = toolResultText;
      }
      toolMessages.push({ role: "tool", tool_call_id: tc.id, content: toolResultText });
    }

    messages = [...messages, assistantMessage, ...toolMessages];
    nudged = false; // reset so the model gets a clean nudge opportunity after each tool round
  }

  // Turn limit reached — return whatever the model streamed so far.
  if (totalContent.trim()) {
    const cleanThinking = stripTextToolCalls(totalThinking).trim();
    const usage = (totalInputTokens > 0 || totalOutputTokens > 0)
      ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
      : null;
    return { content: totalContent, modelId, thinking: cleanThinking || null, usage };
  }
  throw new Error(
    `Tool call limit reached without a final response after ${maxToolTurns} tool turns. ` +
    "Increase Settings → Context Compression → Tool loop limit, or set EMBER_PROVIDER_TOOL_LOOP_LIMIT (0 = very high cap).",
  );
}

async function executeAnthropic(
  provider: Provider,
  secrets: ProviderSecrets,
  request: ProviderExecutionRequest,
): Promise<ProviderExecutionResult> {
  const apiKey = secrets[provider.id]?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Anthropic providers require an API key.");
  }

  const modelId = pickModelId(provider, request.modelId);
  if (!modelId) {
    throw new Error("No model is assigned or discovered for this provider.");
  }

  const systemPrompt = buildSystemPrompt(
    request.promptStack,
    request.memoryContext?.text ?? null,
    request.procedureContext?.text ?? null,
  );
  const maxTokens = request.tools?.length ? 4096 : 1200;
  let messages: unknown[] = toAnthropicMessages(request.conversation, request.content);
  let lastTextContent = "";
  let nudged = false;
  const promptBudget = resolveProviderToolLoopPromptBudget(provider, request.contextWindowTokens);
  const maxToolTurns = getProviderToolLoopLimit(provider, request.toolLoopLimit, request.contextWindowTokens);
  const monitor = new ToolLoopMonitor();

  for (let turn = 0; turn < maxToolTurns; turn++) {
    messages = compactAnthropicMessagesForLoop({
      systemPrompt,
      messages,
      tools: request.tools,
      promptBudget,
    }).messages;

    const body: Record<string, unknown> = {
      model: modelId,
      system: systemPrompt,
      max_tokens: maxTokens,
      messages,
    };

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic responded with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason?: string;
    };

    // Capture any text blocks alongside tool_use in this turn.
    const turnText = extractTextContent(payload.content);
    if (turnText.trim()) lastTextContent = turnText;

    const toolUseBlock = payload.content?.find((b) => b.type === "tool_use");

    if (!toolUseBlock || !request.onToolCall) {
      if (!lastTextContent.trim()) {
        // Model returned empty after tool use — nudge it once to synthesize a response.
        if (!nudged) {
          nudged = true;
          messages = [
            ...messages,
            { role: "user", content: FINAL_ANSWER_NUDGE },
          ];
          continue;
        }
        throw new Error("Provider returned an empty completion.");
      }
      return { content: lastTextContent, modelId };
    }

    // Check for repetition before executing the tool.
    const toolSignature = buildToolCallSignature(toolUseBlock.name!, toolUseBlock.input ?? {});
    const loopCheck = monitor.record(toolSignature);
    if (loopCheck.action === "stop") {
      if (lastTextContent.trim()) return { content: lastTextContent, modelId };
      return { content: loopCheck.message, modelId };
    }
    if (loopCheck.action === "warn") {
      messages = [
        ...messages,
        { role: "assistant", content: payload.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseBlock.id,
              content: loopCheck.message,
            },
          ],
        },
      ];
      continue;
    }

    // Execute tool and loop back with result.
    const toolResult = await request.onToolCall(toolUseBlock.name!, toolUseBlock.input ?? {});
    messages = [
      ...messages,
      { role: "assistant", content: payload.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: toolResultToAnthropicContent(toolResult),
          },
        ],
      },
    ];
  }

  // Turn limit reached — return the last text the model produced, if any.
  if (lastTextContent.trim()) return { content: lastTextContent, modelId };
  throw new Error(
    `Tool call limit reached without a final response after ${maxToolTurns} tool turns. ` +
    "Increase Settings → Context Compression → Tool loop limit, or set EMBER_PROVIDER_TOOL_LOOP_LIMIT (0 = very high cap).",
  );
}

async function streamAnthropic(
  provider: Provider,
  secrets: ProviderSecrets,
  request: ProviderExecutionRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderExecutionResult> {
  const apiKey = secrets[provider.id]?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Anthropic providers require an API key.");
  }

  const modelId = pickModelId(provider, request.modelId);
  if (!modelId) {
    throw new Error("No model is assigned or discovered for this provider.");
  }

  const systemPrompt = buildSystemPrompt(
    request.promptStack,
    request.memoryContext?.text ?? null,
    request.procedureContext?.text ?? null,
  );
  const maxTokens = request.tools?.length ? 4096 : 1200;
  let messages: unknown[] = toAnthropicMessages(request.conversation, request.content);
  let totalContent = "";
  let totalThinking = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let nudged = false;
  const promptBudget = resolveProviderToolLoopPromptBudget(provider, request.contextWindowTokens);
  const maxToolTurns = getProviderToolLoopLimit(provider, request.toolLoopLimit, request.contextWindowTokens);
  const monitor = new ToolLoopMonitor();
  let reportedCompaction = false;
  handlers.onStatus?.("Streaming response...");

  for (let turn = 0; turn < maxToolTurns; turn++) {
    const compacted = compactAnthropicMessagesForLoop({
      systemPrompt,
      messages,
      tools: request.tools,
      promptBudget,
    });
    if (compacted.didCompact && !reportedCompaction) {
      handlers.onStatus?.("Compacting tool-loop history to stay within context window...");
      reportedCompaction = true;
    }
    messages = compacted.messages;

    const body: Record<string, unknown> = {
      model: modelId,
      stream: true,
      system: systemPrompt,
      max_tokens: maxTokens,
      messages,
    };

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic responded with ${response.status}.`);
    }

    if (!response.body) {
      throw new Error("No response body from Anthropic.");
    }

    let buffer = "";
    let turnContent = "";
    let turnThinking = "";
    let stopReason = "";

    interface ToolBlock { id: string; name: string; inputJson: string }
    const toolBlocks: ToolBlock[] = [];
    let currentBlockType = "";
    let currentToolIdx = -1;

    await readResponseStream(response.body, (chunk) => {
      buffer += chunk.replace(/\r\n/g, "\n");
      buffer = processSseChunk(buffer, (data, eventName) => {
        if (data === "[DONE]") return;
        try {
          const payload = JSON.parse(data) as Record<string, unknown>;
          const type = eventName ?? (payload.type as string) ?? "";

          if (type === "message_start") {
            // Anthropic sends input token count in message_start
            const msg = payload.message as Record<string, unknown> | undefined;
            const msgUsage = msg?.usage as Record<string, unknown> | undefined;
            if (msgUsage) {
              const inp = (msgUsage.input_tokens as number) ?? 0;
              if (inp) totalInputTokens += inp;
            }
          } else if (type === "content_block_start") {
            const block = payload.content_block as Record<string, unknown>;
            currentBlockType = (block?.type as string) ?? "";
            if (currentBlockType === "tool_use") {
              toolBlocks.push({ id: block.id as string, name: block.name as string, inputJson: "" });
              currentToolIdx = toolBlocks.length - 1;
            }
          } else if (type === "content_block_delta") {
            const delta = payload.delta as Record<string, unknown>;
            if (delta?.type === "input_json_delta" && currentToolIdx >= 0) {
              toolBlocks[currentToolIdx].inputJson += (delta.partial_json as string) ?? "";
            } else if (delta?.type === "text_delta") {
              const text = (delta.text as string) ?? "";
              if (text) {
                turnContent += text;
                handlers.onContent?.(text);
              }
            } else if (delta?.type === "thinking_delta") {
              const text = (delta.thinking as string) ?? "";
              if (text) {
                turnThinking += text;
                handlers.onThinking?.(text);
              }
            }
          } else if (type === "message_delta") {
            const delta = payload.delta as Record<string, unknown>;
            if (delta?.stop_reason) stopReason = delta.stop_reason as string;
            // Anthropic sends output token count in message_delta
            const deltaUsage = payload.usage as Record<string, unknown> | undefined;
            if (deltaUsage) {
              const out = (deltaUsage.output_tokens as number) ?? 0;
              if (out) totalOutputTokens += out;
            }
          }
        } catch {
          // Ignore malformed stream chunks.
        }
      });
    });

    totalContent += turnContent;
    totalThinking += turnThinking;

    // Emit usage after each turn so the client can show live token counts
    if ((totalInputTokens > 0 || totalOutputTokens > 0) && handlers.onUsage) {
      handlers.onUsage(totalInputTokens, totalOutputTokens);
    }

    if (stopReason !== "tool_use" || !toolBlocks.length || !request.onToolCall) {
      if (!totalContent.trim()) {
        if (!nudged) {
          nudged = true;
          messages = [
            ...messages,
            { role: "user", content: FINAL_ANSWER_NUDGE },
          ];
          continue;
        }
        throw new Error("Provider returned an empty completion.");
      }
      const usage = (totalInputTokens > 0 || totalOutputTokens > 0)
        ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
        : null;
      return { content: totalContent, modelId, thinking: totalThinking || null, usage };
    }

    // Build assistant message with any text + tool_use blocks, then execute tools.
    const assistantContent: unknown[] = [];
    if (turnContent) assistantContent.push({ type: "text", text: turnContent });

    const toolResults: unknown[] = [];
    for (const tb of toolBlocks) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tb.inputJson); } catch { /* leave empty on parse failure */ }

      const toolSignature = buildToolCallSignature(tb.name, input);
      const loopCheck = monitor.record(toolSignature);
      if (loopCheck.action === "stop") {
        if (totalContent.trim()) {
          const usage = (totalInputTokens > 0 || totalOutputTokens > 0) ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } : null;
          return { content: totalContent, modelId, thinking: totalThinking || null, usage };
        }
        return { content: loopCheck.message, modelId };
      }

      assistantContent.push({ type: "tool_use", id: tb.id, name: tb.name, input });
      handlers.onStatus?.(`Tool: ${tb.name}`);

      if (loopCheck.action === "warn") {
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: loopCheck.message });
      } else {
        const result = await request.onToolCall(tb.name, input);
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: toolResultToAnthropicContent(result) });
      }
    }

    messages = [
      ...messages,
      { role: "assistant", content: assistantContent },
      { role: "user", content: toolResults },
    ];

    // Reset tool tracking for next turn.
    toolBlocks.length = 0;
    currentToolIdx = -1;
  }

  // Turn limit reached — return whatever the model streamed so far.
  if (totalContent.trim()) {
    const usage = (totalInputTokens > 0 || totalOutputTokens > 0)
      ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
      : null;
    return { content: totalContent, modelId, thinking: totalThinking || null, usage };
  }
  throw new Error(
    `Tool call limit reached without a final response after ${maxToolTurns} tool turns. ` +
    "Increase Settings → Context Compression → Tool loop limit, or set EMBER_PROVIDER_TOOL_LOOP_LIMIT (0 = very high cap).",
  );
}

export async function recheckProvider(
  provider: Provider,
  secrets: ProviderSecrets,
): Promise<RecheckResult> {
  switch (provider.typeId) {
    case "codex-cli":
      return readCodexCliStatus();
    case "anthropic-api":
      return testAnthropicApi(provider, secrets);
    case "openai-compatible":
      return testOpenAiCompatible(provider, secrets);
  }
}

export function launchProviderConnect(provider: Provider): RecheckResult {
  switch (provider.typeId) {
    case "codex-cli":
      if (!commandExists("codex")) {
        return {
          status: "missing",
          lastError: "codex is not installed locally.",
          availableModels: [],
        };
      }
      spawn("codex", ["login"], { detached: true, stdio: "ignore" }).unref();
      return {
        status: "needs-auth",
        lastError: "Codex login launched.",
        availableModels: [],
      };
    case "anthropic-api":
      return {
        status: "idle",
        lastError: "Save an API key and run recheck.",
        availableModels: [],
      };
    case "openai-compatible":
      return {
        status: "idle",
        lastError: "Save the endpoint and run recheck.",
        availableModels: [],
      };
  }
}

export function providerCanChat(provider: Provider): boolean {
  return provider.capabilities.canChat;
}

export function providerCapabilitiesForType(provider: Provider) {
  return provider.capabilities ?? getProviderCapabilities(provider.typeId);
}

export async function executeProviderChat(
  provider: Provider,
  secrets: ProviderSecrets,
  request: ProviderExecutionRequest,
): Promise<ProviderExecutionResult> {
  if (!providerCanChat(provider)) {
    throw new Error("This provider can connect but is not chat-capable yet.");
  }

  switch (provider.typeId) {
    case "anthropic-api":
      return executeAnthropic(provider, secrets, request);
    case "openai-compatible":
      return executeOpenAiCompatible(provider, secrets, request);
    case "codex-cli":
      return executeCodexCli(provider, request);
  }
}

export async function streamProviderChat(
  provider: Provider,
  secrets: ProviderSecrets,
  request: ProviderExecutionRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderExecutionResult> {
  if (!providerCanChat(provider)) {
    throw new Error("This provider can connect but is not chat-capable yet.");
  }

  switch (provider.typeId) {
    case "anthropic-api":
      return streamAnthropic(provider, secrets, request, handlers);
    case "openai-compatible":
      return streamOpenAiCompatible(provider, secrets, request, handlers);
    case "codex-cli":
      return streamCodexCli(provider, request, handlers);
  }
}
