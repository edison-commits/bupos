import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AppNav } from "@/components/layout/app-nav";
import { PosSidebar } from "@/components/layout/pos-sidebar";
import { RegisterConsole } from "@/components/register/register-console";
import { StoreClockIn } from "@/components/register/store-clock-in";
import { TimezoneBootstrap } from "@/components/system/timezone-bootstrap";
import { getRegisterSession } from "@/lib/auth/session";
import { readStore } from "@/lib/persistence/store";
import type { LocalStoreData } from "@/lib/persistence/types";
import type { RoleKey } from "@/lib/domain/types";

import { safeErr } from "@/lib/logging/safe-err";
import { sanitizeNotice } from "@/lib/utils/sanitize-notice";
export const metadata: Metadata = { title: "Register | BasicUniformPOS" };

interface RosterStore {
  id: string;
  name: string;
  employees: { id: string; name: string; role: string }[];
}

/**
 * Fetch every active store + its register-capable roster for the no-PIN
 * "tap your name" clock-in screen (the operator chose this over PIN
 * login). The server component runs inside the Worker with direct
 * `postgres`-role DB access; there is no anon-callable surface here.
 *
 * Disclosure note: a tap-to-clock-in UX inherently shows employee display
 * names + roles per store to anyone who can reach /register (there's no
 * secret to hide behind). Names are already the abbreviated `display_name`
 * (e.g. "Chris C."). Only employees whose role carries register
 * permissions are listed, and only stores with at least one such employee.
 */
async function getStoresWithRoster(): Promise<RosterStore[]> {
  try {
    const { getPool } = await import("@/lib/supabase-rest");
    const pool = await getPool();
    // check-pool-org-filter: scoped-by-pre-login-store-roster
    // Pre-authentication roster picker; no org is known yet (no session
    // cookie). The JOIN ties each employee to its location's org.
    const { rows } = await pool.query(
      `SELECT l.id::text AS location_id,
              CASE WHEN COALESCE(l.name, '') = '' THEN 'Store' ELSE l.name END AS location_name,
              e.id::text AS employee_id,
              COALESCE(e.display_name, e.first_name || ' ' || e.last_name) AS employee_name,
              e.role_key
         FROM locations l
         JOIN employees e
           ON e.organization_id = l.organization_id
          AND l.id = ANY(e.location_ids)
          AND e.is_active = true
        WHERE l.is_active = true
        ORDER BY l.created_at ASC, employee_name ASC`,
    );
    const { hasPermission } = await import("@/lib/domain/permissions");
    const byLoc = new Map<string, RosterStore>();
    for (const r of rows as Array<{
      location_id: string; location_name: string;
      employee_id: string; employee_name: string; role_key: string;
    }>) {
      const role = r.role_key as RoleKey;
      // Only list employees who can actually open a register.
      if (!hasPermission(role, "register.open") || !hasPermission(role, "register.pin_login")) continue;
      let loc = byLoc.get(r.location_id);
      if (!loc) {
        loc = { id: r.location_id, name: r.location_name, employees: [] };
        byLoc.set(r.location_id, loc);
      }
      loc.employees.push({ id: r.employee_id, name: r.employee_name, role: r.role_key });
    }
    // Only surface stores that have at least one register-capable employee.
    return Array.from(byLoc.values()).filter((s) => s.employees.length > 0);
  } catch (e) {
    console.error("[register/page] getStoresWithRoster failed:", safeErr(e));
    return [];
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
  // Unauthenticated visitors get the store roster for the no-PIN
  // "tap your name" clock-in. Logged-in users skip straight to the console.
  const stores: RosterStore[] = session ? [] : await getStoresWithRoster();

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

  // R44-FE2: sanitize URL-param content — see lib/utils/sanitize-notice.
  const notice = sanitizeNotice(params.notice) ?? undefined;
  const error = sanitizeNotice(params.error) ?? undefined;

  const orgTz = store?.organization?.timezone || "UTC";
  const { runWithTimeZone } = await import("@/lib/format");
  return runWithTimeZone(orgTz, () => (
    <div className="pos-shell flex flex-col min-h-screen">
      {/*
        Sets the CLIENT default timezone to the org's value DURING render so
        the very first client render (hydration) formats dates the same way
        the server did inside runWithTimeZone(orgTz). Must sit above AppNav /
        RegisterConsole — both format the shift-opened time via
        formatDateTime, and without this the client fell back to the
        hardcoded LA default (format.ts `_clientTz`), causing a React #418
        hydration mismatch on /register?notice=Clocked+in whenever the org
        TZ ≠ America/Los_Angeles. The admin console already does this
        (admin-console.tsx); the register tree was missing it.
      */}
      <TimezoneBootstrap timezone={orgTz} />
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
                  <StoreClockIn stores={stores} />
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
