'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Search, Calendar, ChevronDown, ChevronUp, Plus, X, AlertCircle, CheckCircle, Loader } from 'lucide-react';

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

interface Transaction {
  id: string;
  status: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  grand_total: number;
  created_at: string;
  employee_name: string;
  customer_name: string | null;
  cart_snapshot?: string;
}

interface ReturnItem {
  product_id: string;
  product_name: string;
  sku: string;
  original_quantity: number;
  unit_price: number;
  return_quantity: number;
  line_total: number;
}

interface SearchResult {
  transaction: Transaction;
  tenders: Tender[];
  items: CartItem[];
}

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

export default function ReturnsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDateRange, setSearchDateRange] = useState('all');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [selectedItems, setSelectedItems] = useState<ReturnItem[]>([]);
  const [refundMethod, setRefundMethod] = useState('original_tender');
  const [returnReason, setReturnReason] = useState('damaged');
  const [notes, setNotes] = useState('');
  const [processing, setProcessing] = useState(false);
  const [confirmation, setConfirmation] = useState<{ success: boolean; message: string } | null>(null);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      alert('Please enter a transaction ID to search');
      return;
    }

    setSearching(true);
    try {
      const params = new URLSearchParams();
      params.append('search', searchQuery);
      if (searchDateRange !== 'all') {
        params.append('dateRange', searchDateRange);
      }

      const response = await fetch(`/api/returns/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to search transaction');
      }

      const data: SearchResult = await response.json();
      setSearchResults(data);
      setSelectedItems([]);
    } catch (error) {
      console.error('Search failed:', error);
      alert('Failed to search transaction. Please check the ID and try again.');
    } finally {
      setSearching(false);
    }
  }, [searchQuery, searchDateRange]);

  const handleItemToggle = (item: CartItem, checked: boolean) => {
    if (checked) {
      const returnItem: ReturnItem = {
        product_id: item.product_id,
        product_name: item.product_name,
        sku: item.sku,
        original_quantity: item.quantity,
        unit_price: item.unit_price,
        return_quantity: 1,
        line_total: item.unit_price,
      };
      setSelectedItems([...selectedItems, returnItem]);
    } else {
      setSelectedItems(selectedItems.filter((i) => i.product_id !== item.product_id));
    }
  };

  const handleQuantityChange = (productId: string, quantity: number) => {
    setSelectedItems(
      selectedItems.map((item) =>
        item.product_id === productId
          ? {
              ...item,
              return_quantity: Math.max(1, Math.min(item.original_quantity, quantity)),
              line_total: item.unit_price * Math.max(1, Math.min(item.original_quantity, quantity)),
            }
          : item
      )
    );
  };

  const handleRemoveItem = (productId: string) => {
    setSelectedItems(selectedItems.filter((item) => item.product_id !== productId));
  };

  const calculateRefundAmount = () => {
    return selectedItems.reduce((sum, item) => sum + item.line_total, 0);
  };

  const handleProcessReturn = async () => {
    if (!searchResults || selectedItems.length === 0) {
      alert('Please select at least one item to return');
      return;
    }

    setProcessing(true);
    try {
      const response = await fetch('/api/returns/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: searchResults.transaction.id,
          customer_name: searchResults.transaction.customer_name,
          reason: returnReason,
          notes,
          refund_method: refundMethod,
          items: selectedItems.map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            sku: item.sku,
            quantity: item.return_quantity,
            unit_price: item.unit_price,
          })),
          refund_amount: calculateRefundAmount(),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to process return');
      }

      const result = await response.json();
      setConfirmation({
        success: true,
        message: `Return processed successfully! Return #${result.return_number}`,
      });

      // Reset form
      setTimeout(() => {
        setSearchResults(null);
        setSelectedItems([]);
        setSearchQuery('');
        setNotes('');
        setConfirmation(null);
      }, 3000);
    } catch (error) {
      console.error('Processing failed:', error);
      setConfirmation({
        success: false,
        message: error instanceof Error ? error.message : 'Failed to process return',
      });
    } finally {
      setProcessing(false);
    }
  };

  const refundAmount = calculateRefundAmount();
  const itemsInCart = searchResults?.items || [];
  const remainingItems = itemsInCart.filter(
    (item) => !selectedItems.some((s) => s.product_id === item.product_id)
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <h1 className="text-3xl font-bold text-gray-900">Returns & Exchanges</h1>
          <p className="text-gray-600 mt-1">Process returns and exchanges from completed sales</p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Search Section */}
        {!searchResults && (
          <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Find Original Transaction</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Transaction ID
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-3 text-gray-400 w-5 h-5" />
                  <input
                    type="text"
                    placeholder="Enter transaction ID..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                    disabled={searching}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Calendar className="inline w-4 h-4 mr-2" />
                  Date Range (Optional)
                </label>
                <select
                  value={searchDateRange}
                  onChange={(e) => setSearchDateRange(e.target.value)}
                  disabled={searching}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                >
                  <option value="all">All Time</option>
                  <option value="today">Today</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                </select>
              </div>

              <button
                onClick={handleSearch}
                disabled={searching}
                className="w-full flex items-center justify-center gap-2 bg-teal-500 text-white font-semibold py-2 px-4 rounded-lg hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {searching ? (
                  <>
                    <Loader className="w-5 h-5 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <Search className="w-5 h-5" />
                    Search Transaction
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Confirmation Message */}
        {confirmation && (
          <div
            className={`mb-6 p-4 rounded-lg flex items-start gap-3 ${
              confirmation.success
                ? 'bg-emerald-50 border border-emerald-200'
                : 'bg-red-50 border border-red-200'
            }`}
          >
            {confirmation.success ? (
              <CheckCircle className="w-6 h-6 text-emerald-600 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
            )}
            <div>
              <p
                className={`font-semibold ${
                  confirmation.success ? 'text-emerald-800' : 'text-red-800'
                }`}
              >
                {confirmation.message}
              </p>
            </div>
          </div>
        )}

        {/* Transaction Details */}
        {searchResults && (
          <div className="space-y-6">
            {/* Original Transaction Card */}
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">
                    Transaction {searchResults.transaction.id.substring(0, 8)}
                  </h2>
                  <p className="text-sm text-gray-600 mt-1">
                    {formatDateTime(searchResults.transaction.created_at)}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setSearchResults(null);
                    setSelectedItems([]);
                  }}
                  className="text-gray-500 hover:text-gray-700"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-gray-50 rounded-lg mb-6">
                <div>
                  <p className="text-xs text-gray-600 uppercase">Employee</p>
                  <p className="font-semibold text-gray-900">
                    {searchResults.transaction.employee_name}
                  </p>
                </div>
                {searchResults.transaction.customer_name && (
                  <div>
                    <p className="text-xs text-gray-600 uppercase">Customer</p>
                    <p className="font-semibold text-gray-900">
                      {searchResults.transaction.customer_name}
                    </p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-gray-600 uppercase">Subtotal</p>
                  <p className="font-semibold text-gray-900">
                    {formatCurrency(searchResults.transaction.subtotal)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600 uppercase">Total</p>
                  <p className="font-semibold text-teal-600">
                    {formatCurrency(searchResults.transaction.grand_total)}
                  </p>
                </div>
              </div>

              {/* Items for Return */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-3">Select Items to Return</h3>
                <div className="space-y-2">
                  {itemsInCart.map((item, idx) => {
                    const isSelected = selectedItems.some((s) => s.product_id === item.product_id);
                    const selectedItem = selectedItems.find((s) => s.product_id === item.product_id);

                    return (
                      <div
                        key={idx}
                        className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-start gap-4">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => handleItemToggle(item, e.target.checked)}
                            className="mt-1 w-5 h-5 rounded border-gray-300 text-teal-500 focus:ring-teal-500"
                          />
                          <div className="flex-1">
                            <div className="font-semibold text-gray-900">{item.product_name}</div>
                            <div className="text-sm text-gray-600">SKU: {item.sku}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-semibold text-gray-900">
                              {formatCurrency(item.unit_price)}
                            </div>
                            <div className="text-sm text-gray-600">
                              Qty ordered: {item.quantity}
                            </div>
                          </div>
                        </div>

                        {/* Quantity Selector for Selected Items */}
                        {isSelected && selectedItem && (
                          <div className="mt-4 ml-9 flex items-center gap-4">
                            <label className="text-sm text-gray-700">Return quantity:</label>
                            <input
                              type="number"
                              min="1"
                              max={item.quantity}
                              value={selectedItem.return_quantity}
                              onChange={(e) =>
                                handleQuantityChange(item.product_id, parseInt(e.target.value, 10))
                              }
                              className="w-20 px-3 py-1 border border-gray-300 rounded focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                            />
                            <span className="text-sm font-medium text-gray-900">
                              {formatCurrency(selectedItem.line_total)}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {itemsInCart.length === 0 && (
                    <div className="text-center py-8 text-gray-500">
                      No items found in transaction
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Selected Items Summary */}
            {selectedItems.length > 0 && (
              <div className="bg-white rounded-lg border border-teal-200 p-6">
                <h2 className="text-lg font-bold text-gray-900 mb-4">Items to Return</h2>

                <div className="space-y-3 mb-6">
                  {selectedItems.map((item, idx) => (
                    <div key={idx} className="flex justify-between items-center p-3 bg-gray-50 rounded">
                      <div>
                        <div className="font-semibold text-gray-900">{item.product_name}</div>
                        <div className="text-sm text-gray-600">
                          {item.return_quantity} x {formatCurrency(item.unit_price)}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="font-semibold text-gray-900">
                          {formatCurrency(item.line_total)}
                        </span>
                        <button
                          onClick={() => handleRemoveItem(item.product_id)}
                          className="text-red-600 hover:text-red-700"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Return Details Form */}
                <div className="border-t border-gray-200 pt-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Reason for Return
                    </label>
                    <select
                      value={returnReason}
                      onChange={(e) => setReturnReason(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                    >
                      <option value="damaged">Damaged/Defective</option>
                      <option value="wrong_item">Wrong Item</option>
                      <option value="not_as_described">Not as Described</option>
                      <option value="customer_request">Customer Request</option>
                      <option value="sizing">Sizing/Fit Issue</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Notes (Optional)
                    </label>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={3}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                      placeholder="Add any additional notes about this return..."
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Refund Method
                    </label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                        <input
                          type="radio"
                          name="refund"
                          value="original_tender"
                          checked={refundMethod === 'original_tender'}
                          onChange={(e) => setRefundMethod(e.target.value)}
                          className="w-4 h-4 text-teal-500"
                        />
                        <div>
                          <div className="font-medium text-gray-900">Original Tender</div>
                          <div className="text-xs text-gray-600">
                            Refund to original payment method
                          </div>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                        <input
                          type="radio"
                          name="refund"
                          value="store_credit"
                          checked={refundMethod === 'store_credit'}
                          onChange={(e) => setRefundMethod(e.target.value)}
                          className="w-4 h-4 text-teal-500"
                        />
                        <div>
                          <div className="font-medium text-gray-900">Store Credit</div>
                          <div className="text-xs text-gray-600">Issue store credit for future purchase</div>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                        <input
                          type="radio"
                          name="refund"
                          value="cash"
                          checked={refundMethod === 'cash'}
                          onChange={(e) => setRefundMethod(e.target.value)}
                          className="w-4 h-4 text-teal-500"
                        />
                        <div>
                          <div className="font-medium text-gray-900">Cash</div>
                          <div className="text-xs text-gray-600">Issue cash refund immediately</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Refund Summary */}
                  <div className="bg-teal-50 border border-teal-200 rounded-lg p-4">
                    <div className="flex justify-between items-center">
                      <span className="text-base font-semibold text-gray-900">Refund Amount:</span>
                      <span className="text-2xl font-bold text-teal-600">
                        {formatCurrency(refundAmount)}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={handleProcessReturn}
                    disabled={processing}
                    className="w-full flex items-center justify-center gap-2 bg-emerald-500 text-white font-semibold py-3 px-4 rounded-lg hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {processing ? (
                      <>
                        <Loader className="w-5 h-5 animate-spin" />
                        Processing Return...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-5 h-5" />
                        Process Return
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Empty State */}
        {!searchResults && !searching && (
          <div className="text-center py-12">
            <Plus className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 text-lg">
              Search for a transaction to begin processing a return
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
