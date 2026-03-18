import type { FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { getDataRoot } from "@ember/core";

export type ApiAccessClass = "read" | "write" | "admin";

export interface ApiAuthConfig {
  enabled: boolean;
  isDevLike: boolean;
  tokens: Record<ApiAccessClass, string[]>;
}

export interface ApiRateLimitConfig {
  windowMs: number;
  max: number;
}

export interface ApiIdempotencyConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
}

export type IdempotencyBeginResult =
  | { kind: "started" }
  | { kind: "replay"; statusCode: number; body: unknown }
  | { kind: "in-flight"; message: string }
  | { kind: "mismatch"; message: string };

type IdempotencyEntry = {
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  status: "in-flight" | "completed";
  statusCode: number | null;
  body: unknown;
};

/**
 * Build default CORS origins for development mode.
 * Includes localhost + all non-internal IPv4 addresses on the machine
 * (covers Tailscale, LAN, etc.) so the web UI works from any interface.
 */
function buildDefaultCorsOrigins(): string[] {
  const webPort = process.env.EMBER_WEB_PORT ?? "3000";
  const origins = [
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
  ];
  try {
    const interfaces = os.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          origins.push(`http://${addr.address}:${webPort}`);
        }
      }
    }
  } catch {
    // Best-effort — fall back to localhost only
  }
  return origins;
}

const DEFAULT_CORS_ORIGINS = buildDefaultCorsOrigins();
const IDEMPOTENCY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const IDEMPOTENCY_PATH_PREFIXES = [
  "/api/settings",
  "/api/providers",
  "/api/roles",
  "/api/mcp",
  "/api/terminal",
  "/api/checkpoints",
  "/api/simulations",
  "/api/simulation-settings",
];

const NO_BODY_REQUIRED_ROUTES = new Set<string>([
  "POST:/api/conversations/:id/archive",
  "POST:/api/memory/items/:id/approve",
  "POST:/api/memory/items/:id/revalidate",
  "POST:/api/memory/items/:id/retire",
  "POST:/api/memory/items/:id/suppress",
  "POST:/api/memory/replay",
  "POST:/api/mcp/reload",
  "POST:/api/providers/:id/connect",
  "POST:/api/providers/:id/reconnect",
  "POST:/api/providers/:id/recheck",
]);

export function resolveServerHostDefault(): string {
  return process.env.EMBER_RUNTIME_HOST ?? "127.0.0.1";
}

export function resolveApiAuthConfig(env = process.env): ApiAuthConfig {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  const isDevLike = nodeEnv === "" || nodeEnv === "development" || nodeEnv === "test";
  const read = uniqueNonEmpty([
    env.EMBER_API_TOKEN_READ,
    env.EMBER_API_TOKEN,
  ]);
  const write = uniqueNonEmpty([
    env.EMBER_API_TOKEN_WRITE,
    env.EMBER_API_TOKEN,
  ]);
  const admin = uniqueNonEmpty([
    env.EMBER_API_TOKEN_ADMIN,
    env.EMBER_API_TOKEN,
  ]);
  const enabled = read.length > 0 || write.length > 0 || admin.length > 0;
  return {
    enabled,
    isDevLike,
    tokens: {
      read,
      write,
      admin,
    },
  };
}

export function assertAuthConfigIsSafe(config: ApiAuthConfig): void {
  if (!config.isDevLike && !config.enabled) {
    throw new Error(
      "Production runtime requires API auth. Set EMBER_API_TOKEN or scoped EMBER_API_TOKEN_{READ,WRITE,ADMIN}.",
    );
  }
}

export function resolveApiAccessClass(pathname: string, method: string): ApiAccessClass {
  const upperMethod = method.toUpperCase();
  if (pathname.startsWith("/api/settings")
    || pathname.startsWith("/api/providers")
    || pathname.startsWith("/api/roles")
    || pathname.startsWith("/api/mcp")
    || pathname.startsWith("/api/terminal")
    || pathname.startsWith("/api/checkpoints")
    || pathname.startsWith("/api/simulation-settings")) {
    return "admin";
  }
  // Simulation mutation endpoints require write access
  if (pathname.startsWith("/api/simulations") && upperMethod !== "GET" && upperMethod !== "HEAD") {
    return "write";
  }
  if (upperMethod === "GET" || upperMethod === "HEAD") {
    return "read";
  }
  return "write";
}

