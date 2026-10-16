import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { assertNoSecretLeak, createLogger } from "../../src/log.js";
import { DailyLogFile } from "../../src/log-file.js";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;
let logFile: DailyLogFile | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
  logFile?.close();
  logFile = undefined;
  vi.restoreAllMocks();
});

function openLogFile(): DailyLogFile {
  logFile = new DailyLogFile({
    dir: join(mkdtempSync(join(tmpdir(), "cursor-sdk2api-logs-")), "logs"),
    retentionDays: 14,
  });
  return logFile;
}

async function getLogs(query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${ctx!.url}/v0/management/logs${query}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("logs endpoint reports file logging off when no log file is attached", async () => {
  ctx = await startTestApp();
  const { status, body } = await getLogs();
  expect(status).toBe(200);
  expect(body).toEqual({ enabled: false, files: [], entries: [] });
});

test("logs endpoint returns today's lines, then only new ones after next_offset", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const file = openLogFile();
  ctx = await startTestApp({ logFile: file });
  const logger = createLogger("info", { sink: file });
  logger.info({ request_id: "req-1", model: "composer-2.5" }, "turn completed");

  const first = await getLogs();
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    enabled: true,
    dir: file.dir,
    today: file.currentDate(),
    date: file.currentDate(),
  });
  expect(first.body.files).toEqual([expect.objectContaining({ date: file.currentDate() })]);
  expect(first.body.entries).toEqual([
    expect.objectContaining({
      level: "info",
      msg: "turn completed",
      fields: { request_id: "req-1", model: "composer-2.5" },
    }),
  ]);

  logger.info({ request_id: "req-2" }, "ordinary turn");
  const next = await getLogs(`?date=${file.currentDate()}&offset=${first.body.next_offset as number}`);
  expect((next.body.entries as Array<{ msg: string }>).map((entry) => entry.msg)).toEqual(["ordinary turn"]);
});

test("logs endpoint rejects bad dates and offsets", async () => {
  ctx = await startTestApp({ logFile: openLogFile() });
  expect((await getLogs("?date=../../desktop-settings")).status).toBe(400);
  expect((await getLogs("?date=2026-1-1")).status).toBe(400);
  expect((await getLogs("?offset=-1")).status).toBe(400);
  expect((await getLogs("?offset=abc")).status).toBe(400);
  const missing = await getLogs("?date=2020-01-01");
  expect(missing.status).toBe(200);
  expect(missing.body.entries).toEqual([]);
});

test("logs endpoint never returns secrets even from a hand-edited file", async () => {
  const file = openLogFile();
  ctx = await startTestApp({ logFile: file });
  const canary = "sk-canary-SECRET-123456789";
  file.write(JSON.stringify({ level: "warn", msg: `failed with ${canary}`, prompt: "do not log this prompt" }));
  file.write(`raw line Bearer ${canary}`);
  const { body } = await getLogs();
  const dumped = JSON.stringify(body);
  assertNoSecretLeak(dumped, [canary, "do not log this prompt"]);
  expect((body.entries as unknown[]).length).toBe(2);
});
