#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, createWriteStream, existsSync, openSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  defaultRuntime,
  ensureDataFiles,
  readRuntime,
  resolveRepoRoot,
  writeRuntime,
} from "@ember/core";

const localWebUrl = "http://127.0.0.1:3000";
const localApiUrl = "http://127.0.0.1:3005";
const bindHost = process.env.EMBER_BIND_HOST ?? "0.0.0.0";

function openLogFile(repoRoot: string, fileName: string): number {
  const target = path.join(repoRoot, "data", fileName);
  return openSync(target, "a");
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
  },
) {
  const target = path.join(options.cwd, "data", options.logFile);
  const stream = createWriteStream(target, { flags: "a" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = `[${options.label}] `;
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    stream.write(text);
    process.stdout.write(
      text
        .split("\n")
        .map((line: string, index: number, list: string[]) =>
          line.length > 0 || index < list.length - 1 ? `${prefix}${line}\n` : "",
        )
        .join(""),
    );
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stream.write(text);
    process.stderr.write(
      text
        .split("\n")
        .map((line: string, index: number, list: string[]) =>
          line.length > 0 || index < list.length - 1 ? `${prefix}${line}\n` : "",
        )
        .join(""),
    );
  });
  child.on("exit", () => {
    stream.end();
  });
  return child;
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

async function waitFor(url: string, timeoutMs = 30000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function printSummary() {
  console.log("EMBER startup");
  console.log(`runtime: ${localApiUrl}`);
  console.log(`web ui: ${localWebUrl}`);
  console.log(`bind host: ${bindHost}`);
  console.log(`codex cli: ${commandExists("codex") ? "available" : "not installed"}`);
  console.log(`claude cli: ${commandExists("claude") ? "available" : "not installed"}`);
  console.log("tailscale: connect using this machine's Tailscale IP on port 3000");
}

type StartMode = "dev" | "prod";

async function stopRuntimeChildren(
  runtime = defaultRuntime(),
) {
  for (const pid of [runtime.serverPid, runtime.webPid]) {
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // Ignore stale PIDs.
      }
    }
  }
  await writeRuntime(defaultRuntime());
}

async function runForeground(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
) {
  const server = spawnForegroundWithLogs(
    "pnpm",
    ["--filter", "@ember/server", "exec", "tsx", "watch", "src/index.ts"],
    {
      cwd: repoRoot,
      env,
      logFile: "server.log",
      label: "server",
    },
  );
  const web = spawnForegroundWithLogs(
    "pnpm",
    ["--filter", "@ember/web", "exec", "next", "dev", "--hostname", bindHost, "--port", "3000"],
    {
      cwd: repoRoot,
      env,
      logFile: "web.log",
      label: "web",
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

  printSummary();
  console.log("mode: dev");
  console.log("ctrl+c: stop runtime");
  console.log("logs: data/server.log, data/web.log");

  if (!serverReady || !webReady) {
    process.exitCode = 1;
    console.error("One or more services did not become ready in time.");
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const child of [server, web]) {
      if (child.pid) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore.
        }
      }
    }
    await writeRuntime(defaultRuntime());
  };

  const handleSignal = async () => {
    await shutdown();
    process.exit(0);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  await Promise.race([
    new Promise((resolve) => server.on("exit", resolve)),
    new Promise((resolve) => web.on("exit", resolve)),
  ]);

  await shutdown();
}

async function start(mode: StartMode) {
  const repoRoot = resolveRepoRoot(process.cwd());
  const runtime = await readRuntime().catch(() => defaultRuntime());
  await ensureDataFiles(repoRoot);

  if (runtime.serverPid && runtime.webPid) {
    await stopRuntimeChildren(runtime);
  }

  const env = {
    ...process.env,
    COREPACK_HOME: process.env.COREPACK_HOME ?? "/tmp/corepack",
    EMBER_ROOT: repoRoot,
    EMBER_RUNTIME_HOST: bindHost,
    EMBER_RUNTIME_PORT: "3005",
    EMBER_WEB_HOST: bindHost,
    EMBER_WEB_PORT: "3000",
    NEXT_PUBLIC_API_URL: localApiUrl,
  };

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
            bindHost,
            "--port",
            "3000",
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
            bindHost,
            "--port",
            "3000",
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

  printSummary();
  console.log(`mode: ${mode}`);
  if (!serverReady || !webReady) {
    process.exitCode = 1;
    console.error("One or more services did not become ready in time.");
    console.error(`server log: ${path.join(repoRoot, "data", "server.log")}`);
    console.error(`web log: ${path.join(repoRoot, "data", "web.log")}`);
  }
}

async function stop() {
  const runtime = await readRuntime();
  await stopRuntimeChildren(runtime);
  console.log("EMBER stopped.");
}

async function status() {
  const runtime = await readRuntime().catch(() => defaultRuntime());
  const apiHealthy = await waitFor(`${localApiUrl}/health`, 1500);
  const webHealthy = await waitFor(localWebUrl, 1500);

  console.log(`status: ${runtime.status}`);
  console.log(`runtime pid: ${runtime.serverPid ?? "n/a"}`);
  console.log(`web pid: ${runtime.webPid ?? "n/a"}`);
  console.log(`api health: ${apiHealthy ? "ok" : "down"}`);
  console.log(`web health: ${webHealthy ? "ok" : "down"}`);
}

async function doctor() {
  const repoRoot = resolveRepoRoot(process.cwd());
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
  console.log("Connect to the web UI using this machine's Tailscale IP on port 3000.");
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
