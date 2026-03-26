'use client';

import { useState } from 'react';

interface EmailReceiptButtonProps {
  customerEmail?: string;
  transactionId: string;
  storeName: string;
  items: Array<{ name: string; qty: number; price: number }>;
  subtotal: number;
  tax: number;
  total: number;
  tenders: Array<{ type: string; amount: number }>;
  loyaltyEarned: number;
  date: string;
}

export function EmailReceiptButton({
  customerEmail,
  transactionId,
  storeName,
  items,
  subtotal,
  tax,
  total,
  tenders,
  loyaltyEarned,
  date,
}: EmailReceiptButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState(customerEmail || '');
  const [isSending, setIsSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSend = async () => {
    if (!email.trim()) {
      setErrorMessage('Please enter an email address');
      return;
    }

    setIsSending(true);
    setSendStatus('sending');
    setErrorMessage('');

    try {
      const payload = {
        to: email.trim(),
        subject: `Receipt - ${transactionId}`,
        transactionId,
        storeName,
        items,
        subtotal,
        tax,
        total,
        tenders,
        loyaltyEarned,
        date,
      };

      const response = await fetch('/api/email-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `Failed to send receipt (${response.status})`);
      }

      setSendStatus('sent');
      
      // Auto-hide form after 3 seconds
      setTimeout(() => {
        setIsOpen(false);
        setSendStatus('idle');
        setEmail(customerEmail || '');
      }, 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to send receipt';
      setErrorMessage(errorMsg);
      setSendStatus('error');
      setIsSending(false);
    }
  };

  const handleCancel = () => {
    setIsOpen(false);
    setSendStatus('idle');
    setEmail(customerEmail || '');
    setErrorMessage('');
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-zinc-300 rounded-lg hover:bg-gray-50 active:bg-gray-100 transition-colors"
        title="Email receipt to customer"
      >
        <span>✉</span>
        <span>Email receipt</span>
      </button>
    );
  }

  return (
    <div className="mt-4 p-4 border border-zinc-300 rounded-lg bg-white">
      <h3 className="font-semibold text-gray-900 mb-3">Email Receipt</h3>

      <div className="space-y-3">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
            Email Address
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="customer@example.com"
            disabled={isSending}
            className="w-full px-3 py-2 border border-zinc-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-500"
          />
        </div>

        {errorMessage && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {errorMessage}
          </div>
        )}

        {sendStatus === 'sent' && (
          <div className="p-2 bg-green-50 border border-green-200 rounded text-sm text-green-700">
            Receipt sent successfully!
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSend}
            disabled={isSending}
            className="flex-1 px-4 py-2 bg-teal-600 text-white font-medium text-sm rounded-md hover:bg-teal-700 active:bg-teal-800 disabled:bg-teal-400 disabled:cursor-not-allowed transition-colors"
          >
            {isSending ? 'Sending...' : 'Send'}
          </button>
          <button
            onClick={handleCancel}
            disabled={isSending}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 disabled:text-gray-400 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}