"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { openShiftAction, registerLogoutAction, quickSwitchAction } from "@/app/register/actions";
import { closeShiftEnhancedAction, payInOutAction } from "@/app/register/shift-actions";
import type { CloseShiftInput } from "@/app/register/shift-actions";
import { SectionCard } from "@/components/ui/section-card";
import type { PayInOutRecord } from "@/lib/domain/types";
import type { LocalStoreData, RegisterSessionContext } from "@/lib/persistence/types";
import { formatDateTime } from "@/lib/utils/date";
import { ShiftCloseModal } from "./shift-close-modal";
import { PayInOutModal, type PayDirection } from "./pay-in-out-modal";
import { TimeClockWidget } from "./time-clock-widget";
import { EODWizard } from "./eod-wizard";

// Dynamic import with ssr: false to avoid module initialization errors
// during SSR on Cloudflare Workers (Turbopack bundling TDZ issue)
const POSTerminal = dynamic(
  () => import("./pos-terminal").then((m) => ({ default: m.POSTerminal })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center rounded-2xl border border-zinc-200 bg-white p-12 text-zinc-500">
        Loading POS terminal…
      </div>
    ),
  },
);

interface RecentShift {
  id: string;
  status: "open" | "closed";
  openedAt: string;
  openingFloat: number;
  closingVariance?: number;
  employee?: { displayName: string } | undefined;
}

interface RegisterConsoleClientProps {
  store: LocalStoreData;
  context: RegisterSessionContext;
  notice?: string;
  error?: string;
  canOpenRegister: boolean;
  expectedCash: number;
  transactionCount: number;
  salesTotal: number;
  tenderBreakdown: { type: string; total: number; count: number }[];
  recentShifts: RecentShift[];
  payInOuts: PayInOutRecord[];
}

