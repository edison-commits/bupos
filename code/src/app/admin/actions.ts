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
  pgCreateProduct,
  pgCreateVariant,
  VariantUniquenessConflictError,
  pgCreateInventoryLevel,
  pgAdjustInventory,
  pgFindCredentialByEmail,
  pgInsertAuditEvent,
  pgUpdateProduct,
  pgDeleteProduct,
  invalidateProductsCache,
  invalidateVariantsCache,
  invalidateLocationsCache,
  invalidateEmployeesCache,
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
    // R54-M: INSERT + audit inline in one orgTx so the create is
    // atomic with its audit row. Prior shape: pgCreateCategory (own
    // tx) then pgInsertAuditEvent (separate tx) — if the second tx
    // failed, the category landed without an audit trail. Matches
    // the in-tx audit pattern established in R49 for REST routes.
    const { orgTx } = await import("@/lib/db");
    const ts = new Date().toISOString();
    const client = await orgTx(orgId);
    try {
      await client.query(
        `INSERT INTO categories (id, organization_id, slug, name, sort_order, image_url, parent_category_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [id, orgId, slug, name, 0, imageUrl ?? null, null, ts],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'category', $5, 'catalog_update', $6, now())`,
        [randomUUID(), orgId, null, employee.id, id, JSON.stringify({ action: "created", name })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
    // R54-M: drift retained — createProductAction's pg flow is FOUR
    // already-separate txs (pgCreateProduct → pgCreateVariant →
    // pgCreateInventoryLevel → pgUpdateProduct.default_variant_id),
    // each inside its own orgTx internally, because the
    // `fk_products_default_variant_id` FK is NOT DEFERRABLE (R23-H-2
    // rationale in comments above). Collapsing into one tx would
    // require migrating the FK to DEFERRABLE INITIALLY DEFERRED —
    // out of scope for R54. Until then the audit row is already
    // effectively post-create; track for a future refactor.
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
    // R54-M: drift retained — pgAdjustInventory is too complex to
    // inline (SELECT FOR UPDATE on inventory_levels, applied-delta
    // computation vs on_hand floor, INSERT into inventory_adjustments
    // + cache cascade). Collapsing it would require either
    // duplicating all that logic here or widening the pg* signature
    // to accept an optional `client?: PoolClient` — the latter is
    // Approach 3 (too invasive for this round per R54 charter).
    // Track for a future refactor; the window for audit loss is
    // only a transient audit-tx failure after the inventory UPDATE
    // committed, which is logged structured by pgInsertAuditEvent.
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
    // R54-M: INSERT employees + auth_credentials + audit ALL in one
    // orgTx. Prior shape: pgCreateEmployee (own tx wrapping the two
    // INSERTs) → pgInsertAuditEvent (separate tx). Auth-capable
    // employee creation is a privilege-elevation action; the audit
    // row must land with the mint or not at all.
    const pinHash = await hashSecret(pin);
    const passwordHash = password ? await hashSecret(password) : undefined;
    const displayName = `${firstName} ${lastName[0] ?? ""}.`.trim();
    const pinHint = `4-digit ${roleKey.replace("_", " ")} PIN`;
    const ts = new Date().toISOString();
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    try {
      await client.query(
        `INSERT INTO employees (id, organization_id, role_key, first_name, last_name, display_name, email, pin_hint, is_active, location_ids, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11, $11)`,
        [employeeId, orgId, roleKey, firstName, lastName, displayName, email ?? null, pinHint, true, employee.locationIds, ts],
      );
      // check-pool-org-filter: scoped-by-just-created-employee
      // employee_id was just INSERTed above into this org; auth_credentials
      // has no organization_id column (tenancy derives through employees FK).
      await client.query(
        `INSERT INTO auth_credentials (employee_id, email, password_hash, pin_hash, pin_last_rotated_at, failed_pin_attempts, last_failed_pin_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, NULL, $5, $5)`,
        [employeeId, email ?? null, passwordHash ?? null, pinHash, ts],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'employee', $5, 'catalog_update', $6, now())`,
        [randomUUID(), orgId, null, employee.id, employeeId, JSON.stringify({ action: "created_employee", name: `${firstName} ${lastName}` })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Mirror pgCreateEmployee's cache invalidation.
    invalidateEmployeesCache(orgId);
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
    // R54-M: lock + role-check + toggle + audit ALL in one orgTx.
    //
    // Prior shape did pgReadEmployeeById (own conn, no lock) → role
    // permission check → pgToggleEmployee (own tx: SELECT FOR UPDATE
    // + UPDATE) → pgInsertAuditEvent (separate tx). Two drift vectors:
    //   • Audit could drop if its tx failed after the toggle landed.
    //   • A concurrent toggle between the read and the FOR UPDATE
    //     could flip the row twice in aggregate (not a security
    //     break, but audit rows could misreport net direction).
    //
    // Inline all four steps: SELECT FOR UPDATE (same as
    // pgToggleEmployee), permission check on the locked row's
    // role, UPDATE, audit, COMMIT.
    const orgId = actor.organizationId;
    type ToggleEmpOutcome =
      | { kind: "ok" }
      | { kind: "not_found" }
      | { kind: "denied" };
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    let outcome: ToggleEmpOutcome = { kind: "ok" };
    let targetRole = "";
    try {
      const { rows: empRows } = await client.query(
        `SELECT role_key, is_active FROM employees WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [employeeId, orgId],
      );
      if (empRows.length === 0) {
        await client.query("ROLLBACK").catch(() => {});
        outcome = { kind: "not_found" };
      } else {
        targetRole = empRows[0].role_key as string;
        if (!canManageEmployeeRole(actor.roleKey, targetRole as RoleKey)) {
          await client.query("ROLLBACK").catch(() => {});
          outcome = { kind: "denied" };
        } else {
          newStatus = !(empRows[0].is_active as boolean);
          await client.query(
            `UPDATE employees SET is_active = NOT is_active, updated_at = $1
             WHERE id = $2 AND organization_id = $3`,
            [new Date().toISOString(), employeeId, orgId],
          );
          await client.query(
            `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, 'employee', $5, 'employee_status_changed', $6, now())`,
            [
              randomUUID(), orgId, null, actor.id, employeeId,
              JSON.stringify({ action: newStatus ? "activated" : "deactivated", target_role: targetRole }),
            ],
          );
          await client.query("COMMIT");
        }
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (outcome.kind === "ok") {
      // Mirror pgToggleEmployee's cache invalidation on the happy path.
      invalidateEmployeesCache(orgId);
    }
    if (outcome.kind === "not_found") redirect("/admin?error=Employee+not+found");
    if (outcome.kind === "denied") redirect("/admin?error=You+cannot+change+that+employee");
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
    // R54-M: UPDATE + audit inline in one orgTx. Prior shape ran
    // pgUpdateCategory (own tx) then pgInsertAuditEvent (separate
    // tx); on audit-tx failure the rename landed without a trail.
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    try {
      await client.query(
        `UPDATE categories SET name = $1, slug = $2, image_url = $3, updated_at = $4
         WHERE id = $5 AND organization_id = $6`,
        [name, slug, imageUrl ?? null, new Date().toISOString(), categoryId, orgId],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'category', $5, 'catalog_update', $6, now())`,
        [randomUUID(), orgId, null, employee.id, categoryId, JSON.stringify({ action: "updated", name })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
    // R54-M: DELETE + audit inline in one orgTx. Prior shape split
    // DELETE and audit across two separate txs; audit-tx failure
    // left the delete permanent with no trail.
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    try {
      await client.query(
        `DELETE FROM categories WHERE id = $1 AND organization_id = $2`,
        [categoryId, orgId],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'category', $5, 'catalog_update', $6, now())`,
        [randomUUID(), orgId, null, employee.id, categoryId, JSON.stringify({ action: "deleted" })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
    // R54-M: UPDATE + audit inline in one orgTx. Prior shape split
    // pgUpdateProduct and pgInsertAuditEvent into two separate txs;
    // post-commit audit failure left catalog edits with no trail.
    // Mirror the shape of pgUpdateProduct with a pre-built dynamic
    // SET list, then audit before COMMIT.
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    try {
      await client.query(
        `UPDATE products SET name = $1, slug = $2, category_id = $3, description = $4,
                             image_url = $5, is_active = $6, is_touch_favorite = $7, updated_at = $8
         WHERE id = $9 AND organization_id = $10`,
        [
          name, slug, categoryId, description ?? null, imageUrl ?? null,
          isActive, isTouchFavorite, new Date().toISOString(), productId, orgId,
        ],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'product', $5, 'catalog_update', $6, now())`,
        [randomUUID(), orgId, null, employee.id, productId, JSON.stringify({ action: "updated", name })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
    // R54-M: DELETE + audit inline in one orgTx. Prior shape split
    // pgDeleteProduct and pgInsertAuditEvent into two separate txs.
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    try {
      await client.query(
        `DELETE FROM products WHERE id = $1 AND organization_id = $2`,
        [productId, orgId],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'product', $5, 'catalog_update', $6, now())`,
        [randomUUID(), orgId, null, employee.id, productId, JSON.stringify({ action: "deleted" })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Mirror pgDeleteProduct's cache invalidation so POS terminals
    // see the removal before the 30s TTL.
    invalidateProductsCache(orgId);
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

    // R54-M (R53-M2 fix): prior → step-up → UPDATE → audit all in ONE
    // orgTx with SELECT … FOR UPDATE on the prior row.
    //
    // The previous shape had two audit-drift AND TOCTOU problems:
    //   1. The prior SELECT happened via orgQuery (its own tx) so a
    //      concurrent PUT could reprice the row between our read and
    //      our UPDATE — the step-up check gated on a stale snapshot.
    //   2. pgUpdateVariant (own tx) + pgInsertAuditEvent (separate tx):
    //      audit drop on post-commit audit-tx failure.
    //
    // Inline SELECT FOR UPDATE locks the row for the duration of the
    // step-up hash + UPDATE; mirrors the /api/products PUT variant
    // branch exactly. Any other writer waits or aborts cleanly.
    type EditVariantOutcome =
      | { kind: "ok" }
      | { kind: "not_found" }
      | { kind: "stepup_failed"; error: string }
      | { kind: "conflict"; message: string };
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    let outcome: EditVariantOutcome = { kind: "ok" };
    try {
      const { rows: priorRows } = await client.query(
        `SELECT price, cost FROM product_variants WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [variantId, orgId],
      );
      const prior = priorRows[0] as { price: string; cost: string | null } | undefined;
      if (!prior) {
        await client.query("ROLLBACK").catch(() => {});
        outcome = { kind: "not_found" };
      } else {
        const priorPrice = Number(prior.price);
        const priorCost = prior.cost != null ? Number(prior.cost) : null;
        const priceChanged = Math.abs(priorPrice - price) > 0.005;
        const costChanged = cost !== undefined && priorCost !== null && Math.abs(priorCost - cost) > 0.005;
        let stepUpOk = true;
        let stepUpErr = "";
        if (priceChanged || costChanged) {
          const { requireStepUp } = await import('@/lib/auth/step-up');
          const stepUp = await requireStepUp({
            actorId: employee.id,
            orgId,
            actorPassword,
            bucketKey: 'variant-price-stepup',
          });
          if (!stepUp.ok) {
            stepUpOk = false;
            stepUpErr = stepUp.error;
          }
        }
        if (!stepUpOk) {
          await client.query("ROLLBACK").catch(() => {});
          outcome = { kind: "stepup_failed", error: stepUpErr };
        } else {
          try {
            await client.query(
              `UPDATE product_variants SET name = $1, sku = $2, barcode = $3, price = $4, cost = $5,
                                            size_label = $6, color_label = $7, is_active = $8, updated_at = $9
               WHERE id = $10 AND organization_id = $11`,
              [
                name, sku, barcode ?? null, price, cost ?? null,
                sizeLabel ?? null, colorLabel ?? null, isActive, new Date().toISOString(),
                variantId, orgId,
              ],
            );
          } catch (err) {
            // R22-M-1: partial-unique index collision on (org, sku) /
            // (org, barcode) WHERE is_active. Mirror pgUpdateVariant's
            // translation to a typed error so the UI copy stays the same.
            const e = err as { code?: string; constraint?: string };
            if (e.code === "23505") {
              if (e.constraint === "uniq_product_variants_org_sku_active") {
                await client.query("ROLLBACK").catch(() => {});
                outcome = { kind: "conflict", message: new VariantUniquenessConflictError("sku").message };
              } else if (e.constraint === "uniq_product_variants_org_barcode_active") {
                await client.query("ROLLBACK").catch(() => {});
                outcome = { kind: "conflict", message: new VariantUniquenessConflictError("barcode").message };
              } else {
                throw err;
              }
            } else {
              throw err;
            }
          }
          if (outcome.kind === "ok") {
            await client.query(
              `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
               VALUES ($1, $2, $3, $4, 'variant', $5, 'catalog_update', $6, now())`,
              [randomUUID(), orgId, null, employee.id, variantId, JSON.stringify({ action: "updated", name, sku })],
            );
            await client.query("COMMIT");
          }
        }
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (outcome.kind === "ok") {
      // Mirror pgUpdateVariant's cache invalidation on the happy path.
      invalidateVariantsCache(orgId);
    }
    // Redirects deferred past the tx so we don't leak the client.
    if (outcome.kind === "not_found") redirect("/admin?error=Variant+not+found");
    if (outcome.kind === "stepup_failed") redirect(`/admin?error=${encodeURIComponent(outcome.error)}`);
    if (outcome.kind === "conflict") redirect(`/admin?error=${encodeURIComponent(outcome.message)}`);
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
    // R54-M: DELETE + audit inline in one orgTx.
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    try {
      await client.query(
        `DELETE FROM product_variants WHERE id = $1 AND organization_id = $2`,
        [variantId, orgId],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'variant', $5, 'catalog_update', $6, now())`,
        [randomUUID(), orgId, null, employee.id, variantId, JSON.stringify({ action: "deleted" })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Mirror pgDeleteVariant's cache invalidation.
    invalidateVariantsCache(orgId);
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
    // R54-M: UPDATE + audit inline in one orgTx. Prior shape split
    // pgUpdateOrganization (own tx) and pgInsertAuditEvent (separate
    // tx); on audit-tx failure the org identity change landed without
    // an audit trail. Mirrors the /api/settings 'store' branch shape.
    const orgData: Record<string, unknown> = {
      name: String(formData.get("name") ?? "").trim() || undefined,
      legalName: String(formData.get("legalName") ?? "").trim() || undefined,
      phone: String(formData.get("phone") ?? "").trim(),
      email: String(formData.get("email") ?? "").trim(),
      website: String(formData.get("website") ?? "").trim(),
      receiptHeader: String(formData.get("receiptHeader") ?? "").trim(),
      receiptFooter: String(formData.get("receiptFooter") ?? "").trim(),
    };
    const colMap: Record<string, string> = {
      name: "name", legalName: "legal_name", phone: "phone", email: "email",
      website: "website", receiptHeader: "receipt_header", receiptFooter: "receipt_footer",
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [key, col] of Object.entries(colMap)) {
      const v = orgData[key];
      if (v !== undefined) { sets.push(`${col} = $${i++}`); vals.push(v); }
    }
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    try {
      if (sets.length > 0) {
        sets.push(`updated_at = $${i++}`); vals.push(new Date().toISOString());
        vals.push(orgId);
        // check-pool-org-filter: scoped-by-id-is-org-id-on-organizations-table
        // `organizations.id` IS the tenant scope (root of tenancy tree);
        // same rationale as pgUpdateOrganization's comment.
        await client.query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $${i}`, vals);
      }
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'organization', $5, 'settings_update', $6, now())`,
        [randomUUID(), orgId, null, employee.id, orgId, JSON.stringify({ action: "updated_organization" })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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

  if (isPg()) {
    // R54-M (R53-M1 fix): prior SELECT → step-up → UPDATE → audit ALL
    // in one orgTx. Prior shape ran a separate-tx orgQuery for the
    // prior tax snapshot, then pgUpdateLocation (own tx), then
    // pgInsertAuditEvent (separate tx):
    //   • Audit drift: the location change landed but audit could
    //     drop if its tx failed (R53-M1).
    //   • TOCTOU: a concurrent edit could retarget tax_rate between
    //     our snapshot and our UPDATE, silently bypassing the step-up.
    //
    // SELECT … FOR UPDATE locks the row for the duration of the
    // step-up hash + UPDATE; mirrors the /api/settings location
    // branch shape.
    //
    // R44-H: step-up when tax rate is being changed. Other fields
    // (name/address/phone) are low-blast-radius and don't need the
    // gate. R52-G: snapshot-compare with epsilon so legitimate
    // name/address edits don't trigger the password challenge.
    const orgId = employee.organizationId;
    const { orgTx } = await import("@/lib/db");
    type UpdLocOutcome = { kind: "ok" } | { kind: "stepup_failed"; error: string };
    const client = await orgTx(orgId);
    let outcome: UpdLocOutcome = { kind: "ok" };
    try {
      let priorTax: number | null = null;
      if (taxRate !== undefined) {
        const { rows: priorRows } = await client.query(
          `SELECT tax_rate FROM locations WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [locationId, orgId],
        );
        priorTax = priorRows[0]?.tax_rate != null ? Number(priorRows[0].tax_rate) : null;
        const taxChanged = priorTax === null || Math.abs(priorTax - taxRate) > 0.00005;
        if (taxChanged) {
          const actorPassword = String(formData.get("actorPassword") ?? "");
          const { requireStepUp } = await import("@/lib/auth/step-up");
          const stepUp = await requireStepUp({
            actorId: employee.id,
            orgId,
            actorPassword,
            bucketKey: "tax-rate-stepup",
          });
          if (!stepUp.ok) {
            await client.query("ROLLBACK").catch(() => {});
            outcome = { kind: "stepup_failed", error: stepUp.error };
          }
        }
      }

      if (outcome.kind === "ok") {
        // Build dynamic SET list (mirrors pgUpdateLocation).
        const locData: Record<string, unknown> = {
          name: String(formData.get("locationName") ?? "").trim() || undefined,
          address1: String(formData.get("address1") ?? "").trim() || undefined,
          city: String(formData.get("city") ?? "").trim() || undefined,
          region: String(formData.get("region") ?? "").trim() || undefined,
          postalCode: String(formData.get("postalCode") ?? "").trim() || undefined,
          phone: String(formData.get("locationPhone") ?? "").trim(),
          taxRate,
        };
        const colMap: Record<string, string> = {
          name: "name", address1: "address1", city: "city", region: "region",
          postalCode: "postal_code", phone: "phone", taxRate: "tax_rate",
        };
        const sets: string[] = [];
        const vals: unknown[] = [];
        let i = 1;
        for (const [key, col] of Object.entries(colMap)) {
          const v = locData[key];
          if (v !== undefined) { sets.push(`${col} = $${i++}`); vals.push(v); }
        }
        if (sets.length > 0) {
          sets.push(`updated_at = $${i++}`); vals.push(new Date().toISOString());
          vals.push(locationId);
          vals.push(orgId);
          await client.query(
            `UPDATE locations SET ${sets.join(", ")} WHERE id = $${i} AND organization_id = $${i + 1}`,
            vals,
          );
        }
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'location', $5, 'settings_update', $6, now())`,
          [
            randomUUID(), orgId, locationId, employee.id, locationId,
            JSON.stringify({ action: "updated_location", taxRate }),
          ],
        );
        await client.query("COMMIT");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (outcome.kind === "ok") {
      // Mirror pgUpdateLocation's cache invalidation on the happy path.
      invalidateLocationsCache(orgId);
    }
    if (outcome.kind === "stepup_failed") {
      redirect(`/admin?error=${encodeURIComponent(outcome.error)}`);
    }
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Location+settings+updated");
}
