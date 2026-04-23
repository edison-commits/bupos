"use client";

import { useEffect } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";

/**
 * Reads `?notice=` and `?error=` URL search params and fires sonner toasts.
 * Works with server actions that redirect with query-string feedback.
 *
 * R42-Q: sanitize length + character set + block URL-like content. A
 * crafted phishing URL (e.g.
 * `https://basicuniformpos.com/?error=Your+account+is+locked.+Call+1-888-ATTACKER`)
 * otherwise renders an app-branded toast with attacker-controlled
 * content. React auto-escapes HTML, so this isn't XSS — but content
 * injection on an auth-adjacent page is enough for a social-engineer.
 *
 * Hardening:
 *   - Reject messages containing http:// / https:// / phone patterns /
 *     email addresses / @ / control characters
 *   - Cap length at 200 chars (prevents screen-spanning banners)
 *   - Require the message to be ASCII-printable plus common punctuation
 *   - Drop silently on any rejection (no toast leaks into UX)
 */
const PLAIN_TEXT_PATTERN = /^[\x20-\x7e]{1,200}$/; // printable ASCII, up to 200 chars
const BLOCKED_PATTERNS = [
  /https?:\/\//i,
  /\bwww\./i,
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,      // US phone
  /\b\d{1,3}-\d{3}-[A-Z0-9]{4,7}\b/i,        // 1-888-VANITY
  /@/,                                       // emails, handles
  /[<>]/,                                    // angle brackets (belt-and-suspenders, React already escapes)
];

function sanitizeNotice(raw: string | null): string | null {
  if (!raw) return null;
  const msg = raw.replaceAll("+", " ");
  if (!PLAIN_TEXT_PATTERN.test(msg)) return null;
  for (const p of BLOCKED_PATTERNS) if (p.test(msg)) return null;
  return msg;
}

export function NoticeToaster() {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  useEffect(() => {
    const notice = sanitizeNotice(searchParams.get("notice"));
    const error = sanitizeNotice(searchParams.get("error"));

    if (notice) {
      toast.success(notice);
    }
    if (error) {
      toast.error(error);
    }
  }, [searchParams, pathname]);

  return null;
}
