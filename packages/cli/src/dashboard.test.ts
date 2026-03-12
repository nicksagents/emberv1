import test from "node:test";
import assert from "node:assert/strict";

import { renderDashboard, stripAnsi, type DashboardSnapshot } from "./dashboard.js";

function sampleSnapshot(): DashboardSnapshot {
  return {
    mode: "dev",
    startedAt: new Date(Date.now() - 12_000).toISOString(),
    runtime: {
      status: "running",
      url: "http://127.0.0.1:3005",
      host: "0.0.0.0",
      pid: 101,
    },
    web: {
      status: "running",
      url: "http://127.0.0.1:3000",
      host: "0.0.0.0",
      pid: 102,
    },
    mcp: {
      configuredServers: 2,
      runningServers: 2,
      activeTools: 26,
      activeCalls: 1,
      drainingServers: 0,
    },
    tools: {
      codexAvailable: true,
      claudeAvailable: false,
      verboseStartup: false,
    },
    activity: {
      merged: [
        "[server] MCP ready",
        "[web] Ready in 1200ms",
      ],
      server: [
        "[server] scaffold ready",
        "[server] playwright ready",
      ],
      web: [
        "[web] next ready",
        "[web] GET /chat 200",
      ],
    },
    logs: {
      serverPath: "data/server.log",
      webPath: "data/web.log",
    },
  };
}

test("stripAnsi removes ANSI escape codes", () => {
  assert.equal(stripAnsi("\u001b[32mhello\u001b[0m"), "hello");
});

test("renderDashboard renders a wide dashboard with split activity panes", () => {
  const output = stripAnsi(renderDashboard(sampleSnapshot(), {
    columns: 140,
    rows: 26,
    color: true,
  }));

  assert.match(output, /EMBER DASHBOARD/);
  assert.match(output, /Services/);
  assert.match(output, /Agent/);
  assert.match(output, /Server Activity/);
  assert.match(output, /Web Activity/);
  assert.match(output, /2\/2 servers/);
  assert.doesNotMatch(output, /~\+/);
});

test("renderDashboard falls back to a merged activity panel on narrow terminals", () => {
  const output = stripAnsi(renderDashboard(sampleSnapshot(), {
    columns: 86,
    rows: 22,
    color: false,
  }));

  assert.match(output, /Activity/);
  assert.doesNotMatch(output, /Server Activity/);
  assert.match(output, /\[server\] MCP ready/);
});
