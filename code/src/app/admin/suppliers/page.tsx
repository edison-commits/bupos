import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { SupplierManager } from "@/components/admin/supplier-manager";

export const metadata: Metadata = {
  title: "Suppliers",
  description: "Manage vendors and suppliers: contact info, payment terms, and notes.",
};

export default function SuppliersPage() {
  return (
    <PageShell
      eyebrow="Catalog"
      title="Suppliers"
      description="Manage your vendors and suppliers. Add contact info, payment terms, and notes."
    >
      <div className="mb-4 flex justify-end">
        <Link href="/admin/supplier-returns" className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700">
          Supplier Returns
        </Link>
      </div>
      <SupplierManager />
    </PageShell>
  );
}
