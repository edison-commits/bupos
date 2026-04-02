import { getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AppNav } from "@/components/layout/app-nav";
import { PageShell } from "@/components/ui/page-shell";

export default async function SettingsPage() {
  const session = await getAdminSession();

  if (!session) {
    redirect("/");
  }

  return (
    <PageShell
      eyebrow="Settings"
      title="Settings"
      description="Configure your store and account."
    >
      <AppNav />
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-zinc-900">Settings</h2>
        <p className="mt-2 text-sm text-zinc-500">Settings coming soon</p>
      </div>
    </PageShell>
  );
}
