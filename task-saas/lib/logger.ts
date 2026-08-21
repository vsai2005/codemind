type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

function createLogEntry(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(context ? { context } : {}),
  };
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.NODE_ENV === "development") {
      console.debug(JSON.stringify(createLogEntry("debug", message, context)));
    }
  },
  info(message: string, context?: Record<string, unknown>): void {
    console.info(JSON.stringify(createLogEntry("info", message, context)));
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(JSON.stringify(createLogEntry("warn", message, context)));
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(JSON.stringify(createLogEntry("error", message, context)));
  },
};
