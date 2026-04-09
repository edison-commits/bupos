"use server";

import { generateAndPersistFlags } from "@/lib/behavior/flag-engine";
import { mutateStore } from "@/lib/persistence/store";
import { requireAdminPermission } from "@/lib/authz";
import { revalidatePath } from "next/cache";

export async function runFlagEngineAction() {
  await requireAdminPermission("employee.manage");
  const newFlags = await mutateStore((store) => {
    return generateAndPersistFlags(store);
  });
  revalidatePath("/admin");
  return { generated: newFlags.length };
}

export async function reviewFlagAction(flagId: string, reviewNotes: string) {
  await requireAdminPermission("employee.manage");
  await mutateStore((store) => {
    const flag = store.behaviorFlags.find((f) => f.id === flagId);
    if (!flag) throw new Error("Flag not found");
    flag.isReviewed = true;
    flag.reviewedAt = new Date().toISOString();
    flag.reviewNotes = reviewNotes || "Reviewed";
  });
  revalidatePath("/admin");
}
