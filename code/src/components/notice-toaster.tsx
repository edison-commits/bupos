"use client";

import { useEffect } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";

/**
 * Reads `?notice=` and `?error=` URL search params and fires sonner toasts.
 * Works with server actions that redirect with query-string feedback.
 */
export function NoticeToaster() {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  useEffect(() => {
    const notice = searchParams.get("notice");
    const error = searchParams.get("error");

    if (notice) {
      toast.success(notice.replaceAll("+", " "));
    }
    if (error) {
      toast.error(error.replaceAll("+", " "));
    }
  }, [searchParams, pathname]);

  return null;
}
