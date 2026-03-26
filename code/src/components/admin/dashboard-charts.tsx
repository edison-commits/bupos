"use client";

import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import { LocalStoreData } from "@/lib/persistence/types";

interface DashboardChartsProps {
  store: LocalStoreData;
}

export function DashboardCharts({ store }: DashboardChartsProps) {
  // Prepare sales trend data (last 30 days)
  const salesTrendData = prepareSalesTrendData(store);
  
  // Prepare hourly sales data
  const hourlySalesData = prepareHourlySalesData(store);
  
  // Prepare tender type data
  const tenderTypeData = prepareTenderTypeData(store);
  
  // Prepare sales by employee data
  const employeeSalesData = prepareSalesByEmployeeData(store);

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* Sales Trend Line Chart */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h3 className="mb-4 text-sm font-semibold text-zinc-700">Sales Trend (30 Days)</h3>
        {salesTrendData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={salesTrendData}>
              <defs>
                <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0d9488" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey="date" stroke="#71717a" style={{ fontSize: "12px" }} />
              <YAxis stroke="#71717a" style={{ fontSize: "12px" }} tickFormatter={(value) => `$${value}`} />
              <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
              <Area type="monotone" dataKey="total" stroke="#0d9488" strokeWidth={2} fillOpacity={1} fill="url(#colorSales)" />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-zinc-600">No sales data available</p>
        )}
      </div>

      {/* Hourly Sales Bar Chart */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h3 className="mb-4 text-sm font-semibold text-zinc-700">Sales by Hour</h3>
        {hourlySalesData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={hourlySalesData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey="hour" stroke="#71717a" style={{ fontSize: "12px" }} />
              <YAxis stroke="#71717a" style={{ fontSize: "12px" }} tickFormatter={(value) => `$${value}`} />
              <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
              <Bar dataKey="total" fill="#0d9488" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-zinc-600">No hourly sales data available</p>
        )}
      </div>

      {/* Tender Type Pie Chart */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h3 className="mb-4 text-sm font-semibold text-zinc-700">Tender Mix</h3>
        {tenderTypeData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={tenderTypeData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#0d9488"
                dataKey="value"
              >
                {tenderTypeData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={getTenderColor(entry.name, index)} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-zinc-600">No tender data available</p>
        )}
      </div>

      {/* Sales by Employee Bar Chart */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h3 className="mb-4 text-sm font-semibold text-zinc-700">Top Employees by Sales</h3>
        {employeeSalesData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={employeeSalesData}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 150, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis type="number" stroke="#71717a" style={{ fontSize: "12px" }} tickFormatter={(value) => `$${value}`} />
              <YAxis dataKey="name" type="category" stroke="#71717a" style={{ fontSize: "11px" }} width={145} />
              <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}`} />
              <Bar dataKey="total" fill="#0d9488" radius={[0, 8, 8, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-zinc-600">No employee sales data available</p>
        )}
      </div>
    </div>
  );
}

// Helper functions

function prepareSalesTrendData(store: LocalStoreData) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const dailyTotals: Record<string, number> = {};

  store.transactionEventPlaceholders.forEach((event) => {
    if (
      event.eventKind === "transaction_placeholder" &&
      event.payload?.grand_total &&
      event.transactionId !== "txn_register_shift_placeholder"
    ) {
      const createdDate = new Date(event.createdAt);
      if (createdDate >= thirtyDaysAgo && createdDate <= now) {
        const dateStr = createdDate.toISOString().split("T")[0];
        const amount = Number(event.payload.grand_total);
        dailyTotals[dateStr] = (dailyTotals[dateStr] ?? 0) + amount;
      }
    }
  });

  // Create array with all days, filling gaps with 0
  const result = [];
  const current = new Date(thirtyDaysAgo);
  while (current <= now) {
    const dateStr = current.toISOString().split("T")[0];
    result.push({
      date: formatDate(current),
      total: dailyTotals[dateStr] ?? 0,
    });
    current.setDate(current.getDate() + 1);
  }

  return result;
}

function prepareHourlySalesData(store: LocalStoreData) {
  const hourlyTotals: Record<number, number> = {};

  store.transactionEventPlaceholders.forEach((event) => {
    if (
      event.eventKind === "transaction_placeholder" &&
      event.payload?.grand_total &&
      event.transactionId !== "txn_register_shift_placeholder"
    ) {
      const createdDate = new Date(event.createdAt);
      const hour = createdDate.getHours();
      const amount = Number(event.payload.grand_total);
      hourlyTotals[hour] = (hourlyTotals[hour] ?? 0) + amount;
    }
  });

  // Create array for all 24 hours
  const result = [];
  for (let hour = 0; hour < 24; hour++) {
    result.push({
      hour: formatHour(hour),
      total: hourlyTotals[hour] ?? 0,
    });
  }

  return result;
}

function prepareTenderTypeData(store: LocalStoreData) {
  const tenderTotals: Record<string, number> = {};

  store.transactionTenderPlaceholders.forEach((tender) => {
    const tenderType = tender.tenderType || "Other";
    tenderTotals[tenderType] = (tenderTotals[tenderType] ?? 0) + tender.amount;
  });

  return Object.entries(tenderTotals).map(([name, value]) => ({
    name,
    value,
  }));
}

function prepareSalesByEmployeeData(store: LocalStoreData) {
  const employeeSales: Record<string, number> = {};
  const employeeMap = new Map(store.employees.map((e) => [e.id, e.displayName]));

  store.transactionEventPlaceholders.forEach((event) => {
    if (
      event.eventKind === "transaction_placeholder" &&
      event.payload?.grand_total &&
      event.transactionId !== "txn_register_shift_placeholder"
    ) {
      const empId = event.actorEmployeeId;
      const amount = Number(event.payload.grand_total);
      employeeSales[empId] = (employeeSales[empId] ?? 0) + amount;
    }
  });

  return Object.entries(employeeSales)
    .map(([empId, total]) => ({
      id: empId,
      name: employeeMap.get(empId) || "Unknown",
      total,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
}

function getTenderColor(tenderType: string, index: number): string {
  const colors = [
    "#0d9488", // teal
    "#06b6d4", // cyan
    "#3b82f6", // blue
    "#8b5cf6", // purple
    "#ec4899", // pink
    "#f59e0b", // amber
    "#ef4444", // red
    "#10b981", // emerald
  ];

  const tenderMap: Record<string, string> = {
    cash: "#0d9488",
    card: "#3b82f6",
    check: "#8b5cf6",
    gift_card: "#ec4899",
    store_credit: "#f59e0b",
    other: "#71717a",
  };

  return tenderMap[tenderType.toLowerCase()] || colors[index % colors.length];
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day}`;
}

function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}
