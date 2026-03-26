'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

export interface KeyboardShortcutActions {
  onCheckout?: () => void;        // F1 — Go to payment
  onHoldCart?: () => void;         // F2 — Hold current cart
  onRecallCart?: () => void;       // F3 — Recall held cart
  onCustomerSearch?: () => void;   // F4 — Attach customer
  onReturn?: () => void;          // F5 — Open return modal
  onExchange?: () => void;        // F6 — Open exchange modal
  onPromo?: () => void;           // F7 — Open promo code modal
  onLayaway?: () => void;         // F8 — Create layaway
  onVoidCart?: () => void;        // Escape — Void/clear cart
  onNewSale?: () => void;         // F9 — New sale (from receipt screen)
  onPrint?: () => void;           // F10 — Print receipt
  onToggleShortcuts?: () => void; // ? — Show shortcuts overlay
  screen?: 'selling' | 'tender' | 'receipt'; // Current screen for context-aware shortcuts
  shiftOpen?: boolean;
}

export function useKeyboardShortcuts(config: KeyboardShortcutActions) {
  const {
    onCheckout,
    onHoldCart,
    onRecallCart,
    onCustomerSearch,
    onReturn,
    onExchange,
    onPromo,
    onLayaway,
    onVoidCart,
    onNewSale,
    onPrint,
    onToggleShortcuts,
    screen = 'selling',
    shiftOpen = false,
  } = config;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if user is typing in an input/textarea/select
      const target = e.target as HTMLElement;
      const isInputElement =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      if (isInputElement) {
        // Allow Ctrl+Z for undo even in inputs
        if (!(e.ctrlKey && e.key === 'z')) {
          return;
        }
      }

      // Handle ? for shortcuts overlay
      if (e.key === '?') {
        e.preventDefault();
        onToggleShortcuts?.();
        return;
      }

      // Handle Escape for void cart
      if (e.key === 'Escape') {
        e.preventDefault();
        onVoidCart?.();
        return;
      }

      // Handle F-keys
      if (e.key === 'F1') {
        e.preventDefault();
        if (screen === 'selling') {
          onCheckout?.();
        }
        return;
      }

      if (e.key === 'F2') {
        e.preventDefault();
        if (screen === 'selling') {
          onHoldCart?.();
        }
        return;
      }

      if (e.key === 'F3') {
        e.preventDefault();
        if (screen === 'selling') {
          onRecallCart?.();
        }
        return;
      }

      if (e.key === 'F4') {
        e.preventDefault();
        if (screen === 'selling') {
          onCustomerSearch?.();
        }
        return;
      }

      if (e.key === 'F5') {
        e.preventDefault();
        if (screen === 'selling') {
          onReturn?.();
        }
        return;
      }

      if (e.key === 'F6') {
        e.preventDefault();
        if (screen === 'selling') {
          onExchange?.();
        }
        return;
      }

      if (e.key === 'F7') {
        e.preventDefault();
        if (screen === 'selling') {
          onPromo?.();
        }
        return;
      }

      if (e.key === 'F8') {
        e.preventDefault();
        if (screen === 'selling') {
          onLayaway?.();
        }
        return;
      }

      if (e.key === 'F9') {
        e.preventDefault();
        if (screen === 'receipt') {
          onNewSale?.();
        }
        return;
      }

      if (e.key === 'F10') {
        e.preventDefault();
        if (screen === 'receipt') {
          onPrint?.();
        }
        return;
      }

      // Handle Ctrl+Z for undo (void last item)
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        onVoidCart?.();
        return;
      }

      // Handle + and - for quantity adjustments (numpad and regular)
      if ((e.key === '+' || e.key === '=') && !isInputElement && screen === 'selling') {
        e.preventDefault();
        // Quantity increment logic would be handled by parent
        return;
      }

      if (e.key === '-' && !isInputElement && screen === 'selling') {
        e.preventDefault();
        // Quantity decrement logic would be handled by parent
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    onCheckout,
    onHoldCart,
    onRecallCart,
    onCustomerSearch,
    onReturn,
    onExchange,
    onPromo,
    onLayaway,
    onVoidCart,
    onNewSale,
    onPrint,
    onToggleShortcuts,
    screen,
  ]);
}

