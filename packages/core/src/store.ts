import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  defaultConnectorTypes,
  defaultRoleAssignments,
  defaultRuntime,
  defaultSettings,
  defaultSettingsSecrets,
  normalizeSettings,
  normalizeProvider,
} from "./defaults";
import type {
  Conversation,
  ConnectorType,
  Provider,
  CredentialEntry,
  CredentialSecretBackend,
  ProviderSecrets,
  RoleAssignment,
  RuntimeState,
  Settings,
  SettingsSecrets,
} from "./types";
import { createEmptyMemoryStoreData } from "./memory/defaults";
import type { MemoryStoreData } from "./memory/types";

const DATA_FILES = {
  connectorTypes: "connector-types.json",
  conversations: "conversations.json",
  credentialVault: "credential-vault.json",
  memory: "memory.json",
  providers: "providers.json",
  providerSecrets: "provider-secrets.json",
  roleAssignments: "role-assignments.json",
  settings: "settings.json",
  settingsSecrets: "settings-secrets.json",
  runtime: "runtime.json",
} as const;

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const PRIVATE_DATA_FILES = new Set<string>([
  DATA_FILES.credentialVault,
  DATA_FILES.providerSecrets,
  DATA_FILES.settingsSecrets,
]);

const ENCRYPTED_PRIVATE_DATA_FILES = new Set<string>([
  DATA_FILES.credentialVault,
  DATA_FILES.providerSecrets,
  DATA_FILES.settingsSecrets,
]);
const FILE_WRITE_LOCKS = new Map<string, Promise<void>>();
const PROVIDER_SECRETS_REF = "ember:provider-secrets";
const PROVIDER_SECRETS_MOCK_STORE = new Map<string, string>();

type EncryptedJsonPayload = {
  __format: "ember-aes-256-gcm-v1";
  iv: string;
  salt: string;
  tag: string;
  ciphertext: string;
};

const SECRET_KEY_DIR_NAME = ".ember";
const SECRET_KEY_FILE_NAME = ".secret-key";
let cachedSecretMaterial: { value: string; homeDir: string } | null = null;
let warnedLegacySecretFallback = false;

function isEncryptedJsonPayload(value: unknown): value is EncryptedJsonPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.__format === "ember-aes-256-gcm-v1"
    && typeof record.iv === "string"
    && typeof record.salt === "string"
    && typeof record.tag === "string"
    && typeof record.ciphertext === "string";
}

function deriveSecretMaterial(): string {
  // EMBER_SECRET_KEY always takes priority when explicitly provided.
  const explicit = process.env.EMBER_SECRET_KEY?.trim();
  if (explicit) {
    return explicit;
  }

  const homeDir = os.homedir();
  if (cachedSecretMaterial && cachedSecretMaterial.homeDir === homeDir) {
    return cachedSecretMaterial.value;
  }

  const persisted = readOrCreatePersistedSecretKey(homeDir);
  if (persisted) {
    cachedSecretMaterial = { value: persisted, homeDir };
    return persisted;
  }

  if (!warnedLegacySecretFallback) {
    warnedLegacySecretFallback = true;
    console.warn(
      "[ember] Could not initialize ~/.ember/.secret-key; falling back to legacy machine-derived secret material.",
    );
  }
  const legacy = deriveLegacySecretMaterial();
  cachedSecretMaterial = { value: legacy, homeDir };
  return legacy;
}

function deriveLegacySecretMaterial(): string {
  const user = os.userInfo().username;
  return [user, os.hostname(), os.platform(), os.arch(), os.homedir()].join(":");
}

function readOrCreatePersistedSecretKey(homeDir: string): string | null {
  try {
    const keyDir = path.join(homeDir, SECRET_KEY_DIR_NAME);
    const keyPath = path.join(keyDir, SECRET_KEY_FILE_NAME);
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath, "utf8").trim();
      if (existing) {
        return existing;
      }
    }

    mkdirSync(keyDir, { recursive: true });
    const generated = randomBytes(32).toString("hex");
    writeFileSync(keyPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Best-effort only; some platforms ignore POSIX file modes.
    }
    return generated;
  } catch {
    return null;
  }
}

