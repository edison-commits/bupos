import { AppNav } from "@/components/layout/app-nav";
import { AdminConsole } from "@/components/admin/admin-console";
import { PageShell } from "@/components/ui/page-shell";
import { getAdminSession } from "@/lib/auth/session";
import { readStore } from "@/lib/persistence/store";
import { redirect } from "next/navigation";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await getAdminSession();

  if (!session) {
    redirect("/?error=Please+sign+in+to+continue");
  }

  const store = await readStore();
  const notice = typeof params.notice === "string" ? params.notice.replaceAll("+", " ") : undefined;
  const error = typeof params.error === "string" ? params.error.replaceAll("+", " ") : undefined;

  return (
    <PageShell
      eyebrow="Admin"
      title={store.organization.name}
      description="Manage your store's catalog, inventory, employees, and settings."
    >
      <AppNav />
      <AdminConsole
        store={store}
        adminName={session.employee.displayName}
        adminRole={session.employee.roleKey}
        notice={notice}
        error={error}
      />
    </PageShell>
  );
}
