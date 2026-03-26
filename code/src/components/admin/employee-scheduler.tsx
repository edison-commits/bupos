'use client';

import { useState, useMemo } from 'react';

interface Employee {
  id: string;
  displayName: string;
  roleKey: string;
  isActive: boolean;
}

interface Shift {
  id: string;
  employeeId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  notes: string;
  published: boolean;
}

interface EmployeeSchedulerProps {
  employees: Employee[];
}

const COLORS = [
  { bg: 'bg-teal-100', text: 'text-teal-800', border: 'border-teal-300' },
  { bg: 'bg-violet-100', text: 'text-violet-800', border: 'border-violet-300' },
  { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-300' },
  { bg: 'bg-rose-100', text: 'text-rose-800', border: 'border-rose-300' },
  { bg: 'bg-sky-100', text: 'text-sky-800', border: 'border-sky-300' },
  { bg: 'bg-lime-100', text: 'text-lime-800', border: 'border-lime-300' },
  { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-300' },
  { bg: 'bg-indigo-100', text: 'text-indigo-800', border: 'border-indigo-300' },
];

function getWeekDates(baseDate: Date): Date[] {
  const start = new Date(baseDate);
  const day = start.getDay();
  start.setDate(start.getDate() - day); // Sunday
  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function formatDateKey(d: Date): string {
  return d.toISOString().split('T')[0];
}

function formatDayHeader(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTimeDisplay(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function getShiftHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60; // overnight
  return diff / 60;
}

function getEmployeeColor(index: number) {
  return COLORS[index % COLORS.length];
}

type ViewMode = 'week' | 'day';

export function EmployeeScheduler({ employees }: EmployeeSchedulerProps) {
  const activeEmployees = employees.filter((e) => e.isActive);

  const [weekBase, setWeekBase] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingShift, setEditingShift] = useState<Shift | null>(null);

  // New shift form
  const [formEmployee, setFormEmployee] = useState(activeEmployees[0]?.id || '');
  const [formDate, setFormDate] = useState('');
  const [formStart, setFormStart] = useState('09:00');
  const [formEnd, setFormEnd] = useState('17:00');
  const [formNotes, setFormNotes] = useState('');

  const weekDates = useMemo(() => getWeekDates(weekBase), [weekBase]);

  const shiftsByDateEmployee = useMemo(() => {
    const map = new Map<string, Shift[]>();
    shifts.forEach((s) => {
      const key = `${s.date}|${s.employeeId}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    });
    return map;
  }, [shifts]);

  // Weekly hours per employee
  const weeklyHours = useMemo(() => {
    const hours: Record<string, number> = {};
    const weekStart = formatDateKey(weekDates[0]);
    const weekEnd = formatDateKey(weekDates[6]);
    shifts.forEach((s) => {
      if (s.date >= weekStart && s.date <= weekEnd) {
        hours[s.employeeId] = (hours[s.employeeId] || 0) + getShiftHours(s.startTime, s.endTime);
      }
    });
    return hours;
  }, [shifts, weekDates]);

  // Stats
  const totalScheduledHours = Object.values(weeklyHours).reduce((a, b) => a + b, 0);
  const employeesScheduled = new Set(shifts.filter((s) => {
    const weekStart = formatDateKey(weekDates[0]);
    const weekEnd = formatDateKey(weekDates[6]);
    return s.date >= weekStart && s.date <= weekEnd;
  }).map((s) => s.employeeId)).size;

  const handlePrevWeek = () => {
    const d = new Date(weekBase);
    d.setDate(d.getDate() - 7);
    setWeekBase(d);
  };

  const handleNextWeek = () => {
    const d = new Date(weekBase);
    d.setDate(d.getDate() + 7);
    setWeekBase(d);
  };

  const handleThisWeek = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setWeekBase(d);
  };

  const openAddForm = (dateKey?: string, employeeId?: string) => {
    setEditingShift(null);
    setFormDate(dateKey || formatDateKey(weekDates[0]));
    setFormEmployee(employeeId || activeEmployees[0]?.id || '');
    setFormStart('09:00');
    setFormEnd('17:00');
    setFormNotes('');
    setShowAddForm(true);
  };

  const openEditForm = (shift: Shift) => {
    setEditingShift(shift);
    setFormDate(shift.date);
    setFormEmployee(shift.employeeId);
    setFormStart(shift.startTime);
    setFormEnd(shift.endTime);
    setFormNotes(shift.notes);
    setShowAddForm(true);
  };

  const handleSaveShift = () => {
    if (!formEmployee || !formDate) return;

    if (editingShift) {
      setShifts((prev) =>
        prev.map((s) =>
          s.id === editingShift.id
            ? { ...s, employeeId: formEmployee, date: formDate, startTime: formStart, endTime: formEnd, notes: formNotes }
            : s
        )
      );
    } else {
      const newShift: Shift = {
        id: `shift-${Date.now()}`,
        employeeId: formEmployee,
        date: formDate,
        startTime: formStart,
        endTime: formEnd,
        notes: formNotes,
        published: false,
      };
      setShifts((prev) => [...prev, newShift]);
    }

    setShowAddForm(false);
    setEditingShift(null);
  };

  const handleDeleteShift = (shiftId: string) => {
    setShifts((prev) => prev.filter((s) => s.id !== shiftId));
    if (editingShift?.id === shiftId) {
      setShowAddForm(false);
      setEditingShift(null);
    }
  };

  const handleCopyWeek = () => {
    const weekStart = formatDateKey(weekDates[0]);
    const weekEnd = formatDateKey(weekDates[6]);
    const weekShifts = shifts.filter((s) => s.date >= weekStart && s.date <= weekEnd);

    const copied = weekShifts.map((s) => {
      const d = new Date(s.date);
      d.setDate(d.getDate() + 7);
      return {
        ...s,
        id: `shift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: formatDateKey(d),
        published: false,
      };
    });

    setShifts((prev) => [...prev, ...copied]);
    handleNextWeek();
  };

  const handlePublishWeek = () => {
    const weekStart = formatDateKey(weekDates[0]);
    const weekEnd = formatDateKey(weekDates[6]);
    setShifts((prev) =>
      prev.map((s) => (s.date >= weekStart && s.date <= weekEnd ? { ...s, published: true } : s))
    );
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = formatDateKey(today);

  const employeeColorMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getEmployeeColor>>();
    activeEmployees.forEach((emp, idx) => {
      map.set(emp.id, getEmployeeColor(idx));
    });
    return map;
  }, [activeEmployees]);

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <button onClick={handlePrevWeek} className="touch-button px-3 py-2 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium text-sm">←</button>
          <button onClick={handleThisWeek} className="touch-button px-3 py-2 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium text-sm">This Week</button>
          <button onClick={handleNextWeek} className="touch-button px-3 py-2 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium text-sm">→</button>
          <span className="ml-2 text-sm font-semibold text-zinc-700">
            {weekDates[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {weekDates[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode(viewMode === 'week' ? 'day' : 'week')}
            className="touch-button px-3 py-2 rounded-lg border border-zinc-200 bg-white text-zinc-700 font-medium text-sm hover:bg-zinc-50"
          >
            {viewMode === 'week' ? 'Day View' : 'Week View'}
          </button>
          <button
            onClick={handleCopyWeek}
            className="touch-button px-3 py-2 rounded-lg border border-zinc-200 bg-white text-zinc-700 font-medium text-sm hover:bg-zinc-50"
          >
            Copy to Next Week
          </button>
          <button
            onClick={handlePublishWeek}
            className="touch-button px-3 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-medium text-sm"
          >
            Publish Week
          </button>
          <button
            onClick={() => openAddForm()}
            className="touch-button px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white font-medium text-sm"
          >
            + Add Shift
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl bg-white border border-zinc-200 p-3">
          <p className="text-xs text-zinc-500">Employees Scheduled</p>
          <p className="text-xl font-bold text-zinc-900">{employeesScheduled} / {activeEmployees.length}</p>
        </div>
        <div className="rounded-xl bg-white border border-zinc-200 p-3">
          <p className="text-xs text-zinc-500">Total Hours This Week</p>
          <p className="text-xl font-bold text-zinc-900">{totalScheduledHours.toFixed(1)}h</p>
        </div>
        <div className="rounded-xl bg-white border border-zinc-200 p-3">
          <p className="text-xs text-zinc-500">Avg Hours / Employee</p>
          <p className="text-xl font-bold text-zinc-900">
            {employeesScheduled > 0 ? (totalScheduledHours / employeesScheduled).toFixed(1) : '0'}h
          </p>
        </div>
      </div>

      {/* Add/Edit Shift Form */}
      {showAddForm && (
        <div className="rounded-xl bg-white border border-zinc-200 p-4">
          <h3 className="font-bold text-zinc-900 mb-3">{editingShift ? 'Edit Shift' : 'Add Shift'}</h3>
          <form
            onSubmit={(e) => { e.preventDefault(); handleSaveShift(); }}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
          >
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Employee</label>
              <select
                value={formEmployee}
                onChange={(e) => setFormEmployee(e.target.value)}
                className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm text-zinc-800"
              >
                {activeEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.displayName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Date</label>
              <input
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm text-zinc-800"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Start Time</label>
              <input
                type="time"
                value={formStart}
                onChange={(e) => setFormStart(e.target.value)}
                className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm text-zinc-800"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">End Time</label>
              <input
                type="time"
                value={formEnd}
                onChange={(e) => setFormEnd(e.target.value)}
                className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm text-zinc-800"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Notes</label>
              <input
                type="text"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="e.g. Opening"
                className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm text-zinc-800"
              />
            </div>
            <div className="flex items-end gap-2">
              <button type="submit" className="touch-button flex-1 px-3 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-medium text-sm">
                {editingShift ? 'Update' : 'Add'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAddForm(false); setEditingShift(null); }}
                className="touch-button px-3 py-2 rounded-lg bg-zinc-200 hover:bg-zinc-300 text-zinc-700 font-medium text-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Weekly Schedule Grid */}
      {viewMode === 'week' && (
        <div className="rounded-xl bg-white border border-zinc-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="text-left px-3 py-3 text-sm font-semibold text-zinc-700 w-40 border-r border-zinc-200">Employee</th>
                  {weekDates.map((d) => {
                    const dk = formatDateKey(d);
                    const isToday = dk === todayKey;
                    return (
                      <th
                        key={dk}
                        className={`text-center px-2 py-3 text-xs font-semibold border-r border-zinc-200 last:border-r-0 ${isToday ? 'bg-teal-50 text-teal-700' : 'text-zinc-600'}`}
                      >
                        {formatDayHeader(d)}
                      </th>
                    );
                  })}
                  <th className="text-center px-3 py-3 text-xs font-semibold text-zinc-600 w-20">Hours</th>
                </tr>
              </thead>
              <tbody>
                {activeEmployees.map((emp, empIdx) => {
                  const color = employeeColorMap.get(emp.id)!;
                  const hours = weeklyHours[emp.id] || 0;
                  const isOvertime = hours > 40;

                  return (
                    <tr key={emp.id} className="border-t border-zinc-100 hover:bg-zinc-50/50">
                      <td className="px-3 py-2 border-r border-zinc-200">
                        <div className="flex items-center gap-2">
                          <div className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${color.bg} ${color.text}`}>
                            {emp.displayName.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-zinc-900 truncate max-w-[100px]">{emp.displayName}</p>
                            <p className="text-xs text-zinc-500">{emp.roleKey}</p>
                          </div>
                        </div>
                      </td>
                      {weekDates.map((d) => {
                        const dk = formatDateKey(d);
                        const isToday = dk === todayKey;
                        const dayShifts = shiftsByDateEmployee.get(`${dk}|${emp.id}`) || [];

                        return (
                          <td
                            key={dk}
                            className={`px-1 py-1 border-r border-zinc-200 last:border-r-0 align-top cursor-pointer ${isToday ? 'bg-teal-50/30' : ''}`}
                            onClick={() => {
                              if (dayShifts.length === 0) openAddForm(dk, emp.id);
                            }}
                          >
                            {dayShifts.length > 0 ? (
                              <div className="space-y-1">
                                {dayShifts.map((s) => (
                                  <div
                                    key={s.id}
                                    onClick={(e) => { e.stopPropagation(); openEditForm(s); }}
                                    className={`rounded-lg px-2 py-1.5 text-xs cursor-pointer hover:opacity-80 border ${color.bg} ${color.text} ${color.border} ${!s.published ? 'border-dashed' : ''}`}
                                  >
                                    <div className="font-semibold">
                                      {formatTimeDisplay(s.startTime)} – {formatTimeDisplay(s.endTime)}
                                    </div>
                                    <div className="text-[10px] opacity-70">
                                      {getShiftHours(s.startTime, s.endTime).toFixed(1)}h
                                      {s.notes && ` · ${s.notes}`}
                                    </div>
                                    {!s.published && (
                                      <div className="text-[10px] font-medium opacity-50 mt-0.5">Draft</div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="h-10 flex items-center justify-center text-zinc-300 text-xs hover:text-zinc-400">
                                +
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-center">
                        <span className={`text-sm font-bold ${isOvertime ? 'text-red-600' : 'text-zinc-900'}`}>
                          {hours.toFixed(1)}h
                        </span>
                        {isOvertime && <p className="text-[10px] text-red-500 font-medium">OT</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Day View */}
      {viewMode === 'day' && (
        <div className="space-y-4">
          {/* Day selector */}
          <div className="flex gap-1 overflow-x-auto pb-1">
            {weekDates.map((d) => {
              const dk = formatDateKey(d);
              const isToday = dk === todayKey;
              const isSelected = selectedDay === dk || (!selectedDay && isToday);
              return (
                <button
                  key={dk}
                  onClick={() => setSelectedDay(dk)}
                  className={`touch-button flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isSelected
                      ? 'bg-teal-700 text-white'
                      : isToday
                        ? 'bg-teal-50 text-teal-700 border border-teal-200'
                        : 'bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50'
                  }`}
                >
                  {formatDayHeader(d)}
                </button>
              );
            })}
          </div>

          {/* Day shifts */}
          <div className="rounded-xl bg-white border border-zinc-200 p-4">
            {(() => {
              const dayKey = selectedDay || todayKey;
              const dayShifts = shifts.filter((s) => s.date === dayKey).sort((a, b) => a.startTime.localeCompare(b.startTime));

              if (dayShifts.length === 0) {
                return (
                  <div className="text-center py-8">
                    <p className="text-zinc-400 mb-3">No shifts scheduled</p>
                    <button
                      onClick={() => openAddForm(dayKey)}
                      className="touch-button px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-medium text-sm"
                    >
                      + Add Shift
                    </button>
                  </div>
                );
              }

              return (
                <div className="space-y-2">
                  {dayShifts.map((s) => {
                    const emp = activeEmployees.find((e) => e.id === s.employeeId);
                    const color = employeeColorMap.get(s.employeeId) || COLORS[0];
                    const hours = getShiftHours(s.startTime, s.endTime);

                    return (
                      <div
                        key={s.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border ${color.bg} ${color.border} ${!s.published ? 'border-dashed' : ''}`}
                      >
                        <div className={`h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold ${color.bg} ${color.text}`}>
                          {emp?.displayName.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '??'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`font-semibold ${color.text}`}>
                            {emp?.displayName || 'Unknown'}
                            {!s.published && <span className="ml-2 text-xs opacity-50 font-normal">Draft</span>}
                          </p>
                          <p className="text-sm opacity-70">
                            {formatTimeDisplay(s.startTime)} – {formatTimeDisplay(s.endTime)} ({hours.toFixed(1)}h)
                            {s.notes && ` · ${s.notes}`}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => openEditForm(s)}
                            className="touch-button px-2 py-1 rounded bg-white/60 hover:bg-white text-xs font-medium text-zinc-700"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteShift(s.id)}
                            className="touch-button px-2 py-1 rounded bg-white/60 hover:bg-red-100 text-xs font-medium text-red-600"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Employee Hours Summary */}
      <div className="rounded-xl bg-white border border-zinc-200 p-4">
        <h3 className="font-bold text-zinc-900 mb-3">Weekly Hours Summary</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {activeEmployees.map((emp) => {
            const hours = weeklyHours[emp.id] || 0;
            const color = employeeColorMap.get(emp.id)!;
            const isOvertime = hours > 40;
            const barWidth = Math.min((hours / 40) * 100, 100);

            return (
              <div key={emp.id} className="flex items-center gap-2 p-2 rounded-lg border border-zinc-100">
                <div className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold ${color.bg} ${color.text}`}>
                  {emp.displayName.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-zinc-800 truncate">{emp.displayName}</p>
                  <div className="h-1.5 w-full rounded-full bg-zinc-100 mt-0.5">
                    <div
                      className={`h-full rounded-full transition-all ${isOvertime ? 'bg-red-500' : 'bg-teal-500'}`}
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </div>
                <span className={`text-xs font-bold ${isOvertime ? 'text-red-600' : 'text-zinc-700'}`}>
                  {hours.toFixed(1)}h
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
