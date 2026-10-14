import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");
const version = execFileSync(electron, ["-e", "process.stdout.write(process.versions.node)"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  encoding: "utf8",
}).trim();

const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
const below = major < 22 || (major === 22 && (minor < 19 || (minor === 19 && patch < 0)));
if (below || !Number.isFinite(major)) {
  console.error(`Electron bundles Node ${version || "unknown"}, which is below 22.19. Refusing the desktop build.`);
  process.exit(1);
}

console.log(`Electron Node ${version}`);
