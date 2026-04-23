'use client';

import { useState, useMemo, useEffect } from 'react';
import { LocalStoreData } from '@/lib/persistence/types';
import { formatCurrency } from "@/lib/format";

interface DailyStats {
  date: Date;
  salesTotal: number;
  salesSubtotal: number;
  taxTotal: number;
  transactionCount: number;
  returnCount: number;
  returnTotal: number;
  averageTicket: number;
  hourlyBreakdown: Record<number, number>;
  tenderBreakdown: Record<string, { amount: number; count: number }>;
  employeeMetrics: Record<string, EmployeeMetrics>;
  shiftData: ShiftMetrics[];
  inventoryAlerts: InventoryAlert[];
  exceptions: ExceptionAlert[];
  topCategories: CategoryRevenue[];
  newCustomers: number;
  returningCustomers: number;
  topCustomer: { name: string; spend: number } | null;
}

interface EmployeeMetrics {
  employeeId: string;
  displayName: string;
  salesTotal: number;
  transactionCount: number;
  voidCount: number;
  hoursWorked: number;
  cashVariance: number | null;
  exceptionCount: number;
  clockIn: Date | null;
  clockOut: Date | null;
}

interface ShiftMetrics {
  employeeId: string;
  employeeName: string;
  openingFloat: number;
  expectedCash: number;
  declaredCash: number;
  variance: number;
  blindClose: boolean;
}

interface InventoryAlert {
  productId: string;
  productName: string;
  variant: string;
  alertType: 'out_of_stock' | 'below_reorder';
  currentQty: number;
  reorderPoint: number;
}

interface ExceptionAlert {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  priority: 'high' | 'medium' | 'low';
}

interface CategoryRevenue {
  categoryId: string;
  categoryName: string;
  revenue: number;
  percentage: number;
}

interface TransferItem {
  id: string;
  date: Date;
  direction: 'sent' | 'received';
  otherStoreName: string;
  productName: string;
  variant: string;
  qty: number;
  confirmed: boolean;
}

