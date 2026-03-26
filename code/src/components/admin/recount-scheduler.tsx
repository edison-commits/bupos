"use client";

import { useState } from "react";
import type { RecountSchedule, Category, Location, RecountFrequency } from "@/lib/domain/types";

interface RecountSchedulerProps {
  schedules: RecountSchedule[];
  categories: Category[];
  locations: Location[];
  onCreateSchedule?: (
    schedule: Omit<RecountSchedule, "id" | "createdAt" | "updatedAt">
  ) => void;
  onToggleSchedule?: (scheduleId: string, active: boolean) => void;
  onDeleteSchedule?: (scheduleId: string) => void;
}

const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const FREQUENCIES: RecountFrequency[] = ["weekly", "biweekly", "monthly"];

function getNextRunDate(
  dayOfWeek: number,
  frequency: RecountFrequency,
  baseDate: Date = new Date()
): Date {
  const date = new Date(baseDate);
  date.setHours(0, 0, 0, 0);

  // Find next occurrence of the target day of week
  const currentDay = date.getDay();
  let daysUntilTarget = (dayOfWeek - currentDay + 7) % 7;

  // If today is the target day and it's in the future time-wise, use today
  if (daysUntilTarget === 0 && date.getTime() < baseDate.getTime()) {
    daysUntilTarget = 7;
  } else if (daysUntilTarget === 0) {
    daysUntilTarget = 0;
  } else if (daysUntilTarget < 0) {
    daysUntilTarget += 7;
  }

  date.setDate(date.getDate() + daysUntilTarget);

  // Apply frequency offset
  if (frequency === "biweekly") {
    date.setDate(date.getDate() + 7);
  } else if (frequency === "monthly") {
    date.setMonth(date.getMonth() + 1);
  }

  return date;
}

function generateUpcomingCounts(
  schedules: RecountSchedule[],
  categories: Map<string, Category>
): Array<{ date: Date; category: string; scheduleId: string }> {
  const upcoming: Array<{ date: Date; category: string; scheduleId: string }> =
    [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  schedules.forEach((schedule) => {
    if (!schedule.isActive) return;

    let current = new Date(today);
    for (let i = 0; i < 4; i++) {
      const next = getNextRunDate(schedule.dayOfWeek, schedule.frequency, current);
      const categoryName = schedule.categoryId
        ? categories.get(schedule.categoryId)?.name || "Unknown"
        : "All products";
      upcoming.push({
        date: next,
        category: categoryName,
        scheduleId: schedule.id,
      });
      current = new Date(next);
      current.setDate(current.getDate() + 1);
    }
  });

  return upcoming
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 4);
}

