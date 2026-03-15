import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isIP } from "node:net";

import { readCredentialVault, writeCredentialVault, type CredentialEntry } from "@ember/core";

import { readCredentialSecret } from "./credential-secret-store.js";
import type { EmberTool } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_CAPTURE_CHARS = 40_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function appendWithLimit(current: string, next: string): string {
  if (!next) {
    return current;
  }
  const combined = current + next;
  if (combined.length <= MAX_CAPTURE_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - MAX_CAPTURE_CHARS);
}

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

function sanitizeHost(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[A-Za-z0-9._:%\-\[\]]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function sanitizeUsername(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fd7a:115c:a1e0:")) return true; // Tailscale ULA range
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // Link-local fe80::/10
  return false;
}

function isAllowedLanOrTailnetHost(host: string): boolean {
  const normalized = stripIpv6Brackets(host.toLowerCase());
  const ipType = isIP(normalized);
  if (ipType === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipType === 6) {
    return isPrivateIpv6(normalized);
  }

  if (normalized === "localhost") return true;
  if (/^[a-z0-9-]+$/.test(normalized)) return true; // single-label local hostnames

  return (
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".ts.net")
  );
}

function findCredentialEntry(
  entries: CredentialEntry[],
  input: Record<string, unknown>,
): CredentialEntry | null {
  const byId = normalizeText(input.credential_id ?? input.credentialId ?? input.id);
  if (byId) {
    return entries.find((entry) => entry.id === byId) ?? null;
  }

  const byLabel = normalizeText(input.credential_label ?? input.credentialLabel ?? input.label);
  if (byLabel) {
    const normalizedLabel = byLabel.toLowerCase();
    return entries.find((entry) => entry.label.toLowerCase() === normalizedLabel) ?? null;
  }

  const byTarget = normalizeText(input.credential_target ?? input.credentialTarget ?? input.target);
  if (byTarget) {
    const normalizedTarget = byTarget.toLowerCase();
    return (
      entries.find((entry) =>
        (entry.target ?? "").toLowerCase() === normalizedTarget ||
        (entry.loginUrl ?? "").toLowerCase() === normalizedTarget ||
        (entry.appName ?? "").toLowerCase() === normalizedTarget,
      ) ?? null
    );
  }

  return null;
}

function formatSection(title: string, value: string): string {
  return `${title}\n${value.trim() || "(empty)"}`;
}

