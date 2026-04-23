"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { hashSecret } from "@/lib/auth/crypto";
import { canManageEmployeeRole, requireAdminPermission } from "@/lib/authz";
import { signInAdmin, signOutAdmin } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { mutateStore } from "@/lib/persistence/store";
import type { RoleKey } from "@/lib/domain/types";
import {
  pgCreateCategory,
  pgCreateProduct,
  pgCreateVariant,
  VariantUniquenessConflictError,
  pgCreateInventoryLevel,
  pgAdjustInventory,
  pgCreateEmployee,
  pgToggleEmployee,
  pgReadEmployeeById,
  pgFindCredentialByEmail,
  pgInsertAuditEvent,
  pgUpdateOrganization,
  pgUpdateLocation,
  pgUpdateCategory,
  pgDeleteCategory,
  pgUpdateProduct,
  pgDeleteProduct,
  pgUpdateVariant,
  pgDeleteVariant,
} from "@/lib/persistence/postgres-store";

import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
const isPg = () => !!process.env.USE_POSTGRES;

function now() {
  return new Date().toISOString();
}

export async function adminLoginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  // Rate-limit by email to prevent password brute-force (5 attempts/min)
  const rl = checkRateLimit(`admin:${email}`);
  if (!rl.allowed) {
    const secs = Math.ceil(rl.retryAfterMs / 1000);
    redirect(`/?error=Too+many+login+attempts.+Try+again+in+${secs}+seconds`);
  }

  try {
    await signInAdmin(email, String(formData.get("password") ?? ""));
  } catch (err) {
    // Audit: log failed admin login attempt (non-fatal — redirect still proceeds).
    //
    // R15-L-3: previously passed `orgId ?? 'unknown'` to pgInsertAuditEvent,
    // which then fails the `app.current_org_id::uuid` cast inside orgTx.
    // pgInsertAuditEvent swallows the error, so brute-force probes of
    // non-existent emails left NO trace. Split the logic: write to the DB
    // only when we resolved a real orgId; otherwise emit a structured warn
    // log so the trail still exists for ops/security monitoring.
    if (isPg()) {
      try {
        const cred = await pgFindCredentialByEmail(email);
        let orgId: string | null = null;
        if (cred) {
          const { pool } = await import("@/lib/db");
          // check-pool-org-filter: scoped-by-just-looked-up-employee-id
          // cred.employeeId came from the email→credential lookup above;
          // this SELECT resolves the org from that row.
          const { rows } = await pool.query(
            `SELECT organization_id FROM employees WHERE id = $1 LIMIT 1`,
            [cred.employeeId],
          );
          orgId = (rows[0]?.organization_id as string) ?? null;
        }
        if (orgId) {
          // R42-K: classify to a stable reason string instead of
          // dumping the raw err.message into the audit payload (which
          // is persisted to DB + serialized to logs). A pg error
          // reaching this catch carries DETAIL with bound-param values
          // including the email being probed; persisting that into
          // audit_events.payload JSONB would expose attempted-login
          // emails via audit views accessible to org owners.
          const reason = err instanceof Error && /Invalid admin credentials/.test(err.message)
            ? "invalid_credentials"
            : "internal_error";
          await waitUntilOrAwait(pgInsertAuditEvent(
            orgId, null, cred?.employeeId ?? null,
            "session", null, "admin_login_failed",
            { email, reason },
          ).catch((err) => console.error("[audit] Failed to insert audit event:", safeErr(err))));
        } else {
          // Unknown-email attempt — no org to attribute to. Structured log
          // so log-sink alerting can still pattern-match brute-force probes.
          const reason = err instanceof Error && /Invalid admin credentials/.test(err.message)
            ? "invalid_credentials"
            : "internal_error";
          console.warn("[admin_login_failed]", JSON.stringify({
            email_prefix: email.slice(0, 3) + "***",
            reason,
            at: new Date().toISOString(),
          }));
        }
      } catch {
        // audit lookup failed — skip audit, still redirect
      }
    }
    redirect("/?error=Invalid+admin+credentials");
  }

  // Audit: log successful admin login (non-fatal — redirect still proceeds)
  if (isPg()) {
    const { getAdminSession } = await import("@/lib/auth/session");
    const ctx = await getAdminSession();
    if (ctx) {
      await waitUntilOrAwait(pgInsertAuditEvent(
        ctx.employee.organizationId, null, ctx.employee.id,
        "session", ctx.session.id, "admin_login",
        { email, role: ctx.employee.roleKey },
      ).catch((err) => console.error("[adminLoginAction] audit failed:", safeErr(err))));
    }
  }

  redirect("/admin?notice=Signed+in");
}

