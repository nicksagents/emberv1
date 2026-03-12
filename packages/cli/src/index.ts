#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { closeSync, createWriteStream, existsSync, openSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";

import {
  defaultRuntime,
  ensureDataFiles,
  initializeMemoryInfrastructure,
  readSettings,
  readRuntime,
  writeRuntime,
} from "@ember/core";
import {
  TerminalDashboard,
  type DashboardSnapshot,
  type DashboardServiceStatus,
  stripAnsi,
} from "./dashboard.js";
import { buildRuntimeEnv, hasManagedRuntime, resolveEmberRoot } from "./runtime.js";

const runtimePort = "3005";
const webPort = "3000";
const runtimeHost = process.env.EMBER_RUNTIME_HOST ?? process.env.EMBER_BIND_HOST ?? "0.0.0.0";
const webHost = process.env.EMBER_WEB_HOST ?? process.env.EMBER_BIND_HOST ?? "0.0.0.0";
const localWebUrl = `http://127.0.0.1:${webPort}`;
const localApiUrl = `http://127.0.0.1:${runtimePort}`;
const managedPorts = [webPort, runtimePort];
const verboseStartup = process.env.EMBER_VERBOSE_STARTUP === "1";
const dashboardEnabled = Boolean(process.stdout.isTTY && !verboseStartup && process.env.EMBER_DASHBOARD !== "0");
const supportsColor = Boolean(process.stdout.isTTY);
const ansi = {
  reset: supportsColor ? "\u001b[0m" : "",
  bold: supportsColor ? "\u001b[1m" : "",
  dim: supportsColor ? "\u001b[2m" : "",
  cyan: supportsColor ? "\u001b[36m" : "",
  green: supportsColor ? "\u001b[32m" : "",
  yellow: supportsColor ? "\u001b[33m" : "",
  red: supportsColor ? "\u001b[31m" : "",
};
const separator = `${ansi.dim}${"─".repeat(58)}${ansi.reset}`;

interface ForegroundProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  label: string;
  recentLines: string[];
}

interface McpStartupStats {
  configuredServers: number;
  runningServers: number;
  activeTools: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to direct PID signaling.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Ignore stale processes.
  }
}

async function terminateProcess(pid: number | null | undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) {
    return;
  }

  sendSignal(pid, "SIGTERM");
  for (let index = 0; index < 10; index += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(200);
  }

  if (isProcessAlive(pid)) {
    sendSignal(pid, "SIGKILL");
  }
}

function openLogFile(repoRoot: string, fileName: string): number {
  const target = path.join(repoRoot, "data", fileName);
  return openSync(target, "a");
}

function bullet(color: string, symbol: string): string {
  return `${color}${symbol}${ansi.reset}`;
}

function printStartupHeader(): void {
  console.log("");
  console.log(`${ansi.bold}${ansi.cyan}EMBER${ansi.reset} ${ansi.dim}local development runtime${ansi.reset}`);
  console.log(separator);
  console.log(` ${bullet(ansi.yellow, "●")} runtime  starting  ${localApiUrl}`);
  console.log(` ${bullet(ansi.yellow, "●")} web ui   starting  ${localWebUrl}`);
  console.log(` ${bullet(ansi.dim, "•")} logs     data/server.log  data/web.log`);
  if (verboseStartup) {
    console.log(` ${bullet(ansi.dim, "•")} verbose  raw child output enabled`);
  }
  console.log("");
}

function printReadySummary(mcpStats: McpStartupStats | null): void {
  console.log("");
  console.log(`${ansi.bold}${ansi.green}EMBER ready${ansi.reset}`);
  console.log(separator);
  console.log(` ${bullet(ansi.green, "●")} runtime  ready     ${localApiUrl}`);
  console.log(` ${bullet(ansi.green, "●")} web ui   ready     ${localWebUrl}`);
  if (mcpStats) {
    console.log(` ${bullet(ansi.green, "●")} mcp      online    ${mcpStats.runningServers} servers / ${mcpStats.activeTools} tools`);
  }
  console.log(` ${bullet(commandExists("codex") ? ansi.green : ansi.yellow, "●")} codex    ${commandExists("codex") ? "available" : "not installed"}`);
  console.log(` ${bullet(commandExists("claude") ? ansi.green : ansi.yellow, "●")} claude   ${commandExists("claude") ? "available" : "not installed"}`);
  console.log(` ${bullet(ansi.dim, "•")} tailscale connect via this machine on port ${webPort}`);
  console.log(` ${bullet(ansi.dim, "•")} stop      Ctrl+C`);
  console.log("");
}

