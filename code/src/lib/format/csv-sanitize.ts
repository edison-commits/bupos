/**
 * R39-A2-7: CSV cell sanitizer shared between the server export
 * endpoint (`/api/export`) and the client-side admin data-export UI.
 *
 * A cell that starts with `=`, `+`, `-`, `@`, `\t`, or `\r` is
 * interpreted as a formula by Excel / Google Sheets / Apple Numbers —
 * including payloads like `=cmd|' /C calc'!A0` that can execute arbitrary
 * commands when the user opens the spreadsheet. Also strips leading
 * BOM / zero-width-space / whitespace runs before the check: Excel
 * treats `\t` (tab, 0x09) and `\r` (CR, 0x0D) as formulas — leading
 * invisible chars would otherwise let the formula slip past a naïve
 * first-byte check.
 *
 * Prefix the ORIGINAL string with a single quote so the stored data
 * isn't mutated beyond the escape. Excel treats the leading `'` as
 * "text cell" and hides it from display.
 *
 * Previously lived inline in `src/app/api/export/route.ts`. The
 * client-side `src/components/admin/data-export.tsx` had its own
 * downloadCSV helper that only quote-escaped cells, missing formula
 * defense entirely. Consolidated here so both paths stay in sync.
 */
export function sanitizeCsvCell(str: string): string {
  if (str.length === 0) return str;
  const stripped = str.replace(/^[\uFEFF\u200B\s]+/, "");
  if (stripped.length > 0 && /^[=+\-@\t\r]/.test(stripped)) {
    return "'" + str;
  }
  return str;
}

/**
 * Wrap a single cell for CSV (escape quotes, add quotes if it
 * contains comma/quote/newline). Always runs sanitizeCsvCell first.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const str = sanitizeCsvCell(String(v));
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