interface KeyboardShortcutsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsOverlay({ isOpen, onClose }: KeyboardShortcutsOverlayProps) {
  if (!isOpen) return null;

  const shortcuts = {
    cart: [
      { key: 'F1', action: 'Checkout' },
      { key: 'F2', action: 'Hold Cart' },
      { key: 'F3', action: 'Recall Cart' },
      { key: 'Esc', action: 'Void Cart' },
    ],
    customer: [
      { key: 'F4', action: 'Attach Customer' },
      { key: 'F5', action: 'Return' },
      { key: 'F6', action: 'Exchange' },
      { key: 'F7', action: 'Promo Code' },
      { key: 'F8', action: 'Create Layaway' },
    ],
    receipt: [
      { key: 'F9', action: 'New Sale' },
      { key: 'F10', action: 'Print Receipt' },
    ],
    general: [{ key: '?', action: 'Show Shortcuts' }],
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-zinc-50 p-8 text-zinc-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-2 hover:bg-zinc-200 transition-colors"
          aria-label="Close shortcuts"
        >
          <X className="h-6 w-6" />
        </button>

        {/* Header */}
        <h2 className="mb-8 text-2xl font-bold text-zinc-900">Keyboard Shortcuts</h2>

        {/* Shortcuts Grid */}
        <div className="space-y-8">
          {/* Cart Section */}
          <section>
            <h3 className="mb-4 text-lg font-semibold text-zinc-900">Cart</h3>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {shortcuts.cart.map((item) => (
                <div key={item.key} className="flex items-center gap-3">
                  <kbd className="rounded border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm font-semibold text-zinc-900 shadow-sm">
                    {item.key}
                  </kbd>
                  <span className="text-sm font-medium text-zinc-700">{item.action}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Customer Section */}
          <section>
            <h3 className="mb-4 text-lg font-semibold text-zinc-900">Customer</h3>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {shortcuts.customer.map((item) => (
                <div key={item.key} className="flex items-center gap-3">
                  <kbd className="rounded border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm font-semibold text-zinc-900 shadow-sm">
                    {item.key}
                  </kbd>
                  <span className="text-sm font-medium text-zinc-700">{item.action}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Receipt Section */}
          <section>
            <h3 className="mb-4 text-lg font-semibold text-zinc-900">Receipt</h3>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {shortcuts.receipt.map((item) => (
                <div key={item.key} className="flex items-center gap-3">
                  <kbd className="rounded border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm font-semibold text-zinc-900 shadow-sm">
                    {item.key}
                  </kbd>
                  <span className="text-sm font-medium text-zinc-700">{item.action}</span>
                </div>
              ))}
            </div>
          </section>

          {/* General Section */}
          <section>
            <h3 className="mb-4 text-lg font-semibold text-zinc-900">General</h3>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {shortcuts.general.map((item) => (
                <div key={item.key} className="flex items-center gap-3">
                  <kbd className="rounded border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm font-semibold text-zinc-900 shadow-sm">
                    {item.key}
                  </kbd>
                  <span className="text-sm font-medium text-zinc-700">{item.action}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Tip section */}
          <div className="mt-8 rounded-lg bg-zinc-100 p-4">
            <p className="text-sm text-zinc-600">
              <strong>Tip:</strong> Keyboard shortcuts are disabled when typing in search fields or input boxes.
            </p>
          </div>
        </div>

        {/* Footer action */}
        <div className="mt-8 flex justify-end">
          <button
            onClick={onClose}
            className="touch-button rounded-lg bg-zinc-700 px-6 py-2 font-medium text-white transition-colors hover:bg-zinc-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
