'use client';

import { useState, useMemo } from 'react';
import type { LocalStoreData } from '@/lib/persistence/types';
import { formatCurrency } from "@/lib/format";

interface PayrollEntry {
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  breakDuration: number;
  regularHours: number;
  overtimeHours: number;
}

interface EmployeePayroll {
  employeeId: string;
  firstName: string;
  lastName: string;
  role: string;
  location: string;
  entries: PayrollEntry[];
  totalRegularHours: number;
  totalOvertimeHours: number;
  totalBreakHours: number;
}

interface Anomaly {
  employeeId: string;
  employeeName: string;
  type: 'no_clock_out' | 'long_shift' | 'no_break' | 'duplicate_clock_in';
  severity: 'warning' | 'error';
  details: string;
}

const DEFAULT_HOURLY_RATES: Record<string, number> = {
  cashier: 15,
  manager: 22,
  owner: 0,
};

export function PayrollSummary({ store }: { store: LocalStoreData }) {
  const [selectedPeriod, setSelectedPeriod] = useState<'current_week' | 'previous_week' | 'current_biweekly' | 'custom'>('current_week');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [hourlyRates, setHourlyRates] = useState<Record<string, number>>({});
  const [approvedPeriods, setApprovedPeriods] = useState<Record<string, { approvedAt: string; notes: string }>>({});
  const [periodNotes, setPeriodNotes] = useState<Record<string, string>>({});

  // Calculate period dates
  const getPeriodDates = useMemo(() => {
    const today = new Date();
    let startDate: Date;
    let endDate: Date;

    switch (selectedPeriod) {
      case 'current_week': {
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1);
        startDate = new Date(today.setDate(diff));
        endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 6);
        break;
      }
      case 'previous_week': {
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1);
        const currentWeekStart = new Date(today.setDate(diff));
        endDate = new Date(currentWeekStart);
        endDate.setDate(endDate.getDate() - 1);
        startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 6);
        break;
      }
      case 'current_biweekly': {
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1);
        startDate = new Date(today.setDate(diff));
        endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 13);
        break;
      }
      case 'custom': {
        startDate = customStartDate ? new Date(customStartDate) : new Date();
        endDate = customEndDate ? new Date(customEndDate) : new Date();
        break;
      }
      default:
        startDate = new Date();
        endDate = new Date();
    }

    return { startDate, endDate };
  }, [selectedPeriod, customStartDate, customEndDate]);

  const periodKey = `${getPeriodDates.startDate.toISOString().split('T')[0]}_${getPeriodDates.endDate.toISOString().split('T')[0]}`;

  // Calculate payroll data
  const payrollData = useMemo(() => {
    const employeePayrollMap = new Map<string, EmployeePayroll>();
    const anomalies: Anomaly[] = [];

    if (!store.employees || !store.timeClockEntries) {
      return { payrollByEmployee: [], anomalies, totalRegularHours: 0, totalOvertimeHours: 0, totalGrossPay: 0 };
    }

    store.employees.forEach((emp) => {
      if (!emp.isActive) return;

      const empEntries = store.timeClockEntries.filter((e) => e.employeeId === emp.id);
      if (empEntries.length === 0) return;

      const locationName = store.locations?.find((l) => l.id === empEntries[0]?.locationId)?.name || 'Unknown';
      const dailyMap = new Map<string, { clockIn: Date | null; clockOut: Date | null; breaks: number }>();

      empEntries.forEach((entry) => {
        const entryDate = new Date(entry.createdAt);
        if (entryDate < getPeriodDates.startDate || entryDate > getPeriodDates.endDate) return;

        const dateStr = entryDate.toISOString().split('T')[0];
        if (!dailyMap.has(dateStr)) {
          dailyMap.set(dateStr, { clockIn: null, clockOut: null, breaks: 0 });
        }

        const day = dailyMap.get(dateStr)!;
        if (entry.eventType === 'clock_in') {
          if (day.clockIn !== null) {
            anomalies.push({
              employeeId: emp.id,
              employeeName: `${emp.firstName} ${emp.lastName}`,
              type: 'duplicate_clock_in',
              severity: 'error',
              details: `Duplicate clock-in on ${dateStr}`,
            });
          }
          day.clockIn = entryDate;
        } else if (entry.eventType === 'clock_out') {
          day.clockOut = entryDate;
        } else if (entry.eventType === 'break_start' || entry.eventType === 'break_end') {
          day.breaks += 0.5;
        }
      });

      let totalRegularHours = 0;
      let totalOvertimeHours = 0;
      let totalBreakHours = 0;
      const entries: PayrollEntry[] = [];

      const sortedDates = Array.from(dailyMap.keys()).sort();
      let weekHours = 0;

      sortedDates.forEach((dateStr) => {
        const day = dailyMap.get(dateStr)!;
        const date = new Date(dateStr);
        const dayOfWeek = date.getDay();

        let regularHours = 0;
        let overtimeHours = 0;
        let breakDuration = 0;

        if (day.clockIn && day.clockOut) {
          const diffMs = day.clockOut.getTime() - day.clockIn.getTime();
          const totalHours = diffMs / (1000 * 60 * 60);
          breakDuration = day.breaks * 0.5;
          const workHours = Math.max(0, totalHours - breakDuration);

          const remaining = Math.max(0, 40 - weekHours);
          if (workHours <= remaining) {
            regularHours = workHours;
            weekHours += workHours;
          } else {
            regularHours = remaining;
            overtimeHours = workHours - remaining;
            weekHours = 40;
          }

          if (workHours > 12) {
            anomalies.push({
              employeeId: emp.id,
              employeeName: `${emp.firstName} ${emp.lastName}`,
              type: 'long_shift',
              severity: 'warning',
              details: `Long shift on ${dateStr}: ${workHours.toFixed(1)} hours`,
            });
          }

          if (workHours > 6 && breakDuration === 0) {
            anomalies.push({
              employeeId: emp.id,
              employeeName: `${emp.firstName} ${emp.lastName}`,
              type: 'no_break',
              severity: 'warning',
              details: `No breaks on ${dateStr} (${workHours.toFixed(1)} hours)`,
            });
          }
        } else if (day.clockIn && !day.clockOut) {
          anomalies.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            type: 'no_clock_out',
            severity: 'error',
            details: `No clock-out on ${dateStr}`,
          });
        }

        if (regularHours > 0 || overtimeHours > 0 || breakDuration > 0) {
          entries.push({
            date: dateStr,
            clockIn: day.clockIn?.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) || '',
            clockOut: day.clockOut?.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) || '',
            breakDuration,
            regularHours,
            overtimeHours,
          });
          totalRegularHours += regularHours;
          totalOvertimeHours += overtimeHours;
          totalBreakHours += breakDuration;
        }

        if (dayOfWeek === 0) {
          weekHours = 0;
        }
      });

      if (entries.length > 0) {
        employeePayrollMap.set(emp.id, {
          employeeId: emp.id,
          firstName: emp.firstName,
          lastName: emp.lastName,
          role: emp.roleKey || 'employee',
          location: locationName,
          entries,
          totalRegularHours,
          totalOvertimeHours,
          totalBreakHours,
        });
      }
    });

    const payrollByEmployee = Array.from(employeePayrollMap.values());
    let totalRegularHours = 0;
    let totalOvertimeHours = 0;
    let totalGrossPay = 0;

    payrollByEmployee.forEach((emp) => {
      const rate = hourlyRates[emp.employeeId] || DEFAULT_HOURLY_RATES[emp.role] || 15;
      const grossPay = emp.totalRegularHours * rate + emp.totalOvertimeHours * rate * 1.5;
      totalRegularHours += emp.totalRegularHours;
      totalOvertimeHours += emp.totalOvertimeHours;
      totalGrossPay += grossPay;
    });

    return { payrollByEmployee, anomalies, totalRegularHours, totalOvertimeHours, totalGrossPay };
  }, [getPeriodDates, store, hourlyRates]);

  const exportCSV = () => {
    let csv = 'Employee,Role,Date,Clock In,Clock Out,Break (hrs),Regular (hrs),Overtime (hrs),Rate,Gross Pay\n';

    payrollData.payrollByEmployee.forEach((emp) => {
      const rate = hourlyRates[emp.employeeId] || DEFAULT_HOURLY_RATES[emp.role] || 15;

      emp.entries.forEach((entry) => {
        const grossPay = entry.regularHours * rate + entry.overtimeHours * rate * 1.5;
        csv += `"${emp.firstName} ${emp.lastName}","${emp.role}","${entry.date}","${entry.clockIn}","${entry.clockOut}",${entry.breakDuration.toFixed(2)},${entry.regularHours.toFixed(2)},${entry.overtimeHours.toFixed(2)},${rate},${grossPay.toFixed(2)}\n`;
      });
    });

    csv += `\nTotals,,,,,${payrollData.payrollByEmployee.reduce((sum, e) => sum + e.totalBreakHours, 0).toFixed(2)},${payrollData.totalRegularHours.toFixed(2)},${payrollData.totalOvertimeHours.toFixed(2)},,${payrollData.totalGrossPay.toFixed(2)}\n`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll_${periodKey}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const approvePayroll = () => {
    setApprovedPeriods({
      ...approvedPeriods,
      [periodKey]: {
        approvedAt: new Date().toISOString(),
        notes: periodNotes[periodKey] || '',
      },
    });
  };

  const isApproved = !!approvedPeriods[periodKey];

  return (
    <div className="w-full max-w-7xl mx-auto p-6 bg-zinc-50">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-zinc-900 mb-6">Payroll Summary</h1>

        <div className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200 mb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {(['current_week', 'previous_week', 'current_biweekly', 'custom'] as const).map((period) => (
              <button
                key={period}
                onClick={() => setSelectedPeriod(period)}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  selectedPeriod === period
                    ? 'bg-teal-700 text-white'
                    : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                }`}
              >
                {period === 'current_week' && 'Current Week'}
                {period === 'previous_week' && 'Previous Week'}
                {period === 'current_biweekly' && 'Current Biweekly'}
                {period === 'custom' && 'Custom'}
              </button>
            ))}
          </div>

          {selectedPeriod === 'custom' && (
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-2">Start Date</label>
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-2">End Date</label>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700"
                />
              </div>
            </div>
          )}

          <p className="text-sm text-zinc-600">
            <strong>Period:</strong> {getPeriodDates.startDate.toLocaleDateString()} - {getPeriodDates.endDate.toLocaleDateString()}
          </p>
        </div>
      </div>

      {payrollData.anomalies.length > 0 && (
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200 mb-6">
          <h2 className="text-lg font-bold text-zinc-900 mb-4">Anomalies Detected</h2>
          <div className="space-y-2">
            {payrollData.anomalies.map((anomaly, idx) => (
              <div
                key={idx}
                className={`p-3 rounded-lg ${
                  anomaly.severity === 'error' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'
                }`}
              >
                <strong>{anomaly.employeeName}</strong>: {anomaly.details}
              </div>
            ))}
          </div>
        </div>
      )}

      {payrollData.payrollByEmployee.map((emp) => {
        const rate = hourlyRates[emp.employeeId] || DEFAULT_HOURLY_RATES[emp.role] || 15;
        const grossPay = emp.totalRegularHours * rate + emp.totalOvertimeHours * rate * 1.5;

        return (
          <div key={emp.employeeId} className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200 mb-6">
            <div className="mb-4">
              <h3 className="text-xl font-bold text-zinc-900">
                {emp.firstName} {emp.lastName}
              </h3>
              <p className="text-sm text-zinc-600">
                {emp.role} • {emp.location}
              </p>
            </div>

            <div className="overflow-x-auto mb-6">
              <table className="w-full text-sm text-zinc-700">
                <thead className="bg-zinc-100 text-zinc-800 font-semibold">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Clock In</th>
                    <th className="px-3 py-2 text-left">Clock Out</th>
                    <th className="px-3 py-2 text-right">Break (hrs)</th>
                    <th className="px-3 py-2 text-right">Regular (hrs)</th>
                    <th className="px-3 py-2 text-right">Overtime (hrs)</th>
                  </tr>
                </thead>
                <tbody>
                  {emp.entries.map((entry, idx) => (
                    <tr key={idx} className="border-t border-zinc-200">
                      <td className="px-3 py-2">{entry.date}</td>
                      <td className="px-3 py-2">{entry.clockIn || '-'}</td>
                      <td className={`px-3 py-2 ${!entry.clockOut ? 'text-red-600 font-semibold' : ''}`}>
                        {entry.clockOut || 'MISSING'}
                      </td>
                      <td className="px-3 py-2 text-right">{entry.breakDuration.toFixed(2)}</td>
                      <td className={`px-3 py-2 text-right ${entry.regularHours > 8 ? 'bg-green-50' : ''}`}>
                        {entry.regularHours.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2 text-right ${entry.overtimeHours > 0 ? 'bg-amber-50 font-semibold' : ''}`}>
                        {entry.overtimeHours.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-zinc-50 rounded-lg">
              <div>
                <p className="text-xs text-zinc-600">Total Regular</p>
                <p className="text-lg font-bold text-zinc-900">{emp.totalRegularHours.toFixed(2)} hrs</p>
              </div>
              <div>
                <p className="text-xs text-zinc-600">Total Overtime</p>
                <p className="text-lg font-bold text-amber-600">{emp.totalOvertimeHours.toFixed(2)} hrs</p>
              </div>
              <div>
                <p className="text-xs text-zinc-600">Total Break Time</p>
                <p className="text-lg font-bold text-zinc-900">{emp.totalBreakHours.toFixed(2)} hrs</p>
              </div>
              <div>
                <p className="text-xs text-zinc-600">Hourly Rate</p>
                <div className="flex gap-2 mt-1">
                  <span className="text-lg font-bold text-teal-700">{formatCurrency(rate)}</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={rate}
                    onChange={(e) => setHourlyRates({ ...hourlyRates, [emp.employeeId]: parseFloat(e.target.value) })}
                    className="w-20 px-2 py-1 text-sm border border-zinc-300 rounded touch-button"
                  />
                </div>
              </div>
            </div>

            <div className="text-right font-bold text-lg text-teal-700">
              Gross Pay: {formatCurrency(grossPay)}
            </div>
          </div>
        );
      })}

      <div className="bg-teal-50 rounded-2xl p-6 border border-teal-200 mb-6">
        <h2 className="text-lg font-bold text-teal-900 mb-4">Payroll Totals</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
          <div>
            <p className="text-sm text-teal-700">Total Regular Hours</p>
            <p className="text-2xl font-bold text-teal-900">{payrollData.totalRegularHours.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-sm text-teal-700">Total Overtime Hours</p>
            <p className="text-2xl font-bold text-amber-600">{payrollData.totalOvertimeHours.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-sm text-teal-700">Total Gross Payroll</p>
            <p className="text-2xl font-bold text-teal-900">{formatCurrency(payrollData.totalGrossPay)}</p>
          </div>
          <div>
            <p className="text-sm text-teal-700">Avg Hourly Cost</p>
            <p className="text-2xl font-bold text-teal-900">
              {formatCurrency(
                payrollData.totalRegularHours + payrollData.totalOvertimeHours > 0
                  ? payrollData.totalGrossPay / (payrollData.totalRegularHours + payrollData.totalOvertimeHours)
                  : 0
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200 mb-6">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Period Notes</h2>
        <textarea
          value={periodNotes[periodKey] || ''}
          onChange={(e) => setPeriodNotes({ ...periodNotes, [periodKey]: e.target.value })}
          placeholder="Add notes for this payroll period..."
          className="w-full px-4 py-3 border border-zinc-300 rounded-lg text-zinc-700 placeholder-zinc-400 mb-4"
          rows={3}
        />
        <div className="flex gap-3">
          <button
            onClick={exportCSV}
            className="flex-1 px-4 py-2 bg-zinc-700 text-white rounded-lg font-semibold hover:bg-zinc-800 transition touch-button"
          >
            Export CSV
          </button>
          <button
            onClick={approvePayroll}
            className={`flex-1 px-4 py-2 rounded-lg font-semibold transition touch-button ${
              isApproved
                ? 'bg-green-100 text-green-700'
                : 'bg-teal-700 text-white hover:bg-teal-800'
            }`}
          >
            {isApproved ? '✓ Approved' : 'Approve Payroll'}
          </button>
        </div>
        {isApproved && (
          <p className="mt-3 text-sm text-green-700">
            Approved on {new Date(approvedPeriods[periodKey].approvedAt).toLocaleDateString()}
          </p>
        )}
      </div>
    </div>
  );
}