function printStartupFailure(message: string, processes: ForegroundProcess[]): void {
  console.error("");
  console.error(`${ansi.bold}${ansi.red}EMBER startup failed${ansi.reset}`);
  console.error(separator);
  console.error(` ${bullet(ansi.red, "●")} ${message}`);
  console.error(` ${bullet(ansi.dim, "•")} logs data/server.log  data/web.log`);

  for (const processInfo of processes) {
    if (processInfo.recentLines.length === 0) {
      continue;
    }
    console.error(` ${bullet(ansi.dim, "•")} recent ${processInfo.label} output`);
    for (const line of processInfo.recentLines.slice(-6)) {
      console.error(`   ${line}`);
    }
  }
  console.error("");
}

async function readMcpStartupStats(): Promise<McpStartupStats | null> {
  try {
    const response = await fetch(`${localApiUrl}/api/mcp/servers`, { redirect: "manual" });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as {
      stats?: {
        configuredServers?: number;
        runningServers?: number;
        activeTools?: number;
      };
    };
    const runningServers = payload.stats?.runningServers ?? 0;
    return {
      configuredServers: Math.max(payload.stats?.configuredServers ?? 0, runningServers),
      runningServers,
      activeTools: payload.stats?.activeTools ?? 0,
    };
  } catch {
    return null;
  }
}

function spawnWithLogs(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    logFile: string;
  },
) {
  const fd = openLogFile(options.cwd, options.logFile);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  return child;
}

function spawnForegroundWithLogs(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    logFile: string;
    label: string;
    onLine?: (line: string) => void;
  },
): ForegroundProcess {
  const target = path.join(options.cwd, "data", options.logFile);
  const stream = createWriteStream(target, { flags: "a" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }) as ChildProcessByStdio<null, Readable, Readable>;
  const recentLines: string[] = [];
  const consume = (rawText: string, write: (value: string) => void, state: { buffer: string }) => {
    const lines = `${state.buffer}${rawText.replace(/\r/g, "")}`.split("\n");
    state.buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = stripAnsi(rawLine).trimEnd();
      if (!line) {
        continue;
      }
      if (line.includes("ExperimentalWarning: SQLite") || line.startsWith("(Use `node --trace-warnings")) {
        continue;
      }
      const formatted = `[${options.label}] ${line}`;
      recentLines.push(formatted);
      if (recentLines.length > 40) {
        recentLines.shift();
      }
      options.onLine?.(formatted);
      if (verboseStartup) {
        write(`${formatted}\n`);
      }
    }
  };
  const stdoutState = { buffer: "" };
  const stderrState = { buffer: "" };

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    stream.write(text);
    consume(text, (value) => process.stdout.write(value), stdoutState);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stream.write(text);
    consume(text, (value) => process.stderr.write(value), stderrState);
  });
  child.on("exit", () => {
    stream.end();
  });
  return { child, label: options.label, recentLines };
}

function usage() {
  console.log(`EMBER CLI

Commands:
  ember                Start the local runtime and web UI in dev mode
  ember start          Start the local runtime and web UI in dev mode
  ember dev            Start the local runtime and web UI in dev mode
  ember prod           Start the built runtime and built web UI
  ember doctor         Check local readiness
  ember status         Show runtime status
  ember stop           Stop the local runtime
  ember tailscale enable  Print local tailnet guidance
`);
}