export function authorizeApiRequest(
  request: FastifyRequest,
  config: ApiAuthConfig,
): { ok: true } | { ok: false; statusCode: number; message: string } {
  if (!request.url.startsWith("/api/")) {
    return { ok: true };
  }
  const pathname = request.url.split("?")[0] ?? request.url;
  if (pathname === "/api/health") {
    return { ok: true };
  }
  if (!config.enabled) {
    return { ok: true };
  }

  const requiredClass = resolveApiAccessClass(pathname, request.method);
  const bearer = parseBearerToken(request.headers.authorization);
  if (!bearer) {
    return {
      ok: false,
      statusCode: 401,
      message: "Missing Bearer token.",
    };
  }

  const candidates = config.tokens[requiredClass];
  if (candidates.some((candidate) => safeTokenEquals(candidate, bearer))) {
    return { ok: true };
  }
  return {
    ok: false,
    statusCode: 403,
    message: `Token is not authorized for ${requiredClass} routes.`,
  };
}

export function parseCorsOrigins(env = process.env): Set<string> {
  const configured = uniqueNonEmpty((env.EMBER_CORS_ORIGINS ?? "").split(","));
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  const isDevLike = nodeEnv === "" || nodeEnv === "development" || nodeEnv === "test";

  if (configured.length > 0) {
    // In dev mode, merge explicit config with auto-detected network origins
    // so Tailscale/LAN access works even if EMBER_CORS_ORIGINS doesn't list every IP
    if (isDevLike) {
      return new Set([...configured, ...DEFAULT_CORS_ORIGINS]);
    }
    return new Set(configured);
  }
  if (isDevLike) {
    return new Set(DEFAULT_CORS_ORIGINS);
  }
  return new Set();
}

export function isCorsOriginAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  if (!origin) {
    return true;
  }
  if (allowed.size === 0) {
    return false;
  }
  return [...allowed].some((candidate) => corsOriginMatches(candidate, origin));
}

export function validateMutationOrigin(
  request: FastifyRequest,
  allowed: Set<string>,
): { ok: true } | { ok: false; message: string } {
  if (!isMutationMethod(request.method)) {
    return { ok: true };
  }
  const origin = request.headers.origin;
  if (!origin) {
    return { ok: true };
  }
  if (!isCorsOriginAllowed(origin, allowed)) {
    return {
      ok: false,
      message: "Origin not allowed.",
    };
  }
  return { ok: true };
}

export function resolveRateLimitConfig(pathname: string, method: string): ApiRateLimitConfig | null {
  const upperMethod = method.toUpperCase();
  if (pathname === "/api/chat/stream") {
    return {
      windowMs: Number(process.env.EMBER_STREAM_RATE_WINDOW_MS ?? 60_000),
      max: Number(process.env.EMBER_STREAM_RATE_MAX ?? 12),
    };
  }
  if (upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH" || upperMethod === "DELETE") {
    return {
      windowMs: Number(process.env.EMBER_MUTATION_RATE_WINDOW_MS ?? 60_000),
      max: Number(process.env.EMBER_MUTATION_RATE_MAX ?? 120),
    };
  }
  return null;
}

export function resolveIdempotencyConfig(env = process.env): ApiIdempotencyConfig {
  return {
    enabled: parseEnvBoolean(env.EMBER_ENABLE_IDEMPOTENCY_KEYS) ?? true,
    ttlMs: parsePositiveInt(env.EMBER_IDEMPOTENCY_TTL_MS, 10 * 60_000, 1_000, 24 * 60 * 60_000),
    maxEntries: parsePositiveInt(env.EMBER_IDEMPOTENCY_MAX_ENTRIES, 1_000, 32, 50_000),
  };
}

export function shouldApplyIdempotency(pathname: string, method: string): boolean {
  const upperMethod = method.toUpperCase();
  if (!IDEMPOTENCY_METHODS.has(upperMethod)) {
    return false;
  }
  return IDEMPOTENCY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function normalizeIdempotencyKey(headerValue: string | string[] | undefined): string | null {
  const first = Array.isArray(headerValue) ? (headerValue[0] ?? "") : (headerValue ?? "");
  const trimmed = first.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 256);
}

