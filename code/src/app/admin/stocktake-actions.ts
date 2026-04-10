"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import type { Stocktake, StocktakeLine } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";

export async function createStocktakeAction(formData: FormData) {
  const locationId = formData.get("locationId") as string;
  const countType = formData.get("countType") as string;
  const categoryFilter = (formData.get("categoryFilter") as string) || undefined;
  const notes = (formData.get("notes") as string) || undefined;

  if (!locationId || !countType) {
    throw new Error("Location and count type are required");
  }

  const ctx = await requireAdminPermission("inventory.adjust");

  await mutateStore((store) => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const stocktake: Stocktake = {
      id,
      organizationId: store.organization.id,
      locationId,
      initiatedBy: ctx.employee.id,
      status: "in_progress",
      countType: countType as Stocktake["countType"],
      categoryFilter,
      notes,
      createdAt: now,
      updatedAt: now,
    };

    store.stocktakes.push(stocktake);

    // Generate lines from current inventory at this location
    const locationInventory = store.inventory.filter((inv) => inv.locationId === locationId);
    for (const inv of locationInventory) {
      // If cycle count with category filter, only include matching variants
      if (countType === "cycle" && categoryFilter) {
        const variant = store.variants.find((v) => v.id === inv.productVariantId);
        const product = variant ? store.products.find((p) => p.id === variant.productId) : null;
        if (product?.categoryId !== categoryFilter) continue;
      }

      const line: StocktakeLine = {
        id: crypto.randomUUID(),
        stocktakeId: id,
        productVariantId: inv.productVariantId,
        expectedQty: inv.onHand,
        createdAt: now,
      };
      store.stocktakeLines.push(line);
    }
  });

  revalidatePath("/admin");
}

export async function recordCountAction(formData: FormData) {
  const lineId = formData.get("lineId") as string;
  const countedQty = Number(formData.get("countedQty"));

  if (!lineId || isNaN(countedQty) || countedQty < 0) {
    throw new Error("Line ID and non-negative count required");
  }

  const ctx = await requireAdminPermission("inventory.adjust");
  if (!ctx) throw new Error("Not authenticated");

  await mutateStore((store) => {
    const line = store.stocktakeLines.find((l) => l.id === lineId);
    if (!line) throw new Error("Line not found");

    line.countedQty = countedQty;
    line.variance = countedQty - line.expectedQty;
    line.countedBy = ctx.employee.id;
    line.countedAt = new Date().toISOString();
  });

  revalidatePath("/admin");
}

export async function acceptStocktakeAction(stocktakeId: string) {
  const ctx = await requireAdminPermission("inventory.adjust");
  if (!ctx) throw new Error("Not authenticated");

  await mutateStore((store) => {
    const stocktake = store.stocktakes.find((s) => s.id === stocktakeId);
    if (!stocktake) throw new Error("Stocktake not found");
    if (stocktake.status !== "in_progress" && stocktake.status !== "pending_review") {
      throw new Error(`Cannot accept ${stocktake.status} stocktake`);
    }

    const now = new Date().toISOString();
    stocktake.status = "accepted";
    stocktake.acceptedBy = ctx.employee.id;
    stocktake.acceptedAt = now;
    stocktake.updatedAt = now;

    // Apply inventory adjustments
    const lines = store.stocktakeLines.filter((l) => l.stocktakeId === stocktakeId && l.countedQty != null);
    for (const line of lines) {
      const variance = (line.countedQty ?? 0) - line.expectedQty;
      if (variance === 0) continue;

      const inv = store.inventory.find(
        (i) => i.productVariantId === line.productVariantId && i.locationId === stocktake.locationId,
      );
      if (inv) {
        inv.onHand = Math.max(0, inv.onHand + variance);
        inv.updatedAt = now;

        store.inventoryAdjustments.push({
          id: crypto.randomUUID(),
          inventoryLevelId: inv.id,
          productVariantId: line.productVariantId,
          locationId: stocktake.locationId,
          employeeId: ctx.employee.id,
          reason: "stocktake_adjustment",
          delta: variance,
          resultingOnHand: inv.onHand,
          createdAt: now,
        });
      }
    }
  });

  revalidatePath("/admin");
}

export async function cancelStocktakeAction(stocktakeId: string) {
  await mutateStore((store) => {
    const stocktake = store.stocktakes.find((s) => s.id === stocktakeId);
    if (!stocktake) throw new Error("Stocktake not found");
    stocktake.status = "cancelled";
    stocktake.updatedAt = new Date().toISOString();
  });

  revalidatePath("/admin");
}
