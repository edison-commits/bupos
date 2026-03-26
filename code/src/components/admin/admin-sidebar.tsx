"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type SectionKey =
  | "dashboard"
  | "catalog"
  | "inventory"
  | "staff"
  | "sales"
  | "reports"
  | "finance"
  | "calendar"
  | "manager_report"
  | "settings";

export const SECTIONS: { key: SectionKey; label: string; icon: string; color: string }[] = [
  { key: "dashboard", label: "Dashboard", icon: "📊", color: "#0f766e" },
  { key: "catalog", label: "Catalog", icon: "🏷️", color: "#7c3aed" },
  { key: "inventory", label: "Inventory", icon: "📦", color: "#b45309" },
  { key: "staff", label: "Staff", icon: "👥", color: "#0369a1" },
  { key: "sales", label: "Sales", icon: "💰", color: "#15803d" },
  { key: "reports", label: "Reports", icon: "📋", color: "#9333ea" },
  { key: "finance", label: "Finance", icon: "💳", color: "#be185d" },
  { key: "calendar", label: "Calendar", icon: "📅", color: "#c2410c" },
  { key: "manager_report", label: "Daily Report", icon: "📝", color: "#0e7490" },
  { key: "settings", label: "Settings", icon: "⚙️", color: "#525252" },
];

const SectionContext = createContext<{
  active: SectionKey;
  setActive: (key: SectionKey) => void;
}>({ active: "dashboard", setActive: () => {} });

export function useActiveSection() {
  return useContext(SectionContext);
}

export function AdminLayout({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) {
  const [active, setActive] = useState<SectionKey>("dashboard");

  return (
    <SectionContext.Provider value={{ active, setActive }}>
      <div className="flex min-h-[calc(100vh-12rem)] gap-6">
        {/* Sidebar */}
        <nav className="sticky top-24 hidden h-fit w-56 shrink-0 rounded-2xl border p-3 lg:block" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)' }}>
          {header}
          <div className="mt-3 grid gap-1">
            {SECTIONS.map((section) => (
              <button
                key={section.key}
                onClick={() => setActive(section.key)}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-all ${
                  active === section.key
                    ? "shadow-sm"
                    : "hover:bg-zinc-100/60"
                }`}
                style={active === section.key ? { background: `${section.color}12`, color: section.color, borderLeft: `3px solid ${section.color}` } : { color: 'var(--text-secondary)', borderLeft: '3px solid transparent' }}
              >
                <span className="text-base">{section.icon}</span>
                {section.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Mobile horizontal tabs */}
        <div className="fixed bottom-0 left-0 right-0 z-50 flex gap-1 overflow-x-auto border-t px-2 py-1.5 lg:hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)' }}>
          {SECTIONS.map((section) => (
            <button
              key={section.key}
              onClick={() => setActive(section.key)}
              className="flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all"
              style={active === section.key ? { background: `${section.color}18`, color: section.color } : { color: 'var(--text-secondary)' }}
            >
              <span className="text-sm">{section.icon}</span>
              {section.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 pb-20 lg:pb-0">{children}</div>
      </div>
    </SectionContext.Provider>
  );
}

export function SectionPanel({
  sectionKey,
  children,
}: {
  sectionKey: SectionKey;
  children: ReactNode;
}) {
  const { active } = useActiveSection();
  return (
    <div className={`grid gap-6 ${active === sectionKey ? "" : "hidden"}`}>
      {children}
    </div>
  );
}
