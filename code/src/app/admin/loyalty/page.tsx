'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";

import { useState, useEffect } from 'react';
import { AlertCircle, Award, DollarSign, Loader2, Search, TrendingUp, Users, X } from 'lucide-react';
import { authFetch } from '@/lib/api/client';
import { FETCH_TIMEOUT_MS } from '@/lib/config/timing';
import { formatCurrency } from '@/lib/format';
interface LoyaltyOverview {
  total_customers_enrolled: number;
  active_loyalty_customers: number;
  total_points_outstanding: number;
  avg_points_per_customer: number;
  avg_spend_per_customer: number;
}

interface TopCustomer {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  loyalty_points: number;
  total_spend: string | number;
  visit_count: number;
  last_visit_at?: string;
}

interface RecentActivity {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  loyalty_points: number;
  last_transaction_date?: string;
  transaction_count_30d: number;
}

interface PointsDistribution {
  range: string;
  count: number;
}

interface DetailedCustomer {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  loyalty_points: number;
  total_spend: string | number;
  visit_count: number;
  store_credit_balance: string | number;
  last_visit_at?: string;
}

interface RecentTransaction {
  id: string;
  created_at: string;
  total_due: string | number;
  total_paid: string | number;
  status: string;
}

type ModalMode = 'adjust' | 'search' | null;

