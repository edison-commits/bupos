import { getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AppNav } from "@/components/layout/app-nav";
import { PageShell } from "@/components/ui/page-shell";

export default async function SalesPage() {
  const session = await getAdminSession();

  if (!session) {
    redirect("/");
  }

  return (
    <PageShell
      eyebrow="Sales"
      title="Sales"
      description="Track and manage your sales."
    >
      <AppNav />
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-zinc-900">Sales</h2>
        <p className="mt-2 text-sm text-zinc-500">Sales overview coming soon</p>
      </div>
    </PageShell>
  );
}
