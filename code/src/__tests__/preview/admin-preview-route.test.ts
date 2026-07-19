import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("../../app/preview/admin/route.ts", import.meta.url), "utf8");
const helper = readFileSync(new URL("../../lib/preview/admin-preview.ts", import.meta.url), "utf8");

describe("private admin preview contract", () => {
  it("fails closed when preview configuration is absent", () => {
    expect(route).toContain("if (!getPreviewConfig()) return unavailable();");
    expect(route).toContain('new NextResponse("Not found", { status: 404 })');
  });

  it("requires the preview secret before provisioning or signing in", () => {
    const check = "previewSecretMatches(candidate, config.secret)";
    expect(route.indexOf(check)).toBeGreaterThan(-1);
    expect(route.indexOf("ensurePreviewAdmin(config)")).toBeGreaterThan(route.indexOf(check));
    expect(route.indexOf("signInAdmin(config.email, config.password)")).toBeGreaterThan(
      route.indexOf("ensurePreviewAdmin(config)"),
    );
  });

  it("provisions only a scoped manager identity and never changes an existing account", () => {
    expect(helper).toContain("row.role_key !== \"manager\"");
    expect(helper).toContain("row.organization_id !== config.organizationId");
    expect(helper).toContain("VALUES ($1, $2::uuid, 'manager'");
    expect(helper).toContain("Existing accounts are never modified");
  });

  it("keeps the access form independent of the preview identity", () => {
    expect(route).toContain('name="code"');
    expect(route).not.toContain('name="email"');
    expect(route).not.toContain('name="password"');
  });
});
