import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import {
  ensureDataFiles,
  readCredentialVault,
  readProviderSecrets,
  readSettings,
  writeCredentialVault,
  writeProviderSecrets,
  writeSettings,
} from "./store";

function encryptWithLegacySecret(value: unknown): string {
  const legacySecret = [
    os.userInfo().username,
    os.hostname(),
    os.platform(),
    os.arch(),
    os.homedir(),
  ].join(":");
  const iv = randomBytes(12);
  const salt = randomBytes(16);
  const key = scryptSync(legacySecret, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${JSON.stringify({
    __format: "ember-aes-256-gcm-v1",
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }, null, 2)}\n`;
}

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
    assert.match(raw, /"__format": "ember-aes-256-gcm-v1"/);
    assert.doesNotMatch(raw, /super-secret/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("settings secrets are stored in private encrypted file and excluded from public settings", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  const previousRoot = process.env.EMBER_ROOT;
  const previousProviderSecretsBackend = process.env.EMBER_PROVIDER_SECRETS_BACKEND;
  process.env.EMBER_ROOT = tempRoot;
  process.env.EMBER_PROVIDER_SECRETS_BACKEND = "encrypted-file";

  try {
    await ensureDataFiles();
    const settings = await readSettings();
    settings.sudoPassword = "top-secret";
    settings.braveApiKey = "brv-12345";
    await writeSettings(settings);

    const publicSettingsPath = path.join(tempRoot, "data", "settings.json");
    const privateSettingsPath = path.join(tempRoot, "data", "settings-secrets.json");
    const publicRaw = await readFile(publicSettingsPath, "utf8");
    const privateRaw = await readFile(privateSettingsPath, "utf8");

    assert.doesNotMatch(publicRaw, /top-secret/);
    assert.doesNotMatch(publicRaw, /brv-12345/);
    assert.match(privateRaw, /"__format": "ember-aes-256-gcm-v1"/);

    const hydrated = await readSettings();
    assert.equal(hydrated.sudoPassword, "top-secret");
    assert.equal(hydrated.braveApiKey, "brv-12345");
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousProviderSecretsBackend === undefined) {
      delete process.env.EMBER_PROVIDER_SECRETS_BACKEND;
    } else {
      process.env.EMBER_PROVIDER_SECRETS_BACKEND = previousProviderSecretsBackend;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("provider secrets are encrypted at rest", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  const previousRoot = process.env.EMBER_ROOT;
  const previousProviderSecretsBackend = process.env.EMBER_PROVIDER_SECRETS_BACKEND;
  process.env.EMBER_ROOT = tempRoot;
  process.env.EMBER_PROVIDER_SECRETS_BACKEND = "encrypted-file";

  try {
    await ensureDataFiles();
    await writeProviderSecrets({
      provider_demo: {
        apiKey: "super-provider-secret",
      },
    });
    const providerSecretsPath = path.join(tempRoot, "data", "provider-secrets.json");
    const raw = await readFile(providerSecretsPath, "utf8");

    assert.match(raw, /"__format": "ember-aes-256-gcm-v1"/);
    assert.doesNotMatch(raw, /super-provider-secret/);

    const hydrated = await readProviderSecrets();
    assert.equal(hydrated.provider_demo?.apiKey, "super-provider-secret");
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousProviderSecretsBackend === undefined) {
      delete process.env.EMBER_PROVIDER_SECRETS_BACKEND;
    } else {
      process.env.EMBER_PROVIDER_SECRETS_BACKEND = previousProviderSecretsBackend;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("concurrent provider secret writes remain valid and clean temporary files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  const previousRoot = process.env.EMBER_ROOT;
  const previousProviderSecretsBackend = process.env.EMBER_PROVIDER_SECRETS_BACKEND;
  process.env.EMBER_ROOT = tempRoot;
  process.env.EMBER_PROVIDER_SECRETS_BACKEND = "encrypted-file";

  try {
    await ensureDataFiles();

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        writeProviderSecrets({
          provider_demo: {
            apiKey: `secret-${index}`,
          },
        })),
    );

    const hydrated = await readProviderSecrets();
    assert.equal(hydrated.provider_demo?.apiKey, "secret-9");

    const files = await readdir(path.join(tempRoot, "data"));
    assert.equal(files.some((name) => name.includes(".tmp-")), false);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousProviderSecretsBackend === undefined) {
      delete process.env.EMBER_PROVIDER_SECRETS_BACKEND;
    } else {
      process.env.EMBER_PROVIDER_SECRETS_BACKEND = previousProviderSecretsBackend;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("provider secrets support keychain-style backend through mock mode", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  const previousRoot = process.env.EMBER_ROOT;
  const previousProviderSecretsBackend = process.env.EMBER_PROVIDER_SECRETS_BACKEND;
  process.env.EMBER_ROOT = tempRoot;
  process.env.EMBER_PROVIDER_SECRETS_BACKEND = "mock-keychain";

  try {
    await ensureDataFiles();
    await writeProviderSecrets({
      provider_demo: {
        apiKey: "mock-keychain-secret",
      },
    });

    const hydrated = await readProviderSecrets();
    assert.equal(hydrated.provider_demo?.apiKey, "mock-keychain-secret");

    const providerSecretsPath = path.join(tempRoot, "data", "provider-secrets.json");
    const raw = await readFile(providerSecretsPath, "utf8");
    assert.doesNotMatch(raw, /mock-keychain-secret/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousProviderSecretsBackend === undefined) {
      delete process.env.EMBER_PROVIDER_SECRETS_BACKEND;
    } else {
      process.env.EMBER_PROVIDER_SECRETS_BACKEND = previousProviderSecretsBackend;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("deriveSecretMaterial uses EMBER_SECRET_KEY when set and does not create secret key file", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "ember-home-"));
  const previousRoot = process.env.EMBER_ROOT;
  const previousHome = process.env.HOME;
  const previousSecret = process.env.EMBER_SECRET_KEY;
  process.env.EMBER_ROOT = tempRoot;
  process.env.HOME = tempHome;
  process.env.EMBER_SECRET_KEY = "explicit-test-secret";

  try {
    await ensureDataFiles();
    await writeProviderSecrets({
      provider_demo: {
        apiKey: "explicit-secret",
      },
    });
    const hydrated = await readProviderSecrets();
    assert.equal(hydrated.provider_demo?.apiKey, "explicit-secret");
    assert.equal(existsSync(path.join(tempHome, ".ember", ".secret-key")), false);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousSecret === undefined) {
      delete process.env.EMBER_SECRET_KEY;
    } else {
      process.env.EMBER_SECRET_KEY = previousSecret;
    }
    await rm(tempRoot, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("secret key file is generated on first run and reused across reads", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "ember-home-"));
  const previousRoot = process.env.EMBER_ROOT;
  const previousHome = process.env.HOME;
  const previousSecret = process.env.EMBER_SECRET_KEY;
  process.env.EMBER_ROOT = tempRoot;
  process.env.HOME = tempHome;
  delete process.env.EMBER_SECRET_KEY;

  try {
    await ensureDataFiles();
    await writeProviderSecrets({
      provider_demo: {
        apiKey: "persisted-secret",
      },
    });

    const keyPath = path.join(tempHome, ".ember", ".secret-key");
    assert.equal(existsSync(keyPath), true);
    const firstKey = (await readFile(keyPath, "utf8")).trim();
    assert.ok(firstKey.length >= 64);

    const firstRead = await readProviderSecrets();
    assert.equal(firstRead.provider_demo?.apiKey, "persisted-secret");

    const secondRead = await readProviderSecrets();
    assert.equal(secondRead.provider_demo?.apiKey, "persisted-secret");
    const secondKey = (await readFile(keyPath, "utf8")).trim();
    assert.equal(secondKey, firstKey);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousSecret === undefined) {
      delete process.env.EMBER_SECRET_KEY;
    } else {
      process.env.EMBER_SECRET_KEY = previousSecret;
    }
    await rm(tempRoot, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("legacy encrypted payloads migrate to the persisted secret key", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "ember-home-"));
  const previousRoot = process.env.EMBER_ROOT;
  const previousHome = process.env.HOME;
  const previousSecret = process.env.EMBER_SECRET_KEY;
  process.env.EMBER_ROOT = tempRoot;
  process.env.HOME = tempHome;
  delete process.env.EMBER_SECRET_KEY;

  try {
    await ensureDataFiles();
    const providerSecretsPath = path.join(tempRoot, "data", "provider-secrets.json");
    await writeFile(
      providerSecretsPath,
      encryptWithLegacySecret({
        provider_demo: {
          apiKey: "legacy-secret",
        },
      }),
      "utf8",
    );

    const hydrated = await readProviderSecrets();
    assert.equal(hydrated.provider_demo?.apiKey, "legacy-secret");

    const migratedRaw = await readFile(providerSecretsPath, "utf8");
    assert.match(migratedRaw, /"__format": "ember-aes-256-gcm-v1"/);
    assert.doesNotMatch(migratedRaw, /legacy-secret/);
    assert.equal(existsSync(path.join(tempHome, ".ember", ".secret-key")), true);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousSecret === undefined) {
      delete process.env.EMBER_SECRET_KEY;
    } else {
      process.env.EMBER_SECRET_KEY = previousSecret;
    }
    await rm(tempRoot, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  }
});
