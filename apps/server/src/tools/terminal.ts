import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { platform } from "node:os";

import { spawn as spawnPty, type IPty } from "node-pty";

import type { EmberTool } from "./types.js";

let _sudoPassword = "";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_WAIT_MS = 150;
const MAX_WAIT_MS = 5_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const SESSION_IDLE_TTL_MS = 15 * 60_000;

type ShellKind = "posix" | "powershell" | "cmd";
type TransportKind = "pty" | "pipe";

interface PendingCommand {
  marker: string;
  startIndex: number;
}

interface TerminalBackend {
  transport: TransportKind;
  lineEnding: string;
  write(data: string): void;
  interrupt(): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: () => void): void;
}

interface TerminalSession {
  key: string;
  backend: TerminalBackend;
  shellKind: ShellKind;
  cols: number;
  rows: number;
  buffer: string;
  readCursor: number;
  pending: PendingCommand | null;
  lastUsedAt: number;
  waiters: Set<() => void>;
}

interface ShellConfig {
  file: string;
  args: string[];
  kind: ShellKind;
  env: Record<string, string>;
}

const SESSIONS = new Map<string, TerminalSession>();

export function setSudoPassword(password: string) {
  _sudoPassword = password;
}

function appendOutput(current: string, next: string): { value: string; trimmedChars: number } {
  if (!next) {
    return { value: current, trimmedChars: 0 };
  }

  const combined = current + next;
  if (combined.length <= MAX_OUTPUT_CHARS) {
    return { value: combined, trimmedChars: 0 };
  }

  const trimmedChars = combined.length - MAX_OUTPUT_CHARS;
  return {
    value: combined.slice(trimmedChars),
    trimmedChars,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function normalizeSessionKey(input: Record<string, unknown>): string {
  const value = typeof input.__sessionKey === "string" ? input.__sessionKey.trim() : "";
  return value || "default";
}

function normalizeTimeout(input: Record<string, unknown>): number {
  const requested =
    typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
      ? Math.floor(input.timeout_ms)
      : DEFAULT_TIMEOUT_MS;
  return clamp(requested, 1_000, MAX_TIMEOUT_MS);
}

function normalizeWait(input: Record<string, unknown>): number {
  const requested =
    typeof input.wait_ms === "number" && Number.isFinite(input.wait_ms)
      ? Math.floor(input.wait_ms)
      : DEFAULT_WAIT_MS;
  return clamp(requested, 0, MAX_WAIT_MS);
}

function normalizeDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(Math.floor(value), 20, 400)
    : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function normalizeOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function escapePosixArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function detectShell(): ShellConfig {
  if (platform() === "win32") {
    const configured = process.env.EMBER_PTY_SHELL?.trim();
    const file = configured || "powershell.exe";
    const base = path.basename(file).toLowerCase();
    const kind: ShellKind = base.includes("cmd") ? "cmd" : "powershell";
    const args = kind === "powershell" ? ["-NoLogo", "-NoProfile"] : [];
    return {
      file,
      args,
      kind,
      env: sanitizeEnv({
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
      }),
    };
  }

  const file = process.env.EMBER_PTY_SHELL?.trim() || process.env.SHELL || "/bin/bash";
  const base = path.basename(file).toLowerCase();
  const args =
    base === "bash"
      ? ["--noprofile", "--norc"]
      : base === "zsh"
        ? ["-f"]
        : base === "fish"
          ? ["--no-config"]
          : [];

  return {
    file,
    args,
    kind: "posix",
    env: sanitizeEnv({
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      COLORTERM: process.env.COLORTERM || "truecolor",
      PS1: "",
      PROMPT: "",
    }),
  };
}

function createPtyBackend(shell: ShellConfig, cwd: string | undefined, cols: number, rows: number): TerminalBackend {
  const pty = spawnPty(shell.file, shell.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: shell.env,
  });

  if (shell.kind === "posix") {
    pty.write("stty -echo\r");
  }

  return {
    transport: "pty",
    lineEnding: "\r",
    write(data: string) {
      pty.write(data);
    },
    interrupt() {
      pty.write("\u0003");
    },
    resize(nextCols: number, nextRows: number) {
      pty.resize(nextCols, nextRows);
    },
    kill() {
      pty.kill();
    },
    onData(handler: (data: string) => void) {
      pty.onData(handler);
    },
    onExit(handler: () => void) {
      pty.onExit(handler);
    },
  };
}

function createPipeBackend(shell: ShellConfig, cwd: string | undefined): TerminalBackend {
  const child = spawn(shell.file, shell.args, {
    cwd,
    env: shell.env,
    stdio: "pipe",
  });

  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const dataHandlers = new Set<(data: string) => void>();
  const exitHandlers = new Set<() => void>();

  child.stdout.on("data", (chunk: string) => {
    for (const handler of dataHandlers) {
      handler(chunk);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    for (const handler of dataHandlers) {
      handler(chunk);
    }
  });
  child.on("close", () => {
    for (const handler of exitHandlers) {
      handler();
    }
  });

  return {
    transport: "pipe",
    lineEnding: "\n",
    write(data: string) {
      child.stdin.write(data.replace(/\r/g, "\n"));
    },
    interrupt() {
      try {
        child.kill("SIGINT");
      } catch {
        child.kill();
      }
    },
    resize() {
      // Pipes have no terminal dimensions.
    },
    kill() {
      if (!child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      }
    },
    onData(handler: (data: string) => void) {
      dataHandlers.add(handler);
    },
    onExit(handler: () => void) {
      exitHandlers.add(handler);
    },
  };
}

function adjustBufferIndexes(session: TerminalSession, trimmedChars: number) {
  if (trimmedChars <= 0) {
    return;
  }

  session.readCursor = Math.max(0, session.readCursor - trimmedChars);
  if (session.pending) {
    session.pending.startIndex = Math.max(0, session.pending.startIndex - trimmedChars);
  }
}

function handleSessionData(session: TerminalSession, data: string) {
  const appended = appendOutput(session.buffer, data);
  session.buffer = appended.value;
  adjustBufferIndexes(session, appended.trimmedChars);
  session.lastUsedAt = Date.now();

  for (const notify of session.waiters) {
    notify();
  }
}

function destroySession(sessionKey: string, reason?: string) {
  const session = SESSIONS.get(sessionKey);
  if (!session) {
    return;
  }

  SESSIONS.delete(sessionKey);
  if (reason) {
    console.log(`[tool:terminal] closing session "${sessionKey}": ${reason}`);
  }

  try {
    session.backend.kill();
  } catch {
    // Ignore teardown failures on already-closed sessions.
  }
}

function reapIdleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  for (const [sessionKey, session] of SESSIONS.entries()) {
    if (session.lastUsedAt < cutoff) {
      destroySession(sessionKey, "idle timeout");
    }
  }
}

function createSession(sessionKey: string, cwd?: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS): TerminalSession {
  const shell = detectShell();
  let backend: TerminalBackend;

  try {
    backend = createPtyBackend(shell, cwd, cols, rows);
    console.log(`[tool:terminal] session "${sessionKey}" using PTY backend`);
  } catch (error) {
    console.warn(
      `[tool:terminal] PTY backend unavailable for session "${sessionKey}", falling back to pipes: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    backend = createPipeBackend(shell, cwd);
  }

  const session: TerminalSession = {
    key: sessionKey,
    backend,
    shellKind: shell.kind,
    cols,
    rows,
    buffer: "",
    readCursor: 0,
    pending: null,
    lastUsedAt: Date.now(),
    waiters: new Set(),
  };

  backend.onData((data) => handleSessionData(session, data));
  backend.onExit(() => {
    if (SESSIONS.get(sessionKey) === session) {
      SESSIONS.delete(sessionKey);
    }
  });

  SESSIONS.set(sessionKey, session);
  return session;
}

function getSession(
  sessionKey: string,
  options?: { cwd?: string; cols?: number; rows?: number },
): TerminalSession {
  reapIdleSessions();

  const existing = SESSIONS.get(sessionKey);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  return createSession(
    sessionKey,
    options?.cwd,
    options?.cols ?? DEFAULT_COLS,
    options?.rows ?? DEFAULT_ROWS,
  );
}

function readSinceCursor(session: TerminalSession): string {
  const output = session.buffer.slice(session.readCursor);
  session.readCursor = session.buffer.length;
  const normalized = normalizeOutput(output).trim();
  return normalized || "(no output)";
}

function readSinceIndex(session: TerminalSession, index: number): string {
  const normalized = normalizeOutput(session.buffer.slice(index)).trim();
  return normalized || "(no output)";
}

function buildCdCommand(shellKind: ShellKind, cwd: string): string {
  switch (shellKind) {
    case "powershell":
      return `Set-Location -LiteralPath ${escapePowerShellArg(cwd)}`;
    case "cmd":
      return `cd /d "${cwd.replace(/"/g, '""')}"`;
    case "posix":
      return `cd ${escapePosixArg(cwd)}`;
  }
}

