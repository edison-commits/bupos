import { getDefaultTimeZone } from "@/lib/format";

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function formatDateTime(value: string, timeZone?: string) {
  // Pin the timezone so the SSR output and the client's first render
  // produce the same string — otherwise React #418 hydration failures
  // whenever a page renders a date (e.g. "Session opened Apr 16, 5:26 PM"
  // on /register).
  //
  // IMPORTANT: pass `timeZone` explicitly from any SERVER-rendered caller.
  // The async-local TZ set by `runWithTimeZone(orgTz, …)` does NOT survive
  // into React's render phase on Workers (the .run() scope only wraps JSX
  // *construction*, not the later component render), so during SSR
  // `getDefaultTimeZone()` falls back to "UTC" while the client renders in
  // the org's local zone — a guaranteed mismatch. Passing the org TZ here
  // makes SSR and the client identical. When omitted, falls back to the
  // ambient default (fine for fully client-rendered callers).
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timeZone || getDefaultTimeZone(),
  }).format(new Date(value));
}
