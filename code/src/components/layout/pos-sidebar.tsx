"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const transactionalLinks = [
  {
    section: "Operations",
    items: [
      { href: "/register", label: "New Sale", icon: "💳" },
      { href: "/admin/transactions", label: "Transactions", icon: "📋" },
      { href: "/admin/returns", label: "Returns", icon: "↩️" },
      { href: "/admin/inventory", label: "Inventory", icon: "📦" },
      { href: "/admin/shift-close", label: "Shift Close", icon: "🔒" },
    ],
  },
  {
    section: "Management",
    items: [
      { href: "/admin/products", label: "Products", icon: "🏷️" },
      { href: "/admin/customers", label: "Customers", icon: "👥" },
      { href: "/admin/loyalty", label: "Loyalty", icon: "⭐" },
      { href: "/admin/cash-drawer", label: "Cash Drawer", icon: "💵" },
    ],
  },
];

export function PosSidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/register") return pathname === "/register" || pathname === "/register";
    return pathname.startsWith(href);
  };

  return (
    <aside
      className="flex flex-col gap-6 w-56 shrink-0"
      style={{
        backgroundColor: "var(--surface-panel)",
        borderRight: "1px solid var(--border-subtle)",
        minHeight: "calc(100vh - 57px)",
        paddingTop: "1.25rem",
      }}
    >
      {transactionalLinks.map((group) => (
        <div key={group.section} className="flex flex-col gap-1 px-3">
          <p
            className="mb-2 text-xs font-bold uppercase tracking-wider px-2"
            style={{ color: "var(--text-secondary)" }}
          >
            {group.section}
          </p>
          {group.items.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all"
                style={{
                  backgroundColor: active ? "var(--surface-accent)" : "transparent",
                  color: active ? "#ffffff" : "var(--text-secondary)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                <span className="text-base">{link.icon}</span>
                <span>{link.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
