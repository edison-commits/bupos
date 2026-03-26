"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Overview" },
  { href: "/register", label: "Register shell" },
  { href: "/admin", label: "Admin shell" },
  { href: "/admin/dashboard", label: "Dashboard" },
  { href: "/admin/transactions", label: "Transactions" },
  { href: "/admin/returns", label: "Returns" },
  { href: "/admin/inventory", label: "Inventory" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/receiving", label: "Receiving" },
  { href: "/admin/employees", label: "Employees" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/loyalty", label: "Loyalty" },
  { href: "/admin/shift-close", label: "Shift Close" },
  { href: "/admin/cash-drawer", label: "Cash Drawer" },
  { href: "/admin/reports", label: "Reports" },
  { href: "/admin/audit", label: "Audit Log" },
  { href: "/admin/purchase-orders", label: "Purchase Orders" },
  { href: "/admin/labels", label: "Labels" },
  { href: "/admin/settings", label: "Settings" },
];

export function AppNav() {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href;

  return (
    <nav
      style={{
        backgroundColor: `var(--surface-panel)`,
        borderBottomColor: `var(--border-subtle)`,
        borderBottomWidth: "1px",
      }}
      className="sticky top-0 z-40"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3 md:px-6">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div
            style={{ backgroundColor: "#14b8a6" }}
            className="h-2 w-2 rounded-full"
          ></div>
          <span
            style={{ color: `var(--text-primary)` }}
            className="text-base font-bold"
          >
            BasicUniformPOS
          </span>
        </div>

        {/* Desktop Nav Links */}
        <div className="hidden gap-6 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                color: isActive(link.href)
                  ? `var(--text-primary)`
                  : `var(--text-secondary)`,
                borderBottomColor: isActive(link.href)
                  ? `var(--text-primary)`
                  : "transparent",
                borderBottomWidth: "2px",
                paddingBottom: "2px",
                transition: "all 0.2s ease",
              }}
              className="text-base font-medium"
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* Mobile Hamburger Button */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="md:hidden"
          aria-label="Toggle navigation"
          style={{ color: `var(--text-primary)` }}
        >
          <svg
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            {isOpen ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile Menu */}
      {isOpen && (
        <div
          style={{
            backgroundColor: `var(--surface-panel)`,
            borderTopColor: `var(--border-subtle)`,
            borderTopWidth: "1px",
          }}
          className="flex flex-col gap-3 px-4 py-4 md:hidden"
        >
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setIsOpen(false)}
              style={{
                color: isActive(link.href)
                  ? `var(--text-primary)`
                  : `var(--text-secondary)`,
              }}
              className="text-base font-medium"
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
