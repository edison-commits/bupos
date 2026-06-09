"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
// R84-final: admin-mutation cache invalidation. Every admin Server
// Action that mutates org-scoped data must bust the readStore
// cache (30s TTL) so the subsequent revalidatePath("/admin")
// re-render reads fresh data. Parity with R84-hand's register-
// side fix.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";
import { redirect } from "next/navigation";
import { hashSecret, hashPin } from "@/lib/auth/crypto";
import { canManageEmployeeRole, requireAdminPermission } from "@/lib/authz";
// SEC-AUDIT5-HIGH1: `signInAdmin` + `checkRateLimit` (top-level) +
// `pgFindCredentialByEmail` were used only by the deleted
// adminLoginAction Server Action. Dynamic-import + alternate caller
// sites for these still exist — the static-import surface here is gone.
import { signOutAdmin } from "@/lib/auth/session";
import { mutateStore } from "@/lib/persistence/store";
import type { RoleKey } from "@/lib/domain/types";
import {
  pgCreateProduct,
  pgCreateVariant,
  VariantUniquenessConflictError,
  pgCreateInventoryLevel,
  pgAdjustInventory,
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

// SEC-AUDIT5-HIGH1: `adminLoginAction` Server Action removed.
//
// History: this was an early-architecture admin login surface that got
// orphaned when the unified `loginAction` (src/app/actions/auth.ts) +
// `/api/auth/login` route took over. No UI form referenced this action
// (grep confirms zero callers other than the audit-log line within the
// function itself), but as an exported `"use server"` action it was
// still discoverable / invocable by anyone with the bundled action ID.
//
// The hazard: it used a separate rate-limit bucket (`admin:${email}`)
// that was single-tier in-memory only — distinct from the unified
// `admin-login:${email}` bucket the live login surfaces use (which has
// mem + KV + DB layers). An attacker rotating between the live login
// routes and this dead action got an extra ~96 attempts/5 min/email
// beyond the per-isolate cap, with no KV/DB layer to backstop.
//
// Deleted entirely rather than aligning the bucket key, because:
//   - There is no UI caller to preserve.
//   - Keeping a dead Server Action exported is itself a discoverability
//     hazard (encrypted action IDs are stable across deploys; an
//     attacker who scraped one when the action existed retains the
//     ability to invoke it).
//   - The unified login flow (loginAction in actions/auth.ts +
//     /api/auth/login) is the canonical surface; consolidating to one
//     surface removes a class of "drift between two implementations"
//     bugs.

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
    let slugConflict = false;
    try {
      try {
        await client.query(
          `INSERT INTO categories (id, organization_id, slug, name, sort_order, image_url, parent_category_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [id, orgId, slug, name, 0, imageUrl ?? null, null, ts],
        );
      } catch (err) {
        // R70-L3: handle slug-uniqueness collision as a user-
        // friendly redirect rather than bubbling a generic 500.
        // `uniq_categories_org_slug` in migration 061 fires when a
        // second "Shirts" collapses to the same slug as an existing
        // category. Also handles the race where two admins click
        // Create simultaneously — the loser sees the same message.
        const e = err as { code?: string; constraint?: string };
        if (e.code === "23505") {
          await client.query("ROLLBACK").catch(() => {});
          slugConflict = true;
        } else {
          throw err;
        }
      }
      if (!slugConflict) {
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'category', $5, 'catalog_update', $6, now())`,
          [randomUUID(), orgId, null, employee.id, id, JSON.stringify({ action: "created", name })],
        );
        await client.query("COMMIT");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (slugConflict) {
      redirect(`/admin?error=${encodeURIComponent(`A category with slug "${slug}" already exists`)}`);
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

  invalidateStoreCache(employee.organizationId);
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

  // R70-H1: parity with /api/products POST variant-create branch
  // (R58-5) and /api/barcode-lookup POST (R68-H4). Creating a new
  // product ALWAYS creates a priced variant (the starter variant),
  // so the same pricing.manage + variant-price-stepup gates apply.
  // Prior shape gated only on catalog.manage — a stolen
  // inventory_clerk cookie could mint $0.01 variants via the
  // admin-console Create Product form.
  const { hasPermission } = await import("@/lib/domain/permissions");
  if (!hasPermission(employee.roleKey, "pricing.manage")) {
    redirect("/admin?error=Creating+a+product+sets+a+variant+price+and+requires+owner+or+manager+role");
  }
  {
    const actorPassword = String(formData.get("actorPassword") ?? "");
    const { requireStepUp } = await import("@/lib/auth/step-up");
    const stepUp = await requireStepUp({
      actorId: employee.id,
      orgId: employee.organizationId,
      actorPassword,
      bucketKey: "variant-price-stepup",
    });
    if (!stepUp.ok) {
      redirect(`/admin?error=${encodeURIComponent(stepUp.error)}`);
    }
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
    try {
      await pgCreateProduct({
        id: productId, organizationId: orgId, categoryId, name, slug,
        description: String(formData.get("description") ?? "").trim() || undefined,
        imageUrl: String(formData.get("imageUrl") ?? "").trim() || undefined,
        isActive: true, isTouchFavorite: formData.get("isTouchFavorite") === "on",
        defaultVariantId: undefined, modifierGroupIds: [],
      });
    } catch (err) {
      // R72-A: friendly slug-conflict handling. `uniq_products_org_slug`
      // fires when two products collapse to the same slug. Prior
      // shape surfaced a generic 500 via the outer catch.
      const e = err as { code?: string };
      if (e.code === "23505") {
        redirect(`/admin?error=${encodeURIComponent(`A product with slug "${slug}" already exists`)}`);
      }
      throw err;
    }
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

  invalidateStoreCache(employee.organizationId);
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

  invalidateStoreCache(employee.organizationId);
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

  if (!firstName || !lastName) {
    redirect("/admin?error=Employee+needs+first+and+last+name");
  }

  // R56-D (R55 finding): PIN length parity with REST /api/employees
  // POST. R27-H1 requires ≥ 6 digits for admin-capable roles
  // (owner/manager) — their PIN unlocks admin-level endpoints via
  // withDualAuth's role check, so the brute-force space matters.
  // Cashier-class roles can keep 4-digit PINs.
  const isPrivilegedRole = roleKey === "owner" || roleKey === "manager";
  const minPinLen = isPrivilegedRole ? 6 : 4;
  if (!/^\d+$/.test(pin) || pin.length < minPinLen) {
    redirect(`/admin?error=${encodeURIComponent(
      isPrivilegedRole
        ? "Owner and manager PINs must be at least 6 digits."
        : "Cashier PINs must be at least 4 digits.",
    )}`);
  }

  if (!canManageEmployeeRole(employee.roleKey, roleKey)) {
    redirect("/admin?error=You+cannot+provision+that+role");
  }

  // R49: step-up re-auth on employee provisioning. Creating an employee
  // — especially an owner/manager with admin-capable password — is a
  // privilege-elevation action. A stolen cookie shouldn't be able to
  // mint shadow admin accounts. Matches the REST /api/employees POST
  // gate.
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
  // AUTH-HIGH1: parity with signupAction + password-change/reset Zod
  // (12-char floor). Prior shape had no minimum on the admin-side
  // employee-create path, so a 1-char owner password could persist
  // indefinitely. Empty is already gated above for owner/manager.
  if (password && password.length < 12) {
    redirect("/admin?error=Password+must+be+at+least+12+characters");
  }

  if (isPg()) {
    const employeeId = randomUUID();
    const orgId = employee.organizationId;

    // R56-D: PIN-collision check, org-scoped (REST parity). Prior
    // shape had no duplicate-PIN check — two employees could share
    // a PIN, so PIN-based register login could ambiguously resolve.
    // Pulled hashes are salted so the compare is per-row.
    const { orgQuery } = await import("@/lib/supabase-rest");
    const { verifySecret: verify } = await import("@/lib/auth/crypto");
    const pinHash = await hashPin(pin);
    const { rows: existingCreds } = await orgQuery(
      orgId,
      `SELECT ac.pin_hash FROM auth_credentials ac
         JOIN employees e ON e.id = ac.employee_id
        WHERE e.organization_id = $1 AND ac.pin_hash IS NOT NULL`,
      [orgId],
    );
    for (const row of existingCreds) {
      const existingHash = row.pin_hash as string | undefined;
      if (existingHash && await verify(pin, existingHash)) {
        redirect("/admin?error=That+PIN+is+already+in+use.+Pick+another.");
      }
    }

    const passwordHash = password ? await hashSecret(password) : undefined;
    const displayName = `${firstName} ${lastName[0] ?? ""}.`.trim();
    const pinHint = `${pin.length}-digit ${roleKey.replace("_", " ")} PIN`;
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
      // R56-D: event_kind 'employee_created' (was 'catalog_update' —
      // misclassified; breaks audit-filter parity with the REST
      // surface and makes forensic search for "who provisioned this
      // account" harder than it should be).
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'employee', $5, 'employee_created', $6, now())`,
        [randomUUID(), orgId, null, employee.id, employeeId, JSON.stringify({ action: "created_employee", name: `${firstName} ${lastName}`, role_key: roleKey })],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // R74-C: friendly error on auth_credentials email unique index
      // (migration 051:55). Prior shape surfaced as a generic
      // "Failed to create employee" — masked the real fix (use a
      // different email). Mirrors REST /api/employees POST 23505
      // handler added in the same round.
      const err = e as { code?: string };
      if (err?.code === "23505") {
        redirect(
          "/admin?error=An+employee+with+this+email+already+exists.+Choose+a+different+email.",
        );
      }
      throw e;
    } finally {
      client.release();
    }
    // Mirror pgCreateEmployee's cache invalidation.
    invalidateEmployeesCache(orgId);
  } else {
    const timestamp = now();
    const pinHashVal = await hashPin(pin);
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

  invalidateStoreCache(employee.organizationId);
  revalidatePath("/admin");
  redirect("/admin?notice=Employee+created");
}

export async function toggleEmployeeAction(formData: FormData) {
  const { employee: actor } = await requireAdminPermission("employee.manage");
  const employeeId = String(formData.get("employeeId") ?? "");
  const actorPassword = String(formData.get("actorPassword") ?? "");
  // R77-SEC-H: explicit "activate" | "deactivate" instead of a
  // toggle. Prior shape (`SET is_active = NOT is_active`) let a
  // stolen-cookie attacker chain deactivate→reactivate to hide
  // activity and didn't distinguish the two operations in audit
  // payload. REST /api/employees PATCH was hardened to explicit
  // action in R28-H4; this Server Action never matched.
  const explicitAction = String(formData.get("action") ?? "").trim();

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

  // R77-SEC-H: parity with REST /api/employees PATCH (R30-H3) —
  // self-deactivation is forbidden and owner-on-owner deactivation
  // is forbidden. These are only meaningful when we know the
  // direction, so validate `explicitAction` first.
  if (explicitAction !== "activate" && explicitAction !== "deactivate") {
    redirect("/admin?error=Missing+or+invalid+action");
  }
  const isSelf = actor.id === employeeId;
  if (isSelf && explicitAction === "deactivate") {
    redirect("/admin?error=You+cannot+deactivate+yourself");
  }

  // R98-SEC-M2: prior `newStatus` sentinel gated a post-COMMIT session
  // DELETE. Session invalidation now lives INSIDE the orgTx below, so
  // the sentinel has no consumer and is gone.
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
      | { kind: "denied" }
      | { kind: "noop" };
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
        const wasActive = empRows[0].is_active as boolean;
        const targetActive = explicitAction === "activate";
        if (!canManageEmployeeRole(actor.roleKey, targetRole as RoleKey)) {
          await client.query("ROLLBACK").catch(() => {});
          outcome = { kind: "denied" };
        } else if (
          // R77-SEC-H: R30-H3 parity — owner-on-owner deactivation
          // locks out a co-owner. One owner with compromised cookie
          // could silently deactivate every peer and corner the org
          // pending DB-side intervention.
          !isSelf && actor.roleKey === "owner" && targetRole === "owner" && !targetActive
        ) {
          await client.query("ROLLBACK").catch(() => {});
          outcome = { kind: "denied" };
        } else if (wasActive === targetActive) {
          // No-op — the requested state matches current. Silent
          // success would mask toggle-DoS attempts in audit.
          await client.query("ROLLBACK").catch(() => {});
          outcome = { kind: "noop" };
        } else {
          await client.query(
            `UPDATE employees SET is_active = $1, updated_at = $2
             WHERE id = $3 AND organization_id = $4`,
            [targetActive, new Date().toISOString(), employeeId, orgId],
          );
          await client.query(
            `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, 'employee', $5, $6, $7, now())`,
            [
              randomUUID(), orgId, null, actor.id, employeeId,
              // R77-SEC-H: match REST event_kind so audit filters don't
              // have to special-case the surface.
              targetActive ? "employee_activated" : "employee_deactivated",
              JSON.stringify({ action: targetActive ? "activated" : "deactivated", target_role: targetRole }),
            ],
          );
          // R98-SEC-M2: DELETE sessions INSIDE the same tx on
          // deactivate so the old session row can't outlive the
          // authority change. Prior R77-SEC-H shape post-COMMIT
          // left a 10-100ms gap on Neon serverless during which
          // a stolen cookie still resolved.
          if (!targetActive) {
            await client.query(
              `DELETE FROM sessions
                 WHERE employee_id = $1
                   AND employee_id IN (SELECT id FROM employees WHERE organization_id = $2)`,
              [employeeId, orgId],
            );
          }
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
      // R77-SEC-H / R98-SEC-M2: session DELETE now lives INSIDE the
      // orgTx above — see the in-tx block. Post-commit no-op here
      // kept so the outcome branches stay structurally parallel.
    }
    if (outcome.kind === "not_found") redirect("/admin?error=Employee+not+found");
    if (outcome.kind === "denied") redirect("/admin?error=You+cannot+change+that+employee");
    if (outcome.kind === "noop") redirect(`/admin?notice=Employee+already+${explicitAction}d`);
  } else {
    await mutateStore((store) => {
      const employee = store.employees.find((entry) => entry.id === employeeId);
      if (!employee) redirect("/admin?error=Employee+not+found");
      if (!canManageEmployeeRole(actor.roleKey, employee!.roleKey)) {
        redirect("/admin?error=You+cannot+change+that+employee");
      }
      const targetActive = explicitAction === "activate";
      employee!.isActive = targetActive;
      employee!.updatedAt = now();
    });
  }

  invalidateStoreCache(actor.organizationId);
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
    let slugConflict = false;
    try {
      try {
        await client.query(
          `UPDATE categories SET name = $1, slug = $2, image_url = $3, updated_at = $4
           WHERE id = $5 AND organization_id = $6`,
          [name, slug, imageUrl ?? null, new Date().toISOString(), categoryId, orgId],
        );
      } catch (err) {
        // R72-A: parity with R70-L3 createCategoryAction. Slug
        // regenerated from name — renaming into a collision fires
        // `uniq_categories_org_slug`. Prior shape bubbled as
        // generic 500; now a friendly redirect.
        const e = err as { code?: string };
        if (e.code === "23505") {
          await client.query("ROLLBACK").catch(() => {});
          slugConflict = true;
        } else {
          throw err;
        }
      }
      if (!slugConflict) {
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'category', $5, 'catalog_update', $6, now())`,
          [randomUUID(), orgId, null, employee.id, categoryId, JSON.stringify({ action: "updated", name })],
        );
        await client.query("COMMIT");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (slugConflict) {
      redirect(`/admin?error=${encodeURIComponent(`A category with slug "${slug}" already exists`)}`);
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

  invalidateStoreCache(employee.organizationId);
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

  invalidateStoreCache(employee.organizationId);
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
    let slugConflict = false;
    try {
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
      } catch (err) {
        // R72-A: parity with R70-L3. Product rename regenerates
        // slug; `uniq_products_org_slug` fires if another product
        // already occupies it. Friendly redirect instead of 500.
        const e = err as { code?: string };
        if (e.code === "23505") {
          await client.query("ROLLBACK").catch(() => {});
          slugConflict = true;
        } else {
          throw err;
        }
      }
      if (!slugConflict) {
        await client.query(
          `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
           VALUES ($1, $2, $3, $4, 'product', $5, 'catalog_update', $6, now())`,
          [randomUUID(), orgId, null, employee.id, productId, JSON.stringify({ action: "updated", name })],
        );
        await client.query("COMMIT");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (slugConflict) {
      redirect(`/admin?error=${encodeURIComponent(`A product with slug "${slug}" already exists`)}`);
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

  invalidateStoreCache(employee.organizationId);
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
    // R54-M / R58-2: soft-delete + in-tx audit.
    //
    // R58-2 fixes the semantic divergence R57 flagged:
    //   • REST /api/products DELETE soft-deletes (UPDATE is_active =
    //     false) and emits event_kind = 'product_deleted'.
    //   • Server Action was HARD deleting (DELETE FROM products)
    //     and emitting event_kind = 'catalog_update' with
    //     `action:"deleted"` — cascading through child tables and
    //     breaking forensic queries that filter by event_kind.
    // Unified on the soft-delete semantics (REST was already there)
    // AND on event_kind = 'product_deleted' so a single audit-kind
    // query finds every product removal regardless of surface. The
    // admin list queries already filter on is_active elsewhere, so
    // soft-delete behaves indistinguishably from hard-delete at the
    // UI layer.
    const { orgTx } = await import("@/lib/db");
    const client = await orgTx(orgId);
    try {
      const res = await client.query(
        `UPDATE products SET is_active = false, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 RETURNING id, name`,
        [productId, orgId],
      );
      if (res.rows.length === 0) {
        await client.query("ROLLBACK");
        redirect("/admin?error=Product+not+found");
      }
      // R60-A3: cascade soft-delete to variants in the SAME tx.
      // Prior shape (R58-2) only deactivated the product row; the
      // variants stayed active, which left direct variant lookups
      // (barcode-lookup, offline-sync, checkout-action) returning
      // a "deleted" SKU. Checkout paths only check variant.is_active,
      // so a soft-deleted product could still be rung up. This
      // cascade matches the hard-delete semantics the prior shape
      // relied on via FK CASCADE.
      const varRes = await client.query(
        `UPDATE product_variants SET is_active = false, updated_at = NOW()
          WHERE product_id = $1 AND organization_id = $2`,
        [productId, orgId],
      );
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'product', $5, 'product_deleted', $6, now())`,
        [
          randomUUID(), orgId, null, employee.id, productId,
          JSON.stringify({
            id: productId,
            name: res.rows[0]?.name,
            soft_delete: true,
            variants_deactivated: varRes.rowCount ?? 0,
          }),
        ],
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
    invalidateVariantsCache(orgId);
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

  invalidateStoreCache(employee.organizationId);
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

    // R56-B1: step-up OUTSIDE the tx; tx re-reads prior + TOCTOU-
    // guards. Prior shape (R54-M / R53-M2) correctly closed the
    // audit drift and the snapshot-compare TOCTOU by running
    // SELECT FOR UPDATE → step-up → UPDATE → audit inside one
    // orgTx. But that held the product_variants row lock (and the
    // orgTx pool client) across requireStepUp, which does ~3 KV
    // RTTs + a separate orgQuery on auth_credentials + a PBKDF2
    // verify (~100ms CPU) + optionally a decoy PBKDF2 (~100ms
    // more) + an in-success aggregate-counter audit insert. Net:
    // ~300-500ms of row-lock contention per reprice, PLUS pool
    // multiplication from the step-up's own orgQuery. Under
    // concurrent reprices on the same variant this serialized
    // hard and starved other readers of the same variant.
    //
    // New shape:
    //   1. Non-locking prior SELECT (orgQuery).
    //   2. Decide priceChanged/costChanged from that snapshot.
    //   3. Run requireStepUp outside the tx (password verify +
    //      audit happen on their own connection).
    //   4. Enter orgTx, SELECT FOR UPDATE the row again, compare
    //      the NEW prior to the prior we step-upped against — if
    //      they differ, reject with a short retry error (TOCTOU
    //      detected; the user is asked to re-save, which is
    //      acceptable UX since the prior view is now stale).
    //   5. UPDATE + audit + COMMIT.
    //
    // Matches the adjustInventoryAction / toggleEmployeeAction
    // shapes already in this file.
    type EditVariantOutcome =
      | { kind: "ok" }
      | { kind: "not_found" }
      | { kind: "conflict"; message: string }
      | { kind: "toctou_retry" };

    const { orgQuery, orgTx } = await import("@/lib/supabase-rest");

    // (1) Non-locking prior snapshot.
    const { rows: priorRows } = await orgQuery(
      orgId,
      `SELECT price, cost FROM product_variants WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [variantId, orgId],
    );
    const priorSnap = priorRows[0] as { price: string; cost: string | null } | undefined;
    if (!priorSnap) {
      redirect("/admin?error=Variant+not+found");
    }
    const priorPriceSnap = Number(priorSnap!.price);
    const priorCostSnap = priorSnap!.cost != null ? Number(priorSnap!.cost) : null;
    const priceChanged = Math.abs(priorPriceSnap - price) > 0.005;
    const costChanged = cost !== undefined && priorCostSnap !== null && Math.abs(priorCostSnap - cost) > 0.005;

    // (2/3) Step-up OUTSIDE the tx.
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

    // (4/5) Re-read + TOCTOU guard + UPDATE + audit in orgTx.
    const client = await orgTx(orgId);
    let outcome: EditVariantOutcome = { kind: "ok" };
    try {
      const { rows: lockedRows } = await client.query(
        `SELECT price, cost FROM product_variants WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [variantId, orgId],
      );
      const locked = lockedRows[0] as { price: string; cost: string | null } | undefined;
      if (!locked) {
        await client.query("ROLLBACK").catch(() => {});
        outcome = { kind: "not_found" };
      } else {
        // TOCTOU guard: if the row's price/cost drifted between the
        // snapshot read (pre-step-up) and the locked read, reject.
        // A concurrent writer moved the row while we were stepping
        // up; our step-up decision was based on stale data. The
        // user retries — at which point they see the fresh value.
        const lockedPrice = Number(locked.price);
        const lockedCost = locked.cost != null ? Number(locked.cost) : null;
        const priceDrift = Math.abs(priorPriceSnap - lockedPrice) > 0.005;
        const costDrift =
          (priorCostSnap === null && lockedCost !== null) ||
          (priorCostSnap !== null && lockedCost === null) ||
          (priorCostSnap !== null && lockedCost !== null && Math.abs(priorCostSnap - lockedCost) > 0.005);
        if (priceDrift || costDrift) {
          await client.query("ROLLBACK").catch(() => {});
          outcome = { kind: "toctou_retry" };
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
            // (org, barcode) WHERE is_active.
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
      invalidateVariantsCache(orgId);
    }
    if (outcome.kind === "not_found") redirect("/admin?error=Variant+not+found");
    if (outcome.kind === "toctou_retry") {
      redirect("/admin?error=Variant+was+changed+by+another+user.+Please+refresh+and+try+again.");
    }
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

  invalidateStoreCache(employee.organizationId);
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

  invalidateStoreCache(employee.organizationId);
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

  invalidateStoreCache(employee.organizationId);
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
    // R56-B2: same refactor as editVariantAction — step-up OUTSIDE
    // the tx; tx re-reads prior and TOCTOU-guards. Prior shape held
    // the locations row lock across requireStepUp (~300-500ms of
    // KV RTTs + PBKDF2 + separate audit tx), starving concurrent
    // readers of the same location. New shape:
    //   1. Non-locking prior SELECT (orgQuery) on tax_rate.
    //   2. Step-up OUTSIDE tx if tax changed (epsilon 0.00005).
    //   3. Enter orgTx with SELECT … FOR UPDATE, re-compare prior
    //      tax to the snapshot; reject on drift with a retry
    //      message.
    //   4. UPDATE + audit + COMMIT.
    //
    // Also R56-LOW: skip audit row on completely empty SET
    // (caller submitted no mutable fields) to prevent audit-log
    // pollution / existence oracle.
    const orgId = employee.organizationId;
    const { orgQuery, orgTx } = await import("@/lib/supabase-rest");
    type UpdLocOutcome =
      | { kind: "ok"; didUpdate: boolean }
      | { kind: "not_found" }
      | { kind: "toctou_retry" };

    // (1) Non-locking prior tax snapshot. We also need to verify
    // the location exists before doing any work.
    const { rows: priorRows } = await orgQuery(
      orgId,
      `SELECT tax_rate FROM locations WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [locationId, orgId],
    );
    if (priorRows.length === 0) {
      redirect("/admin?error=Location+not+found");
    }
    const priorTaxSnap = priorRows[0]?.tax_rate != null ? Number(priorRows[0].tax_rate) : null;
    const taxChanged = taxRate !== undefined && (priorTaxSnap === null || Math.abs(priorTaxSnap - taxRate) > 0.00005);

    // (2) Step-up OUTSIDE tx.
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
        redirect(`/admin?error=${encodeURIComponent(stepUp.error)}`);
      }
    }

    // (3/4) Re-read + guard + UPDATE + audit in tx.
    const client = await orgTx(orgId);
    let outcome: UpdLocOutcome = { kind: "ok", didUpdate: false };
    try {
      const { rows: lockedRows } = await client.query(
        `SELECT tax_rate FROM locations WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [locationId, orgId],
      );
      if (lockedRows.length === 0) {
        await client.query("ROLLBACK").catch(() => {});
        outcome = { kind: "not_found" };
      } else {
        // TOCTOU guard: if tax_rate drifted between the snapshot
        // read and the locked read, the step-up decision was
        // based on stale data. Reject with retry.
        const lockedTax = lockedRows[0]?.tax_rate != null ? Number(lockedRows[0].tax_rate) : null;
        const drifted =
          (priorTaxSnap === null && lockedTax !== null) ||
          (priorTaxSnap !== null && lockedTax === null) ||
          (priorTaxSnap !== null && lockedTax !== null && Math.abs(priorTaxSnap - lockedTax) > 0.00005);
        if (drifted && taxRate !== undefined) {
          await client.query("ROLLBACK").catch(() => {});
          outcome = { kind: "toctou_retry" };
        } else {
          // Build dynamic SET list.
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
            // R56-LOW: audit only when something actually changed.
            await client.query(
              `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
               VALUES ($1, $2, $3, $4, 'location', $5, 'settings_update', $6, now())`,
              [
                randomUUID(), orgId, locationId, employee.id, locationId,
                JSON.stringify({ action: "updated_location", taxRate, keys: sets.slice(0, -1).map((s) => s.split(" = ")[0]) }),
              ],
            );
            outcome = { kind: "ok", didUpdate: true };
          } else {
            outcome = { kind: "ok", didUpdate: false };
          }
          await client.query("COMMIT");
        }
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (outcome.kind === "ok" && outcome.didUpdate) {
      invalidateLocationsCache(orgId);
    }
    if (outcome.kind === "not_found") redirect("/admin?error=Location+not+found");
    if (outcome.kind === "toctou_retry") {
      redirect("/admin?error=Location+tax+rate+was+changed+by+another+user.+Please+refresh+and+try+again.");
    }
  }

  invalidateStoreCache(employee.organizationId);
  revalidatePath("/admin");
  redirect("/admin?notice=Location+settings+updated");
}
