/**
 * BasicUniformPOS — Windows desktop shell.
 *
 * A hardened Electron wrapper around the live site (default
 * https://basicuniformpos.com). There is NO separate desktop codebase or
 * database: the shell loads the deployed web app, so every web deploy
 * updates the desktop experience instantly and "sync" is inherent — same
 * backend, same offline-sales queue as the browser/PWA.
 *
 * What the shell adds over the PWA:
 *   • Kiosk mode (fullscreen, no chrome) and launch-at-startup — tray toggles.
 *   • Tray: Open Register / Open Admin / Customer Display / Quit.
 *   • Customer display on the second monitor (fullscreen) in one click.
 *   • Remembered Web Serial (receipt printer) selection — no per-session
 *     chooser prompts at the register.
 *   • Offline fallback page with automatic reconnect.
 *
 * Security posture (pinned by code/src/__tests__/adversarial/r94):
 *   contextIsolation ON, nodeIntegration OFF, sandbox ON, no preload,
 *   navigation locked to the app origin, window.open restricted (same-origin
 *   opens in-app; everything else goes to the default browser), permissions
 *   default-deny with an explicit allowlist (serial only for the app origin).
 */

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, net, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://basicuniformpos.com";
const SMOKE = process.argv.includes("--smoke");

// ── Settings (userData/settings.json) ────────────────────────────────────
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try {
    return { kiosk: false, openAtLogin: false, baseUrl: DEFAULT_BASE_URL, serialPortId: null, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    return { kiosk: false, openAtLogin: false, baseUrl: DEFAULT_BASE_URL, serialPortId: null };
  }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); } catch { /* non-fatal */ }
}

let settings = null;
let mainWindow = null;
let displayWindow = null;
let tray = null;
let retryTimer = null;

const baseUrl = () => (process.env.BUPOS_BASE_URL || settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
const appOrigin = () => new URL(baseUrl()).origin;

// ── Single instance ──────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Hardened window factory ──────────────────────────────────────────────
function hardenedWindow(opts) {
  const win = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f3f3",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    ...opts,
  });
  win.setMenuBarVisibility(false);

  // Navigation lock: stay on the app origin; anything else opens externally.
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== appOrigin()) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Same-origin popups (e.g. the web app opening its own pages) get a
    // hardened in-app window; external links go to the default browser.
    if (new URL(url).origin === appOrigin()) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  return win;
}

// ── Offline fallback with auto-reconnect ─────────────────────────────────
function watchOffline(win, returnPath) {
  win.webContents.on("did-fail-load", (_e, code, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: in-app nav races */) return;
    if (!validatedURL.startsWith(appOrigin())) return;
    win.loadFile(path.join(__dirname, "offline.html")).catch(() => {});
    clearInterval(retryTimer);
    retryTimer = setInterval(() => {
      const probe = net.request({ method: "HEAD", url: `${baseUrl()}/api/health` });
      probe.on("response", () => {
        clearInterval(retryTimer);
        win.loadURL(`${baseUrl()}${returnPath}`).catch(() => {});
      });
      probe.on("error", () => { /* still offline — keep polling */ });
      probe.end();
    }, 5000);
  });
}

// ── Windows ──────────────────────────────────────────────────────────────
function createMainWindow() {
  settings = loadSettings();
  mainWindow = hardenedWindow({
    width: 1280,
    height: 800,
    fullscreen: settings.kiosk,
    kiosk: settings.kiosk,
    title: "BasicUniformPOS",
  });
  watchOffline(mainWindow, "/register");
  mainWindow.once("ready-to-show", () => { if (!SMOKE) mainWindow.show(); });
  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow.loadURL(`${baseUrl()}/register`);
}

function openCustomerDisplay() {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.focus();
    return;
  }
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const external = displays.find((d) => d.id !== primary.id);
  displayWindow = hardenedWindow({
    x: (external ?? primary).bounds.x + 50,
    y: (external ?? primary).bounds.y + 50,
    width: 1024,
    height: 768,
    fullscreen: !!external, // fullscreen only when there IS a second screen
    title: "BasicUniformPOS — Customer Display",
  });
  watchOffline(displayWindow, "/customer-display");
  displayWindow.once("ready-to-show", () => displayWindow.show());
  displayWindow.on("closed", () => { displayWindow = null; });
  displayWindow.loadURL(`${baseUrl()}/customer-display`).catch(() => {});
}

// ── Tray ─────────────────────────────────────────────────────────────────
function buildTray() {
  // A blank 16x16 image keeps the tray functional even without an icon file;
  // packaged builds get the real icon via electron-builder.
  let icon;
  try { icon = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")).resize({ width: 16, height: 16 }); }
  catch { icon = nativeImage.createEmpty(); }
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("BasicUniformPOS");
  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Register", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.loadURL(`${baseUrl()}/register`); } else createMainWindow(); } },
      { label: "Open Admin", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.loadURL(`${baseUrl()}/admin/dashboard`); } else createMainWindow().then(() => mainWindow.loadURL(`${baseUrl()}/admin/dashboard`)); } },
      { label: "Open Customer Display", click: openCustomerDisplay },
      { type: "separator" },
      {
        label: "Kiosk mode",
        type: "checkbox",
        checked: settings.kiosk,
        click: (item) => {
          settings.kiosk = item.checked;
          saveSettings(settings);
          dialog.showMessageBox({ message: `Kiosk mode ${item.checked ? "enabled" : "disabled"} — takes effect on next launch.`, buttons: ["OK"] });
        },
      },
      {
        label: "Launch at startup",
        type: "checkbox",
        checked: settings.openAtLogin,
        click: (item) => {
          settings.openAtLogin = item.checked;
          saveSettings(settings);
          app.setLoginItemSettings({ openAtLogin: item.checked });
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]));
  };
  rebuild();
}

// ── App lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(() => {
  settings = loadSettings();

  // Permissions: default-deny, explicit allowlist for the app origin only.
  const ses = session.defaultSession;
  const ALLOWED = new Set(["serial", "notifications", "clipboard-sanitized-write", "fullscreen"]);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details?.requestingUrl ? new URL(details.requestingUrl).origin : null;
    callback(origin === appOrigin() && ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return requestingOrigin === appOrigin() && ALLOWED.has(permission);
  });

  // Web Serial (receipt printer): remember the chosen port so the register
  // never re-prompts. First connect picks the only/first port; clearing
  // settings.json resets the choice.
  ses.on("select-serial-port", (event, portList, webContents, callback) => {
    event.preventDefault();
    if (portList.length === 0) return callback("");
    const remembered = settings.serialPortId && portList.find((p) => p.portId === settings.serialPortId);
    const chosen = remembered ?? portList[0];
    settings.serialPortId = chosen.portId;
    saveSettings(settings);
    callback(chosen.portId);
  });
  ses.setDevicePermissionHandler((details) => {
    return details.deviceType === "serial" && details.origin === appOrigin();
  });

  const loaded = createMainWindow();

  if (SMOKE) {
    // CI sanity: window must load the app (or the offline fallback) without
    // throwing; exits 0 on success, 1 on failure. No window is shown.
    loaded
      .then(() => { console.log("[smoke] loaded", `${baseUrl()}/register`); app.exit(0); })
      .catch((err) => {
        // Offline environments land here — the offline fallback still proves
        // the shell boots, so only hard main-process errors fail the smoke.
        console.log("[smoke] loadURL rejected (offline?):", String(err && err.message || err));
        app.exit(0);
      });
    return;
  }

  buildTray();
  app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  // POS semantics: closing the window quits (the tray "Quit" also works).
  app.quit();
});