function encryptPrivatePayload<T>(value: T): EncryptedJsonPayload {
  const iv = randomBytes(12);
  const salt = randomBytes(16);
  const key = scryptSync(deriveSecretMaterial(), salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    __format: "ember-aes-256-gcm-v1",
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptPrivatePayload<T>(value: EncryptedJsonPayload): T {
  return decryptPrivatePayloadWithSecret(value, deriveSecretMaterial());
}

function decryptPrivatePayloadWithSecret<T>(value: EncryptedJsonPayload, secret: string): T {
  const iv = Buffer.from(value.iv, "base64");
  const salt = Buffer.from(value.salt, "base64");
  const tag = Buffer.from(value.tag, "base64");
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  const key = scryptSync(secret, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

type ProviderSecretsBackend = "encrypted-file" | "os-keychain" | "mock-keychain";

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

function runSecretCommand(command: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function resolveProviderSecretsBackend(env = process.env): ProviderSecretsBackend {
  const forced = env.EMBER_PROVIDER_SECRETS_BACKEND?.trim().toLowerCase();
  if (forced === "encrypted-file" || forced === "local-file") {
    return "encrypted-file";
  }
  if (forced === "mock" || forced === "mock-keychain") {
    return "mock-keychain";
  }
  if (forced === "os-keychain") {
    return "os-keychain";
  }

  if (process.platform === "darwin" && commandExists("security")) {
    return "os-keychain";
  }
  if (process.platform === "linux" && commandExists("secret-tool")) {
    return "os-keychain";
  }
  return "encrypted-file";
}

function writeProviderSecretsToKeychain(value: ProviderSecrets): void {
  const payload = JSON.stringify(value);
  if (process.platform === "darwin") {
    const result = runSecretCommand("security", [
      "add-generic-password",
      "-U",
      "-a",
      "ember",
      "-s",
      PROVIDER_SECRETS_REF,
      "-w",
      payload,
    ]);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(detail || "Failed to write provider secrets to macOS keychain.");
    }
    return;
  }

  if (process.platform === "linux") {
    const result = runSecretCommand(
      "secret-tool",
      [
        "store",
        "--label",
        "Ember Provider Secrets",
        "application",
        "ember",
        "kind",
        "provider-secrets",
      ],
      payload,
    );
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(detail || "Failed to write provider secrets to Secret Service keychain.");
    }
    return;
  }

  throw new Error("Operating-system keychain backend is not available on this host.");
}

function readProviderSecretsFromKeychain(): ProviderSecrets | null {
  if (process.platform === "darwin") {
    const result = runSecretCommand("security", [
      "find-generic-password",
      "-a",
      "ember",
      "-s",
      PROVIDER_SECRETS_REF,
      "-w",
    ]);
    if (result.status !== 0) {
      return null;
    }
    const raw = result.stdout.trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as ProviderSecrets;
  }

  if (process.platform === "linux") {
    const result = runSecretCommand("secret-tool", [
      "lookup",
      "application",
      "ember",
      "kind",
      "provider-secrets",
    ]);
    if (result.status !== 0) {
      return null;
    }
    const raw = result.stdout.trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as ProviderSecrets;
  }

  return null;
}

export function resolveRepoRoot(from = process.cwd()): string {
  let current = path.resolve(from);

  while (true) {
    const marker = path.join(current, "pnpm-workspace.yaml");
    if (existsSync(marker)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(from);
    }
    current = parent;
  }
}

export function getDataRoot(from = process.cwd()): string {
  const repoRoot = process.env.EMBER_ROOT
    ? path.resolve(process.env.EMBER_ROOT)
    : resolveRepoRoot(from);

  return path.join(repoRoot, "data");
}

export async function ensureDataFiles(from = process.cwd()): Promise<void> {
  const repoRoot = process.env.EMBER_ROOT
    ? path.resolve(process.env.EMBER_ROOT)
    : resolveRepoRoot(from);
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });

  const defaults = {
    [DATA_FILES.connectorTypes]: defaultConnectorTypes,
    [DATA_FILES.conversations]: [] satisfies Conversation[],
    [DATA_FILES.credentialVault]: [] satisfies CredentialEntry[],
    [DATA_FILES.memory]: createEmptyMemoryStoreData() satisfies MemoryStoreData,
    [DATA_FILES.providers]: [] satisfies Provider[],
    [DATA_FILES.providerSecrets]: {} satisfies ProviderSecrets,
    [DATA_FILES.roleAssignments]: defaultRoleAssignments(),
    [DATA_FILES.settings]: defaultSettings(repoRoot),
    [DATA_FILES.settingsSecrets]: defaultSettingsSecrets(),
    [DATA_FILES.runtime]: defaultRuntime(),
  };

  for (const [file, value] of Object.entries(defaults)) {
    const target = path.join(dataRoot, file);
    if (!(await pathExists(target))) {
      if (PRIVATE_DATA_FILES.has(file)) {
        if (ENCRYPTED_PRIVATE_DATA_FILES.has(file)) {
          await writeEncryptedPrivateJson(target, value);
        } else {
          await writePrivateJson(target, value);
        }
      } else {
        await writeJson(target, value);
      }
    }
  }
}

export async function readJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  const target = path.join(getDataRoot(), fileName);
  try {
    const raw = await readFile(target, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    await writeJson(target, fallback);
    return fallback;
  }
}

export async function writeJson<T>(filePath: string, value: T): Promise<void> {
  await writeJsonAtomically(filePath, value);
}

async function readPrivateJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  const target = path.join(getDataRoot(), fileName);
  try {
    const raw = await readFile(target, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    await writePrivateJson(target, fallback);
    return fallback;
  }
}

async function readEncryptedPrivateJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  const target = path.join(getDataRoot(), fileName);
  try {
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isEncryptedJsonPayload(parsed)) {
      try {
        return decryptPrivatePayload<T>(parsed);
      } catch (decryptError) {
        try {
          const migrated = decryptPrivatePayloadWithSecret<T>(parsed, deriveLegacySecretMaterial());
          if (deriveSecretMaterial() !== deriveLegacySecretMaterial()) {
            await writeEncryptedPrivateJson(target, migrated);
          }
          return migrated;
        } catch {
          throw decryptError;
        }
      }
    }
    return parsed as T;
  } catch {
    await writeEncryptedPrivateJson(target, fallback);
    return fallback;
  }
}

