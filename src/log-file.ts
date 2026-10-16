import {
  chmodSync,
  closeSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "./core/lineage-store.js";
import { redactSecrets } from "./errors.js";
import { sanitize, type LogSink } from "./log.js";

export const LOG_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^gateway-(\d{4}-\d{2}-\d{2})\.log$/;
const TAIL_BYTES = 512 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export interface LogFileEntry {
  time?: string;
  level: "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
}

export interface LogFileRead {
  entries: LogFileEntry[];
  next_offset: number;
}

export interface LogFileInfo {
  date: string;
  size: number;
}

/** Local calendar date (process time zone) as YYYY-MM-DD. */
export function localLogDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * One owner-only JSON-lines file per local day: `<dir>/gateway-YYYY-MM-DD.log`.
 * Writes are synchronous so a crash still leaves its last line on disk. A write
 * failure disables the file sink instead of taking the gateway down.
 */
export class DailyLogFile implements LogSink {
  readonly dir: string;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private fd: number | undefined;
  private date: string | undefined;
  private disabled = false;

  constructor(options: { dir: string; retentionDays: number; now?: () => Date }) {
    this.dir = options.dir;
    this.retentionDays = Math.max(1, Math.floor(options.retentionDays));
    this.now = options.now ?? (() => new Date());
    ensurePrivateDir(this.dir);
    this.prune();
  }

  currentDate(): string {
    return localLogDate(this.now());
  }

  write(line: string): void {
    if (this.disabled) return;
    try {
      const today = this.currentDate();
      if (this.fd === undefined || today !== this.date) this.open(today);
      writeSync(this.fd!, line.endsWith("\n") ? line : `${line}\n`);
    } catch (error) {
      this.fail(error);
    }
  }

  list(): LogFileInfo[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const files: LogFileInfo[] = [];
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (!match) continue;
      try {
        files.push({ date: match[1]!, size: statSync(join(this.dir, name)).size });
      } catch {
        // removed between readdir and stat
      }
    }
    return files.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  /**
   * Without `offset`, returns the tail of that day's file. With `offset`, returns
   * whole lines appended since then; an offset past the end (file replaced)
   * restarts from the beginning.
   */
  read(date: string, offset?: number): LogFileRead {
    if (!LOG_DATE_RE.test(date)) throw new Error("invalid log date");
    const path = this.pathFor(date);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { entries: [], next_offset: 0 };
    }
    const tail = offset === undefined;
    const start = tail ? Math.max(0, size - TAIL_BYTES) : offset > size ? 0 : offset;
    const end = tail ? size : Math.min(size, start + CHUNK_BYTES);
    if (end <= start) return { entries: [], next_offset: start };

    const buffer = Buffer.alloc(end - start);
    const fd = openSync(path, "r");
    let read = 0;
    try {
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, start + read);
        if (n === 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    const bytes = buffer.subarray(0, read);
    const lastNewline = bytes.lastIndexOf(NEWLINE);
    // Stop at the last full line unless this chunk reaches the end of the file.
    const consumed = start + read < size && lastNewline >= 0 ? lastNewline + 1 : bytes.length;
    let from = 0;
    if (tail && start > 0) {
      const firstNewline = bytes.indexOf(NEWLINE);
      from = firstNewline >= 0 ? firstNewline + 1 : bytes.length;
    }
    const entries = bytes
      .subarray(from, consumed)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(parseLogLine);
    return { entries, next_offset: start + consumed };
  }

  prune(): void {
    const today = this.now();
    const cutoff = localLogDate(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - (this.retentionDays - 1)),
    );
    for (const file of this.list()) {
      if (file.date >= cutoff) continue;
      try {
        unlinkSync(this.pathFor(file.date));
      } catch {
        // best-effort
      }
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
    this.fd = undefined;
  }

  private pathFor(date: string): string {
    return join(this.dir, `gateway-${date}.log`);
  }

  private open(date: string): void {
    const rolled = this.date !== undefined && this.date !== date;
    this.close();
    ensurePrivateDir(this.dir);
    const path = this.pathFor(date);
    this.fd = openSync(path, "a", 0o600);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort on filesystems without POSIX modes
    }
    this.date = date;
    if (rolled) this.prune();
  }

  private fail(error: unknown): void {
    this.disabled = true;
    this.close();
    const message = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(
        `${JSON.stringify({
          time: new Date().toISOString(),
          level: "error",
          msg: "log file disabled",
          service: "cursor-sdk2api",
          error: redactSecrets(message),
        })}\n`,
      );
    } catch {
      // nowhere left to report
    }
  }
}

export function parseLogLine(line: string): LogFileEntry {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { time, level, msg, service: _service, ...rest } = parsed as Record<string, unknown>;
      return {
        time: typeof time === "string" ? time : undefined,
        level: level === "warn" || level === "error" ? level : "info",
        msg: typeof msg === "string" ? redactSecrets(msg) : "",
        fields: sanitize(rest) as Record<string, unknown>,
      };
    }
  } catch {
    // plain text line
  }
  return { level: "info", msg: redactSecrets(line), fields: {} };
}
