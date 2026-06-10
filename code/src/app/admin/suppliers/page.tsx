import type { Metadata } from "next";
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
      <SupplierManager />
    </PageShell>
  );
}
