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

export const metadata: Metadata = { title: "Register | BasicUniformPOS" };

/** Single-row query via Supabase RPC — no pool/WebSocket needed. */
async function getDefaultLocation() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return { id: '', name: 'Default Location' };
  const res = await fetch(
    `${supabaseUrl}/rest/v1/locations?is_active=eq.true&select=id,name&limit=1`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return { id: '', name: 'Default Location' };
  const rows = await res.json() as { id: string; name: string }[];
  if (!rows[0]) return { id: '', name: 'Default Location' };
  return rows[0];
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
    console.error("[register/page] getRegisterSession failed:", e);
  }

  // Lightweight: only load full store when logged in (RegisterConsole needs it).
  // Unauthenticated: just grab the active location name + id — single cheap query.
  let store: LocalStoreData | null = null;
  if (session) {
    try {
      store = await readStore(session.employee.organizationId);
    } catch (e: unknown) {
      console.error("[register/page] readStore failed:", e);
      // Redirect to clean state instead of crashing
      redirect("/register");
    }
  }
  let location = { id: '', name: 'Default Location' };
  try {
    location = session
      ? store!.locations[0] ?? session.location
      : await getDefaultLocation();
  } catch (e: unknown) {
    console.error('[register/page] location lookup failed:', e);
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

  return (
    <div className="pos-shell flex flex-col min-h-screen">
      <AppNav session={headerSession} />
      <div className="flex flex-1 min-h-0">
        <PosSidebar {...sidebarProps} />
        <main className="flex-1 min-w-0 overflow-hidden">
          {session ? (
            <RegisterConsole store={store!} context={session} notice={notice} error={error} />
          ) : (
            <div className="h-full flex items-center justify-center p-6">
              <div className="w-full max-w-2xl">
                <section className="card px-8 py-8">
                  <h2 className="text-2xl font-semibold">PIN login</h2>
                  <p className="mt-2 text-sm text-zinc-600">Enter your PIN to open a register session at {location.name}. Demo PINs: 1111 owner · 2222 manager · 3333 cashier.</p>
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
  );
}
