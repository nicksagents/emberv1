import {
  readCredentialVault,
  writeCredentialVault,
  type CredentialEntry,
  type CredentialKind,
} from "@ember/core";

import type { EmberTool } from "./types.js";
import {
  deleteCredentialSecret,
  describeCredentialSecretBackend,
  readCredentialSecret,
  storeCredentialSecret,
} from "./credential-secret-store.js";

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeKind(value: unknown): CredentialKind {
  if (typeof value !== "string") {
    return "other";
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "website":
    case "application":
    case "service":
    case "other":
      return normalized;
    case "app":
      return "application";
    default:
      return "other";
  }
}

function pickFirstText(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function listStoredFields(entry: CredentialEntry): string[] {
  return [
    entry.username ? "username" : null,
    entry.email ? "email" : null,
    entry.hasSecret || entry.password ? "password" : null,
    entry.loginUrl ? "login_url" : null,
    entry.appName ? "app_name" : null,
    entry.notes ? "notes" : null,
  ].filter((field): field is string => Boolean(field));
}

function formatCredentialSummary(entry: CredentialEntry): string {
  const fields = listStoredFields(entry);
  return [
    `Credential: ${entry.id}`,
    `Label: ${entry.label}`,
    `Target: ${entry.target ?? "(none)"}`,
    `Kind: ${entry.kind}`,
    `Stored fields: ${fields.join(", ") || "(none)"}`,
    `Secret storage: ${entry.secretBackend}`,
    `Tags: ${entry.tags.join(", ") || "(none)"}`,
    `Last used: ${entry.lastUsedAt ?? "(never)"}`,
    `Updated: ${entry.updatedAt}`,
  ].join("\n");
}

function findCredential(
  entries: CredentialEntry[],
  input: Record<string, unknown>,
): CredentialEntry | null {
  const id = normalizeText(input.id);
  if (id) {
    return entries.find((entry) => entry.id === id) ?? null;
  }

  const label = pickFirstText(input.label, input.account, input.name);
  if (label) {
    const normalized = label.toLowerCase();
    return entries.find((entry) => entry.label.toLowerCase() === normalized) ?? null;
  }

  const target = pickFirstText(input.target, input.service, input.site, input.url, input.app_name);
  if (target) {
    const normalized = target.toLowerCase();
    return (
      entries.find(
        (entry) =>
          entry.target?.toLowerCase() === normalized ||
          entry.loginUrl?.toLowerCase() === normalized ||
          entry.appName?.toLowerCase() === normalized,
      ) ?? null
    );
  }

  return null;
}

async function credentialSaveExecute(input: Record<string, unknown>): Promise<string> {
  const label = pickFirstText(input.label, input.account, input.target, input.service, input.site, input.app_name);
  if (!label) {
    return "Error: label is required. Use the site, app, or account name you want Ember to reuse later.";
  }

  const email = pickFirstText(input.email, input.login_email);
  const username = pickFirstText(input.username, input.user_name, input.user);
  const password = pickFirstText(input.password, input.secret, input.passcode);
  const target = pickFirstText(input.target, input.service, input.site);
  const loginUrl = pickFirstText(input.login_url, input.url);
  const appName = pickFirstText(input.app_name, input.application);
  const notes = normalizeText(input.notes);
  const tags = normalizeTags(input.tags);

  if (!email && !username && !password && !target && !loginUrl && !appName && !notes && tags.length === 0) {
    return "Error: provide at least one field to store, such as email, username, password, login_url, app_name, or notes.";
  }

  const now = new Date().toISOString();
  const entries = await readCredentialVault();
  const existing = findCredential(entries, input) ??
    entries.find((entry) => entry.label.toLowerCase() === label.toLowerCase()) ??
    null;
  const baseEntry: CredentialEntry = {
    id: existing?.id ?? createId("cred"),
    label,
    target: target ?? existing?.target ?? null,
    kind: normalizeKind(input.kind ?? existing?.kind ?? (loginUrl || target ? "website" : appName ? "application" : "service")),
    username: username ?? existing?.username ?? null,
    email: email ?? existing?.email ?? null,
    password: existing?.password ?? null,
    loginUrl: loginUrl ?? existing?.loginUrl ?? null,
    appName: appName ?? existing?.appName ?? null,
    notes: notes ?? existing?.notes ?? null,
    tags: [...new Set([...(existing?.tags ?? []), ...tags])],
    hasSecret: existing?.hasSecret ?? false,
    secretBackend: existing?.secretBackend ?? "none",
    secretRef: existing?.secretRef ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt ?? null,
  };

  let nextEntry = baseEntry;
  let storageLabel = describeCredentialSecretBackend(nextEntry.secretBackend);
  if (password) {
    const storedSecret = await storeCredentialSecret(baseEntry, password);
    if (
      existing &&
      existing.secretRef &&
      (existing.secretBackend !== storedSecret.backend ||
        (storedSecret.secretRef !== null && existing.secretRef !== storedSecret.secretRef))
    ) {
      await deleteCredentialSecret(existing);
    }
    nextEntry = {
      ...baseEntry,
      password: storedSecret.backend === "local-file" ? password : null,
      hasSecret: true,
      secretBackend: storedSecret.backend,
      secretRef: storedSecret.secretRef,
    };
    storageLabel = storedSecret.label;
  }

  const nextEntries = existing
    ? entries.map((entry) => (entry.id === existing.id ? nextEntry : entry))
    : [nextEntry, ...entries];
  await writeCredentialVault(nextEntries);

  return `${existing ? "Updated" : "Saved"} credential vault entry using ${storageLabel}.\n${formatCredentialSummary(nextEntry)}`;
}

async function credentialListExecute(input: Record<string, unknown>): Promise<string> {
  const query = pickFirstText(input.query, input.target, input.service, input.site, input.tag)?.toLowerCase() ?? "";
  const maxResults =
    typeof input.max_results === "number" && Number.isFinite(input.max_results)
      ? Math.max(1, Math.min(20, Math.floor(input.max_results)))
      : 10;

  const entries = await readCredentialVault();
  const matches = entries
    .filter((entry) => {
      if (!query) {
        return true;
      }
      const haystack = [
        entry.label,
        entry.target ?? "",
        entry.loginUrl ?? "",
        entry.appName ?? "",
        entry.username ?? "",
        entry.email ?? "",
        entry.notes ?? "",
        entry.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    })
    .slice(0, maxResults);

  if (matches.length === 0) {
    return query ? `No credential vault entries matched "${query}".` : "Credential vault is empty.";
  }

  return [
    "Credential vault entries:",
    ...matches.map((entry, index) => {
      return `${index + 1}. ${entry.id} label=${entry.label} target=${entry.target ?? "(none)"} kind=${entry.kind} fields=${listStoredFields(entry).join(",") || "(none)"} last_used=${entry.lastUsedAt ?? "(never)"}`;
    }),
  ].join("\n");
}

async function credentialGetExecute(input: Record<string, unknown>): Promise<string> {
  const entries = await readCredentialVault();
  const entry = findCredential(entries, input);
  if (!entry) {
    return "Error: credential entry not found. Use credential_list first if you are unsure about the label or id.";
  }

  const now = new Date().toISOString();
  const nextEntry = {
    ...entry,
    lastUsedAt: now,
    updatedAt: entry.updatedAt,
  };
  await writeCredentialVault(entries.map((candidate) => (candidate.id === entry.id ? nextEntry : candidate)));

  const password = await readCredentialSecret(entry);
  return [
    `Credential: ${entry.id}`,
    `Label: ${entry.label}`,
    `Target: ${entry.target ?? "(none)"}`,
    `Kind: ${entry.kind}`,
    `Secret storage: ${entry.secretBackend} (${describeCredentialSecretBackend(entry.secretBackend)})`,
    `Login URL: ${entry.loginUrl ?? "(none)"}`,
    `App name: ${entry.appName ?? "(none)"}`,
    `Username: ${entry.username ?? "(none)"}`,
    `Email: ${entry.email ?? "(none)"}`,
    `Password: ${password ?? "(none)"}`,
    `Notes: ${entry.notes ?? "(none)"}`,
    `Tags: ${entry.tags.join(", ") || "(none)"}`,
  ].join("\n");
}

export const credentialSaveTool: EmberTool = {
  definition: {
    name: "credential_save",
    description:
      "Store or update a local-only login record for a website, service, or native app. Use when the user gives credentials and wants Ember to reuse them later without saving them as normal memory.",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Short name for this login, such as Gmail, Discord, or Work VPN.",
        },
        target: {
          type: "string",
          description: "Website domain, service name, or system target.",
        },
        service: {
          type: "string",
          description: "Alias for target.",
        },
        site: {
          type: "string",
          description: "Alias for target when saving a website login.",
        },
        app_name: {
          type: "string",
          description: "Native application name when the login is for a desktop app.",
        },
        email: {
          type: "string",
          description: "Stored login email, if applicable.",
        },
        username: {
          type: "string",
          description: "Stored username, if applicable.",
        },
        password: {
          type: "string",
          description: "Stored password or passphrase.",
        },
        secret: {
          type: "string",
          description: "Alias for password.",
        },
        login_url: {
          type: "string",
          description: "Direct login URL if the account uses a specific page.",
        },
        url: {
          type: "string",
          description: "Alias for login_url.",
        },
        kind: {
          type: "string",
          enum: ["website", "application", "service", "other", "app"],
          description: "Credential type. app is accepted as an alias for application.",
        },
        notes: {
          type: "string",
          description: "Optional non-secret notes, such as tenant name or required sign-in order.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional retrieval tags.",
        },
      },
      required: ["label"],
    },
  },
  execute: credentialSaveExecute,
};