export function RecountScheduler({
  schedules,
  categories,
  locations,
  onCreateSchedule,
  onToggleSchedule,
  onDeleteSchedule,
}: RecountSchedulerProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    locationId: locations[0]?.id || "",
    categoryId: "",
    frequency: "weekly" as RecountFrequency,
    dayOfWeek: 1, // Monday
    isActive: true,
  });

  const categoriesMap = new Map(categories.map((c) => [c.id, c]));
  const locationsMap = new Map(locations.map((l) => [l.id, l]));

  const handleCreateSchedule = (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.locationId) {
      alert("Please select a location");
      return;
    }

    const nextRunAt = getNextRunDate(
      formData.dayOfWeek,
      formData.frequency
    ).toISOString();

    onCreateSchedule?.({
      organizationId: "", // This would be provided by parent
      locationId: formData.locationId,
      categoryId: formData.categoryId || undefined,
      frequency: formData.frequency,
      dayOfWeek: formData.dayOfWeek,
      nextRunAt,
      isActive: formData.isActive,
    });

    setFormData({
      locationId: locations[0]?.id || "",
      categoryId: "",
      frequency: "weekly",
      dayOfWeek: 1,
      isActive: true,
    });
    setShowCreateForm(false);
  };

  const upcomingCounts = generateUpcomingCounts(schedules, categoriesMap);

  const activeCount = schedules.filter((s) => s.isActive).length;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Total schedules</p>
          <p className="mt-1 text-2xl font-semibold">{schedules.length}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Active</p>
          <p className="mt-1 text-2xl font-semibold">{activeCount}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs text-zinc-500">Paused</p>
          <p className="mt-1 text-2xl font-semibold">
            {schedules.length - activeCount}
          </p>
        </div>
      </div>

      {/* Create Button */}
      <button
        onClick={() => setShowCreateForm(!showCreateForm)}
        className="rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 transition-colors"
      >
        {showCreateForm ? "Cancel" : "Create schedule"}
      </button>

      {/* Create Schedule Form */}
      {showCreateForm && (
        <form
          onSubmit={handleCreateSchedule}
          className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-4"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium">
              <span>Location *</span>
              <select
                value={formData.locationId}
                onChange={(e) =>
                  setFormData({ ...formData, locationId: e.target.value })
                }
                className="touch-button rounded-xl border border-zinc-300 px-3 py-2 text-sm"
                required
              >
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2 text-sm font-medium">
              <span>Category (optional)</span>
              <select
                value={formData.categoryId}
                onChange={(e) =>
                  setFormData({ ...formData, categoryId: e.target.value })
                }
                className="touch-button rounded-xl border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">All products</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2 text-sm font-medium">
              <span>Frequency *</span>
              <select
                value={formData.frequency}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    frequency: e.target.value as RecountFrequency,
                  })
                }
                className="touch-button rounded-xl border border-zinc-300 px-3 py-2 text-sm"
                required
              >
                {FREQUENCIES.map((freq) => (
                  <option key={freq} value={freq}>
                    {freq.charAt(0).toUpperCase() + freq.slice(1)}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2 text-sm font-medium">
              <span>Day of week *</span>
              <select
                value={formData.dayOfWeek}
                onChange={(e) =>
                  setFormData({ ...formData, dayOfWeek: parseInt(e.target.value) })
                }
                className="touch-button rounded-xl border border-zinc-300 px-3 py-2 text-sm"
                required
              >
                {DAYS_OF_WEEK.map((day, idx) => (
                  <option key={idx} value={idx}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={formData.isActive}
              onChange={(e) =>
                setFormData({ ...formData, isActive: e.target.checked })
              }
              className="rounded border-zinc-300"
            />
            <span className="text-sm font-medium">Active</span>
          </label>

          <button
            type="submit"
            className="w-full rounded-2xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 transition-colors"
          >
            Create schedule
          </button>
        </form>
      )}

      {/* Schedules List */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-900">Schedules</h3>
        {schedules.length === 0 ? (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-6 text-center">
            <p className="text-sm text-zinc-500">No schedules created yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {schedules.map((schedule) => {
              const location = locationsMap.get(schedule.locationId);
              const category = schedule.categoryId
                ? categoriesMap.get(schedule.categoryId)
                : null;

              const nextRun = new Date(schedule.nextRunAt);
              const formattedDate = nextRun.toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              });

              return (
                <div
                  key={schedule.id}
                  className="rounded-2xl border border-zinc-200 bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <p className="font-medium text-zinc-900 truncate">
                          {category?.name || "All products"}
                        </p>
                        <span
                          className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                            schedule.isActive
                              ? "bg-teal-100 text-teal-700"
                              : "bg-zinc-100 text-zinc-600"
                          }`}
                        >
                          {schedule.isActive ? "Active" : "Paused"}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-600">
                        {location?.name} • {schedule.frequency} •{" "}
                        {DAYS_OF_WEEK[schedule.dayOfWeek]}
                      </p>
                      <p className="text-xs text-zinc-500 mt-1">
                        Next run: {formattedDate}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          onToggleSchedule?.(schedule.id, !schedule.isActive)
                        }
                        className="touch-button rounded-xl border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
                      >
                        {schedule.isActive ? "Pause" : "Resume"}
                      </button>
                      <button
                        onClick={() => onDeleteSchedule?.(schedule.id)}
                        className="touch-button rounded-xl border border-red-300 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Upcoming Counts Calendar Preview */}
      {upcomingCounts.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h3 className="mb-4 text-sm font-semibold text-zinc-900">
            Next 4 scheduled counts
          </h3>
          <div className="space-y-2">
            {upcomingCounts.map((count, idx) => {
              const formatted = count.date.toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
              });

              return (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-teal-100">
                      <span className="text-xs font-semibold text-teal-700">
                        {count.date.getDate()}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-900">
                        {formatted}
                      </p>
                      <p className="text-xs text-zinc-600">{count.category}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
