"use client";

import { useState, useCallback } from "react";
import { clockAction } from "@/app/register/time-clock-action";
import type { TimeClockEntry, TimeClockEventType } from "@/lib/domain/types";

interface TimeClockWidgetProps {
  employeeId: string;
  employeeName: string;
  locationId: string;
  organizationId: string;
  todayEntries: TimeClockEntry[];
}

export function TimeClockWidget({
  employeeId,
  employeeName,
  locationId,
  organizationId,
  todayEntries,
}: TimeClockWidgetProps) {
  const [processing, setProcessing] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  // Derive current status from today's entries for this employee
  const myEntries = todayEntries
    .filter((e) => e.employeeId === employeeId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lastEvent = myEntries[myEntries.length - 1];

  let status: "not_clocked_in" | "clocked_in" | "on_break" | "clocked_out" = "not_clocked_in";
  if (lastEvent) {
    if (lastEvent.eventType === "clock_in" || lastEvent.eventType === "break_end") status = "clocked_in";
    else if (lastEvent.eventType === "break_start") status = "on_break";
    else if (lastEvent.eventType === "clock_out") status = "clocked_out";
  }

  // Compute worked time
  const clockInEntry = myEntries.find((e) => e.eventType === "clock_in");
  const clockOutEntry = myEntries.findLast((e) => e.eventType === "clock_out");
  const breakPairs: { start: string; end?: string }[] = [];
  let currentBreak: { start: string; end?: string } | null = null;
  for (const entry of myEntries) {
    if (entry.eventType === "break_start") {
      currentBreak = { start: entry.createdAt };
    } else if (entry.eventType === "break_end" && currentBreak) {
      currentBreak.end = entry.createdAt;
      breakPairs.push(currentBreak);
      currentBreak = null;
    }
  }
  if (currentBreak) breakPairs.push(currentBreak);

  const totalBreakMs = breakPairs.reduce((sum, b) => {
    if (!b.end) return sum;
    return sum + (new Date(b.end).getTime() - new Date(b.start).getTime());
  }, 0);

  const clockInTime = clockInEntry ? new Date(clockInEntry.createdAt).getTime() : 0;
  const endTime = clockOutEntry ? new Date(clockOutEntry.createdAt).getTime() : Date.now();
  const totalWorkedMs = clockInTime > 0 && status !== "not_clocked_in" ? Math.max(0, endTime - clockInTime - totalBreakMs) : 0;

  const formatDuration = (ms: number) => {
    const hours = Math.floor(ms / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    return `${hours}h ${mins}m`;
  };

  const handleClock = useCallback(async (eventType: TimeClockEventType) => {
    setProcessing(true);
    try {
      await clockAction(employeeId, locationId, organizationId, eventType);
      setLastAction(eventType === "clock_in" ? "Clocked in" : eventType === "clock_out" ? "Clocked out" : eventType === "break_start" ? "Break started" : "Break ended");
      setTimeout(() => setLastAction(null), 3000);
    } catch {
      setLastAction("Action failed");
    } finally {
      setProcessing(false);
    }
  }, [employeeId, locationId, organizationId]);

  const statusColors = {
    not_clocked_in: "bg-zinc-100 text-zinc-600",
    clocked_in: "bg-emerald-100 text-emerald-700",
    on_break: "bg-amber-100 text-amber-700",
    clocked_out: "bg-zinc-100 text-zinc-600",
  };

  const statusLabels = {
    not_clocked_in: "Not clocked in",
    clocked_in: "Clocked in",
    on_break: "On break",
    clocked_out: "Clocked out",
  };

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Time clock</p>
          <p className="text-sm font-semibold">{employeeName}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusColors[status]}`}>
          {statusLabels[status]}
        </span>
      </div>

      {/* Time summary */}
      {clockInTime > 0 && (
        <div className="mt-3 flex gap-4 text-xs text-zinc-500">
          <span>In: {new Date(clockInEntry!.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          {clockOutEntry && <span>Out: {new Date(clockOutEntry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
          <span>Worked: {formatDuration(totalWorkedMs)}</span>
          {totalBreakMs > 0 && <span>Break: {formatDuration(totalBreakMs)}</span>}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-3 flex gap-2">
        {(status === "not_clocked_in" || status === "clocked_out") && (
          <button
            type="button"
            disabled={processing}
            onClick={() => handleClock("clock_in")}
            className="touch-button flex-1 rounded-xl bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Clock in
          </button>
        )}
        {status === "clocked_in" && (
          <>
            <button
              type="button"
              disabled={processing}
              onClick={() => handleClock("break_start")}
              className="touch-button flex-1 rounded-xl bg-amber-500 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              Start break
            </button>
            <button
              type="button"
              disabled={processing}
              onClick={() => handleClock("clock_out")}
              className="touch-button flex-1 rounded-xl bg-zinc-700 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Clock out
            </button>
          </>
        )}
        {status === "on_break" && (
          <button
            type="button"
            disabled={processing}
            onClick={() => handleClock("break_end")}
            className="touch-button flex-1 rounded-xl bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            End break
          </button>
        )}
      </div>

      {/* Last action toast */}
      {lastAction && (
        <p className="mt-2 text-center text-xs font-medium text-teal-600">{lastAction}</p>
      )}
    </div>
  );
}
