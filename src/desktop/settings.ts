import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir } from "../core/lineage-store.js";

export interface DesktopSettings {
  port: number;
  gatewayAccessKey: string;
}

export function saveDesktopSettings(
  filePath: string,
  input: { port: unknown; gatewayAccessKey: unknown },
  cursorKeys: readonly string[] = [],
): DesktopSettings {
  const settings = parseDesktopSettings(input, cursorKeys);
  writePrivate(filePath, settings);
  return settings;
}

export function loadOrCreateDesktopSettings(filePath: string): DesktopSettings {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const created: DesktopSettings = {
      port: 8080,
      gatewayAccessKey: randomBytes(32).toString("base64url"),
    };
    writePrivate(filePath, created);
    return created;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("desktop settings file is corrupt");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("desktop settings file is corrupt");
  }
  const record = parsed as { port?: unknown; gatewayAccessKey?: unknown };
  try {
    return parseDesktopSettings({
      port: record.port,
      gatewayAccessKey: record.gatewayAccessKey,
    });
  } catch {
    throw new Error("desktop settings file is corrupt");
  }
}

function parseDesktopSettings(
  input: { port: unknown; gatewayAccessKey: unknown },
  cursorKeys: readonly string[] = [],
): DesktopSettings {
  if (typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("port is not an integer from 1 to 65535");
  }
  if (typeof input.gatewayAccessKey !== "string" || input.gatewayAccessKey.trim() === "") {
    throw new Error("gateway access key is empty");
  }
  const gatewayAccessKey = input.gatewayAccessKey.trim();
  if (cursorKeys.some((key) => key === gatewayAccessKey)) {
    throw new Error("gateway access key matches a stored Cursor key");
  }
  return { port: input.port, gatewayAccessKey };
}

function writePrivate(filePath: string, settings: DesktopSettings): void {
  ensurePrivateDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(settings)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // best effort on filesystems that ignore mode
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
