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
  { href: "/admin/shifts", label: "Shifts" },
  { href: "/admin/audit", label: "Log" },
  { href: "/admin/clock-in", label: "Clock In" },
  { href: "/admin/cash-drawer", label: "Cash Drawer" },
  { href: "/admin/receiving", label: "Receiving" },
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
      <div className="max-w-7xl mx-auto px-8">
        <div className="flex items-center gap-1 overflow-x-auto py-2">
          {adminLinks.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className="flex-shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all"
                style={{
                  backgroundColor: active ? "var(--surface-accent)" : "transparent",
                  color: active ? "#ffffff" : "var(--text-secondary)",
                }}
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
