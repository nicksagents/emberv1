import { execFile as execFileCallback } from "node:child_process";
import { cpus, freemem, loadavg, networkInterfaces, platform, totalmem } from "node:os";
import { promisify } from "node:util";

import type { EmberTool } from "./types.js";

const execFile = promisify(execFileCallback);

const MAX_OUTPUT_CHARS = 6_000;

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

async function getDiskInfo(): Promise<string> {
  try {
    if (platform() === "win32") {
      const { stdout } = await execFile("wmic", ["logicaldisk", "get", "size,freespace,caption"], { timeout: 6_000 });
      return stdout.trim();
    }
    const { stdout } = await execFile("df", ["-h", "/"], { timeout: 6_000 });
    return stdout.trim();
  } catch {
    return "(unavailable)";
  }
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : "all";
  const parts: string[] = [];

  const needsCpu     = action === "cpu" || action === "all";
  const needsMemory  = action === "memory" || action === "mem" || action === "all";
  const needsDisk    = action === "disk" || action === "all";
  const needsNetwork = action === "network" || action === "net" || action === "interfaces" || action === "all";
  const needsEnv     = action === "env" || action === "environment";

  if (needsCpu) {
    const load = loadavg();
    const cpuList = cpus();
    parts.push(
      "## CPU",
      `Cores: ${cpuList.length}`,
      `Model: ${cpuList[0]?.model ?? "unknown"}`,
      `Load average (1m / 5m / 15m): ${load.map((l) => l.toFixed(2)).join(" / ")}`,
    );
  }

  if (needsMemory) {
    const total = totalmem();
    const free = freemem();
    const used = total - free;
    parts.push(
      "## Memory",
      `Total: ${formatBytes(total)}`,
      `Used:  ${formatBytes(used)} (${Math.round((used / total) * 100)}%)`,
      `Free:  ${formatBytes(free)}`,
    );
  }

  if (needsDisk) {
    const disk = await getDiskInfo();
    parts.push("## Disk", disk);
  }

  if (needsNetwork) {
    const ifaces = networkInterfaces();
    const lines: string[] = ["## Network Interfaces"];
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        const tag = addr.internal ? " (loopback)" : "";
        lines.push(`  ${name}: ${addr.address} (${addr.family})${tag}`);
      }
    }
    parts.push(...lines);
  }

  if (needsEnv) {
    const SENSITIVE_PATTERN = /token|secret|password|passwd|key|auth|credential|private|cert|access/i;
    const envLines = Object.entries(process.env)
      .filter(([k]) => !SENSITIVE_PATTERN.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 60)
      .map(([k, v]) => `${k}=${v ?? ""}`);
    parts.push("## Environment Variables (sensitive keys redacted)", ...envLines);
  }

  if (parts.length === 0) {
    return `Unknown action "${action}". Valid: cpu, memory, disk, network, env, all`;
  }

  const result = parts.join("\n");
  return result.length > MAX_OUTPUT_CHARS
    ? `${result.slice(0, MAX_OUTPUT_CHARS)}\n...(truncated)`
    : result;
}

export const systemInfoTool: EmberTool = {
  definition: {
    name: "system_info",
    description:
      "Get host system information: CPU core count and load average, RAM usage, disk space, network interfaces with IPs, and environment variables. " +
      "Use action=all for a full snapshot or specify a section: cpu, memory, disk, network, env.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            'Section to retrieve. One of: "cpu", "memory", "disk", "network", "env", "all" (default).',
          enum: ["cpu", "memory", "disk", "network", "env", "all"],
        },
      },
    },
  },
  execute,
};