function commandExists(command: string): boolean {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function listListeningPids(port: string): number[] {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.error) {
    return [];
  }

  return (result.stdout ?? "")
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function clearManagedPortListeners(excludePids: number[] = []): Promise<void> {
  const excluded = new Set(excludePids.filter((pid) => Number.isInteger(pid) && pid > 0));

  for (const port of managedPorts) {
    for (const pid of listListeningPids(port)) {
      if (excluded.has(pid)) {
        continue;
      }
      await terminateProcess(pid);
    }
  }
}

function shouldDisplayDashboardLine(line: string): boolean {
  if (!line.trim()) {
    return false;
  }
  if (/^\[(?:web|server)\]\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.test(line)) {
    return false;
  }
  if (/^\[server\]\s+\[mcp\]\s+resolved\s+"/i.test(line)) {
    return false;
  }
  if (/^\[web\]\s+-\s+(?:Local|Network):/i.test(line)) {
    return false;
  }
  return true;
}

function normalizeDashboardLine(line: string): string {
  return line
    .replace(/\bin \d+ms\b/g, "in <ms>")
    .replace(/\(\d+ modules\)/g, "(<modules> modules)")
    .replace(/\bready in \d+ms\b/gi, "ready in <ms>");
}

function formatDashboardLine(line: string): string {
  return line.replace(
    /^(\[server\]\s+\[mcp\]\s+Server\s+"[^"]+"\s+ready[^:]*):\s+.+$/i,
    "$1",
  );
}

function splitCollapsedDashboardLine(line: string): { base: string; count: number } {
  const match = /^(.*) \(x(\d+)\)$/.exec(line);
  if (!match) {
    return { base: line, count: 1 };
  }
  return {
    base: match[1] ?? line,
    count: Number.parseInt(match[2] ?? "1", 10) || 1,
  };
}

function pushDashboardLine(target: string[], line: string, limit: number): void {
  const sanitized = formatDashboardLine(stripAnsi(line).trim());
  if (!shouldDisplayDashboardLine(sanitized)) {
    return;
  }

  const previous = target.at(-1);
  if (previous) {
    const previousLine = splitCollapsedDashboardLine(previous);
    if (normalizeDashboardLine(previousLine.base) === normalizeDashboardLine(sanitized)) {
      target[target.length - 1] = `${sanitized} (x${previousLine.count + 1})`;
      return;
    }
  }

  target.push(sanitized);
  while (target.length > limit) {
    target.shift();
  }
}

function createDashboardSnapshot(mode: StartMode): DashboardSnapshot {
  return {
    mode,
    startedAt: null,
    runtime: {
      status: "starting",
      url: localApiUrl,
      host: runtimeHost,
      pid: null,
    },
    web: {
      status: "starting",
      url: localWebUrl,
      host: webHost,
      pid: null,
    },
    mcp: {
      configuredServers: 0,
      runningServers: 0,
      activeTools: 0,
      activeCalls: 0,
      drainingServers: 0,
    },
    tools: {
      codexAvailable: commandExists("codex"),
      claudeAvailable: commandExists("claude"),
      verboseStartup,
    },
    activity: {
      merged: ["[ember] Preparing managed runtime and web services..."],
      server: ["[server] Waiting for runtime bootstrap..."],
      web: ["[web] Waiting for web bootstrap..."],
    },
    logs: {
      serverPath: "data/server.log",
      webPath: "data/web.log",
    },
  };
}

function resolveServiceStatus(options: {
  ready: boolean;
  alive: boolean;
  shuttingDown: boolean;
}): DashboardServiceStatus {
  if (options.shuttingDown) {
    return "stopping";
  }
  if (options.ready) {
    return "running";
  }
  if (options.alive) {
    return "starting";
  }
  return "error";
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual" });
    return response.ok || (response.status >= 300 && response.status < 400);
  } catch {
    return false;
  }
}

async function readRuntimeHealth(): Promise<import("@ember/core").RuntimeState | null> {
  try {
    const response = await fetch(`${localApiUrl}/health`, { redirect: "manual" });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as { runtime?: import("@ember/core").RuntimeState };
    return payload.runtime ?? null;
  } catch {
    return null;
  }
}

async function readMcpDashboardStats(): Promise<DashboardSnapshot["mcp"] | null> {
  try {
    const response = await fetch(`${localApiUrl}/api/mcp/servers`, { redirect: "manual" });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as {
      stats?: {
        configuredServers?: number;
        runningServers?: number;
        activeTools?: number;
        activeCalls?: number;
        drainingServers?: number;
      };
    };
    const runningServers = payload.stats?.runningServers ?? 0;
    const configuredServers = Math.max(payload.stats?.configuredServers ?? 0, runningServers);
    return {
      configuredServers,
      runningServers,
      activeTools: payload.stats?.activeTools ?? 0,
      activeCalls: payload.stats?.activeCalls ?? 0,
      drainingServers: payload.stats?.drainingServers ?? 0,
    };
  } catch {
    return null;
  }
}

