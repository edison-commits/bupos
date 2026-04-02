"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";

const topLinks = [
  { href: "/", label: "Overview" },
  { href: "/register", label: "Register" },
  { href: "/admin", label: "Admin" },
];

export function AppNav() {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/register") return pathname.startsWith("/register");
    if (href === "/admin") return pathname.startsWith("/admin");
    return pathname === href;
  };

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
        <div className="hidden gap-1 md:flex">
          {topLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                color: isActive(link.href)
                  ? `var(--text-primary)`
                  : `var(--text-secondary)`,
                borderBottomColor: isActive(link.href)
                  ? `var(--surface-accent)`
                  : "transparent",
                borderBottomWidth: "2px",
                paddingBottom: "2px",
                transition: "all 0.2s ease",
                backgroundColor: isActive(link.href) ? `${link.href === "/register" ? "var(--surface-accent)" : "transparent"}` : "transparent",
                borderRadius: "0.5rem",
                padding: "0.25rem 0.75rem",
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
          {topLinks.map((link) => (
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
