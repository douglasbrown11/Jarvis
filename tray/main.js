"use strict";

const { app, ipcMain, Menu, nativeImage, session, Tray } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const rootDir = path.join(__dirname, "..");
const configPath = path.join(rootDir, "config.json");

let tray = null;
let listenerWindow = null;
let serverProcess = null;
let lastWakeAt = 0;
let lastConsoleOpenAt = 0;
let listenerStatus = "Starting";
const wakeRetriggerBlockMs = 30000;

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function getPort() {
  const config = loadConfig();
  return Number(process.env.PORT || config.server.port || 3080);
}

function makeTrayImage() {
  const dataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAVFBMVEUAAAAAABsDGSgFGiwIGzIMIDEPJjMTKzQVMDkXND4ZOUQbPUsdQlEfSFIhV1ciXGAjY2kjb3Ejf4EjkJQkr7Mlu7wmz8Io2M8p5e0r8vQs9/0u+/8wf4m1AAAAHHRSTlMAAQIFCAsNDxMUFRkaHB4gIyYqLzE1OT5AlYcdyAAAAJpJREFUGNNVz1kSgkAMRNFkEQQBl+X9L9uQYVTT7M5v2p6knTLs8dqgJ9WwYEe45v3ejUrtZ5GxqjSTuB4I7AQd7A7D6FR6B3pH1cDOHGb6E6g0i7HoZxlkP+WGiViPKk1o0rGvO6VVFiWtd7Fq7s4KxG1e+qTnUZizp7U1ZrYVb3UhnY8xwQ4P/FxWqKoQ3edmJ5SgLxSz2h0t4Pl76nR8P4FfG1w8n+p9wAAAABJRU5ErkJggg==";
  return nativeImage.createFromDataURL(dataUrl);
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Jarvis: ${listenerStatus}`,
      enabled: false
    },
    {
      label: "Open Jarvis Console",
      click: () => {
        void openJarvisConsole(false);
      }
    },
    {
      label: "Restart Listener",
      click: () => {
        void restartListener();
      }
    },
    {
      type: "separator"
    },
    {
      label: "Quit Jarvis",
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setToolTip(`Jarvis tray listener: ${listenerStatus}`);
  tray.setContextMenu(contextMenu);
}

function setListenerStatus(status) {
  listenerStatus = status;
  updateTrayMenu();
}

function isServerListening(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/config",
        timeout: 1200
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.on("error", () => {
      resolve(false);
    });
  });
}

function postJson(port, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        timeout: 2500,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString("utf8");
        });
        res.on("end", () => {
          const status = Number(res.statusCode || 0);
          let data = {};

          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (_error) {
            data = {};
          }

          if (status >= 200 && status < 300) {
            resolve(data);
            return;
          }

          const message = data.error || `Request failed with status ${status}.`;
          reject(new Error(message));
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out."));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function ensureServerRunning() {
  const port = getPort();
  if (await isServerListening(port)) {
    return port;
  }

  if (!serverProcess) {
    serverProcess = spawn("node", ["server.js"], {
      cwd: rootDir,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        JARVIS_OPEN_BROWSER: "0"
      }
    });

    serverProcess.on("exit", () => {
      serverProcess = null;
    });
  }

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isServerListening(port)) {
      return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  throw new Error("Jarvis server did not start in time.");
}

function getBrowserExecutable() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function openJarvisConsole(fromWake, knownPort) {
  const port = Number(knownPort) || await ensureServerRunning();
  const browserPath = getBrowserExecutable();
  if (fromWake) {
    lastConsoleOpenAt = Date.now();
  }
  const url = `http://localhost:${port}/?autostart=1${fromWake ? "&wake=1" : ""}&source=tray`;

  if (!browserPath) {
    spawn("cmd.exe", ["/c", "start", "\"\"", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
    return;
  }

  spawn(browserPath, [
    `--app=${url}`,
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream"
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }).unref();
}

async function triggerWakeRoutine(port) {
  try {
    await postJson(port, "/api/trigger", {});
  } catch (_error) {
    // Wake fallback still succeeds through the console path.
  }
}

async function createListenerWindow() {
  const { BrowserWindow } = require("electron");

  listenerWindow = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required"
    }
  });

  listenerWindow.on("closed", () => {
    listenerWindow = null;
  });

  await listenerWindow.loadURL(pathToFileURL(path.join(__dirname, "listener.html")).toString());
}

async function restartListener() {
  if (listenerWindow && !listenerWindow.isDestroyed()) {
    listenerWindow.destroy();
  }
  setListenerStatus("Restarting");
  await createListenerWindow();
}

function allowLocalMediaPermissions() {
  const currentSession = session.defaultSession;

  currentSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission !== "media") {
      return false;
    }

    if (details.mediaType && details.mediaType !== "audio") {
      return false;
    }

    return requestingOrigin.startsWith("file://") || requestingOrigin.startsWith("http://localhost:");
  });

  currentSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === "media" && (!details.mediaTypes || details.mediaTypes.includes("audio"))) {
      callback(true);
      return;
    }

    callback(false);
  });
}

function createTray() {
  tray = new Tray(makeTrayImage());
  tray.on("double-click", () => {
    void openJarvisConsole(false);
  });
  setListenerStatus("Starting");
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  void openJarvisConsole(false);
});

ipcMain.handle("tray:get-config", () => {
  const config = loadConfig();
  return {
    clapDetector: config.clapDetector,
    microphone: config.microphone || {
      lockedDeviceId: "",
      lockedLabel: ""
    }
  };
});

ipcMain.on("tray:status", (_event, payload) => {
  if (payload && typeof payload.status === "string") {
    setListenerStatus(payload.status);
  }
});

ipcMain.on("tray:wake", async () => {
  const config = loadConfig();
  const cooldown = Number(config.clapDetector.cooldownMs) || 6000;
  const now = Date.now();

  if (now - lastWakeAt < cooldown) {
    return;
  }

  if (now - lastConsoleOpenAt < wakeRetriggerBlockMs) {
    return;
  }

  lastWakeAt = now;
  setListenerStatus("Wake Triggered");

  try {
    const port = await ensureServerRunning();
    await Promise.allSettled([
      triggerWakeRoutine(port),
      openJarvisConsole(true, port)
    ]);
    setListenerStatus("Listening");
  } catch (error) {
    setListenerStatus("Error");
  }
});

app.whenReady().then(async () => {
  app.setAppUserModelId("Jarvis.Tray");
  allowLocalMediaPermissions();
  createTray();
  await ensureServerRunning();
  await createListenerWindow();
  setListenerStatus("Listening");
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});
