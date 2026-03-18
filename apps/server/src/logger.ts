export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RequestLogger {
  requestId: string;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  debug: (msg: string, data?: Record<string, unknown>) => void;
  /** Attach conversation and role context for all subsequent logs */
  setContext: (context: { conversationId?: string; role?: string }) => void;
}

export interface SystemLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  debug: (msg: string, data?: Record<string, unknown>) => void;
}

/** Minimum log level (configurable via EMBER_LOG_LEVEL env var) */
const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getMinLogLevel(): LogLevel {
  const env = process.env.EMBER_LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVEL_ORDER) return env as LogLevel;
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[getMinLogLevel()];
}

function emit(
  level: "info" | "warn" | "error",
  requestId: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const payload = {
    level,
    requestId,
    msg,
    ts: Date.now(),
    ...(data ?? {}),
  };
  const serialized = JSON.stringify(payload);
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  if (level === "error") {
    console.error(serialized);
    return;
  }
  console.log(serialized);
}

function emitSystem(
  level: LogLevel,
  component: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const payload = {
    level,
    component,
    msg,
    ts: Date.now(),
    time: new Date().toISOString(),
    ...(data ?? {}),
  };
  const serialized = JSON.stringify(payload);
  if (level === "warn") { console.warn(serialized); return; }
  if (level === "error") { console.error(serialized); return; }
  if (level === "debug") { console.debug(serialized); return; }
  console.log(serialized);
}

export function createRequestLogger(requestId: string): RequestLogger {
  let contextData: Record<string, unknown> = {};
  return {
    requestId,
    setContext(context) {
      if (context.conversationId) contextData.conversationId = context.conversationId;
      if (context.role) contextData.role = context.role;
    },
    info(msg, data) {
      emit("info", requestId, msg, { ...contextData, ...data });
    },
    warn(msg, data) {
      emit("warn", requestId, msg, { ...contextData, ...data });
    },
    error(msg, data) {
      emit("error", requestId, msg, { ...contextData, ...data });
    },
    debug(msg, data) {
      if (!shouldLog("debug")) return;
      emit("info", requestId, msg, { ...contextData, level: "debug", ...data });
    },
  };
}

/**
 * System-wide logger for non-request contexts (startup, shutdown, background tasks).
 */
export function createSystemLogger(component: string): SystemLogger {
  return {
    info(msg, data) { emitSystem("info", component, msg, data); },
    warn(msg, data) { emitSystem("warn", component, msg, data); },
    error(msg, data) { emitSystem("error", component, msg, data); },
    debug(msg, data) { emitSystem("debug", component, msg, data); },
  };
}

