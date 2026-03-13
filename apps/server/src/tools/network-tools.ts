import { exec } from "node:child_process";
import { networkInterfaces, platform } from "node:os";
import { promisify } from "node:util";

import type { EmberTool } from "./types.js";

const execAsync = promisify(exec);

const MAX_OUTPUT_CHARS = 6_000;

async function runShell(cmd: string, timeoutMs = 10_000): Promise<{ out: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs });
    return { out: (stdout + (stderr ? `\n${stderr}` : "")).trim(), ok: true };
  } catch (err) {
    if (err && typeof err === "object") {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      const combined = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
      return { out: combined || e.message || String(err), ok: false };
    }
    return { out: String(err), ok: false };
  }
}

function getLocalInterfaces(): string {
  const ifaces = networkInterfaces();
  const lines: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      const tag = addr.internal ? " (loopback)" : "";
      lines.push(`  ${name}: ${addr.address} (${addr.family})${tag}`);
    }
  }
  return lines.join("\n") || "(no interfaces found)";
}

async function tailscaleStatus(): Promise<string> {
  const { out, ok } = await runShell("tailscale status", 8_000);
  if (!ok && (out.includes("not found") || out.includes("not installed") || out.includes("connect"))) {
    return "Tailscale is not installed or not running.\nInstall: https://tailscale.com/download\nThen run: sudo tailscale up";
  }
  return out;
}

async function tailscaleIp(): Promise<string> {
  const { out } = await runShell("tailscale ip", 5_000);
  return out;
}

async function tailscaleServeStatus(): Promise<string> {
  const { out, ok } = await runShell("tailscale serve status", 8_000);
  if (!ok) return "Tailscale serve is not available or Tailscale is not running.";
  return out || "No active serve/funnel configs.";
}

async function doPing(host: string, count: number): Promise<string> {
  const safeHost = host.replace(/[^a-zA-Z0-9.\-:]/g, "");
  if (!safeHost) return "Error: invalid host.";
  const cmd =
    platform() === "win32"
      ? `ping -n ${count} ${safeHost}`
      : `ping -c ${count} ${safeHost}`;
  const { out } = await runShell(cmd, 30_000);
  return out;
}

async function doDnsLookup(host: string): Promise<string> {
  const safeHost = host.replace(/[^a-zA-Z0-9.\-]/g, "");
  if (!safeHost) return "Error: invalid host.";
  // Try dig first (usually available), fall back to nslookup
  const { out: digOut, ok: digOk } = await runShell(`dig +short ${safeHost}`, 10_000);
  if (digOk && digOut) return digOut;
  const { out: nsOut } = await runShell(`nslookup ${safeHost}`, 10_000);
  return nsOut;
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : "interfaces";

  let result = "";

  if (action === "interfaces" || action === "ifaces" || action === "net") {
    result = `## Network Interfaces\n${getLocalInterfaces()}`;
  } else if (action === "tailscale_status" || action === "tailscale") {
    const status = await tailscaleStatus();
    result = `## Tailscale Status\n${status}`;
  } else if (action === "tailscale_ip") {
    const ip = await tailscaleIp();
    result = `## Tailscale IP\n${ip}`;
  } else if (action === "tailscale_serve" || action === "tailscale_serve_status") {
    const status = await tailscaleServeStatus();
    result = `## Tailscale Serve / Funnel Status\n${status}`;
  } else if (action === "ping") {
    const host = typeof input.host === "string" ? input.host.trim() : "";
    if (!host) return "Error: host is required for ping.";
    const count = typeof input.count === "number" ? Math.min(Math.max(1, Math.floor(input.count)), 10) : 4;
    result = await doPing(host, count);
  } else if (action === "dns" || action === "dns_lookup") {
    const host = typeof input.host === "string" ? input.host.trim() : "";
    if (!host) return "Error: host is required for dns_lookup.";
    const out = await doDnsLookup(host);
    result = `## DNS Lookup: ${host}\n${out}`;
  } else {
    return `Unknown action "${action}". Valid: interfaces, tailscale_status, tailscale_ip, tailscale_serve, ping, dns_lookup`;
  }

  return result.length > MAX_OUTPUT_CHARS
    ? `${result.slice(0, MAX_OUTPUT_CHARS)}\n...(truncated)`
    : result;
}

export const networkToolsTool: EmberTool = {
  definition: {
    name: "network_tools",
    description:
      "Network diagnostics and Tailscale VPN integration. " +
      "List local network interfaces, get Tailscale mesh status and IP, inspect active Tailscale serve/funnel configs, ping a host, or resolve a DNS name. " +
      "Use tailscale_status to confirm Tailscale is running before sharing a local server.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            'Action: "interfaces" (local IPs), "tailscale_status" (mesh peers + IP), "tailscale_ip" (device Tailscale IP), "tailscale_serve" (active share configs), "ping", "dns_lookup".',
          enum: ["interfaces", "tailscale_status", "tailscale_ip", "tailscale_serve", "ping", "dns_lookup"],
        },
        host: {
          type: "string",
          description: "For ping and dns_lookup: hostname or IP address to target.",
        },
        count: {
          type: "number",
          description: "For ping: number of ICMP packets to send (default 4, max 10).",
        },
      },
      required: ["action"],
    },
  },
  execute,
};
