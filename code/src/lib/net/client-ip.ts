/**
 * R28-M3: centralized client-IP extraction with spoof-resistant
 * defaults.
 *
 * Background: most of our auth routes accept `x-forwarded-for` as a
 * fallback when `cf-connecting-ip` is absent. On Cloudflare, the edge
 * strips and replaces XFF — safe. Off Cloudflare (local dev,
 * `wrangler dev`, staging behind something else), XFF is
 * client-controllable: an attacker can spoof it on every request and
 * rotate the per-IP rate-limit bucket.
 *
 * This helper:
 *   • ALWAYS prefers `cf-connecting-ip` (Cloudflare sets this and can't
 *     be forged).
 *   • Only trusts XFF when the environment explicitly opts in via
 *     `TRUST_FORWARDED_FOR=1`. Default: off. Matches the industry
 *     pattern for HTTP frameworks behind unknown proxies (Express
 *     `trust proxy`, Fastify `trustProxy`, etc.).
 *   • Returns `"unknown"` when nothing trustworthy is present — that
 *     collapses all unknown-origin clients into a single bucket,
 *     which is a tighter ceiling than rotating-per-request spoofing.
 */
// AUTH-AUDIT6-HIGH1: accept any header bag exposing `get()` so Server
// Actions can pass Next's `ReadonlyHeaders` (from `await headers()`),
// not just the route-handler `Request.headers` (`Headers`). Both satisfy
// this structural type; existing callers passing `Headers` are unaffected.
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const trustXff = process.env.TRUST_FORWARDED_FOR === "1";
  if (trustXff) {
    const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }

  return "unknown";
}
