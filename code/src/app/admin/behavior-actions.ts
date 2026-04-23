"use server";

import { generateAndPersistFlags } from "@/lib/behavior/flag-engine";
import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import { revalidatePath } from "next/cache";
// R84-final: bust readStore cache so admin dashboards don't serve
// stale flag list for 30s after scan/review.
import { invalidateStoreCache } from "@/lib/persistence/postgres-read-store";

export async function runFlagEngineAction() {
  const { employee } = await requireAdminPermission("employee.manage");
  const newFlags = await mutateStore((store) => {
    return generateAndPersistFlags(store);
  });
  invalidateStoreCache(employee.organizationId);
  invalidateStoreCache(employee.organizationId);
  revalidatePath("/admin");
  return { generated: newFlags.length };
}

export async function reviewFlagAction(flagId: string, reviewNotes: string) {
  const { employee } = await requireAdminPermission("employee.manage");
  await mutateStore((store) => {
    const flag = store.behaviorFlags.find((f) => f.id === flagId);
    if (!flag) throw new Error("Flag not found");
    flag.isReviewed = true;
    flag.reviewedAt = new Date().toISOString();
    flag.reviewNotes = reviewNotes || "Reviewed";
  });
  invalidateStoreCache(employee.organizationId);
  revalidatePath("/admin");
}
