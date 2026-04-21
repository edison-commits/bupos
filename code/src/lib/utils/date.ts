import { getDefaultTimeZone } from "@/lib/format";

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function formatDateTime(value: string) {
  // Pin the timezone so the SSR output (which runs in UTC on Workers) and
  // the client's first render produce the same string. Without this we
  // get React #418 hydration failures whenever a page renders a date
  // (e.g. "Session opened Apr 16, 5:26 PM" on /register). The default is
  // overridable per-org via setDefaultTimeZone() so stores in other
  // timezones see correct dates.
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: getDefaultTimeZone(),
  }).format(new Date(value));
}