async function writePrivateJson<T>(filePath: string, value: T): Promise<void> {
  await writeJsonAtomically(filePath, value, { mode: 0o600 });
}

async function writeEncryptedPrivateJson<T>(filePath: string, value: T): Promise<void> {
  await writePrivateJson(filePath, encryptPrivatePayload(value));
}

export async function readConnectorTypes(): Promise<ConnectorType[]> {
  return readJsonFile(DATA_FILES.connectorTypes, defaultConnectorTypes);
}

export async function readProviders(): Promise<Provider[]> {
  const providers = await readJsonFile<Provider[]>(DATA_FILES.providers, []);
  return providers.map(normalizeProvider);
}

export async function readConversations(): Promise<Conversation[]> {
  const conversations = await readJsonFile<Conversation[]>(DATA_FILES.conversations, []);
  return conversations.map((conversation) => ({
    ...conversation,
    archivedAt:
      typeof conversation.archivedAt === "string" && conversation.archivedAt.trim()
        ? conversation.archivedAt
        : null,
  }));
}

export async function writeConversations(value: Conversation[]): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.conversations), value);
}

export async function writeProviders(value: Provider[]): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.providers), value);
}

export async function readProviderSecrets(): Promise<ProviderSecrets> {
  const backend = resolveProviderSecretsBackend();

  if (backend === "mock-keychain") {
    const raw = PROVIDER_SECRETS_MOCK_STORE.get(PROVIDER_SECRETS_REF) ?? "";
    return raw ? JSON.parse(raw) as ProviderSecrets : {};
  }

  if (backend === "os-keychain") {
    try {
      const fromKeychain = readProviderSecretsFromKeychain();
      if (fromKeychain) {
        return fromKeychain;
      }
    } catch {
      // Fall through to encrypted file fallback.
    }
  }

  const fallback = await readEncryptedPrivateJsonFile<ProviderSecrets>(DATA_FILES.providerSecrets, {});
  if (backend === "os-keychain" && Object.keys(fallback).length > 0) {
    try {
      writeProviderSecretsToKeychain(fallback);
    } catch {
      // Keep encrypted-file fallback when keychain migration is not available.
    }
  }
  return fallback;
}

export async function writeProviderSecrets(value: ProviderSecrets): Promise<void> {
  const backend = resolveProviderSecretsBackend();

  if (backend === "mock-keychain") {
    PROVIDER_SECRETS_MOCK_STORE.set(PROVIDER_SECRETS_REF, JSON.stringify(value));
    return;
  }

  if (backend === "os-keychain") {
    try {
      writeProviderSecretsToKeychain(value);
      return;
    } catch {
      // Fall through to encrypted file fallback.
    }
  }

  await writeEncryptedPrivateJson(path.join(getDataRoot(), DATA_FILES.providerSecrets), value);
}

export async function readCredentialVault(): Promise<CredentialEntry[]> {
  const entries = await readEncryptedPrivateJsonFile<CredentialEntry[]>(DATA_FILES.credentialVault, []);
  return Array.isArray(entries)
    ? entries.map((entry) => ({
        ...entry,
        label: typeof entry.label === "string" && entry.label.trim() ? entry.label : entry.id,
        target: typeof entry.target === "string" && entry.target.trim() ? entry.target : null,
        kind:
          entry.kind === "website" ||
          entry.kind === "application" ||
          entry.kind === "service" ||
          entry.kind === "other"
            ? entry.kind
            : "other",
        username: typeof entry.username === "string" && entry.username.trim() ? entry.username : null,
        email: typeof entry.email === "string" && entry.email.trim() ? entry.email : null,
        password: typeof entry.password === "string" && entry.password.trim() ? entry.password : null,
        loginUrl: typeof entry.loginUrl === "string" && entry.loginUrl.trim() ? entry.loginUrl : null,
        appName: typeof entry.appName === "string" && entry.appName.trim() ? entry.appName : null,
        notes: typeof entry.notes === "string" && entry.notes.trim() ? entry.notes : null,
        tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
        hasSecret: resolveCredentialHasSecret(entry),
        secretBackend: resolveCredentialSecretBackend(entry),
        secretRef: typeof entry.secretRef === "string" && entry.secretRef.trim() ? entry.secretRef : null,
        lastUsedAt:
          typeof entry.lastUsedAt === "string" && entry.lastUsedAt.trim() ? entry.lastUsedAt : null,
      }))
    : [];
}

