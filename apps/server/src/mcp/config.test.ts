import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";

import {
  buildInstalledMcpServer,
  buildRemoteMcpServer,
  describeMcpServerTransport,
  derivePublicMcpServerName,
  loadMcpConfigFile,
  readResolvedMcpConfigState,
  removeMcpServer,
  resolveMcpTransportKind,
  upsertMcpServer,
  validateMcpServerConfig,
  validatePublicMcpPackageName,
} from "./config.js";

function tempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ember-mcp-config-"));
}

test("readResolvedMcpConfigState merges default then project config with source tracking", () => {
  const workspaceDir = tempWorkspace();
  const projectConfigPath = path.join(workspaceDir, ".ember", "mcp.json");
  mkdirSync(path.dirname(projectConfigPath), { recursive: true });
  writeFileSync(projectConfigPath, JSON.stringify({
    mcpServers: {
      playwright: {
        enabled: false,
        command: "npx",
        args: ["-y", "@playwright/mcp"],
        roles: ["coordinator"],
      },
      atlas: {
        command: "npx",
        args: ["-y", "@atlas/mcp"],
        roles: ["director"],
      },
    },
  }, null, 2));

  const state = readResolvedMcpConfigState({
    workspaceDir,
    defaultConfig: {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp"],
          roles: ["coordinator", "inspector"],
        },
        scaffold: {
          command: "npx",
          args: ["-y", "@ember/project-scaffold-mcp"],
          roles: ["coordinator", "director"],
        },
      },
    },
  });

  assert.equal(state.servers.length, 3);
  assert.equal(state.servers.find((entry) => entry.name === "playwright")?.sourceScope, "project");
  assert.equal(state.servers.find((entry) => entry.name === "playwright")?.config.enabled, false);
  assert.equal(state.servers.find((entry) => entry.name === "scaffold")?.sourceScope, "default");
  assert.equal(state.servers.find((entry) => entry.name === "atlas")?.sourceScope, "project");
});

test("upsertMcpServer and removeMcpServer manage project-scoped config files", async () => {
  const workspaceDir = tempWorkspace();
  const config = buildInstalledMcpServer({
    packageName: "@modelcontextprotocol/server-filesystem",
    roles: ["coordinator", "director"],
    args: ["--root", "."],
    timeout: 45_000,
    description: "Filesystem access",
  });

  await upsertMcpServer({
    scope: "project",
    workspaceDir,
    name: "filesystem",
    config,
  });

  const written = loadMcpConfigFile(path.join(workspaceDir, ".ember", "mcp.json"));
  assert.ok(written);
  assert.deepEqual(written?.mcpServers.filesystem?.roles, ["coordinator", "director"]);
  assert.deepEqual(written?.mcpServers.filesystem?.args, [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "--root",
    ".",
  ]);

  const removed = await removeMcpServer({
    scope: "project",
    workspaceDir,
    name: "filesystem",
  });
  assert.equal(removed, true);
  const afterRemove = loadMcpConfigFile(path.join(workspaceDir, ".ember", "mcp.json"));
  assert.deepEqual(afterRemove?.mcpServers ?? {}, {});
});

test("public MCP package helpers validate names and derive compact server ids", () => {
  assert.equal(validatePublicMcpPackageName("@modelcontextprotocol/server-filesystem"), null);
  assert.match(validatePublicMcpPackageName("bad package") ?? "", /public npm package id/i);
  assert.equal(derivePublicMcpServerName("@modelcontextprotocol/server-filesystem"), "server-filesystem");
});

test("remote MCP helpers build and validate streamable HTTP and SSE configs", () => {
  const httpConfig = buildRemoteMcpServer({
    transport: "streamable-http",
    url: "https://mcp.example.test/mcp",
    roles: ["coordinator", "inspector"],
    headers: { Authorization: "Bearer demo" },
    timeout: 20_000,
  });
  const sseConfig = buildRemoteMcpServer({
    transport: "sse",
    url: "https://mcp.example.test/sse",
    roles: ["advisor"],
  });

  assert.equal(resolveMcpTransportKind(httpConfig), "streamable-http");
  assert.equal(resolveMcpTransportKind(sseConfig), "sse");
  assert.equal(validateMcpServerConfig(httpConfig), null);
  assert.equal(validateMcpServerConfig(sseConfig), null);
  assert.equal(describeMcpServerTransport(httpConfig), "https://mcp.example.test/mcp");
  assert.equal(describeMcpServerTransport(sseConfig), "https://mcp.example.test/sse");
});
