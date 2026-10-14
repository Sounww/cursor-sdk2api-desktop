import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

const dirs: string[] = [];
let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function settingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-desktop-http-"));
  dirs.push(dir);
  return join(dir, "desktop-settings.json");
}

test("desktop settings routes stay closed unless desktop mode is on", async () => {
  ctx = await startTestApp({ captureLogs: true });
  const secret = "gateway-secret-should-stay-out-of-logs";
  const got = await fetch(`${ctx.url}/v0/management/desktop`);
  const put = await fetch(`${ctx.url}/v0/management/desktop`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: 9090, gateway_access_key: secret }),
  });
  expect(got.status).toBe(404);
  expect(put.status).toBe(404);
  expect(ctx.logs.join("\n")).not.toContain(secret);
});

test("desktop mode returns the loopback listen settings and gateway key", async () => {
  const file = settingsFile();
  ctx = await startTestApp({
    captureLogs: true,
    config: {
      desktopMode: true,
      desktopSettingsPath: file,
      authMode: "managed",
      gatewayAccessKey: "gateway-secret",
      port: 9090,
    },
  });
  const response = await fetch(`${ctx.url}/v0/management/desktop`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    desktop: true,
    host: "127.0.0.1",
    port: 9090,
    gateway_access_key: "gateway-secret",
  });
  expect(ctx.logs.join("\n")).not.toContain("gateway-secret");
});

test("saving desktop settings writes the file and asks the process to restart", async () => {
  const file = settingsFile();
  let restarted = false;
  ctx = await startTestApp({
    captureLogs: true,
    onDesktopRestart: () => {
      restarted = true;
    },
    config: {
      desktopMode: true,
      desktopSettingsPath: file,
      authMode: "managed",
      gatewayAccessKey: "gateway-secret",
      port: 9090,
    },
  });
  const response = await fetch(`${ctx.url}/v0/management/desktop`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      port: 9100,
      gateway_access_key: "next-gateway-secret",
      host: "0.0.0.0",
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ restart_required: true, port: 9100 });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    port: 9100,
    gatewayAccessKey: "next-gateway-secret",
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(restarted).toBe(true);
  const current = await fetch(`${ctx.url}/v0/management/desktop`);
  expect(await current.json()).toMatchObject({ port: 9090, host: "127.0.0.1" });
  expect(ctx.logs.join("\n")).not.toContain("next-gateway-secret");
  expect(ctx.logs.join("\n")).not.toContain("gateway-secret");
});

test("saving desktop settings rejects an empty key, a bad port, and a stored Cursor key", async () => {
  const file = settingsFile();
  ctx = await startTestApp({
    captureLogs: true,
    config: {
      desktopMode: true,
      desktopSettingsPath: file,
      authMode: "managed",
      gatewayAccessKey: "gateway-secret",
      port: 9090,
      stateDir: mkdtempSync(join(tmpdir(), "cursor-sdk2api-desktop-state-")),
    },
  });
  dirs.push(ctx.app.config.stateDir);
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "cursor-secret" }),
  });
  expect(created.status).toBe(201);

  const emptyKey = await fetch(`${ctx.url}/v0/management/desktop`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: 9100, gateway_access_key: " " }),
  });
  expect(emptyKey.status).toBe(400);

  const badPort = await fetch(`${ctx.url}/v0/management/desktop`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: 0, gateway_access_key: "next-gateway-secret" }),
  });
  expect(badPort.status).toBe(400);

  const collision = await fetch(`${ctx.url}/v0/management/desktop`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: 9100, gateway_access_key: "cursor-secret" }),
  });
  expect(collision.status).toBe(400);
  expect(() => readFileSync(file, "utf8")).toThrow();
  expect(ctx.logs.join("\n")).not.toContain("cursor-secret");
  expect(ctx.logs.join("\n")).not.toContain("next-gateway-secret");
  expect(ctx.logs.join("\n")).not.toContain("gateway-secret");
});
