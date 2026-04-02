import { getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AppNav } from "@/components/layout/app-nav";
import { PageShell } from "@/components/ui/page-shell";

export default async function ProductsPage() {
  const session = await getAdminSession();

  if (!session) {
    redirect("/");
  }

  return (
    <PageShell
      eyebrow="Products"
      title="Products"
      description="Manage your product catalog and inventory."
    >
      <AppNav />
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-zinc-900">Products</h2>
        <p className="mt-2 text-sm text-zinc-500">Product management coming soon</p>
      </div>
    </PageShell>
  );
}
