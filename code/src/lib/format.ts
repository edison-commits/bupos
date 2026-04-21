/**
 * Shared formatting utilities.
 * All UI currency/date/number formatting should go through these helpers
 * so currency code and locale can be changed in one place.
 */

/**
 * Request-scoped default timezone for date formatters.
 *
 * On Cloudflare Workers a single isolate handles concurrent requests. A
 * previous implementation stored the org timezone in a module-scope `let`,
 * which made `setDefaultTimeZone` from Request A clobber the value during
 * Request B's SSR — cross-tenant TZ corruption on the admin dashboard.
 *
 * We now prefer `AsyncLocalStorage` (available on Workers via the Node.js
 * compat flag) so each request's async frame resolves its own TZ. On the
 * browser, where there's only ever one tab / one user at a time, the
 * module-scope fallback is safe. If AsyncLocalStorage is unavailable, any
 * call to setDefaultTimeZone becomes a no-op on the server side (we do NOT
 * silently fall back to the module scope there — safer to return UTC than
 * the wrong tenant's timezone).
 */
type AlsLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, cb: () => R): R;
};

// Lazily instantiate to avoid importing `node:async_hooks` in a browser
// chunk. `_als` is created the first time `setDefaultTimeZone` is called
// server-side; remains null on the browser.
//
// We memoize the PROMISE, not the resolved instance — two concurrent
// `ensureAls()` calls before the first one completed would otherwise both
// see `_als === null`, both await the dynamic import, and each create a
// fresh AsyncLocalStorage. Whichever assignment lost the race would then
// silently return `undefined` from `getDefaultTimeZone` (→ falls back to
// UTC), so concurrent requests in different TZs would contaminate again.
// Caught by scripts/test-r9-regressions.mjs first run.
let _als: AlsLike<{ tz: string }> | null = null;
let _alsPending: Promise<AlsLike<{ tz: string }> | null> | null = null;
let _clientTz = "America/Los_Angeles";

function isServer(): boolean {
  // Workers, Node, Edge runtimes all have no `window`.
  return typeof window === "undefined";
}

async function ensureAls(): Promise<AlsLike<{ tz: string }> | null> {
  if (_als) return _als;
  if (!isServer()) return null;
  if (_alsPending) return _alsPending;
  _alsPending = (async () => {
    try {
      const hooks = (await import("node:async_hooks")) as { AsyncLocalStorage?: new <T>() => AlsLike<T> };
      if (hooks.AsyncLocalStorage) {
        _als = new hooks.AsyncLocalStorage<{ tz: string }>();
        return _als;
      }
    } catch {
      // node:async_hooks not available (non-Workers edge runtime) — callers
      // fall through to explicit options.timeZone or UTC.
    }
    return null;
  })();
  return _alsPending;
}

export function setDefaultTimeZone(tz: string | null | undefined) {
  if (!tz || typeof tz !== "string") return;
  if (isServer()) {
    // On the server, setting the module-scope value would corrupt other
    // in-flight requests on the same isolate. Callers SHOULD wrap their
    // render in `runWithTimeZone(tz, async () => { ... })`, but we also
    // keep a best-effort no-op to preserve backwards compatibility.
    return;
  }
  _clientTz = tz;
}

export async function runWithTimeZone<R>(tz: string, cb: () => Promise<R> | R): Promise<R> {
  const als = await ensureAls();
  if (!als) return await cb();
  return als.run({ tz }, () => cb() as R);
}

export function getDefaultTimeZone(): string {
  if (!isServer()) return _clientTz;
  const store = _als?.getStore();
  return store?.tz ?? "UTC";
}

/**
 * Format a number as a currency string — always emits a thousands
 * separator (so $69485.22 renders as $69,485.22). Defaults to USD; a
 * future multi-currency build can pass an alternative code.
 *
 * Third arg was historically a locale string; keeping it for backward
 * compat. New callers can pass `{ fractionDigits: 0 }` to get
 * whole-dollar output (useful in tight tooltips/labels).
 */
export function formatCurrency(
  value: string | number,
  currency: string = 'USD',
  localeOrOpts: string | { locale?: string; fractionDigits?: number } = 'en-US',
): string {
  const { locale = 'en-US', fractionDigits } =
    typeof localeOrOpts === 'string' ? { locale: localeOrOpts } : localeOrOpts;
  const num = typeof value === 'string' ? parseFloat(value) : value;
  const options: Intl.NumberFormatOptions = { style: 'currency', currency };
  // Validate fractionDigits — Intl.NumberFormat throws RangeError on
  // negative, non-integer, Infinity, or NaN values. That would surface as
  // an uncaught exception in SSR. Ignore invalid values (fall back to the
  // default 2 decimals) rather than crash.
  if (typeof fractionDigits === 'number'
      && Number.isInteger(fractionDigits)
      && fractionDigits >= 0
      && fractionDigits <= 20) {
    options.minimumFractionDigits = fractionDigits;
    options.maximumFractionDigits = fractionDigits;
  }
  return new Intl.NumberFormat(locale, options).format(isNaN(num) ? 0 : num);
}

/**
 * Format an ISO date string as a locale-aware date.
 * Uses the browser/Node runtime default locale when no explicit locale is passed.
 */
export function formatDate(
  dateString: string,
  options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  },
  locale: string = 'en-US',
): string {
  // Pin timezone so server (UTC on Workers) and client first render agree,
  // and so multi-tenant orgs outside LA see correct dates.
  const withTz: Intl.DateTimeFormatOptions = options.timeZone
    ? options
    : { ...options, timeZone: getDefaultTimeZone() };
  return new Date(dateString).toLocaleDateString(locale, withTz);
}

/**
 * Format an ISO date string as a locale-aware datetime.
 */
export function formatDateTime(
  dateString: string,
  options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
  locale: string = 'en-US',
): string {
  // Pin timezone (see formatDate). Hydration mismatches surface on the
  // admin dashboard / transaction list whenever the server's UTC render
  // differs from the client's local-tz render.
  const withTz: Intl.DateTimeFormatOptions = options.timeZone
    ? options
    : { ...options, timeZone: getDefaultTimeZone() };
  return new Date(dateString).toLocaleString(locale, withTz);
}
