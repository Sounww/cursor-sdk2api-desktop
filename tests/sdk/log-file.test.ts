import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DailyLogFile, localLogDate, parseLogLine } from "../../src/log-file.js";
import { captureConsole, createLogger, installCrashLogging } from "../../src/log.js";

const files: DailyLogFile[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
  for (const file of files.splice(0)) file.close();
  for (const restore of restores.splice(0)) restore();
  vi.restoreAllMocks();
});

function open(now: () => Date = () => new Date(2026, 9, 16, 12), retentionDays = 14) {
  const dir = join(mkdtempSync(join(tmpdir(), "cursor-sdk2api-logs-")), "logs");
  const file = new DailyLogFile({ dir, retentionDays, now });
  files.push(file);
  return file;
}

function line(msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ time: "2026-10-16T04:00:00.000Z", level: "info", msg, service: "cursor-sdk2api", ...extra });
}

test("writes one owner-only file per local day", () => {
  const file = open();
  file.write(line("hello"));
  const path = join(file.dir, "gateway-2026-10-16.log");
  expect(readFileSync(path, "utf8")).toBe(`${line("hello")}\n`);
  expect(file.currentDate()).toBe("2026-10-16");
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(file.dir).mode & 0o777).toBe(0o700);
  }
});

test("rolls to a new file when the local day changes", () => {
  let now = new Date(2026, 9, 16, 23, 59);
  const file = open(() => now);
  file.write(line("before midnight"));
  now = new Date(2026, 9, 17, 0, 1);
  file.write(line("after midnight"));
  expect(file.list().map((info) => info.date)).toEqual(["2026-10-17", "2026-10-16"]);
  expect(file.read("2026-10-16").entries.map((entry) => entry.msg)).toEqual(["before midnight"]);
  expect(file.read("2026-10-17").entries.map((entry) => entry.msg)).toEqual(["after midnight"]);
});

test("prunes files older than the retention window", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cursor-sdk2api-logs-")), "logs");
  const first = new DailyLogFile({ dir, retentionDays: 3, now: () => new Date(2026, 9, 10) });
  first.write(line("old"));
  first.close();
  writeFileSync(join(dir, "notes.txt"), "keep");
  const file = new DailyLogFile({ dir, retentionDays: 3, now: () => new Date(2026, 9, 12) });
  files.push(file);
  expect(existsSync(join(dir, "gateway-2026-10-10.log"))).toBe(true);
  file.close();
  const later = new DailyLogFile({ dir, retentionDays: 3, now: () => new Date(2026, 9, 13) });
  files.push(later);
  expect(readdirSync(dir).sort()).toEqual(["notes.txt"]);
});

test("reads the tail, then only lines appended after the offset", () => {
  const file = open();
  file.write(line("one"));
  file.write(line("two"));
  const first = file.read("2026-10-16");
  expect(first.entries.map((entry) => entry.msg)).toEqual(["one", "two"]);
  file.write(line("three"));
  const next = file.read("2026-10-16", first.next_offset);
  expect(next.entries.map((entry) => entry.msg)).toEqual(["three"]);
  expect(file.read("2026-10-16", next.next_offset).entries).toEqual([]);
  // An offset past the end means the file was replaced: start over.
  expect(file.read("2026-10-16", next.next_offset + 1_000).entries.map((entry) => entry.msg)).toEqual([
    "one",
    "two",
    "three",
  ]);
});

test("tail reads drop the partial first line of a large file", () => {
  const file = open();
  const filler = "x".repeat(1_000);
  for (let index = 0; index < 700; index += 1) file.write(line(`line-${index}`, { filler }));
  const { entries, next_offset } = file.read("2026-10-16");
  expect(entries.length).toBeGreaterThan(100);
  expect(entries.length).toBeLessThan(700);
  expect(entries.every((entry) => entry.msg.startsWith("line-"))).toBe(true);
  expect(entries.at(-1)?.msg).toBe("line-699");
  expect(next_offset).toBe(statSync(join(file.dir, "gateway-2026-10-16.log")).size);
});

test("incremental reads stop at the last complete line", () => {
  const file = open();
  file.write(line("whole"));
  appendFileSync(join(file.dir, "gateway-2026-10-16.log"), '{"level":"info","msg":"par');
  const read = file.read("2026-10-16", 0);
  // The chunk reaches end of file, so the trailing fragment is returned as text.
  expect(read.entries.map((entry) => entry.msg)).toEqual(["whole", '{"level":"info","msg":"par']);
});

test("rejects dates that are not YYYY-MM-DD and returns nothing for missing days", () => {
  const file = open();
  expect(() => file.read("../secrets")).toThrow("invalid log date");
  expect(file.read("2020-01-01")).toEqual({ entries: [], next_offset: 0 });
});

test("parsed lines are sanitized again on the way out", () => {
  const entry = parseLogLine(
    JSON.stringify({ level: "warn", msg: "boom sk-canary-SECRET-123456789", prompt: "do not show", request_id: "r1" }),
  );
  expect(entry.level).toBe("warn");
  expect(entry.msg).not.toContain("sk-canary");
  expect(entry.fields).toEqual({ prompt: "[redacted]", request_id: "r1" });
  expect(parseLogLine("plain text Bearer abc.def")).toEqual({ level: "info", msg: "plain text [redacted]", fields: {} });
});

test("the logger writes timestamped sanitized lines to its sink", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const sink = { lines: [] as string[], write(value: string) { this.lines.push(value); } };
  const logger = createLogger("info", { sink });
  logger.info({ request_id: "r1", prompt: "secret prompt" }, "turn completed");
  expect(sink.lines).toHaveLength(1);
  const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
  expect(parsed).toMatchObject({ level: "info", msg: "turn completed", request_id: "r1", prompt: "[redacted]" });
  expect(typeof parsed.time).toBe("string");
});

test("captureConsole records redacted third-party warnings once", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const sink = { lines: [] as string[], write(value: string) { this.lines.push(value); } };
  restores.push(captureConsole(sink));
  const logger = createLogger("info", { sink });

  console.error("[TranscriptStore] failed", new Error("key sk-canary-SECRET-123456789"));
  console.warn("cursor key_0123456789abcdef0123456789abcdef in output");
  logger.warn({ request_id: "r2" }, "request failed");

  expect(error).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(sink.lines).toHaveLength(3);
  const dumped = sink.lines.join("\n");
  expect(dumped).not.toContain("sk-canary-SECRET-123456789");
  expect(dumped).not.toContain("key_0123456789abcdef0123456789abcdef");
  const parsed = sink.lines.map((value) => JSON.parse(value) as Record<string, unknown>);
  expect(parsed[0]).toMatchObject({ level: "error", source: "console" });
  expect(parsed[1]).toMatchObject({ level: "warn", source: "console" });
  expect(parsed[2]).toMatchObject({ level: "warn", msg: "request failed", request_id: "r2" });
  expect(parsed[2]).not.toHaveProperty("source");
});

test("crash logging records uncaught exceptions", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sink = { lines: [] as string[], write(value: string) { this.lines.push(value); } };
  restores.push(installCrashLogging(createLogger("info", { sink })));
  const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
  emit("uncaughtExceptionMonitor", new Error("listen EADDRINUSE 127.0.0.1:8080"), "uncaughtException");
  expect(sink.lines).toHaveLength(1);
  expect(JSON.parse(sink.lines[0]!)).toMatchObject({
    level: "error",
    msg: "uncaught exception",
    origin: "uncaughtException",
    error: "listen EADDRINUSE 127.0.0.1:8080",
  });
});

test("localLogDate uses the local calendar day", () => {
  expect(localLogDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
});
