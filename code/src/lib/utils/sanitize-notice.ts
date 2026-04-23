/**
 * R44-FE2: shared sanitizer for `?error=` / `?notice=` URL-param
 * content that gets rendered into the UI.
 *
 * The client-side `<NoticeToaster>` (R42-Q / R43-LOW) hardened toasts
 * against URL-param content injection. But three server-rendered
 * pages still read `searchParams.error` / `searchParams.notice`
 * directly into app-branded banners:
 *   - `src/app/page.tsx` (home / login)
 *   - `src/app/register/page.tsx`
 *   - `src/app/admin/page.tsx` (auth-gated, lower severity)
 *
 * An attacker's `/?error=Call+1-888-ATTACKER+to+unlock+your+store`
 * otherwise renders attacker-controlled phishing text inside a styled
 * red banner on a bupos-origin login page. React auto-escapes HTML,
 * so this isn't XSS — it's content-injection social engineering on
 * an auth surface. `sanitizeNotice` drops messages that contain URLs
 * / phone numbers / email addresses / angle brackets / control chars,
 * and caps length at 200 Unicode codepoints.
 *
 * Returns the sanitized message, or null if the input fails the
 * filter (caller then renders nothing).
 */

const PLAIN_TEXT_PATTERN = /^[\p{L}\p{N}\p{P}\p{Z}\p{S}]{1,200}$/u;
const BLOCKED_PATTERNS = [
  /https?:\/\//i,
  /\bwww\./i,
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  // Vanity phone "1-888-ATTACKER" — widen the trailing word to 4-10
  // chars so common vanity numbers don't slip past.
  /\b\d{1,3}-\d{3}-[A-Z0-9]{4,10}\b/i,
  /@/,
  /[<>]/,
];

export function sanitizeNotice(raw: string | string[] | undefined): string | null {
  if (!raw || Array.isArray(raw)) return null;
  const msg = raw.replaceAll("+", " ");
  if (!PLAIN_TEXT_PATTERN.test(msg)) return null;
  for (const p of BLOCKED_PATTERNS) if (p.test(msg)) return null;
  return msg;
}
