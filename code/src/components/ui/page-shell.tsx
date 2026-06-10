import type { ReactNode } from "react";

export function PageShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="pos-shell">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 md:px-6">
        {/* Header */}
        <header>
          <p
            style={{
              color: "var(--surface-accent)",
              letterSpacing: "0.2em",
            }}
            className="text-sm font-semibold uppercase"
          >
            {eyebrow}
          </p>
          <h1
            style={{ color: `var(--text-primary)` }}
            className="mt-2 text-2xl font-bold tracking-tight"
          >
            {title}
          </h1>
          {description && (
            <p
              style={{ color: `var(--text-secondary)` }}
              className="mt-2 max-w-3xl text-base leading-6"
            >
              {description}
            </p>
          )}
        </header>

        {/* Content */}
        {children}
      </div>
    </div>
  );
}
