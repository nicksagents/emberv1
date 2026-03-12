#!/usr/bin/env node

import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { defaultScreenshotPath, resolveDesktopController } from "./controller.js";

const server = new McpServer({
  name: "desktop-control",
  version: "0.1.0",
});

const controller = resolveDesktopController();

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

server.registerTool(
  "describe_environment",
  {
    description:
      "Describe the current OS desktop automation environment and the exact desktop capabilities available right now. Call this first on desktop tasks.",
    inputSchema: {},
  },
  async () => ({
    content: textContent(controller.describeEnvironment()),
  }),
);

server.registerTool(
  "take_screenshot",
  {
    description:
      "Capture the current desktop or active screen to an image file and return the screenshot as an image result plus the saved file path.",
    inputSchema: {
      path: z.string().optional().describe("Optional absolute or workspace-relative path for the screenshot PNG file."),
    },
  },
  async ({ path }) => {
    const filePath = resolve(path?.trim() ? path : defaultScreenshotPath());
    const screenshot = controller.takeScreenshot(filePath);
    return {
      content: [
        { type: "text", text: `Saved desktop screenshot to ${screenshot.filePath}` },
        {
          type: "image",
          data: screenshot.imageBase64,
          mimeType: screenshot.imageMimeType,
        },
      ],
    };
  },
);

server.registerTool(
  "list_open_applications",
  {
    description:
      "List currently visible applications or desktop targets that can likely be focused for automation.",
    inputSchema: {},
  },
  async () => {
    const applications = controller.listOpenApplications();
    return {
      content: textContent(
        applications.length > 0
          ? applications.map((entry, index) => `${index + 1}. ${entry}`).join("\n")
          : "No visible applications were reported.",
      ),
    };
  },
);

server.registerTool(
  "open_application",
  {
    description:
      "Launch a desktop application by name or executable identifier.",
    inputSchema: {
      application: z.string().describe("Application name, bundle name, or executable name to launch."),
    },
  },
  async ({ application }) => ({
    content: textContent(controller.openApplication(application)),
  }),
);

server.registerTool(
  "focus_application",
  {
    description:
      "Bring a desktop application to the foreground so keyboard or mouse actions target the right window.",
    inputSchema: {
      application: z.string().describe("Application name or process name to focus."),
    },
  },
  async ({ application }) => ({
    content: textContent(controller.focusApplication(application)),
  }),
);

server.registerTool(
  "open_resource",
  {
    description:
      "Open a local file, directory, or URL using the desktop environment's default handler.",
    inputSchema: {
      target: z.string().describe("Absolute path, workspace-relative path, or URL to open."),
    },
  },
  async ({ target }) => ({
    content: textContent(controller.openResource(target)),
  }),
);

server.registerTool(
  "type_text",
  {
    description:
      "Type literal text into the currently focused desktop control or application.",
    inputSchema: {
      text: z.string().describe("Literal text to type into the focused application."),
    },
  },
  async ({ text }) => ({
    content: textContent(controller.typeText(text)),
  }),
);

server.registerTool(
  "press_keys",
  {
    description:
      "Press a single desktop key chord such as cmd+l, ctrl+shift+p, enter, escape, or alt+tab.",
    inputSchema: {
      chord: z.string().describe("A key chord like cmd+l, ctrl+shift+p, enter, tab, or escape."),
    },
  },
  async ({ chord }) => ({
    content: textContent(controller.pressKeys(chord)),
  }),
);

server.registerTool(
  "move_mouse",
  {
    description:
      "Move the mouse pointer to an absolute screen coordinate.",
    inputSchema: {
      x: z.number().describe("Absolute screen X coordinate in pixels."),
      y: z.number().describe("Absolute screen Y coordinate in pixels."),
    },
  },
  async ({ x, y }) => ({
    content: textContent(controller.moveMouse(x, y)),
  }),
);

server.registerTool(
  "click_mouse",
  {
    description:
      "Move the pointer to an absolute screen coordinate and click the requested mouse button.",
    inputSchema: {
      x: z.number().describe("Absolute screen X coordinate in pixels."),
      y: z.number().describe("Absolute screen Y coordinate in pixels."),
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button to click."),
      clicks: z.number().optional().describe("Number of clicks to perform. Defaults to 1."),
    },
  },
  async ({ x, y, button, clicks }) => ({
    content: textContent(
      controller.clickMouse(
        x,
        y,
        button === "right" || button === "middle" ? button : "left",
        typeof clicks === "number" && Number.isFinite(clicks) ? clicks : 1,
      ),
    ),
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[desktop-mcp] MCP server ready on stdio");
}

main().catch((error) => {
  console.error("[desktop-mcp] Server error:", error);
  process.exit(1);
});
