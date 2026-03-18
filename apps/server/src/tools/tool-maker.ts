/**
 * Tool-maker — lets the agent create, register, list, and delete custom tools at runtime.
 *
 * create_tool: define a new tool with name, description, schema, and JavaScript code.
 *   The tool is immediately available and persisted for future sessions.
 *
 * Persistence: tools are saved as JSON files in ~/.ember/custom-tools/<name>.json
 * and .ember/custom-tools/<name>.json (project scope).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import { Worker } from "node:worker_threads";
import type { ToolResult } from "@ember/core";
import type { EmberTool } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface CustomToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** JavaScript function body. Receives `input` (Record<string, unknown>).
   *  Must return a string or { text, imageBase64?, imageMimeType? }.
   *  Has access to: fetch, setTimeout, JSON, Math, Date, console, Buffer,
   *  URL, URLSearchParams, RegExp, Array, Object, Map, Set, Promise,
   *  TextEncoder, TextDecoder. */
  code: string;
  /** When the tool was created (ISO string). */
  createdAt: string;
  /** Ember roles that can use this tool. */
  roles: string[];
  /** Scope: user (global) or project. */
  scope: "user" | "project";
}

const CUSTOM_TOOL_SCOPE_BY_NAME = new Map<string, "user" | "project">();

// ── Context for dynamic registration ─────────────────────────────────────────

export interface ToolMakerContext {
  /** Register a dynamically-created tool into the live registry + role maps. */
  registerCustomTool: (tool: EmberTool, roles: string[]) => void;
  /** Remove a tool from the live registry. */
  unregisterCustomTool: (name: string) => void;
  /** The workspace directory (for project-scoped tools). */
  workspaceDir: string;
}

let makerContext: ToolMakerContext | null = null;

export function setToolMakerContext(ctx: ToolMakerContext): void {
  makerContext = ctx;
}

// ── Directories ──────────────────────────────────────────────────────────────

function getUserToolDir(): string {
  return path.join(os.homedir(), ".ember", "custom-tools");
}

function getProjectToolDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".ember", "custom-tools");
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Sandboxed execution ──────────────────────────────────────────────────────

const DEFAULT_CUSTOM_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_CUSTOM_TOOL_MEMORY_MB = 96;

const TOOL_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

function normalizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function run() {
  const { code, toolName, input } = workerData;
  const wrappedCode = \`
    "use strict";
    (async function executeCustomTool(input) {
      \${code}
    })
  \`;
  const context = vm.createContext({
    JSON,
    Math,
    Date,
    RegExp,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    Number,
    String,
    Boolean,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    URIError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    __toolName: toolName,
  });
  const script = new vm.Script(wrappedCode, {
    filename: \`custom-tool:\${toolName}\`,
  });
  const executeFn = script.runInContext(context, { timeout: 3_000 });
  const result = await executeFn(input);
  parentPort.postMessage({ ok: true, result });
}

run().catch((error) => {
  parentPort.postMessage({
    ok: false,
    error: normalizeError(error),
  });
});
`;

async function runToolInWorker(options: {
  code: string;
  toolName: string;
  input: Record<string, unknown>;
}): Promise<unknown> {
  const customToolTimeoutMs = resolveCustomToolTimeoutMs();
  const customToolMemoryMb = resolveCustomToolMemoryMb();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(TOOL_WORKER_SOURCE, {
      eval: true,
      workerData: {
        code: options.code,
        toolName: options.toolName,
        input: options.input,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: customToolMemoryMb,
      },
    });

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      handler();
      void worker.terminate().catch(() => {
        // Ignore worker shutdown errors.
      });
    };

    const timeoutHandle = setTimeout(() => {
      finish(() => reject(new Error(`Custom tool timed out after ${customToolTimeoutMs}ms.`)));
    }, customToolTimeoutMs);

    worker.once("message", (payload: { ok?: boolean; error?: string; result?: unknown }) => {
      finish(() => {
        if (!payload?.ok) {
          reject(new Error(payload?.error ?? "Custom tool execution failed."));
          return;
        }
        resolve(payload.result);
      });
    });

    worker.once("error", (error) => {
      finish(() => reject(error));
    });

    worker.once("exit", (code) => {
      if (settled) {
        return;
      }
      finish(() => {
        if (code === 0) {
          resolve(null);
          return;
        }
        reject(new Error(`Custom tool worker exited with code ${code}.`));
      });
    });
  });
}

export function resolveCustomToolTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.EMBER_CUSTOM_TOOL_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CUSTOM_TOOL_TIMEOUT_MS;
  }
  return Math.max(100, Math.min(parsed, 120_000));
}

