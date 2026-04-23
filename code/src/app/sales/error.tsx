"use client";
import { ErrorFallback } from "@/components/shared/error-fallback";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorFallback error={error} reset={reset} section="sales" />;
}
