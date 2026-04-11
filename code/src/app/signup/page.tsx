import Link from "next/link";
import { getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { SignupForm } from "@/components/auth/signup-form";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create Your Store",
  description: "Set up your BasicUniformPOS store in minutes. Manage inventory, sales, employees, and customers from one place.",
};

export default async function SignupPage() {
  const session = await getAdminSession();
  if (session) {
    redirect("/admin");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4" style={{ background: "var(--surface-app)" }}>
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600">
            <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>Create your store</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Get started with BasicUniformPOS in under a minute.</p>
        </div>

        {/* Signup card */}
        <div className="rounded-2xl border p-6 shadow-sm" style={{ background: "var(--surface-panel)", borderColor: "var(--border-subtle)" }}>
          <SignupForm />
        </div>

        {/* Back to login */}
        <p className="mt-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>
          Already have an account?{" "}
          <Link href="/" className="font-medium text-teal-700 hover:text-teal-600">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
