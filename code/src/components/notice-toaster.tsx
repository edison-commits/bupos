"use client";

import { useEffect } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
// R45-M: import the shared sanitizer (from R44-FE2). Prior shape
// had a local copy with slightly narrower vanity-phone regex
// (`{4,7}` vs the shared `{4,10}`), so messages like
// `1-888-ATTACKER` were blocked by the shared util but accepted
// by the toaster. Two copies drifting is how regressions happen;
// importing the shared version makes the rule canonical.
import { sanitizeNotice } from "@/lib/utils/sanitize-notice";

/**
 * Reads `?notice=` and `?error=` URL search params and fires sonner toasts.
 * Works with server actions that redirect with query-string feedback.
 * Content is gated through the shared `sanitizeNotice` helper so
 * phishing-style URL/phone/email content is dropped silently.
 */

export function NoticeToaster() {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  useEffect(() => {
    const notice = sanitizeNotice(searchParams.get("notice") ?? undefined);
    const error = sanitizeNotice(searchParams.get("error") ?? undefined);

    if (notice) {
      toast.success(notice);
    }
    if (error) {
      toast.error(error);
    }
  }, [searchParams, pathname]);

  return null;
}
