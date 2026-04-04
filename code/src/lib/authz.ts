import { redirect } from "next/navigation";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";
import type { PermissionKey, RoleKey } from "@/lib/domain/types";

export const permissionMatrix: Record<RoleKey, PermissionKey[]> = {
  owner: [
    "register.open",
    "register.pin_login",
    "catalog.manage",
    "inventory.adjust",
    "employee.manage",
    "audit.view",
    "approval.discount",
    "approval.void_item",
    "approval.void_transaction",
    "approval.store_credit",
    "approval.price_override",
  ],
  manager: [
    "register.open",
    "register.pin_login",
    "catalog.manage",
    "inventory.adjust",
    "employee.manage",
    "audit.view",
    "approval.discount",
    "approval.void_item",
    "approval.void_transaction",
    "approval.store_credit",
  ],
  cashier: ["register.open", "register.pin_login"],
  inventory_clerk: ["inventory.adjust"],
  support: ["audit.view"],
};

export function hasPermission(role: RoleKey, permission: PermissionKey): boolean {
  if (role === "owner") return true;
  const allowed = permissionMatrix[role];
  return allowed?.includes(permission) ?? false;
}

export function canManageEmployeeRole(actorRole: RoleKey, targetRole: RoleKey): boolean {
  if (actorRole === "owner") return true;
  // Intentional: manager can manage support role (support is read-only audit, not a security risk)
  if (actorRole === "manager") return targetRole !== "owner" && targetRole !== "manager";
  return false;
}

export async function requireAdminPermission(permission: PermissionKey) {
  const ctx = await getAdminSession();
  if (!ctx || !ctx.session || !ctx.employee) {
    redirect("/admin");
  }
  if (!hasPermission(ctx.employee.roleKey, permission)) {
    redirect("/admin?error=Unauthorized");
  }
  return { session: ctx.session, employee: ctx.employee };
}

export async function requireRegisterPermission(permission: PermissionKey) {
  const ctx = await getRegisterSession();
  if (!ctx || !ctx.employee) {
    redirect("/register/login");
  }
  if (!hasPermission(ctx.employee.roleKey, permission)) {
    redirect("/register?error=Unauthorized");
  }
  return ctx;
}
