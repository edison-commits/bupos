/**
 * /admin/layout.tsx
 *
 * Auth gate for ALL /admin/* routes.
 * Checks for an active admin session; if absent, redirects to login.
 *
 * NOTE: /admin/page.tsx retains its own session check as a belt-and-suspenders
 * measure for direct navigation to the root /admin route.
 */
import { getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AdminShell } from "@/components/layout/admin-shell";

export const metadata: Metadata = {
  title: {
    template: "%s | BasicUniformPOS Admin",
    default: "Admin | BasicUniformPOS",
  },
  description: "BasicUniformPOS admin console: manage products, inventory, employees, sales, and store settings.",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session) {
    redirect("/?error=Please+sign+in+to+access+admin");
  }
  return (
    <AdminShell
      adminName={session.employee.displayName}
      adminRole={session.employee.roleKey}
    >
      {children}
    </AdminShell>
  );
}
