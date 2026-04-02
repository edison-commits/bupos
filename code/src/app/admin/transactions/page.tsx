'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";

import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, Search, Download, Calendar, Filter } from 'lucide-react';

interface Transaction {
  id: string;
  status: 'completed' | 'voided' | 'refunded';
  subtotal: number;
  discount_total: number;
  tax_total: number;
  grand_total: number;
  item_count: number;
  created_at: string;
  employee_name: string;
  customer_name: string | null;
}

interface TransactionDetail extends Transaction {
  cart_snapshot: string;
}

interface CartItem {
  product_id: string;
  product_name: string;
  sku: string;
  quantity: number;
  unit_price: number;
  discount_percent?: number;
  discount_amount?: number;
  line_total: number;
}

interface Tender {
  tender_type: string;
  amount: number;
}

interface Event {
  event_kind: string;
  actor_name: string;
  notes: string | null;
  created_at: string;
}

interface ApiResponse {
  transactions: Transaction[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface DetailResponse {
  transaction: TransactionDetail;
  tenders: Tender[];
  events: Event[];
}

const STATUS_COLORS = {
  completed: { bg: 'bg-emerald-100', text: 'text-emerald-800', badge: 'bg-emerald-500' },
  voided: { bg: 'bg-red-100', text: 'text-red-800', badge: 'bg-red-500' },
  refunded: { bg: 'bg-amber-100', text: 'text-amber-800', badge: 'bg-amber-500' },
};

const DATE_RANGES = [
  { label: 'Today', value: 'today' },
  { label: 'This Week', value: 'week' },
  { label: 'This Month', value: 'month' },
  { label: 'All Time', value: 'all' },
];

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TransactionSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-16 bg-gray-200 rounded animate-pulse" />
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status as keyof typeof STATUS_COLORS] || STATUS_COLORS.completed;
  return (
    <span className={`inline-block px-2 py-1 rounded text-xs font-semibold text-white ${colors.badge}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function DetailPanel({ transaction, tenders, events, onClose }: {
  transaction: TransactionDetail;
  tenders: Tender[];
  events: Event[];
  onClose: () => void;
}) {
  let items: CartItem[] = [];
  try {
    items = JSON.parse(transaction.cart_snapshot);
  } catch (e) {
    console.error('Failed to parse cart_snapshot:', e);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex justify-between items-center">
          <h2 className="text-2xl font-bold text-gray-900">Transaction {transaction.id.substring(0, 8)}</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-2xl"
          >
            ×
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Header Info */}
          <div className="grid grid-cols-2 gap-4 pb-4 border-b border-gray-200">
            <div>
              <p className="text-sm text-gray-600">Date/Time</p>
              <p className="text-sm font-semibold text-gray-900">{formatDateTime(transaction.created_at)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Status</p>
              <div className="mt-1">
                <StatusBadge status={transaction.status} />
              </div>
            </div>
            <div>
              <p className="text-sm text-gray-600">Employee</p>
              <p className="text-sm font-semibold text-gray-900">{transaction.employee_name}</p>
            </div>
            {transaction.customer_name && (
              <div>
                <p className="text-sm text-gray-600">Customer</p>
                <p className="text-sm font-semibold text-gray-900">{transaction.customer_name}</p>
              </div>
            )}
          </div>

          {/* Items */}
          <div>
            <h3 className="font-semibold text-gray-900 mb-3">Items</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-gray-700">Product</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-700">Qty</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-700">Unit Price</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-700">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-gray-900">{item.product_name}</div>
                        <div className="text-xs text-gray-500">{item.sku}</div>
                      </td>
                      <td className="text-right px-3 py-2 text-gray-900">{item.quantity}</td>
                      <td className="text-right px-3 py-2 text-gray-900">{formatCurrency(item.unit_price)}</td>
                      <td className="text-right px-3 py-2 font-semibold text-gray-900">
                        {formatCurrency(item.line_total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Totals */}
          <div className="bg-gray-50 rounded-lg p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-700">Subtotal</span>
              <span className="text-gray-900 font-semibold">{formatCurrency(transaction.subtotal)}</span>
            </div>
            {transaction.discount_total > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-700">Discount</span>
                <span className="text-red-600 font-semibold">-{formatCurrency(transaction.discount_total)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-gray-700">Tax</span>
              <span className="text-gray-900 font-semibold">{formatCurrency(transaction.tax_total)}</span>
            </div>
            <div className="flex justify-between text-base font-bold border-t border-gray-200 pt-2">
              <span className="text-gray-900">Total</span>
              <span className="text-emerald-600">{formatCurrency(transaction.grand_total)}</span>
            </div>
          </div>

          {/* Tenders */}
          {tenders.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-900 mb-3">Payment Methods</h3>
              <div className="space-y-2">
                {tenders.map((tender, idx) => (
                  <div key={idx} className="flex justify-between items-center bg-gray-50 p-3 rounded">
                    <span className="text-gray-700">{tender.tender_type}</span>
                    <span className="font-semibold text-gray-900">{formatCurrency(tender.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Events Timeline */}
          {events.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-900 mb-3">Timeline</h3>
              <div className="space-y-3">
                {events.map((event, idx) => (
                  <div key={idx} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="w-2 h-2 bg-emerald-500 rounded-full mt-1" />
                      {idx < events.length - 1 && <div className="w-0.5 h-8 bg-gray-200 mt-1" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-semibold text-gray-900">{event.event_kind}</p>
                          <p className="text-xs text-gray-500">{event.actor_name}</p>
                        </div>
                        <span className="text-xs text-gray-500">{formatDateTime(event.created_at)}</span>
                      </div>
                      {event.notes && <p className="text-sm text-gray-700 mt-1">{event.notes}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateRange, setDateRange] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 1 });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ transaction: TransactionDetail; tenders: Tender[]; events: Event[] } | null>(null);

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.append('search', searchQuery);
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (dateRange !== 'all') params.append('from', dateRange);
      params.append('page', currentPage.toString());
      params.append('limit', '10');

      const response = await fetch(`/api/transactions?${params.toString()}`);
      const data: ApiResponse = await response.json();
      setTransactions(data.transactions);
      setPagination(data.pagination);
    } catch (error) {
      console.error('Failed to fetch transactions:', error);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, statusFilter, dateRange, currentPage]);

  const fetchDetail = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/transactions?id=${id}`);
      const data: DetailResponse = await response.json();
      setDetail(data);
    } catch (error) {
      console.error('Failed to fetch transaction detail:', error);
    }
  }, []);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const handleRowClick = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
    } else {
      setExpandedId(id);
      fetchDetail(id);
    }
  };

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setCurrentPage(1);
  };

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value);
    setCurrentPage(1);
  };

  const handleDateRangeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setDateRange(e.target.value);
    setCurrentPage(1);
  };

  return (
    <div className="min-h-screen bg-gray-50">
        <AdminTopNav />
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <h1 className="text-3xl font-bold text-gray-900">Transaction History</h1>
          <p className="text-gray-600 mt-1">View and manage all POS transactions</p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Search Bar */}
        <div className="mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-3 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Search by transaction ID or employee name..."
              value={searchQuery}
              onChange={handleSearch}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Filters Row */}
        <div className="mb-6 flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-600" />
            <select
              value={statusFilter}
              onChange={handleStatusChange}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
            >
              <option value="all">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="voided">Voided</option>
              <option value="refunded">Refunded</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-gray-600" />
            <select
              value={dateRange}
              onChange={handleDateRangeChange}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm"
            >
              {DATE_RANGES.map((range) => (
                <option key={range.value} value={range.value}>
                  {range.label}
                </option>
              ))}
            </select>
          </div>

          <a
            href="/api/export?type=transactions"
            className="ml-auto flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors text-sm font-semibold"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </a>
        </div>

        {/* Transactions Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {loading ? (
            <div className="p-6">
              <TransactionSkeleton />
            </div>
          ) : transactions.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-gray-500 text-lg">No transactions found</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">ID</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Date/Time</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Employee</th>
                      <th className="px-6 py-3 text-center text-xs font-semibold text-gray-700 uppercase tracking-wider">Items</th>
                      <th className="px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wider">Total</th>
                      <th className="px-6 py-3 text-center text-xs font-semibold text-gray-700 uppercase tracking-wider">Status</th>
                      <th className="px-6 py-3 text-center text-xs font-semibold text-gray-700 uppercase tracking-wider" />
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((transaction) => (
                      <React.Fragment key={transaction.id}>
                        <tr
                          onClick={() => handleRowClick(transaction.id)}
                          className="border-b border-gray-100 hover:bg-emerald-50 cursor-pointer transition-colors"
                        >
                          <td className="px-6 py-4">
                            <code className="text-sm font-mono text-gray-900">
                              {transaction.id.substring(0, 8)}
                            </code>
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900">
                            {formatDateTime(transaction.created_at)}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900">
                            {transaction.employee_name}
                          </td>
                          <td className="px-6 py-4 text-center">
                            <span className="inline-block px-2 py-1 bg-gray-100 text-gray-900 rounded text-sm font-semibold">
                              {transaction.item_count}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right font-semibold text-gray-900">
                            {formatCurrency(transaction.grand_total)}
                          </td>
                          <td className="px-6 py-4 text-center">
                            <StatusBadge status={transaction.status} />
                          </td>
                          <td className="px-6 py-4 text-center">
                            {expandedId === transaction.id ? (
                              <ChevronUp className="w-5 h-5 text-emerald-600 mx-auto" />
                            ) : (
                              <ChevronDown className="w-5 h-5 text-gray-400 mx-auto" />
                            )}
                          </td>
                        </tr>
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Pagination */}
        {!loading && transactions.length > 0 && (
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-gray-700">
              Showing <span className="font-semibold">{(currentPage - 1) * pagination.limit + 1}</span> to{' '}
              <span className="font-semibold">
                {Math.min(currentPage * pagination.limit, pagination.total)}
              </span>{' '}
              of <span className="font-semibold">{pagination.total}</span> transactions
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <div className="flex items-center gap-1">
                {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map((page) => (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={`px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
                      currentPage === page
                        ? 'bg-emerald-500 text-white'
                        : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {page}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setCurrentPage((p) => Math.min(pagination.totalPages, p + 1))}
                disabled={currentPage === pagination.totalPages}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Panel Modal */}
      {detail && expandedId && (
        <DetailPanel
          transaction={detail.transaction}
          tenders={detail.tenders}
          events={detail.events}
          onClose={() => {
            setExpandedId(null);
            setDetail(null);
          }}
        />
      )}
    </div>
  );
}
