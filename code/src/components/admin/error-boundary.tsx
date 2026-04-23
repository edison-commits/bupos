"use client";

/**
 * R43-LOW: AdminErrorBoundary consolidated into a thin wrapper around
 * the shared `<ErrorFallback>`. Prior shape was a separate near-
 * identical component that R42-G's original leak (rendering
 * error.message) could easily drift back into — two components with
 * the same job, the same failure modes, maintained independently.
 *
 * All 24 admin/.../error.tsx files import `AdminErrorBoundary` from
 * this module; keeping the export name means no cross-repo rename.
 * Internally we just forward to ErrorFallback with a section prefix.
 */
import { ErrorFallback } from "@/components/shared/error-fallback";

export function AdminErrorBoundary({
  error,
  reset,
  section,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  section?: string;
}) {
  return <ErrorFallback error={error} reset={reset} section={section ?? "admin"} />;
}
