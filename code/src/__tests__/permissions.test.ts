import { describe, it, expect } from "vitest";
import { hasPermission } from "@/lib/domain/permissions";
import type { RoleKey } from "@/lib/domain/types";

describe("Permission system", () => {
  it("owner has all permissions", () => {
    expect(hasPermission("owner", "audit.view")).toBe(true);
    expect(hasPermission("owner", "employee.manage")).toBe(true);
    expect(hasPermission("owner", "register.open")).toBe(true);
    expect(hasPermission("owner", "catalog.manage")).toBe(true);
  });

  it("manager has most permissions", () => {
    expect(hasPermission("manager", "audit.view")).toBe(true);
    expect(hasPermission("manager", "employee.manage")).toBe(true);
    expect(hasPermission("manager", "register.open")).toBe(true);
  });

  it("cashier has limited permissions", () => {
    expect(hasPermission("cashier", "register.open")).toBe(true);
    expect(hasPermission("cashier", "audit.view")).toBe(false);
    expect(hasPermission("cashier", "employee.manage")).toBe(false);
  });

  it("inventory clerk can manage inventory but not employees", () => {
    expect(hasPermission("inventory_clerk", "inventory.adjust")).toBe(true);
    expect(hasPermission("inventory_clerk", "employee.manage")).toBe(false);
  });
});
