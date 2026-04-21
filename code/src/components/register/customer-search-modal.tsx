"use client";

import { useState, useMemo } from "react";
import type { Customer, TransactionEventPlaceholder, TransactionTenderPlaceholder } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";

interface CustomerSearchModalProps {
  customers: Customer[];
  currentCustomerId?: string;
  transactionEvents?: TransactionEventPlaceholder[];
  transactionTenders?: TransactionTenderPlaceholder[];
  onSelect: (customer: Customer) => void;
  onClear: () => void;
  onCancel: () => void;
  onCreateCustomer?: (data: { firstName: string; lastName: string; email?: string; phone?: string }) => Promise<Customer | null>;
}

export function CustomerSearchModal({
  customers,
  currentCustomerId,
  transactionEvents,
  transactionTenders,
  onSelect,
  onClear,
  onCancel,
  onCreateCustomer,
}: CustomerSearchModalProps) {
  const [query, setQuery] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [creating, setCreating] = useState(false);
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);

  // Build purchase history per customer from transaction events that mention customer_id
  const purchaseHistory = useMemo(() => {
    if (!transactionEvents || !transactionTenders) return new Map<string, { transactionId: string; date: string; total: number; tenderType: string }[]>();
    const map = new Map<string, { transactionId: string; date: string; total: number; tenderType: string }[]>();
    for (const evt of transactionEvents) {
      if (evt.eventKind !== "transaction_placeholder" || !evt.payload?.grand_total) continue;
      if (evt.payload?.is_return === "true") continue;
      const custId = evt.payload?.customer_id;
      if (!custId) continue;
      const tenders = transactionTenders.filter((t) => t.transactionId === evt.transactionId);
      const primaryTender = tenders.length === 1 ? tenders[0].tenderType : "split";
      const entry = {
        transactionId: evt.transactionId,
        date: evt.createdAt,
        total: Math.abs(Number(evt.payload.grand_total)),
        tenderType: primaryTender,
      };
      const existing = map.get(custId) ?? [];
      existing.push(entry);
      map.set(custId, existing);
    }
    return map;
  }, [transactionEvents, transactionTenders]);

  const filtered = useMemo(() => {
    if (!query.trim()) return customers.filter((c) => c.isActive);
    const q = query.toLowerCase().trim();
    return customers.filter(
      (c) =>
        c.isActive &&
        (c.firstName.toLowerCase().includes(q) ||
          c.lastName.toLowerCase().includes(q) ||
          `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q) ||
          c.phone?.includes(q)),
    );
  }, [customers, query]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-100 px-5 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">Customer</h2>
            <button
              type="button"
              onClick={onCancel}
              className="touch-button rounded-xl bg-zinc-100 px-3 text-sm font-semibold text-zinc-600 hover:bg-zinc-200"
            >
              Close
            </button>
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, or phone..."
            className="mt-3 w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm"
            autoFocus
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto p-4">
          {/* New customer form */}
          {onCreateCustomer && !showNewForm && (
            <button
              type="button"
              onClick={() => setShowNewForm(true)}
              className="mb-3 w-full rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-left text-sm font-semibold text-teal-700 hover:bg-teal-100 active:bg-teal-200"
            >
              + New customer
            </button>
          )}
          {showNewForm && onCreateCustomer && (
            <div className="mb-3 rounded-xl border border-teal-200 bg-teal-50 p-4">
              <p className="mb-2 text-sm font-semibold text-teal-800">New customer</p>
              <div className="grid grid-cols-2 gap-2">
                <input value={newFirst} onChange={(e) => setNewFirst(e.target.value)} placeholder="First name *" className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm" autoFocus />
                <input value={newLast} onChange={(e) => setNewLast(e.target.value)} placeholder="Last name *" className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm" />
                <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email" type="email" className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm" />
                <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone" type="tel" className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm" />
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={!newFirst.trim() || !newLast.trim() || creating}
                  onClick={async () => {
                    setCreating(true);
                    const customer = await onCreateCustomer({
                      firstName: newFirst.trim(), lastName: newLast.trim(),
                      email: newEmail.trim() || undefined, phone: newPhone.trim() || undefined,
                    });
                    setCreating(false);
                    if (customer) {
                      setShowNewForm(false);
                      setNewFirst(""); setNewLast(""); setNewEmail(""); setNewPhone("");
                      onSelect(customer);
                    }
                  }}
                  className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create & attach"}
                </button>
                <button type="button" onClick={() => setShowNewForm(false)} className="rounded-lg bg-zinc-200 px-4 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-300">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {currentCustomerId && (
            <button
              type="button"
              onClick={onClear}
              className="mb-3 w-full rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm font-semibold text-red-700 hover:bg-red-100 active:bg-red-200"
            >
              Remove customer from sale
            </button>
          )}

          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-400">
              {query.trim() ? "No customers found" : "No customers yet"}
            </p>
          ) : (
            <div className="space-y-2">
              {filtered.map((customer) => {
                const isSelected = customer.id === currentCustomerId;
                return (
                  <div key={customer.id} className="space-y-1">
                    <button
                      type="button"
                      onClick={() => onSelect(customer)}
                      className={`touch-button w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                        isSelected
                          ? "border-teal-300 bg-teal-50"
                          : "border-zinc-200 bg-zinc-50 hover:bg-blue-50 active:bg-blue-100"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-semibold">
                            {customer.firstName} {customer.lastName}
                            {isSelected && <span className="ml-2 text-xs font-normal text-teal-600">(attached)</span>}
                          </p>
                          <p className="text-xs text-zinc-500">
                            {[customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact info"}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-semibold text-teal-700">{customer.loyaltyPoints} pts</p>
                          <p className="text-xs text-zinc-500">{customer.visitCount} visits</p>
                        </div>
                      </div>
                    </button>
                    {(purchaseHistory.get(customer.id)?.length ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedCustomerId(expandedCustomerId === customer.id ? null : customer.id)}
                        className="w-full text-left px-4 py-1 text-xs text-blue-600 hover:text-blue-800"
                      >
                        {expandedCustomerId === customer.id ? "Hide" : "Show"} purchase history ({purchaseHistory.get(customer.id)?.length ?? 0})
                      </button>
                    )}
                    {expandedCustomerId === customer.id && (
                      <div className="rounded-lg bg-zinc-50 px-4 py-2 space-y-1">
                        {(purchaseHistory.get(customer.id) ?? []).slice(0, 10).map((txn) => (
                          <div key={txn.transactionId} className="flex justify-between text-xs text-zinc-600">
                            <span>{new Date(txn.date).toLocaleDateString()}</span>
                            <span className="capitalize">{txn.tenderType}</span>
                            <span className="font-semibold">{formatCurrency(txn.total)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
