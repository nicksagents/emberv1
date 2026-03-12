import { existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultConnectorTypes,
  defaultRoleAssignments,
  defaultRuntime,
  defaultSettings,
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
]);

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
    [DATA_FILES.runtime]: defaultRuntime(),
  };

  for (const [file, value] of Object.entries(defaults)) {
    const target = path.join(dataRoot, file);
    if (!(await pathExists(target))) {
      if (PRIVATE_DATA_FILES.has(file)) {
        await writePrivateJson(target, value);
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
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

async function writePrivateJson<T>(filePath: string, value: T): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Best-effort only; some platforms ignore POSIX file modes.
  }
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
  return readPrivateJsonFile(DATA_FILES.providerSecrets, {});
}

export async function writeProviderSecrets(value: ProviderSecrets): Promise<void> {
  await writePrivateJson(path.join(getDataRoot(), DATA_FILES.providerSecrets), value);
}

export async function readCredentialVault(): Promise<CredentialEntry[]> {
  const entries = await readPrivateJsonFile<CredentialEntry[]>(DATA_FILES.credentialVault, []);
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
  await writePrivateJson(path.join(getDataRoot(), DATA_FILES.credentialVault), value);
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
  const settings = await readJsonFile(DATA_FILES.settings, defaultSettings(repoRoot));
  return normalizeSettings(settings, repoRoot);
}

export async function writeSettings(value: Settings): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.settings), value);
}

export async function readRuntime(): Promise<RuntimeState> {
  return readJsonFile(DATA_FILES.runtime, defaultRuntime());
}

export async function writeRuntime(value: RuntimeState): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.runtime), value);
}
