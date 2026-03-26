"use client";

import { useMemo } from "react";
import type { Employee, TimeClockEntry } from "@/lib/domain/types";

interface TimesheetViewProps {
  employees: Employee[];
  timeClockEntries: TimeClockEntry[];
  locationId: string;
}

export function TimesheetView({ employees, timeClockEntries, locationId }: TimesheetViewProps) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();

  const summaries = useMemo(() => {
    const locationEntries = timeClockEntries.filter(
      (e) => e.locationId === locationId && e.createdAt.startsWith(today),
    );

    const byEmployee = new Map<string, TimeClockEntry[]>();
    for (const entry of locationEntries) {
      const existing = byEmployee.get(entry.employeeId) ?? [];
      existing.push(entry);
      byEmployee.set(entry.employeeId, existing);
    }

    return Array.from(byEmployee.entries()).map(([empId, entries]) => {
      const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const emp = employees.find((e) => e.id === empId);

      const clockIn = sorted.find((e) => e.eventType === "clock_in");
      const clockOut = sorted.findLast((e) => e.eventType === "clock_out");

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
      if (currentBreak) breaks.push(currentBreak);

      const totalBreakMs = breaks.reduce((sum, b) => {
        if (!b.end) return sum;
        return sum + (new Date(b.end).getTime() - new Date(b.start).getTime());
      }, 0);

      const clockInTime = clockIn ? new Date(clockIn.createdAt).getTime() : 0;
      const clockOutTime = clockOut ? new Date(clockOut.createdAt).getTime() : nowMs;
      const totalWorkedMs = clockInTime > 0 ? Math.max(0, clockOutTime - clockInTime - totalBreakMs) : 0;

      const lastEvent = sorted[sorted.length - 1];
      let status: "clocked_in" | "on_break" | "clocked_out" = "clocked_out";
      if (lastEvent) {
        if (lastEvent.eventType === "clock_in" || lastEvent.eventType === "break_end") status = "clocked_in";
        else if (lastEvent.eventType === "break_start") status = "on_break";
        else if (lastEvent.eventType === "clock_out") status = "clocked_out";
      }

      return {
        employeeId: empId,
        employeeName: emp?.displayName ?? empId.slice(0, 8),
        role: emp?.roleKey ?? "unknown",
        clockIn: clockIn?.createdAt,
        clockOut: clockOut?.createdAt,
        breaks,
        totalWorkedMs,
        totalBreakMs,
        status,
      };
    });
  }, [employees, timeClockEntries, locationId, today, nowMs]);

  const formatDuration = (ms: number) => {
    const hours = Math.floor(ms / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    return `${hours}h ${mins}m`;
  };

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const statusColors = {
    clocked_in: "bg-emerald-100 text-emerald-700",
    on_break: "bg-amber-100 text-amber-700",
    clocked_out: "bg-zinc-100 text-zinc-600",
  };

  if (summaries.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-zinc-400">
        No time clock activity today.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">Today — {today}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2">Employee</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Clock in</th>
              <th className="px-3 py-2">Clock out</th>
              <th className="px-3 py-2">Breaks</th>
              <th className="px-3 py-2">Worked</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => (
              <tr key={s.employeeId} className="border-b border-zinc-100">
                <td className="px-3 py-2 font-semibold">{s.employeeName}</td>
                <td className="px-3 py-2 capitalize text-zinc-500">{s.role}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusColors[s.status]}`}>
                    {s.status === "clocked_in" ? "Active" : s.status === "on_break" ? "Break" : "Out"}
                  </span>
                </td>
                <td className="px-3 py-2">{s.clockIn ? formatTime(s.clockIn) : "—"}</td>
                <td className="px-3 py-2">{s.clockOut ? formatTime(s.clockOut) : "—"}</td>
                <td className="px-3 py-2">
                  {s.breaks.length > 0 ? (
                    <span>{s.breaks.length}x · {formatDuration(s.totalBreakMs)}</span>
                  ) : (
                    <span className="text-zinc-400">None</span>
                  )}
                </td>
                <td className="px-3 py-2 font-semibold">{formatDuration(s.totalWorkedMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
