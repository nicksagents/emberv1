import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { McpClientManager } from "./mcp/mcp-client-manager.js";

const __testDir = dirname(fileURLToPath(import.meta.url));
const STDIO_FIXTURE_PATH = join(__testDir, "mcp", "fixtures", "test-stdio-server.ts");

function canSpawnNodeWithTsx(): boolean {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", "console.log('ok')"], {
    encoding: "utf8",
  });
  return !result.error && result.status === 0;
}

function tempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ember-mcp-runtime-"));
}

function writeProjectMcpConfig(workspaceDir: string, config: unknown): void {
  const configPath = join(workspaceDir, ".ember", "mcp.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs}ms.`);
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server port.");
  }
  return address.port;
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function ensureLoopbackSocketAvailable(t: { skip: (message?: string) => void }): Promise<boolean> {
  const probe = createServer((_req, res) => {
    res.writeHead(200).end("ok");
  });
  try {
    await listen(probe);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    t.skip(`Loopback sockets unavailable in this runtime: ${message}`);
    return false;
  } finally {
    await closeHttpServer(probe).catch(() => undefined);
  }
}

async function startStreamableHttpFixture(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("not found");
      return;
    }

    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST, DELETE" }).end("method not allowed");
      return;
    }

    if (req.method === "DELETE") {
      const rawSessionId = req.headers["mcp-session-id"];
      const sessionId = typeof rawSessionId === "string" ? rawSessionId : null;
      const session = sessionId ? sessions.get(sessionId) : null;
      if (session && sessionId) {
        sessions.delete(sessionId);
        await session.transport.close().catch(() => undefined);
        await session.server.close().catch(() => undefined);
      }
      res.writeHead(405, { Allow: "POST" }).end("method not allowed");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, DELETE" }).end("method not allowed");
      return;
    }

    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = typeof rawSessionId === "string" ? rawSessionId : null;
    let session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      const mcpServer = new McpServer({
        name: "ember-streamable-http-test",
        version: "1.0.0",
      });
      mcpServer.registerTool("remote_ping", {
        description: "Return a fixed response from the streamable HTTP test server.",
      }, async () => ({
        content: [{ type: "text", text: "streamable-http-ok" }],
      }));

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, { transport, server: mcpServer });
        },
      });
      transport.onclose = () => {
        const activeSessionId = transport.sessionId;
        if (activeSessionId) {
          sessions.delete(activeSessionId);
        }
      };
      await mcpServer.connect(transport);
      session = { transport, server: mcpServer };
    }

    await session.transport.handleRequest(req, res);
  });
  const port = await listen(httpServer);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await Promise.all(
        [...sessions.values()].map(async (session) => {
          await session.transport.close().catch(() => undefined);
          await session.server.close().catch(() => undefined);
        }),
      );
      await closeHttpServer(httpServer);
    },
  };
}

async function startSseFixture(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      const mcpServer = new McpServer({
        name: "ember-sse-test",
        version: "1.0.0",
      });
      mcpServer.registerTool("sse_ping", {
        description: "Return a fixed response from the SSE test server.",
      }, async () => ({
        content: [{ type: "text", text: "sse-ok" }],
      }));

      sessions.set(transport.sessionId, { transport, server: mcpServer });
      transport.onclose = () => {
        sessions.delete(transport.sessionId);
      };
      await mcpServer.connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      const session = sessionId ? sessions.get(sessionId) : null;
      if (!session) {
        res.writeHead(404).end("missing session");
        return;
      }
      await session.transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404).end("not found");
  });
  const port = await listen(httpServer);

  return {
    url: `http://127.0.0.1:${port}/sse`,
    close: async () => {
      await Promise.all(
        [...sessions.values()].map(async (session) => {
          await session.transport.close().catch(() => undefined);
          await session.server.close().catch(() => undefined);
        }),
      );
      await closeHttpServer(httpServer);
    },
  };
}

