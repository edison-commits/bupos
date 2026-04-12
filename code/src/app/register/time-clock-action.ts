"use server";

import { revalidatePath } from "next/cache";
import { mutateStore } from "@/lib/persistence/store";
import { requireRegisterPermission } from "@/lib/authz";
import type { TimeClockEventType, TimesheetSummary } from "@/lib/domain/types";

const isPg = () => !!process.env.USE_POSTGRES;

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

  if (isPg()) {
    const { pgInsertTimeClockEntry } = await import("@/lib/persistence/postgres-phase3");
    await pgInsertTimeClockEntry({ employeeId, locationId, organizationId, eventType, note });
  } else {
    await mutateStore((store) => {
      store.timeClockEntries.unshift({
        id: crypto.randomUUID(),
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
  if (isPg()) {
    const { pgGetTimesheetSummaries } = await import("@/lib/persistence/postgres-phase3");
    return pgGetTimesheetSummaries(locationId, date);
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
