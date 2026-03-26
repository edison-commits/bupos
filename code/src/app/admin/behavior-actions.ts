"use server";

import { generateAndPersistFlags } from "@/lib/behavior/flag-engine";
import { mutateStore } from "@/lib/persistence/store";
import { revalidatePath } from "next/cache";

export async function runFlagEngineAction() {
  const newFlags = await mutateStore((store) => {
    return generateAndPersistFlags(store);
  });
  revalidatePath("/admin");
  return { generated: newFlags.length };
}

export async function reviewFlagAction(flagId: string, reviewNotes: string) {
  await mutateStore((store) => {
    const flag = store.behaviorFlags.find((f) => f.id === flagId);
    if (!flag) throw new Error("Flag not found");
    flag.isReviewed = true;
    flag.reviewedAt = new Date().toISOString();
    flag.reviewNotes = reviewNotes || "Reviewed";
  });
  revalidatePath("/admin");
}
