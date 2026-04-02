import { AppNav } from "@/components/layout/app-nav";
import { PosSidebar } from "@/components/layout/pos-sidebar";
import { RegisterConsole } from "@/components/register/register-console";
import { registerLoginAction } from "@/app/register/actions";
import { PinLoginForm } from "@/components/register/pin-login-form";
import { getRegisterSession } from "@/lib/auth/session";
import { readStore } from "@/lib/persistence/store";
import pool from "@/lib/db";

/** Single-row query — no joins, no full store load. Used only for unauthenticated PIN login. */
async function getDefaultLocation() {
  const { rows } = await pool.query(
    "SELECT id, name FROM locations WHERE is_active = true LIMIT 1",
  );
  if (!rows[0]) throw new Error("No active location found");
  return { id: rows[0].id as string, name: rows[0].name as string };
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await getRegisterSession();

  // Lightweight: only load full store when logged in (RegisterConsole needs it).
  // Unauthenticated: just grab the active location name + id — single cheap query.
  const store = session ? await readStore() : null;
  const location = session
    ? store!.locations[0] ?? session.location
    : await getDefaultLocation();

  const sidebarProps = session
    ? {
        employeeName: `${session.employee.firstName} ${session.employee.lastName}`,
        isClockedIn: session.activeShift !== null,
      }
    : {};

  const notice = typeof params.notice === "string" ? params.notice.replaceAll("+", " ") : undefined;
  const error = typeof params.error === "string" ? params.error.replaceAll("+", " ") : undefined;

  return (
    <div className="pos-shell">
      <AppNav />
      <div className="mx-auto flex w-full max-w-7xl px-4 py-6 md:px-6">
        <PosSidebar {...sidebarProps} />
        <main className="flex-1 min-w-0">
          {session ? (
            <RegisterConsole store={store!} context={session} notice={notice} error={error} />
          ) : (
            <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
              <section className="card px-6 py-6">
                <h2 className="text-xl font-semibold">PIN login</h2>
                <p className="mt-2 text-sm text-zinc-600">Enter your PIN to open a register session at {location.name}. Demo PINs: 1111 owner · 2222 manager · 3333 cashier.</p>
                <form action={registerLoginAction} className="mt-5">
                  <PinLoginForm locationId={location.id} />
                </form>
                {notice ? <p className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}
                {error ? <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
              </section>

              <section className="card px-6 py-6">
                <h2 className="text-xl font-semibold">BasicUniformPOS register</h2>
                <p className="mt-3 text-sm text-zinc-600">
                  Log in with your PIN, open a shift, and start selling. The register supports cash, card, and store credit payments with split tender. Manager approval is required for discounts, voids, and store credits above configured thresholds.
                </p>
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
