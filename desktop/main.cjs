const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const HOST = "127.0.0.1";
const STDERR_TAIL_CHARS = 3000;

let child = null;
let windowRef = null;
let quitting = false;
let generation = 0;

function appRoot() {
  return join(__dirname, "..");
}

async function loadSettings() {
  const settingsModule = await import(pathToFileURL(join(appRoot(), "dist", "desktop", "settings.js")).href);
  const root = join(app.getPath("appData"), "cursor-sdk2api");
  const file = join(root, "desktop-settings.json");
  return {
    file,
    stateDir: join(root, "state"),
    logDir: join(root, "logs"),
    settings: settingsModule.loadOrCreateDesktopSettings(file),
  };
}

function spawnGateway(loaded) {
  const entry = join(appRoot(), "dist", "index.js");
  const proc = spawn(process.execPath, [entry], {
    cwd: appRoot(),
    windowsHide: true,
    stdio: ["ignore", "inherit", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DESKTOP_MODE: "1",
      HOST,
      PORT: String(loaded.settings.port),
      GATEWAY_ACCESS_KEY: loaded.settings.gatewayAccessKey,
      AUTH_MODE: "managed",
      STATE_DIR: loaded.stateDir,
      DESKTOP_SETTINGS_PATH: loaded.file,
      LOG_DIR: loaded.logDir,
    },
  });
  // Keep the last stderr output so a crash before the gateway logger starts is still visible.
  proc.stderrTail = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    proc.stderrTail = (proc.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    try {
      process.stderr.write(chunk);
    } catch {
      // packaged GUI builds may have no stderr
    }
  });
  return proc;
}

function failureDetail(summary, proc, logDir) {
  const tail = proc.stderrTail.trim();
  return [summary, tail, `Logs: ${logDir}`].filter(Boolean).join("\n\n");
}

function waitForHealth(port, token) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (token !== generation) {
        reject(new Error("stale"));
        return;
      }
      fetch(`http://${HOST}:${port}/health`).then((response) => {
        if (token !== generation) {
          reject(new Error("stale"));
          return;
        }
        if (response.ok) {
          resolve();
          return;
        }
        retry();
      }).catch(() => {
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > 20_000) {
        reject(new Error("Gateway did not become ready"));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function boot() {
  const mine = ++generation;
  if (child) {
    child.kill();
    child = null;
  }
  let loaded;
  try {
    loaded = await loadSettings();
  } catch (error) {
    dialog.showErrorBox(
      "cursor-sdk2api",
      error instanceof Error ? error.message : "Could not read desktop settings",
    );
    app.quit();
    return;
  }
  if (mine !== generation || quitting) return;
  const proc = spawnGateway(loaded);
  child = proc;
  proc.on("error", (error) => {
    if (quitting || mine !== generation) return;
    dialog.showErrorBox("cursor-sdk2api", error.message);
  });
  // "close" waits for stderr to drain, so the failure dialog shows the complete tail.
  proc.on("close", (code) => {
    if (child === proc) child = null;
    if (quitting || mine !== generation) return;
    if (code === 0) {
      void boot();
      return;
    }
    dialog.showErrorBox(
      "cursor-sdk2api",
      failureDetail(`Gateway exited with code ${code ?? "unknown"}.`, proc, loaded.logDir),
    );
  });
  try {
    await waitForHealth(loaded.settings.port, mine);
  } catch (error) {
    if (mine !== generation || quitting) return;
    if (error instanceof Error && error.message === "stale") return;
    dialog.showErrorBox(
      "cursor-sdk2api",
      failureDetail(error instanceof Error ? error.message : "Gateway did not start", proc, loaded.logDir),
    );
    return;
  }
  if (mine !== generation || quitting) return;
  const url = `http://${HOST}:${loaded.settings.port}/console/`;
  if (!windowRef || windowRef.isDestroyed()) {
    windowRef = new BrowserWindow({
      width: 1100,
      height: 800,
      title: "cursor-sdk2api",
      icon: join(__dirname, "icon.png"),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windowRef.on("closed", () => {
      windowRef = null;
    });
  }
  await windowRef.loadURL(url);
}

app.on("before-quit", () => {
  quitting = true;
  generation += 1;
  if (child) child.kill();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(() => {
  void boot();
});