export async function adminLogoutAction() {
  // Capture session context before destroying the cookie
  let actorOrgId: string | null = null;
  let actorEmployeeId: string | null = null;
  let sessionId: string | null = null;
  if (isPg()) {
    const { getAdminSession } = await import("@/lib/auth/session");
    const ctx = await getAdminSession();
    if (ctx) {
      actorOrgId = ctx.employee.organizationId;
      actorEmployeeId = ctx.employee.id;
      sessionId = ctx.session.id;
    }
  }

  await signOutAdmin();

  // Audit: log admin logout (non-fatal — redirect still proceeds)
  if (isPg() && actorOrgId && actorEmployeeId) {
    await waitUntilOrAwait(pgInsertAuditEvent(
      actorOrgId, null, actorEmployeeId,
      "session", sessionId, "admin_logout",
      {},
    ).catch((err) => console.error("[adminLogoutAction] audit failed:", safeErr(err))));
  }

  redirect("/?notice=Signed+out");
}

export async function createCategoryAction(formData: FormData) {
  const { employee } = await requireAdminPermission("catalog.manage");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect("/admin?error=Category+name+is+required");
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const imageUrl = String(formData.get("imageUrl") ?? "").trim() || undefined;
  const timestamp = now();

  if (isPg()) {
    const id = randomUUID();
    const orgId = employee.organizationId;
    await pgCreateCategory({
      id, organizationId: orgId, name, slug,
      sortOrder: 0, imageUrl,
    });
    await pgInsertAuditEvent(orgId, null, employee.id, "category", id, "catalog_update", { action: "created", name });
  } else {
    await mutateStore((store) => {
      store.categories.push({
        id: randomUUID(),
        organizationId: store.organization.id,
        name,
        slug,
        parentCategoryId: undefined,
        sortOrder: store.categories.length + 1,
        imageUrl,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "txn_admin_catalog_placeholder",
        eventKind: "catalog_update",
        actorEmployeeId: employee.id,
        notes: `Created category ${name}`,
        payload: { entity: "category" },
        createdAt: timestamp,
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Category+created");
}

export async function createProductAction(formData: FormData) {
  const { employee } = await requireAdminPermission("catalog.manage");
  const name = String(formData.get("name") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "");
  const sku = String(formData.get("sku") ?? "").trim();
  const variantName = String(formData.get("variantName") ?? "Default").trim();
  const price = Number(formData.get("price") ?? 0);

  // R19-LOW-3: isFinite rejects NaN AND Infinity; isNaN only rejects NaN.
  // FormData can carry "Infinity" / "1e400" which Number() happily turns
  // into Infinity — Postgres NUMERIC accepts it since PG14 and corrupts
  // every downstream calculation referencing the row.
  if (!name || !categoryId || !sku || !Number.isFinite(price) || price <= 0) {
    redirect("/admin?error=Product+name,+category,+SKU,+and+price+are+required");
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const timestamp = now();
  const productId = randomUUID();
  const variantId = randomUUID();

  if (isPg()) {
    const orgId = employee.organizationId;
    const locationId = employee.locationIds[0] ?? "";
    // R23-H-2: `fk_products_default_variant_id` is NOT DEFERRABLE and
    // fires at INSERT time. The prior shape passed `defaultVariantId:
    // variantId` here — but the variant doesn't exist yet, so every
    // product-creation attempt through the admin UI 500'd with
    // "insert or update on table 'products' violates foreign key
    // constraint". Empirically verified on test DB.
    //
    // Fix: create product with `defaultVariantId: undefined`, then
    // create variant + inventory, then pgUpdateProduct to set the
    // default. Three separate txs — not atomic — but the orphan
    // failure mode (product exists without a default variant) is
    // already an admin-visible data state that's recoverable via
    // delete-or-retry. The alternative (making the FK DEFERRABLE via
    // migration + refactoring all three helpers to share a client)
    // is a much bigger surface and can land separately.
    await pgCreateProduct({
      id: productId, organizationId: orgId, categoryId, name, slug,
      description: String(formData.get("description") ?? "").trim() || undefined,
      imageUrl: String(formData.get("imageUrl") ?? "").trim() || undefined,
      isActive: true, isTouchFavorite: formData.get("isTouchFavorite") === "on",
      defaultVariantId: undefined, modifierGroupIds: [],
    });
    try {
      await pgCreateVariant({
        id: variantId, organizationId: orgId, productId, sku,
        barcode: String(formData.get("barcode") ?? "").trim() || undefined,
        name: variantName,
        sizeLabel: String(formData.get("sizeLabel") ?? "").trim() || undefined,
        colorLabel: String(formData.get("colorLabel") ?? "").trim() || undefined,
        price, cost: Number(formData.get("cost") ?? 0) || undefined,
        compareAtPrice: Number(formData.get("compareAtPrice") ?? 0) || undefined,
        isActive: true,
      });
    } catch (err) {
      // R22-M-1: SKU/barcode partial-unique collision → friendly redirect.
      // R23-H-2: clean up the product row we already inserted so the
      // orphan doesn't persist if we catch-and-redirect. Fire-and-
      // forget cleanup — failure to delete the orphan is logged but
      // doesn't block the user-facing redirect.
      if (err instanceof VariantUniquenessConflictError) {
        await pgDeleteProduct(productId, orgId).catch((cleanupErr) =>
          console.error("[createProductAction] orphan product cleanup failed:", safeErr(cleanupErr)),
        );
        redirect(`/admin?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    await pgCreateInventoryLevel({
      id: randomUUID(), organizationId: orgId, locationId,
      productVariantId: variantId,
      onHand: Number(formData.get("openingStock") ?? 0) || 0,
      reserved: 0, reorderPoint: Number(formData.get("reorderPoint") ?? 0) || 0,
    });
    // Now that the variant exists, point product.default_variant_id at it.
    await pgUpdateProduct(productId, { defaultVariantId: variantId }, orgId);
    await pgInsertAuditEvent(orgId, locationId, employee.id, "product", productId, "catalog_update", { action: "created", name, sku });
  } else {
    await mutateStore((store) => {
      store.products.push({
        id: productId, organizationId: store.organization.id, categoryId, name, slug,
        description: String(formData.get("description") ?? "").trim() || undefined,
        imageUrl: String(formData.get("imageUrl") ?? "").trim() || undefined,
        isActive: true, isTouchFavorite: formData.get("isTouchFavorite") === "on",
        defaultVariantId: variantId, modifierGroupIds: [],
        createdAt: timestamp, updatedAt: timestamp,
      });
      store.variants.push({
        id: variantId, organizationId: store.organization.id, productId, sku,
        barcode: String(formData.get("barcode") ?? "").trim() || undefined,
        name: variantName,
        sizeLabel: String(formData.get("sizeLabel") ?? "").trim() || undefined,
        colorLabel: String(formData.get("colorLabel") ?? "").trim() || undefined,
        price, cost: Number(formData.get("cost") ?? 0) || undefined,
        compareAtPrice: Number(formData.get("compareAtPrice") ?? 0) || undefined,
        isActive: true, createdAt: timestamp, updatedAt: timestamp,
      });
      const locationId = store.locations[0]?.id;
      if (locationId) {
        store.inventory.push({
          id: randomUUID(), organizationId: store.organization.id, locationId,
          productVariantId: variantId,
          onHand: Number(formData.get("openingStock") ?? 0) || 0,
          reserved: 0, reorderPoint: Number(formData.get("reorderPoint") ?? 0) || 0,
          createdAt: timestamp, updatedAt: timestamp,
        });
      }
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(), transactionId: "txn_admin_catalog_placeholder",
        eventKind: "catalog_update", actorEmployeeId: employee.id,
        notes: `Created product ${name}`, payload: { entity: "product", sku },
        createdAt: timestamp,
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Product+created");
}

export async function adjustInventoryAction(formData: FormData) {
  const { employee } = await requireAdminPermission("inventory.adjust");
  const inventoryLevelId = String(formData.get("inventoryLevelId") ?? "");
  const delta = Number(formData.get("delta") ?? 0);
  const reason = String(formData.get("reason") ?? "").trim();
  const actorPassword = String(formData.get("actorPassword") ?? "");

  if (!inventoryLevelId || !reason || !Number.isFinite(delta) || delta === 0) {
    redirect("/admin?error=Inventory+adjustment+needs+row,+delta,+and+reason");
  }

  // R34-D5: step-up auth on large deltas. The per-adjust cap (±10k
  // manager / ±1k clerk at R28-H6) plus rate-limit (20/5min at
  // R31-H3) together cap blast radius, but a compromised manager
  // cookie can still mint +10k × 20 = 200k phantom units in a 5-min
  // window. High-delta step-up forces the attacker to ALSO have the
  // password — matches the financial-issuance patterns at R32-H10.
  // Thresholds: |delta| > 500 for clerks, > 5_000 for managers.
  const HIGH_DELTA_MANAGER = 5_000;
  const HIGH_DELTA_CLERK = 500;
  const isPrivileged = employee.roleKey === "owner" || employee.roleKey === "manager";
  const highDeltaThreshold = isPrivileged ? HIGH_DELTA_MANAGER : HIGH_DELTA_CLERK;
  if (Math.abs(delta) > highDeltaThreshold) {
    const { requireStepUp } = await import('@/lib/auth/step-up');
    const stepUp = await requireStepUp({
      actorId: employee.id,
      orgId: employee.organizationId,
      actorPassword,
      bucketKey: 'inventory-adjust-stepup',
    });
    if (!stepUp.ok) {
      redirect(`/admin?error=${encodeURIComponent(stepUp.error)}`);
    }
  }

  // R28-H6: delta bounds.
  //
  // |delta| ≤ 10_000 per call: covers every legitimate stocktake
  // variance (damaged/missing/found goods) at a single-location POS.
  // Beyond that, a manager submitting +/- 10_000 on a high-value SKU
  // is either running a pilferage cloaking attack (mint phantom stock,
  // then "sell" / move it off-books) or fat-fingering a decimal. Both
  // deserve manager re-confirmation; block here and require the
  // admin to break it into multiple smaller adjustments, each
  // individually audit-visible.
  //
  // Separately, clerk-role (inventory.adjust) callers get a tighter
  // cap (±1_000) so a compromised clerk cookie can't mint enough
  // stock for meaningful pilferage without tripping manager-required
  // approval. Owner/manager get the higher cap. The threshold lives
  // here rather than in pgAdjustInventory so the helper stays a
  // pure-write primitive that other callers (e.g., stocktake accept)
  // don't have to coordinate around.
  const MAX_DELTA_MANAGER = 10_000;
  const MAX_DELTA_CLERK = 1_000;
  const isManager = employee.roleKey === "owner" || employee.roleKey === "manager";
  const cap = isManager ? MAX_DELTA_MANAGER : MAX_DELTA_CLERK;
  if (Math.abs(delta) > cap) {
    redirect(`/admin?error=Inventory+adjustment+exceeds+${cap}+unit+cap.+Split+into+smaller+adjustments.`);
  }

  // R31-H3: per-employee rate-limit. Without a cap an attacker with a
  // stolen cookie can loop adjusts under the cap (±1_000 clerk ×
  // 60/min = 60k minted units per minute). 20 per 5 min is above
  // normal ops use; a legitimate stocktake goes through
  // `acceptStocktakeAction`, not individual adjusts.
  const { checkRateLimit } = await import("@/lib/auth/rate-limit");
  const rl = checkRateLimit(
    `inventory-adjust:${employee.organizationId}:${employee.id}`,
    { maxAttempts: 20, windowMs: 300_000 },
  );
  if (!rl.allowed) {
    redirect("/admin?error=Too+many+inventory+adjustments.+Try+again+in+a+few+minutes.");
  }

  if (isPg()) {
    // R31-H2: verify the inventoryLevelId belongs to a location the
    // caller is assigned to (non-managers only — owners/managers keep
    // org-wide scope). Prior shape trusted the admin's client-supplied
    // id, so a clerk at Store A could pull Store B's inventoryLevelId
    // from /api/inventory (when switching location context in the UI)
    // and submit +1000 to Store B's stock — phantom inventory at a
    // store they don't work at, bypass of location assignment.
    if (!isManager) {
      const { rows: invLocRows } = await (await import("@/lib/db")).default.query(
        `SELECT location_id FROM inventory_levels WHERE id = $1 AND organization_id = $2`,
        [inventoryLevelId, employee.organizationId],
      );
      const invLocationId = invLocRows[0]?.location_id as string | undefined;
      if (!invLocationId) {
        redirect("/admin?error=Inventory+row+not+found");
      }
      if (!(employee.locationIds ?? []).includes(invLocationId)) {
        // Generic "not found" — don't leak that the row exists at a
        // location the caller doesn't have access to.
        redirect("/admin?error=Inventory+row+not+found");
      }
    }
    const { level } = await pgAdjustInventory(inventoryLevelId, delta, employee.id, reason, employee.organizationId);
    await pgInsertAuditEvent(level.organizationId, level.locationId, employee.id, "inventory_level", inventoryLevelId, "inventory_adjustment", { delta, reason });
  } else {
    await mutateStore((store) => {
      const timestamp = now();
      const inventoryRow = store.inventory.find((entry) => entry.id === inventoryLevelId);
      if (!inventoryRow) {
        redirect("/admin?error=Inventory+row+not+found");
      }
      inventoryRow.onHand = Math.max(0, inventoryRow.onHand + delta);
      inventoryRow.updatedAt = timestamp;
      store.inventoryAdjustments.unshift({
        id: randomUUID(), inventoryLevelId: inventoryRow.id,
        productVariantId: inventoryRow.productVariantId, locationId: inventoryRow.locationId,
        employeeId: employee.id, reason, delta, resultingOnHand: inventoryRow.onHand, createdAt: timestamp,
      });
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(), transactionId: "txn_inventory_placeholder",
        eventKind: "inventory_adjustment", actorEmployeeId: employee.id,
        notes: `${reason} (${delta > 0 ? "+" : ""}${delta})`,
        payload: { inventory_level_id: inventoryRow.id }, createdAt: timestamp,
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Inventory+updated");
}

export async function createEmployeeAction(formData: FormData) {
  const { employee } = await requireAdminPermission("employee.manage");
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const roleKey = String(formData.get("roleKey") ?? "cashier") as RoleKey;
  const pin = String(formData.get("pin") ?? "").trim();
  const actorPassword = String(formData.get("actorPassword") ?? "");

  if (!firstName || !lastName || !/^\d{4}$/.test(pin)) {
    redirect("/admin?error=Employee+needs+name+and+4-digit+PIN");
  }

  if (!canManageEmployeeRole(employee.roleKey, roleKey)) {
    redirect("/admin?error=You+cannot+provision+that+role");
  }

  // R49: step-up re-auth on employee provisioning. Creating an employee
  // — especially an owner/manager with admin-capable password — is a
  // privilege-elevation action. A stolen cookie shouldn't be able to
  // mint shadow admin accounts. Matches the REST /api/employees POST
  // gate once actorPassword is wired through the admin UI.
  const { requireStepUp } = await import('@/lib/auth/step-up');
  const stepUp = await requireStepUp({
    actorId: employee.id,
    orgId: employee.organizationId,
    actorPassword,
    bucketKey: 'employees-create-stepup',
  });
  if (!stepUp.ok) {
    redirect(`/admin?error=${encodeURIComponent(stepUp.error)}`);
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase() || undefined;
  const password = String(formData.get("password") ?? "").trim();

  if (["owner", "manager"].includes(roleKey) && !password) {
    redirect("/admin?error=Admin-capable+roles+need+a+password");
  }

  if (isPg()) {
    const employeeId = randomUUID();
    const orgId = employee.organizationId;
    await pgCreateEmployee({
      id: employeeId, organizationId: orgId, roleKey, firstName, lastName,
      displayName: `${firstName} ${lastName[0] ?? ""}.`.trim(),
      email, pinHash: await hashSecret(pin),
      passwordHash: password ? await hashSecret(password) : undefined,
      pinHint: `4-digit ${roleKey.replace("_", " ")} PIN`,
      isActive: true, locationIds: employee.locationIds,
    });
    await pgInsertAuditEvent(orgId, null, employee.id, "employee", employeeId, "catalog_update", { action: "created_employee", name: `${firstName} ${lastName}` });
  } else {
    const timestamp = now();
    const pinHashVal = await hashSecret(pin);
    const passwordHashVal = password ? await hashSecret(password) : undefined;
    await mutateStore((store) => {
      const employeeId = randomUUID();
      store.employees.push({
        id: employeeId, organizationId: store.organization.id,
        locationIds: [store.locations[0].id], roleKey, firstName, lastName,
        displayName: `${firstName} ${lastName[0] ?? ""}.`.trim(),
        email, pinHint: `4-digit ${roleKey.replace("_", " ")} PIN`,
        isActive: true, createdAt: timestamp, updatedAt: timestamp,
      });
      store.authCredentials.push({
        employeeId, email,
        passwordHash: passwordHashVal,
        pinHash: pinHashVal,
        passwordLastRotatedAt: password ? timestamp : undefined,
        pinLastRotatedAt: timestamp,
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Employee+created");
}

export async function toggleEmployeeAction(formData: FormData) {
  const { employee: actor } = await requireAdminPermission("employee.manage");
  const employeeId = String(formData.get("employeeId") ?? "");
  const actorPassword = String(formData.get("actorPassword") ?? "");

  // R49: step-up re-auth. Mirrors the REST /api/employees PATCH gate
  // (bucketKey 'employees-patch-stepup') so both surfaces share the
  // same step-up bucket aggregate. Toggling active status can lock
  // out peers or reactivate terminated employees — never a low-
  // privilege action.
  const { requireStepUp } = await import('@/lib/auth/step-up');
  const stepUp = await requireStepUp({
    actorId: actor.id,
    orgId: actor.organizationId,
    actorPassword,
    bucketKey: 'employees-patch-stepup',
  });
  if (!stepUp.ok) {
    redirect(`/admin?error=${encodeURIComponent(stepUp.error)}`);
  }

  let newStatus: boolean | null = null;
  if (isPg()) {
    const target = await pgReadEmployeeById(employeeId, actor.organizationId);
    if (!target) redirect("/admin?error=Employee+not+found");
    if (!canManageEmployeeRole(actor.roleKey, target!.roleKey)) {
      redirect("/admin?error=You+cannot+change+that+employee");
    }
    newStatus = !target!.isActive;
    const toggled = await pgToggleEmployee(employeeId, actor.organizationId);
    if (!toggled) redirect("/admin?error=Employee+not+found");
    await pgInsertAuditEvent(
      actor.organizationId, null, actor.id,
      "employee", employeeId, "employee_status_changed",
      { action: newStatus ? "activated" : "deactivated", target_role: target!.roleKey },
    );
  } else {
    await mutateStore((store) => {
      const employee = store.employees.find((entry) => entry.id === employeeId);
      if (!employee) redirect("/admin?error=Employee+not+found");
      if (!canManageEmployeeRole(actor.roleKey, employee!.roleKey)) {
        redirect("/admin?error=You+cannot+change+that+employee");
      }
      newStatus = !employee!.isActive;
      employee!.isActive = newStatus;
      employee!.updatedAt = now();
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Employee+status+updated");
}

// ── Edit/Delete catalog actions ───────────────────────────────────

export async function editCategoryAction(formData: FormData) {
  const { employee } = await requireAdminPermission("catalog.manage");
  const categoryId = String(formData.get("categoryId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  
  if (!categoryId || !name) {
    redirect("/admin?error=Category+ID+and+name+are+required");
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const imageUrl = String(formData.get("imageUrl") ?? "").trim() || undefined;

  if (isPg()) {
    const orgId = employee.organizationId;
    await pgUpdateCategory(categoryId, { name, slug, imageUrl }, employee.organizationId);
    await pgInsertAuditEvent(orgId, null, employee.id, "category", categoryId, "catalog_update", { action: "updated", name });
  } else {
    await mutateStore((store) => {
      const category = store.categories.find((c) => c.id === categoryId);
      if (!category) {
        redirect("/admin?error=Category+not+found");
      }
      category.name = name;
      category.slug = slug;
      category.imageUrl = imageUrl;
      category.updatedAt = now();
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "txn_admin_catalog_placeholder",
        eventKind: "catalog_update",
        actorEmployeeId: employee.id,
        notes: `Updated category ${name}`,
        payload: { entity: "category" },
        createdAt: now(),
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Category+updated");
}

export async function deleteCategoryAction(formData: FormData) {
  const { employee } = await requireAdminPermission("catalog.manage");
  const categoryId = String(formData.get("categoryId") ?? "");

  if (!categoryId) {
    redirect("/admin?error=Category+ID+is+required");
  }

  if (isPg()) {
    const orgId = employee.organizationId;
    await pgDeleteCategory(categoryId, employee.organizationId);
    await pgInsertAuditEvent(orgId, null, employee.id, "category", categoryId, "catalog_update", { action: "deleted" });
  } else {
    await mutateStore((store) => {
      const index = store.categories.findIndex((c) => c.id === categoryId);
      if (index === -1) {
        redirect("/admin?error=Category+not+found");
      }
      const deleted = store.categories.splice(index, 1)[0];
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "txn_admin_catalog_placeholder",
        eventKind: "catalog_update",
        actorEmployeeId: employee.id,
        notes: `Deleted category ${deleted.name}`,
        payload: { entity: "category" },
        createdAt: now(),
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Category+deleted");
}

export async function editProductAction(formData: FormData) {
  const { employee } = await requireAdminPermission("catalog.manage");
  const productId = String(formData.get("productId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "");
  const description = String(formData.get("description") ?? "").trim() || undefined;
  const imageUrl = String(formData.get("imageUrl") ?? "").trim() || undefined;
  const isActive = formData.get("isActive") === "on";
  const isTouchFavorite = formData.get("isTouchFavorite") === "on";

  if (!productId || !name || !categoryId) {
    redirect("/admin?error=Product+ID,+name,+and+category+are+required");
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  if (isPg()) {
    const orgId = employee.organizationId;
    await pgUpdateProduct(productId, { name, slug, categoryId, description, imageUrl, isActive, isTouchFavorite }, employee.organizationId);
    await pgInsertAuditEvent(orgId, null, employee.id, "product", productId, "catalog_update", { action: "updated", name });
  } else {
    await mutateStore((store) => {
      const product = store.products.find((p) => p.id === productId);
      if (!product) {
        redirect("/admin?error=Product+not+found");
      }
      product.name = name;
      product.slug = slug;
      product.categoryId = categoryId;
      product.description = description;
      product.imageUrl = imageUrl;
      product.isActive = isActive;
      product.isTouchFavorite = isTouchFavorite;
      product.updatedAt = now();
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "txn_admin_catalog_placeholder",
        eventKind: "catalog_update",
        actorEmployeeId: employee.id,
        notes: `Updated product ${name}`,
        payload: { entity: "product" },
        createdAt: now(),
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Product+updated");
}

export async function deleteProductAction(formData: FormData) {
  const { employee } = await requireAdminPermission("catalog.manage");
  const productId = String(formData.get("productId") ?? "");

  if (!productId) {
    redirect("/admin?error=Product+ID+is+required");
  }

  if (isPg()) {
    const orgId = employee.organizationId;
    await pgDeleteProduct(productId, employee.organizationId);
    await pgInsertAuditEvent(orgId, null, employee.id, "product", productId, "catalog_update", { action: "deleted" });
  } else {
    await mutateStore((store) => {
      const index = store.products.findIndex((p) => p.id === productId);
      if (index === -1) {
        redirect("/admin?error=Product+not+found");
      }
      const deleted = store.products.splice(index, 1)[0];
      store.variants = store.variants.filter((v) => v.productId !== productId);
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "txn_admin_catalog_placeholder",
        eventKind: "catalog_update",
        actorEmployeeId: employee.id,
        notes: `Deleted product ${deleted.name}`,
        payload: { entity: "product" },
        createdAt: now(),
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Product+deleted");
}

export async function editVariantAction(formData: FormData) {
  const { employee } = await requireAdminPermission("catalog.manage");
  const variantId = String(formData.get("variantId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim();
  const barcode = String(formData.get("barcode") ?? "").trim() || undefined;
  const price = Number(formData.get("price") ?? 0);
  const cost = Number(formData.get("cost") ?? 0) || undefined;
  const sizeLabel = String(formData.get("sizeLabel") ?? "").trim() || undefined;
  const colorLabel = String(formData.get("colorLabel") ?? "").trim() || undefined;
  const isActive = formData.get("isActive") === "on";
  const actorPassword = String(formData.get("actorPassword") ?? "");

  if (!variantId || !name || !sku || !Number.isFinite(price) || price <= 0) {
    redirect("/admin?error=Variant+ID,+name,+SKU,+and+valid+price+are+required");
  }

  // R33-H4: variant price + cost mutations require pricing.manage.
  // catalog.manage is enough to create/rename variants (SKU, barcode,
  // size/color labels) — but not to reprice. Matches the /api/products
  // PUT gate so the two admin-writable surfaces stay consistent.
  const { hasPermission } = await import("@/lib/domain/permissions");
  if (!hasPermission(employee.roleKey, "pricing.manage")) {
    redirect("/admin?error=Pricing+changes+require+owner+or+manager+role");
  }

  if (isPg()) {
    const orgId = employee.organizationId;

    // R49: step-up re-auth when price OR cost actually CHANGES. Snapshot
    // the pre-value and compare — the form posts the same fields every
    // time (including unchanged price), so gating on field presence
    // would friction every edit. Comparing real before/after bounds
    // the step-up ask to genuine price moves — the fraud-relevant edit.
    const { orgQuery } = await import("@/lib/supabase-rest");
    const { rows: priorRows } = await orgQuery(
      orgId,
      `SELECT price, cost FROM product_variants WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [variantId, orgId],
    );
    const prior = priorRows[0] as { price: string; cost: string | null } | undefined;
    const priorPrice = prior ? Number(prior.price) : null;
    const priorCost = prior?.cost != null ? Number(prior.cost) : null;
    const priceChanged = priorPrice !== null && Math.abs(priorPrice - price) > 0.005;
    const costChanged = cost !== undefined && priorCost !== null && Math.abs(priorCost - cost) > 0.005;
    if (priceChanged || costChanged) {
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const stepUp = await requireStepUp({
        actorId: employee.id,
        orgId,
        actorPassword,
        bucketKey: 'variant-price-stepup',
      });
      if (!stepUp.ok) {
        redirect(`/admin?error=${encodeURIComponent(stepUp.error)}`);
      }
    }

    try {
      await pgUpdateVariant(variantId, { name, sku, barcode, price, cost, sizeLabel, colorLabel, isActive }, employee.organizationId);
    } catch (err) {
      // R22-M-1: reactivating / renaming into a conflicting SKU/barcode
      // collides with uniq_product_variants_org_{sku,barcode}_active.
      if (err instanceof VariantUniquenessConflictError) {
        redirect(`/admin?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    await pgInsertAuditEvent(orgId, null, employee.id, "variant", variantId, "catalog_update", { action: "updated", name, sku });
  } else {
    await mutateStore((store) => {
      const variant = store.variants.find((v) => v.id === variantId);
      if (!variant) {
        redirect("/admin?error=Variant+not+found");
      }
      variant.name = name;
      variant.sku = sku;
      variant.barcode = barcode;
      variant.price = price;
      variant.cost = cost;
      variant.sizeLabel = sizeLabel;
      variant.colorLabel = colorLabel;
      variant.isActive = isActive;
      variant.updatedAt = now();
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "txn_admin_catalog_placeholder",
        eventKind: "catalog_update",
        actorEmployeeId: employee.id,
        notes: `Updated variant ${name}`,
        payload: { entity: "variant", sku },
        createdAt: now(),
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Variant+updated");
}

export async function deleteVariantAction(formData: FormData) {
  const { employee } = await requireAdminPermission("catalog.manage");
  const variantId = String(formData.get("variantId") ?? "");

  if (!variantId) {
    redirect("/admin?error=Variant+ID+is+required");
  }

  if (isPg()) {
    const orgId = employee.organizationId;
    await pgDeleteVariant(variantId, employee.organizationId);
    await pgInsertAuditEvent(orgId, null, employee.id, "variant", variantId, "catalog_update", { action: "deleted" });
  } else {
    await mutateStore((store) => {
      const index = store.variants.findIndex((v) => v.id === variantId);
      if (index === -1) {
        redirect("/admin?error=Variant+not+found");
      }
      const deleted = store.variants.splice(index, 1)[0];
      store.transactionEventPlaceholders.unshift({
        id: randomUUID(),
        transactionId: "txn_admin_catalog_placeholder",
        eventKind: "catalog_update",
        actorEmployeeId: employee.id,
        notes: `Deleted variant ${deleted.name}`,
        payload: { entity: "variant", sku: deleted.sku },
        createdAt: now(),
      });
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Variant+deleted");
}

// ── Settings actions ──────────────────────────────────────────────────

export async function updateOrganizationAction(formData: FormData) {
  // Match the REST /api/settings gate (employee.manage). catalog.manage is
  // also held by inventory_clerk, who should NOT be able to change org
  // identity, receipt wording, etc.
  const { employee } = await requireAdminPermission("employee.manage");
  const orgId = employee.organizationId;

  if (isPg()) {
    await pgUpdateOrganization(orgId, {
      name: String(formData.get("name") ?? "").trim() || undefined,
      legalName: String(formData.get("legalName") ?? "").trim() || undefined,
      phone: String(formData.get("phone") ?? "").trim(),
      email: String(formData.get("email") ?? "").trim(),
      website: String(formData.get("website") ?? "").trim(),
      receiptHeader: String(formData.get("receiptHeader") ?? "").trim(),
      receiptFooter: String(formData.get("receiptFooter") ?? "").trim(),
    });
    await pgInsertAuditEvent(orgId, null, employee.id, "organization", orgId, "settings_update", { action: "updated_organization" });
  } else {
    await mutateStore((store) => {
      store.organization.name = String(formData.get("name") ?? "").trim() || store.organization.name;
      store.organization.legalName = String(formData.get("legalName") ?? "").trim() || store.organization.legalName;
      store.organization.updatedAt = now();
    });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Store+settings+updated");
}

export async function updateLocationAction(formData: FormData) {
  // taxRate affects every checkout — gate above catalog.manage so an
  // inventory_clerk can't silently retarget tax collection.
  const { employee } = await requireAdminPermission("employee.manage");
  const locationId = String(formData.get("locationId") ?? "").trim();
  if (!locationId) redirect("/admin?error=Missing+location");

  const taxRateRaw = String(formData.get("taxRate") ?? "").trim();
  const taxRatePercent = Number.parseFloat(taxRateRaw);
  const taxRate = Number.isFinite(taxRatePercent) ? taxRatePercent / 100 : undefined;

  // R44-H: step-up when tax rate is being changed. Server-action form
  // submissions carry `actorPassword` in the FormData when the UI
  // prompts via <PasswordGate>. Other fields (name/address/phone) are
  // low-blast-radius and don't need the gate.
  //
  // R52-G: snapshot-compare against prior taxRate so the gate fires
  // ONLY when the value actually changed. Prior shape gated on
  // `taxRate !== undefined` — but the form posts taxRate on every
  // save (defaultValue is set), so every single save triggered the
  // step-up. Legitimate name/address/phone edits errored with
  // "password required" on every attempt. Mirror the editVariant
  // pattern: compare new tax vs prior with a small epsilon to
  // absorb floating-point noise, gate only on real change.
  if (taxRate !== undefined && isPg()) {
    const { orgQuery } = await import("@/lib/supabase-rest");
    const { rows: priorRows } = await orgQuery(
      employee.organizationId,
      `SELECT tax_rate FROM locations WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [locationId, employee.organizationId],
    );
    const priorTax = priorRows[0]?.tax_rate != null ? Number(priorRows[0].tax_rate) : null;
    const taxChanged = priorTax === null || Math.abs(priorTax - taxRate) > 0.00005;
    if (taxChanged) {
      const actorPassword = String(formData.get("actorPassword") ?? "");
      const { requireStepUp } = await import("@/lib/auth/step-up");
      const stepUp = await requireStepUp({
        actorId: employee.id,
        orgId: employee.organizationId,
        actorPassword,
        bucketKey: "tax-rate-stepup",
      });
      if (!stepUp.ok) {
        redirect(`/admin?error=${encodeURIComponent(stepUp.error)}`);
      }
    }
  }

  if (isPg()) {
    await pgUpdateLocation(locationId, {
      name: String(formData.get("locationName") ?? "").trim() || undefined,
      address1: String(formData.get("address1") ?? "").trim() || undefined,
      city: String(formData.get("city") ?? "").trim() || undefined,
      region: String(formData.get("region") ?? "").trim() || undefined,
      postalCode: String(formData.get("postalCode") ?? "").trim() || undefined,
      phone: String(formData.get("locationPhone") ?? "").trim(),
      taxRate,
    }, employee.organizationId);
    await pgInsertAuditEvent(employee.organizationId, locationId, employee.id, "location", locationId, "settings_update", { action: "updated_location", taxRate });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Location+settings+updated");
}
