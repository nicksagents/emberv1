import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { platform } from "node:os";

import { getDataRoot, readJsonFile, writeJson } from "@ember/core";
import { writeAuditEvent } from "../audit-log.js";
import { CONFIG } from "../config.js";
import type { EmberTool } from "./types.js";

interface SudoCredential {
  password: string;
  sessionKey: string;
  setAt: number;
  ttlMs: number;
}

let _sudoCredential: SudoCredential | null = null;
const SUDO_TTL_MS = CONFIG.terminal.sudoTtlMs;
const SUDO_SET_WINDOW_MS = CONFIG.terminal.sudoRateWindowMs;
const SUDO_SET_RATE_LIMIT = CONFIG.terminal.sudoRateLimit;
const sudoSetTimestamps: number[] = [];
const require = createRequire(import.meta.url);
type NodePtyModule = typeof import("node-pty");
let nodePtyModule: NodePtyModule | null = null;
let nodePtyLoadError: unknown = null;

function loadNodePtyModule(): NodePtyModule {
  if (nodePtyModule) {
    return nodePtyModule;
  }
  if (nodePtyLoadError) {
    throw nodePtyLoadError;
  }

  try {
    nodePtyModule = require("node-pty") as NodePtyModule;
    return nodePtyModule;
  } catch (error) {
    nodePtyLoadError = error;
    throw error;
  }
}

const DEFAULT_TIMEOUT_MS = CONFIG.terminal.defaultTimeoutMs;
const MAX_TIMEOUT_MS = CONFIG.terminal.maxTimeoutMs;
const DEFAULT_WAIT_MS = 150;
const MAX_WAIT_MS = 5_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MAX_OUTPUT_CHARS = CONFIG.terminal.maxOutputChars;
const SESSION_IDLE_TTL_MS = CONFIG.terminal.sessionIdleTtlMs;
const TERMINAL_ALLOWLIST_FILE = "terminal-allowlist.json";
const TERMINAL_APPROVAL_SECRET_FILE = "terminal-approval-secret.bin";
const TERMINAL_APPROVAL_TTL_MS = CONFIG.terminal.approvalTtlMs;
let APPROVAL_SECRET = randomBytes(32);
let approvalSecretLoaded = false;

async function loadOrCreateApprovalSecret(): Promise<void> {
  if (approvalSecretLoaded) {
    return;
  }
  const secretPath = path.join(getDataRoot(), TERMINAL_APPROVAL_SECRET_FILE);
  try {
    const stored = await readFile(secretPath);
    if (stored.length === 32) {
      APPROVAL_SECRET = stored;
      approvalSecretLoaded = true;
      return;
    }
  } catch {
    // File doesn't exist — persist the current in-memory secret.
  }
  // Persist the secret we already have in memory (generated at module load).
  // Do NOT regenerate — that would invalidate any signatures created before this call.
  try {
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(secretPath, APPROVAL_SECRET, { mode: 0o600 });
  } catch {
    // Best-effort persistence — continue with in-memory secret.
  }
  approvalSecretLoaded = true;
}

interface PendingApproval {
  id: string;
  nonce: string;
  sessionKey: string;
  command: string;
  reasons: string[];
  createdAt: number;
}

interface TerminalAllowlistFile {
  commands: string[];
}

export type TerminalApprovalDecision = "deny" | "once" | "session" | "always";

export interface TerminalApprovalSummary {
  id: string;
  sessionKey: string;
  command: string;
  reasons: string[];
  createdAt: string;
  expiresAt: string;
}

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
  createdAt: number;
  lastUsedAt: number;
  lastCommand: string | null;
  commandCount: number;
  waiters: Set<() => void>;
}

interface ShellConfig {
  file: string;
  args: string[];
  kind: ShellKind;
  env: Record<string, string>;
}

const SESSIONS = new Map<string, TerminalSession>();
const PENDING_APPROVALS = new Map<string, PendingApproval>();
const SESSION_APPROVALS = new Map<string, Set<string>>();
let persistentAllowlist = new Set<string>();
let allowlistLoaded = false;
const ONE_TIME_APPROVALS = new Map<string, number>();

function clearSudoCredential(): void {
  if (_sudoCredential) {
    _sudoCredential.password = "x".repeat(_sudoCredential.password.length);
    _sudoCredential = null;
  }
}

