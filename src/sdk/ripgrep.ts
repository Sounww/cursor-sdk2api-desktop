import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/** Pin the SDK file walker to the platform package binary before any Agent starts. */
export function configureBundledRipgrep(): string {
  const pkg = `@cursor/sdk-${process.platform}-${process.arch}`;
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  let root: string;
  try {
    root = join(require.resolve(`${pkg}/package.json`), "..");
  } catch {
    throw new Error(
      `Cursor SDK platform package ${pkg} is not installed. Run npm ci so Agent file search can start.`,
    );
  }
  const path = join(root, "bin", binary);
  if (!existsSync(path)) {
    throw new Error(
      `Cursor SDK ripgrep is missing at ${path}. Reinstall ${pkg} with npm ci.`,
    );
  }
  process.env.CURSOR_RIPGREP_PATH = path;
  return path;
}
