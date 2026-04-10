"use server";

import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import type { LayawayPayment } from "@/lib/domain/types";
import { revalidatePath } from "next/cache";

export async function makeLayawayPaymentAction(formData: FormData) {
  const layawayId = formData.get("layawayId") as string;
  const amount = Number(formData.get("amount"));
  const tenderType = formData.get("tenderType") as string;

  if (!layawayId || !amount || amount <= 0 || !tenderType) {
    throw new Error("Layaway ID, positive amount, and tender type are required");
  }

  const ctx = await requireAdminPermission("register.open");

  await mutateStore((store) => {
    const layaway = store.layaways.find((l) => l.id === layawayId);
    if (!layaway) throw new Error("Layaway not found");
    if (layaway.status !== "active" && layaway.status !== "partially_paid") {
      throw new Error(`Cannot make payment on ${layaway.status} layaway`);
    }
    if (amount > layaway.balanceDue) {
      throw new Error("Payment exceeds balance due");
    }

    const now = new Date().toISOString();

    const payment: LayawayPayment = {
      id: crypto.randomUUID(),
      layawayId,
      tenderType: tenderType as LayawayPayment["tenderType"],
      amount,
      employeeId: ctx.employee.id,
      metadata: {},
      createdAt: now,
    };

    layaway.depositPaid += amount;
    layaway.balanceDue -= amount;
    layaway.status = layaway.balanceDue <= 0 ? "paid_in_full" : "partially_paid";
    layaway.updatedAt = now;

    store.layawayPayments.push(payment);
  });

  revalidatePath("/admin");
}

export async function cancelLayawayAction(layawayId: string, reason: string) {
  const ctx = await requireAdminPermission("register.open");
  if (!ctx) throw new Error("Not authenticated");

  await mutateStore((store) => {
    const layaway = store.layaways.find((l) => l.id === layawayId);
    if (!layaway) throw new Error("Layaway not found");
    if (layaway.status !== "active" && layaway.status !== "partially_paid") {
      throw new Error(`Cannot cancel ${layaway.status} layaway`);
    }

    const now = new Date().toISOString();
    layaway.status = "cancelled";
    layaway.cancelledBy = ctx.employee.id;
    layaway.cancelledAt = now;
    layaway.cancellationReason = reason || "Manager cancelled";
    layaway.updatedAt = now;

    // Release reserved inventory
    // (Inventory reservation is tracked via the cart snapshot items)
  });

  revalidatePath("/admin");
}

export async function collectLayawayAction(layawayId: string) {
  await mutateStore((store) => {
    const layaway = store.layaways.find((l) => l.id === layawayId);
    if (!layaway) throw new Error("Layaway not found");
    if (layaway.status !== "paid_in_full") {
      throw new Error("Layaway must be paid in full before collection");
    }

    layaway.status = "collected";
    layaway.updatedAt = new Date().toISOString();
  });

  revalidatePath("/admin");
}