export const credentialListTool: EmberTool = {
  definition: {
    name: "credential_list",
    description:
      "List locally stored credential entries without revealing passwords. Use this before asking the user to repeat a known login, or when you need to find the right account label.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional text filter over labels, targets, URLs, notes, and tags.",
        },
        target: {
          type: "string",
          description: "Alias filter for query.",
        },
        service: {
          type: "string",
          description: "Alias filter for query.",
        },
        tag: {
          type: "string",
          description: "Tag filter.",
        },
        max_results: {
          type: "number",
          description: "Maximum entries to return. Default 10, maximum 20.",
        },
      },
    },
  },
  execute: credentialListExecute,
};

export const credentialGetTool: EmberTool = {
  definition: {
    name: "credential_get",
    description:
      "Retrieve a locally stored login record, including the saved username, email, and password. Use this right before browser or desktop sign-in steps and do not echo the secret back to the user unless they explicitly ask for it.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Credential id from credential_list.",
        },
        label: {
          type: "string",
          description: "Saved login label, such as Gmail or Work VPN.",
        },
        target: {
          type: "string",
          description: "Target site, service, or app name.",
        },
        service: {
          type: "string",
          description: "Alias for target.",
        },
        site: {
          type: "string",
          description: "Alias for target.",
        },
      },
    },
  },
  execute: credentialGetExecute,
};