export function buildIdempotencyFingerprint(input: {
  method: string;
  pathname: string;
  body: unknown;
}): string {
  const normalizedMethod = input.method.toUpperCase();
  const body = stableSerialize(input.body);
  const hash = createHash("sha256");
  hash.update(normalizedMethod);
  hash.update("\n");
  hash.update(input.pathname);
  hash.update("\n");
  hash.update(body);
  return hash.digest("hex");
}

export function isRuntimeMcpInstallEnabled(env = process.env): boolean {
  const explicit = parseEnvBoolean(env.EMBER_ENABLE_RUNTIME_MCP_INSTALL);
  if (explicit != null) {
    return explicit;
  }
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  return nodeEnv === "" || nodeEnv === "development" || nodeEnv === "test";
}

export function parseMcpRemoteAllowlist(env = process.env): string[] {
  return uniqueNonEmpty((env.EMBER_MCP_REMOTE_ALLOWLIST ?? "").split(","))
    .map((entry) => entry.toLowerCase());
}

export function validateMcpRemoteTarget(urlValue: string, env = process.env): string | null {
  let hostname: string;
  try {
    const parsed = new URL(urlValue);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return "Remote MCP target URL is invalid.";
  }

  const allowlist = parseMcpRemoteAllowlist(env);
  if (allowlist.length > 0) {
    const matched = allowlist.some((candidate) => hostMatchesAllowlist(hostname, candidate));
    if (!matched) {
      return `Remote MCP host "${hostname}" is not in EMBER_MCP_REMOTE_ALLOWLIST.`;
    }
    return null;
  }

  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  const isDevLike = nodeEnv === "" || nodeEnv === "development" || nodeEnv === "test";
  if (isDevLike) {
    return null;
  }

  return "Remote MCP install targets are blocked in production unless EMBER_MCP_REMOTE_ALLOWLIST is configured.";
}