function buildMarkerCommand(shellKind: ShellKind, marker: string): string {
  switch (shellKind) {
    case "powershell":
      return `Write-Output ""; Write-Output "${marker}:$LASTEXITCODE"`;
    case "cmd":
      return `echo ${marker}:%errorlevel%`;
    case "posix":
      return `printf '\\n${marker}:%s\\n' "$?"`;
  }
}

function maybeWrapSudo(shellKind: ShellKind, command: string): string {
  if (shellKind !== "posix" || !/\bsudo\b/.test(command) || !_sudoPassword) {
    return command;
  }

  const runCommand = command.replace(/\bsudo\b(?!\s*-S\b)/, "sudo -S");
  return `printf '%s\\n' ${escapePosixArg(_sudoPassword)} | (${runCommand})`;
}

function buildCommandPayload(
  session: TerminalSession,
  command: string,
  marker: string,
  cwd?: string,
): string {
  const segments: string[] = [];
  if (cwd) {
    segments.push(buildCdCommand(session.shellKind, cwd));
  }
  segments.push(maybeWrapSudo(session.shellKind, command.trim()));
  segments.push(buildMarkerCommand(session.shellKind, marker));
  return `${segments.join(session.backend.lineEnding)}${session.backend.lineEnding}`;
}

function extractCompletedCommand(session: TerminalSession): { output: string; exitCode: number } | null {
  const pending = session.pending;
  if (!pending) {
    return null;
  }

  const markerIndex = session.buffer.indexOf(pending.marker, pending.startIndex);
  if (markerIndex === -1) {
    return null;
  }

  const match = session.buffer
    .slice(markerIndex)
    .match(new RegExp(`${escapeRegExp(pending.marker)}:(-?\\d+)`));
  if (!match) {
    return null;
  }

  const output = session.buffer.slice(pending.startIndex, markerIndex);
  const exitCode = Number(match[1] ?? "1");
  session.pending = null;
  session.readCursor = session.buffer.length;
  return {
    output: normalizeOutput(output).trim() || "(no output)",
    exitCode,
  };
}

