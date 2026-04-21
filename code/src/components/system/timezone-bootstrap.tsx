"use client";

import { setDefaultTimeZone } from "@/lib/format";

/**
 * Sets the client-side default timezone from the org's configured value so
 * formatDate/formatDateTime output matches what SSR rendered. This must
 * execute during render (not useEffect) because the very first client
 * render is hydration, and any formatter call inside that render needs
 * the timezone already set to avoid React #418.
 *
 * Renders nothing.
 */
export function TimezoneBootstrap({ timezone }: { timezone?: string }) {
  if (timezone) setDefaultTimeZone(timezone);
  return null;
}
