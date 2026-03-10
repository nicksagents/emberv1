import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
  ProviderSecrets,
  RoleAssignment,
  RuntimeState,
  Settings,
} from "./types";

const DATA_FILES = {
  connectorTypes: "connector-types.json",
  conversations: "conversations.json",
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
    [DATA_FILES.providers]: [] satisfies Provider[],
    [DATA_FILES.providerSecrets]: {} satisfies ProviderSecrets,
    [DATA_FILES.roleAssignments]: defaultRoleAssignments(),
    [DATA_FILES.settings]: defaultSettings(repoRoot),
    [DATA_FILES.runtime]: defaultRuntime(),
  };

  for (const [file, value] of Object.entries(defaults)) {
    const target = path.join(dataRoot, file);
    if (!(await pathExists(target))) {
      await writeJson(target, value);
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

export async function readConnectorTypes(): Promise<ConnectorType[]> {
  return readJsonFile(DATA_FILES.connectorTypes, defaultConnectorTypes);
}

export async function readProviders(): Promise<Provider[]> {
  const providers = await readJsonFile<Provider[]>(DATA_FILES.providers, []);
  return providers.map(normalizeProvider);
}

export async function readConversations(): Promise<Conversation[]> {
  return readJsonFile<Conversation[]>(DATA_FILES.conversations, []);
}

export async function writeConversations(value: Conversation[]): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.conversations), value);
}

export async function writeProviders(value: Provider[]): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.providers), value);
}

export async function readProviderSecrets(): Promise<ProviderSecrets> {
  return readJsonFile(DATA_FILES.providerSecrets, {});
}

export async function writeProviderSecrets(value: ProviderSecrets): Promise<void> {
  await writeJson(path.join(getDataRoot(), DATA_FILES.providerSecrets), value);
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
