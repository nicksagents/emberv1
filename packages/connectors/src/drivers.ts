import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import {
  type ChatAttachment,
  type ConnectorTypeId,
  getProviderCapabilities,
  type ChatMessage,
  type PromptStack,
  type Provider,
  type ProviderExecutionRequest,
  type ProviderExecutionResult,
  type ProviderSecrets,
  type ProviderStatus,
} from "@ember/core";

interface ProviderStreamHandlers {
  onStatus?: (message: string) => void;
  onThinking?: (text: string) => void;
  onContent?: (text: string) => void;
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

interface ClaudeStatsCache {
  modelUsage?: Record<string, unknown>;
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

function normalizeClaudeModelId(value: string): string {
  return value.trim().toLowerCase().replace(/\./g, "-").replace(/-+/g, "-");
}

function isSupportedClaudeModel(value: string): boolean {
  return /^(claude-(?:sonnet|opus|haiku)-\d+(?:-\d+)*(?:-\d{8})?(?:-v\d+)?)$/.test(
    value,
  );
}

function sortClaudeModels(values: string[]): string[] {
  const aliases = ["sonnet", "opus", "haiku"];
  const aliasSet = new Set(aliases);
  const uniqueValues = unique(values);

  const aliasValues = aliases.filter((alias) => uniqueValues.includes(alias));
  const versionedValues = uniqueValues
    .filter((value) => !aliasSet.has(value))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  return [...aliasValues, ...versionedValues];
}

function readClaudeModelsFromStats(): string[] {
  const statsPath = path.join(os.homedir(), ".claude", "stats-cache.json");
  const stats = readJsonFile<ClaudeStatsCache>(statsPath);

  return Object.keys(stats?.modelUsage ?? {})
    .map(normalizeClaudeModelId)
    .filter(isSupportedClaudeModel);
}

function readClaudeModelsFromBinary(): string[] {
  const commandPath = resolveCommandPath("claude");
  if (!commandPath || !commandExists("strings")) {
    return [];
  }

  const result = spawnSync("strings", [commandPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    return [];
  }

  const matches =
    result.stdout.match(/\b(?:claude-(?:sonnet|opus|haiku)-[a-z0-9.-]+|sonnet|opus|haiku)\b/gi) ??
    [];

  return matches
    .map(normalizeClaudeModelId)
    .filter(
      (value) =>
        value === "sonnet" ||
        value === "opus" ||
        value === "haiku" ||
        isSupportedClaudeModel(value),
    );
}

function readCliModels(command: "codex" | "claude"): string[] {
  if (command === "codex") {
    return unique(readCodexModels());
  }

  return sortClaudeModels([
    ...readClaudeModelsFromBinary(),
    ...readClaudeModelsFromStats(),
  ]);
}

export function getConnectorModelCatalog(): Partial<Record<ConnectorTypeId, string[]>> {
  return {
    "codex-cli": readCliModels("codex"),
    "claude-code-cli": readCliModels("claude"),
  };
}

function readCliStatus(command: "codex" | "claude"): RecheckResult {
  const availableModels = readCliModels(command);

  if (!commandExists(command)) {
    return {
      status: "missing",
      lastError: `${command} is not installed locally.`,
      availableModels,
    };
  }

  const statusChecks =
    command === "codex"
      ? [
          ["login", "status"],
          ["auth", "status"],
        ]
      : [
          ["auth", "status"],
          ["login", "status"],
        ];

  for (const args of statusChecks) {
    const authResult = runStatusCommand(command, args);

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
          combined || `${command} is installed but not authenticated.`,
        availableModels,
      };
    }
  }

