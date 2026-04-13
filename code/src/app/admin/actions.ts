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
    // Audit: log failed admin login attempt (non-fatal — redirect still proceeds)
    if (isPg()) {
      try {
        const cred = await pgFindCredentialByEmail(email);
        let orgId: string | null = null;
        if (cred) {
          const { pool } = await import("@/lib/db");
          const { rows } = await pool.query(
            `SELECT organization_id FROM employees WHERE id = $1 LIMIT 1`,
            [cred.employeeId],
          );
          orgId = (rows[0]?.organization_id as string) ?? null;
        }
        pgInsertAuditEvent(
          orgId ?? 'unknown', null, cred?.employeeId ?? null,
          "session", null, "admin_login_failed",
          { email, reason: err instanceof Error ? err.message : "unknown" },
        ).catch((err) => console.error("[audit] Failed to insert audit event:", err));
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
      pgInsertAuditEvent(
        ctx.employee.organizationId, null, ctx.employee.id,
        "session", ctx.session.id, "admin_login",
        { email, role: ctx.employee.roleKey },
      ).catch((err) => console.error("[adminLoginAction] audit failed:", err));
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
    pgInsertAuditEvent(
      actorOrgId, null, actorEmployeeId,
      "session", sessionId, "admin_logout",
      {},
    ).catch((err) => console.error("[adminLogoutAction] audit failed:", err));
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

  if (!name || !categoryId || !sku || Number.isNaN(price) || price <= 0) {
    redirect("/admin?error=Product+name,+category,+SKU,+and+price+are+required");
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const timestamp = now();
  const productId = randomUUID();
  const variantId = randomUUID();

  if (isPg()) {
    const orgId = employee.organizationId;
    const locationId = employee.locationIds[0] ?? "";
    await pgCreateProduct({
      id: productId, organizationId: orgId, categoryId, name, slug,
      description: String(formData.get("description") ?? "").trim() || undefined,
      imageUrl: String(formData.get("imageUrl") ?? "").trim() || undefined,
      isActive: true, isTouchFavorite: formData.get("isTouchFavorite") === "on",
      defaultVariantId: variantId, modifierGroupIds: [],
    });
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
    await pgCreateInventoryLevel({
      id: randomUUID(), organizationId: orgId, locationId,
      productVariantId: variantId,
      onHand: Number(formData.get("openingStock") ?? 0) || 0,
      reserved: 0, reorderPoint: Number(formData.get("reorderPoint") ?? 0) || 0,
    });
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

  if (!inventoryLevelId || !reason || Number.isNaN(delta) || delta === 0) {
    redirect("/admin?error=Inventory+adjustment+needs+row,+delta,+and+reason");
  }

  if (isPg()) {
    const { level } = await pgAdjustInventory(inventoryLevelId, delta, employee.id, reason);
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

  if (!firstName || !lastName || !/^\d{4}$/.test(pin)) {
    redirect("/admin?error=Employee+needs+name+and+4-digit+PIN");
  }

  if (!canManageEmployeeRole(employee.roleKey, roleKey)) {
    redirect("/admin?error=You+cannot+provision+that+role");
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

  let newStatus: boolean | null = null;
  if (isPg()) {
    const target = await pgReadEmployeeById(employeeId);
    if (!target) redirect("/admin?error=Employee+not+found");
    if (!canManageEmployeeRole(actor.roleKey, target!.roleKey)) {
      redirect("/admin?error=You+cannot+change+that+employee");
    }
    newStatus = !target!.isActive;
    await pgToggleEmployee(employeeId);
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
    await pgUpdateCategory(categoryId, { name, slug, imageUrl });
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
    await pgDeleteCategory(categoryId);
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
    await pgUpdateProduct(productId, { name, slug, categoryId, description, imageUrl, isActive, isTouchFavorite });
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
    await pgDeleteProduct(productId);
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

  if (!variantId || !name || !sku || Number.isNaN(price) || price <= 0) {
    redirect("/admin?error=Variant+ID,+name,+SKU,+and+valid+price+are+required");
  }

  if (isPg()) {
    const orgId = employee.organizationId;
    await pgUpdateVariant(variantId, { name, sku, barcode, price, cost, sizeLabel, colorLabel, isActive });
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
    await pgDeleteVariant(variantId);
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
  const { employee } = await requireAdminPermission("catalog.manage");
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
  const { employee } = await requireAdminPermission("catalog.manage");
  const locationId = String(formData.get("locationId") ?? "").trim();
  if (!locationId) redirect("/admin?error=Missing+location");

  const taxRateRaw = String(formData.get("taxRate") ?? "").trim();
  const taxRatePercent = Number.parseFloat(taxRateRaw);
  const taxRate = Number.isFinite(taxRatePercent) ? taxRatePercent / 100 : undefined;

  if (isPg()) {
    await pgUpdateLocation(locationId, {
      name: String(formData.get("locationName") ?? "").trim() || undefined,
      address1: String(formData.get("address1") ?? "").trim() || undefined,
      city: String(formData.get("city") ?? "").trim() || undefined,
      region: String(formData.get("region") ?? "").trim() || undefined,
      postalCode: String(formData.get("postalCode") ?? "").trim() || undefined,
      phone: String(formData.get("locationPhone") ?? "").trim(),
      taxRate,
    });
    await pgInsertAuditEvent(employee.organizationId, locationId, employee.id, "location", locationId, "settings_update", { action: "updated_location", taxRate });
  }

  revalidatePath("/admin");
  redirect("/admin?notice=Location+settings+updated");
}