function formatCommandResult(output: string, exitCode: number): string {
  if (exitCode !== 0) {
    return `Exit code ${exitCode}:\n${output}`;
  }
  return output;
}

function waitForData(session: TerminalSession, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) {
      resolve(false);
      return;
    }

    const onData = () => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      session.waiters.delete(onData);
    };

    session.waiters.add(onData);
  });
}

async function waitForCommand(session: TerminalSession, timeoutMs: number): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const completed = extractCompletedCommand(session);
    if (completed) {
      return formatCommandResult(completed.output, completed.exitCode);
    }

    const remaining = timeoutMs - (Date.now() - startedAt);
    await waitForData(session, remaining);
  }

  if (session.pending) {
    const pendingOutput = readSinceIndex(session, session.pending.startIndex);
    session.pending.startIndex = session.buffer.length;
    session.readCursor = session.buffer.length;
    return `Command is still running in the terminal session.\n${pendingOutput}`;
  }

  return "(no output)";
}

async function readOrWait(session: TerminalSession, waitMs: number): Promise<string> {
  const completed = extractCompletedCommand(session);
  if (completed) {
    return formatCommandResult(completed.output, completed.exitCode);
  }

  if (waitMs > 0) {
    await waitForData(session, waitMs);
  }

  const finishedAfterWait = extractCompletedCommand(session);
  if (finishedAfterWait) {
    return formatCommandResult(finishedAfterWait.output, finishedAfterWait.exitCode);
  }

  return readSinceCursor(session);
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const sessionKey = normalizeSessionKey(input);
  const sessionAction =
    typeof input.session_action === "string" && input.session_action.trim()
      ? input.session_action.trim().toLowerCase()
      : typeof input.action === "string" && input.action.trim()
        ? input.action.trim().toLowerCase()
        : "run";
  const timeoutMs = normalizeTimeout(input);
  const waitMs = normalizeWait(input);
  const cols = normalizeDimension(input.cols, DEFAULT_COLS);
  const rows = normalizeDimension(input.rows, DEFAULT_ROWS);
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  const command = typeof input.command === "string" ? input.command : "";
  const rawInput = typeof input.input === "string" ? input.input : "";

  if (sessionAction === "reset") {
    destroySession(sessionKey, "explicit reset");
    return `Terminal session "${sessionKey}" has been reset.`;
  }

  const session = getSession(sessionKey, { cwd, cols, rows });
  session.lastUsedAt = Date.now();

  if (sessionAction === "resize") {
    session.cols = cols;
    session.rows = rows;
    session.backend.resize(cols, rows);
    return `Terminal resized to ${cols}x${rows}.`;
  }

  if (sessionAction === "interrupt") {
    session.backend.interrupt();
    await sleep(waitMs);
    return await readOrWait(session, 0);
  }

  if (sessionAction === "read") {
    return await readOrWait(session, waitMs);
  }

  if (sessionAction === "input") {
    if (!rawInput) {
      return "Error: input is required for session_action=input.";
    }
    session.backend.write(rawInput);
    await sleep(waitMs);
    return await readOrWait(session, 0);
  }

  if (!command.trim()) {
    return "Error: no command provided.";
  }

  if (session.pending) {
    return "Error: a terminal command is still running. Use session_action=read, input, or interrupt before starting another command.";
  }

  const marker = `__EMBER_TERMINAL_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 10)}__`;
  session.pending = {
    marker,
    startIndex: session.buffer.length,
  };
  session.readCursor = session.buffer.length;

  console.log(
    `[tool:terminal] session="${sessionKey}" (${session.backend.transport}) $ ${command}${cwd ? ` (cwd: ${cwd})` : ""}`,
  );

  session.backend.write(buildCommandPayload(session, command, marker, cwd));
  return await waitForCommand(session, timeoutMs);
}

