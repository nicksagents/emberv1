import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const signalDir = process.env.MCP_SIGNAL_DIR ?? process.cwd();
mkdirSync(signalDir, { recursive: true });

const server = new McpServer({
  name: "ember-test-stdio",
  version: "1.0.0",
});

server.registerTool("quick_echo", {
  description: "Return a quick response for MCP integration tests.",
}, async () => ({
  content: [
    {
      type: "text",
      text: process.env.MCP_QUICK_TEXT ?? "quick-ok",
    },
  ],
}));

server.registerTool("slow_echo", {
  description: "Hold the tool call open until the test releases it.",
}, async () => {
  writeFileSync(join(signalDir, "call-started"), new Date().toISOString(), "utf8");
  const releasePath = join(signalDir, "release");
  while (!existsSync(releasePath)) {
    await delay(25);
  }
  return {
    content: [
      {
        type: "text",
        text: process.env.MCP_SLOW_TEXT ?? "slow-ok",
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
