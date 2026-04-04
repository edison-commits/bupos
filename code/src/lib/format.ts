/**
 * Shared formatting utilities.
 * All UI currency/date/number formatting should go through these helpers
 * so currency code and locale can be changed in one place.
 */

/**
 * Format a number as a currency string.
 * Defaults to USD so callers don't need to pass it every time,
 * but accepts an optional `currency` arg for future multi-currency support.
 */
export function formatCurrency(
  value: string | number,
  currency: string = 'USD',
  locale: string = 'en-US',
): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(0);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(num);
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
  return new Date(dateString).toLocaleDateString(locale, options);
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
  return new Date(dateString).toLocaleString(locale, options);
}
