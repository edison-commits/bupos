import type { RoleKey } from "@/lib/domain/types";
import { hasPermission } from "@/lib/domain/permissions";

/**
 * Maps each admin route to the minimum roles that can access it.
 * This is a role-based access control (RBAC) mapping for admin pages.
 */
export const adminPageAccess: Record<string, RoleKey[]> = {
  "/admin/dashboard": ["owner", "manager", "cashier"],
  "/admin/transactions": ["owner", "manager", "cashier"],
  "/admin/returns": ["owner", "manager", "cashier"],
  "/admin/inventory": ["owner", "manager", "inventory_clerk"],
  "/admin/products": ["owner", "manager", "inventory_clerk"],
  "/admin/receiving": ["owner", "manager", "inventory_clerk"],
  "/admin/employees": ["owner", "manager"],
  "/admin/customers": ["owner", "manager", "cashier"],
  "/admin/shift-close": ["owner", "manager"],
  "/admin/cash-drawer": ["owner", "manager"],
  "/admin/reports": ["owner", "manager"],
  "/admin/audit": ["owner", "manager"],
  "/admin/purchase-orders": ["owner", "manager", "inventory_clerk"],
  "/admin/loyalty": ["owner", "manager"],
  "/admin/labels": ["owner", "manager", "inventory_clerk", "cashier"],
  "/admin/settings": ["owner"],
};

/**
 * Check if a given role can access a specific admin page.
 *
 * @param roleKey - The user's role key
 * @param path - The admin page path (e.g., "/admin/dashboard")
 * @returns true if the role can access the page, false otherwise
 */
export function canAccessPage(roleKey: RoleKey, path: string): boolean {
  const allowedRoles = adminPageAccess[path];
  if (!allowedRoles) {
    // If path is not in the mapping, deny by default
    return false;
  }
  return allowedRoles.includes(roleKey);
}

/**
 * Get all accessible admin pages for a given role.
 *
 * @param roleKey - The user's role key
 * @returns An array of admin page paths the role can access
 */
export function getAccessiblePages(roleKey: RoleKey): string[] {
  return Object.entries(adminPageAccess)
    .filter(([_path, roles]) => roles.includes(roleKey))
    .map(([path]) => path);
}
