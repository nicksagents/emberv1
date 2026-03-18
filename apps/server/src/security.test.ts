import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAuthConfigIsSafe,
  buildIdempotencyFingerprint,
  isRuntimeMcpInstallEnabled,
  isCorsOriginAllowed,
  MemoryIdempotencyStore,
  normalizeIdempotencyKey,
  parseCorsOrigins,
  resolveIdempotencyConfig,
  validateMcpRemoteTarget,
  resolveApiAccessClass,
  resolveApiAuthConfig,
  shouldApplyIdempotency,
  validateMutationOrigin,
  validateRequestBodyShape,
} from "./security.js";

test("resolveApiAccessClass uses admin scope for settings/mcp/providers/roles", () => {
  assert.equal(resolveApiAccessClass("/api/settings", "GET"), "admin");
  assert.equal(resolveApiAccessClass("/api/providers", "POST"), "admin");
  assert.equal(resolveApiAccessClass("/api/mcp/servers", "GET"), "admin");
  assert.equal(resolveApiAccessClass("/api/roles", "PUT"), "admin");
  assert.equal(resolveApiAccessClass("/api/terminal/approvals", "GET"), "admin");
  assert.equal(resolveApiAccessClass("/api/checkpoints", "GET"), "admin");
});

test("resolveApiAccessClass defaults to read/write for other endpoints", () => {
  assert.equal(resolveApiAccessClass("/api/conversations", "GET"), "read");
  assert.equal(resolveApiAccessClass("/api/session-recall", "GET"), "read");
  assert.equal(resolveApiAccessClass("/api/failover/metrics", "GET"), "read");
  assert.equal(resolveApiAccessClass("/api/parallel-tasks/traces", "GET"), "read");
  assert.equal(resolveApiAccessClass("/api/chat", "POST"), "write");
});

test("assertAuthConfigIsSafe rejects production without tokens", () => {
  const config = resolveApiAuthConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.throws(() => assertAuthConfigIsSafe(config), /requires API auth/i);
});

test("assertAuthConfigIsSafe accepts production with token", () => {
  const config = resolveApiAuthConfig({
    NODE_ENV: "production",
    EMBER_API_TOKEN: "demo",
  } as NodeJS.ProcessEnv);
  assert.doesNotThrow(() => assertAuthConfigIsSafe(config));
});

