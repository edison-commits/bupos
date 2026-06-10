# BasicUniformPOS — Windows Desktop App

A hardened Electron shell around **basicuniformpos.com**. There is no separate
desktop codebase or database: the app loads the live site, so every web deploy
updates the desktop experience instantly, and "sync" is inherent — same
backend, same offline-sales queue as the browser/PWA.

## What the desktop app adds over the browser

| Feature | How |
|---|---|
| Boot-to-register kiosk mode | Tray → **Kiosk mode** (fullscreen, no chrome; takes effect next launch) |
| Launch at Windows startup | Tray → **Launch at startup** |
| Customer-facing display | Tray → **Open Customer Display** (fullscreen on the second monitor when one is connected) |
| Remembered receipt printer | The first Web Serial port you connect is remembered — no chooser prompts at the register (reset by deleting `settings.json`, see below) |
| Offline resilience | Network drop mid-shift: sales queue and replay automatically (web app feature). Full outage: a branded offline screen polls and reloads the register the moment the connection returns |

## Getting the installer

GitHub → **Actions** → **Desktop build (Windows)** → **Run workflow**, then
download the `BasicUniformPOS-windows-installer` artifact from the finished
run. (Tagging `desktop-v1.0.0` also triggers a build.)

The installer is currently **unsigned**: the first launch shows Windows
SmartScreen — click **More info → Run anyway**. To ship signed builds later,
buy a code-signing certificate and add two repo secrets (`CSC_LINK` = base64
PFX, `CSC_KEY_PASSWORD`); electron-builder signs automatically from then on.

## Settings

Stored at `%APPDATA%/bupos-desktop/settings.json` (created on first run):

```json
{
  "kiosk": false,          // fullscreen lockdown
  "openAtLogin": false,    // start with Windows
  "baseUrl": "https://basicuniformpos.com",  // point at another instance if needed
  "serialPortId": null     // remembered receipt-printer port; delete to re-pick
}
```

`BUPOS_BASE_URL` (environment variable) overrides `baseUrl`.

## Development

```bash
cd desktop
npm install
npm start         # run the shell against the live site
npm run smoke     # headless load check (used by CI)
npm run dist      # build the NSIS installer locally (Windows only)
```

## Security posture

`contextIsolation` on, `nodeIntegration` off, `sandbox` on, no preload script,
navigation locked to the app origin (external links open in the default
browser), permissions default-deny with an explicit allowlist (Web Serial only
for the app origin). These invariants are pinned by
`code/src/__tests__/adversarial/r94-desktop-shell.test.ts` — CI fails if any
of them regress.
