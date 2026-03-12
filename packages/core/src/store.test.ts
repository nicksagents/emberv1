import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { ensureDataFiles, readCredentialVault, writeCredentialVault } from "./store";

test("credential vault data file is created and persists local credentials", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = tempRoot;

  try {
    await ensureDataFiles();

    const vaultPath = path.join(tempRoot, "data", "credential-vault.json");
    assert.equal(existsSync(vaultPath), true);
    assert.deepEqual(await readCredentialVault(), []);

    await writeCredentialVault([
      {
        id: "cred_demo",
        label: "Demo Login",
        target: "demo.example.com",
        kind: "website",
        username: null,
        email: "demo@example.com",
        password: "super-secret",
        loginUrl: "https://demo.example.com/login",
        appName: null,
        notes: "Local-only credential.",
        tags: ["demo"],
        hasSecret: true,
        secretBackend: "local-file",
        secretRef: null,
        createdAt: "2026-03-12T12:00:00.000Z",
        updatedAt: "2026-03-12T12:00:00.000Z",
        lastUsedAt: null,
      },
    ]);

    const stored = await readCredentialVault();
    const raw = await readFile(vaultPath, "utf8");

    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.email, "demo@example.com");
    assert.equal(stored[0]?.hasSecret, true);
    assert.equal(stored[0]?.secretBackend, "local-file");
    assert.match(raw, /"password": "super-secret"/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
