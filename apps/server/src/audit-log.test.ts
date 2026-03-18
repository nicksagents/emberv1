import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { buildRequestAuditEvent, writeAuditEvent } from "./audit-log.js";

function getDateTag(): string {
  return new Date().toISOString().slice(0, 10);
}

function getAuditLogPath(tempRoot: string): string {
  return path.join(tempRoot, "data", "audit-logs", `audit-${getDateTag()}.jsonl`);
}

test("buildRequestAuditEvent captures request metadata and strips query strings", () => {
  const request = {
    method: "POST",
    url: "/api/providers?verbose=1",
    ip: "127.0.0.1",
  } as unknown as import("fastify").FastifyRequest;

  const event = buildRequestAuditEvent(request, "providers.create", "ok", {
    providerId: "provider_demo",
  });

  assert.equal(event.action, "providers.create");
  assert.equal(event.method, "POST");
  assert.equal(event.path, "/api/providers");
  assert.equal(event.ip, "127.0.0.1");
  assert.equal(event.status, "ok");
});

test("writeAuditEvent redacts sensitive fields in details", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-audit-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    await writeAuditEvent({
      action: "settings.update",
      method: "PUT",
      path: "/api/settings",
      ip: "127.0.0.1",
      status: "ok",
      details: {
        apiKey: "super-secret",
        nested: {
          token: "abc123",
          safe: "value",
        },
      },
    });

    const raw = await readFile(getAuditLogPath(tempRoot), "utf8");
    assert.match(raw, /"action":"settings\.update"/);
    assert.doesNotMatch(raw, /super-secret/);
    assert.doesNotMatch(raw, /abc123/);
    assert.match(raw, /"\[REDACTED\]"/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("writeAuditEvent redacts deeply nested sensitive fields and caps nested depth", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-audit-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  const deepPayload = {
    level1: {
      level2: {
        level3: {
          apiKey: "sk-123",
        },
      },
    },
    depth: {
      n1: {
        n2: {
          n3: {
            n4: {
              n5: {
                n6: {
                  n7: {
                    n8: {
                      n9: {
                        n10: {
                          n11: "too-deep",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  try {
    await writeAuditEvent({
      action: "providers.update",
      method: "PUT",
      path: "/api/providers",
      ip: "127.0.0.1",
      status: "ok",
      details: deepPayload,
    });

    const raw = await readFile(getAuditLogPath(tempRoot), "utf8");
    assert.doesNotMatch(raw, /sk-123/);
    assert.match(raw, /"\[REDACTED\]"/);
    assert.match(raw, /"\[nested\]"/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("writeAuditEvent rotates audit logs when file size exceeds threshold", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-audit-"));
  const previousRoot = process.env.EMBER_ROOT;
  const previousMaxSize = process.env.EMBER_AUDIT_LOG_MAX_SIZE_BYTES;
  const previousMaxRotated = process.env.EMBER_AUDIT_LOG_MAX_ROTATED;
  process.env.EMBER_ROOT = tempRoot;
  process.env.EMBER_AUDIT_LOG_MAX_SIZE_BYTES = "1200";
  process.env.EMBER_AUDIT_LOG_MAX_ROTATED = "2";

  try {
    for (let index = 0; index < 30; index += 1) {
      await writeAuditEvent({
        action: "rotation.test",
        method: "POST",
        path: "/api/rotation",
        ip: "127.0.0.1",
        status: "ok",
        details: {
          index,
          message: `entry-${index}-${"x".repeat(200)}`,
        },
      });
    }

    const activePath = getAuditLogPath(tempRoot);
    const rotatedPath = `${activePath}.1`;
    assert.equal(existsSync(activePath), true);
    assert.equal(existsSync(rotatedPath), true);
    const activeRaw = await readFile(activePath, "utf8");
    const rotatedRaw = await readFile(rotatedPath, "utf8");
    assert.match(activeRaw, /rotation\.test/);
    assert.match(rotatedRaw, /rotation\.test/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousMaxSize === undefined) {
      delete process.env.EMBER_AUDIT_LOG_MAX_SIZE_BYTES;
    } else {
      process.env.EMBER_AUDIT_LOG_MAX_SIZE_BYTES = previousMaxSize;
    }
    if (previousMaxRotated === undefined) {
      delete process.env.EMBER_AUDIT_LOG_MAX_ROTATED;
    } else {
      process.env.EMBER_AUDIT_LOG_MAX_ROTATED = previousMaxRotated;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
