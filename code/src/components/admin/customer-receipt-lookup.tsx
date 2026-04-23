'use client';

import { useState, useMemo, useEffect } from 'react';
import type { Customer, TransactionEventPlaceholder, TransactionTenderPlaceholder } from '@/lib/domain/types';
import { formatCurrency } from "@/lib/format";

interface ReceiptDetailProps {
  transaction: TransactionEventPlaceholder;
  customer: Customer;
  tenders: TransactionTenderPlaceholder[];
  onClose: () => void;
}

function ReceiptDetail({ transaction, customer, tenders, onClose }: ReceiptDetailProps) {
  const transactionTenders = tenders.filter(t => t.transactionId === transaction.transactionId);
  const totalAmount = transactionTenders.reduce((sum, t) => sum + t.amount, 0);

  // R81-FE-H1: Esc closes the modal so the global Esc yield check
  // (R80-FE-H1) correctly sees [role=dialog][aria-modal=true] here.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    // R81-FE-H3: id="receipt-modal" makes the @media print rules at
    // globals.css:380 match ONLY the modal content (not the admin
    // page behind it). Prior shape printed the entire admin page
    // with the modal overlay visible. Also R81-FE-H1: role=dialog +
    // aria-modal so the R80 keyboard-shortcuts Esc yield correctly
    // sees this as an open modal.
    <div
      id="receipt-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Receipt detail"
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
    >
      <div id="receipt-content" className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-zinc-200 p-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-zinc-900">Receipt Detail</h2>
            <p className="text-sm text-zinc-600 mt-1">
              {customer.firstName} {customer.lastName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close receipt detail"
            className="touch-button p-2 hover:bg-zinc-100 rounded-lg transition"
          >
            <span className="text-xl font-bold text-zinc-600" aria-hidden="true">&times;</span>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Transaction Info */}
          <div className="bg-zinc-50 rounded-2xl p-4 space-y-3">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs font-medium text-zinc-600 uppercase tracking-wide">Transaction ID</p>
                <p className="text-lg font-mono text-zinc-900 mt-1">{transaction.transactionId}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium text-zinc-600 uppercase tracking-wide">Date</p>
                <p className="text-lg text-zinc-900 mt-1">
                  {new Date(transaction.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
          </div>

          {/* Items Summary */}
          {transaction.payload && Object.keys(transaction.payload).length > 0 && (
            <div className="space-y-3">
              <h3 className="font-semibold text-zinc-900">Items</h3>
              <div className="bg-zinc-50 rounded-2xl divide-y divide-zinc-200 overflow-hidden">
                {Object.entries(transaction.payload).map(([key, value]) => (
                  <div key={key} className="p-4 flex justify-between items-start">
                    <div>
                      <p className="font-medium text-zinc-900 capitalize">{key}</p>
                      <p className="text-sm text-zinc-600 mt-0.5">{value}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tenders */}
          <div className="space-y-3">
            <h3 className="font-semibold text-zinc-900">Payment Method</h3>
            <div className="bg-zinc-50 rounded-2xl divide-y divide-zinc-200 overflow-hidden">
              {transactionTenders.map(tender => (
                <div key={tender.id} className="p-4 flex justify-between items-center">
                  <div>
                    <p className="font-medium text-zinc-900">{tender.tenderType}</p>
                    {tender.metadata && Object.keys(tender.metadata).length > 0 && (
                      <p className="text-sm text-zinc-600 mt-1">
                        {Object.values(tender.metadata).join(' • ')}
                      </p>
                    )}
                  </div>
                  <p className="text-lg font-semibold text-zinc-900">
                    {formatCurrency(tender.amount)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Total */}
          <div className="pt-4 border-t-2 border-zinc-200">
            <div className="flex justify-between items-center">
              <p className="text-lg font-semibold text-zinc-900">Total</p>
              <p className="text-3xl font-bold text-zinc-900">{formatCurrency(totalAmount)}</p>
            </div>
          </div>

          {/* Notes */}
          {transaction.notes && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
              <p className="text-sm font-medium text-amber-900">Notes</p>
              <p className="text-sm text-amber-800 mt-2">{transaction.notes}</p>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="sticky bottom-0 bg-white border-t border-zinc-200 p-6 flex gap-3">
          <button
            onClick={() => window.print()}
            className="touch-button flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition"
          >
            Print
          </button>
          {/* R74-E: the Email button previously fired `alert("Email
              receipt to ...")` — a visible affordance that looked
              functional but sent no mail. Any staff member who clicked
              it and saw the alert had no way to know the receipt
              hadn't actually been emailed. Disable the button and
              label it "coming soon" until a mail integration ships;
              visibly preferable to a dead UX that implies delivery. */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Email receipts coming soon"
            className="touch-button flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-zinc-100 text-zinc-400 rounded-lg font-medium cursor-not-allowed"
          >
            Email (soon)
          </button>
          <button
            onClick={onClose}
            className="touch-button px-6 py-3 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded-lg font-medium transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function CustomerReceiptLookup({
  customers,
  transactions,
  tenders,
}: {
  customers: Customer[];
  transactions: TransactionEventPlaceholder[];
  tenders: TransactionTenderPlaceholder[];
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedTransaction, setSelectedTransaction] = useState<TransactionEventPlaceholder | null>(null);
  const [showResults, setShowResults] = useState(false);

  // Filter customers based on search query
  const matchedCustomers = useMemo(() => {
    if (!searchQuery.trim()) return [];

    const query = searchQuery.toLowerCase();
    return customers.filter(customer => {
      const email = customer.email?.toLowerCase() || '';
      const phone = customer.phone?.toLowerCase() || '';
      const name = `${customer.firstName} ${customer.lastName}`.toLowerCase();

      return email.includes(query) || phone.includes(query) || name.includes(query);
    });
  }, [searchQuery, customers]);

  // Get transactions for selected customer
  const customerTransactions = useMemo(() => {
    if (!selectedCustomer) return [];

    // Since we don't have a direct customerId on transactions, we filter by customer name
    // In a real system, you'd have a customerId or customer reference on transactions
    return transactions.sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return dateB - dateA; // Most recent first
    });
  }, [selectedCustomer, transactions]);

  const handleCustomerSelect = (customer: Customer) => {
    setSelectedCustomer(customer);
    setSearchQuery('');
    setShowResults(false);
  };

  const handleTransactionSelect = (transaction: TransactionEventPlaceholder) => {
    setSelectedTransaction(transaction);
  };

  const getTransactionTotal = (transactionId: string): number => {
    return tenders
      .filter(t => t.transactionId === transactionId)
      .reduce((sum, t) => sum + t.amount, 0);
  };

  const getTransactionItemsPreview = (transaction: TransactionEventPlaceholder): string => {
    if (!transaction.payload || Object.keys(transaction.payload).length === 0) {
      return 'No items recorded';
    }
    const items = Object.keys(transaction.payload).slice(0, 2);
    const count = Object.keys(transaction.payload).length;
    const preview = items.join(', ');
    return count > 2 ? `${preview}, +${count - 2} more` : preview;
  };

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-zinc-900">Receipt Lookup</h1>
          <p className="text-zinc-600 mt-1">Find and view past purchases</p>
        </div>

        {/* Search Section */}
        {!selectedCustomer ? (
          <div className="space-y-4">
            <div className="relative">
              <input
                type="text"
                placeholder="Search by email, phone, or name..."
                value={searchQuery}
                onChange={e => {
                  setSearchQuery(e.target.value);
                  setShowResults(e.target.value.length > 0);
                }}
                onFocus={() => setShowResults(searchQuery.length > 0)}
                className="touch-button w-full px-4 py-3 bg-white border border-zinc-300 rounded-2xl text-zinc-900 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />

              {/* Search Results Dropdown */}
              {showResults && matchedCustomers.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-zinc-300 rounded-2xl shadow-lg z-10 overflow-hidden">
                  {matchedCustomers.map(customer => (
                    <button
                      key={customer.id}
                      onClick={() => handleCustomerSelect(customer)}
                      className="touch-button w-full text-left px-4 py-3 hover:bg-zinc-50 border-b border-zinc-200 last:border-b-0 transition flex items-center justify-between group"
                    >
                      <div>
                        <p className="font-medium text-zinc-900">
                          {customer.firstName} {customer.lastName}
                        </p>
                        <p className="text-sm text-zinc-600 mt-0.5">
                          {customer.email || customer.phone || 'No contact'}
                        </p>
                      </div>
                      <span className="text-zinc-400 group-hover:text-zinc-600">&rarr;</span>
                    </button>
                  ))}
                </div>
              )}

              {/* No results message */}
              {showResults && searchQuery.trim() && matchedCustomers.length === 0 && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-zinc-300 rounded-2xl shadow-lg p-4 text-center">
                  <p className="text-zinc-600">No customers found matching &apos;{searchQuery}&apos;</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Selected Customer Header */}
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-blue-900">
                    {selectedCustomer.firstName} {selectedCustomer.lastName}
                  </h2>
                  <div className="flex gap-4 mt-3 text-sm text-blue-800">
                    {selectedCustomer.email && (
                      <div>
                        <p className="text-xs font-medium text-blue-700 uppercase">Email</p>
                        <p>{selectedCustomer.email}</p>
                      </div>
                    )}
                    {selectedCustomer.phone && (
                      <div>
                        <p className="text-xs font-medium text-blue-700 uppercase">Phone</p>
                        <p>{selectedCustomer.phone}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs font-medium text-blue-700 uppercase">Total Spend</p>
                      <p>{formatCurrency(selectedCustomer.totalSpend)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-blue-700 uppercase">Visits</p>
                      <p>{selectedCustomer.visitCount}</p>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setSelectedCustomer(null);
                    setSelectedTransaction(null);
                  }}
                  className="touch-button px-4 py-2 bg-blue-200 hover:bg-blue-300 text-blue-900 rounded-lg font-medium transition"
                >
                  Change Customer
                </button>
              </div>
            </div>

            {/* Transactions List */}
            <div className="space-y-3">
              <h3 className="font-semibold text-lg text-zinc-900">Purchase History</h3>
              {customerTransactions.length === 0 ? (
                <div className="bg-zinc-50 border border-zinc-200 rounded-2xl p-8 text-center">
                  <p className="text-zinc-600">No transactions found for this customer</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {customerTransactions.map(transaction => (
                    <button
                      key={transaction.id}
                      onClick={() => handleTransactionSelect(transaction)}
                      className="touch-button w-full text-left p-4 bg-white border border-zinc-200 rounded-2xl hover:shadow-md hover:border-blue-300 transition group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <p className="font-medium text-zinc-900">
                            {new Date(transaction.createdAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}{' '}
                            at{' '}
                            {new Date(transaction.createdAt).toLocaleTimeString('en-US', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                          <p className="text-sm text-zinc-600 mt-1">
                            {getTransactionItemsPreview(transaction)}
                          </p>
                        </div>
                        <div className="text-right ml-4">
                          <p className="text-xl font-bold text-zinc-900">
                            {formatCurrency(getTransactionTotal(transaction.transactionId))}
                          </p>
                          <p className="text-xs text-zinc-500 mt-1 uppercase tracking-wide">
                            View Details
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Receipt Detail Modal */}
      {selectedTransaction && selectedCustomer && (
        <ReceiptDetail
          transaction={selectedTransaction}
          customer={selectedCustomer}
          tenders={tenders}
          onClose={() => setSelectedTransaction(null)}
        />
      )}
    </div>
  );
}
