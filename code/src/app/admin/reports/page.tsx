import { AdminTopNav } from "@/components/layout/admin-top-nav";
"use client";

import { useState, useEffect } from "react";

type DateRange = "today" | "week" | "month" | "custom";
type ReportType = "summary" | "category" | "employee" | "hourly" | "tender" | "products" | "shifts";

interface ReportData {
  type: ReportType;
  data: any;
  loading: boolean;
  error: string | null;
}

export default function ReportsPage() {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [activeReport, setActiveReport] = useState<ReportType>("summary");
  const [reports, setReports] = useState<Record<ReportType, ReportData>>({
    summary: { type: "summary", data: null, loading: false, error: null },
    category: { type: "category", data: null, loading: false, error: null },
    employee: { type: "employee", data: null, loading: false, error: null },
    hourly: { type: "hourly", data: null, loading: false, error: null },
    tender: { type: "tender", data: null, loading: false, error: null },
    products: { type: "products", data: null, loading: false, error: null },
    shifts: { type: "shifts", data: null, loading: false, error: null },
  });

  const getDateRange = () => {
    const now = new Date();
    let from: Date, to: Date = now;

    if (dateRange === "today") {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (dateRange === "week") {
      const dayOfWeek = now.getDay();
      from = new Date(now);
      from.setDate(now.getDate() - dayOfWeek);
    } else if (dateRange === "month") {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      from = customFrom ? new Date(customFrom) : now;
      to = customTo ? new Date(customTo) : now;
    }

    return {
      from: from.toISOString().split("T")[0],
      to: to.toISOString().split("T")[0],
    };
  };

  const fetchReport = async (type: ReportType) => {
    const { from, to } = getDateRange();
    setReports((prev) => ({
      ...prev,
      [type]: { ...prev[type], loading: true, error: null },
    }));

    try {
      const response = await fetch(`/api/reports?type=${type}&from=${from}&to=${to}`);
      if (!response.ok) throw new Error(`Failed to fetch ${type} report`);

      const data = await response.json();
      setReports((prev) => ({
        ...prev,
        [type]: { ...prev[type], data, loading: false },
      }));
    } catch (error) {
      setReports((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          loading: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      }));
    }
  };

  useEffect(() => {
    fetchReport(activeReport);
  }, [activeReport, dateRange, customFrom, customTo]);

  const currentReport = reports[activeReport];
  const { from, to } = getDateRange();

  const handleExportCSV = () => {
    if (!currentReport.data) return;

    const csv = reportToCSV(activeReport, currentReport.data);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeReport}-report-${from}-to-${to}.csv`;
    a.click();
  };

  return (
    <div className="grid gap-6 p-6">
        <AdminTopNav />
      <div className="max-w-7xl mx-auto p-6"><h1 className="text-3xl font-bold text-gray-900 mb-2">Reports & Analytics</h1><p className="text-gray-500 mb-6">Comprehensive sales, inventory, and operational insights.</p>
        <div className="space-y-6">
          {/* Date Range Picker */}
          <div className="rounded-2xl bg-zinc-50 p-4">
            <p className="text-sm font-medium text-zinc-700 mb-3">Date Range</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {(["today", "week", "month", "custom"] as DateRange[]).map((range) => (
                <button
                  key={range}
                  onClick={() => setDateRange(range)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                    dateRange === range
                      ? "bg-teal-600 text-white"
                      : "bg-white border border-zinc-300 text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  {range === "today"
                    ? "Today"
                    : range === "week"
                      ? "This Week"
                      : range === "month"
                        ? "This Month"
                        : "Custom"}
                </button>
              ))}
            </div>

            {dateRange === "custom" && (
              <div className="flex gap-3">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="flex-1 px-3 py-2 border border-zinc-300 rounded-lg text-sm"
                />
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="flex-1 px-3 py-2 border border-zinc-300 rounded-lg text-sm"
                />
              </div>
            )}
          </div>

          {/* Report Type Tabs */}
          <div className="border-b border-zinc-200">
            <div className="flex gap-1 overflow-x-auto">
              {(["summary", "category", "employee", "hourly", "tender", "products", "shifts"] as ReportType[]).map(
                (type) => (
                  <button
                    key={type}
                    onClick={() => setActiveReport(type)}
                    className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition border-b-2 ${
                      activeReport === type
                        ? "border-teal-600 text-teal-600"
                        : "border-transparent text-zinc-600 hover:text-zinc-900"
                    }`}
                  >
                    {type === "summary"
                      ? "Sales Summary"
                      : type === "category"
                        ? "By Category"
                        : type === "employee"
                          ? "By Employee"
                          : type === "hourly"
                            ? "By Hour"
                            : type === "tender"
                              ? "Tender Analysis"
                              : type === "products"
                                ? "Top Products"
                                : "Shifts"}
                  </button>
                )
              )}
            </div>
          </div>

          {/* Report Content */}
          <div className="min-h-96">
            {currentReport.loading ? (
              <div className="flex items-center justify-center h-96">
                <div className="text-center">
                  <div className="inline-block w-8 h-8 border-4 border-teal-200 border-t-teal-600 rounded-full animate-spin"></div>
                  <p className="mt-3 text-zinc-600">Loading report...</p>
                </div>
              </div>
            ) : currentReport.error ? (
              <div className="rounded-2xl bg-red-50 p-4 text-sm text-red-700">{currentReport.error}</div>
            ) : (
              <>
                {activeReport === "summary" && <SalesSummaryReport data={currentReport.data} />}
                {activeReport === "category" && <CategoryReport data={currentReport.data} />}
                {activeReport === "employee" && <EmployeeReport data={currentReport.data} />}
                {activeReport === "hourly" && <HourlyReport data={currentReport.data} />}
                {activeReport === "tender" && <TenderReport data={currentReport.data} />}
                {activeReport === "products" && <ProductsReport data={currentReport.data} />}
                {activeReport === "shifts" && <ShiftsReport data={currentReport.data} />}
              </>
            )}
          </div>

          {/* Export Button */}
          {!currentReport.loading && currentReport.data && (
            <button
              onClick={handleExportCSV}
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition"
            >
              Export as CSV
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SalesSummaryReport({ data }: { data: any }) {
  if (!data) return null;

  const { current, previous } = data;
  const revenueDelta = previous.revenue ? ((current.revenue - previous.revenue) / previous.revenue) * 100 : 0;
  const ticketDelta = previous.avgTicket ? ((current.avgTicket - previous.avgTicket) / previous.avgTicket) * 100 : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MetricCard label="Revenue" value={`$${current.revenue.toFixed(2)}`} delta={revenueDelta} />
      <MetricCard label="Transactions" value={String(current.transactionCount)} />
      <MetricCard label="Avg Ticket" value={`$${current.avgTicket.toFixed(2)}`} delta={ticketDelta} />
      <MetricCard label="Items Sold" value={String(current.itemCount)} />
      <MetricCard label="Tax Collected" value={`$${current.taxTotal.toFixed(2)}`} />
      <MetricCard label="Discounts" value={`$${current.discountTotal.toFixed(2)}`} />
      <MetricCard label="Refunds" value={String(current.refundCount)} />
      <MetricCard label="Returns Total" value={`$${current.returnTotal.toFixed(2)}`} />
    </div>
  );
}

function CategoryReport({ data }: { data: any }) {
  if (!data?.categories) return null;

  const maxRevenue = Math.max(...data.categories.map((c: any) => c.revenue));

  return (
    <div className="space-y-6">
      <div className="grid gap-4">
        {data.categories.map((cat: any, idx: number) => (
          <div key={idx} className="rounded-lg border border-zinc-200 p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-zinc-900">{cat.name}</h3>
              <span className="text-sm font-medium text-teal-600">{((cat.revenue / data.totalRevenue) * 100).toFixed(1)}%</span>
            </div>
            <div className="h-2 bg-zinc-100 rounded-full overflow-hidden mb-3">
              <div className="h-full bg-teal-500 rounded-full" style={{ width: `${(cat.revenue / maxRevenue) * 100}%` }}></div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <p className="text-zinc-500">Revenue</p>
                <p className="font-semibold">${cat.revenue.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-zinc-500">Items</p>
                <p className="font-semibold">{cat.itemCount}</p>
              </div>
              <div>
                <p className="text-zinc-500">Transactions</p>
                <p className="font-semibold">{cat.transactionCount}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmployeeReport({ data }: { data: any }) {
  if (!data?.employees) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50">
            <th className="px-4 py-3 text-left font-semibold text-zinc-900">Employee</th>
            <th className="px-4 py-3 text-right font-semibold text-zinc-900">Transactions</th>
            <th className="px-4 py-3 text-right font-semibold text-zinc-900">Sales</th>
            <th className="px-4 py-3 text-right font-semibold text-zinc-900">Avg Ticket</th>
            <th className="px-4 py-3 text-right font-semibold text-zinc-900">Refunds</th>
          </tr>
        </thead>
        <tbody>
          {data.employees.map((emp: any, idx: number) => (
            <tr key={idx} className="border-b border-zinc-100 hover:bg-zinc-50">
              <td className="px-4 py-3 font-medium text-zinc-900">{emp.name}</td>
              <td className="px-4 py-3 text-right text-zinc-600">{emp.transactionCount}</td>
              <td className="px-4 py-3 text-right font-semibold text-teal-600">${emp.totalSales.toFixed(2)}</td>
              <td className="px-4 py-3 text-right text-zinc-600">${emp.avgTicket.toFixed(2)}</td>
              <td className="px-4 py-3 text-right text-red-600">{emp.refundCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HourlyReport({ data }: { data: any }) {
  if (!data?.hours) return null;

  const maxRevenue = Math.max(...data.hours.map((h: any) => h.revenue));

  return (
    <div className="space-y-3">
      {data.hours.map((hour: any, idx: number) => (
        <div key={idx} className="flex items-center gap-3">
          <div className="w-16 text-sm font-medium text-zinc-700">{hour.hour}:00</div>
          <div className="flex-1">
            <div className="h-6 bg-zinc-100 rounded flex items-center overflow-hidden">
              <div className="h-full bg-emerald-500 rounded" style={{ width: `${(hour.revenue / maxRevenue) * 100}%` }}></div>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-zinc-900">${hour.revenue.toFixed(2)}</p>
            <p className="text-xs text-zinc-500">{hour.transactionCount} txns</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function TenderReport({ data }: { data: any }) {
  if (!data?.tenders) return null;

  const total = data.tenders.reduce((sum: number, t: any) => sum + t.amount, 0);

  return (
    <div className="space-y-4">
      {data.tenders.map((tender: any, idx: number) => (
        <div key={idx} className="rounded-lg border border-zinc-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-zinc-900">{tender.type}</h3>
            <span className="text-sm font-medium text-teal-600">{((tender.amount / total) * 100).toFixed(1)}%</span>
          </div>
          <div className="h-3 bg-zinc-100 rounded-full overflow-hidden mb-3">
            <div className="h-full rounded-full" style={{ width: `${(tender.amount / total) * 100}%`, backgroundColor: getTenderColor(tender.type) }}></div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <p className="text-zinc-500">Amount</p>
              <p className="font-semibold">${tender.amount.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-zinc-500">Count</p>
              <p className="font-semibold">{tender.count}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProductsReport({ data }: { data: any }) {
  if (!data?.byRevenue) return null;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-zinc-700 mb-3">Top Products by Revenue</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="px-4 py-3 text-left font-semibold text-zinc-900">Product</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">Revenue</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">Qty</th>
              </tr>
            </thead>
            <tbody>
              {data.byRevenue.map((prod: any, idx: number) => (
                <tr key={idx} className="border-b border-zinc-100 hover:bg-zinc-50">
                  <td className="px-4 py-3 font-medium text-zinc-900">{prod.name}</td>
                  <td className="px-4 py-3 text-right font-semibold text-teal-600">${prod.revenue.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right text-zinc-600">{prod.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-zinc-700 mb-3">Top Products by Quantity</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="px-4 py-3 text-left font-semibold text-zinc-900">Product</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">Qty Sold</th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-900">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.byQuantity.map((prod: any, idx: number) => (
                <tr key={idx} className="border-b border-zinc-100 hover:bg-zinc-50">
                  <td className="px-4 py-3 font-medium text-zinc-900">{prod.name}</td>
                  <td className="px-4 py-3 text-right font-semibold text-emerald-600">{prod.quantity}</td>
                  <td className="px-4 py-3 text-right text-zinc-600">${prod.revenue.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ShiftsReport({ data }: { data: any }) {
  if (!data?.shifts) return null;

  return (
    <div className="space-y-3">
      {data.shifts.map((shift: any, idx: number) => (
        <div key={idx} className="rounded-lg border border-zinc-200 p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <h3 className="font-semibold text-zinc-900">{shift.employee}</h3>
              <p className="text-sm text-zinc-500">{shift.date}</p>
            </div>
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${shift.status === "closed" ? "bg-emerald-100 text-emerald-800" : "bg-blue-100 text-blue-800"}`}>
              {shift.status}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <div>
              <p className="text-zinc-500">Opening Float</p>
              <p className="font-semibold">${shift.openingFloat.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-zinc-500">Sales</p>
              <p className="font-semibold">${shift.sales.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-zinc-500">Expected Cash</p>
              <p className="font-semibold">${shift.closingExpectedCash.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-zinc-500">Declared</p>
              <p className="font-semibold">${shift.closingDeclaredCash.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-zinc-500">Variance</p>
              <p className={`font-semibold ${shift.variance >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                {shift.variance >= 0 ? "+" : ""} ${shift.variance.toFixed(2)}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MetricCard({ label, value, delta }: { label: string; value: string; delta?: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4">
      <p className="text-xs text-zinc-500 font-medium uppercase">{label}</p>
      <p className="text-2xl font-bold text-zinc-900 mt-1">{value}</p>
      {delta !== undefined && (
        <p className={`text-xs mt-1 font-medium ${delta >= 0 ? "text-emerald-600" : "text-red-600"}`}>
          {delta >= 0 ? "+" : ""} {delta.toFixed(1)}%
        </p>
      )}
    </div>
  );
}

function getTenderColor(type: string): string {
  const colors: Record<string, string> = {
    cash: "#10b981",
    card: "#3b82f6",
    check: "#f59e0b",
    gift_card: "#8b5cf6",
    store_credit: "#ec4899",
  };
  return colors[type] || "#6b7280";
}

function reportToCSV(type: ReportType, data: any): string {
  let csv = "";

  if (type === "summary") {
    csv = "Metric,Value\n";
    csv += `Revenue,$${data.current.revenue.toFixed(2)}\n`;
    csv += `Transactions,${data.current.transactionCount}\n`;
    csv += `Avg Ticket,$${data.current.avgTicket.toFixed(2)}\n`;
    csv += `Items Sold,${data.current.itemCount}\n`;
    csv += `Tax,$${data.current.taxTotal.toFixed(2)}\n`;
    csv += `Discounts,$${data.current.discountTotal.toFixed(2)}\n`;
    csv += `Refunds,${data.current.refundCount}\n`;
    csv += `Returns Total,$${data.current.returnTotal.toFixed(2)}\n`;
  } else if (type === "category") {
    csv = "Category,Revenue,Items,Transactions,% of Total\n";
    data.categories.forEach((cat: any) => {
      csv += `"${cat.name}","${cat.revenue.toFixed(2)}","${cat.itemCount}","${cat.transactionCount}","${((cat.revenue / data.totalRevenue) * 100).toFixed(1)}%"\n`;
    });
  } else if (type === "employee") {
    csv = "Employee,Transactions,Sales,Avg Ticket,Refunds\n";
    data.employees.forEach((emp: any) => {
      csv += `"${emp.name}","${emp.transactionCount}","${emp.totalSales.toFixed(2)}","${emp.avgTicket.toFixed(2)}","${emp.refundCount}"\n`;
    });
  } else if (type === "hourly") {
    csv = "Hour,Revenue,Transactions\n";
    data.hours.forEach((hour: any) => {
      csv += `"${hour.hour}:00","${hour.revenue.toFixed(2)}","${hour.transactionCount}"\n`;
    });
  } else if (type === "tender") {
    csv = "Tender Type,Amount,Count,% of Total\n";
    const total = data.tenders.reduce((sum: number, t: any) => sum + t.amount, 0);
    data.tenders.forEach((tender: any) => {
      csv += `"${tender.type}","${tender.amount.toFixed(2)}","${tender.count}","${((tender.amount / total) * 100).toFixed(1)}%"\n`;
    });
  } else if (type === "products") {
    csv = "Product,Revenue,Quantity\n";
    data.byRevenue.forEach((prod: any) => {
      csv += `"${prod.name}","${prod.revenue.toFixed(2)}","${prod.quantity}"\n`;
    });
  } else if (type === "shifts") {
    csv = "Employee,Date,Status,Opening Float,Sales,Expected Cash,Declared Cash,Variance\n";
    data.shifts.forEach((shift: any) => {
      csv += `"${shift.employee}","${shift.date}","${shift.status}","${shift.openingFloat.toFixed(2)}","${shift.sales.toFixed(2)}","${shift.closingExpectedCash.toFixed(2)}","${shift.closingDeclaredCash.toFixed(2)}","${shift.variance.toFixed(2)}"\n`;
    });
  }

  return csv;
}
