/**
 * Format a number as US currency (USD)
 * @param amount The amount in dollars (as a number)
 * @returns Formatted string like "$123.45"
 */
export function formatCurrency(amount: number): string {
  return `$${Math.abs(amount).toFixed(2)}`;
}

/**
 * Format a percentage
 * @param percent The percentage value (0-100)
 * @returns Formatted string like "15.5%"
 */
export function formatPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

/**
 * Format a date as a readable string
 * @param date The date to format
 * @param includeTime Whether to include time
 * @returns Formatted date string
 */
export function formatDate(date: string | Date, includeTime = false): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  if (includeTime) {
    options.hour = "2-digit";
    options.minute = "2-digit";
  }
  return d.toLocaleDateString("en-US", options);
}
