import { format } from "node:util";
import { redactSecrets } from "./errors.js";

const SERVICE = "cursor-sdk2api";
const CONSOLE_LINE_LIMIT = 4_000;

const BLOCKED_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api_key",
  "apikey",
  "token",
  "secret",
  "password",
  "content",
  "text",
  "thinking",
  "input",
  "args",
  "result",
  "prompt",
  "system",
  "messages",
  "email",
  "useremail",
]);

export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Receives each already-sanitized JSON log line, e.g. the daily log file. */
export interface LogSink {
  write(line: string): void;
}

// Set while the logger prints, so captureConsole does not record the same line twice.
let loggerPrinting = false;

export function createLogger(level = "info", options: { sink?: LogSink } = {}): Logger {
  const ranks: Record<string, number> = { info: 0, warn: 1, error: 2 };
  const minimum = ranks[level.toLowerCase()] ?? ranks.info!;
  const write = (severity: string, fields: Record<string, unknown>, message: string) => {
    if ((ranks[severity] ?? ranks.info!) < minimum) return;
    const safe = sanitize(fields) as Record<string, unknown>;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: severity,
      msg: message,
      service: SERVICE,
      ...safe,
    });
    loggerPrinting = true;
    try {
      if (severity === "error") console.error(line);
      else if (severity === "warn") console.warn(line);
      else console.log(line);
    } finally {
      loggerPrinting = false;
    }
    options.sink?.write(line);
  };
  return {
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
    error: (fields, message) => write("error", fields, message),
  };
}

/**
 * Mirrors third-party `console.warn` / `console.error` output (for example SDK
 * diagnostics) into the sink after secret redaction and truncation. The
 * original console output is unchanged. Returns a function that restores it.
 */
export function captureConsole(sink: LogSink): () => void {
  const original = { warn: console.warn, error: console.error };
  const wrap = (severity: "warn" | "error") =>
    (...args: unknown[]): void => {
      original[severity].apply(console, args);
      if (loggerPrinting) return;
      try {
        const text = redactSecrets(format(...args));
        sink.write(
          JSON.stringify({
            time: new Date().toISOString(),
            level: severity,
            msg: text.length > CONSOLE_LINE_LIMIT ? `${text.slice(0, CONSOLE_LINE_LIMIT)}…` : text,
            service: SERVICE,
            source: "console",
          }),
        );
      } catch {
        // logging must never break the caller
      }
    };
  console.warn = wrap("warn");
  console.error = wrap("error");
  return () => {
    console.warn = original.warn;
    console.error = original.error;
  };
}

/** Records uncaught exceptions before Node's default crash handling runs. */
export function installCrashLogging(logger: Logger): () => void {
  const monitor = (error: unknown, origin: string) => {
    const err = error instanceof Error ? error : undefined;
    logger.error(
      {
        origin,
        error: err ? err.message : String(error),
        stack: err?.stack?.slice(0, CONSOLE_LINE_LIMIT),
      },
      "uncaught exception",
    );
  };
  process.on("uncaughtExceptionMonitor", monitor);
  return () => {
    process.off("uncaughtExceptionMonitor", monitor);
  };
}

export function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (BLOCKED_KEYS.has(key.toLowerCase())) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitize(nested);
    }
    return out;
  }
  return value;
}

export function assertNoSecretLeak(text: string, canaries: string[]): void {
  for (const canary of canaries) {
    if (canary && text.includes(canary)) {
      throw new Error("secret canary leaked into log or response");
    }
  }
}