export function resolveCustomToolMemoryMb(): number {
  const parsed = Number.parseInt(process.env.EMBER_CUSTOM_TOOL_MEMORY_MB ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CUSTOM_TOOL_MEMORY_MB;
  }
  return Math.max(32, Math.min(parsed, 1024));
}

function buildToolExecutor(code: string, toolName: string): (input: Record<string, unknown>) => Promise<ToolResult> {
  return async (input: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const result = await runToolInWorker({
        code,
        toolName,
        input,
      });

      if (result === null || result === undefined) {
        return "Tool executed successfully (no output).";
      }
      if (typeof result === "string") {
        return result;
      }
      if (typeof result === "object" && "text" in (result as Record<string, unknown>)) {
        const obj = result as Record<string, unknown>;
        return {
          text: String(obj.text ?? ""),
          ...(obj.imageBase64 ? { imageBase64: String(obj.imageBase64), imageMimeType: (String(obj.imageMimeType ?? "image/png")) as "image/png" | "image/jpeg" | "image/webp" } : {}),
        } as ToolResult;
      }
      // Fallback: stringify the result
      return JSON.stringify(result, null, 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error executing custom tool "${toolName}": ${message}`;
    }
  };
}

// ── Build EmberTool from definition ──────────────────────────────────────────

function buildEmberTool(def: CustomToolDefinition): EmberTool {
  const prefix = "custom__";
  const fullName = def.name.startsWith(prefix) ? def.name : `${prefix}${def.name}`;
  CUSTOM_TOOL_SCOPE_BY_NAME.set(fullName, def.scope);

  return {
    definition: {
      name: fullName,
      description: `[Custom] ${def.description}`,
      inputSchema: def.inputSchema,
    },
    execute: buildToolExecutor(def.code, fullName),
  };
}

export function getCustomToolScope(name: string): "user" | "project" | null {
  return CUSTOM_TOOL_SCOPE_BY_NAME.get(name) ?? null;
}

export function isCustomToolName(name: string): boolean {
  return name.startsWith("custom__");
}

// ── Persistence ──────────────────────────────────────────────────────────────

function saveToolToDisk(def: CustomToolDefinition): void {
  const dir = def.scope === "project" && makerContext
    ? getProjectToolDir(makerContext.workspaceDir)
    : getUserToolDir();
  ensureDir(dir);

  const safeName = def.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(dir, `${safeName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(def, null, 2), "utf-8");
}

function deleteToolFromDisk(name: string): boolean {
  const safeName = name.replace(/^custom__/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  let deleted = false;

  for (const dir of [getUserToolDir(), ...(makerContext ? [getProjectToolDir(makerContext.workspaceDir)] : [])]) {
    const filePath = path.join(dir, `${safeName}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deleted = true;
    }
  }

  return deleted;
}

function loadToolsFromDir(dir: string, scope: "user" | "project"): CustomToolDefinition[] {
  if (!fs.existsSync(dir)) return [];

  const defs: CustomToolDefinition[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const def = JSON.parse(raw) as CustomToolDefinition;
      def.scope = scope;
      defs.push(def);
    } catch {
      // Skip invalid files
    }
  }
  return defs;
}

// ── Load all persisted custom tools at startup ───────────────────────────────

export function loadCustomTools(workspaceDir: string): Array<{ tool: EmberTool; roles: string[] }> {
  const userTools = loadToolsFromDir(getUserToolDir(), "user");
  const projectTools = loadToolsFromDir(getProjectToolDir(workspaceDir), "project");

  // Project tools override user tools with the same name
  const merged = new Map<string, CustomToolDefinition>();
  for (const def of userTools) merged.set(def.name, def);
  for (const def of projectTools) merged.set(def.name, def);

  return [...merged.values()].map((def) => ({
    tool: buildEmberTool(def),
    roles: def.roles,
  }));
}

// ── Validation ───────────────────────────────────────────────────────────────

const RESERVED_NAMES = new Set([
  "create_tool", "handoff", "launch_parallel_tasks",
  "project_overview", "git_inspect", "run_terminal_command",
  "stat_path", "list_directory", "search_files", "read_file",
  "write_file", "edit_file", "delete_file", "web_search",
  "http_request", "fetch_page", "credential_save", "credential_list",
  "credential_get", "save_memory", "memory_search", "memory_get",
  "forget_memory", "system_info", "process_manager", "network_tools",
  "ssh_execute", "mcp_search", "mcp_install", "mcp_resources", "mcp_prompts",
]);

const NAME_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;

const FORBIDDEN_CODE_PATTERNS = [
  /\bprocess\s*\.\s*exit\b/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bchild_process\b/,
  /\bexec\s*\(/,
  /\bexecSync\b/,
  /\bspawn\s*\(/,
  /\bspawnSync\b/,
  /\bfs\s*\.\s*(unlink|rmdir|rm|writeFile|appendFile|rename|chmod|chown)\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bglobalThis\s*\.\s*process\b/,
];

function validateToolName(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return `Tool name must be 2-49 lowercase letters, digits, or underscores, starting with a letter. Got: "${name}"`;
  }
  if (RESERVED_NAMES.has(name)) {
    return `Tool name "${name}" is reserved by the system. Choose a different name.`;
  }
  return null;
}

function validateCode(code: string): string | null {
  if (!code.trim()) {
    return "Code cannot be empty.";
  }
  if (code.length > 50_000) {
    return "Code exceeds maximum length (50,000 characters).";
  }
  for (const pattern of FORBIDDEN_CODE_PATTERNS) {
    if (pattern.test(code)) {
      return `Code contains forbidden pattern: ${pattern.source}. Custom tools run in a sandbox and cannot use Node.js built-in modules, process.exit, or filesystem write operations directly. Use fetch() for HTTP, or request the user to run shell commands via the terminal tool.`;
    }
  }
  return null;
}

// ── The create_tool EmberTool ────────────────────────────────────────────────

export const createToolTool: EmberTool = {
  definition: {
    name: "create_tool",
    description:
      "Create a new custom tool at runtime. The tool is immediately registered and available for use, and persisted for future sessions. Use this when you need a capability that doesn't exist yet — data transformers, API clients, calculators, formatters, validators, etc.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "delete", "view"],
          description: "Action: 'create' a new tool, 'list' existing custom tools, 'delete' a custom tool, 'view' a tool's code. Default: create.",
        },
        name: {
          type: "string",
          description: "Tool name (lowercase, 2-49 chars, letters/digits/underscores). Will be prefixed with 'custom__' automatically. Required for create/delete/view.",
        },
        description: {
          type: "string",
          description: "What the tool does. Keep it concise but descriptive. Required for create.",
        },
        input_schema: {
          type: "object",
          description: "JSON Schema for the tool's input parameters. Must have type:'object'. Required for create.",
          properties: {
            type: { type: "string", enum: ["object"] },
            properties: { type: "object" },
            required: { type: "array", items: { type: "string" } },
          },
        },
        code: {
          type: "string",
          description: "JavaScript function body. Receives `input` object. Must return a string or { text, imageBase64?, imageMimeType? }. Runs in a sandbox with access to: fetch, JSON, Math, Date, Buffer, URL, URLSearchParams, console, setTimeout, crypto, TextEncoder/Decoder. Cannot use require/import or Node fs/child_process. Required for create.",
        },
        roles: {
          type: "array",
          items: { type: "string", enum: ["coordinator", "advisor", "director", "inspector", "ops"] },
          description: "Roles that can use this tool. Default: coordinator, advisor, director, inspector.",
        },
        scope: {
          type: "string",
          enum: ["user", "project"],
          description: "Persistence scope. 'user' = global (~/.ember/custom-tools/), 'project' = this project only (.ember/custom-tools/). Default: project.",
        },
      },
      required: ["action"],
    },
  },

  execute: async (input): Promise<ToolResult> => {
    const action = (input.action as string ?? "create").toLowerCase();

    switch (action) {
      case "list":
        return handleList();
      case "delete":
        return handleDelete(input);
      case "view":
        return handleView(input);
      case "create":
        return handleCreate(input);
      default:
        return `Unknown action "${action}". Use: create, list, delete, or view.`;
    }
  },
};

function handleList(): ToolResult {
  if (!makerContext) return "Tool maker not initialized.";

  const userTools = loadToolsFromDir(getUserToolDir(), "user");
  const projectTools = loadToolsFromDir(getProjectToolDir(makerContext.workspaceDir), "project");

  if (userTools.length === 0 && projectTools.length === 0) {
    return "No custom tools found. Use create_tool action=create to make one.";
  }

  const lines: string[] = ["## Custom Tools\n"];

  if (userTools.length > 0) {
    lines.push("### User scope (~/.ember/custom-tools/)\n");
    for (const def of userTools) {
      lines.push(`- **custom__${def.name}**: ${def.description}`);
      lines.push(`  Roles: ${def.roles.join(", ")} | Created: ${def.createdAt}`);
    }
    lines.push("");
  }

  if (projectTools.length > 0) {
    lines.push("### Project scope (.ember/custom-tools/)\n");
    for (const def of projectTools) {
      lines.push(`- **custom__${def.name}**: ${def.description}`);
      lines.push(`  Roles: ${def.roles.join(", ")} | Created: ${def.createdAt}`);
    }
  }

  return lines.join("\n");
}

function handleDelete(input: Record<string, unknown>): ToolResult {
  if (!makerContext) return "Tool maker not initialized.";

  const name = (input.name as string ?? "").trim().replace(/^custom__/, "");
  if (!name) return "Error: name is required for delete.";

  const fullName = `custom__${name}`;
  const deleted = deleteToolFromDisk(name);

  if (deleted) {
    makerContext.unregisterCustomTool(fullName);
    CUSTOM_TOOL_SCOPE_BY_NAME.delete(fullName);
    return `Deleted custom tool "${fullName}" and removed from registry.`;
  }

  return `Custom tool "${name}" not found on disk.`;
}

function handleView(input: Record<string, unknown>): ToolResult {
  if (!makerContext) return "Tool maker not initialized.";

  const name = (input.name as string ?? "").trim().replace(/^custom__/, "");
  if (!name) return "Error: name is required for view.";

  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const userPath = path.join(getUserToolDir(), `${safeName}.json`);
  const projectPath = path.join(getProjectToolDir(makerContext.workspaceDir), `${safeName}.json`);

  const filePath = fs.existsSync(projectPath) ? projectPath : fs.existsSync(userPath) ? userPath : null;
  if (!filePath) return `Custom tool "${name}" not found.`;

  try {
    const def = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CustomToolDefinition;
    return [
      `## custom__${def.name}`,
      `**Description:** ${def.description}`,
      `**Roles:** ${def.roles.join(", ")}`,
      `**Scope:** ${def.scope}`,
      `**Created:** ${def.createdAt}`,
      "",
      "### Input Schema",
      "```json",
      JSON.stringify(def.inputSchema, null, 2),
      "```",
      "",
      "### Code",
      "```javascript",
      def.code,
      "```",
    ].join("\n");
  } catch {
    return `Error reading tool "${name}".`;
  }
}

function handleCreate(input: Record<string, unknown>): ToolResult {
  if (!makerContext) return "Tool maker not initialized. Server may still be starting up.";

  const name = (input.name as string ?? "").trim();
  const description = (input.description as string ?? "").trim();
  const code = (input.code as string ?? "").trim();
  const roles = (input.roles as string[] | undefined) ?? ["coordinator", "advisor", "director", "inspector"];
  const scope = (input.scope as "user" | "project" | undefined) ?? "project";

  // Validate
  if (!name) return "Error: name is required.";
  if (!description) return "Error: description is required.";
  if (!code) return "Error: code is required.";

  const nameError = validateToolName(name);
  if (nameError) return `Error: ${nameError}`;

  const codeError = validateCode(code);
  if (codeError) return `Error: ${codeError}`;

  let inputSchema = input.input_schema as CustomToolDefinition["inputSchema"] | undefined;
  if (!inputSchema || typeof inputSchema !== "object") {
    inputSchema = { type: "object" };
  }
  if (inputSchema.type !== "object") {
    inputSchema.type = "object";
  }

  // Build the definition
  const def: CustomToolDefinition = {
    name,
    description,
    inputSchema,
    code,
    createdAt: new Date().toISOString(),
    roles,
    scope,
  };

  // Test-compile the code to catch syntax errors early
  try {
    const testCode = `"use strict"; (async function executeCustomTool(input) { ${code} })`;
    new vm.Script(testCode, { filename: `custom-tool-test:${name}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: Code has a syntax error: ${message}`;
  }

  // Build, register, and persist
  const emberTool = buildEmberTool(def);

  try {
    saveToolToDisk(def);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error saving tool to disk: ${message}`;
  }

  makerContext.registerCustomTool(emberTool, roles);

  const fullName = `custom__${name}`;
  return [
    `Created custom tool "${fullName}".`,
    "",
    `**Description:** ${description}`,
    `**Roles:** ${roles.join(", ")}`,
    `**Scope:** ${scope}`,
    `**Persisted:** ${scope === "project" ? ".ember/custom-tools/" : "~/.ember/custom-tools/"}${name}.json`,
    "",
    `The tool is now active. Call it as "${fullName}" with the input schema you defined.`,
  ].join("\n");
}
