import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("role and permission review contract", () => {
  it("exposes a secured role review endpoint with role definitions and employee rows", () => {
    const route = read("src/app/api/roles/review/route.ts");
    expect(route).toContain('withAdminAuth("employee.manage"');
    expect(route).toContain("roleDefinitions");
    expect(route).toContain("permissionsForRole");
    expect(route).toContain("FROM employees e");
    expect(route).toContain("e.organization_id = $1");
  });

  it("flags sensitive permissions and inactive/admin-risk employees", () => {
    const route = read("src/app/api/roles/review/route.ts");
    expect(route).toContain("SENSITIVE_PERMISSIONS");
    expect(route).toContain("sensitivePermissions");
    expect(route).toContain("inactivePrivilegedCount");
    expect(route).toContain("ownerCount");
  });

  it("renders a manager-facing permission review matrix", () => {
    const page = read("src/app/admin/roles/page.tsx");
    expect(page).toContain("Role & Permission Review");
    expect(page).toContain("Permission matrix");
    expect(page).toContain("Sensitive permissions");
    expect(page).toContain("Inactive privileged users");
    expect(page).toContain("authFetch('/api/roles/review'");
  });

  it("employees page links to the role review", () => {
    const page = read("src/app/admin/employees/page.tsx");
    expect(page).toContain("Permission Review");
    expect(page).toContain("/admin/roles");
  });
});
