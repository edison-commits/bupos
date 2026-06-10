import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

/**
 * Standard empty state: icon + title + one-line explanation + optional CTA.
 * Replaces bare "No results found" text on list pages so first-run screens
 * point the user at the next action instead of dead-ending.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  /** Either {label, href} for a link CTA, or any custom node (e.g. a button). */
  action?: { label: string; href: string } | ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {Icon && (
        <span
          className="mb-3 flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: "var(--surface-panel-muted)", color: "var(--text-secondary)" }}
        >
          <Icon className="h-6 w-6" />
        </span>
      )}
      <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm" style={{ color: "var(--text-secondary)" }}>{description}</p>
      )}
      {action && (
        <div className="mt-4">
          {typeof action === "object" && action !== null && "href" in action && "label" in action ? (
            <Link
              href={(action as { href: string }).href}
              className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-white"
              style={{ background: "var(--surface-accent)" }}
            >
              {(action as { label: string }).label}
            </Link>
          ) : (
            (action as ReactNode)
          )}
        </div>
      )}
    </div>
  );
}
