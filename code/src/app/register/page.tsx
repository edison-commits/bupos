import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AppNav } from "@/components/layout/app-nav";
import { PosSidebar } from "@/components/layout/pos-sidebar";
import { RegisterConsole } from "@/components/register/register-console";
import { registerLoginAction } from "@/app/register/actions";
import { PinLoginForm } from "@/components/register/pin-login-form";
import { getRegisterSession } from "@/lib/auth/session";
import { readStore } from "@/lib/persistence/store";
import type { LocalStoreData } from "@/lib/persistence/types";

import { safeErr } from "@/lib/logging/safe-err";
export const metadata: Metadata = { title: "Register | BasicUniformPOS" };

/**
 * Fetch the default active location for the unauthenticated PIN-login screen.
 *
 * R27-M6: previously this called an `anon`-executable SECURITY DEFINER
 * RPC (`get_default_active_location`), which meant every unauthenticated
 * visitor to `/register` could learn a live tenant's locationId suitable
 * for feeding to /api/auth/register-login for PIN brute force. Under the
 * old ranking (login_rank ASC, name_rank ASC, created_at ASC), the
 * revealed tenant was predictable and stable — an external attacker
 * could seed their attack without ever needing an account.
 *
 * New shape: the server component runs inside the Worker and already
 * has direct `postgres`-role DB access via `getPool()`. We make the
 * same query server-side, and DO NOT expose any anon-callable way
 * for an external visitor to learn a locationId. The paired migration
 * 055 revokes the `anon`/`authenticated` grant on the RPC.
 *
 * Security: we still return a location to the visitor so the PIN form
 * can be populated — the real defense is the per-IP rate limit on
 * /api/auth/register-login (R27-H1), which caps brute force regardless
 * of how the locationId was obtained. Hiding the locationId removes
 * one recon step but is not itself the isolation boundary.
 */
async function getDefaultLocation() {
  try {
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();
    // check-pool-org-filter: scoped-by-pre-login-location-picker
    // This is the pre-authentication location-picker; no org is known
    // yet (the caller has no session cookie). Returns a single row
    // shaped (id, name). The same ordering as the old RPC.
    const { rows } = await pool.query(
      `WITH ranked AS (
         SELECT l.id,
                CASE WHEN COALESCE(l.name, '') = '' THEN 'Store' ELSE l.name END AS name,
                l.created_at,
                CASE WHEN EXISTS (
                  SELECT 1
                    FROM employees e
                    JOIN auth_credentials ac ON ac.employee_id = e.id
                   WHERE e.is_active = true
                     AND ac.pin_hash IS NOT NULL
                     AND l.id = ANY(e.location_ids)
                ) THEN 0 ELSE 1 END AS login_rank,
                CASE WHEN COALESCE(l.name, '') = '' THEN 1 ELSE 0 END AS name_rank
           FROM locations l
          WHERE l.is_active = true
       )
       SELECT id::text AS id, name
         FROM ranked
        ORDER BY login_rank ASC, name_rank ASC, created_at ASC
        LIMIT 1`,
    );
    const row = rows[0] as { id?: string; name?: string } | undefined;
    if (!row || !row.id) return { id: '', name: 'Default Location' };
    return { id: row.id, name: row.name ?? 'Default Location' };
  } catch (e) {
    console.error('[register/page] getDefaultLocation failed:', safeErr(e));
    return { id: '', name: 'Default Location' };
  }
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let session = null;
  try {
    session = await getRegisterSession();
  } catch (e: unknown) {
    // Session lookup failed (pool issue on edge) — treat as unauthenticated
    console.error("[register/page] getRegisterSession failed:", safeErr(e));
  }

  // Lightweight: only load full store when logged in (RegisterConsole needs it).
  // Unauthenticated: just grab the active location name + id — single cheap query.
  let store: LocalStoreData | null = null;
  if (session) {
    try {
      store = await readStore(session.employee.organizationId);
    } catch (e: unknown) {
      console.error("[register/page] readStore failed:", safeErr(e));
      // Redirect to login instead of looping back to /register
      redirect("/register?error=Failed+to+load+store+data");
    }
    // TZ is applied via `runWithTimeZone` around the render below so it
    // stays request-scoped on Cloudflare Workers. Setting module-scope
    // state here leaked TZ across concurrent requests (R9-C-3).
  }
  let location = { id: '', name: 'Default Location' };
  try {
    location = session
      ? store!.locations[0] ?? session.location
      : await getDefaultLocation();
  } catch (e: unknown) {
    console.error('[register/page] location lookup failed:', safeErr(e));
  }

  const sidebarProps = session
    ? {
        employeeName: `${session.employee.firstName} ${session.employee.lastName}`,
        isClockedIn: true,
      }
    : {};

  // Compute session info for the header bar
  const headerSession = session && store && session.activeShift
    ? {
        employeeName: `${session.employee.firstName} ${session.employee.lastName}`,
        locationName: session.location.name,
        shiftOpenedAt: session.activeShift.openedAt,
        openingFloat: session.activeShift.openingFloat,
        payInTotal: store.payInOuts.filter((p: { direction: string }) => p.direction === "pay_in").reduce((s: number, p: { amount: number }) => s + p.amount, 0),
        payOutTotal: store.payInOuts.filter((p: { direction: string }) => p.direction === "pay_out").reduce((s: number, p: { amount: number }) => s + p.amount, 0),
      }
    : undefined;

  const notice = typeof params.notice === "string" ? params.notice.replaceAll("+", " ") : undefined;
  const error = typeof params.error === "string" ? params.error.replaceAll("+", " ") : undefined;

  const orgTz = store?.organization?.timezone || "UTC";
  const { runWithTimeZone } = await import("@/lib/format");
  return runWithTimeZone(orgTz, () => (
    <div className="pos-shell flex flex-col min-h-screen">
      <AppNav session={headerSession} />
      <div className="flex flex-1 min-h-0">
        <PosSidebar {...sidebarProps} />
        <main className="flex-1 min-w-0 overflow-hidden">
          {session && store ? (
            <RegisterConsole store={store} context={session} notice={notice} error={error} />
          ) : (
            <div className="h-full flex items-center justify-center p-6">
              <div className="w-full max-w-2xl">
                <section className="card px-8 py-8">
                  <h2 className="text-2xl font-semibold">PIN login</h2>
                  <p className="mt-2 text-sm text-zinc-600">Enter your PIN to open a register session at {location.name}.</p>
                  <form action={registerLoginAction} className="mt-5">
                    <PinLoginForm locationId={location.id} />
                  </form>
                  {notice ? <p className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}
                  {error ? <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
                </section>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  ));
}