async function runSshCommand(options: {
  command: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorMessage: string | null;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const child = spawn(options.command, options.args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout = appendWithLimit(stdout, chunk);
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({
        stdout,
        stderr,
        timedOut,
        exitCode: null,
        signal: null,
        errorMessage: error.message || String(error),
      });
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({
        stdout,
        stderr,
        timedOut,
        exitCode: code,
        signal,
        errorMessage: null,
      });
    });
  });
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const action = normalizeText(input.action)?.toLowerCase() ?? "run";
  if (action !== "run" && action !== "test") {
    return 'Error: action must be "run" or "test".';
  }

  const rawHost = normalizeText(input.host ?? input.ip ?? input.hostname);
  if (!rawHost) {
    return "Error: host is required (use host or ip).";
  }
  const host = sanitizeHost(rawHost);
  if (!host) {
    return "Error: host contains invalid characters.";
  }

  const allowPublicHost = parseBoolean(input.allow_public_host) ?? false;
  if (!allowPublicHost && !isAllowedLanOrTailnetHost(host)) {
    return "Error: host is not in a private LAN/Tailscale range. Set allow_public_host=true only when you intentionally need internet-exposed SSH.";
  }

  const rawPort = input.port ?? 22;
  const port = typeof rawPort === "number" ? Math.floor(rawPort) : Number.parseInt(String(rawPort), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return "Error: port must be a number between 1 and 65535.";
  }

  const timeoutMs =
    typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
      ? clamp(Math.floor(input.timeout_ms), 2_000, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  const connectTimeoutSeconds = clamp(Math.ceil(timeoutMs / 1_000), 2, 60);

  const command = normalizeText(input.command ?? input.remote_command ?? input.cmd);
  if (action === "run" && !command) {
    return "Error: command is required when action=run.";
  }
  const effectiveCommand = command ?? "true";

  let username = normalizeText(input.username ?? input.user);
  if (username) {
    username = sanitizeUsername(username);
    if (!username) {
      return "Error: username contains invalid characters.";
    }
  }

  let password = normalizeText(input.password ?? input.ssh_password ?? input.secret);
  let matchedCredential: CredentialEntry | null = null;

  if (
    normalizeText(input.credential_id) ||
    normalizeText(input.credentialId) ||
    normalizeText(input.credential_label) ||
    normalizeText(input.credentialLabel) ||
    normalizeText(input.credential_target) ||
    normalizeText(input.credentialTarget)
  ) {
    const entries = await readCredentialVault();
    matchedCredential = findCredentialEntry(entries, input);
    if (!matchedCredential) {
      return "Error: credential entry was not found. Use credential_list first to locate the right credential.";
    }

    if (!username && matchedCredential.username) {
      const normalizedUsername = sanitizeUsername(matchedCredential.username);
      if (normalizedUsername) {
        username = normalizedUsername;
      }
    }

    if (!password) {
      password = await readCredentialSecret(matchedCredential);
    }
  }

  if (!username) {
    return "Error: username is required (use username/user, or provide a credential with a saved username).";
  }

  const hostKeyPolicyRaw = normalizeText(input.host_key_policy)?.toLowerCase() ?? "accept-new";
  if (!["accept-new", "strict", "off"].includes(hostKeyPolicyRaw)) {
    return 'Error: host_key_policy must be one of "accept-new", "strict", or "off".';
  }
  const hostKeyPolicy = hostKeyPolicyRaw as "accept-new" | "strict" | "off";

  const privateKeyPath = normalizeText(input.private_key_path ?? input.identity_file ?? input.key_path);
  if (privateKeyPath && !existsSync(privateKeyPath)) {
    return `Error: private key file was not found: ${privateKeyPath}`;
  }

  if (!password && !privateKeyPath && !matchedCredential) {
    return "Error: provide one auth method: password, credential_* (with saved secret), or private_key_path.";
  }

  const tty = parseBoolean(input.tty) ?? false;
  const knownHostsPath = normalizeText(input.known_hosts_path);

  const sshArgs: string[] = [
    "-p",
    String(port),
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o",
    "LogLevel=ERROR",
    "-o",
    "NumberOfPasswordPrompts=1",
  ];

  if (hostKeyPolicy === "accept-new") {
    sshArgs.push("-o", "StrictHostKeyChecking=accept-new");
  } else if (hostKeyPolicy === "strict") {
    sshArgs.push("-o", "StrictHostKeyChecking=yes");
  } else {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    sshArgs.push("-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${nullDevice}`);
  }

  if (knownHostsPath && hostKeyPolicy !== "off") {
    sshArgs.push("-o", `UserKnownHostsFile=${knownHostsPath}`);
  }

  if (privateKeyPath) {
    sshArgs.push("-i", privateKeyPath);
  }

  if (tty) {
    sshArgs.push("-tt");
  }

  if (password) {
    sshArgs.push("-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive");
  } else {
    sshArgs.push("-o", "BatchMode=yes");
  }

  const target = `${username}@${host}`;
  sshArgs.push(target, effectiveCommand);

  let launchCommand = "ssh";
  let launchArgs = sshArgs;
  const launchEnv: NodeJS.ProcessEnv = { ...process.env };

  if (password) {
    if (!commandExists("sshpass")) {
      return "Error: password auth requires sshpass, but it is not installed on this host. Install sshpass or use SSH keys/private_key_path.";
    }
    launchCommand = "sshpass";
    launchArgs = ["-e", "ssh", ...sshArgs];
    launchEnv.SSHPASS = password;
  }

  if (matchedCredential) {
    const now = new Date().toISOString();
    const credentialId = matchedCredential.id;
    const entries = await readCredentialVault();
    const updated = entries.map((entry) =>
      entry.id === credentialId
        ? {
            ...entry,
            lastUsedAt: now,
          }
        : entry,
    );
    await writeCredentialVault(updated);
  }

  const result = await runSshCommand({
    command: launchCommand,
    args: launchArgs,
    timeoutMs,
    env: launchEnv,
  });

  if (result.errorMessage) {
    return `Error: failed to start SSH process: ${result.errorMessage}`;
  }

  const sections: string[] = [
    `SSH target: ${target}`,
    `Action: ${action}`,
    `Auth mode: ${password ? "password" : privateKeyPath ? "private_key" : "credential"}`,
    `Exit code: ${result.exitCode ?? "unknown"}${result.signal ? ` (signal: ${result.signal})` : ""}`,
  ];

  if (result.timedOut) {
    sections.push(`Timed out after ${timeoutMs}ms.`);
  }

  if (result.stdout.trim()) {
    sections.push("", formatSection("STDOUT:", result.stdout));
  }
  if (result.stderr.trim()) {
    sections.push("", formatSection("STDERR:", result.stderr));
  }
  if (!result.stdout.trim() && !result.stderr.trim()) {
    sections.push("", "(no remote output)");
  }

  const output = sections.join("\n");
  return output.length > MAX_OUTPUT_CHARS
    ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n...(truncated)`
    : output;
}

export const sshExecuteTool: EmberTool = {
  definition: {
    name: "ssh_execute",
    description:
      "Run a remote shell command over SSH on a LAN or Tailscale host. " +
      "Supports SSH key auth or password auth (direct password or credential vault lookup). " +
      "Default safety policy allows private-network hosts only unless allow_public_host=true.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: 'Action to run: "run" (default) executes command, "test" verifies SSH auth/connection with a no-op command.',
          enum: ["run", "test"],
        },
        host: {
          type: "string",
          description: "Target hostname or IP address.",
        },
        ip: {
          type: "string",
          description: "Alias for host.",
        },
        username: {
          type: "string",
          description: "SSH username on the target device.",
        },
        user: {
          type: "string",
          description: "Alias for username.",
        },
        port: {
          type: "number",
          description: "SSH port number. Default: 22.",
        },
        command: {
          type: "string",
          description: "Remote command to execute when action=run.",
        },
        remote_command: {
          type: "string",
          description: "Alias for command.",
        },
        password: {
          type: "string",
          description: "SSH password for password-based auth (requires sshpass on this machine).",
        },
        private_key_path: {
          type: "string",
          description: "Absolute path to an SSH private key file for key-based auth.",
        },
        credential_id: {
          type: "string",
          description: "Credential vault id to load SSH username/password from.",
        },
        credential_label: {
          type: "string",
          description: "Credential vault label to load SSH username/password from.",
        },
        credential_target: {
          type: "string",
          description: "Credential vault target/login_url/app_name to load SSH username/password from.",
        },
        host_key_policy: {
          type: "string",
          description: 'Host key policy: "accept-new" (default), "strict" (only known hosts), or "off" (no verification).',
          enum: ["accept-new", "strict", "off"],
        },
        known_hosts_path: {
          type: "string",
          description: "Optional custom known_hosts file path used when host_key_policy is accept-new or strict.",
        },
        allow_public_host: {
          type: "boolean",
          description: "Set true to allow SSH to non-private hosts. Default false for LAN/Tailscale-only safety.",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Default 30000, max 300000.",
        },
        tty: {
          type: "boolean",
          description: "Set true to force TTY allocation (-tt) for commands that require an interactive terminal.",
        },
      },
    },
  },
  execute,
};
