import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { configureBundledRipgrep } from "../../src/sdk/ripgrep.js";

test("configureBundledRipgrep pins the platform rg binary", () => {
  const path = configureBundledRipgrep();
  expect(existsSync(path)).toBe(true);
  expect(path.endsWith(process.platform === "win32" ? "rg.exe" : "rg")).toBe(true);
  expect(process.env.CURSOR_RIPGREP_PATH).toBe(path);
});
