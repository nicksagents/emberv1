import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { toAppleScriptKeySpec, toLinuxKeyChord, toWindowsSendKeys } from "./keys.js";

export type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";

export interface DesktopCapabilities {
  screenshot: boolean;
  openApplication: boolean;
  focusApplication: boolean;
  openResource: boolean;
  typeText: boolean;
  pressKeys: boolean;
  moveMouse: boolean;
  clickMouse: boolean;
  listOpenApplications: boolean;
  notes: string[];
}

export interface ScreenshotResult {
  filePath: string;
  imageBase64: string;
  imageMimeType: "image/png";
}

export interface DesktopController {
  platform: DesktopPlatform;
  capabilities: DesktopCapabilities;
  describeEnvironment(): string;
  takeScreenshot(filePath: string): ScreenshotResult;
  listOpenApplications(): string[];
  openApplication(application: string): string;
  focusApplication(application: string): string;
  openResource(target: string): string;
  typeText(text: string): string;
  pressKeys(chord: string): string;
  moveMouse(x: number, y: number): string;
  clickMouse(x: number, y: number, button: "left" | "right" | "middle", clicks: number): string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
  } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertOk(result: CommandResult, action: string): string {
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail ? `${action}: ${detail}` : action);
  }
  return result.stdout.trim();
}

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolvePlatform(): DesktopPlatform {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function formatCapabilitySummary(platform: DesktopPlatform, capabilities: DesktopCapabilities): string {
  const entries = Object.entries(capabilities)
    .filter(([key, value]) => key !== "notes" && typeof value === "boolean")
    .map(([key, value]) => `${key}=${value ? "yes" : "no"}`);
  const notes = capabilities.notes.length > 0 ? `\nnotes:\n- ${capabilities.notes.join("\n- ")}` : "";
  return `platform: ${platform}\ncapabilities: ${entries.join(", ")}${notes}`;
}

function readPngBase64(filePath: string): ScreenshotResult {
  const imageBase64 = readFileSync(filePath).toString("base64");
  return {
    filePath,
    imageBase64,
    imageMimeType: "image/png",
  };
}

function powershellCommand(command: string): CommandResult {
  return runCommand("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]);
}

function powershellQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function swiftEnv(): NodeJS.ProcessEnv {
  const cacheRoot = path.join(tmpdir(), "ember-swift-cache");
  mkdirSync(cacheRoot, { recursive: true });
  return {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: cacheRoot,
    SWIFT_MODULE_CACHE_PATH: cacheRoot,
  };
}

function runSwiftScript(scriptName: string, args: string[]): CommandResult {
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", scriptName);
  return runCommand("swift", [scriptPath, ...args], { env: swiftEnv() });
}

function createMacController(): DesktopController {
  const capabilities: DesktopCapabilities = {
    screenshot: commandExists("screencapture"),
    openApplication: commandExists("open"),
    focusApplication: commandExists("osascript"),
    openResource: commandExists("open"),
    typeText: commandExists("osascript"),
    pressKeys: commandExists("osascript"),
    moveMouse: commandExists("swift"),
    clickMouse: commandExists("swift"),
    listOpenApplications: commandExists("osascript"),
    notes: [
      "macOS desktop automation requires Accessibility permission for keystrokes and pointer control.",
      "macOS screenshots require Screen Recording permission if you want to capture other apps.",
    ],
  };

  return {
    platform: "macos",
    capabilities,
    describeEnvironment: () => formatCapabilitySummary("macos", capabilities),
    takeScreenshot(filePath) {
      ensureParentDirectory(filePath);
      assertOk(runCommand("screencapture", ["-x", "-t", "png", filePath]), "Failed to take macOS screenshot");
      return readPngBase64(filePath);
    },
    listOpenApplications() {
      const output = assertOk(
        runCommand("osascript", [
          "-e",
          'tell application "System Events" to get name of every application process whose background only is false',
        ]),
        "Failed to list macOS applications",
      );
      return output
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    openApplication(application) {
      assertOk(runCommand("open", ["-a", application]), `Failed to open application "${application}"`);
      return `Opened application "${application}".`;
    },
    focusApplication(application) {
      assertOk(
        runCommand("osascript", [
          "-e",
          "on run argv",
          "-e",
          'tell application (item 1 of argv) to activate',
          "-e",
          "end run",
          "--",
          application,
        ]),
        `Failed to focus application "${application}"`,
      );
      return `Focused application "${application}".`;
    },
    openResource(target) {
      assertOk(runCommand("open", [target]), `Failed to open resource "${target}"`);
      return `Opened "${target}".`;
    },
    typeText(text) {
      assertOk(
        runCommand("osascript", [
          "-e",
          "on run argv",
          "-e",
          'tell application "System Events" to keystroke item 1 of argv',
          "-e",
          "end run",
          "--",
          text,
        ]),
        "Failed to type text via macOS System Events",
      );
      return `Typed ${text.length} characters.`;
    },
    pressKeys(chord) {
      const spec = toAppleScriptKeySpec(chord);
      const modifierClause = spec.modifiers.length > 0 ? ` using {${spec.modifiers.join(", ")}}` : "";
      const args = spec.kind === "keystroke"
        ? [
            "-e",
            "on run argv",
            "-e",
            `tell application "System Events" to keystroke item 1 of argv${modifierClause}`,
            "-e",
            "end run",
            "--",
            String(spec.value),
          ]
        : [
            "-e",
            `tell application "System Events" to key code ${spec.value}${modifierClause}`,
          ];
      assertOk(runCommand("osascript", args), `Failed to press key chord "${chord}"`);
      return `Pressed "${chord}".`;
    },
    moveMouse(x, y) {
      assertOk(runSwiftScript("macos-pointer.swift", ["move", String(x), String(y)]), "Failed to move mouse");
      return `Moved mouse to (${x}, ${y}).`;
    },
    clickMouse(x, y, button, clicks) {
      assertOk(
        runSwiftScript("macos-pointer.swift", ["click", String(x), String(y), button, String(clicks)]),
        "Failed to click mouse",
      );
      return `Clicked ${button} mouse button at (${x}, ${y}) x${clicks}.`;
    },
  };
}

function createWindowsController(): DesktopController {
  const capabilities: DesktopCapabilities = {
    screenshot: commandExists("powershell"),
    openApplication: commandExists("powershell"),
    focusApplication: commandExists("powershell"),
    openResource: commandExists("powershell"),
    typeText: commandExists("powershell"),
    pressKeys: commandExists("powershell"),
    moveMouse: commandExists("powershell"),
    clickMouse: commandExists("powershell"),
    listOpenApplications: commandExists("powershell"),
    notes: [
      "Windows desktop automation requires an interactive logged-in desktop session.",
    ],
  };

  return {
    platform: "windows",
    capabilities,
    describeEnvironment: () => formatCapabilitySummary("windows", capabilities),
    takeScreenshot(filePath) {
      ensureParentDirectory(filePath);
      const command = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "Add-Type -AssemblyName System.Drawing;",
        `$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;`,
        "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;",
        "$graphics = [System.Drawing.Graphics]::FromImage($bitmap);",
        "$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);",
        `$bitmap.Save(${powershellQuoted(filePath)}, [System.Drawing.Imaging.ImageFormat]::Png);`,
        "$graphics.Dispose();",
        "$bitmap.Dispose();",
      ].join(" ");
      assertOk(powershellCommand(command), "Failed to take Windows screenshot");
      return readPngBase64(filePath);
    },
    listOpenApplications() {
      const output = assertOk(
        powershellCommand(
          "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty ProcessName",
        ),
        "Failed to list Windows applications",
      );
      return output
        .split(/\r?\n/g)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    openApplication(application) {
      assertOk(
        powershellCommand(`Start-Process ${powershellQuoted(application)}`),
        `Failed to open application "${application}"`,
      );
      return `Opened application "${application}".`;
    },
    focusApplication(application) {
      assertOk(
        powershellCommand(
          `$shell = New-Object -ComObject WScript.Shell; [void]$shell.AppActivate(${powershellQuoted(application)})`,
        ),
        `Failed to focus application "${application}"`,
      );
      return `Focused application "${application}".`;
    },
    openResource(target) {
      assertOk(
        powershellCommand(`Start-Process ${powershellQuoted(target)}`),
        `Failed to open resource "${target}"`,
      );
      return `Opened "${target}".`;
    },
    typeText(text) {
      assertOk(
        powershellCommand(
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${powershellQuoted(text)})`,
        ),
        "Failed to type text via Windows SendKeys",
      );
      return `Typed ${text.length} characters.`;
    },
    pressKeys(chord) {
      assertOk(
        powershellCommand(
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${powershellQuoted(toWindowsSendKeys(chord))})`,
        ),
        `Failed to press key chord "${chord}"`,
      );
      return `Pressed "${chord}".`;
    },
    moveMouse(x, y) {
      const script = [
        'Add-Type @"',
        "using System.Runtime.InteropServices;",
        "public static class User32 {",
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        "}",
        '"@;',
        `[User32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null;`,
      ].join(" ");
      assertOk(powershellCommand(script), "Failed to move mouse");
      return `Moved mouse to (${x}, ${y}).`;
    },
    clickMouse(x, y, button, clicks) {
      const eventMap: Record<"left" | "right" | "middle", [number, number]> = {
        left: [0x0002, 0x0004],
        right: [0x0008, 0x0010],
        middle: [0x0020, 0x0040],
      };
      const [downFlag, upFlag] = eventMap[button];
      const script = [
        'Add-Type @"',
        "using System.Runtime.InteropServices;",
        "public static class User32 {",
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        '  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);',
        "}",
        '"@;',
        `[User32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null;`,
        ...Array.from({ length: Math.max(1, Math.floor(clicks)) }, () =>
          `[User32]::mouse_event(${downFlag}, 0, 0, 0, 0); [User32]::mouse_event(${upFlag}, 0, 0, 0, 0);`,
        ),
      ].join(" ");
      assertOk(powershellCommand(script), "Failed to click mouse");
      return `Clicked ${button} mouse button at (${x}, ${y}) x${clicks}.`;
    },
  };
}

function linuxScreenshotCommand(filePath: string): [string, string[]] | null {
  if (commandExists("gnome-screenshot")) {
    return ["gnome-screenshot", ["-f", filePath]];
  }
  if (commandExists("scrot")) {
    return ["scrot", [filePath]];
  }
  if (commandExists("import")) {
    return ["import", ["-window", "root", filePath]];
  }
  return null;
}

function createLinuxController(): DesktopController {
  const screenshotCommand = linuxScreenshotCommand("/tmp/ember-screenshot-probe.png");
  const hasXdotool = commandExists("xdotool");
  const capabilities: DesktopCapabilities = {
    screenshot: screenshotCommand !== null,
    openApplication: true,
    focusApplication: hasXdotool || commandExists("wmctrl"),
    openResource: commandExists("xdg-open"),
    typeText: hasXdotool,
    pressKeys: hasXdotool,
    moveMouse: hasXdotool,
    clickMouse: hasXdotool,
    listOpenApplications: commandExists("wmctrl") || hasXdotool,
    notes: [
      "Linux desktop automation depends on the active desktop session and X11/Wayland tooling.",
      "Install xdotool or wmctrl for richer pointer, focus, and window control on Linux.",
    ],
  };

  return {
    platform: "linux",
    capabilities,
    describeEnvironment: () => formatCapabilitySummary("linux", capabilities),
    takeScreenshot(filePath) {
      const command = linuxScreenshotCommand(filePath);
      if (!command) {
        throw new Error("No Linux screenshot command is available. Install gnome-screenshot, scrot, or ImageMagick import.");
      }
      ensureParentDirectory(filePath);
      assertOk(runCommand(command[0], command[1]), "Failed to take Linux screenshot");
      return readPngBase64(filePath);
    },
    listOpenApplications() {
      if (commandExists("wmctrl")) {
        const output = assertOk(runCommand("wmctrl", ["-lx"]), "Failed to list Linux windows");
        return output
          .split(/\r?\n/g)
          .map((entry) => entry.trim().split(/\s+/, 5).slice(2).join(" ").trim())
          .filter(Boolean);
      }
      if (commandExists("xdotool")) {
        const output = assertOk(runCommand("xdotool", ["search", "--onlyvisible", "--name", "."]), "Failed to query Linux windows");
        return output.split(/\r?\n/g).map((entry) => entry.trim()).filter(Boolean);
      }
      throw new Error("No Linux window listing capability is available.");
    },
    openApplication(application) {
      spawnDetached(application, []);
      return `Opened application "${application}".`;
    },
    focusApplication(application) {
      if (commandExists("wmctrl")) {
        assertOk(runCommand("wmctrl", ["-xa", application]), `Failed to focus application "${application}"`);
        return `Focused application "${application}".`;
      }
      if (commandExists("xdotool")) {
        assertOk(
          runCommand("xdotool", ["search", "--name", application, "windowactivate"]),
          `Failed to focus application "${application}"`,
        );
        return `Focused application "${application}".`;
      }
      throw new Error("No Linux focus capability is available.");
    },
    openResource(target) {
      spawnDetached("xdg-open", [target]);
      return `Opened "${target}".`;
    },
    typeText(text) {
      assertOk(runCommand("xdotool", ["type", "--delay", "12", text]), "Failed to type text on Linux");
      return `Typed ${text.length} characters.`;
    },
    pressKeys(chord) {
      assertOk(runCommand("xdotool", ["key", toLinuxKeyChord(chord)]), `Failed to press key chord "${chord}"`);
      return `Pressed "${chord}".`;
    },
    moveMouse(x, y) {
      assertOk(runCommand("xdotool", ["mousemove", String(Math.round(x)), String(Math.round(y))]), "Failed to move mouse");
      return `Moved mouse to (${x}, ${y}).`;
    },
    clickMouse(x, y, button, clicks) {
      const buttonMap: Record<"left" | "right" | "middle", string> = {
        left: "1",
        middle: "2",
        right: "3",
      };
      assertOk(runCommand("xdotool", ["mousemove", String(Math.round(x)), String(Math.round(y))]), "Failed to move mouse");
      assertOk(
        runCommand("xdotool", ["click", "--repeat", String(Math.max(1, Math.floor(clicks))), buttonMap[button]]),
        "Failed to click mouse",
      );
      return `Clicked ${button} mouse button at (${x}, ${y}) x${clicks}.`;
    },
  };
}

function createUnsupportedController(): DesktopController {
  const capabilities: DesktopCapabilities = {
    screenshot: false,
    openApplication: false,
    focusApplication: false,
    openResource: false,
    typeText: false,
    pressKeys: false,
    moveMouse: false,
    clickMouse: false,
    listOpenApplications: false,
    notes: ["This operating system is not supported by the bundled desktop MCP server."],
  };
  const unsupported = (action: string) => {
    throw new Error(`${action} is not supported on this operating system.`);
  };
  return {
    platform: "unknown",
    capabilities,
    describeEnvironment: () => formatCapabilitySummary("unknown", capabilities),
    takeScreenshot: () => unsupported("Screenshot"),
    listOpenApplications: () => unsupported("Listing applications"),
    openApplication: () => unsupported("Opening applications"),
    focusApplication: () => unsupported("Focusing applications"),
    openResource: () => unsupported("Opening resources"),
    typeText: () => unsupported("Typing text"),
    pressKeys: () => unsupported("Pressing keys"),
    moveMouse: () => unsupported("Moving the mouse"),
    clickMouse: () => unsupported("Clicking the mouse"),
  };
}

export function resolveDesktopController(): DesktopController {
  switch (resolvePlatform()) {
    case "macos":
      return createMacController();
    case "windows":
      return createWindowsController();
    case "linux":
      return createLinuxController();
    default:
      return createUnsupportedController();
  }
}

export function defaultScreenshotPath(cwd = process.cwd()): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, "data", "desktop", `desktop-${timestamp}.png`);
}
