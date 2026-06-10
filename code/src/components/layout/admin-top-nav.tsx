"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const adminLinks = [
  { href: "/register", label: "Register" },
  { href: "/admin/dashboard", label: "Dashboard" },
  { href: "/admin/transactions", label: "Transactions" },
  { href: "/admin/inventory", label: "Inventory" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/employees", label: "Employees" },
  { href: "/admin/loyalty", label: "Loyalty" },
  { href: "/admin/promos", label: "Promos" },
  { href: "/admin/shifts", label: "Shifts" },
  { href: "/admin/audit", label: "Log" },
  { href: "/admin/clock-in", label: "Clock In" },
  { href: "/admin/cash-drawer", label: "Cash Drawer" },
  { href: "/admin/receiving", label: "Receiving" },
  { href: "/admin/online-selling", label: "Online Selling" },
  { href: "/admin/settings", label: "Settings" },
];

export function AdminTopNav() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/register") return pathname === "/register";
    if (href === "/admin/dashboard") return pathname === "/admin" || pathname === "/admin/dashboard";
    return pathname.startsWith(href);
  };

  return (
    <div
      className="sticky top-0 z-30 w-full"
      style={{
        backgroundColor: "var(--surface-panel)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div className="max-w-7xl mx-auto px-8 relative admin-top-nav-overflow-fade">
        {/*
          The relative + .admin-top-nav-overflow-fade class wires up
          the right-edge gradient fade defined in globals.css. On
          narrow viewports where some tabs (Cash Drawer, Receiving,
          Settings) overflow horizontally, the fade signals
          "scroll for more" instead of just truncating tabs.
        */}
        <div className="flex items-center gap-1 overflow-x-auto py-2 scroll-smooth">
          {adminLinks.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`flex-shrink-0 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-[var(--surface-accent)] text-white shadow-sm"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-panel-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
