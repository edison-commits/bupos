/**
 * Redact an error for safe logging.
 *
 * Cloudflare Workers logs retain 30 days of data. Raw pg error objects may
 * include query text + parameter values (emails, session IDs, etc.), and
 * error.stack can include file paths with deployment internals. This helper
 * projects only the safe-subset of fields and truncates to 200 chars so a
 * malicious payload doesn't blow up log volume.
 *
 * Use at every `console.error` in API routes + server actions instead of
 * passing the raw `err` object. Originally defined inline in
 * `/api/auth/register-login/route.ts` and duplicated nowhere else — until
 * R18-LOW-2 surfaced that the sibling `/api/auth/login` was logging raw
 * errors.
 */
// R32-D8: node-postgres embeds the offending value in Error.message
// for unique-constraint violations, e.g.
//   `duplicate key value violates unique constraint "uniq_customers_email"
//    DETAIL: Key (email)=(alice@example.com) already exists.`
// The 200-char truncation can leak PII (email, sku, phone) into
// Logpush retention. Strip the `DETAIL: Key (…)=(…)` fragment (and
// any stray KEY (col)=(val) clause) before truncation so logs carry
// only the constraint name, not the key value.
function scrubPgDetail(s: string): string {
  return s
    // `DETAIL: Key (col)=(val) already exists.` or similar tails.
    .replace(/\s*DETAIL:.*$/is, "")
    // `Key (col)=(val)` fragment that can appear in the base message.
    .replace(/Key\s*\([^)]*\)\s*=\s*\([^)]*\)/gi, "Key (…)=(…)");
}

export function safeErr(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    // R32-L-safeErr-fields: also scrub node-postgres's separate
    // `err.detail` field. Prior shape only whitelisted code/name/message
    // which meant .detail was implicitly dropped — but a future
    // `console.error({ err, ctx })` or a logger that stringifies the
    // whole error would expose it. Explicit here is safer than relying
    // on projection side-effects. Do NOT return `detail` in the output.
    return {
      code: (err as { code?: string }).code,
      name: err.name,
      message: scrubPgDetail(err.message).slice(0, 200),
    };
  }
  return { value: scrubPgDetail(String(err)).slice(0, 200) };
}
