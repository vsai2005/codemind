type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Values that must never appear in a log line, whatever produced them.
 *
 * Redaction happens here — at the single point every log passes through — rather than
 * at each call site. Provider SDKs and Prisma both embed credentials in error messages
 * (Prisma puts the whole DATABASE_URL, password included, into some connection
 * errors), and relying on ~20 call sites to remember to scrub is a rule a future edit
 * will eventually forget.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /nvapi-[A-Za-z0-9_-]+/g,
  /Bearer\s+\S+/gi,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /AIza[A-Za-z0-9_-]{10,}/g,
  // Database / broker connection strings.
  /\b(?:postgres|postgresql|mysql|mongodb)(?:\+srv)?:\/\/[^\s"'\\]+/gi,
  // Bare user:password@host credentials appearing without a scheme.
  /\b[A-Za-z0-9._%-]+:[^\s:@/"']{4,}@[A-Za-z0-9.-]+/g,
];

const REDACTED = "[redacted]";

/** Strip anything credential-shaped from a string. No truncation. */
export function redactSecrets(text: string): string {
  let safe = text;
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, REDACTED);
  }
  return safe;
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

/** Serialize, then redact the whole line so nested context values are covered too. */
function emit(level: LogLevel, message: string, context?: Record<string, unknown>): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(createLogEntry(level, message, context));
  } catch {
    // A context object holding a circular reference must not break logging.
    serialized = JSON.stringify(
      createLogEntry(level, message, { note: "unserializable context" })
    );
  }
  return redactSecrets(serialized);
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.NODE_ENV === "development") {
      console.debug(emit("debug", message, context));
    }
  },
  info(message: string, context?: Record<string, unknown>): void {
    console.info(emit("info", message, context));
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(emit("warn", message, context));
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(emit("error", message, context));
  },
};