export function validateRequestBodyShape(
  routePath: string,
  method: string,
  body: unknown,
): string | null {
  const upperMethod = method.toUpperCase();
  const routeKey = `${upperMethod}:${routePath}`;

  if ((upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH")
    && !NO_BODY_REQUIRED_ROUTES.has(routeKey)
    && body !== undefined
    && body !== null
    && !isPlainObject(body)) {
    return "Request body must be an object.";
  }

  if (routeKey === "POST:/api/chat" || routeKey === "POST:/api/chat/stream") {
    if (!isPlainObject(body)) {
      return "Chat request body is required.";
    }
    if (typeof body.content !== "string") {
      return "chat.content must be a string.";
    }
    if (typeof body.mode !== "string") {
      return "chat.mode must be a string.";
    }
    if (!Array.isArray(body.conversation)) {
      return "chat.conversation must be an array.";
    }
  }

  if (routeKey === "POST:/api/chat/attachments/prepare") {
    if (!isPlainObject(body) || !Array.isArray(body.uploads) || body.uploads.length === 0) {
      return "uploads is required and must be a non-empty array.";
    }
    const uploads = body.uploads as unknown[];
    for (const upload of uploads) {
      if (!isPlainObject(upload)
        || typeof upload.id !== "string"
        || typeof upload.name !== "string"
        || typeof upload.mediaType !== "string"
        || typeof upload.dataUrl !== "string") {
        return "Each upload must include id, name, mediaType, and dataUrl strings.";
      }
    }
  }

  if (routeKey === "POST:/api/providers") {
    if (!isPlainObject(body) || typeof body.name !== "string" || typeof body.typeId !== "string") {
      return "name and typeId are required.";
    }
    if (body.config !== undefined && !isStringRecord(body.config)) {
      return "config must be an object of string values.";
    }
    if (body.secrets !== undefined && !isStringRecord(body.secrets)) {
      return "secrets must be an object of string values.";
    }
  }

  if (routeKey === "PUT:/api/providers/:id") {
    if (!isPlainObject(body)) {
      return "Provider update payload is required.";
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      return "name must be a string.";
    }
    if (body.config !== undefined && !isStringRecord(body.config)) {
      return "config must be an object of string values.";
    }
    if (body.secrets !== undefined && !isStringRecord(body.secrets)) {
      return "secrets must be an object of string values.";
    }
    if (body.clearSecrets !== undefined && !isStringArray(body.clearSecrets)) {
      return "clearSecrets must be an array of strings.";
    }
  }

  if (routeKey === "PATCH:/api/conversations/:id") {
    if (!isPlainObject(body)) {
      return "Conversation update payload is required.";
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      return "title must be a string.";
    }
  }

  if (routeKey === "PUT:/api/settings") {
    if (!isPlainObject(body) || !isPlainObject(body.item)) {
      return "settings.item is required.";
    }
    const customTools = body.item.customTools;
    if (customTools !== undefined) {
      if (!isPlainObject(customTools)) {
        return "settings.item.customTools must be an object.";
      }
      if (
        customTools.trustMode !== undefined &&
        customTools.trustMode !== "disabled" &&
        customTools.trustMode !== "local-only" &&
        customTools.trustMode !== "allow"
      ) {
        return "settings.item.customTools.trustMode must be disabled, local-only, or allow.";
      }
    }
  }

  if (routeKey === "PUT:/api/roles") {
    if (!isPlainObject(body) || !Array.isArray(body.items)) {
      return "roles.items is required.";
    }
  }

  if (routeKey === "POST:/api/mcp/install") {
    if (!isPlainObject(body)) {
      return "MCP install body must be an object.";
    }
    if (body.transport !== undefined && typeof body.transport !== "string") {
      return "transport must be a string.";
    }
    if (body.packageName !== undefined && typeof body.packageName !== "string") {
      return "packageName must be a string.";
    }
    if (body.serverName !== undefined && typeof body.serverName !== "string") {
      return "serverName must be a string.";
    }
    if (body.scope !== undefined && typeof body.scope !== "string") {
      return "scope must be a string.";
    }
    if (body.roles !== undefined && !isStringArray(body.roles)) {
      return "roles must be an array of strings.";
    }
    if (body.args !== undefined && !isStringArray(body.args)) {
      return "args must be an array of strings.";
    }
    if (body.env !== undefined && !isStringRecord(body.env)) {
      return "env must be an object of string values.";
    }
    if (body.headers !== undefined && !isStringRecord(body.headers)) {
      return "headers must be an object of string values.";
    }
    if (body.timeout !== undefined && (typeof body.timeout !== "number" || !Number.isFinite(body.timeout))) {
      return "timeout must be a finite number.";
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      return "description must be a string.";
    }
  }

  if (routeKey === "PUT:/api/mcp/servers/:scope/:name") {
    if (!isPlainObject(body) || !isPlainObject(body.config)) {
      return "config is required.";
    }
  }

  if (routeKey === "POST:/api/memory/replay") {
    if (body === undefined || body === null) {
      return null;
    }
    if (!isPlainObject(body)) {
      return "Memory replay payload must be an object.";
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
      return "force must be a boolean.";
    }
  }

  if (
    routeKey === "POST:/api/memory/items/:id/suppress"
    || routeKey === "POST:/api/memory/items/:id/revalidate"
    || routeKey === "POST:/api/memory/items/:id/approve"
    || routeKey === "POST:/api/memory/items/:id/retire"
  ) {
    if (body === undefined || body === null) {
      return null;
    }
    if (!isPlainObject(body)) {
      return "Memory mutation payload must be an object.";
    }
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return "reason must be a string.";
    }
  }

  if (routeKey === "POST:/api/terminal/approvals/:id") {
    if (!isPlainObject(body) || typeof body.decision !== "string") {
      return "decision is required.";
    }
    if (!["deny", "once", "session", "always"].includes(body.decision)) {
      return "decision must be deny, once, session, or always.";
    }
  }

  return null;
}

type RateEntry = {
  count: number;
  resetAt: number;
};

export class MemoryRateLimiter {
  private readonly buckets = new Map<string, RateEntry>();

  check(key: string, options: ApiRateLimitConfig, now = Date.now()): boolean {
    const normalizedWindow = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 60_000;
    const normalizedMax = Number.isFinite(options.max) && options.max > 0 ? options.max : 120;
    const existing = this.buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + normalizedWindow,
      });
      return true;
    }
    if (existing.count >= normalizedMax) {
      return false;
    }
    existing.count += 1;
    this.buckets.set(key, existing);
    return true;
  }
}