  return {
    status: "needs-auth",
    lastError: `${command} is installed but EMBER could not confirm the login state with this CLI version.`,
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

function toOpenAiMessages(
  conversation: ChatMessage[],
  promptStack: PromptStack,
  content: string,
  purpose: "chat" | "route" = "chat",
) {
  const systemContent = [promptStack.shared, promptStack.role].filter(Boolean).join("\n\n");

  if (purpose === "route") {
    return [
      { role: "system", content: systemContent },
      { role: "user", content },
    ];
  }

  const recentConversation = conversation.slice(-12);
  const alreadyHasLatest =
    recentConversation.at(-1)?.role === "user" &&
    recentConversation.at(-1)?.content.trim() === content.trim();

  return [
    { role: "system", content: systemContent },
    ...recentConversation.map((message) => toOpenAiMessage(message)),
    ...(alreadyHasLatest ? [] : [{ role: "user", content }]),
  ];
}

function toAnthropicMessages(conversation: ChatMessage[], content: string) {
  const recentConversation = conversation.slice(-12);
  const alreadyHasLatest =
    recentConversation.at(-1)?.role === "user" &&
    recentConversation.at(-1)?.content.trim() === content.trim();

  return [
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

function getImageAttachments(message: ChatMessage): ChatAttachment[] {
  return (message.attachments ?? []).filter((attachment) => attachment.kind === "image");
}

function toOpenAiUserContent(message: ChatMessage) {
  const attachments = getImageAttachments(message);
  if (attachments.length === 0) {
    return message.content;
  }

  return [
    ...(message.content.trim()
      ? [{ type: "text", text: message.content }]
      : []),
    ...attachments.map((attachment) => ({
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
  const attachments = getImageAttachments(message);
  if (attachments.length === 0) {
    return message.content;
  }

  return [
    ...(message.content.trim()
      ? [{ type: "text", text: message.content }]
      : []),
    ...attachments.flatMap((attachment) => {
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
  purpose: "chat" | "route" = "chat",
): string {
  const systemParts = [promptStack.shared, promptStack.role].filter(Boolean);

  if (purpose === "route") {
    return [...systemParts, `User: ${content}`].join("\n\n");
  }

  const recentConversation = conversation.slice(-10);
  const transcript = recentConversation
    .map((message) => {
      const speaker = message.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${message.content}`;
    })
    .join("\n\n");

  return [
    ...systemParts,
    transcript ? `Conversation so far:\n${transcript}` : "",
    `User: ${content}`,
    "Respond as the assigned role. Keep the answer direct and user-facing.",
  ]
    .filter(Boolean)
    .join("\n\n");
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

async function executeCodexCli(
  provider: Provider,
  request: ProviderExecutionRequest,
): Promise<ProviderExecutionResult> {
  if (!commandExists("codex")) {
    throw new Error("codex is not installed locally.");
  }

  const modelId = request.modelId?.trim() || provider.config.defaultModelId?.trim() || null;
  const prompt = formatCliConversation(
    request.conversation,
    request.promptStack,
    request.content,
    request.purpose,
  );
  const repoRoot = process.env.EMBER_ROOT
    ? path.resolve(process.env.EMBER_ROOT)
    : process.cwd();
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--json",
    ...(modelId ? ["-m", modelId] : []),
    prompt,
  ];

  const result = spawnSync("codex", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OTEL_SDK_DISABLED: "true",
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  const content = parseCodexExecJson(stdout);

  if (result.status !== 0 && !content) {
    throw new Error(stderr || stdout || "Codex exec failed.");
  }

  if (!content) {
    throw new Error("Codex returned an empty response.");
  }

  return {
    content,
    modelId,
  };
}

async function streamCodexCli(
  provider: Provider,
  request: ProviderExecutionRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderExecutionResult> {
  if (!commandExists("codex")) {
    throw new Error("codex is not installed locally.");
  }

  const modelId = request.modelId?.trim() || provider.config.defaultModelId?.trim() || null;
  const prompt = formatCliConversation(
    request.conversation,
    request.promptStack,
    request.content,
    request.purpose,
  );
  const repoRoot = process.env.EMBER_ROOT
    ? path.resolve(process.env.EMBER_ROOT)
    : process.cwd();
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--json",
    ...(modelId ? ["-m", modelId] : []),
    prompt,
  ];

  handlers.onStatus?.("Launching Codex CLI...");

  return await new Promise<ProviderExecutionResult>((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        OTEL_SDK_DISABLED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let fullStdout = "";
    let content = "";
    let thinking = "";

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        return;
      }

      try {
        const event = JSON.parse(trimmed) as {
          type?: string;
          delta?: unknown;
          text?: unknown;
          item?: { type?: string; text?: string; delta?: unknown; content?: unknown };
        };
        const eventType = event.type ?? "";
        const itemType = event.item?.type ?? "";

        const thinkingText =
          /thinking|reason/i.test(eventType) || /thinking|reason/i.test(itemType)
            ? extractNestedText(event.delta ?? event.text ?? event.item?.delta ?? event.item?.content ?? event.item?.text)
            : "";
        if (thinkingText) {
          thinking += thinkingText;
          handlers.onThinking?.(thinkingText);
          return;
        }

        if (/agent_message/i.test(itemType)) {
          const completedText = event.item?.text?.trim() ?? "";
          if (completedText) {
            if (!content) {
              content = completedText;
              handlers.onContent?.(completedText);
            } else if (completedText.startsWith(content)) {
              const delta = completedText.slice(content.length);
              if (delta) {
                content = completedText;
                handlers.onContent?.(delta);
              }
            } else if (completedText !== content) {
              const delta = completedText;
              content = completedText;
              handlers.onContent?.(delta);
            }
          }
        }
      } catch {
        // Ignore non-JSON or unknown event lines from the CLI.
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      fullStdout += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      const message = stripAnsi(chunk).trim();
      if (message && shouldSurfaceCodexStatus(message)) {
        handlers.onStatus?.(message);
      }
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer);
      }

      if (!content) {
        const parsed = parseCodexExecJson(`${fullStdout}\n${stdoutBuffer}`);
        if (parsed) {
          content = parsed;
          handlers.onContent?.(parsed);
        }
      }

      if (code !== 0 && !content) {
        reject(new Error(stderrBuffer.trim() || "Codex exec failed."));
        return;
      }

      if (!content.trim()) {
        reject(new Error("Codex returned an empty response."));
        return;
      }

      resolve({
        content,
        modelId,
        thinking: thinking || null,
      });
    });
  });
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
    request.purpose,
  );

  for (let turn = 0; turn < 10; turn++) {
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
      throw new Error(`Provider responded with ${response.status}.`);
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

    if (!toolCalls?.length || !request.onToolCall) {
      const content = extractTextContent(message?.content);
      if (!content.trim()) {
        throw new Error("Provider returned an empty completion.");
      }
      return { content, modelId };
    }

    // Execute the first tool call and loop back with result.
    const toolCall = toolCalls[0];
    let toolInput: Record<string, unknown> = {};
    try {
      toolInput = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch {
      // Leave input empty on parse failure.
    }
    const toolResult = await request.onToolCall(toolCall.function.name, toolInput);
    messages = [
      ...messages,
      { role: "assistant", content: null, tool_calls: toolCalls },
      { role: "tool", tool_call_id: toolCall.id, content: toolResult },
    ];
  }

  throw new Error("Tool call limit reached (10 turns) without a final response.");
}

async function streamOpenAiCompatible(
  provider: Provider,
  secrets: ProviderSecrets,
  request: ProviderExecutionRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderExecutionResult> {
  // When tools are enabled, use the non-streaming path so the tool loop works cleanly.
  if (request.tools?.length && request.onToolCall) {
    handlers.onStatus?.("Running with tool access...");
    const result = await executeOpenAiCompatible(provider, secrets, request);
    return result;
  }

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

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      stream: true,
      messages: toOpenAiMessages(
        request.conversation,
        request.promptStack,
        request.content,
        request.purpose,
      ),
    }),
  });

  if (!response.ok) {
    throw new Error(`Provider responded with ${response.status}.`);
  }

  if (!response.body) {
    return executeOpenAiCompatible(provider, secrets, request);
  }

  let buffer = "";
  let content = "";
  let thinking = "";
  handlers.onStatus?.("Streaming response...");

  await readResponseStream(response.body, (chunk) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    buffer = processSseChunk(buffer, (data) => {
      if (data === "[DONE]") {
        return;
      }

      try {
        const payload = JSON.parse(data) as {
          model?: string;
          choices?: Array<{
            delta?: Record<string, unknown>;
          }>;
        };

        const delta = payload.choices?.[0]?.delta;
        const thinkingDelta = extractOpenAiDeltaThinking(delta);
        if (thinkingDelta) {
          thinking += thinkingDelta;
          handlers.onThinking?.(thinkingDelta);
        }

        const contentDelta = extractOpenAiDeltaContent(delta);
        if (contentDelta) {
          content += contentDelta;
          handlers.onContent?.(contentDelta);
        }
      } catch {
        // Ignore malformed stream chunks.
      }
    });
  });

  if (!content.trim()) {
    throw new Error("Provider returned an empty completion.");
  }

  return {
    content,
    modelId,
    thinking: thinking || null,
  };
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

  const systemPrompt = `${request.promptStack.shared}\n\n${request.promptStack.role}`;
  const maxTokens = request.tools?.length ? 4096 : 1200;
  let messages: unknown[] = toAnthropicMessages(request.conversation, request.content);

  for (let turn = 0; turn < 10; turn++) {
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

    const toolUseBlock = payload.content?.find((b) => b.type === "tool_use");

    if (!toolUseBlock || !request.onToolCall) {
      const content = extractTextContent(payload.content);
      if (!content.trim()) {
        throw new Error("Anthropic returned an empty completion.");
      }
      return { content, modelId };
    }

    // Execute tool and loop back with result.
    const toolResult = await request.onToolCall(toolUseBlock.name!, toolUseBlock.input ?? {});
    messages = [
      ...messages,
      { role: "assistant", content: payload.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseBlock.id, content: toolResult }] },
    ];
  }

  throw new Error("Tool call limit reached (10 turns) without a final response.");
}

async function streamAnthropic(
  provider: Provider,
  secrets: ProviderSecrets,
  request: ProviderExecutionRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderExecutionResult> {
  // When tools are enabled, use the non-streaming path so the tool loop works
  // cleanly. Status updates are still emitted around the call.
  if (request.tools?.length && request.onToolCall) {
    handlers.onStatus?.("Running with tool access...");
    const result = await executeAnthropic(provider, secrets, request);
    return result;
  }

  const apiKey = secrets[provider.id]?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Anthropic providers require an API key.");
  }

  const modelId = pickModelId(provider, request.modelId);
  if (!modelId) {
    throw new Error("No model is assigned or discovered for this provider.");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: modelId,
      stream: true,
      system: `${request.promptStack.shared}\n\n${request.promptStack.role}`,
      max_tokens: 1200,
      messages: toAnthropicMessages(request.conversation, request.content),
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic responded with ${response.status}.`);
  }

  if (!response.body) {
    return executeAnthropic(provider, secrets, request);
  }

  let buffer = "";
  let content = "";
  let thinking = "";
  handlers.onStatus?.("Streaming response...");

  await readResponseStream(response.body, (chunk) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    buffer = processSseChunk(buffer, (data, eventName) => {
      if (data === "[DONE]") {
        return;
      }

      try {
        const payload = JSON.parse(data) as {
          type?: string;
          delta?: { text?: string; thinking?: string };
        };

        const type = eventName ?? payload.type ?? "";
        if (type === "content_block_delta" || type === "message_delta") {
          const thinkingDelta = payload.delta?.thinking?.trim() ?? "";
          if (thinkingDelta) {
            thinking += thinkingDelta;
            handlers.onThinking?.(thinkingDelta);
          }

          const textDelta = payload.delta?.text ?? "";
          if (textDelta) {
            content += textDelta;
            handlers.onContent?.(textDelta);
          }
        }
      } catch {
        // Ignore malformed stream chunks.
      }
    });
  });

  if (!content.trim()) {
    throw new Error("Anthropic returned an empty completion.");
  }

  return {
    content,
    modelId,
    thinking: thinking || null,
  };
}

export async function recheckProvider(
  provider: Provider,
  secrets: ProviderSecrets,
): Promise<RecheckResult> {
  switch (provider.typeId) {
    case "codex-cli":
      return readCliStatus("codex");
    case "claude-code-cli":
      return readCliStatus("claude");
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
    case "claude-code-cli":
      if (!commandExists("claude")) {
        return {
          status: "missing",
          lastError: "claude is not installed locally.",
          availableModels: [],
        };
      }
      spawn("claude", ["login"], { detached: true, stdio: "ignore" }).unref();
      return {
        status: "needs-auth",
        lastError: "Claude Code login launched.",
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
    case "claude-code-cli":
      throw new Error(
        "CLI providers are auth-capable in this phase but not yet wired into role execution.",
      );
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
    case "claude-code-cli":
      throw new Error(
        "CLI providers are auth-capable in this phase but not yet wired into role execution.",
      );
  }
}
