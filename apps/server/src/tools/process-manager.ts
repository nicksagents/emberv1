import { exec } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

import type { EmberTool } from "./types.js";

const execAsync = promisify(exec);

const MAX_OUTPUT_CHARS = 6_000;
const isWindows = platform() === "win32";

async function runShell(cmd: string, timeoutMs = 10_000): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs });
    return (stdout + (stderr ? `\n${stderr}` : "")).trim();
  } catch (err) {
    if (err && typeof err === "object") {
      const errObj = err as { stdout?: string; stderr?: string; message?: string };
      const output = ((errObj.stdout ?? "") + (errObj.stderr ?? "")).trim();
      if (output) return output;
      return `Error: ${errObj.message ?? String(err)}`;
    }
    return `Error: ${String(err)}`;
  }
}

async function listProcesses(filter?: string): Promise<string> {
  if (isWindows) {
    const out = await runShell("tasklist /fo csv /nh", 10_000);
    if (!filter) return out;
    const lines = out.split("\n").filter((l) => l.toLowerCase().includes(filter.toLowerCase()));
    return lines.join("\n") || `No processes matching "${filter}"`;
  }

  const filterPart = filter
    ? ` | grep -i ${JSON.stringify(filter)} | grep -v grep`
    : "";
  return runShell(`ps aux --sort=-%cpu${filterPart} 2>/dev/null | head -25`, 10_000);
}

async function checkPort(port: number): Promise<string> {
  if (isWindows) {
    const out = await runShell(`netstat -ano | findstr :${port}`, 5_000);
    return out || `Nothing listening on port ${port}`;
  }

  // Try lsof first (macOS + Linux), fall back to ss (Linux-only)
  const out = await runShell(
    `lsof -i :${port} -n -P 2>/dev/null || ss -tlpn 2>/dev/null | grep :${port}`,
    6_000,
  );
  return out || `Nothing listening on port ${port}`;
}

async function killProcess(target: string, signal: string): Promise<string> {
  const sig = signal.toUpperCase().replace(/^SIG/, "");

  if (/^\d+$/.test(target)) {
    const pid = Number.parseInt(target, 10);
    if (isWindows) {
      const out = await runShell(`taskkill /PID ${pid} /F`, 5_000);
      return out || `Sent KILL to PID ${pid}`;
    }
    const out = await runShell(`kill -${sig} ${pid}`, 5_000);
    return out || `Sent SIG${sig} to PID ${pid}`;
  }

  // Kill by name/pattern
  if (isWindows) {
    const out = await runShell(`taskkill /IM "${target}" /F`, 5_000);
    return out || `Sent KILL to processes matching "${target}"`;
  }
  const out = await runShell(`pkill -${sig} -f ${JSON.stringify(target)}`, 5_000);
  if (out.startsWith("Error")) {
    const msg = out.toLowerCase();
    if (msg.includes("no such process") || msg.includes("no process found") || out.includes("exit code 1")) {
      return `No matching process found for "${target}"`;
    }
  }
  return out || `Sent SIG${sig} to processes matching "${target}"`;
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : "list";

  if (action === "list") {
    const filter = typeof input.filter === "string" ? input.filter.trim() || undefined : undefined;
    const result = await listProcesses(filter);
    return result.length > MAX_OUTPUT_CHARS ? `${result.slice(0, MAX_OUTPUT_CHARS)}\n...(truncated)` : result;
  }

  if (action === "port_check" || action === "port") {
    const rawPort = input.port ?? input.number;
    const port = typeof rawPort === "number" ? rawPort : Number.parseInt(String(rawPort ?? ""), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return "Error: port must be a number between 1 and 65535.";
    }
    return checkPort(port);
  }

  if (action === "kill") {
    const target = input.pid ?? input.name ?? input.target;
    if (!target) {
      return 'Error: kill requires "pid" (number) or "name" (string).';
    }
    const signal = typeof input.signal === "string" ? input.signal.trim() : "TERM";
    return killProcess(String(target), signal);
  }

  return `Unknown action "${action}". Valid: list, port_check, kill`;
}

export const processManagerTool: EmberTool = {
  definition: {
    name: "process_manager",
    description:
      "List running processes, check what is listening on a port, and kill processes by PID or name. " +
      "Use port_check to debug 'port already in use' errors, list to inspect running services, and kill to stop a runaway process.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: 'Action to perform: "list" (default), "port_check", or "kill".',
          enum: ["list", "port_check", "kill"],
        },
        filter: {
          type: "string",
          description: 'For list: filter by process name substring (e.g. "node", "python", "ruby").',
        },
        port: {
          type: "number",
          description: "For port_check: port number to inspect (1–65535).",
        },
        pid: {
          type: "number",
          description: "For kill: PID of the process to signal.",
        },
        name: {
          type: "string",
          description: 'For kill: process name or pattern to match (e.g. "node", "webpack").',
        },
        signal: {
          type: "string",
          description: 'For kill: signal name. Default "TERM" (graceful). Use "KILL" to force-terminate.',
          enum: ["TERM", "KILL", "HUP", "INT"],
        },
      },
    },
  },
  execute,
};
