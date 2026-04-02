"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const posLinks = [
  { href: "/register", label: "New Sale", icon: "💳" },
  { href: "/admin/transactions", label: "Transactions", icon: "📋" },
  { href: "/admin/returns", label: "Returns", icon: "↩️" },
  { href: "/admin/inventory", label: "Inventory", icon: "📦" },
  { href: "/admin/shift-close", label: "Shift Close", icon: "🔒" },
  { href: "/admin/products", label: "Products", icon: "🏷️" },
  { href: "/admin/customers", label: "Customers", icon: "👥" },
  { href: "/admin/loyalty", label: "Loyalty", icon: "⭐" },
  { href: "/admin/cash-drawer", label: "Cash Drawer", icon: "💵" },
];

export interface PosSidebarProps {
  employeeName?: string;
  isClockedIn?: boolean;
}

export function PosSidebar({ employeeName, isClockedIn }: PosSidebarProps) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/register") return pathname === "/register";
    return pathname.startsWith(href);
  };

  return (
    <aside
      className="flex flex-col gap-3 w-60 shrink-0 p-4"
      style={{
        backgroundColor: "var(--surface-panel)",
        borderRight: "1px solid var(--border-subtle)",
        minHeight: "calc(100vh - 57px)",
      }}
    >
      {/* Clocked-in employee banner */}
      {isClockedIn && employeeName ? (
        <div
          className="flex flex-col items-center justify-center rounded-2xl px-4 py-5 text-center"
          style={{
            backgroundColor: "var(--surface-accent)",
            color: "#ffffff",
            minHeight: "72px",
          }}
        >
          <p className="text-xs font-semibold uppercase tracking-wider opacity-80">Clocked in</p>
          <p className="mt-1 text-lg font-bold">{employeeName}</p>
        </div>
      ) : (
        <Link
          href="/admin/shift-close"
          className="flex items-center justify-center gap-3 rounded-2xl px-5 py-4 transition-all w-full text-center"
          style={{
            backgroundColor: "var(--surface-panel-muted, #f4f4f5)",
            color: "var(--text-primary)",
            fontSize: "1.125rem",
            fontWeight: 600,
            minHeight: "60px",
            border: "2px solid var(--border-subtle)",
          }}
        >
          <span className="text-2xl leading-none">🕐</span>
          <span>Clock In</span>
        </Link>
      )}

      {/* Navigation buttons */}
      {posLinks
        .filter((link) => !(link.href === "/admin/shift-close" && isClockedIn))
        .map((link) => {
          const active = isActive(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className="flex items-center gap-3 rounded-2xl px-5 py-4 transition-all w-full text-left"
              style={{
                backgroundColor: active ? "var(--surface-accent)" : "var(--surface-panel-muted, #f4f4f5)",
                color: active ? "#ffffff" : "var(--text-primary)",
                fontSize: "1.125rem",
                fontWeight: 600,
                minHeight: "60px",
                border: active ? "2px solid var(--surface-accent)" : "2px solid var(--border-subtle)",
                boxShadow: active ? "0 4px 12px rgba(20,184,166,0.25)" : "0 2px 4px rgba(0,0,0,0.06)",
              }}
            >
              <span className="text-2xl leading-none">{link.icon}</span>
              <span>{link.label}</span>
            </Link>
          );
        })}
    </aside>
  );
}
