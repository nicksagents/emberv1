import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function buildSystemPrompt(stack: PromptStack): string {
  return [stack.shared, stack.role, stack.tools].filter(Boolean).join("\n\n");
}

function toOpenAiMessages(
  conversation: ChatMessage[],
  promptStack: PromptStack,
  content: string,
  purpose: "chat" | "route" = "chat",
) {
  const systemContent = buildSystemPrompt(promptStack);

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

function withCliAttachmentLabels(message: ChatMessage): string {
  const attachments = getImageAttachments(message);
  if (attachments.length === 0) {
    return message.content;
  }

  const label = `Attached images: ${attachments
    .map((attachment) => attachment.name.trim() || attachment.id)
    .join(", ")}`;

  return message.content.trim() ? `${message.content}\n[${label}]` : `[${label}]`;
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
  const systemParts = [promptStack.shared, promptStack.role, promptStack.tools].filter(Boolean);

  if (purpose === "route") {
    return [...systemParts, `User: ${content}`].join("\n\n");
  }

  const recentConversation = conversation.slice(-10);
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
    transcript ? `Conversation so far:\n${transcript}` : "",
    ...(alreadyHasLatest ? [] : [`User: ${content}`]),
    "Respond as the assigned role. Keep the answer direct and user-facing.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const CODEX_TOOL_CALL_TAG = "ember_tool_call";

interface ParsedCliToolCall {
  name: string;
  input: Record<string, unknown>;
}

function buildCodexToolProtocol(tools: ToolDefinition[]): string {
  if (!tools.length) {
    return "";
  }

  const toolLines = tools.map((tool) => {
    const fields = Object.entries(tool.inputSchema.properties)
      .map(([name, spec]) => `${name}: ${spec.type}`)
      .join(", ");
    return `- ${tool.name}(${fields || "no arguments"}) — ${tool.description}`;
  });

  return [
    "## EMBER tool protocol",
    "When you need an EMBER tool, respond with exactly one tool call block and no extra prose:",
    `<${CODEX_TOOL_CALL_TAG}>`,
    '{"name":"read_file","input":{"path":"packages/core/src/types.ts"}}',
    `</${CODEX_TOOL_CALL_TAG}>`,
    "Use only the tool names listed below and ensure the JSON is valid.",
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
    request.purpose,
  );
  const toolProtocol = buildCodexToolProtocol(request.tools ?? []);
  return [basePrompt, toolProtocol].filter(Boolean).join("\n\n");
}

function parseCodexToolCall(content: string): { call: ParsedCliToolCall | null; error: string | null } {
  const matches = [
    ...content.matchAll(
      new RegExp(`<${CODEX_TOOL_CALL_TAG}>\\s*([\\s\\S]*?)\\s*</${CODEX_TOOL_CALL_TAG}>`, "gi"),
    ),
  ];
  const rawPayload = matches.at(-1)?.[1]?.trim();
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

function collectRecentCliImages(conversation: ChatMessage[]): ChatAttachment[] {
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
  handlers?: Pick<ProviderStreamHandlers, "onStatus">,
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

    if (stderr) {
      const status = stripAnsi(stderr).trim();
      if (status && shouldSurfaceCodexStatus(status)) {
        handlers?.onStatus?.(status);
      }
    }

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
  } finally {
    await imageFiles.cleanup();
  }
}

async function executeCodexCli(
  provider: Provider,
  request: ProviderExecutionRequest,
  handlers?: Pick<ProviderStreamHandlers, "onStatus">,
): Promise<ProviderExecutionResult> {
  let conversation = [...request.conversation];
  let currentContent = request.content;
  let lastContent = "";
  let modelId = request.modelId?.trim() || provider.config.defaultModelId?.trim() || null;

  for (let turn = 0; turn < 10; turn++) {
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
    const toolResult = await request.onToolCall(parsed.call!.name, parsed.call!.input);
    currentContent = `Tool result for ${parsed.call!.name}:\n${toolResultToText(toolResult)}`;
    conversation.push(buildSyntheticCliMessage("user", currentContent, request));
  }

  if (lastContent.trim()) {
    return { content: lastContent, modelId };
  }

  throw new Error("Codex tool loop reached the turn limit without a final response.");
}

async function streamCodexCli(
  provider: Provider,
  request: ProviderExecutionRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderExecutionResult> {
  const result = await executeCodexCli(provider, request, { onStatus: handlers.onStatus });
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
    request.purpose,
  );

  let lastTextContent = "";
  let nudged = false;

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

    // Capture any text the model produced alongside or instead of tool calls.
    const turnText = extractTextContent(message?.content);
    if (turnText.trim()) lastTextContent = turnText;

    if (!toolCalls?.length || !request.onToolCall) {
      if (!lastTextContent.trim()) {
        // Model returned empty after tool use — nudge it once to synthesize a response.
        if (!nudged) {
          nudged = true;
          messages = [
            ...messages,
            { role: "user", content: "Based on the information above, please provide your final answer." },
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
    const toolResult = await request.onToolCall(toolCall.function.name, toolInput);
    messages = [
      ...messages,
      { role: "assistant", content: message?.content ?? null, tool_calls: toolCalls },
      { role: "tool", tool_call_id: toolCall.id, content: toolResultToText(toolResult) },
    ];
    nudged = false; // reset so the model gets a clean nudge opportunity after each tool round
  }

  // Turn limit reached — return the last text the model produced, if any.
  if (lastTextContent.trim()) return { content: lastTextContent, modelId };
  throw new Error("Tool call limit reached without a final response.");
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
    request.purpose,
  );
  let totalContent = "";
  let totalThinking = "";
  let nudged = false;
  handlers.onStatus?.("Streaming response...");

  for (let turn = 0; turn < 10; turn++) {
    const body: Record<string, unknown> = { model: modelId, stream: true, messages };

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

    if (!response.body) {
      throw new Error("No response body from provider.");
    }

    let buffer = "";
    let turnContent = "";
    let finishReason = "";

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
          };

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
            totalThinking += thinkingDelta;
            handlers.onThinking?.(thinkingDelta);
          }

          const contentDelta = extractOpenAiDeltaContent(delta);
          if (contentDelta) {
            turnContent += contentDelta;
            handlers.onContent?.(contentDelta);
          }
        } catch {
          // Ignore malformed stream chunks.
        }
      });
    });

    totalContent += turnContent;

    const toolCalls = Object.values(toolCallAcc);
    if (finishReason !== "tool_calls" || !toolCalls.length || !request.onToolCall) {
      if (!totalContent.trim()) {
        if (!nudged) {
          nudged = true;
          messages = [
            ...messages,
            { role: "user", content: "Based on the information above, please provide your final answer." },
          ];
          continue;
        }
        throw new Error("Provider returned an empty completion.");
      }
      return { content: totalContent, modelId, thinking: totalThinking || null };
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
      const result = await request.onToolCall(tc.name, input);
      toolMessages.push({ role: "tool", tool_call_id: tc.id, content: toolResultToText(result) });
    }

    messages = [...messages, assistantMessage, ...toolMessages];
    nudged = false; // reset so the model gets a clean nudge opportunity after each tool round
  }

  // Turn limit reached — return whatever the model streamed so far.
  if (totalContent.trim()) return { content: totalContent, modelId, thinking: totalThinking || null };
  throw new Error("Tool call limit reached without a final response.");
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

  const systemPrompt = buildSystemPrompt(request.promptStack);
  const maxTokens = request.tools?.length ? 4096 : 1200;
  let messages: unknown[] = toAnthropicMessages(request.conversation, request.content);
  let lastTextContent = "";
  let nudged = false;

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
            { role: "user", content: "Based on the information above, please provide your final answer." },
          ];
          continue;
        }
        throw new Error("Provider returned an empty completion.");
      }
      return { content: lastTextContent, modelId };
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
  throw new Error("Tool call limit reached without a final response.");
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

  const systemPrompt = buildSystemPrompt(request.promptStack);
  const maxTokens = request.tools?.length ? 4096 : 1200;
  let messages: unknown[] = toAnthropicMessages(request.conversation, request.content);
  let totalContent = "";
  let totalThinking = "";
  let nudged = false;
  handlers.onStatus?.("Streaming response...");

  for (let turn = 0; turn < 10; turn++) {
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

          if (type === "content_block_start") {
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
          }
        } catch {
          // Ignore malformed stream chunks.
        }
      });
    });

    totalContent += turnContent;
    totalThinking += turnThinking;

    if (stopReason !== "tool_use" || !toolBlocks.length || !request.onToolCall) {
      if (!totalContent.trim()) {
        if (!nudged) {
          nudged = true;
          messages = [
            ...messages,
            { role: "user", content: "Based on the information above, please provide your final answer." },
          ];
          continue;
        }
        throw new Error("Provider returned an empty completion.");
      }
      return { content: totalContent, modelId, thinking: totalThinking || null };
    }

    // Build assistant message with any text + tool_use blocks, then execute tools.
    const assistantContent: unknown[] = [];
    if (turnContent) assistantContent.push({ type: "text", text: turnContent });

    const toolResults: unknown[] = [];
    for (const tb of toolBlocks) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tb.inputJson); } catch { /* leave empty on parse failure */ }
      assistantContent.push({ type: "tool_use", id: tb.id, name: tb.name, input });
      handlers.onStatus?.(`Tool: ${tb.name}`);
      const result = await request.onToolCall(tb.name, input);
      toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: toolResultToAnthropicContent(result) });
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
  if (totalContent.trim()) return { content: totalContent, modelId, thinking: totalThinking || null };
  throw new Error("Tool call limit reached without a final response.");
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
