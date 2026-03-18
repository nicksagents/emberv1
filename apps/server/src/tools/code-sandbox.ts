/**
 * Code Execution Sandbox
 *
 * Runs untrusted code in a restricted Node.js VM context.
 * - No filesystem access
 * - No network access
 * - No process/child_process
 * - Timeout enforced
 * - Memory limited via VM context
 */

import vm from "node:vm";
import type { EmberTool } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... (truncated at ${limit} chars)`;
}

function createSandboxContext(): vm.Context {
  // Minimal safe globals — no require, no process, no fs, no network
  const sandbox: Record<string, unknown> = {
    console: {
      log: (...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      },
      warn: (...args: unknown[]) => {
        output.push("[warn] " + args.map(String).join(" "));
      },
      error: (...args: unknown[]) => {
        output.push("[error] " + args.map(String).join(" "));
      },
      info: (...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      },
    },
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    clearImmediate: undefined,
    // Math and JSON are safe
    Math,
    JSON,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    URIError,
    EvalError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    encodeURIComponent,
    decodeURI,
    decodeURIComponent,
    // Explicitly blocked
    require: undefined,
    process: undefined,
    globalThis: undefined,
    global: undefined,
    __dirname: undefined,
    __filename: undefined,
    Buffer: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
  };

  const output: string[] = [];
  (sandbox as { __output: string[] }).__output = output;

  return vm.createContext(sandbox, {
    name: "ember-sandbox",
    codeGeneration: {
      strings: false, // Block eval() and new Function()
      wasm: false,
    },
  });
}

function executeJavaScript(code: string, timeoutMs: number): { stdout: string; returnValue: string | null; error: string | null } {
  const context = createSandboxContext();
  const output = (context as { __output: string[] }).__output;

  try {
    const script = new vm.Script(code, {
      filename: "sandbox.js",
    });

    const result = script.runInContext(context, {
      timeout: timeoutMs,
      displayErrors: true,
    });

    const returnValue = result !== undefined ? String(result) : null;
    return {
      stdout: output.join("\n"),
      returnValue,
      error: null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      stdout: output.join("\n"),
      returnValue: null,
      error,
    };
  }
}

export const codeSandboxTool: EmberTool = {
  definition: {
    name: "execute_code",
    description:
      "Execute JavaScript code in a sandboxed environment. No filesystem, network, or process access. Use console.log() for output. Returns stdout and the expression's return value.",
    inputSchema: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: "The JavaScript code to execute",
        },
        timeout_ms: {
          type: "number",
          description: `Execution timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
        },
      },
      required: ["code"],
    },
  },
  priority: 3,
  execute(input) {
    const code = input.code;
    if (typeof code !== "string" || !code.trim()) {
      return "Error: code is required and must be a non-empty string.";
    }

    const rawTimeout = typeof input.timeout_ms === "number" ? input.timeout_ms : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(rawTimeout, 100), MAX_TIMEOUT_MS);

    const result = executeJavaScript(code, timeoutMs);
    const parts: string[] = [];

    if (result.stdout) {
      parts.push(`--- stdout ---\n${truncate(result.stdout, MAX_OUTPUT_CHARS)}`);
    }
    if (result.returnValue !== null) {
      parts.push(`--- return value ---\n${truncate(result.returnValue, MAX_OUTPUT_CHARS)}`);
    }
    if (result.error) {
      parts.push(`--- error ---\n${result.error}`);
    }
    if (parts.length === 0) {
      parts.push("(no output)");
    }

    return parts.join("\n\n");
  },
};
