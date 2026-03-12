import readline from "node:readline";
import type { WriteStream } from "node:tty";

export type DashboardServiceStatus = "starting" | "running" | "stopping" | "error" | "down";

export interface DashboardServiceState {
  status: DashboardServiceStatus;
  url: string;
  host: string;
  pid: number | null;
}

export interface DashboardMcpState {
  configuredServers: number;
  runningServers: number;
  activeTools: number;
  activeCalls: number;
  drainingServers: number;
}

export interface DashboardSnapshot {
  mode: string;
  startedAt: string | null;
  runtime: DashboardServiceState;
  web: DashboardServiceState;
  mcp: DashboardMcpState;
  tools: {
    codexAvailable: boolean;
    claudeAvailable: boolean;
    verboseStartup: boolean;
  };
  activity: {
    merged: string[];
    server: string[];
    web: string[];
  };
  logs: {
    serverPath: string;
    webPath: string;
  };
}

interface DashboardPalette {
  reset: string;
  bold: string;
  dim: string;
  cyan: string;
  green: string;
  yellow: string;
  red: string;
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function createPalette(color: boolean): DashboardPalette {
  if (!color) {
    return {
      reset: "",
      bold: "",
      dim: "",
      cyan: "",
      green: "",
      yellow: "",
      red: "",
    };
  }

  return {
    reset: "\u001b[0m",
    bold: "\u001b[1m",
    dim: "\u001b[2m",
    cyan: "\u001b[36m",
    green: "\u001b[32m",
    yellow: "\u001b[33m",
    red: "\u001b[31m",
  };
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function fitLine(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const plain = stripAnsi(text);
  if (plain.length > width) {
    if (width === 1) {
      return plain.slice(0, 1);
    }
    return `${plain.slice(0, width - 1)}~`;
  }
  return `${text}${" ".repeat(width - plain.length)}`;
}

function makeSeparator(width: number, palette: DashboardPalette): string {
  return `${palette.dim}${"-".repeat(Math.max(1, width))}${palette.reset}`;
}

function buildTopBorder(title: string, innerWidth: number): string {
  const label = ` ${title.trim()} `;
  const plainLabel = stripAnsi(label);
  if (plainLabel.length >= innerWidth) {
    return `+${fitLine(label, innerWidth)}+`;
  }
  return `+${label}${"-".repeat(innerWidth - plainLabel.length)}+`;
}

function formatDuration(startedAt: string | null, now = new Date()): string {
  if (!startedAt) {
    return "00:00:00";
  }
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) {
    return "00:00:00";
  }
  const totalSeconds = Math.max(0, Math.floor((now.getTime() - started.getTime()) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function statusColor(status: DashboardServiceStatus, palette: DashboardPalette): string {
  switch (status) {
    case "running":
      return palette.green;
    case "starting":
    case "stopping":
      return palette.yellow;
    case "error":
      return palette.red;
    default:
      return palette.dim;
  }
}

function serviceToken(status: DashboardServiceStatus, palette: DashboardPalette): string {
  return `${statusColor(status, palette)}[${status.toUpperCase()}]${palette.reset}`;
}

function mcpToken(mcp: DashboardMcpState, palette: DashboardPalette): string {
  const status =
    mcp.configuredServers === 0 ? "down" : mcp.runningServers > 0 ? "running" : "starting";
  return serviceToken(status, palette);
}

function buildBox(title: string, width: number, bodyLines: string[], bodyHeight: number): string[] {
  const innerWidth = Math.max(8, width - 2);
  const top = buildTopBorder(title, innerWidth);
  const lines = bodyLines.slice(-bodyHeight);
  while (lines.length < bodyHeight) {
    lines.unshift("");
  }

  return [
    top,
    ...lines.map((line) => `|${fitLine(line, innerWidth)}|`),
    `+${"-".repeat(innerWidth)}+`,
  ];
}

function mergeColumns(left: string[], right: string[], gap: number): string[] {
  const height = Math.max(left.length, right.length);
  const leftWidth = stripAnsi(left[0] ?? "").length;
  const rightWidth = stripAnsi(right[0] ?? "").length;
  const rows: string[] = [];

  for (let index = 0; index < height; index += 1) {
    const leftLine = fitLine(left[index] ?? "", leftWidth);
    const rightLine = fitLine(right[index] ?? "", rightWidth);
    rows.push(`${leftLine}${" ".repeat(gap)}${rightLine}`);
  }
  return rows;
}

function buildServiceLines(snapshot: DashboardSnapshot, palette: DashboardPalette): string[] {
  return [
    `runtime  ${serviceToken(snapshot.runtime.status, palette)} ${snapshot.runtime.url}`,
    `web ui   ${serviceToken(snapshot.web.status, palette)} ${snapshot.web.url}`,
    `runtime host ${snapshot.runtime.host}  pid ${snapshot.runtime.pid ?? "n/a"}`,
    `web host     ${snapshot.web.host}  pid ${snapshot.web.pid ?? "n/a"}`,
    `uptime       ${formatDuration(snapshot.startedAt)}`,
  ];
}

function buildAgentLines(snapshot: DashboardSnapshot, palette: DashboardPalette): string[] {
  return [
    `mcp     ${mcpToken(snapshot.mcp, palette)} ${snapshot.mcp.runningServers}/${snapshot.mcp.configuredServers} servers`,
    `tools   ${snapshot.mcp.activeTools} loaded  active calls ${snapshot.mcp.activeCalls}`,
    `drain   ${snapshot.mcp.drainingServers} draining`,
    `codex   ${snapshot.tools.codexAvailable ? "available" : "missing"}`,
    `claude  ${snapshot.tools.claudeAvailable ? "available" : "missing"}`,
  ];
}

function buildFooter(snapshot: DashboardSnapshot): string[] {
  return [
    `Ctrl+C stop | runtime ${snapshot.runtime.url} | web ${snapshot.web.url}`,
    `logs ${snapshot.logs.serverPath} ${snapshot.logs.webPath}`,
    snapshot.tools.verboseStartup
      ? "Verbose child logs are enabled via EMBER_VERBOSE_STARTUP=1"
      : "Set EMBER_VERBOSE_STARTUP=1 to mirror raw child logs",
  ];
}

export function renderDashboard(
  snapshot: DashboardSnapshot,
  options: {
    columns: number;
    rows: number;
    color?: boolean;
  },
): string {
  const columns = Math.max(72, options.columns);
  const rows = Math.max(18, options.rows);
  const palette = createPalette(Boolean(options.color));
  const title = `${palette.bold}${palette.cyan}EMBER DASHBOARD${palette.reset}`;
  const meta = `${palette.dim}mode${palette.reset} ${snapshot.mode}  ${palette.dim}uptime${palette.reset} ${formatDuration(snapshot.startedAt)}  ${palette.dim}mcp${palette.reset} ${snapshot.mcp.runningServers}/${snapshot.mcp.configuredServers}`;
  const header = fitLine(`${title}  ${meta}`, columns);
  const headerSeparator = makeSeparator(columns, palette);

  const footerLines = buildFooter(snapshot).map((line) => fitLine(line, columns));
  const summaryHeight = 5;
  const bodyBudget = Math.max(6, rows - 2 - footerLines.length);
  const serviceLines = buildServiceLines(snapshot, palette);
  const agentLines = buildAgentLines(snapshot, palette);

  let layout: string[] = [];
  if (columns >= 110) {
    const leftWidth = Math.floor((columns - 2) / 2);
    const rightWidth = columns - leftWidth - 2;
    const servicesBox = buildBox("Services", leftWidth, serviceLines, summaryHeight);
    const agentBox = buildBox("Agent", rightWidth, agentLines, summaryHeight);
    layout = mergeColumns(servicesBox, agentBox, 2);
  } else {
    layout = [
      ...buildBox("Services", columns, serviceLines, summaryHeight),
      ...buildBox("Agent", columns, agentLines, summaryHeight),
    ];
  }

  const remaining = Math.max(5, bodyBudget - layout.length);
  const logBodyHeight = Math.max(3, remaining - 2);

  let activitySection: string[];
  if (columns >= 120) {
    const leftWidth = Math.floor((columns - 2) / 2);
    const rightWidth = columns - leftWidth - 2;
    const serverBox = buildBox("Server Activity", leftWidth, snapshot.activity.server, logBodyHeight);
    const webBox = buildBox("Web Activity", rightWidth, snapshot.activity.web, logBodyHeight);
    activitySection = mergeColumns(serverBox, webBox, 2);
  } else {
    const mergedActivity = snapshot.activity.merged.length > 0
      ? snapshot.activity.merged
      : ["Waiting for activity..."];
    activitySection = buildBox("Activity", columns, mergedActivity, logBodyHeight);
  }

  return [
    header,
    headerSeparator,
    ...layout,
    ...activitySection,
    ...footerLines,
  ].join("\n");
}

export class TerminalDashboard {
  private snapshot: DashboardSnapshot;
  private active = false;
  private tickHandle: NodeJS.Timeout | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor(
    initialSnapshot: DashboardSnapshot,
    private readonly stdout: WriteStream = process.stdout,
  ) {
    this.snapshot = initialSnapshot;
  }

  start(): void {
    if (this.active || !this.stdout.isTTY) {
      return;
    }
    this.active = true;
    this.stdout.write("\u001b[?1049h\u001b[?25l");
    this.render();
    this.tickHandle = setInterval(() => this.render(), 1_000);
    this.tickHandle.unref?.();
    this.resizeHandler = () => this.render();
    this.stdout.on("resize", this.resizeHandler);
  }

  setSnapshot(snapshot: DashboardSnapshot): void {
    this.snapshot = snapshot;
    if (this.active) {
      this.render();
    }
  }

  stop(finalMessage?: string): void {
    if (!this.active) {
      if (finalMessage) {
        this.stdout.write(`${finalMessage}\n`);
      }
      return;
    }
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.resizeHandler) {
      this.stdout.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    this.stdout.write("\u001b[?25h\u001b[?1049l");
    this.active = false;
    if (finalMessage) {
      this.stdout.write(`${finalMessage}\n`);
    }
  }

  private render(): void {
    if (!this.active) {
      return;
    }
    const output = renderDashboard(this.snapshot, {
      columns: this.stdout.columns ?? 120,
      rows: this.stdout.rows ?? 30,
      color: true,
    });
    readline.cursorTo(this.stdout, 0, 0);
    readline.clearScreenDown(this.stdout);
    this.stdout.write(output);
  }
}
