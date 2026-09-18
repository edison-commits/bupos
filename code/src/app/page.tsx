import Link from "next/link";
import { getAdminSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
// R44-FE2: sanitize `?error=` / `?notice=` URL-param content before
// rendering to block phishing-style content injection in app-branded
// banners on the auth-surface home page.
import { sanitizeNotice } from "@/lib/utils/sanitize-notice";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // If already logged in, go straight to admin
  const session = await getAdminSession();
  if (session) {
    redirect("/admin");
  }

  const error = sanitizeNotice(params.error) ?? undefined;
  const notice = sanitizeNotice(params.notice) ?? undefined;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4" style={{ background: "var(--surface-app)" }}>
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
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>BasicUniformPOS</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Web-first retail POS for your store</p>
        </div>

        <div className="mb-5 rounded-2xl border border-teal-200 bg-teal-50 p-5 text-center">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-800">New to BUPOS?</p>
          <h2 className="mt-2 text-lg font-semibold text-slate-900">See how BUPOS works</h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">Explore with sample store data before you create an account.</p>
          <Link href="/demo/features" className="mt-4 inline-flex rounded-full bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800">
            Review the product and demo
          </Link>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border p-6 shadow-sm" style={{ background: "var(--surface-panel)", borderColor: "var(--border-subtle)" }}>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Sign in</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Enter your admin credentials to continue.</p>

          <LoginForm />

          {notice && (
            <p className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>
          )}
          {error && (
            <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
          )}
        </div>

        {/* Signup CTA */}
        <p className="mt-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium text-teal-700 hover:text-teal-600">
            Create your store
          </Link>
        </p>
        <nav aria-label="Trust and support" className="mt-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-slate-600">
          <Link href="/privacy" className="hover:text-teal-700">Privacy</Link>
          <Link href="/terms" className="hover:text-teal-700">Terms</Link>
          <Link href="/support" className="hover:text-teal-700">Support</Link>
        </nav>
      </div>
    </div>
  );
}
