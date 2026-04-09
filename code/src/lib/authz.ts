import { redirect } from "next/navigation";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";
import type { PermissionKey, RoleKey } from "@/lib/domain/types";
import { hasPermission, permissionsForRole } from "@/lib/domain/permissions";

// Re-export from the single source of truth
export { hasPermission, permissionsForRole };

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
