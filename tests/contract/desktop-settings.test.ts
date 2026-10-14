import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadConfig } from "../../src/config.js";
import { loadOrCreateDesktopSettings, saveDesktopSettings } from "../../src/desktop/settings.js";

const dirs: string[] = [];
const touchedEnv = [
  "DESKTOP_MODE",
  "DESKTOP_SETTINGS_PATH",
  "HOST",
  "PORT",
  "AUTH_MODE",
  "GATEWAY_ACCESS_KEY",
  "CURSOR_API_KEY",
] as const;
const originalEnv = Object.fromEntries(touchedEnv.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of touchedEnv) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-desktop-"));
  dirs.push(dir);
  return join(dir, "desktop-settings.json");
}

function withEnv(values: Partial<Record<(typeof touchedEnv)[number], string | undefined>>, run: () => void): void {
  for (const key of touchedEnv) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  run();
}

test("saveDesktopSettings rejects ports outside 1-65535 and non-integers", () => {
  const file = tempFile();
  for (const port of [0, -1, 65536, 1.5, "8080", null]) {
    expect(() => saveDesktopSettings(file, { port, gatewayAccessKey: "gateway-secret" })).toThrow(/port/i);
  }
  expect(() => statSync(file)).toThrow();
});

test("saveDesktopSettings rejects an empty gateway key", () => {
  const file = tempFile();
  expect(() => saveDesktopSettings(file, { port: 8080, gatewayAccessKey: "   " })).toThrow(/key/i);
  expect(() => statSync(file)).toThrow();
});

test("saveDesktopSettings rejects a gateway key that matches a Cursor key", () => {
  const file = tempFile();
  expect(() =>
    saveDesktopSettings(file, { port: 8080, gatewayAccessKey: "cursor-secret" }, ["cursor-secret"]),
  ).toThrow(/Cursor/);
  expect(() => statSync(file)).toThrow();
});

test("saveDesktopSettings persists a trimmed key and reloads the same settings", () => {
  const file = tempFile();
  const saved = saveDesktopSettings(file, { port: 9090, gatewayAccessKey: "  gateway-secret  " });
  expect(saved).toEqual({ port: 9090, gatewayAccessKey: "gateway-secret" });
  expect(loadOrCreateDesktopSettings(file)).toEqual({
    port: 9090,
    gatewayAccessKey: "gateway-secret",
  });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    port: 9090,
    gatewayAccessKey: "gateway-secret",
  });
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  }
});

test("loadOrCreateDesktopSettings creates port 8080 and a fresh key when the file is missing", () => {
  const file = tempFile();
  const created = loadOrCreateDesktopSettings(file);
  expect(created.port).toBe(8080);
  expect(created.gatewayAccessKey.length).toBeGreaterThanOrEqual(32);
  expect(created.gatewayAccessKey).not.toContain("gateway-secret");
  expect(loadOrCreateDesktopSettings(file)).toEqual(created);
});

test("loadOrCreateDesktopSettings refuses a corrupt settings file", () => {
  const file = tempFile();
  writeFileSync(file, "{", "utf8");
  expect(() => loadOrCreateDesktopSettings(file)).toThrow(/desktop settings/i);
  expect(readFileSync(file, "utf8")).toBe("{");
});

test("DESKTOP_MODE refuses a non-loopback host", () => {
  withEnv(
    {
      DESKTOP_MODE: "1",
      HOST: "0.0.0.0",
      DESKTOP_SETTINGS_PATH: "C:\\cursor-sdk2api\\desktop-settings.json",
      AUTH_MODE: "managed",
      GATEWAY_ACCESS_KEY: "gateway-secret",
    },
    () => {
      expect(() => loadConfig()).toThrow(/loopback/i);
    },
  );
});

test("DESKTOP_MODE on loopback keeps the managed key and settings path", () => {
  withEnv(
    {
      DESKTOP_MODE: "1",
      HOST: "127.0.0.1",
      PORT: "9090",
      DESKTOP_SETTINGS_PATH: "C:\\cursor-sdk2api\\desktop-settings.json",
      AUTH_MODE: "managed",
      GATEWAY_ACCESS_KEY: "gateway-secret",
    },
    () => {
      const config = loadConfig();
      expect(config.desktopMode).toBe(true);
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(9090);
      expect(config.desktopSettingsPath).toBe("C:\\cursor-sdk2api\\desktop-settings.json");
      expect(config.authMode).toBe("managed");
      expect(config.gatewayAccessKey).toBe("gateway-secret");
    },
  );
});

test("DESKTOP_MODE requires a settings path and managed auth", () => {
  withEnv(
    {
      DESKTOP_MODE: "1",
      HOST: "127.0.0.1",
      AUTH_MODE: "managed",
      GATEWAY_ACCESS_KEY: "gateway-secret",
    },
    () => {
      expect(() => loadConfig()).toThrow(/DESKTOP_SETTINGS_PATH/);
    },
  );
  withEnv(
    {
      DESKTOP_MODE: "1",
      HOST: "127.0.0.1",
      DESKTOP_SETTINGS_PATH: "C:\\cursor-sdk2api\\desktop-settings.json",
    },
    () => {
      expect(() => loadConfig()).toThrow(/managed/i);
    },
  );
});

test("without DESKTOP_MODE the listen defaults stay unchanged", () => {
  withEnv({}, () => {
    const config = loadConfig();
    expect(config.desktopMode).toBe(false);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.desktopSettingsPath).toBeUndefined();
  });
});
