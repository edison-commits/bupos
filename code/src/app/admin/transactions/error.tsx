"use client";
import { AdminErrorBoundary } from "@/components/admin/error-boundary";

export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <AdminErrorBoundary {...props} section="transactions" />;
}
