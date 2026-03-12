import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { toAppleScriptKeySpec, toLinuxKeyChord, toWindowsSendKeys } from "./keys.js";
import { findOcrTextBlocks, parseTesseractTsv, parseVisionJson, type OcrTextBlock } from "./ocr.js";

export type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";

export interface DesktopCapabilities {
  screenshot: boolean;
  openApplication: boolean;
  focusApplication: boolean;
  openResource: boolean;
  activeWindow: boolean;
  listWindows: boolean;
  ocr: boolean;
  typeText: boolean;
  pressKeys: boolean;
  moveMouse: boolean;
  clickMouse: boolean;
  dragMouse: boolean;
  scrollMouse: boolean;
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
  getActiveWindow(): string;
  listWindows(): string[];
  detectText(filePath: string): OcrTextBlock[];
  findTextOnScreen(filePath: string, query: string, maxResults: number): OcrTextBlock[];
  listOpenApplications(): string[];
  openApplication(application: string): string;
  focusApplication(application: string): string;
  openResource(target: string): string;
  typeText(text: string): string;
  pressKeys(chord: string): string;
  moveMouse(x: number, y: number): string;
  clickMouse(x: number, y: number, button: "left" | "right" | "middle", clicks: number): string;
  dragMouse(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    button: "left" | "right" | "middle",
    steps: number,
  ): string;
  scrollMouse(deltaX: number, deltaY: number, x?: number, y?: number): string;
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
    input?: string;
  } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env,
    input: options.input,
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
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

