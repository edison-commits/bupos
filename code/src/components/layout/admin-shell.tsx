"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { adminLogoutAction } from "@/app/admin/actions";
import { CommandPalette } from "./command-palette";
import { NAV_GROUPS, type NavItem } from "./admin-nav";
import { Menu, Search, X } from "lucide-react";

/**
 * Global admin shell: grouped icon sidebar (desktop) + hamburger drawer
 * (mobile), rendered once from /admin/layout.tsx so every admin page shares
 * one navigation. The `/admin` console page is exempt — it's the legacy
 * all-in-one surface with its own internal section sidebar, reachable from
 * "More tools". Nav data lives in ./admin-nav (a leaf module) so the
 * command palette can import it without a circular dependency.
 */

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-4">
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base font-bold text-white"
        style={{ background: "var(--surface-accent)" }}
        aria-hidden
      >
        B
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>BuPOS</span>
        <span className="block text-[11px]" style={{ color: "var(--text-secondary)" }}>Basic Uniform POS</span>
      </span>
    </div>
  );
}

function NavLinks({ pathname }: { pathname: string }) {
  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
  return (
    <nav className="flex-1 overflow-y-auto px-2 pb-3">
      {NAV_GROUPS.map((group, gi) => (
        <div key={group.label ?? gi} className={gi === 0 ? "" : "mt-4"}>
          {group.label && (
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-secondary)" }}>
              {group.label}
            </p>
          )}
          <div className="grid gap-0.5">
            {group.items.map((item) => {
              const active = isActive(item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors"
                  style={
                    active
                      ? { background: "var(--surface-accent)", color: "#ffffff" }
                      : { color: "var(--text-secondary)" }
                  }
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--surface-panel-muted)"; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function UserCard({ adminName, adminRole }: { adminName: string; adminRole: string }) {
  return (
    <div className="border-t px-3 py-3" style={{ borderColor: "var(--border-subtle)" }}>
      <p className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{adminName}</p>
      <p className="text-xs capitalize" style={{ color: "var(--text-secondary)" }}>{adminRole}</p>
      <form action={adminLogoutAction} className="mt-2">
        <button
          className="w-full rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          style={{ background: "var(--surface-panel-muted)", color: "var(--text-primary)" }}
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

export function AdminShell({
  adminName,
  adminRole,
  children,
}: {
  adminName: string;
  adminRole: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Close the mobile drawer on navigation.
  useEffect(() => { setDrawerOpen(false); }, [pathname]);

  // The /admin console is the self-contained legacy surface with its own
  // internal section sidebar — don't double-wrap it.
  if (pathname === "/admin") return <>{children}</>;

  const sidebarInner = (
    <div className="flex h-full flex-col" style={{ background: "var(--surface-panel)" }}>
      <Wordmark />
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)", background: "var(--surface-panel-muted)" }}
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded border px-1 py-0.5 text-[10px]" style={{ borderColor: "var(--border-subtle)" }}>⌘K</kbd>
        </button>
      </div>
      <NavLinks pathname={pathname} />
      <UserCard adminName={adminName} adminRole={adminRole} />
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside
        className="sticky top-0 hidden h-screen w-60 shrink-0 border-r lg:block"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        {sidebarInner}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl">
            <div className="relative h-full">
              {sidebarInner}
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
                className="absolute right-2 top-4 rounded-md p-1.5"
                style={{ color: "var(--text-secondary)" }}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content column (mobile top bar + page) */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b px-3 lg:hidden"
          style={{ background: "var(--surface-panel)", borderColor: "var(--border-subtle)" }}
        >
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-1.5"
            style={{ color: "var(--text-primary)" }}
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>BuPOS</span>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} />
    </div>
  );
}
