import { platform } from "node:os";
import { spawnSync } from "node:child_process";

import type { CredentialEntry, CredentialSecretBackend } from "@ember/core";

type SecretStoreBackendKind = Extract<CredentialSecretBackend, "os-keychain" | "local-file" | "mock">;

export interface CredentialSecretStoreStatus {
  backend: SecretStoreBackendKind;
  secure: boolean;
  label: string;
}

const MOCK_SECRET_STORE = new Map<string, string>();

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    input?: string;
  } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: options.input,
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

function assertOk(
  result: { status: number | null; stdout: string; stderr: string },
  action: string,
): string {
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail ? `${action}: ${detail}` : action);
  }
  return result.stdout.trim();
}

function powershellCommand(script: string): { status: number | null; stdout: string; stderr: string } {
  return runCommand("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

function powershellQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveSecretStoreStatus(): CredentialSecretStoreStatus {
  const forced = process.env.EMBER_CREDENTIAL_SECRET_BACKEND?.trim().toLowerCase();
  if (forced === "mock") {
    return {
      backend: "mock",
      secure: true,
      label: "Mock keychain",
    };
  }
  if (forced === "local-file") {
    return {
      backend: "local-file",
      secure: false,
      label: "Local Ember credential file",
    };
  }

  switch (platform()) {
    case "darwin":
      if (commandExists("security")) {
        return {
          backend: "os-keychain",
          secure: true,
          label: "macOS Keychain",
        };
      }
      break;
    case "linux":
      if (commandExists("secret-tool")) {
        return {
          backend: "os-keychain",
          secure: true,
          label: "Freedesktop Secret Service",
        };
      }
      break;
    case "win32":
      if (commandExists("powershell")) {
        return {
          backend: "os-keychain",
          secure: true,
          label: "Windows Credential Manager",
        };
      }
      break;
  }

  return {
    backend: "local-file",
    secure: false,
    label: "Local Ember credential file",
  };
}

function buildSecretRef(entry: Pick<CredentialEntry, "id">): string {
  return `ember:credential:${entry.id}`;
}

function buildWindowsCredentialScript(action: "write" | "read" | "delete", target: string, secret?: string): string {
  const header = [
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "using System.Runtime.InteropServices.ComTypes;",
    "[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
    "public struct CREDENTIAL {",
    "  public int Flags;",
    "  public int Type;",
    "  public string TargetName;",
    "  public string Comment;",
    "  public FILETIME LastWritten;",
    "  public int CredentialBlobSize;",
    "  public IntPtr CredentialBlob;",
    "  public int Persist;",
    "  public int AttributeCount;",
    "  public IntPtr Attributes;",
    "  public string TargetAlias;",
    "  public string UserName;",
    "}",
    "public static class CredMan {",
    '  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]',
    "  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);",
    '  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]',
    "  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);",
    '  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]',
    "  public static extern bool CredDelete(string target, int type, int flags);",
    '  [DllImport("Advapi32.dll", SetLastError = true)]',
    "  public static extern void CredFree([In] IntPtr cred);",
    "}",
    '"@;',
  ].join(" ");

  switch (action) {
    case "write":
      return [
        header,
        `$target = ${powershellQuoted(target)};`,
        `$secret = ${powershellQuoted(secret ?? "")};`,
        "$blob = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret);",
        "$credential = New-Object CREDENTIAL;",
        "$credential.Type = 1;",
        "$credential.TargetName = $target;",
        "$credential.Persist = 2;",
        '$credential.UserName = "ember";',
        "$credential.CredentialBlob = $blob;",
        "$credential.CredentialBlobSize = [Text.Encoding]::Unicode.GetByteCount($secret);",
        "$ok = [CredMan]::CredWrite([ref]$credential, 0);",
        "[System.Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($blob);",
        'if (-not $ok) { throw "CredWrite failed." }',
      ].join(" ");
    case "read":
      return [
        header,
        `$target = ${powershellQuoted(target)};`,
        "$ptr = [IntPtr]::Zero;",
        "$ok = [CredMan]::CredRead($target, 1, 0, [ref]$ptr);",
        'if (-not $ok) { throw "CredRead failed." }',
        "$credential = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CREDENTIAL]);",
        "$length = [Math]::Floor($credential.CredentialBlobSize / 2);",
        "$value = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, $length);",
        "[CredMan]::CredFree($ptr);",
        "Write-Output $value;",
      ].join(" ");
    case "delete":
      return [
        header,
        `$target = ${powershellQuoted(target)};`,
        "[void][CredMan]::CredDelete($target, 1, 0);",
      ].join(" ");
  }
}

function storeInOperatingSystemKeychain(secretRef: string, secret: string): void {
  switch (platform()) {
    case "darwin":
      assertOk(
        runCommand("security", ["add-generic-password", "-U", "-a", "ember", "-s", secretRef, "-w", secret]),
        `Failed to store "${secretRef}" in the macOS Keychain`,
      );
      return;
    case "linux":
      assertOk(
        runCommand(
          "secret-tool",
          ["store", "--label", `Ember Credential ${secretRef}`, "application", "ember", "credential_id", secretRef],
          { input: secret },
        ),
        `Failed to store "${secretRef}" in the Secret Service keychain`,
      );
      return;
    case "win32":
      assertOk(
        powershellCommand(buildWindowsCredentialScript("write", secretRef, secret)),
        `Failed to store "${secretRef}" in Windows Credential Manager`,
      );
      return;
    default:
      throw new Error("No operating-system keychain is available on this host.");
  }
}

function readFromOperatingSystemKeychain(secretRef: string): string {
  switch (platform()) {
    case "darwin":
      return assertOk(
        runCommand("security", ["find-generic-password", "-a", "ember", "-s", secretRef, "-w"]),
        `Failed to read "${secretRef}" from the macOS Keychain`,
      );
    case "linux":
      return assertOk(
        runCommand("secret-tool", ["lookup", "application", "ember", "credential_id", secretRef]),
        `Failed to read "${secretRef}" from the Secret Service keychain`,
      );
    case "win32":
      return assertOk(
        powershellCommand(buildWindowsCredentialScript("read", secretRef)),
        `Failed to read "${secretRef}" from Windows Credential Manager`,
      );
    default:
      throw new Error("No operating-system keychain is available on this host.");
  }
}

function deleteFromOperatingSystemKeychain(secretRef: string): void {
  switch (platform()) {
    case "darwin":
      runCommand("security", ["delete-generic-password", "-a", "ember", "-s", secretRef]);
      return;
    case "linux":
      runCommand("secret-tool", ["clear", "application", "ember", "credential_id", secretRef]);
      return;
    case "win32":
      powershellCommand(buildWindowsCredentialScript("delete", secretRef));
      return;
  }
}

export function getCredentialSecretStoreStatus(): CredentialSecretStoreStatus {
  return resolveSecretStoreStatus();
}

export function describeCredentialSecretBackend(backend: CredentialSecretBackend): string {
  switch (backend) {
    case "os-keychain":
      switch (platform()) {
        case "darwin":
          return "macOS Keychain";
        case "linux":
          return "Freedesktop Secret Service";
        case "win32":
          return "Windows Credential Manager";
        default:
          return "Operating-system keychain";
      }
    case "mock":
      return "Mock keychain";
    case "local-file":
      return "Local Ember credential file";
    case "none":
    default:
      return "No secret stored";
  }
}

export async function storeCredentialSecret(
  entry: Pick<CredentialEntry, "id">,
  secret: string,
): Promise<{ backend: SecretStoreBackendKind; label: string; secretRef: string | null }> {
  const status = resolveSecretStoreStatus();
  const secretRef = buildSecretRef(entry);

  if (status.backend === "mock") {
    MOCK_SECRET_STORE.set(secretRef, secret);
    return {
      backend: "mock",
      label: status.label,
      secretRef,
    };
  }

  if (status.backend === "local-file") {
    return {
      backend: "local-file",
      label: status.label,
      secretRef: null,
    };
  }

  storeInOperatingSystemKeychain(secretRef, secret);
  return {
    backend: "os-keychain",
    label: status.label,
    secretRef,
  };
}

export async function readCredentialSecret(entry: Pick<CredentialEntry, "secretBackend" | "secretRef" | "password">): Promise<string | null> {
  if (entry.secretBackend === "mock") {
    return entry.secretRef ? (MOCK_SECRET_STORE.get(entry.secretRef) ?? null) : null;
  }
  if (entry.secretBackend === "local-file") {
    return typeof entry.password === "string" && entry.password.trim() ? entry.password : null;
  }
  if (entry.secretBackend === "os-keychain") {
    if (!entry.secretRef) {
      return null;
    }
    return readFromOperatingSystemKeychain(entry.secretRef);
  }
  return typeof entry.password === "string" && entry.password.trim() ? entry.password : null;
}

export async function deleteCredentialSecret(entry: Pick<CredentialEntry, "secretBackend" | "secretRef">): Promise<void> {
  if (!entry.secretRef) {
    return;
  }
  if (entry.secretBackend === "mock") {
    MOCK_SECRET_STORE.delete(entry.secretRef);
    return;
  }
  if (entry.secretBackend === "os-keychain") {
    deleteFromOperatingSystemKeychain(entry.secretRef);
  }
}

export function resetMockCredentialSecretStore(): void {
  MOCK_SECRET_STORE.clear();
}