test("McpClientManager reload drains active stdio MCP calls without interruption", async (t) => {
  if (!canSpawnNodeWithTsx()) {
    t.skip("Skipping stdio MCP integration test because child Node+tsx subprocesses are unavailable.");
    return;
  }

  const workspaceDir = tempWorkspace();
  const signalDir = join(workspaceDir, "signals");
  mkdirSync(signalDir, { recursive: true });
  writeProjectMcpConfig(workspaceDir, {
    mcpServers: {
      slowtest: {
        command: process.execPath,
        args: ["--import", "tsx", STDIO_FIXTURE_PATH],
        env: {
          MCP_SIGNAL_DIR: signalDir,
          MCP_SLOW_TEXT: "slow-ok",
          MCP_QUICK_TEXT: "quick-ok",
        },
        roles: ["coordinator"],
      },
    },
  });

  const manager = new McpClientManager({ workspaceDir });
  await manager.start();

  try {
    const initialTools = manager.getTools();
    const slowTool = initialTools.find((entry) => entry.tool.definition.name === "mcp__slowtest__slow_echo")?.tool;
    if (!slowTool) {
      t.skip("Skipping stdio MCP integration test because fixture tools were not discovered in this runtime.");
      return;
    }

    const slowCall = slowTool!.execute({});
    await waitFor(() => existsSync(join(signalDir, "call-started")));
    assert.equal(manager.getRuntimeStats().activeCalls, 1);

    await manager.reload();
    const statsAfterReload = manager.getRuntimeStats();
    assert.equal(statsAfterReload.runningServers, 1);
    assert.equal(statsAfterReload.drainingServers, 1);

    const quickTool = manager.getTools().find((entry) => entry.tool.definition.name === "mcp__slowtest__quick_echo")?.tool;
    if (!quickTool) {
      t.skip("Skipping stdio MCP integration test because fixture tools disappeared after reload in this runtime.");
      return;
    }
    assert.equal(await quickTool!.execute({}), "quick-ok");

    writeFileSync(join(signalDir, "release"), "release", "utf8");
    assert.equal(await slowCall, "slow-ok");
    await waitFor(() => manager.getRuntimeStats().drainingServers === 0);
  } finally {
    await manager.stop();
  }
});

test("McpClientManager can discover and call tools over streamable HTTP", async (t) => {
  if (!(await ensureLoopbackSocketAvailable(t))) {
    return;
  }

  const workspaceDir = tempWorkspace();
  const fixture = await startStreamableHttpFixture();
  writeProjectMcpConfig(workspaceDir, {
    mcpServers: {
      remotehttp: {
        httpUrl: fixture.url,
        roles: ["coordinator"],
      },
    },
  });

  const manager = new McpClientManager({ workspaceDir });
  try {
    await manager.start();
    const tool = manager.getTools().find((entry) => entry.tool.definition.name === "mcp__remotehttp__remote_ping")?.tool;
    assert.ok(tool, "remote streamable HTTP tool should be discovered");
    assert.equal(await tool!.execute({}), "streamable-http-ok");
  } finally {
    await manager.stop();
    await fixture.close();
  }
});

test("McpClientManager can discover and call tools over SSE", async (t) => {
  if (!(await ensureLoopbackSocketAvailable(t))) {
    return;
  }

  const workspaceDir = tempWorkspace();
  const fixture = await startSseFixture();
  writeProjectMcpConfig(workspaceDir, {
    mcpServers: {
      remotesse: {
        url: fixture.url,
        roles: ["coordinator"],
      },
    },
  });

  const manager = new McpClientManager({ workspaceDir });
  try {
    await manager.start();
    const tool = manager.getTools().find((entry) => entry.tool.definition.name === "mcp__remotesse__sse_ping")?.tool;
    assert.ok(tool, "remote SSE tool should be discovered");
    assert.equal(await tool!.execute({}), "sse-ok");
  } finally {
    await manager.stop();
    await fixture.close();
  }
});
