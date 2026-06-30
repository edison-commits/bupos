import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api/with-auth";
import { orgQuery } from "@/lib/supabase-rest";
import { safeErr } from "@/lib/logging/safe-err";
import { permissionsForRole, roleDefinitions } from "@/lib/domain/permissions";
import type { PermissionKey, RoleKey } from "@/lib/domain/types";

const SENSITIVE_PERMISSIONS: PermissionKey[] = [
  "employee.manage",
  "pricing.manage",
  "online.manage",
  "reports.export",
  "inventory.adjust",
  "approval.cash_payout",
  "approval.price_override",
  "approval.store_credit",
  "approval.void_transaction",
];

function labelForRole(roleKey: RoleKey) {
  return roleDefinitions.find((role) => role.key === roleKey)?.label ?? roleKey;
}

export const GET = withAdminAuth("employee.manage", async (_request, ctx) => {
  const { orgId } = ctx;
  try {
    const { rows } = await orgQuery(
      orgId,
      `SELECT e.id, e.display_name, e.email, e.role_key, e.is_active, e.location_ids,
              e.created_at, e.updated_at,
              COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id', l.id, 'name', l.name) ORDER BY l.name)
                FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS locations
       FROM employees e
       LEFT JOIN LATERAL unnest(e.location_ids) AS loc_id(id) ON true
       LEFT JOIN locations l ON l.id = loc_id.id AND l.organization_id = $1
       WHERE e.organization_id = $1
       GROUP BY e.id
       ORDER BY e.role_key ASC, e.is_active DESC, e.display_name ASC`,
      [orgId],
    );

    const employees = rows.map((row) => {
      const roleKey = row.role_key as RoleKey;
      const permissions = permissionsForRole(roleKey);
      const sensitivePermissions = permissions.filter((permission) => SENSITIVE_PERMISSIONS.includes(permission));
      return {
        id: row.id,
        displayName: row.display_name,
        email: row.email,
        roleKey,
        roleLabel: labelForRole(roleKey),
        isActive: Boolean(row.is_active),
        locationIds: row.location_ids ?? [],
        locations: row.locations ?? [],
        permissions,
        sensitivePermissions,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    const ownerCount = employees.filter((employee) => employee.roleKey === "owner" && employee.isActive).length;
    const inactivePrivilegedCount = employees.filter((employee) =>
      !employee.isActive && employee.sensitivePermissions.length > 0,
    ).length;
    const sensitiveEmployeeCount = employees.filter((employee) =>
      employee.isActive && employee.sensitivePermissions.length > 0,
    ).length;

    const roleSummaries = roleDefinitions.map((role) => {
      const roleEmployees = employees.filter((employee) => employee.roleKey === role.key);
      return {
        key: role.key,
        label: role.label,
        description: role.description,
        permissions: role.permissions,
        sensitivePermissions: role.permissions.filter((permission) => SENSITIVE_PERMISSIONS.includes(permission)),
        activeCount: roleEmployees.filter((employee) => employee.isActive).length,
        inactiveCount: roleEmployees.filter((employee) => !employee.isActive).length,
      };
    });

    return NextResponse.json({
      employees,
      roleDefinitions: roleSummaries,
      sensitivePermissions: SENSITIVE_PERMISSIONS,
      summary: {
        totalEmployees: employees.length,
        ownerCount,
        inactivePrivilegedCount,
        sensitiveEmployeeCount,
      },
    });
  } catch (error) {
    console.error("Role review GET error:", safeErr(error));
    return NextResponse.json({ error: "Failed to load role review" }, { status: 500 });
  }
});
