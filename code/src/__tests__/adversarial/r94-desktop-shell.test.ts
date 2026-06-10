/**
 * R94 — Electron desktop shell security invariants (source-grep on
 * desktop/main.js). The shell wraps the live site; a regression here
 * (nodeIntegration on, navigation unlocked, permissive permissions) would
 * hand any compromised page full machine access on every store PC.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = code/src/__tests__/adversarial → repo root is four up.
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const main = fs.readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");

describe("R94: renderer is fully isolated", () => {
  it("contextIsolation on, nodeIntegration off, sandbox on", () => {
    expect(main).toMatch(/contextIsolation: true/);
    expect(main).toMatch(/nodeIntegration: false/);
    expect(main).toMatch(/sandbox: true/);
  });
  it("no preload script and no remote module", () => {
    expect(main).not.toMatch(/preload:/);
    expect(main).not.toMatch(/@electron\/remote|enableRemoteModule/);
  });
});

describe("R94: navigation is locked to the app origin", () => {
  it("will-navigate blocks cross-origin and hands it to the OS browser", () => {
    expect(main).toMatch(/will-navigate/);
    expect(main).toMatch(/event\.preventDefault\(\);\s*\n\s*shell\.openExternal\(url\)/);
  });
  it("window.open: same-origin hardened in-app, external denied to default browser", () => {
    expect(main).toMatch(/setWindowOpenHandler/);
    expect(main).toMatch(/action: "deny"/);
    // The same-origin allow path must re-apply the hardened webPreferences.
    expect(main).toMatch(/overrideBrowserWindowOptions[\s\S]{0,200}contextIsolation: true, nodeIntegration: false, sandbox: true/);
  });
});

describe("R94: permissions are default-deny with an app-origin allowlist", () => {
  it("request + check handlers gate on origin AND an explicit allowlist", () => {
    expect(main).toMatch(/setPermissionRequestHandler/);
    expect(main).toMatch(/setPermissionCheckHandler/);
    expect(main).toMatch(/origin === appOrigin\(\) && ALLOWED\.has\(permission\)/);
  });
  it("serial device access is origin-gated", () => {
    expect(main).toMatch(/setDevicePermissionHandler/);
    expect(main).toMatch(/details\.deviceType === "serial" && details\.origin === appOrigin\(\)/);
  });
});

describe("R94: the build pipeline exists and uploads an installer artifact", () => {
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "desktop-build.yml"), "utf8");
  it("builds NSIS on windows-latest and uploads the exe", () => {
    expect(wf).toMatch(/runs-on: windows-latest/);
    expect(wf).toMatch(/electron-builder --win nsis --publish never/);
    expect(wf).toMatch(/desktop\/dist\/\*\.exe/);
  });
});