export default function LoyaltyDashboard() {
  const [overview, setOverview] = useState<LoyaltyOverview | null>(null);
  const [topCustomers, setTopCustomers] = useState<TopCustomer[]>([]);
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [pointsDistribution, setPointsDistribution] = useState<PointsDistribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [_selectedCustomerId, _setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomerDetails, setSelectedCustomerDetails] = useState<DetailedCustomer | null>(null);
  const [recentTransactions, setRecentTransactions] = useState<RecentTransaction[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  
  // Adjustment form
  const [adjustmentCustomerId, setAdjustmentCustomerId] = useState('');
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);
  const [adjustmentLoading, setAdjustmentLoading] = useState(false);
  
  // Search form
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  useEffect(() => {
    loadLoyaltyData();
  }, []);

  const loadLoyaltyData = async () => {
    setLoading(true);
    setError(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let data;
      try {
        const response = await authFetch('/api/loyalty', { cache: 'no-store', signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: Failed to load loyalty data`);
        }
        data = await response.json();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('Request timed out — please try again');
        }
        throw err;
      }
      setOverview(data.overview);
      setTopCustomers(data.top_customers);
      setRecentActivity(data.recent_activity);
      setPointsDistribution(data.points_distribution);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load loyalty data');
    } finally {
      setLoading(false);
    }
  };

  const openAdjustModal = () => {
    setModalMode('adjust');
    setAdjustmentError(null);
    setAdjustmentCustomerId('');
    setAdjustmentAmount('');
    setAdjustmentReason('');
  };

  const handleAdjustment = async () => {
    if (adjustmentLoading) return;
    setAdjustmentError(null);
    
    if (!adjustmentCustomerId || !adjustmentAmount || !adjustmentReason) {
      setAdjustmentError('All fields are required');
      return;
    }

    const amount = parseInt(adjustmentAmount);
    if (isNaN(amount)) {
      setAdjustmentError('Amount must be a valid integer');
      return;
    }

    setAdjustmentLoading(true);
    try {
      const response = await authFetch('/api/loyalty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: adjustmentCustomerId,
          adjustment: amount,
          reason: adjustmentReason,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to adjust points');
      }

      setModalMode(null);
      loadLoyaltyData();
    } catch (err) {
      setAdjustmentError(err instanceof Error ? err.message : 'Failed to adjust points');
    } finally {
      setAdjustmentLoading(false);
    }
  };

  const handleSearch = async () => {
    setSearchError(null);
    
    if (!searchQuery.trim()) {
      setSearchError('Please enter a customer ID or name');
      return;
    }

    setSearchLoading(true);
    try {
      // Search through topCustomers and recentActivity
      const allCustomers = [...topCustomers, ...recentActivity];
      const searchLower = searchQuery.toLowerCase();
      
      const matchedCustomer = allCustomers.find(c =>
        c.id === searchQuery ||
        `${c.first_name} ${c.last_name}`.toLowerCase().includes(searchLower) ||
        c.email?.toLowerCase().includes(searchLower)
      );

      if (!matchedCustomer) {
        setSearchError('Customer not found');
        setSearchLoading(false);
        return;
      }

      // Load detailed customer info
      await loadCustomerDetails(matchedCustomer.id);
      setModalMode('search');
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearchLoading(false);
    }
  };

  const loadCustomerDetails = async (customerId: string) => {
    setDetailLoading(true);
    try {
      const response = await authFetch(`/api/loyalty?customer_id=${customerId}`);
      if (!response.ok) {
        throw new Error('Failed to load customer details');
      }
      const data = await response.json();
      setSelectedCustomerDetails(data.customer);
      setRecentTransactions(data.recentTransactions);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Failed to load customer details');
    } finally {
      setDetailLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  const maxDistribution = Math.max(...pointsDistribution.map(d => d.count), 1);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
        <AdminTopNav />
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">Loyalty Program Dashboard</h1>
          <p className="text-slate-600">Manage customer loyalty points and program metrics</p>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="text-red-600 mt-0.5" size={20} />
              <p className="text-red-800">{error}</p>
            </div>
          </div>
        )}

        {/* Summary Cards */}
        {overview && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Total Enrolled</p>
                  <p className="text-3xl font-bold text-slate-900 mt-2">{overview.total_customers_enrolled}</p>
                  <p className="text-xs text-slate-500 mt-2">{overview.active_loyalty_customers} active</p>
                </div>
                <Users className="text-emerald-600" size={24} />
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Points Outstanding</p>
                  <p className="text-3xl font-bold text-slate-900 mt-2">{Number(overview.total_points_outstanding).toLocaleString()}</p>
                  <p className="text-xs text-slate-500 mt-2">{Number(overview.avg_points_per_customer).toFixed(0)} avg/customer</p>
                </div>
                <Award className="text-emerald-600" size={24} />
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Avg Spend</p>
                  <p className="text-3xl font-bold text-slate-900 mt-2">{formatCurrency(overview.avg_spend_per_customer)}</p>
                  <p className="text-xs text-slate-500 mt-2">per enrolled customer</p>
                </div>
                <DollarSign className="text-emerald-600" size={24} />
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Quick Actions</p>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={openAdjustModal}
                      className="px-3 py-1 text-xs font-medium rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                    >
                      Adjust Points
                    </button>
                  </div>
                </div>
                <TrendingUp className="text-emerald-600" size={24} />
              </div>
            </div>
          </div>
        )}

        {/* Search Bar */}
        <div className="mb-8 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <label className="block text-sm font-medium text-slate-700 mb-3">Search Customer</label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Enter customer name, email, or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <button
              onClick={handleSearch}
              disabled={searchLoading}
              className="px-4 py-2 rounded bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {searchLoading ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
            </button>
          </div>
          {searchError && <p className="text-red-600 text-xs mt-2">{searchError}</p>}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Top Customers Table */}
            {topCustomers.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="border-b border-slate-200 px-6 py-4">
                  <h2 className="text-lg font-semibold text-slate-900">Top Customers by Points</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 text-left font-semibold text-slate-700">Name</th>
                        <th className="px-6 py-3 text-left font-semibold text-slate-700">Email</th>
                        <th className="px-6 py-3 text-right font-semibold text-slate-700">Points</th>
                        <th className="px-6 py-3 text-right font-semibold text-slate-700">Spend</th>
                        <th className="px-6 py-3 text-right font-semibold text-slate-700">Visits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topCustomers.map((customer) => (
                        <tr
                          key={customer.id}
                          className="border-b border-slate-200 hover:bg-slate-50 cursor-pointer"
                          onClick={() => {
                            loadCustomerDetails(customer.id);
                            setModalMode('search');
                          }}
                        >
                          <td className="px-6 py-4 font-medium text-slate-900">
                            {customer.first_name} {customer.last_name}
                          </td>
                          <td className="px-6 py-4 text-slate-600">{customer.email || '-'}</td>
                          <td className="px-6 py-4 text-right text-emerald-600 font-semibold">
                            {Number(customer.loyalty_points).toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-right text-slate-900">{formatCurrency(customer.total_spend)}</td>
                          <td className="px-6 py-4 text-right text-slate-600">{customer.visit_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="border-b border-slate-200 px-6 py-4">
                  <h2 className="text-lg font-semibold text-slate-900">Recent Activity (30 days)</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 text-left font-semibold text-slate-700">Name</th>
                        <th className="px-6 py-3 text-left font-semibold text-slate-700">Email</th>
                        <th className="px-6 py-3 text-right font-semibold text-slate-700">Points</th>
                        <th className="px-6 py-3 text-right font-semibold text-slate-700">Trans. (30d)</th>
                        <th className="px-6 py-3 text-left font-semibold text-slate-700">Last Visit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentActivity.map((activity) => (
                        <tr
                          key={activity.id}
                          className="border-b border-slate-200 hover:bg-slate-50 cursor-pointer"
                          onClick={() => {
                            loadCustomerDetails(activity.id);
                            setModalMode('search');
                          }}
                        >
                          <td className="px-6 py-4 font-medium text-slate-900">
                            {activity.first_name} {activity.last_name}
                          </td>
                          <td className="px-6 py-4 text-slate-600">{activity.email || '-'}</td>
                          <td className="px-6 py-4 text-right text-emerald-600 font-semibold">
                            {Number(activity.loyalty_points).toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-right text-slate-600">{activity.transaction_count_30d}</td>
                          <td className="px-6 py-4 text-slate-600">
                            {activity.last_transaction_date ? formatDate(activity.last_transaction_date) : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Points Distribution */}
            {pointsDistribution.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-slate-900 mb-6">Points Distribution</h2>
                <div className="space-y-4">
                  {pointsDistribution.map((item) => (
                    <div key={item.range}>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium text-slate-700">{item.range}</span>
                        <span className="text-sm font-semibold text-slate-900">{item.count}</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                          style={{
                            width: `${maxDistribution > 0 ? (item.count / maxDistribution) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Adjustment Modal */}
      {modalMode === 'adjust' && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 sticky top-0 bg-white">
              <h2 className="text-lg font-semibold text-slate-900">Adjust Loyalty Points</h2>
              <button
                onClick={() => setModalMode(null)}
                className="p-1 rounded hover:bg-slate-100"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {adjustmentError && (
                <div className="rounded border border-red-200 bg-red-50 p-3">
                  <p className="text-sm text-red-800">{adjustmentError}</p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Customer ID
                </label>
                <input
                  type="text"
                  value={adjustmentCustomerId}
                  onChange={(e) => setAdjustmentCustomerId(e.target.value)}
                  placeholder="Enter customer ID"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Adjustment Amount
                </label>
                <input
                  type="number"
                  value={adjustmentAmount}
                  onChange={(e) => setAdjustmentAmount(e.target.value)}
                  placeholder="e.g., 100 or -50"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
                <p className="text-xs text-slate-500 mt-1">Positive to add, negative to subtract</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Reason
                </label>
                <input
                  type="text"
                  value={adjustmentReason}
                  onChange={(e) => setAdjustmentReason(e.target.value)}
                  placeholder="e.g., Referral bonus, Manual correction"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setModalMode(null)}
                  className="flex-1 rounded border-2 border-slate-300 px-5 py-4 text-lg font-bold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdjustment}
                  disabled={adjustmentLoading}
                  className="flex-1 rounded bg-emerald-600 px-5 py-4 text-lg font-bold text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {adjustmentLoading && <Loader2 className="animate-spin" size={16} />}
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Customer Detail Modal */}
      {modalMode === 'search' && selectedCustomerDetails && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 sticky top-0 bg-white">
              <h2 className="text-lg font-semibold text-slate-900">Customer Details</h2>
              <button
                onClick={() => setModalMode(null)}
                className="p-1 rounded hover:bg-slate-100"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {detailLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="animate-spin" size={24} />
                </div>
              ) : (
                <>
                  <div>
                    <p className="text-xs text-slate-600 uppercase">Name</p>
                    <p className="text-lg font-semibold text-slate-900">
                      {selectedCustomerDetails.first_name} {selectedCustomerDetails.last_name}
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-200 space-y-3">
                    {selectedCustomerDetails.email && (
                      <div>
                        <p className="text-xs text-slate-600 uppercase">Email</p>
                        <p className="text-sm text-slate-900">{selectedCustomerDetails.email}</p>
                      </div>
                    )}
                    {selectedCustomerDetails.phone && (
                      <div>
                        <p className="text-xs text-slate-600 uppercase">Phone</p>
                        <p className="text-sm text-slate-900">{selectedCustomerDetails.phone}</p>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200">
                    <div>
                      <p className="text-xs text-slate-600 uppercase">Loyalty Points</p>
                      <p className="text-2xl font-bold text-emerald-600">
                        {Number(selectedCustomerDetails.loyalty_points).toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-600 uppercase">Total Spend</p>
                      <p className="text-2xl font-bold text-slate-900">
                        {formatCurrency(selectedCustomerDetails.total_spend)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-600 uppercase">Visits</p>
                      <p className="text-2xl font-bold text-slate-900">
                        {selectedCustomerDetails.visit_count}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-600 uppercase">Store Credit</p>
                      <p className="text-2xl font-bold text-slate-900">
                        {formatCurrency(selectedCustomerDetails.store_credit_balance)}
                      </p>
                    </div>
                  </div>

                  {recentTransactions.length > 0 && (
                    <div className="pt-4 border-t border-slate-200">
                      <p className="text-sm font-semibold text-slate-900 mb-3">Recent Transactions</p>
                      <div className="space-y-2 max-h-40 overflow-y-auto">
                        {recentTransactions.slice(0, 5).map((tx) => (
                          <div
                            key={tx.id}
                            className="flex justify-between items-center p-2 bg-slate-50 rounded text-xs"
                          >
                            <div>
                              <p className="text-slate-900 font-medium">{formatDate(tx.created_at)}</p>
                              <p className="text-slate-600">{tx.status}</p>
                            </div>
                            <p className="font-semibold text-slate-900">{formatCurrency(tx.total_due)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
