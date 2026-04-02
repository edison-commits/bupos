import { LoginForm } from "@/components/auth/login-form";
import Link from "next/link";
import { getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  // If already logged in, go straight to admin
  const session = await getAdminSession();
  if (session) {
    redirect("/admin");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-md">
        {/* Logo / brand */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600">
            <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">BasicUniformPOS</h1>
          <p className="mt-1 text-sm text-zinc-500">Web-first retail POS for your store</p>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Sign in</h2>
          <p className="mt-1 text-sm text-zinc-500">Enter your admin credentials to continue.</p>

          <LoginForm />
        </div>

        {/* Signup CTA */}
        <p className="mt-6 text-center text-sm text-zinc-500">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium text-teal-700 hover:text-teal-600">
            Create your store
          </Link>
        </p>
      </div>
    </div>
  );
}
