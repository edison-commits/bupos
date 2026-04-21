"use server";

import { randomUUID } from "@/lib/uuid";
import { revalidatePath } from "next/cache";
import { mutateStore } from "@/lib/persistence/store";
import { requireRegisterPermission } from "@/lib/authz";
import type { TimeClockEventType, TimesheetSummary } from "@/lib/domain/types";

const isPg = () => !!process.env.USE_POSTGRES;

// R13-M-6 + R14-H-1: clock events respect a state machine:
//   clocked_out  --clock_in-->   clocked_in
//   clocked_in   --break_start-> on_break | --clock_out-> clocked_out
//   on_break     --break_end->   clocked_in
//
// The "current state" comes from the MOST RECENT clock event within the
// last 24 hours (rolling window), not a UTC-day partition. The UTC-day
// bug (R14-H-1): a California employee who clocks in at 3pm PT (23:00 UTC)
// and clocks out at 9pm PT (05:00 UTC next day) would otherwise see "no
// entries today" when clocking out, state=clocked_out, and the clock_out
// gets rejected.
//
// We also treat a clock_in older than STALE_CLOCK_IN_HOURS as equivalent
// to clocked_out (forgotten clock-out from yesterday). Without this, the
// employee shows up for their next shift and can't clock in — state is
// still clocked_in with nothing to break_start or clock_out from (their
// yesterday's shift has no real end time). A synthetic clock_out would
// be ideal but that's a schema change; for now, just release the lock so
// they can start a new shift, and rely on admin review of orphan shifts.
const LOOKBACK_HOURS = 24;
const STALE_CLOCK_IN_HOURS = 16;

const ALLOWED_TRANSITIONS: Record<string, TimeClockEventType[]> = {
  // from → allowed next eventType
  clocked_out: ["clock_in"],
  clocked_in: ["break_start", "clock_out"],
  on_break: ["break_end"],
};

function stateAfter(last: { eventType: TimeClockEventType; createdAt: string } | null): keyof typeof ALLOWED_TRANSITIONS {
  if (!last) return "clocked_out";
  // Stale clock_in escape hatch: treat as clocked_out so the employee
  // can open a new shift.
  if (last.eventType === "clock_in") {
    const ageMs = Date.now() - new Date(last.createdAt).getTime();
    if (ageMs > STALE_CLOCK_IN_HOURS * 3600_000) return "clocked_out";
    return "clocked_in";
  }
  if (last.eventType === "break_end") return "clocked_in";
  if (last.eventType === "break_start") return "on_break";
  return "clocked_out"; // clock_out
}