test("parseCorsOrigins defaults to localhost origins in development", () => {
  const origins = parseCorsOrigins({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.equal(origins.has("http://127.0.0.1:3000"), true);
  assert.equal(origins.has("http://localhost:3000"), true);
  assert.equal(isCorsOriginAllowed("http://localhost:3000", origins), true);
  assert.equal(isCorsOriginAllowed("https://evil.example", origins), false);
});

test("parseCorsOrigins uses explicit allowlist when configured", () => {
  const origins = parseCorsOrigins({
    NODE_ENV: "production",
    EMBER_CORS_ORIGINS: "https://app.example,https://ops.example",
  } as NodeJS.ProcessEnv);
  assert.equal(isCorsOriginAllowed("https://app.example", origins), true);
  assert.equal(isCorsOriginAllowed("https://evil.example", origins), false);
});

test("isCorsOriginAllowed supports wildcard origins", () => {
  const origins = parseCorsOrigins({
    NODE_ENV: "production",
    EMBER_CORS_ORIGINS: "https://*.example.com",
  } as NodeJS.ProcessEnv);
  assert.equal(isCorsOriginAllowed("https://app.example.com", origins), true);
  assert.equal(isCorsOriginAllowed("https://admin.example.com", origins), true);
  assert.equal(isCorsOriginAllowed("https://example.com", origins), false);
});

test("validateMutationOrigin enforces origin on mutating methods", () => {
  const allowed = new Set<string>(["http://localhost:3000", "https://*.example.com"]);
  const allowedRequest = {
    method: "POST",
    headers: { origin: "https://ops.example.com" },
  } as unknown as import("fastify").FastifyRequest;
  const deniedRequest = {
    method: "DELETE",
    headers: { origin: "https://evil.example.net" },
  } as unknown as import("fastify").FastifyRequest;
  const noOriginRequest = {
    method: "PATCH",
    headers: {},
  } as unknown as import("fastify").FastifyRequest;

  assert.deepEqual(validateMutationOrigin(allowedRequest, allowed), { ok: true });
  assert.deepEqual(validateMutationOrigin(noOriginRequest, allowed), { ok: true });
  assert.deepEqual(validateMutationOrigin(deniedRequest, allowed), {
    ok: false,
    message: "Origin not allowed.",
  });
});

test("isRuntimeMcpInstallEnabled defaults to enabled in dev-like env and disabled in production", () => {
  assert.equal(isRuntimeMcpInstallEnabled({ NODE_ENV: "development" } as NodeJS.ProcessEnv), true);
  assert.equal(isRuntimeMcpInstallEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv), true);
  assert.equal(isRuntimeMcpInstallEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
});

test("isRuntimeMcpInstallEnabled honors explicit env override", () => {
  assert.equal(
    isRuntimeMcpInstallEnabled({
      NODE_ENV: "production",
      EMBER_ENABLE_RUNTIME_MCP_INSTALL: "true",
    } as NodeJS.ProcessEnv),
    true,
  );
  assert.equal(
    isRuntimeMcpInstallEnabled({
      NODE_ENV: "development",
      EMBER_ENABLE_RUNTIME_MCP_INSTALL: "0",
    } as NodeJS.ProcessEnv),
    false,
  );
});

test("validateMcpRemoteTarget enforces production allowlist", () => {
  assert.match(
    validateMcpRemoteTarget(
      "https://mcp.example.test/sse",
      { NODE_ENV: "production" } as NodeJS.ProcessEnv,
    ) ?? "",
    /allowlist/i,
  );
  assert.equal(
    validateMcpRemoteTarget(
      "https://mcp.example.test/sse",
      {
        NODE_ENV: "production",
        EMBER_MCP_REMOTE_ALLOWLIST: "*.example.test",
      } as NodeJS.ProcessEnv,
    ),
    null,
  );
});

test("validateRequestBodyShape enforces chat payload basics", () => {
  assert.match(
    validateRequestBodyShape("/api/chat", "POST", {}) ?? "",
    /content/i,
  );
  assert.equal(
    validateRequestBodyShape("/api/chat", "POST", {
      content: "hello",
      mode: "auto",
      conversation: [],
    }),
    null,
  );
});

test("validateRequestBodyShape enforces settings payload", () => {
  assert.match(
    validateRequestBodyShape("/api/settings", "PUT", {}) ?? "",
    /settings\.item/i,
  );
  assert.match(
    validateRequestBodyShape("/api/settings", "PUT", {
      item: {
        customTools: {
          trustMode: "unsafe",
        },
      },
    }) ?? "",
    /trustMode/i,
  );
  assert.equal(
    validateRequestBodyShape("/api/settings", "PUT", {
      item: {
        customTools: {
          trustMode: "local-only",
        },
      },
    }),
    null,
  );
});

test("validateRequestBodyShape enforces provider update payload types", () => {
  assert.match(
    validateRequestBodyShape("/api/providers/:id", "PUT", {
      clearSecrets: "apiKey",
    }) ?? "",
    /clearSecrets must be an array/i,
  );
  assert.equal(
    validateRequestBodyShape("/api/providers/:id", "PUT", {
      clearSecrets: ["apiKey"],
      name: "OpenAI",
      config: { baseUrl: "http://127.0.0.1:11434/v1" },
    }),
    null,
  );
});

test("validateRequestBodyShape enforces memory mutation payloads", () => {
  assert.match(
    validateRequestBodyShape("/api/memory/items/:id/suppress", "POST", {
      reason: true,
    }) ?? "",
    /reason must be a string/i,
  );
  assert.equal(
    validateRequestBodyShape("/api/memory/items/:id/suppress", "POST", {
      reason: "duplicate memory",
    }),
    null,
  );
});

test("validateRequestBodyShape enforces terminal approval decision payload", () => {
  assert.match(
    validateRequestBodyShape("/api/terminal/approvals/:id", "POST", {
      decision: "invalid",
    }) ?? "",
    /decision must be/i,
  );
  assert.equal(
    validateRequestBodyShape("/api/terminal/approvals/:id", "POST", {
      decision: "session",
    }),
    null,
  );
});

test("resolveIdempotencyConfig defaults to enabled with bounded defaults", () => {
  const config = resolveIdempotencyConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.ttlMs > 0, true);
  assert.equal(config.maxEntries > 0, true);
});

test("shouldApplyIdempotency scopes to mutating control-plane routes", () => {
  assert.equal(shouldApplyIdempotency("/api/settings", "PUT"), true);
  assert.equal(shouldApplyIdempotency("/api/providers/provider-1/connect", "POST"), true);
  assert.equal(shouldApplyIdempotency("/api/mcp/install", "POST"), true);
  assert.equal(shouldApplyIdempotency("/api/checkpoints/abc/rollback", "POST"), true);
  assert.equal(shouldApplyIdempotency("/api/terminal/approvals", "GET"), false);
  assert.equal(shouldApplyIdempotency("/api/chat", "POST"), false);
});

test("normalizeIdempotencyKey trims header values and handles arrays", () => {
  assert.equal(normalizeIdempotencyKey("  abc-123  "), "abc-123");
  assert.equal(normalizeIdempotencyKey(["key-1", "key-2"]), "key-1");
  assert.equal(normalizeIdempotencyKey("   "), null);
});

test("buildIdempotencyFingerprint is stable for object key order", () => {
  const first = buildIdempotencyFingerprint({
    method: "POST",
    pathname: "/api/providers",
    body: { b: 2, a: 1 },
  });
  const second = buildIdempotencyFingerprint({
    method: "post",
    pathname: "/api/providers",
    body: { a: 1, b: 2 },
  });
  assert.equal(first, second);
});

test("MemoryIdempotencyStore supports replay, mismatch, and in-flight behavior", () => {
  const store = new MemoryIdempotencyStore({
    ttlMs: 60_000,
    maxEntries: 128,
  });
  const key = "idem-1";
  const fingerprint = "fp-1";

  assert.deepEqual(
    store.begin({ key, fingerprint }),
    { kind: "started" },
  );

  const inFlight = store.begin({ key, fingerprint });
  assert.equal(inFlight.kind, "in-flight");

  const mismatch = store.begin({ key, fingerprint: "fp-2" });
  assert.equal(mismatch.kind, "mismatch");

  store.complete({
    key,
    fingerprint,
    statusCode: 200,
    body: { ok: true },
  });
  const replay = store.begin({ key, fingerprint });
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.body, { ok: true });
  }
});

test("MemoryIdempotencyStore clears keys after 5xx responses", () => {
  const store = new MemoryIdempotencyStore({
    ttlMs: 60_000,
    maxEntries: 128,
  });
  const key = "idem-500";
  const fingerprint = "fp-500";

  assert.deepEqual(store.begin({ key, fingerprint }), { kind: "started" });
  store.complete({
    key,
    fingerprint,
    statusCode: 500,
    body: { error: "boom" },
  });

  assert.deepEqual(store.begin({ key, fingerprint }), { kind: "started" });
});
