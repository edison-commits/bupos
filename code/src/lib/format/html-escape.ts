/**
 * R28-M5: single HTML-escape helper, shared across every route that
 * embeds user-controlled strings into HTML bodies (emails, receipts,
 * generated labels, etc.).
 *
 * Covers `& < > " '` — the full OWASP-recommended set for HTML body
 * AND attribute contexts. Prior implementations in multiple routes
 * covered only `& < >` (element-content context) which is safe for
 * those specific callers' element placement but fragile: a future
 * edit that moves a user field into an attribute (`<a href="${esc}">`)
 * would silently gain an attribute-break vulnerability.
 *
 * Use this for:
 *   • Resend email HTML bodies (password-reset, PIN-reset notify,
 *     receipts, EOD reports)
 *   • Any generated HTML that interpolates user-controlled strings
 *   • Any generated XML/SVG (though escXml in barcode-label-printer
 *     has its own variant — leave be)
 *
 * Do NOT use this for:
 *   • URL query param encoding → use `encodeURIComponent`
 *   • SQL LIKE pattern escaping → use the `[%_\\]` regex pattern
 *   • JSON stringification → use `JSON.stringify`
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" :
    "&#39;"
  ));
}