export async function clockAction(
  _employeeId: string,
  _locationId: string,
  _organizationId: string,
  eventType: TimeClockEventType,
  note?: string,
): Promise<{ success: true; eventType: TimeClockEventType }> {
  const authCtx = await requireRegisterPermission("register.open");
  const employeeId = authCtx.employee.id;
  const locationId = authCtx.location.id;
  const organizationId = authCtx.employee.organizationId;

  // Load the last 24h of entries (rolling window, not UTC-day).
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
  let lastEvent: { eventType: TimeClockEventType; createdAt: string } | null = null;
  if (isPg()) {
    const { pgReadEmployeeTimeClockEntriesSince } = await import("@/lib/persistence/postgres-phase3");
    const entries = await pgReadEmployeeTimeClockEntriesSince(organizationId, employeeId, sinceIso);
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      lastEvent = { eventType: last.eventType, createdAt: last.createdAt };
    }
  } else {
    const { readStore } = await import("@/lib/persistence/store");
    const store = await readStore();
    const recent = store.timeClockEntries
      .filter((e) => e.employeeId === employeeId && e.createdAt >= sinceIso)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (recent.length > 0) {
      const last = recent[recent.length - 1];
      lastEvent = { eventType: last.eventType, createdAt: last.createdAt };
    }
  }

  const currentState = stateAfter(lastEvent);
  const allowed = ALLOWED_TRANSITIONS[currentState] ?? [];
  if (!allowed.includes(eventType)) {
    throw new Error(
      `Cannot ${eventType.replace("_", " ")} from ${currentState.replace("_", " ")}`,
    );
  }

  if (isPg()) {
    const { pgInsertTimeClockEntry } = await import("@/lib/persistence/postgres-phase3");
    await pgInsertTimeClockEntry({ employeeId, locationId, organizationId, eventType, note });
  } else {
    await mutateStore((store) => {
      store.timeClockEntries.unshift({
        id: randomUUID(),
        organizationId,
        employeeId,
        locationId,
        eventType,
        note,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  revalidatePath("/register");
  return { success: true, eventType };
}

/** Build timesheet summaries for a given date (default: today). */
export async function getTimesheetSummaries(
  locationId: string,
  date?: string,
): Promise<TimesheetSummary[]> {
  // Require register session and verify caller can access this location's timesheets
  const ctx = await requireRegisterPermission("register.open");
  if (ctx.location.id !== locationId) {
    throw new Error("Cannot access timesheets for another location");
  }
  if (isPg()) {
    const { pgGetTimesheetSummaries } = await import("@/lib/persistence/postgres-phase3");
    return pgGetTimesheetSummaries(ctx.employee.organizationId, locationId, date);
  }

  const { readStore } = await import("@/lib/persistence/store");
  const store = await readStore();
  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  // Get all clock entries for the date + location
  const dayEntries = store.timeClockEntries.filter(
    (e) => e.locationId === locationId && e.createdAt.startsWith(targetDate),
  );

  // Group by employee
  const byEmployee = new Map<string, typeof dayEntries>();
  for (const entry of dayEntries) {
    const existing = byEmployee.get(entry.employeeId) ?? [];
    existing.push(entry);
    byEmployee.set(entry.employeeId, existing);
  }

  const summaries: TimesheetSummary[] = [];

  for (const [empId, entries] of byEmployee) {
    const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const emp = store.employees.find((e) => e.id === empId);
    const empName = emp?.displayName ?? empId.slice(0, 8);

    const clockIn = sorted.find((e) => e.eventType === "clock_in");
    const clockOut = sorted.findLast((e) => e.eventType === "clock_out");

    // Build break pairs
    const breaks: { start: string; end?: string }[] = [];
    let currentBreak: { start: string; end?: string } | null = null;
    for (const entry of sorted) {
      if (entry.eventType === "break_start") {
        currentBreak = { start: entry.createdAt };
      } else if (entry.eventType === "break_end" && currentBreak) {
        currentBreak.end = entry.createdAt;
        breaks.push(currentBreak);
        currentBreak = null;
      }
    }
    if (currentBreak) breaks.push(currentBreak); // unclosed break

    // Compute total break time
    const totalBreakMs = breaks.reduce((sum, b) => {
      if (!b.end) return sum;
      return sum + (new Date(b.end).getTime() - new Date(b.start).getTime());
    }, 0);

    // Compute total worked time
    const clockInTime = clockIn ? new Date(clockIn.createdAt).getTime() : 0;
    const clockOutTime = clockOut ? new Date(clockOut.createdAt).getTime() : Date.now();
    const totalWorkedMs = clockInTime > 0 ? Math.max(0, clockOutTime - clockInTime - totalBreakMs) : 0;

    // Determine current status
    const lastEvent = sorted[sorted.length - 1];
    let status: "clocked_in" | "on_break" | "clocked_out" = "clocked_out";
    if (lastEvent) {
      if (lastEvent.eventType === "clock_in" || lastEvent.eventType === "break_end") status = "clocked_in";
      else if (lastEvent.eventType === "break_start") status = "on_break";
      else if (lastEvent.eventType === "clock_out") status = "clocked_out";
    }

    summaries.push({
      employeeId: empId,
      employeeName: empName,
      date: targetDate,
      clockIn: clockIn?.createdAt,
      clockOut: clockOut?.createdAt,
      breaks,
      totalWorkedMs,
      totalBreakMs,
      status,
    });
  }

  return summaries;
}
