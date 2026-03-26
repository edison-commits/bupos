"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function SectionCard({
  title,
  description,
  children,
  className,
  defaultCollapsed = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section className={cn("card px-5 py-5", className)}>
      <div className="mb-0 flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex flex-1 cursor-pointer items-start gap-3 text-left"
          aria-expanded={!collapsed}
        >
          {/* Chevron */}
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            style={{
              color: "var(--text-secondary)",
              transition: "transform 0.2s ease",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              flexShrink: 0,
              marginTop: "2px",
            }}
          >
            <path
              d="M6 8l4 4 4-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {description && !collapsed ? (
              <p className="text-sm text-zinc-600">{description}</p>
            ) : null}
          </div>
        </button>
      </div>

      {/* Collapsible content */}
      <div
        style={{
          display: collapsed ? "none" : "block",
          marginTop: "1rem",
        }}
      >
        {children}
      </div>
    </section>
  );
}
