#!/usr/bin/env node

import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { defaultScreenshotPath, resolveDesktopController } from "./controller.js";
import { formatOcrBlocks } from "./ocr.js";

const server = new McpServer({
  name: "desktop-control",
  version: "0.1.0",
});

const controller = resolveDesktopController();

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function resolveInspectionPath(pathValue?: string): string {
  return resolve(pathValue?.trim() ? pathValue : defaultScreenshotPath());
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
  "get_active_window",
  {
    description:
      "Return the currently focused desktop application and, when available, the active window title. Use this before typing or clicking when focus is uncertain.",
    inputSchema: {},
  },
  async () => ({
    content: textContent(controller.getActiveWindow()),
  }),
);

server.registerTool(
  "list_windows",
  {
    description:
      "List visible desktop windows with their application or window titles when the platform can provide them.",
    inputSchema: {},
  },
  async () => {
    const windows = controller.listWindows();
    return {
      content: textContent(
        windows.length > 0
          ? windows.map((entry, index) => `${index + 1}. ${entry}`).join("\n")
          : "No visible windows were reported.",
      ),
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

server.registerTool(
  "drag_mouse",
  {
    description:
      "Click and drag between two absolute screen coordinates using the requested mouse button.",
    inputSchema: {
      start_x: z.number().describe("Starting screen X coordinate in pixels."),
      start_y: z.number().describe("Starting screen Y coordinate in pixels."),
      end_x: z.number().describe("Ending screen X coordinate in pixels."),
      end_y: z.number().describe("Ending screen Y coordinate in pixels."),
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button to hold during the drag."),
      steps: z.number().optional().describe("Number of interpolation steps for the drag. Defaults to 12."),
    },
  },
  async ({ start_x, start_y, end_x, end_y, button, steps }) => ({
    content: textContent(
      controller.dragMouse(
        start_x,
        start_y,
        end_x,
        end_y,
        button === "right" || button === "middle" ? button : "left",
        typeof steps === "number" && Number.isFinite(steps) ? steps : 12,
      ),
    ),
  }),
);

server.registerTool(
  "scroll_mouse",
  {
    description:
      "Scroll the mouse wheel horizontally and/or vertically. Positive delta_y scrolls up, negative delta_y scrolls down. Positive delta_x scrolls right.",
    inputSchema: {
      delta_x: z.number().optional().describe("Horizontal scroll amount in wheel units. Positive is right."),
      delta_y: z.number().optional().describe("Vertical scroll amount in wheel units. Positive is up."),
      x: z.number().optional().describe("Optional screen X coordinate to move to before scrolling."),
      y: z.number().optional().describe("Optional screen Y coordinate to move to before scrolling."),
    },
  },
  async ({ delta_x, delta_y, x, y }) => ({
    content: textContent(
      controller.scrollMouse(
        typeof delta_x === "number" && Number.isFinite(delta_x) ? delta_x : 0,
        typeof delta_y === "number" && Number.isFinite(delta_y) ? delta_y : 0,
        typeof x === "number" && Number.isFinite(x) ? x : undefined,
        typeof y === "number" && Number.isFinite(y) ? y : undefined,
      ),
    ),
  }),
);

server.registerTool(
  "detect_text_on_screen",
  {
    description:
      "Run OCR on a screenshot or on the current desktop to detect visible text blocks with bounding boxes and clickable center coordinates.",
    inputSchema: {
      path: z.string().optional().describe("Optional existing screenshot path. If omitted, a fresh desktop screenshot is captured first."),
      max_results: z.number().optional().describe("Maximum OCR blocks to return. Defaults to 20."),
    },
  },
  async ({ path, max_results }) => {
    const filePath = resolveInspectionPath(path);
    if (!path?.trim()) {
      controller.takeScreenshot(filePath);
    }
    const blocks = controller.detectText(filePath).slice(
      0,
      typeof max_results === "number" && Number.isFinite(max_results)
        ? Math.max(1, Math.floor(max_results))
        : 20,
    );
    return {
      content: textContent(`OCR source: ${filePath}\n${formatOcrBlocks(blocks)}`),
    };
  },
);

server.registerTool(
  "find_text_on_screen",
  {
    description:
      "Run OCR on a screenshot or the current desktop and return the best matches for a visible label or text query, including box and center coordinates for clicking.",
    inputSchema: {
      query: z.string().describe("Visible text to locate on the screen, such as Sign in, Continue, or Inbox."),
      path: z.string().optional().describe("Optional existing screenshot path. If omitted, a fresh desktop screenshot is captured first."),
      max_results: z.number().optional().describe("Maximum matches to return. Defaults to 10."),
    },
  },
  async ({ query, path, max_results }) => {
    const filePath = resolveInspectionPath(path);
    if (!path?.trim()) {
      controller.takeScreenshot(filePath);
    }
    const blocks = controller.findTextOnScreen(
      filePath,
      query,
      typeof max_results === "number" && Number.isFinite(max_results) ? max_results : 10,
    );
    return {
      content: textContent(
        `OCR source: ${filePath}\n${
          blocks.length > 0
            ? [
                `OCR matches for "${query}":`,
                ...blocks.map((block, index) => {
                  const confidence = block.confidence !== null ? ` conf=${block.confidence.toFixed(2)}` : "";
                  return `${index + 1}. "${block.text}"${confidence} box=(${block.x},${block.y},${block.width}x${block.height}) center=(${block.centerX},${block.centerY})`;
                }),
              ].join("\n")
            : `No OCR matches found for "${query}".`
        }`,
      ),
    };
  },
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