async function waitFor(url: string, timeoutMs = 30000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probeUrl(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

type StartMode = "dev" | "prod";

async function stopRuntimeChildren(
  runtime = defaultRuntime(),
) {
  if (hasManagedRuntime(runtime)) {
    await writeRuntime({
      ...runtime,
      status: "stopping",
    });
  } else {
    await writeRuntime(defaultRuntime());
  }

  for (const pid of [runtime.serverPid, runtime.webPid]) {
    await terminateProcess(pid);
  }
  await clearManagedPortListeners();
  await writeRuntime(defaultRuntime());
}

async function runForeground(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
) {
  const snapshot = createDashboardSnapshot("dev");
  const dashboard = dashboardEnabled ? new TerminalDashboard(snapshot) : null;
  const syncLine = (label: "server" | "web") => (line: string) => {
    pushDashboardLine(snapshot.activity[label], line, 48);
    pushDashboardLine(snapshot.activity.merged, line, 96);
    dashboard?.setSnapshot(snapshot);
  };

  if (dashboard) {
    dashboard.start();
  } else {
    printStartupHeader();
  }

  const server = spawnForegroundWithLogs(
    "pnpm",
    ["--filter", "@ember/server", "exec", "tsx", "watch", "src/index.ts"],
    {
      cwd: repoRoot,
      env,
      logFile: "server.log",
      label: "server",
      onLine: syncLine("server"),
    },
  );
  const web = spawnForegroundWithLogs(
    "pnpm",
    ["--filter", "@ember/web", "exec", "next", "dev", "--hostname", webHost, "--port", webPort],
    {
      cwd: repoRoot,
      env,
      logFile: "web.log",
      label: "web",
      onLine: syncLine("web"),
    },
  );
  snapshot.startedAt = new Date().toISOString();
  snapshot.runtime.pid = server.child.pid ?? null;
  snapshot.web.pid = web.child.pid ?? null;
  dashboard?.setSnapshot(snapshot);

  await writeRuntime({
    serverPid: server.child.pid ?? null,
    webPid: web.child.pid ?? null,
    startedAt: snapshot.startedAt,
    webUrl: localWebUrl,
    apiUrl: localApiUrl,
    status: "starting",
  });

  let shuttingDown = false;
  let dashboardSyncHandle: NodeJS.Timeout | null = null;
  let dashboardSyncInFlight = false;
  const stopDashboard = (message?: string) => {
    if (dashboardSyncHandle) {
      clearInterval(dashboardSyncHandle);
      dashboardSyncHandle = null;
    }
    dashboard?.stop(message);
  };
  const syncDashboard = async () => {
    if (!dashboard || dashboardSyncInFlight) {
      return;
    }
    dashboardSyncInFlight = true;
    try {
      const [runtimeHealth, apiHealthy, webHealthy, mcpStats] = await Promise.all([
        readRuntimeHealth(),
        probeUrl(`${localApiUrl}/health`),
        probeUrl(localWebUrl),
        readMcpDashboardStats(),
      ]);

      if (runtimeHealth) {
        snapshot.startedAt = runtimeHealth.startedAt ?? snapshot.startedAt;
        snapshot.runtime.pid = runtimeHealth.serverPid ?? snapshot.runtime.pid;
        snapshot.web.pid = runtimeHealth.webPid ?? snapshot.web.pid;
      }
      snapshot.runtime.status = resolveServiceStatus({
        ready: apiHealthy,
        alive: isProcessAlive(server.child.pid),
        shuttingDown,
      });
      snapshot.web.status = resolveServiceStatus({
        ready: webHealthy,
        alive: isProcessAlive(web.child.pid),
        shuttingDown,
      });
      if (mcpStats) {
        snapshot.mcp = mcpStats;
      }
      dashboard.setSnapshot(snapshot);
    } finally {
      dashboardSyncInFlight = false;
    }
  };

  if (dashboard) {
    await syncDashboard();
    dashboardSyncHandle = setInterval(() => {
      void syncDashboard();
    }, 1_000);
    dashboardSyncHandle.unref?.();
  }

  const [serverReady, webReady] = await Promise.all([
    waitFor(`${localApiUrl}/health`),
    waitFor(localWebUrl),
  ]);

  await writeRuntime({
    serverPid: server.child.pid ?? null,
    webPid: web.child.pid ?? null,
    startedAt: snapshot.startedAt,
    webUrl: localWebUrl,
    apiUrl: localApiUrl,
    status: serverReady && webReady ? "running" : "error",
  });
  const mcpStats = serverReady ? await readMcpStartupStats() : null;
  const runtimeState = () => ({
    serverPid: server.child.pid ?? null,
    webPid: web.child.pid ?? null,
    startedAt: snapshot.startedAt ?? new Date().toISOString(),
    webUrl: localWebUrl,
    apiUrl: localApiUrl,
    status: "error" as const,
  });
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    snapshot.runtime.status = "stopping";
    snapshot.web.status = "stopping";
    dashboard?.setSnapshot(snapshot);
    for (const child of [server.child, web.child]) {
      await terminateProcess(child.pid);
    }
    await clearManagedPortListeners();
    await writeRuntime(defaultRuntime());
  };

  const handleSignal = async () => {
    await shutdown();
    stopDashboard("EMBER stopped.");
    process.exit(0);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  process.once("SIGHUP", handleSignal);
  process.once("exit", () => {
    stopDashboard();
    for (const child of [server.child, web.child]) {
      if (child.pid) {
        sendSignal(child.pid, "SIGTERM");
      }
    }
  });

  if (!serverReady || !webReady) {
    process.exitCode = 1;
    stopDashboard();
    printStartupFailure("One or more services did not become ready in time.", [server, web]);
    await writeRuntime(runtimeState());
    await shutdown();
    return;
  }

  snapshot.runtime.status = "running";
  snapshot.web.status = "running";
  if (mcpStats) {
    snapshot.mcp = {
      configuredServers: Math.max(snapshot.mcp.configuredServers, mcpStats.configuredServers, mcpStats.runningServers),
      runningServers: mcpStats.runningServers,
      activeTools: mcpStats.activeTools,
      activeCalls: snapshot.mcp.activeCalls,
      drainingServers: snapshot.mcp.drainingServers,
    };
  }
  if (dashboard) {
    dashboard.setSnapshot(snapshot);
  } else {
    printReadySummary(mcpStats);
  }

  const exited = await Promise.race([
    new Promise<"server">((resolve) => server.child.once("exit", () => resolve("server"))),
    new Promise<"web">((resolve) => web.child.once("exit", () => resolve("web"))),
  ]);
  const persistedRuntime = await readRuntime().catch(() => defaultRuntime());
  const externallyStopped = persistedRuntime.status === "stopping" ||
    (persistedRuntime.status === "idle" && !hasManagedRuntime(persistedRuntime));

  if (!shuttingDown && !externallyStopped) {
    process.exitCode = 1;
    stopDashboard();
    printStartupFailure(`${exited} exited unexpectedly.`, [server, web]);
    await writeRuntime(runtimeState());
  }

  await shutdown();
  stopDashboard(externallyStopped || shuttingDown ? "EMBER stopped." : undefined);
}

async function start(mode: StartMode) {
  const repoRoot = resolveEmberRoot(process.cwd(), process.env.EMBER_ROOT);
  process.env.EMBER_ROOT = repoRoot;
  const runtime = await readRuntime().catch(() => defaultRuntime());
  await ensureDataFiles(repoRoot);
  const settings = await readSettings();
  await initializeMemoryInfrastructure(settings.memory);

  if (hasManagedRuntime(runtime)) {
    await stopRuntimeChildren(runtime);
  } else if (runtime.status !== "idle") {
    await writeRuntime(defaultRuntime());
  }

  await clearManagedPortListeners();

  const env = buildRuntimeEnv({
    repoRoot,
    runtimeHost,
    runtimePort,
    webHost,
    webPort,
    apiUrl: localApiUrl,
  });

  if (mode === "dev") {
    await runForeground(repoRoot, env);
    return;
  }

  const serverBuild = path.join(repoRoot, "apps", "server", "dist", "index.js");
  const webBuild = path.join(repoRoot, "apps", "web", ".next");

  const server =
    mode === "prod" && existsSync(serverBuild)
      ? spawnWithLogs("node", [serverBuild], {
          cwd: repoRoot,
          env,
          logFile: "server.log",
        })
      : spawnWithLogs(
          "pnpm",
          ["--filter", "@ember/server", "exec", "tsx", "watch", "src/index.ts"],
          {
            cwd: repoRoot,
            env,
            logFile: "server.log",
          },
        );

  const web =
    mode === "prod" && existsSync(webBuild)
      ? spawnWithLogs(
          "pnpm",
          [
            "--filter",
            "@ember/web",
            "exec",
            "next",
            "start",
            "--hostname",
            webHost,
            "--port",
            webPort,
          ],
          {
            cwd: repoRoot,
            env,
            logFile: "web.log",
          },
        )
      : spawnWithLogs(
          "pnpm",
          [
            "--filter",
            "@ember/web",
            "exec",
            "next",
            "dev",
            "--hostname",
            webHost,
            "--port",
            webPort,
          ],
          {
            cwd: repoRoot,
            env,
            logFile: "web.log",
          },
        );

  await writeRuntime({
    serverPid: server.pid ?? null,
    webPid: web.pid ?? null,
    startedAt: new Date().toISOString(),
    webUrl: localWebUrl,
    apiUrl: localApiUrl,
    status: "starting",
  });

  const [serverReady, webReady] = await Promise.all([
    waitFor(`${localApiUrl}/health`),
    waitFor(localWebUrl),
  ]);

  await writeRuntime({
    serverPid: server.pid ?? null,
    webPid: web.pid ?? null,
    startedAt: new Date().toISOString(),
    webUrl: localWebUrl,
    apiUrl: localApiUrl,
    status: serverReady && webReady ? "running" : "error",
  });

  printReadySummary(serverReady ? await readMcpStartupStats() : null);
  console.log(`mode: ${mode}`);
  if (!serverReady || !webReady) {
    process.exitCode = 1;
    console.error("One or more services did not become ready in time.");
    console.error(`server log: ${path.join(repoRoot, "data", "server.log")}`);
    console.error(`web log: ${path.join(repoRoot, "data", "web.log")}`);
    await stopRuntimeChildren({
      serverPid: server.pid ?? null,
      webPid: web.pid ?? null,
      startedAt: new Date().toISOString(),
      webUrl: localWebUrl,
      apiUrl: localApiUrl,
      status: "error",
    });
  }
}

async function stop() {
  const repoRoot = resolveEmberRoot(process.cwd(), process.env.EMBER_ROOT);
  process.env.EMBER_ROOT = repoRoot;
  await ensureDataFiles(repoRoot);
  const runtime = await readRuntime();
  await stopRuntimeChildren(runtime);
  console.log("EMBER stopped.");
}

async function status() {
  const repoRoot = resolveEmberRoot(process.cwd(), process.env.EMBER_ROOT);
  process.env.EMBER_ROOT = repoRoot;
  await ensureDataFiles(repoRoot);
  const runtime = await readRuntime().catch(() => defaultRuntime());
  const apiBaseUrl = runtime.apiUrl || localApiUrl;
  const webUrl = runtime.webUrl || localWebUrl;
  const apiHealthUrl = new URL("/health", apiBaseUrl).toString();
  const hasActiveRuntime = hasManagedRuntime(runtime);
  const apiHealthy = hasActiveRuntime ? await waitFor(apiHealthUrl, 1500) : false;
  const webHealthy = hasActiveRuntime ? await waitFor(webUrl, 1500) : false;

  console.log(`status: ${runtime.status}`);
  console.log(`runtime pid: ${runtime.serverPid ?? "n/a"}`);
  console.log(`web pid: ${runtime.webPid ?? "n/a"}`);
  console.log(`runtime url: ${apiBaseUrl}`);
  console.log(`web url: ${webUrl}`);
  console.log(`api health: ${apiHealthy ? "ok" : "down"}`);
  console.log(`web health: ${webHealthy ? "ok" : "down"}`);
}

async function doctor() {
  const repoRoot = resolveEmberRoot(process.cwd(), process.env.EMBER_ROOT);
  process.env.EMBER_ROOT = repoRoot;
  const checks = [
    ["node", commandExists("node")],
    ["npm", commandExists("npm")],
    ["pnpm", commandExists("pnpm")],
    ["codex", commandExists("codex")],
    ["claude", commandExists("claude")],
    ["workspace", existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))],
  ] as const;

  for (const [label, ok] of checks) {
    console.log(`${label}: ${ok ? "ok" : "missing"}`);
  }
}

function tailscaleEnable() {
  console.log("EMBER now binds to all interfaces by default.");
  console.log(`Connect to the web UI using this machine's Tailscale IP on port ${webPort}.`);
}

const command = process.argv[2] ?? "start";

switch (command) {
  case "start":
  case "dev":
    await start("dev");
    break;
  case "prod":
    await start("prod");
    break;
  case "doctor":
    await doctor();
    break;
  case "status":
    await status();
    break;
  case "stop":
    await stop();
    break;
  case "tailscale":
    if (process.argv[3] === "enable") {
      tailscaleEnable();
    } else {
      usage();
    }
    break;
  case "--help":
  case "-h":
    usage();
    break;
  default:
    usage();
    process.exitCode = 1;
}