export class MemoryIdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private persistScheduled = false;

  constructor(config: Pick<ApiIdempotencyConfig, "ttlMs" | "maxEntries">) {
    this.ttlMs = Number.isFinite(config.ttlMs) && config.ttlMs > 0 ? config.ttlMs : 10 * 60_000;
    this.maxEntries =
      Number.isFinite(config.maxEntries) && config.maxEntries > 0
        ? Math.floor(config.maxEntries)
        : 1_000;
  }

  begin(input: { key: string; fingerprint: string; now?: number }): IdempotencyBeginResult {
    const now = input.now ?? Date.now();
    this.prune(now);
    const existing = this.entries.get(input.key);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) {
        return {
          kind: "mismatch",
          message: "Idempotency key reuse with a different request payload is not allowed.",
        };
      }
      if (existing.status === "in-flight") {
        return {
          kind: "in-flight",
          message: "A request with this idempotency key is already in progress.",
        };
      }
      return {
        kind: "replay",
        statusCode: existing.statusCode ?? 200,
        body: existing.body,
      };
    }

    this.entries.set(input.key, {
      fingerprint: input.fingerprint,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: "in-flight",
      statusCode: null,
      body: null,
    });
    this.pruneOverflow();
    return { kind: "started" };
  }

  complete(input: {
    key: string;
    fingerprint: string;
    statusCode: number;
    body: unknown;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    const existing = this.entries.get(input.key);
    if (!existing || existing.fingerprint !== input.fingerprint) {
      return;
    }

    if (input.statusCode >= 500) {
      this.entries.delete(input.key);
      return;
    }

    this.entries.set(input.key, {
      ...existing,
      status: "completed",
      statusCode: input.statusCode,
      body: input.body,
      expiresAt: now + this.ttlMs,
    });
    this.prune(now);
    this.pruneOverflow();
    this.schedulePersist();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private pruneOverflow(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    const oldest = [...this.entries.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt);
    const overflowCount = this.entries.size - this.maxEntries;
    for (let index = 0; index < overflowCount; index += 1) {
      const key = oldest[index]?.[0];
      if (key) {
        this.entries.delete(key);
      }
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private schedulePersist(): void {
    if (this.persistScheduled) {
      return;
    }
    this.persistScheduled = true;
    // Debounce: batch rapid complete() calls into a single write.
    setTimeout(() => {
      this.persistScheduled = false;
      void this.persist();
    }, 500);
  }

  async persist(): Promise<void> {
    try {
      const now = Date.now();
      const serializable: Record<string, IdempotencyEntry> = {};
      for (const [key, entry] of this.entries.entries()) {
        // Only persist completed entries that haven't expired.
        if (entry.status === "completed" && entry.expiresAt > now) {
          serializable[key] = entry;
        }
      }
      const filePath = nodePath.join(getDataRoot(), "idempotency-store.json");
      await mkdir(nodePath.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(serializable, null, 2), "utf8");
    } catch {
      // Best-effort persistence.
    }
  }

  async restore(): Promise<number> {
    try {
      const filePath = nodePath.join(getDataRoot(), "idempotency-store.json");
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw) as Record<string, IdempotencyEntry>;
      const now = Date.now();
      let restored = 0;
      for (const [key, entry] of Object.entries(data)) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof entry.fingerprint === "string" &&
          typeof entry.expiresAt === "number" &&
          entry.status === "completed" &&
          entry.expiresAt > now
        ) {
          this.entries.set(key, entry);
          restored++;
        }
      }
      this.pruneOverflow();
      return restored;
    } catch {
      return 0;
    }
  }
}

function parseBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]?.trim() || null : null;
}

function safeTokenEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function parseEnvBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (value === undefined) {
    return null;
  }
  return value;
}

function hostMatchesAllowlist(hostname: string, candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1);
    return hostname.endsWith(suffix);
  }
  return hostname === normalized;
}

function isMutationMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE";
}

function corsOriginMatches(allowedOrigin: string, origin: string): boolean {
  if (allowedOrigin === origin) {
    return true;
  }
  if (!allowedOrigin.includes("*")) {
    return false;
  }
  return wildcardOriginMatch(allowedOrigin, origin);
}

function wildcardOriginMatch(pattern: string, origin: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const expression = new RegExp(`^${escaped}$`, "i");
  return expression.test(origin);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