function splitOutputLines(value: string): string[] {
  return value
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
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

function detectTextWithVision(filePath: string): OcrTextBlock[] {
  const output = assertOk(
    runSwiftScript("macos-ocr.swift", [filePath]),
    `Failed to OCR "${filePath}" with Apple Vision`,
  );
  return parseVisionJson(output);
}

function detectTextWithTesseract(filePath: string): OcrTextBlock[] {
  const output = assertOk(
    runCommand("tesseract", [filePath, "stdout", "--psm", "6", "tsv"]),
    `Failed to OCR "${filePath}" with Tesseract`,
  );
  return parseTesseractTsv(output);
}

function createMacController(): DesktopController {
  const capabilities: DesktopCapabilities = {
    screenshot: commandExists("screencapture"),
    openApplication: commandExists("open"),
    focusApplication: commandExists("osascript"),
    openResource: commandExists("open"),
    activeWindow: commandExists("osascript"),
    listWindows: commandExists("osascript"),
    ocr: commandExists("swift") || commandExists("tesseract"),
    typeText: commandExists("osascript"),
    pressKeys: commandExists("osascript"),
    moveMouse: commandExists("swift"),
    clickMouse: commandExists("swift"),
    dragMouse: commandExists("swift"),
    scrollMouse: commandExists("swift"),
    listOpenApplications: commandExists("osascript"),
    notes: [
      "macOS desktop automation requires Accessibility permission for keystrokes and pointer control.",
      "macOS screenshots require Screen Recording permission if you want to capture other apps.",
      "macOS OCR prefers Apple Vision and falls back to Tesseract when available.",
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
    getActiveWindow() {
      return assertOk(
        runCommand("osascript", [
          "-e",
          'tell application "System Events"',
          "-e",
          "set frontProcess to first application process whose frontmost is true",
          "-e",
          "set processName to name of frontProcess",
          "-e",
          "try",
          "-e",
          "set windowName to name of front window of frontProcess",
          "-e",
          'if windowName is missing value or windowName is "" then set windowName to "(untitled)"',
          "-e",
          "on error",
          "-e",
          'set windowName to "(window unavailable)"',
          "-e",
          "end try",
          "-e",
          'return processName & " :: " & windowName',
          "-e",
          "end tell",
        ]),
        "Failed to read active macOS window",
      );
    },
    listWindows() {
      const output = assertOk(
        runCommand("osascript", [
          "-e",
          "set outputLines to {}",
          "-e",
          'tell application "System Events"',
          "-e",
          "repeat with proc in (every application process whose background only is false)",
          "-e",
          "set processName to name of proc",
          "-e",
          "try",
          "-e",
          "set processWindows to windows of proc",
          "-e",
          "if (count of processWindows) is 0 then",
          "-e",
          'copy (processName & " :: (no window title)") to end of outputLines',
          "-e",
          "else",
          "-e",
          "repeat with win in processWindows",
          "-e",
          "try",
          "-e",
          "set windowName to name of win",
          "-e",
          'if windowName is missing value or windowName is "" then set windowName to "(untitled)"',
          "-e",
          "on error",
          "-e",
          'set windowName to "(untitled)"',
          "-e",
          "end try",
          "-e",
          'copy (processName & " :: " & windowName) to end of outputLines',
          "-e",
          "end repeat",
          "-e",
          "end if",
          "-e",
          "on error",
          "-e",
          'copy (processName & " :: (window list unavailable)") to end of outputLines',
          "-e",
          "end try",
          "-e",
          "end repeat",
          "-e",
          "end tell",
          "-e",
          "set AppleScript's text item delimiters to linefeed",
          "-e",
          "return outputLines as text",
        ]),
        "Failed to list macOS windows",
      );
      return splitOutputLines(output);
    },
    detectText(filePath) {
      if (commandExists("swift")) {
        return detectTextWithVision(filePath);
      }
      if (commandExists("tesseract")) {
        return detectTextWithTesseract(filePath);
      }
      throw new Error("No macOS OCR capability is available. Install Swift or Tesseract.");
    },
    findTextOnScreen(filePath, query, maxResults) {
      const blocks = commandExists("swift")
        ? detectTextWithVision(filePath)
        : commandExists("tesseract")
          ? detectTextWithTesseract(filePath)
          : [];
      if (blocks.length === 0 && !commandExists("swift") && !commandExists("tesseract")) {
        throw new Error("No macOS OCR capability is available. Install Swift or Tesseract.");
      }
      return findOcrTextBlocks(blocks, query, maxResults);
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
    dragMouse(startX, startY, endX, endY, button, steps) {
      assertOk(
        runSwiftScript("macos-pointer.swift", [
          "drag",
          String(startX),
          String(startY),
          String(endX),
          String(endY),
          button,
          String(Math.max(2, Math.floor(steps))),
        ]),
        "Failed to drag mouse",
      );
      return `Dragged ${button} mouse button from (${startX}, ${startY}) to (${endX}, ${endY}).`;
    },
    scrollMouse(deltaX, deltaY, x, y) {
      const args = [
        "scroll",
        String(Math.round(deltaX)),
        String(Math.round(deltaY)),
        x !== undefined ? String(x) : "keep",
        y !== undefined ? String(y) : "keep",
      ];
      assertOk(runSwiftScript("macos-pointer.swift", args), "Failed to scroll mouse");
      return `Scrolled mouse by (${deltaX}, ${deltaY})${x !== undefined && y !== undefined ? ` at (${x}, ${y})` : ""}.`;
    },
  };
}

function createWindowsController(): DesktopController {
  const capabilities: DesktopCapabilities = {
    screenshot: commandExists("powershell"),
    openApplication: commandExists("powershell"),
    focusApplication: commandExists("powershell"),
    openResource: commandExists("powershell"),
    activeWindow: commandExists("powershell"),
    listWindows: commandExists("powershell"),
    ocr: commandExists("tesseract"),
    typeText: commandExists("powershell"),
    pressKeys: commandExists("powershell"),
    moveMouse: commandExists("powershell"),
    clickMouse: commandExists("powershell"),
    dragMouse: commandExists("powershell"),
    scrollMouse: commandExists("powershell"),
    listOpenApplications: commandExists("powershell"),
    notes: [
      "Windows desktop automation requires an interactive logged-in desktop session.",
      "Install Tesseract to enable desktop OCR on Windows.",
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
    getActiveWindow() {
      const output = assertOk(
        powershellCommand([
          'Add-Type @"',
          "using System;",
          "using System.Text;",
          "using System.Runtime.InteropServices;",
          "public static class User32 {",
          '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
          '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
          '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
          "}",
          '"@;',
          "$hwnd = [User32]::GetForegroundWindow();",
          'if ($hwnd -eq [IntPtr]::Zero) { throw "No active window." }',
          "$title = New-Object System.Text.StringBuilder 1024;",
          "[void][User32]::GetWindowText($hwnd, $title, $title.Capacity);",
          "$pid = 0;",
          "[void][User32]::GetWindowThreadProcessId($hwnd, [ref]$pid);",
          "$proc = Get-Process -Id $pid -ErrorAction Stop;",
          '"$($proc.ProcessName) :: $($title.ToString().Trim())"',
        ].join(" ")),
        "Failed to read active Windows window",
      );
      return output || "(active window unavailable)";
    },
    listWindows() {
      const output = assertOk(
        powershellCommand(
          'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne "" } | Sort-Object ProcessName, MainWindowTitle | ForEach-Object { "$($_.ProcessName) :: $($_.MainWindowTitle)" }',
        ),
        "Failed to list Windows windows",
      );
      return splitOutputLines(output);
    },
    detectText(filePath) {
      if (!commandExists("tesseract")) {
        throw new Error("No Windows OCR capability is available. Install Tesseract to enable OCR.");
      }
      return detectTextWithTesseract(filePath);
    },
    findTextOnScreen(filePath, query, maxResults) {
      if (!commandExists("tesseract")) {
        throw new Error("No Windows OCR capability is available. Install Tesseract to enable OCR.");
      }
      return findOcrTextBlocks(detectTextWithTesseract(filePath), query, maxResults);
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
    dragMouse(startX, startY, endX, endY, button, steps) {
      const eventMap: Record<"left" | "right" | "middle", [number, number]> = {
        left: [0x0002, 0x0004],
        right: [0x0008, 0x0010],
        middle: [0x0020, 0x0040],
      };
      const [downFlag, upFlag] = eventMap[button];
      const totalSteps = Math.max(2, Math.floor(steps));
      const moveSteps = Array.from({ length: totalSteps }, (_, index) => {
        const progress = (index + 1) / totalSteps;
        const x = Math.round(startX + (endX - startX) * progress);
        const y = Math.round(startY + (endY - startY) * progress);
        return `[User32]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 12;`;
      }).join(" ");
      const script = [
        'Add-Type @"',
        "using System.Runtime.InteropServices;",
        "public static class User32 {",
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        '  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);',
        "}",
        '"@;',
        `[User32]::SetCursorPos(${Math.round(startX)}, ${Math.round(startY)}) | Out-Null;`,
        `[User32]::mouse_event(${downFlag}, 0, 0, 0, 0);`,
        moveSteps,
        `[User32]::mouse_event(${upFlag}, 0, 0, 0, 0);`,
      ].join(" ");
      assertOk(powershellCommand(script), "Failed to drag mouse");
      return `Dragged ${button} mouse button from (${startX}, ${startY}) to (${endX}, ${endY}).`;
    },
    scrollMouse(deltaX, deltaY, x, y) {
      const script = [
        'Add-Type @"',
        "using System.Runtime.InteropServices;",
        "public static class User32 {",
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        '  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);',
        "}",
        '"@;',
        ...(x !== undefined && y !== undefined ? [`[User32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null;`] : []),
        ...(Math.round(deltaY) !== 0
          ? [`[User32]::mouse_event(0x0800, 0, 0, ${Math.round(deltaY) * 120}, 0);`]
          : []),
        ...(Math.round(deltaX) !== 0
          ? [`[User32]::mouse_event(0x01000, 0, 0, ${Math.round(deltaX) * 120}, 0);`]
          : []),
      ].join(" ");
      assertOk(powershellCommand(script), "Failed to scroll mouse");
      return `Scrolled mouse by (${deltaX}, ${deltaY})${x !== undefined && y !== undefined ? ` at (${x}, ${y})` : ""}.`;
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
    activeWindow: hasXdotool,
    listWindows: commandExists("wmctrl") || hasXdotool,
    ocr: commandExists("tesseract"),
    typeText: hasXdotool,
    pressKeys: hasXdotool,
    moveMouse: hasXdotool,
    clickMouse: hasXdotool,
    dragMouse: hasXdotool,
    scrollMouse: hasXdotool,
    listOpenApplications: commandExists("wmctrl") || hasXdotool,
    notes: [
      "Linux desktop automation depends on the active desktop session and X11/Wayland tooling.",
      "Install xdotool or wmctrl for richer pointer, focus, and window control on Linux.",
      "Install Tesseract to enable desktop OCR on Linux.",
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
    getActiveWindow() {
      if (!commandExists("xdotool")) {
        throw new Error("No Linux active-window capability is available. Install xdotool.");
      }
      const windowId = assertOk(runCommand("xdotool", ["getactivewindow"]), "Failed to query active Linux window");
      const title = assertOk(runCommand("xdotool", ["getwindowname", windowId]), "Failed to query active Linux window title");
      let processName = "linux-window";
      try {
        const pid = assertOk(runCommand("xdotool", ["getwindowpid", windowId]), "Failed to query active Linux window pid");
        processName = assertOk(runCommand("ps", ["-p", pid, "-o", "comm="]), "Failed to query active Linux process name");
      } catch {
        // Window titles are still useful even if process lookup fails.
      }
      return `${processName} :: ${title}`;
    },
    listWindows() {
      if (commandExists("wmctrl")) {
        const output = assertOk(runCommand("wmctrl", ["-lx"]), "Failed to list Linux windows");
        return splitOutputLines(output).map((entry) => {
          const parts = entry.split(/\s+/, 5);
          const windowClass = parts[3] ?? "window";
          const title = parts[4] ?? "(untitled)";
          return `${windowClass} :: ${title}`;
        });
      }
      if (commandExists("xdotool")) {
        const ids = splitOutputLines(
          assertOk(runCommand("xdotool", ["search", "--onlyvisible", "--name", "."]), "Failed to query Linux windows"),
        );
        return ids.map((windowId) => {
          try {
            return assertOk(runCommand("xdotool", ["getwindowname", windowId]), `Failed to read Linux window ${windowId}`);
          } catch {
            return `window ${windowId}`;
          }
        });
      }
      throw new Error("No Linux window listing capability is available.");
    },
    detectText(filePath) {
      if (!commandExists("tesseract")) {
        throw new Error("No Linux OCR capability is available. Install Tesseract to enable OCR.");
      }
      return detectTextWithTesseract(filePath);
    },
    findTextOnScreen(filePath, query, maxResults) {
      if (!commandExists("tesseract")) {
        throw new Error("No Linux OCR capability is available. Install Tesseract to enable OCR.");
      }
      return findOcrTextBlocks(detectTextWithTesseract(filePath), query, maxResults);
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
    dragMouse(startX, startY, endX, endY, button, steps) {
      const buttonMap: Record<"left" | "right" | "middle", string> = {
        left: "1",
        middle: "2",
        right: "3",
      };
      const totalSteps = Math.max(2, Math.floor(steps));
      assertOk(
        runCommand("xdotool", ["mousemove", String(Math.round(startX)), String(Math.round(startY))]),
        "Failed to move mouse",
      );
      assertOk(runCommand("xdotool", ["mousedown", buttonMap[button]]), "Failed to press mouse button");
      for (let index = 1; index <= totalSteps; index += 1) {
        const progress = index / totalSteps;
        const x = Math.round(startX + (endX - startX) * progress);
        const y = Math.round(startY + (endY - startY) * progress);
        assertOk(runCommand("xdotool", ["mousemove", String(x), String(y)]), "Failed to drag mouse");
      }
      assertOk(runCommand("xdotool", ["mouseup", buttonMap[button]]), "Failed to release mouse button");
      return `Dragged ${button} mouse button from (${startX}, ${startY}) to (${endX}, ${endY}).`;
    },
    scrollMouse(deltaX, deltaY, x, y) {
      if (x !== undefined && y !== undefined) {
        assertOk(
          runCommand("xdotool", ["mousemove", String(Math.round(x)), String(Math.round(y))]),
          "Failed to move mouse",
        );
      }
      const horizontalClicks = Math.abs(Math.round(deltaX));
      const verticalClicks = Math.abs(Math.round(deltaY));
      if (verticalClicks > 0) {
        const button = deltaY > 0 ? "4" : "5";
        assertOk(runCommand("xdotool", ["click", "--repeat", String(verticalClicks), button]), "Failed to scroll vertically");
      }
      if (horizontalClicks > 0) {
        const button = deltaX > 0 ? "7" : "6";
        assertOk(runCommand("xdotool", ["click", "--repeat", String(horizontalClicks), button]), "Failed to scroll horizontally");
      }
      return `Scrolled mouse by (${deltaX}, ${deltaY})${x !== undefined && y !== undefined ? ` at (${x}, ${y})` : ""}.`;
    },
  };
}

function createUnsupportedController(): DesktopController {
  const capabilities: DesktopCapabilities = {
    screenshot: false,
    openApplication: false,
    focusApplication: false,
    openResource: false,
    activeWindow: false,
    listWindows: false,
    ocr: false,
    typeText: false,
    pressKeys: false,
    moveMouse: false,
    clickMouse: false,
    dragMouse: false,
    scrollMouse: false,
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
    getActiveWindow: () => unsupported("Reading the active window"),
    listWindows: () => unsupported("Listing windows"),
    detectText: () => unsupported("OCR"),
    findTextOnScreen: () => unsupported("OCR text search"),
    listOpenApplications: () => unsupported("Listing applications"),
    openApplication: () => unsupported("Opening applications"),
    focusApplication: () => unsupported("Focusing applications"),
    openResource: () => unsupported("Opening resources"),
    typeText: () => unsupported("Typing text"),
    pressKeys: () => unsupported("Pressing keys"),
    moveMouse: () => unsupported("Moving the mouse"),
    clickMouse: () => unsupported("Clicking the mouse"),
    dragMouse: () => unsupported("Dragging the mouse"),
    scrollMouse: () => unsupported("Scrolling the mouse"),
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