interface WeatherData {
  tempHigh: number;
  tempLow: number;
  tempCurrent: number;
  condition: string;
  icon: string;
  isRaining: boolean;
  humidity: number;
  windSpeed: number;
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function getDateRangeForDay(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function computeDailyStats(store: LocalStoreData, date: Date): DailyStats {
  const { start, end } = getDateRangeForDay(date);

  const dayTransactions = store.transactionEventPlaceholders?.filter((e) => {
    const createdAt = new Date(e.createdAt);
    return e.eventKind === 'transaction_placeholder' && createdAt >= start && createdAt <= end;
  }) || [];

  const dayReturns = dayTransactions.filter((t) => t.payload?.is_return === 'true');
  const daySales = dayTransactions.filter((t) => t.payload?.is_return !== 'true');

  // R76-FE-M: guard NaN contamination. `parseFloat(payload?.x || '0')`
  // falls back to '0' only on null/empty-string — a corrupted payload
  // like "$12.00" or "N/A" yields NaN, and one NaN poisons every sum
  // via reduce. Make the parsed value safe.
  const safeNum = (v: unknown) => {
    const n = parseFloat(String(v ?? "0"));
    return Number.isFinite(n) ? n : 0;
  };
  const salesTotal = daySales.reduce((sum, t) => sum + safeNum(t.payload?.grand_total), 0);
  const salesSubtotal = daySales.reduce((sum, t) => sum + safeNum(t.payload?.subtotal), 0);
  const taxTotal = daySales.reduce((sum, t) => sum + safeNum(t.payload?.tax_total), 0);
  const returnTotal = dayReturns.reduce((sum, t) => sum + safeNum(t.payload?.grand_total), 0);

  const hourlyBreakdown: Record<number, number> = {};
  daySales.forEach((transaction) => {
    const hour = new Date(transaction.createdAt).getHours();
    hourlyBreakdown[hour] = (hourlyBreakdown[hour] || 0) + safeNum(transaction.payload?.grand_total);
  });

  const tenderBreakdown: Record<string, { amount: number; count: number }> = {};
  const dayTenders = store.transactionTenderPlaceholders?.filter((t) => {
    const transactionIds = new Set(dayTransactions.map((e) => e.transactionId));
    return transactionIds.has(t.transactionId);
  }) || [];

  dayTenders.forEach((tender) => {
    if (!tenderBreakdown[tender.tenderType]) {
      tenderBreakdown[tender.tenderType] = { amount: 0, count: 0 };
    }
    tenderBreakdown[tender.tenderType].amount += tender.amount;
    tenderBreakdown[tender.tenderType].count += 1;
  });

  const employeeMetrics: Record<string, EmployeeMetrics> = {};
  dayTransactions.forEach((transaction) => {
    const actorId = transaction.actorEmployeeId;
    if (!actorId) return;

    const employee = store.employees?.find((e) => e.id === actorId);
    if (!employee) return;

    if (!employeeMetrics[actorId]) {
      employeeMetrics[actorId] = {
        employeeId: actorId,
        displayName: employee.displayName,
        salesTotal: 0,
        transactionCount: 0,
        voidCount: 0,
        hoursWorked: 0,
        cashVariance: null,
        exceptionCount: 0,
        clockIn: null,
        clockOut: null,
      };
    }

    if (transaction.payload?.is_return !== 'true') {
      employeeMetrics[actorId].salesTotal += parseFloat(transaction.payload?.grand_total || '0');
      employeeMetrics[actorId].transactionCount += 1;
    }
  });

  const dayClocks = store.timeClockEntries?.filter((e) => {
    const createdAt = new Date(e.createdAt);
    return createdAt >= start && createdAt <= end;
  }) || [];

  const employeeClockIn: Record<string, Date> = {};
  dayClocks.forEach((clock) => {
    if (clock.eventType === 'clock_in') {
      employeeClockIn[clock.employeeId] = new Date(clock.createdAt);
      // Track clock-in time for roster
      if (employeeMetrics[clock.employeeId]) {
        if (!employeeMetrics[clock.employeeId].clockIn || new Date(clock.createdAt) < employeeMetrics[clock.employeeId].clockIn!) {
          employeeMetrics[clock.employeeId].clockIn = new Date(clock.createdAt);
        }
      }
    } else if (clock.eventType === 'clock_out') {
      if (employeeClockIn[clock.employeeId]) {
        const hours = (new Date(clock.createdAt).getTime() - employeeClockIn[clock.employeeId].getTime()) / (1000 * 60 * 60);
        if (employeeMetrics[clock.employeeId]) {
          employeeMetrics[clock.employeeId].hoursWorked += hours;
          employeeMetrics[clock.employeeId].clockOut = new Date(clock.createdAt);
        }
        delete employeeClockIn[clock.employeeId];
      }
    }
  });

  // Also add employees who clocked in but didn't make sales
  dayClocks.forEach((clock) => {
    if (clock.eventType === 'clock_in' && !employeeMetrics[clock.employeeId]) {
      const employee = store.employees?.find((e) => e.id === clock.employeeId);
      if (employee) {
        employeeMetrics[clock.employeeId] = {
          employeeId: clock.employeeId,
          displayName: employee.displayName,
          salesTotal: 0,
          transactionCount: 0,
          voidCount: 0,
          hoursWorked: 0,
          cashVariance: null,
          exceptionCount: 0,
          clockIn: new Date(clock.createdAt),
          clockOut: null,
        };
      }
    }
  });

  const dayShifts = store.shifts?.filter((s) => {
    if (!s.openedAt) return false;
    const openedAt = new Date(s.openedAt);
    return openedAt >= start && openedAt <= end;
  }) || [];

  const shiftData: ShiftMetrics[] = dayShifts.map((shift) => {
    const employee = store.employees?.find((e) => e.id === shift.employeeId);
    const expectedCash = shift.closingExpectedCash || 0;
    const declaredCash = shift.closingDeclaredCash || 0;
    const variance = declaredCash - expectedCash;

    if (employeeMetrics[shift.employeeId]) {
      employeeMetrics[shift.employeeId].cashVariance = variance;
    }

    return {
      employeeId: shift.employeeId,
      employeeName: employee?.displayName || 'Unknown',
      openingFloat: shift.openingFloat,
      expectedCash,
      declaredCash,
      variance,
      blindClose: shift.blindClose || false,
    };
  });

  const dayExceptions = store.transactionExceptionPlaceholders?.filter((e) => {
    const transactionIds = new Set(dayTransactions.map((t) => t.transactionId));
    return transactionIds.has(e.transactionId) && !e.resolvedAt;
  }) || [];

  dayExceptions.forEach((exc) => {
    const transaction = dayTransactions.find((t) => t.transactionId === exc.transactionId);
    if (transaction && employeeMetrics[transaction.actorEmployeeId]) {
      employeeMetrics[transaction.actorEmployeeId].exceptionCount += 1;
    }
  });

  const exceptions: ExceptionAlert[] = dayExceptions.map((exc) => {
    const transaction = dayTransactions.find((t) => t.transactionId === exc.transactionId);
    const employee = store.employees?.find((e) => e.id === transaction?.actorEmployeeId);
    const priority = exc.requiresManagerApproval ? 'high' : 'medium';
    return {
      id: exc.id,
      code: exc.exceptionCode,
      employeeId: transaction?.actorEmployeeId || '',
      employeeName: employee?.displayName || 'Unknown',
      priority,
    };
  });

  const variantMap = new Map(store.variants?.map((v) => [v.id, v]) || []);
  const productMap = new Map(store.products?.map((p) => [p.id, p]) || []);
  const categoryMap = new Map(store.categories?.map((c) => [c.id, c]) || []);

  const categoryRevenue: Record<string, number> = {};
  const topCategories: CategoryRevenue[] = Object.entries(categoryRevenue)
    .map(([catId, revenue]) => ({
      categoryId: catId,
      categoryName: categoryMap.get(catId)?.name || 'Unknown',
      revenue,
      percentage: (revenue / salesTotal) * 100,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const inventoryAlerts: InventoryAlert[] = [];
  store.inventory?.forEach((inv) => {
    const variant = variantMap.get(inv.productVariantId);
    const product = variant ? productMap.get(variant.productId) : null;

    if (inv.onHand === 0) {
      inventoryAlerts.push({
        productId: product?.id || '',
        productName: product?.name || 'Unknown',
        variant: variant?.name || '',
        alertType: 'out_of_stock',
        currentQty: 0,
        reorderPoint: inv.reorderPoint,
      });
    } else if (inv.onHand < inv.reorderPoint) {
      inventoryAlerts.push({
        productId: product?.id || '',
        productName: product?.name || 'Unknown',
        variant: variant?.name || '',
        alertType: 'below_reorder',
        currentQty: inv.onHand,
        reorderPoint: inv.reorderPoint,
      });
    }
  });

  const dayCustomerTransactions = new Set<string>();
  dayTransactions.forEach((t) => {
    if (t.payload?.customer_id) {
      dayCustomerTransactions.add(t.payload.customer_id);
    }
  });

  let newCustomers = 0;
  let returningCustomers = 0;
  let topCustomer: { name: string; spend: number } | null = null;
  let topCustomerSpend = 0;

  store.customers?.forEach((cust) => {
    if (dayCustomerTransactions.has(cust.id)) {
      if (cust.visitCount === 1) {
        newCustomers += 1;
      } else {
        returningCustomers += 1;
      }

      const spend = daySales
        .filter((t) => t.payload?.customer_id === cust.id)
        .reduce((sum, t) => sum + safeNum(t.payload?.grand_total), 0);

      if (spend > topCustomerSpend) {
        topCustomerSpend = spend;
        topCustomer = { name: `${cust.firstName} ${cust.lastName}`, spend };
      }
    }
  });

  return {
    date,
    salesTotal,
    salesSubtotal,
    taxTotal,
    transactionCount: daySales.length,
    returnCount: dayReturns.length,
    returnTotal,
    averageTicket: daySales.length > 0 ? salesTotal / daySales.length : 0,
    hourlyBreakdown,
    tenderBreakdown,
    employeeMetrics,
    shiftData,
    inventoryAlerts,
    exceptions,
    topCategories,
    newCustomers,
    returningCustomers,
    topCustomer,
  };
}

// Weather condition codes from Open-Meteo WMO
function getWeatherInfo(code: number): { condition: string; icon: string; isRaining: boolean } {
  if (code === 0) return { condition: 'Clear sky', icon: '☀️', isRaining: false };
  if (code <= 3) return { condition: 'Partly cloudy', icon: '⛅', isRaining: false };
  if (code <= 48) return { condition: 'Foggy', icon: '🌫️', isRaining: false };
  if (code <= 57) return { condition: 'Drizzle', icon: '🌦️', isRaining: true };
  if (code <= 67) return { condition: 'Rain', icon: '🌧️', isRaining: true };
  if (code <= 77) return { condition: 'Snow', icon: '🌨️', isRaining: false };
  if (code <= 82) return { condition: 'Rain showers', icon: '🌧️', isRaining: true };
  if (code <= 86) return { condition: 'Snow showers', icon: '🌨️', isRaining: false };
  if (code <= 99) return { condition: 'Thunderstorm', icon: '⛈️', isRaining: true };
  return { condition: 'Unknown', icon: '❓', isRaining: false };
}

export function DailyManagerReport({ store }: { store: LocalStoreData }) {
  const today = new Date();
  const [selectedDate, setSelectedDate] = useState(today);
  const [notes, setNotes] = useState('');

  // Hourly time range
  const [hourStart, setHourStart] = useState(0);
  const [hourEnd, setHourEnd] = useState(23);

  // Transfer items (local state - in production would come from DB)
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [showAddTransfer, setShowAddTransfer] = useState(false);
  const [newTransfer, setNewTransfer] = useState<Partial<TransferItem>>({ direction: 'sent', qty: 1, confirmed: false });

  // Weather
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  const stats = useMemo(() => computeDailyStats(store, selectedDate), [store, selectedDate]);

  // Fetch weather when date changes
  useEffect(() => {
    const fetchWeather = async () => {
      setWeatherLoading(true);
      setWeatherError(null);
      try {
        // Bellflower, CA coordinates
        const lat = 33.8817;
        const lon = -118.1170;
        const dateStr = selectedDate.toISOString().split('T')[0];

        const isToday = dateStr === new Date().toISOString().split('T')[0];
        const isPast = selectedDate < new Date();

        let url: string;
        if (isToday) {
          url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,weather_code,relative_humidity_2m_max,wind_speed_10m_max&current=temperature_2m&timezone=America/Los_Angeles&forecast_days=1`;
        } else if (isPast) {
          url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,weather_code,relative_humidity_2m_max,wind_speed_10m_max&timezone=America/Los_Angeles&start_date=${dateStr}&end_date=${dateStr}&past_days=90`;
        } else {
          url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,weather_code,relative_humidity_2m_max,wind_speed_10m_max&timezone=America/Los_Angeles&start_date=${dateStr}&end_date=${dateStr}`;
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error('Weather data unavailable');
        const data = await res.json();

        if (data.daily && data.daily.temperature_2m_max?.length > 0) {
          const weatherCode = data.daily.weather_code[0];
          const info = getWeatherInfo(weatherCode);
          // Convert Celsius to Fahrenheit
          const toF = (c: number) => Math.round(c * 9 / 5 + 32);

          setWeather({
            tempHigh: toF(data.daily.temperature_2m_max[0]),
            tempLow: toF(data.daily.temperature_2m_min[0]),
            tempCurrent: data.current?.temperature_2m ? toF(data.current.temperature_2m) : toF((data.daily.temperature_2m_max[0] + data.daily.temperature_2m_min[0]) / 2),
            condition: info.condition,
            icon: info.icon,
            isRaining: info.isRaining,
            humidity: data.daily.relative_humidity_2m_max?.[0] ?? 0,
            windSpeed: Math.round((data.daily.wind_speed_10m_max?.[0] ?? 0) * 0.621371), // km/h to mph
          });
        } else {
          setWeather(null);
          setWeatherError('No data for this date');
        }
      } catch {
        setWeather(null);
        setWeatherError('Could not load weather');
      } finally {
        setWeatherLoading(false);
      }
    };

    fetchWeather();
  }, [selectedDate]);

  const dayOfWeek = selectedDate.toLocaleDateString('en-US', { weekday: 'short' });
  const fullDate = selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const handlePrevDay = () => {
    const prev = new Date(selectedDate);
    prev.setDate(prev.getDate() - 1);
    setSelectedDate(prev);
  };

  const handleNextDay = () => {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + 1);
    if (next <= today) {
      setSelectedDate(next);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleAddTransfer = () => {
    if (!newTransfer.productName) return;
    const item: TransferItem = {
      id: `transfer-${Date.now()}`,
      date: selectedDate,
      direction: newTransfer.direction as 'sent' | 'received',
      otherStoreName: newTransfer.otherStoreName || 'Other Store',
      productName: newTransfer.productName || '',
      variant: newTransfer.variant || '',
      qty: newTransfer.qty || 1,
      confirmed: false,
    };
    setTransfers((prev) => [...prev, item]);
    setNewTransfer({ direction: 'sent', qty: 1, confirmed: false });
    setShowAddTransfer(false);
  };

  const toggleTransferConfirmed = (id: string) => {
    setTransfers((prev) => prev.map((t) => t.id === id ? { ...t, confirmed: !t.confirmed } : t));
  };

  const avgTicketValue =
    Object.values(stats.employeeMetrics).reduce((sum, m) => sum + m.salesTotal, 0) /
    Object.values(stats.employeeMetrics).length || 0;

  const filteredHours = Array.from({ length: 24 }, (_, h) => h).filter((h) => h >= hourStart && h <= hourEnd);
  const maxHourlyValue = Math.max(...filteredHours.map((h) => stats.hourlyBreakdown[h] || 0), 1);
  const filteredHourlyTotal = filteredHours.reduce((sum, h) => sum + (stats.hourlyBreakdown[h] || 0), 0);
  const totalCashVariance = stats.shiftData.reduce((sum, s) => sum + s.variance, 0);

  // Employees who worked (from metrics + clock entries)
  const employeeRoster = Object.values(stats.employeeMetrics).sort((a, b) => b.salesTotal - a.salesTotal);

  // Day transfers
  const dayTransfers = transfers.filter((t) => t.date.toDateString() === selectedDate.toDateString());

  const _locations = store.locations || [];

  return (
    <div className="bg-zinc-50 p-6 min-h-screen">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-zinc-900">Daily Manager Report</h1>
          <p className="text-zinc-600 mt-2">
            {dayOfWeek}, {fullDate}
          </p>
        </div>
        <button
          onClick={handlePrint}
          className="touch-button px-4 py-2 bg-teal-700 text-white rounded-2xl hover:bg-teal-800"
        >
          Print Report
        </button>
      </div>

      {/* Date Selector */}
      <div className="flex gap-3 mb-6">
        <button
          onClick={handlePrevDay}
          className="touch-button px-4 py-2 bg-white border border-zinc-300 rounded-2xl text-zinc-700 hover:bg-zinc-100"
        >
          ← Previous Day
        </button>
        <div className="flex-1 flex items-center justify-center">
          <input
            type="date"
            value={selectedDate.toISOString().split('T')[0]}
            onChange={(e) => setSelectedDate(new Date(e.target.value))}
            className="px-4 py-2 border border-zinc-300 rounded-2xl text-zinc-700"
          />
        </div>
        <button
          onClick={handleNextDay}
          disabled={selectedDate >= today}
          className="touch-button px-4 py-2 bg-white border border-zinc-300 rounded-2xl text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
        >
          Next Day →
        </button>
      </div>

      {/* Weather Card */}
      <div className="bg-white rounded-2xl p-5 mb-6 shadow-sm border border-zinc-200">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-500 mb-3">Weather</h2>
        {weatherLoading ? (
          <div className="flex items-center gap-2 text-zinc-500 text-sm">
            <span className="animate-pulse">Loading weather data...</span>
          </div>
        ) : weatherError ? (
          <p className="text-sm text-zinc-400">{weatherError}</p>
        ) : weather ? (
          <div className="flex items-center gap-6">
            <div className="text-4xl">{weather.icon}</div>
            <div>
              <p className="text-xl font-bold text-zinc-900">{weather.tempCurrent}°F</p>
              <p className="text-sm text-zinc-600">{weather.condition}</p>
            </div>
            <div className="flex gap-4 ml-auto text-sm">
              <div className="text-center">
                <p className="text-zinc-500">High</p>
                <p className="font-bold text-zinc-900">{weather.tempHigh}°F</p>
              </div>
              <div className="text-center">
                <p className="text-zinc-500">Low</p>
                <p className="font-bold text-zinc-900">{weather.tempLow}°F</p>
              </div>
              <div className="text-center">
                <p className="text-zinc-500">Humidity</p>
                <p className="font-bold text-zinc-900">{weather.humidity}%</p>
              </div>
              <div className="text-center">
                <p className="text-zinc-500">Wind</p>
                <p className="font-bold text-zinc-900">{weather.windSpeed} mph</p>
              </div>
              <div className="text-center">
                <p className="text-zinc-500">Rain</p>
                <p className={`font-bold ${weather.isRaining ? 'text-blue-600' : 'text-zinc-900'}`}>
                  {weather.isRaining ? 'Yes' : 'No'}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No weather data available</p>
        )}
      </div>

      {/* Executive Summary */}
      <div className="bg-white rounded-2xl p-6 mb-6 border-l-4 border-teal-700 shadow-sm">
        <div className="grid grid-cols-4 gap-4">
          <div>
            <p className="text-zinc-600 text-sm font-medium">Net Sales</p>
            <p className="text-2xl font-bold text-zinc-900">{formatCurrency(stats.salesTotal)}</p>
          </div>
          <div>
            <p className="text-zinc-600 text-sm font-medium">Transactions</p>
            <p className="text-2xl font-bold text-zinc-900">{stats.transactionCount}</p>
          </div>
          <div>
            <p className="text-zinc-600 text-sm font-medium">Avg Ticket</p>
            <p className="text-2xl font-bold text-zinc-900">{formatCurrency(stats.averageTicket)}</p>
          </div>
          <div>
            <p className="text-zinc-600 text-sm font-medium">Returns</p>
            <p className="text-2xl font-bold text-red-600">
              {stats.returnCount} ({formatCurrency(stats.returnTotal)})
            </p>
          </div>
        </div>
      </div>

      {/* Sales Breakdown */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        {/* Hourly Chart with Time Range */}
        <div className="bg-white rounded-2xl p-6 shadow-sm">
          <div className="flex flex-col gap-3 mb-4">
            <h2 className="text-lg font-bold text-zinc-900">Hourly Sales</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-1.5 text-sm text-zinc-600">
                From
                <select
                  value={hourStart}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setHourStart(val);
                    if (val > hourEnd) setHourEnd(val);
                  }}
                  className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm font-medium text-zinc-800"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{formatHourLabel(i)}</option>
                  ))}
                </select>
              </label>
              <span className="text-zinc-400">—</span>
              <label className="flex items-center gap-1.5 text-sm text-zinc-600">
                To
                <select
                  value={hourEnd}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setHourEnd(val);
                    if (val < hourStart) setHourStart(val);
                  }}
                  className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm font-medium text-zinc-800"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{formatHourLabel(i)}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => { setHourStart(0); setHourEnd(23); }}
                className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
          <div className="space-y-2">
            {filteredHours.map((h) => {
              const value = stats.hourlyBreakdown[h] || 0;
              const percentage = (value / maxHourlyValue) * 100;
              return (
                <div key={h} className="flex items-center gap-2">
                  <div className="w-12 text-right text-xs font-medium text-zinc-600">
                    {formatHourLabel(h)}
                  </div>
                  <div className="flex-1 h-6 bg-zinc-100 rounded-lg overflow-hidden">
                    {percentage > 0 && (
                      <div
                        className="h-full bg-teal-600 transition-all"
                        style={{ width: `${percentage}%` }}
                      />
                    )}
                  </div>
                  <div className="w-16 text-right text-xs font-medium text-zinc-700">
                    {formatCurrency(value, 'USD', { fractionDigits: 0 })}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Range total */}
          <div className="mt-3 flex items-center justify-between border-t border-zinc-200 pt-3">
            <span className="text-xs font-semibold text-zinc-500">
              Total ({formatHourLabel(hourStart)} – {formatHourLabel(hourEnd)})
            </span>
            <span className="text-sm font-bold text-teal-700">{formatCurrency(filteredHourlyTotal)}</span>
          </div>
        </div>

        {/* Tender Breakdown */}
        <div className="bg-white rounded-2xl p-6 shadow-sm">
          <h2 className="text-lg font-bold text-zinc-900 mb-4">Tender Breakdown</h2>
          <div className="space-y-3">
            {Object.entries(stats.tenderBreakdown).map(([tender, data]) => {
              const percentage = (data.amount / stats.salesTotal) * 100;
              return (
                <div key={tender}>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-zinc-700 font-medium capitalize">{tender}</span>
                    <span className="text-zinc-900 font-bold">{formatCurrency(data.amount)}</span>
                  </div>
                  <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden">
                    <div className="h-full bg-teal-600" style={{ width: `${percentage}%` }} />
                  </div>
                  <p className="text-xs text-zinc-600 mt-1">
                    {percentage.toFixed(1)}% ({data.count} trans.)
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Employees Who Worked Today */}
      <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Employees on Duty</h2>
        {employeeRoster.length === 0 ? (
          <p className="text-sm text-zinc-500">No employee activity recorded for this day</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {employeeRoster.map((emp) => {
              const clockInStr = emp.clockIn
                ? emp.clockIn.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                : '—';
              const clockOutStr = emp.clockOut
                ? emp.clockOut.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                : 'Still in';

              return (
                <div key={emp.employeeId} className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3">
                  {/* Avatar */}
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-100 text-teal-700 font-bold text-sm">
                    {emp.displayName.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-zinc-900 truncate">{emp.displayName}</p>
                    <p className="text-xs text-zinc-500">
                      {clockInStr} – {clockOutStr}
                      {emp.hoursWorked > 0 && ` (${emp.hoursWorked.toFixed(1)}h)`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-zinc-900">{emp.transactionCount} sales</p>
                    <p className="text-xs text-zinc-500">{formatCurrency(emp.salesTotal, 'USD', { fractionDigits: 0 })}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Inter-Store Transfers */}
      <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-zinc-900">Inter-Store Transfers</h2>
          <button
            onClick={() => setShowAddTransfer(!showAddTransfer)}
            className="touch-button px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-medium text-sm"
          >
            + Add Transfer
          </button>
        </div>

        {showAddTransfer && (
          <form
            onSubmit={(e) => { e.preventDefault(); handleAddTransfer(); }}
            className="mb-4 p-4 bg-zinc-50 rounded-xl border border-zinc-200 space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Direction</label>
                <select
                  value={newTransfer.direction}
                  onChange={(e) => setNewTransfer({ ...newTransfer, direction: e.target.value as 'sent' | 'received' })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                >
                  <option value="sent">Sent to another store</option>
                  <option value="received">Received from another store</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">
                  {newTransfer.direction === 'sent' ? 'Sent To' : 'Received From'}
                </label>
                <input
                  type="text"
                  value={newTransfer.otherStoreName || ''}
                  onChange={(e) => setNewTransfer({ ...newTransfer, otherStoreName: e.target.value })}
                  placeholder="Store name"
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Product</label>
                <input
                  type="text"
                  value={newTransfer.productName || ''}
                  onChange={(e) => setNewTransfer({ ...newTransfer, productName: e.target.value })}
                  placeholder="Product name"
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Variant / SKU</label>
                <input
                  type="text"
                  value={newTransfer.variant || ''}
                  onChange={(e) => setNewTransfer({ ...newTransfer, variant: e.target.value })}
                  placeholder="e.g. Blue / XL"
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Qty</label>
                <input
                  type="number"
                  min="1"
                  value={newTransfer.qty || 1}
                  onChange={(e) => setNewTransfer({ ...newTransfer, qty: parseInt(e.target.value) || 1 })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="touch-button px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-medium text-sm">
                Add
              </button>
              <button type="button" onClick={() => setShowAddTransfer(false)} className="touch-button px-4 py-2 rounded-lg bg-zinc-200 hover:bg-zinc-300 text-zinc-700 font-medium text-sm">
                Cancel
              </button>
            </div>
          </form>
        )}

        {dayTransfers.length === 0 && !showAddTransfer ? (
          <p className="text-sm text-zinc-500">No inter-store transfers recorded for this day</p>
        ) : (
          <div className="space-y-2">
            {dayTransfers.map((t) => (
              <div
                key={t.id}
                className={`flex items-center gap-3 p-3 rounded-xl border ${
                  t.direction === 'sent'
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-blue-50 border-blue-200'
                }`}
              >
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={t.confirmed}
                    onChange={() => toggleTransferConfirmed(t.id)}
                    className="h-5 w-5 rounded border-zinc-300 text-teal-600"
                  />
                </label>
                <div className={`text-xs font-bold px-2 py-1 rounded-full ${
                  t.direction === 'sent' ? 'bg-amber-200 text-amber-800' : 'bg-blue-200 text-blue-800'
                }`}>
                  {t.direction === 'sent' ? '→ SENT' : '← RECEIVED'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`font-medium text-zinc-900 ${t.confirmed ? 'line-through opacity-60' : ''}`}>
                    {t.productName} {t.variant && `(${t.variant})`}
                  </p>
                  <p className="text-xs text-zinc-600">
                    {t.direction === 'sent' ? `To: ${t.otherStoreName}` : `From: ${t.otherStoreName}`} — Qty: {t.qty}
                  </p>
                </div>
                <button
                  onClick={() => setTransfers((prev) => prev.filter((x) => x.id !== t.id))}
                  className="text-zinc-400 hover:text-red-600 text-sm font-bold"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Staff Performance */}
      <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Staff Performance</h2>
        <div className="space-y-3">
          {Object.values(stats.employeeMetrics).filter((e) => e.transactionCount > 0).map((emp) => {
            const isAboveAvg = emp.salesTotal > avgTicketValue;
            const varianceColor = emp.cashVariance === null ? 'text-zinc-600' : emp.cashVariance >= 0 ? 'text-green-600' : 'text-red-600';

            return (
              <div
                key={emp.employeeId}
                className={`border rounded-xl p-4 ${isAboveAvg ? 'bg-green-50 border-green-200' : 'border-zinc-200'}`}
              >
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <p className="font-bold text-zinc-900">{emp.displayName}</p>
                    <p className="text-xs text-zinc-600">
                      {emp.transactionCount} sales • {emp.hoursWorked.toFixed(1)}h worked
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-zinc-900">{formatCurrency(emp.salesTotal)}</p>
                    <p className="text-xs text-zinc-600">Avg: {formatCurrency((emp.salesTotal / Math.max(emp.transactionCount, 1)))}</p>
                  </div>
                </div>
                <div className="flex gap-4 text-sm">
                  <span className="text-zinc-700">Voids: {emp.voidCount}</span>
                  <span className={varianceColor}>
                    Cash Var: {formatCurrency((emp.cashVariance || 0))}
                  </span>
                  {emp.exceptionCount > 0 && (
                    <span className="text-red-600 font-medium">{emp.exceptionCount} exceptions</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Cash Accountability */}
      <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Cash Accountability</h2>
        <div className="space-y-3">
          {stats.shiftData.map((shift) => {
            const varianceColor = shift.variance >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200';
            const varianceTextColor = shift.variance >= 0 ? 'text-green-700' : 'text-red-700';

            return (
              <div key={shift.employeeId} className={`border rounded-xl p-4 ${varianceColor}`}>
                <div className="flex justify-between items-start mb-2">
                  <p className="font-bold text-zinc-900">{shift.employeeName}</p>
                  {shift.blindClose && <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded-full">Blind Close</span>}
                </div>
                <div className="grid grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-zinc-600 text-xs">Opening Float</p>
                    <p className="font-bold text-zinc-900">{formatCurrency(shift.openingFloat)}</p>
                  </div>
                  <div>
                    <p className="text-zinc-600 text-xs">Expected</p>
                    <p className="font-bold text-zinc-900">{formatCurrency(shift.expectedCash)}</p>
                  </div>
                  <div>
                    <p className="text-zinc-600 text-xs">Declared</p>
                    <p className="font-bold text-zinc-900">{formatCurrency(shift.declaredCash)}</p>
                  </div>
                  <div>
                    <p className="text-zinc-600 text-xs">Variance</p>
                    <p className={`font-bold ${varianceTextColor}`}>
                      {shift.variance >= 0 ? '+' : ''} {formatCurrency(shift.variance)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
          {stats.shiftData.length > 0 && (
            <div className={`border-t-2 pt-3 mt-3 ${totalCashVariance >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              <p className="text-sm font-bold">
                Total Variance: {totalCashVariance >= 0 ? '+' : ''} {formatCurrency(totalCashVariance)}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Inventory Alerts */}
      {stats.inventoryAlerts.length > 0 && (
        <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
          <h2 className="text-lg font-bold text-zinc-900 mb-4">Inventory Alerts</h2>
          <div className="space-y-2">
            {stats.inventoryAlerts.slice(0, 8).map((alert) => (
              <div key={alert.productId} className="flex items-center justify-between p-3 bg-red-50 border border-red-200 rounded-lg">
                <div>
                  <p className="font-medium text-zinc-900">{alert.productName}</p>
                  <p className="text-xs text-zinc-600">{alert.variant}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-red-700">
                    {alert.alertType === 'out_of_stock' ? 'OUT OF STOCK' : `${alert.currentQty} on hand`}
                  </p>
                  <p className="text-xs text-zinc-600">Reorder: {alert.reorderPoint}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Customer Insights */}
      <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Customer Insights</h2>
        <div className="grid grid-cols-3 gap-4">
          <div className="p-4 bg-blue-50 rounded-xl border border-blue-200">
            <p className="text-zinc-600 text-sm">New Customers</p>
            <p className="text-2xl font-bold text-blue-700">{stats.newCustomers}</p>
          </div>
          <div className="p-4 bg-purple-50 rounded-xl border border-purple-200">
            <p className="text-zinc-600 text-sm">Returning Customers</p>
            <p className="text-2xl font-bold text-purple-700">{stats.returningCustomers}</p>
          </div>
          <div className="p-4 bg-amber-50 rounded-xl border border-amber-200">
            <p className="text-zinc-600 text-sm">Top Customer</p>
            <p className="text-lg font-bold text-amber-700">
              {stats.topCustomer ? stats.topCustomer.name : 'N/A'}
            </p>
            {stats.topCustomer && (
              <p className="text-xs text-zinc-600">{formatCurrency(stats.topCustomer.spend)}</p>
            )}
          </div>
        </div>
      </div>

      {/* Exceptions & Flags */}
      {stats.exceptions.length > 0 && (
        <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
          <h2 className="text-lg font-bold text-zinc-900 mb-4">Action Items / Flags</h2>
          <div className="space-y-2">
            {stats.exceptions.map((exc) => {
              const priorityColor = exc.priority === 'high' ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200';
              const priorityBadge = exc.priority === 'high' ? 'bg-red-200 text-red-800' : 'bg-yellow-200 text-yellow-800';

              return (
                <div key={exc.id} className={`flex items-center justify-between p-3 border rounded-lg ${priorityColor}`}>
                  <div>
                    <p className="font-medium text-zinc-900">{exc.code}</p>
                    <p className="text-xs text-zinc-600">{exc.employeeName}</p>
                  </div>
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${priorityBadge}`}>
                    {exc.priority.toUpperCase()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Notes Section */}
      <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Manager Notes</h2>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add notes for this day's operations..."
          className="w-full h-24 p-4 border border-zinc-300 rounded-xl text-zinc-700 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-700"
        />
      </div>
    </div>
  );
}