function pruneSudoSetTimestamps(now = Date.now()): void {
  while (sudoSetTimestamps.length > 0 && now - (sudoSetTimestamps[0] ?? now) > SUDO_SET_WINDOW_MS) {
    sudoSetTimestamps.shift();
  }
}

export function setSudoPassword(password: string, sessionKey: string): void {
  const normalizedPassword = password.trim();
  const normalizedSessionKey = sessionKey.trim() || "default";
  if (!normalizedPassword) {
    clearSudoCredential();
    return;
  }

  const now = Date.now();
  if (
    _sudoCredential
    && _sudoCredential.password === normalizedPassword
    && _sudoCredential.sessionKey === normalizedSessionKey
    && now - _sudoCredential.setAt <= _sudoCredential.ttlMs
  ) {
    _sudoCredential.setAt = now;
    return;
  }

  pruneSudoSetTimestamps(now);
  if (sudoSetTimestamps.length >= SUDO_SET_RATE_LIMIT) {
    throw new Error("Sudo password set rate limit exceeded (maximum 3 attempts per minute).");
  }
  sudoSetTimestamps.push(now);

  _sudoCredential = {
    password: normalizedPassword,
    sessionKey: normalizedSessionKey,
    setAt: now,
    ttlMs: SUDO_TTL_MS,
  };
}

export function getSudoPassword(sessionKey: string): string | null {
  if (!_sudoCredential) {
    return null;
  }
  const now = Date.now();
  if (now - _sudoCredential.setAt > _sudoCredential.ttlMs) {
    clearSudoCredential();
    return null;
  }
  if (_sudoCredential.sessionKey !== sessionKey) {
    return null;
  }
  return _sudoCredential.password;
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
  const { spawn: spawnPty } = loadNodePtyModule();
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

function formatSessionSummary(session: TerminalSession): string {
  return [
    `Session: ${session.key}`,
    `Transport: ${session.backend.transport}`,
    `Shell: ${session.shellKind}`,
    `Pending command: ${session.pending ? "yes" : "no"}`,
    `Commands run: ${session.commandCount}`,
    `Last command: ${session.lastCommand ?? "(none)"}`,
    `Terminal size: ${session.cols}x${session.rows}`,
    `Created: ${new Date(session.createdAt).toISOString()}`,
    `Last used: ${new Date(session.lastUsedAt).toISOString()}`,
  ].join("\n");
}

function formatSessionList(): string {
  if (SESSIONS.size === 0) {
    return "No terminal sessions are active.";
  }

  return [
    "Active terminal sessions:",
    ...[...SESSIONS.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((session) => {
        const pending = session.pending ? "pending" : "idle";
        return `- ${session.key} transport=${session.backend.transport} shell=${session.shellKind} state=${pending} commands=${session.commandCount}`;
      }),
  ].join("\n");
}

function reapIdleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  for (const [sessionKey, session] of SESSIONS.entries()) {
    if (session.lastUsedAt < cutoff) {
      destroySession(sessionKey, "idle timeout");
    }
  }
}

async function ensurePersistentAllowlistLoaded(): Promise<void> {
  if (allowlistLoaded) {
    return;
  }
  const stored = await readJsonFile<TerminalAllowlistFile>(TERMINAL_ALLOWLIST_FILE, { commands: [] });
  persistentAllowlist = new Set(
    Array.isArray(stored.commands)
      ? stored.commands
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
      : [],
  );
  allowlistLoaded = true;
}

async function persistAllowlist(): Promise<void> {
  await ensurePersistentAllowlistLoaded();
  await writeJson(path.join(getDataRoot(), TERMINAL_ALLOWLIST_FILE), {
    commands: [...persistentAllowlist].sort((left, right) => left.localeCompare(right)),
  });
}

function cleanupStaleApprovals(now = Date.now()): void {
  for (const [nonce, pending] of PENDING_APPROVALS.entries()) {
    if (now - pending.createdAt > TERMINAL_APPROVAL_TTL_MS) {
      PENDING_APPROVALS.delete(nonce);
    }
  }
}

function isApprovalExpired(pending: PendingApproval, now = Date.now()): boolean {
  return now - pending.createdAt > TERMINAL_APPROVAL_TTL_MS;
}

function splitApprovalId(approvalId: string): { nonce: string; signature: string } | null {
  const separatorIndex = approvalId.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= approvalId.length - 1) {
    return null;
  }
  const nonce = approvalId.slice(0, separatorIndex).trim();
  const signature = approvalId.slice(separatorIndex + 1).trim();
  if (!nonce || !signature) {
    return null;
  }
  return { nonce, signature };
}