export function RegisterConsoleClient({
  store,
  context,
  notice,
  error,
  canOpenRegister,
  expectedCash,
  transactionCount,
  salesTotal,
  tenderBreakdown,
  recentShifts,
  payInOuts,
}: RegisterConsoleClientProps) {
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showEODWizard, setShowEODWizard] = useState(false);
  const [payDirection, setPayDirection] = useState<PayDirection | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [showQuickSwitch, setShowQuickSwitch] = useState(false);
  const [switchPin, setSwitchPin] = useState("");
  const [switching, setSwitching] = useState(false);

  // Dark mode by default for register — Toast POS feel
  useEffect(() => {
    const stored = localStorage.getItem("bupos-dark-mode");
    // Default to dark if no preference stored
    if (stored === null || stored === "true") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    if (stored === null) localStorage.setItem("bupos-dark-mode", "true");
    return () => {
      // Clean up dark class when leaving register
      document.documentElement.classList.remove("dark");
    };
  }, []);

  const payInTotal = payInOuts.filter((p) => p.direction === "pay_in").reduce((s, p) => s + p.amount, 0);
  const payOutTotal = payInOuts.filter((p) => p.direction === "pay_out").reduce((s, p) => s + p.amount, 0);

  async function handleCloseShift(declaredCash: number, note: string, blind: boolean) {
    setClosing(true);
    setActionError(null);
    try {
      const input: CloseShiftInput = { declaredCash, expectedCash, note, blindClose: blind };
      const result = await closeShiftEnhancedAction(input);
      if (!result.success) {
        setActionError(result.error ?? "Failed to close shift");
      }
      setShowCloseModal(false);
    } catch {
      setActionError("Failed to close shift");
    } finally {
      setClosing(false);
    }
  }

  async function handleQuickSwitch() {
    if (!switchPin.trim()) return;
    setSwitching(true);
    setActionError(null);
    try {
      const result = await quickSwitchAction(switchPin);
      if (!result.success) {
        setActionError(result.error ?? "Switch failed");
      } else {
        setShowQuickSwitch(false);
      }
      setSwitchPin("");
    } catch {
      setActionError("Quick switch failed");
    } finally {
      setSwitching(false);
    }
  }

  async function handlePayInOut(amount: number, reason: string, note: string) {
    if (!payDirection) return;
    setActionError(null);
    try {
      const result = await payInOutAction({ direction: payDirection, amount, reason, note });
      if (!result.success) {
        setActionError(result.error ?? "Failed");
      }
      setPayDirection(null);
    } catch {
      setActionError("Failed to record pay-in/out");
    }
  }

  // When shift is open, show the full POS terminal
  if (context.activeShift && canOpenRegister) {
    return (
      <div className="space-y-4">
        {/* Compact session bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="font-semibold">{context.employee.displayName}</span>
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-600">{context.location.name}</span>
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-500" suppressHydrationWarning>Shift opened {formatDateTime(context.activeShift.openedAt)}</span>
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-500">Float ${context.activeShift.openingFloat.toFixed(2)}</span>
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-500">Expected ${expectedCash.toFixed(2)}</span>
            {payInOuts.length > 0 && (
              <>
                <span className="text-zinc-400">·</span>
                <span className="text-zinc-500">
                  {payInTotal > 0 && <span className="text-teal-600">+${payInTotal.toFixed(2)} in</span>}
                  {payInTotal > 0 && payOutTotal > 0 && " / "}
                  {payOutTotal > 0 && <span className="text-amber-600">−${payOutTotal.toFixed(2)} out</span>}
                </span>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <a
              href="/admin/clock-in"
              className="touch-button flex items-center gap-1 rounded-xl bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
            >
              🕐 Clock In
            </a>
            <button
              type="button"
              onClick={() => setPayDirection("pay_in")}
              className="touch-button rounded-xl bg-teal-50 px-3 text-sm font-semibold text-teal-700 hover:bg-teal-100"
            >
              Pay in
            </button>
            <button
              type="button"
              onClick={() => setPayDirection("pay_out")}
              className="touch-button rounded-xl bg-amber-50 px-3 text-sm font-semibold text-amber-700 hover:bg-amber-100"
            >
              Pay out
            </button>
            <button
              type="button"
              onClick={() => setShowQuickSwitch(true)}
              className="touch-button rounded-xl bg-indigo-50 px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-100"
            >
              Switch
            </button>
            <button
              type="button"
              disabled={closing}
              onClick={() => setShowEODWizard(true)}
              className="touch-button rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              End of day
            </button>
            <button
              type="button"
              disabled={closing}
              onClick={() => setShowCloseModal(true)}
              className="touch-button rounded-xl bg-amber-600 px-4 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              Close shift
            </button>
            <form action={registerLogoutAction}>
              <button className="touch-button rounded-xl bg-zinc-200 px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-300">
                Log out
              </button>
            </form>
          </div>
        </div>

        {/* Time Clock */}
        <TimeClockWidget
          employeeId={context.employee.id}
          employeeName={context.employee.displayName}
          locationId={context.location.id}
          organizationId={context.employee.organizationId}
          todayEntries={store.timeClockEntries.filter((e) => e.createdAt.startsWith(new Date().toISOString().slice(0, 10)))}
        />

        {notice && <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
        {(error || actionError) && (
          <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error || actionError}</p>
        )}

        {/* POS Terminal */}
        <POSTerminal
          products={store.products}
          variants={store.variants}
          categories={store.categories}
          inventory={store.inventory}
          customers={store.customers}
          transactionEvents={store.transactionEventPlaceholders}
          transactionTenders={store.transactionTenderPlaceholders}
          employee={context.employee}
          location={context.location}
          registerSession={context.registerSession}
          activeShift={context.activeShift}
          registerConfig={store.registerConfiguration}
          giftCards={store.giftCards}
          promoCodes={store.promoCodes}
          storeName={store.organization.name}
          receiptHeader={store.organization.receiptHeader}
          receiptFooter={store.organization.receiptFooter}
        />

        {/* Shift close modal */}
        {showCloseModal && (
          <ShiftCloseModal
            expectedCash={expectedCash}
            openingFloat={context.activeShift.openingFloat}
            shiftOpenedAt={context.activeShift.openedAt}
            cashierName={context.employee.displayName}
            transactionCount={transactionCount}
            salesTotal={salesTotal}
            tenderBreakdown={tenderBreakdown}
            onConfirm={handleCloseShift}
            onCancel={() => setShowCloseModal(false)}
          />
        )}

        {/* End of day wizard */}
        {showEODWizard && (
          <EODWizard
            expectedCash={expectedCash}
            openingFloat={context.activeShift.openingFloat}
            shiftOpenedAt={context.activeShift.openedAt}
            cashierName={context.employee.displayName}
            transactionCount={transactionCount}
            salesTotal={salesTotal}
            tenderBreakdown={tenderBreakdown}
            onCloseShift={handleCloseShift}
            onCancel={() => setShowEODWizard(false)}
            dailyReportUrl="https://jkdgdcfpgxjfdlccvqjf.supabase.co/functions/v1/daily-report"
          />
        )}

        {/* Pay-in/out modal */}
        {payDirection && (
          <PayInOutModal
            direction={payDirection}
            onConfirm={handlePayInOut}
            onCancel={() => setPayDirection(null)}
          />
        )}

        {/* Quick-switch PIN modal */}
        {showQuickSwitch && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-xs rounded-2xl bg-white shadow-2xl">
              <div className="rounded-t-2xl bg-indigo-600 px-5 py-4 text-center text-white">
                <p className="text-lg font-bold">Switch employee</p>
                <p className="mt-1 text-sm text-indigo-200">Enter new cashier&apos;s PIN</p>
              </div>
              <div className="p-5">
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  autoFocus
                  value={switchPin}
                  onChange={(e) => setSwitchPin(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") handleQuickSwitch(); }}
                  placeholder="Enter PIN"
                  className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-4 text-center text-2xl tracking-[0.5em] focus:border-indigo-400 focus:outline-none"
                />
                <div className="mt-4 grid grid-cols-3 gap-2">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, "⌫"].map((key) => {
                    if (key === null) return <div key="spacer" />;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          if (key === "⌫") setSwitchPin((p) => p.slice(0, -1));
                          else setSwitchPin((p) => p.length < 6 ? p + key : p);
                        }}
                        className="touch-button rounded-xl bg-zinc-100 py-3 text-lg font-semibold text-zinc-800 hover:bg-zinc-200 active:bg-zinc-300"
                      >
                        {key}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowQuickSwitch(false); setSwitchPin(""); }}
                    className="touch-button flex-1 rounded-xl bg-zinc-100 px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={switching || switchPin.length < 4}
                    onClick={handleQuickSwitch}
                    className="touch-button flex-1 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {switching ? "Switching…" : "Switch"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Pre-shift: show session info + shift open/close
  return (
    <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
      <div className="grid gap-6">
        <SectionCard title="Register session" description="Open a shift to start selling. The shift tracks cash accountability for the drawer.">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
              <p className="text-sm text-zinc-500">Cashier</p>
              <p className="mt-2 text-2xl font-semibold">{context.employee.displayName}</p>
              <p className="text-sm text-zinc-600">{context.employee.roleKey}</p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
              <p className="text-sm text-zinc-500">Location</p>
              <p className="mt-2 text-2xl font-semibold">{context.location.name}</p>
              <p className="text-sm text-zinc-600">{context.location.address1}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-zinc-600">
              Session opened {formatDateTime(context.session.createdAt)}
            </div>
            <form action={registerLogoutAction}>
              <button className="touch-button rounded-2xl bg-zinc-900 px-5 text-sm font-semibold text-white">Close session</button>
            </form>
          </div>
          {notice ? <p className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}
          {error ? <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
        </SectionCard>

        <SectionCard title="Open shift to start selling" description="Count your cash drawer and open a shift. Once open, the full POS terminal appears.">
          {!canOpenRegister ? (
            <p className="rounded-2xl bg-zinc-100 px-4 py-3 text-sm text-zinc-700">This role can participate in register flows but cannot open or close the register.</p>
          ) : context.activeShift ? (
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Metric label="Opening float" value={`$${context.activeShift.openingFloat.toFixed(2)}`} detail={context.activeShift.openedNote ?? "No opening note"} />
                <Metric label="Shift state" value="Open" detail={`Opened ${formatDateTime(context.activeShift.openedAt)}`} />
              </div>
              <button
                type="button"
                onClick={() => setShowCloseModal(true)}
                className="touch-button rounded-2xl bg-amber-600 px-5 text-sm font-semibold text-white"
              >
                Close shift
              </button>
              {showCloseModal && (
                <ShiftCloseModal
                  expectedCash={expectedCash}
                  openingFloat={context.activeShift.openingFloat}
                  shiftOpenedAt={context.activeShift.openedAt}
                  cashierName={context.employee.displayName}
                  transactionCount={transactionCount}
                  salesTotal={salesTotal}
                  tenderBreakdown={tenderBreakdown}
                  onConfirm={handleCloseShift}
                  onCancel={() => setShowCloseModal(false)}
                />
              )}
            </div>
          ) : (
            <form action={openShiftAction} className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-sm font-medium text-zinc-700">
                <span>Opening float</span>
                <input name="openingFloat" type="number" step="0.01" defaultValue="200.00" className="rounded-2xl border border-zinc-300 bg-white px-4 py-3" />
              </label>
              <label className="grid gap-1 text-sm font-medium text-zinc-700 md:col-span-2">
                <span>Opening note</span>
                <textarea name="openedNote" className="min-h-24 rounded-2xl border border-zinc-300 bg-white px-4 py-3" placeholder="Drawer counted and receipt printer loaded." />
              </label>
              <button className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white md:col-span-2">Open shift</button>
            </form>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-6">
        <SectionCard title="Recent shifts" description="Previous shifts at this location.">
          <div className="space-y-3">
            {recentShifts.length === 0 ? (
              <p className="text-sm text-zinc-600">No shifts opened yet.</p>
            ) : (
              recentShifts.map((shift) => (
                <div key={shift.id} className="rounded-2xl border border-zinc-200 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{shift.employee?.displayName ?? "Unknown"}</p>
                      <p className="text-sm text-zinc-600">Opened {formatDateTime(shift.openedAt)}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${shift.status === "open" ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-700"}`}>{shift.status}</span>
                  </div>
                  <div className="mt-3 text-sm text-zinc-600">
                    Float ${shift.openingFloat.toFixed(2)}
                    {typeof shift.closingVariance === "number" ? ` · variance ${shift.closingVariance >= 0 ? "+" : ""}$${shift.closingVariance.toFixed(2)}` : ""}
                  </div>
                </div>
              ))
            )}
          </div>
        </SectionCard>

        <SectionCard title="Tender & approval configuration" description="Configured tender types and manager approval thresholds for this location.">
          <div className="grid gap-3">
            {store.registerConfiguration.supportedTenders.map((tender) => (
              <div key={tender} className="flex items-center justify-between rounded-2xl border border-zinc-200 px-4 py-3">
                <span className="font-medium capitalize">{tender === "store_credit" ? "Store Credit" : tender}</span>
                <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700">Enabled</span>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-3">
            {Object.entries(store.registerConfiguration.approvalThresholds).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between rounded-2xl bg-zinc-50 px-4 py-3 text-sm">
                <span>{formatThresholdLabel(key)}</span>
                <span className="font-semibold">${value.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
      <p className="mt-2 text-xs text-zinc-500">{detail}</p>
    </div>
  );
}

function formatThresholdLabel(key: string): string {
  const map: Record<string, string> = {
    discountOver: "Discount over",
    itemVoidOver: "Item void over",
    transactionVoidOver: "Transaction void over",
    storeCreditIssuanceOver: "Store credit issuance over",
    manualPriceOverrideOver: "Manual price override over",
    returnWithoutManagerOver: "Return without manager over",
  };
  return map[key] ?? key;
}