export const terminalTool: EmberTool = {
  definition: {
    name: "run_terminal_command",
    description:
      "Execute commands in a persistent cross-platform terminal session. EMBER prefers a PTY-backed terminal emulator when the host allows it and falls back to a persistent shell session otherwise. " +
      "The session persists across tool calls within the same conversation, keeps working directory and environment state, and supports reading output, sending raw input, interrupting running programs, resizing the terminal, and resetting the session.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute when session_action is omitted or set to run.",
        },
        cwd: {
          type: "string",
          description:
            "Optional working directory. When provided, the terminal changes into it before running the command and keeps that directory for later calls.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds for run actions (default 120000, maximum 600000).",
        },
        wait_ms: {
          type: "number",
          description: "Optional short wait for read, input, or interrupt actions (default 150, maximum 5000).",
        },
        input: {
          type: "string",
          description: "Raw characters to send to the running terminal session when session_action=input.",
        },
        cols: {
          type: "number",
          description: "Terminal width in columns, mainly for session_action=resize.",
        },
        rows: {
          type: "number",
          description: "Terminal height in rows, mainly for session_action=resize.",
        },
        session_action: {
          type: "string",
          description:
            'Optional control action. One of: "run" (default), "read", "input", "interrupt", "resize", "reset".',
        },
        action: {
          type: "string",
          description:
            'Alias for session_action. One of: "run", "read", "input", "interrupt", "resize", "reset".',
        },
      },
    },
  },
  systemPrompt:
    "run_terminal_command — Use only when a narrower tool will not do. Default is run; use action=read/input/interrupt for follow-up terminal steps.",
  execute,
};
