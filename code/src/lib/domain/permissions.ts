import type { PermissionKey, RoleDefinition } from "@/lib/domain/types";

const managerApprovals: PermissionKey[] = [
  "approval.discount",
  "approval.void_item",
  "approval.void_transaction",
  "approval.store_credit",
  "approval.price_override",
  "approval.cash_payout",
];

export const roleDefinitions: RoleDefinition[] = [
  {
    key: "owner",
    label: "Owner",
    description: "Full business visibility and configuration authority.",
    permissions: [
      "register.open",
      "register.pin_login",
      "catalog.manage",
      "inventory.adjust",
      "employee.manage",
      "audit.view",
      "reports.export",
      "pricing.manage",
      "online.manage",
      ...managerApprovals,
    ],
  },
  {
    key: "manager",
    label: "Manager",
    description: "Store manager with approval authority and team access.",
    permissions: [
      "register.open",
      "register.pin_login",
      "catalog.manage",
      "inventory.adjust",
      "employee.manage",
      "audit.view",
      "reports.export",
      "pricing.manage",
      "online.manage",
      ...managerApprovals,
    ],
  },
  {
    key: "cashier",
    label: "Cashier",
    description: "Register-focused employee using PIN-based session login.",
    permissions: ["register.open", "register.pin_login"],
  },
  {
    key: "inventory_clerk",
    label: "Inventory Clerk",
    description: "Catalog and stock support without register override powers.",
    permissions: ["catalog.manage", "inventory.adjust", "audit.view"],
  },
  {
    key: "support",
    label: "Support",
    description: "Operational read-focused support role.",
    permissions: ["audit.view"],
  },
];

export function permissionsForRole(roleKey: RoleDefinition["key"]) {
  return roleDefinitions.find((role) => role.key === roleKey)?.permissions ?? [];
}

export function hasPermission(roleKey: RoleDefinition["key"], permission: PermissionKey) {
  return permissionsForRole(roleKey).includes(permission);
}