export async function writeCredentialVault(value: CredentialEntry[]): Promise<void> {
  await writeEncryptedPrivateJson(path.join(getDataRoot(), DATA_FILES.credentialVault), value);
}

function resolveCredentialHasSecret(entry: CredentialEntry): boolean {
  if (entry.hasSecret === true) {
    return true;
  }
  return typeof entry.password === "string" && entry.password.trim().length > 0;
}

function resolveCredentialSecretBackend(entry: CredentialEntry): CredentialSecretBackend {
  switch (entry.secretBackend) {
    case "os-keychain":
    case "local-file":
    case "mock":
    case "none":
      return entry.secretBackend;
    default:
      return typeof entry.password === "string" && entry.password.trim() ? "local-file" : "none";
  }
}

export async function readRoleAssignments(): Promise<RoleAssignment[]> {
  return readJsonFile(DATA_FILES.roleAssignments, defaultRoleAssignments());
}

export async function writeRoleAssignments(
  value: RoleAssignment[],
): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.roleAssignments), value);
}

export async function readSettings(): Promise<Settings> {
  const repoRoot = process.env.EMBER_ROOT
    ? path.resolve(process.env.EMBER_ROOT)
    : resolveRepoRoot();
  const settings = normalizeSettings(
    await readJsonFile(DATA_FILES.settings, defaultSettings(repoRoot)),
    repoRoot,
  );
  const secrets = await readEncryptedPrivateJsonFile<SettingsSecrets>(
    DATA_FILES.settingsSecrets,
    defaultSettingsSecrets(),
  );
  return {
    ...settings,
    sudoPassword: secrets.sudoPassword ?? "",
    braveApiKey: secrets.braveApiKey ?? "",
  };
}

export async function writeSettings(value: Settings): Promise<void> {
  const repoRoot = process.env.EMBER_ROOT
    ? path.resolve(process.env.EMBER_ROOT)
    : resolveRepoRoot();
  const normalized = normalizeSettings(value, repoRoot);
  const currentSecrets = await readEncryptedPrivateJsonFile<SettingsSecrets>(
    DATA_FILES.settingsSecrets,
    defaultSettingsSecrets(),
  );
  const nextSecrets: SettingsSecrets = {
    sudoPassword: normalized.sudoPassword.trim() ? normalized.sudoPassword : currentSecrets.sudoPassword,
    braveApiKey: normalized.braveApiKey.trim() ? normalized.braveApiKey : currentSecrets.braveApiKey,
  };

  await Promise.all([
    writeJson(path.join(getDataRoot(), DATA_FILES.settings), {
      ...normalized,
      sudoPassword: "",
      braveApiKey: "",
    }),
    writeEncryptedPrivateJson(path.join(getDataRoot(), DATA_FILES.settingsSecrets), nextSecrets),
  ]);
}

export async function readRuntime(): Promise<RuntimeState> {
  return readJsonFile(DATA_FILES.runtime, defaultRuntime());
}

export async function writeRuntime(value: RuntimeState): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.runtime), value);
}

async function writeJsonAtomically<T>(
  filePath: string,
  value: T,
  options: {
    mode?: number;
  } = {},
): Promise<void> {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await withFileWriteLock(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, payload, options.mode);
  });
}

async function atomicWriteFile(filePath: string, payload: string, mode?: number): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const handle = await open(tmpPath, "w", mode);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tmpPath, filePath);
    if (typeof mode === "number") {
      try {
        await chmod(filePath, mode);
      } catch {
        // Best-effort only; some platforms ignore POSIX file modes.
      }
    }
  } catch (error) {
    await unlink(tmpPath).catch(() => {
      // Best-effort cleanup.
    });
    throw error;
  }
}

async function withFileWriteLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = FILE_WRITE_LOCKS.get(filePath) ?? Promise.resolve();
  let release = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = previous.then(() => next);
  FILE_WRITE_LOCKS.set(filePath, queue);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (FILE_WRITE_LOCKS.get(filePath) === queue) {
      FILE_WRITE_LOCKS.delete(filePath);
    }
  }
}
