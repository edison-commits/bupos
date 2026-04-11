import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "POS | BasicUniformPOS" };

export default function PosPage() {
  redirect("/register");
}