function buildApprovalSignature(sessionKey: string, command: string, createdAt: number): string {
  const payload = `${sessionKey}:${command}:${createdAt}`;
  return createHmac("sha256", APPROVAL_SECRET)
    .update(payload)
    .digest("hex");
}

function hasValidApprovalSignature(approvalId: string, pending: PendingApproval): boolean {
  const parsed = splitApprovalId(approvalId);
  if (!parsed) {
    return false;
  }
  const expected = buildApprovalSignature(pending.sessionKey, pending.command, pending.createdAt);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(parsed.signature, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function getPendingApproval(approvalId: string): PendingApproval | null {
  const parsed = splitApprovalId(approvalId);
  if (!parsed) {
    return null;
  }
  return PENDING_APPROVALS.get(parsed.nonce) ?? null;
}

function deletePendingApproval(approvalId: string): void {
  const parsed = splitApprovalId(approvalId);
  if (!parsed) {
    return;
  }
  PENDING_APPROVALS.delete(parsed.nonce);
}

function approvalKey(sessionKey: string, command: string): string {
  return `${sessionKey}\n${command}`;
}

function registerOneTimeApproval(sessionKey: string, command: string): void {
  const key = approvalKey(sessionKey, command);
  const current = ONE_TIME_APPROVALS.get(key) ?? 0;
  ONE_TIME_APPROVALS.set(key, current + 1);
}

function consumeOneTimeApproval(sessionKey: string, command: string): boolean {
  const key = approvalKey(sessionKey, command);
  const current = ONE_TIME_APPROVALS.get(key) ?? 0;
  if (current <= 0) {
    return false;
  }
  if (current === 1) {
    ONE_TIME_APPROVALS.delete(key);
  } else {
    ONE_TIME_APPROVALS.set(key, current - 1);
  }
  return true;
}

function normalizeCommand(command: string): string {
  return command
    .replace(/\\\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

type CommandSeverity = "warn" | "block";

interface DangerousCommandPattern {
  pattern: RegExp;
  reason: string;
  severity: CommandSeverity;
}

const DANGEROUS_COMMAND_PATTERNS: DangerousCommandPattern[] = [
  // ── Block: Destructive filesystem operations ──
  { pattern: /\brm\s+(-[a-z]*r[a-z]*\s+|.*-rf\s)/i, reason: "Recursive deletion", severity: "block" },
  { pattern: /\bmkfs(\.|\s)/i, reason: "Filesystem format", severity: "block" },
  { pattern: /\bdd\s+.*of=\/dev\//i, reason: "Direct disk write", severity: "block" },
  { pattern: />\s*\/dev\/(sd|hd|nvme)/i, reason: "Direct disk write via redirect", severity: "block" },

  // ── Block: Dangerous permissions ──
  { pattern: /\bchmod\s+777\b/, reason: "World-writable permissions", severity: "block" },
  { pattern: /\bchmod\b.*\+s\b/i, reason: "Setting setuid/setgid bit", severity: "block" },
  { pattern: /\bchown\s+-[a-z]*R/i, reason: "Recursive ownership change", severity: "block" },

  // ── Block: Destructive SQL ──
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: "Destructive SQL operation", severity: "block" },
  { pattern: /\bDELETE\s+FROM\b/i, reason: "SQL DELETE without review", severity: "block" },

  // ── Block: System control ──
  { pattern: /\bshutdown\b|\breboot\b|\bpoweroff\b|\binit\s+[06]\b/i, reason: "System shutdown/reboot", severity: "block" },
  { pattern: /\bkill\s+-9\s+-1\b/, reason: "Kill all processes", severity: "block" },
  { pattern: /\bsystemctl\b.*(disable|mask)\b/i, reason: "Disabling system service", severity: "block" },

  // ── Block: Remote code execution ──
  { pattern: /\bcurl\b.*\|\s*(sudo\s+)?(ba)?sh\b/i, reason: "Piped remote execution", severity: "block" },
  { pattern: /\bwget\b.*\|\s*(sudo\s+)?(ba)?sh\b/i, reason: "Piped remote execution", severity: "block" },
  { pattern: /\bwget\b.*-o\s*-\s*\|/i, reason: "Piping remote download to command", severity: "block" },

  // ── Block: Fork bombs and denial of service ──
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/i, reason: "Fork bomb", severity: "block" },
  { pattern: /\bwhile\s+true\s*;\s*do\s+(fork|:)\b/i, reason: "Fork bomb variant", severity: "block" },

  // ── Block: Network security ──
  { pattern: /\biptables\s+-F\b/i, reason: "Firewall flush", severity: "block" },
  { pattern: /\bufw\s+disable\b/i, reason: "Firewall disable", severity: "block" },
  { pattern: /\bnc\b.*-[le]\b/i, reason: "Netcat listener (potential reverse shell)", severity: "block" },

  // ── Block: Environment exfiltration ──
  { pattern: /\b(env|printenv)\b.*\|\s*(curl|wget|nc)\b/i, reason: "Environment variable exfiltration", severity: "block" },

  // ── Warn: Potentially dangerous but sometimes legitimate ──
  { pattern: /\brm\s+(-[a-z]*f[a-z]*\s)/i, reason: "Forced deletion", severity: "warn" },
  { pattern: /\bchmod\s+-[a-z]*R/i, reason: "Recursive permission change", severity: "warn" },
  { pattern: /\bgit\s+push\s+.*--force\b/i, reason: "Force push", severity: "warn" },
  { pattern: /\bgit\s+push\s+-f\b/i, reason: "Force push", severity: "warn" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Hard reset", severity: "warn" },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: "Git clean with force", severity: "warn" },
  { pattern: /\bkill\s+-9\b/i, reason: "Force process kill (SIGKILL)", severity: "warn" },
  { pattern: /\bsystemctl\s+stop\b/i, reason: "Stopping system service", severity: "warn" },
  { pattern: /\bcrontab\b.*-[re]\b/i, reason: "Modifying cron schedule", severity: "warn" },
  { pattern: /\b(python|node|ruby|perl)\b.*-[ec]\b/i, reason: "Inline code execution", severity: "warn" },
  { pattern: /\bnpm\s+publish\b/i, reason: "Package publish", severity: "warn" },
  { pattern: /\bdocker\s+system\s+prune\s+-a/i, reason: "Docker full prune", severity: "warn" },
  { pattern: /\bdd\s+if=/i, reason: "Raw disk read command (dd)", severity: "warn" },
  { pattern: /\bexport\b[^>]*>/i, reason: "Exporting env to file", severity: "warn" },
];

export interface CommandClassification {
  safe: boolean;
  warnings: string[];
  blocked: string[];
}

export function classifyCommand(command: string): CommandClassification {
  const normalized = normalizeCommand(command);
  const segments = normalized
    .split(/(?:&&|\|\||[;|])/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const scopes = [normalized, ...segments];

  const warnings: string[] = [];
  const blocked: string[] = [];

  for (const scope of scopes) {
    for (const entry of DANGEROUS_COMMAND_PATTERNS) {
      if (!entry.pattern.test(scope)) {
        continue;
      }
      const target = entry.severity === "block" ? blocked : warnings;
      if (!target.includes(entry.reason)) {
        target.push(entry.reason);
      }
    }
  }

  return {
    safe: blocked.length === 0 && warnings.length === 0,
    warnings,
    blocked,
  };
}

/** Backward-compatible wrapper: returns all reasons (both warn + block). */
function assessDangerousCommand(command: string): string[] {
  const { warnings, blocked } = classifyCommand(command);
  return [...blocked, ...warnings];
}

function isCommandApprovedForSession(sessionKey: string, command: string): boolean {
  const approved = SESSION_APPROVALS.get(sessionKey);
  return approved?.has(command) ?? false;
}

function registerSessionApproval(sessionKey: string, command: string): void {
  const current = SESSION_APPROVALS.get(sessionKey) ?? new Set<string>();
  current.add(command);
  SESSION_APPROVALS.set(sessionKey, current);
}

function createApprovalRequest(sessionKey: string, command: string, reasons: string[]): PendingApproval {
  const createdAt = Date.now();
  const nonce = randomUUID();
  const signature = buildApprovalSignature(sessionKey, command, createdAt);
  const id = `${nonce}.${signature}`;
  const pending: PendingApproval = {
    id,
    nonce,
    sessionKey,
    command,
    reasons,
    createdAt,
  };
  PENDING_APPROVALS.set(nonce, pending);
  return pending;
}

function formatApprovalPrompt(pending: PendingApproval): string {
  return [
    "Approval required for dangerous terminal command.",
    `Command: ${pending.command}`,
    `Reasons: ${pending.reasons.join(", ")}`,
    "",
    "Re-run run_terminal_command with:",
    `- approval_id: "${pending.id}"`,
    '- approval_decision: "deny" | "once" | "session" | "always"',
    "",
    "Decision meanings:",
    '- "once": run this command now only',
    '- "session": allow this exact command for this terminal session',
    '- "always": persist this exact command in allowlist',
    '- "deny": reject and clear this approval request',
  ].join("\n");
}

function toTerminalApprovalSummary(pending: PendingApproval): TerminalApprovalSummary {
  return {
    id: pending.id,
    sessionKey: pending.sessionKey,
    command: pending.command,
    reasons: pending.reasons,
    createdAt: new Date(pending.createdAt).toISOString(),
    expiresAt: new Date(pending.createdAt + TERMINAL_APPROVAL_TTL_MS).toISOString(),
  };
}

function logTerminalAudit(
  action: string,
  status: "ok" | "denied" | "error",
  details: Record<string, unknown>,
): void {
  void writeAuditEvent({
    action,
    method: "tool",
    path: "run_terminal_command",
    ip: "local-session",
    status,
    details,
  }).catch(() => {
    // Best-effort only for tool-level auditing.
  });
}

function applyApprovalDecision(pending: PendingApproval, decision: TerminalApprovalDecision): Promise<void> | void {
  if (decision === "once") {
    registerOneTimeApproval(pending.sessionKey, pending.command);
    return;
  }
  if (decision === "session") {
    registerSessionApproval(pending.sessionKey, pending.command);
    return;
  }
  if (decision === "always") {
    persistentAllowlist.add(pending.command);
    return persistAllowlist();
  }
}

export function listPendingTerminalApprovals(): TerminalApprovalSummary[] {
  cleanupStaleApprovals();
  return [...PENDING_APPROVALS.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((pending) => toTerminalApprovalSummary(pending));
}

export async function decidePendingTerminalApproval(input: {
  approvalId: string;
  decision: TerminalApprovalDecision;
}): Promise<{ ok: true; item: TerminalApprovalSummary } | { ok: false; message: string }> {
  await ensurePersistentAllowlistLoaded();
  cleanupStaleApprovals();

  const pending = getPendingApproval(input.approvalId);
  if (!pending) {
    return {
      ok: false,
      message: "Approval request not found or expired.",
    };
  }

  if (!hasValidApprovalSignature(input.approvalId, pending)) {
    deletePendingApproval(input.approvalId);
    return {
      ok: false,
      message: "Approval request signature is invalid.",
    };
  }
  if (isApprovalExpired(pending)) {
    deletePendingApproval(input.approvalId);
    return {
      ok: false,
      message: "Approval request not found or expired.",
    };
  }

  const summary = toTerminalApprovalSummary(pending);
  deletePendingApproval(input.approvalId);
  if (input.decision === "deny") {
    logTerminalAudit("terminal.approval", "denied", {
      decision: input.decision,
      sessionKey: pending.sessionKey,
      command: pending.command,
      source: "api",
    });
    return { ok: true, item: summary };
  }

  await applyApprovalDecision(pending, input.decision);
  logTerminalAudit("terminal.approval", "ok", {
    decision: input.decision,
    sessionKey: pending.sessionKey,
    command: pending.command,
    source: "api",
  });
  return { ok: true, item: summary };
}

async function createSession(sessionKey: string, cwd?: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS): Promise<TerminalSession> {
  const shell = detectShell();
  let backend: TerminalBackend;
  let needsInitSettle = false;

  try {
    backend = createPtyBackend(shell, cwd, cols, rows);
    needsInitSettle = shell.kind === "posix";
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
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastCommand: null,
    commandCount: 0,
    waiters: new Set(),
  };

  backend.onData((data) => handleSessionData(session, data));
  backend.onExit(() => {
    if (SESSIONS.get(sessionKey) === session) {
      SESSIONS.delete(sessionKey);
    }
  });

  SESSIONS.set(sessionKey, session);

  // Wait for `stty -echo` initialization to flush through the PTY so its
  // echoed output never leaks into the first real command's result.
  if (needsInitSettle) {
    await sleep(100);
    session.buffer = "";
    session.readCursor = 0;
  }

  return session;
}

async function getSession(
  sessionKey: string,
  options?: { cwd?: string; cols?: number; rows?: number },
): Promise<TerminalSession> {
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

function maybeWrapSudo(
  shellKind: ShellKind,
  sessionKey: string,
  command: string,
): { command: string; usedCredential: boolean } {
  if (shellKind !== "posix" || !/\bsudo\b/.test(command)) {
    return { command, usedCredential: false };
  }
  const sudoPassword = getSudoPassword(sessionKey);
  if (!sudoPassword) {
    return { command, usedCredential: false };
  }

  const runCommand = command.replace(/\bsudo\b(?!\s*-S\b)/, "sudo -S");
  return {
    command: `printf '%s\\n' ${escapePosixArg(sudoPassword)} | (${runCommand})`,
    usedCredential: true,
  };
}

function buildCommandPayload(
  session: TerminalSession,
  command: string,
  marker: string,
  cwd?: string,
): { payload: string; usedSudoCredential: boolean } {
  const segments: string[] = [];
  if (cwd) {
    segments.push(buildCdCommand(session.shellKind, cwd));
  }
  const wrapped = maybeWrapSudo(session.shellKind, session.key, command.trim());
  segments.push(wrapped.command);
  segments.push(buildMarkerCommand(session.shellKind, marker));
  return {
    payload: `${segments.join(session.backend.lineEnding)}${session.backend.lineEnding}`,
    usedSudoCredential: wrapped.usedCredential,
  };
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
  await loadOrCreateApprovalSecret();
  await ensurePersistentAllowlistLoaded();
  cleanupStaleApprovals();

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
  const approvalId = typeof input.approval_id === "string" ? input.approval_id.trim() : "";
  const approvalDecision =
    typeof input.approval_decision === "string" && input.approval_decision.trim()
      ? input.approval_decision.trim().toLowerCase()
      : "";

  if (sessionAction === "list_sessions") {
    return formatSessionList();
  }

  if (sessionAction === "status") {
    const session = SESSIONS.get(sessionKey);
    return session
      ? formatSessionSummary(session)
      : `Terminal session "${sessionKey}" does not exist.`;
  }

  if (sessionAction === "close") {
    if (!SESSIONS.has(sessionKey)) {
      return `Terminal session "${sessionKey}" does not exist.`;
    }
    destroySession(sessionKey, "explicit close");
    return `Terminal session "${sessionKey}" has been closed.`;
  }

  if (sessionAction === "reset") {
    destroySession(sessionKey, "explicit reset");
    return `Terminal session "${sessionKey}" has been reset.`;
  }

  const session = await getSession(sessionKey, { cwd, cols, rows });
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

  let commandToRun = command.trim();
  let approvedByDecision = false;

  if (approvalId || approvalDecision) {
    if (!approvalId || !approvalDecision) {
      return "Error: approval_id and approval_decision are required together.";
    }
    if (!["deny", "once", "session", "always"].includes(approvalDecision)) {
      return 'Error: approval_decision must be one of "deny", "once", "session", or "always".';
    }
    const pending = getPendingApproval(approvalId);
    if (!pending) {
      return "Error: approval request not found or expired.";
    }
    if (!hasValidApprovalSignature(approvalId, pending)) {
      deletePendingApproval(approvalId);
      return "Error: approval request signature is invalid.";
    }
    if (isApprovalExpired(pending)) {
      deletePendingApproval(approvalId);
      return "Error: approval request not found or expired.";
    }
    if (pending.sessionKey !== sessionKey) {
      return "Error: approval request does not belong to this terminal session.";
    }

    if (approvalDecision === "deny") {
      deletePendingApproval(approvalId);
      logTerminalAudit("terminal.approval", "denied", {
        decision: approvalDecision,
        sessionKey,
        command: pending.command,
      });
      return `Denied command: ${pending.command}`;
    }

    commandToRun = pending.command;
    deletePendingApproval(approvalId);
    approvedByDecision = true;
    if (approvalDecision !== "once") {
      await applyApprovalDecision(pending, approvalDecision as TerminalApprovalDecision);
    }
    logTerminalAudit("terminal.approval", "ok", {
      decision: approvalDecision,
      sessionKey,
      command: commandToRun,
    });
  }

  if (!commandToRun) {
    return "Error: no command provided.";
  }

  let commandWarnings: string[] = [];
  if (!approvedByDecision) {
    const classification = classifyCommand(commandToRun);
    const allReasons = [...classification.blocked, ...classification.warnings];
    const approvedBySession = isCommandApprovedForSession(sessionKey, commandToRun);
    const approvedPersistently = persistentAllowlist.has(commandToRun);
    const approvedByOneTime = consumeOneTimeApproval(sessionKey, commandToRun);
    if (approvedByOneTime) {
      logTerminalAudit("terminal.approval.consume", "ok", {
        decision: "once",
        sessionKey,
        command: commandToRun,
      });
    }

    // Block-severity patterns require explicit approval unless already approved.
    if (classification.blocked.length > 0 && !approvedBySession && !approvedPersistently && !approvedByOneTime) {
      const pending = createApprovalRequest(sessionKey, commandToRun, allReasons);
      logTerminalAudit("terminal.approval.request", "denied", {
        sessionKey,
        command: commandToRun,
        reasons: allReasons,
        blockedReasons: classification.blocked,
      });
      return formatApprovalPrompt(pending);
    }

    // Warn-severity patterns: log and surface warnings but allow execution.
    if (classification.warnings.length > 0 && !approvedBySession && !approvedPersistently && !approvedByOneTime) {
      commandWarnings = classification.warnings;
      logTerminalAudit("terminal.command.warn", "ok", {
        sessionKey,
        command: commandToRun,
        warnings: classification.warnings,
      });
    }
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
  session.lastCommand = commandToRun;
  session.commandCount += 1;

  console.log(
    `[tool:terminal] session="${sessionKey}" (${session.backend.transport}) $ ${commandToRun}${cwd ? ` (cwd: ${cwd})` : ""}`,
  );

  const commandPayload = buildCommandPayload(session, commandToRun, marker, cwd);
  session.backend.write(commandPayload.payload);
  try {
    const result = await waitForCommand(session, timeoutMs);
    if (commandWarnings.length > 0) {
      const warningHeader = `[WARNING] ${commandWarnings.join("; ")}`;
      return `${warningHeader}\n\n${result}`;
    }
    return result;
  } finally {
    if (commandPayload.usedSudoCredential) {
      clearSudoCredential();
    }
  }
}

export function resetTerminalApprovalStateForTests(): void {
  PENDING_APPROVALS.clear();
  SESSION_APPROVALS.clear();
  ONE_TIME_APPROVALS.clear();
  persistentAllowlist = new Set<string>();
  allowlistLoaded = false;
  clearSudoCredential();
  sudoSetTimestamps.length = 0;
}

export const terminalTool: EmberTool = {
  definition: {
    name: "run_terminal_command",
    description:
      "Execute host-machine commands in a persistent cross-platform terminal session. EMBER prefers a PTY-backed terminal emulator when the host allows it and falls back to a persistent shell session otherwise. " +
      "The session persists across tool calls within the same conversation, keeps working directory and environment state, and supports reading output, sending raw input, interrupting running programs, resizing the terminal, and resetting the session. Dangerous commands require explicit approval.",
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
        approval_id: {
          type: "string",
          description: "Approval request id returned by a prior dangerous command warning.",
        },
        approval_decision: {
          type: "string",
          enum: ["deny", "once", "session", "always"],
          description:
            'Approval decision for dangerous commands. Use with approval_id. "once" runs once, "session" allows this command for current session, "always" persists allowlist.',
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
            'Optional control action. One of: "run" (default), "read", "input", "interrupt", "resize", "status", "list_sessions", "close", "reset".',
        },
        action: {
          type: "string",
          description:
            'Alias for session_action. One of: "run", "read", "input", "interrupt", "resize", "status", "list_sessions", "close", "reset".',
        },
      },
    },
  },
  execute,
};
