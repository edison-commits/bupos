"use client";

import { useState, useEffect, useId } from "react";
import { ESCPOSBuilder } from "@/lib/receipt/escpos";
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

// Sortable button config — defined at module scope so TypeScript sees it in the component
const STORAGE_KEY = "bupos-register-buttons";
const LOCK_KEY = "bupos-register-buttons-locked";

interface ButtonConfig {
  id: string;
  label: string;
  type: "pay_in" | "pay_out" | "switch" | "drawer" | "eod" | "close" | "logout" | "clockin";
  variant: "teal" | "amber" | "indigo" | "teal-solid" | "amber-solid" | "zinc" | "emerald" | "gray";
  href?: string;
}

const DEFAULT_BUTTONS: ButtonConfig[] = [
  { id: "clockin", label: "🕐 Clock In", type: "clockin", variant: "emerald", href: "/admin/clock-in" },
  { id: "payin",   label: "Pay in",      type: "pay_in",  variant: "teal" },
  { id: "payout",  label: "Pay out",     type: "pay_out", variant: "amber" },
  { id: "switch",  label: "Switch",      type: "switch",   variant: "indigo" },
  { id: "drawer",  label: "Open Drawer", type: "drawer",   variant: "gray" },
  { id: "eod",     label: "End of day",  type: "eod",      variant: "teal-solid" },
  { id: "close",   label: "Close shift", type: "close",   variant: "amber-solid" },
  { id: "logout",  label: "Log out",     type: "logout",   variant: "zinc" },
];

function loadButtons(): ButtonConfig[] {
  if (typeof window === "undefined") return DEFAULT_BUTTONS;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_BUTTONS;
    const order: string[] = JSON.parse(saved);
    const map = new Map(DEFAULT_BUTTONS.map((b) => [b.id, b]));
    const ordered = order.map((id) => map.get(id)).filter(Boolean) as ButtonConfig[];
    for (const b of DEFAULT_BUTTONS) {
      if (!ordered.find((x) => x.id === b.id)) ordered.push(b);
    }
    return ordered;
  } catch { return DEFAULT_BUTTONS; }
}

function loadLocked(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LOCK_KEY) === "true";
}

function saveButtons(order: ButtonConfig[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(order.map((b) => b.id)));
}

function saveLocked(locked: boolean) {
  localStorage.setItem(LOCK_KEY, String(locked));
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
  const uid = useId();
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showEODWizard, setShowEODWizard] = useState(false);
  const [payDirection, setPayDirection] = useState<PayDirection | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [showQuickSwitch, setShowQuickSwitch] = useState(false);
  const [switchPin, setSwitchPin] = useState("");
  const [switching, setSwitching] = useState(false);
  const [drawerStatus, setDrawerStatus] = useState<"idle" | "opening" | "done" | "error">("idle");

  // Sortable button state
  const [buttons, setButtons] = useState<ButtonConfig[]>(loadButtons);
  const [isLocked, setIsLocked] = useState(loadLocked);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  async function handleOpenDrawer() {
    if (!("serial" in navigator)) {
      setDrawerStatus("error");
      return;
    }
    setDrawerStatus("opening");
    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: 9600 });
      const writer = port.writable.getWriter();
      const cmd = new ESCPOSBuilder().init().openDrawer().build();
      await writer.write(cmd);
      writer.releaseLock();
      await port.close();
      setDrawerStatus("done");
      setTimeout(() => setDrawerStatus("idle"), 2000);
    } catch {
      setDrawerStatus("error");
      setTimeout(() => setDrawerStatus("idle"), 3000);
    }
  }

  // Drag handlers
  function handleDragStart(e: React.DragEvent, id: string) {
    if (isLocked) return;
    setDraggedId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }
  function handleDragOver(e: React.DragEvent, id: string) {
    if (isLocked || draggedId === null || draggedId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(id);
  }
  function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    if (isLocked || draggedId === null || draggedId === targetId) return;
    setButtons((prev) => {
      const next = [...prev];
      const from = next.findIndex((b) => b.id === draggedId);
      const to = next.findIndex((b) => b.id === targetId);
      if (from < 0 || to < 0) return prev;
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      saveButtons(next);
      return next;
    });
    setDraggedId(null);
    setDragOverId(null);
  }
  function handleDragEnd() {
    setDraggedId(null);
    setDragOverId(null);
  }
  function toggleLock() {
    const next = !isLocked;
    setIsLocked(next);
    saveLocked(next);
    if (next) {
      setDraggedId(null);
      setDragOverId(null);
    }
  }

  function variantClass(v: ButtonConfig["variant"]) {
    switch (v) {
      case "teal": return "bg-teal-50 text-teal-700 hover:bg-teal-100";
      case "amber": return "bg-amber-50 text-amber-700 hover:bg-amber-100";
      case "indigo": return "bg-indigo-50 text-indigo-700 hover:bg-indigo-100";
      case "emerald": return "bg-emerald-50 text-emerald-700 hover:bg-emerald-100";
      case "gray": return "bg-gray-700 text-white hover:bg-gray-800";
      case "teal-solid": return "bg-teal-600 text-white hover:bg-teal-700";
      case "amber-solid": return "bg-amber-600 text-white hover:bg-amber-700";
      case "zinc": return "bg-zinc-200 text-zinc-700 hover:bg-zinc-300";
    }
  }

  function renderButton(b: ButtonConfig) {
    const isDragging = draggedId === b.id;
    const isDropTarget = dragOverId === b.id && !isDragging;
    const isDisabled =
      (b.type === "drawer" && drawerStatus !== "idle") ||
      (b.type === "eod" && closing) ||
      (b.type === "close" && closing);
    const dragProps = isLocked ? {} : {
      draggable: true,
      onDragStart: (e: React.DragEvent) => handleDragStart(e, b.id),
      onDragOver: (e: React.DragEvent) => handleDragOver(e, b.id),
      onDrop: (e: React.DragEvent) => handleDrop(e, b.id),
      onDragEnd: handleDragEnd,
    };

    if (b.type === "clockin") {
      return (
        <a
          key={b.id}
          {...dragProps}
          href={b.href}
          className={`touch-button flex items-center gap-1 rounded-xl px-4 py-2 text-base font-semibold ${variantClass(b.variant)} ${isDragging ? "opacity-40" : ""}`}
        >
          {!isLocked && <span className="text-xs opacity-60">⋮⋮</span>}
          {b.label}
        </a>
      );
    }
    if (b.type === "logout") {
      return (
        <form key={b.id} action={registerLogoutAction}>
          <button
            {...dragProps}
            type="submit"
            className={`touch-button flex items-center gap-1 rounded-xl px-4 py-2 text-base font-semibold ${variantClass(b.variant)} ${isDragging ? "opacity-40" : ""}`}
          >
            {!isLocked && <span className="text-xs opacity-60">⋮⋮</span>}
            {b.label}
          </button>
        </form>
      );
    }
    const label = b.type === "drawer"
      ? (drawerStatus === "idle" ? b.label : drawerStatus === "opening" ? "Opening…" : drawerStatus === "done" ? "✓ Done" : "Failed")
      : b.label;
    const clickHandlers: Record<string, () => void> = {
      pay_in: () => setPayDirection("pay_in"),
      pay_out: () => setPayDirection("pay_out"),
      switch: () => setShowQuickSwitch(true),
      drawer: handleOpenDrawer,
      eod: () => setShowEODWizard(true),
      close: () => setShowCloseModal(true),
    };
    return (
      <button
        key={b.id}
        {...dragProps}
        type="button"
        disabled={isDisabled}
        onClick={clickHandlers[b.type]}
        className={`touch-button flex items-center gap-1 rounded-xl px-4 py-3 text-base font-semibold ${variantClass(b.variant)} ${isDragging ? "opacity-40" : ""} ${isDropTarget ? "ring-2 ring-offset-1 ring-teal-400" : ""} ${isDisabled && b.type !== "drawer" ? "disabled:opacity-50" : ""}`}
      >
        {!isLocked && <span className="text-xs opacity-60">⋮⋮</span>}
        {label}
      </button>
    );
  }

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
        {/* Sortable action buttons */}
        <div className="flex flex-wrap gap-2">
          {buttons.map(renderButton)}
          <button
            type="button"
            onClick={toggleLock}
            title={isLocked ? "Unlock to rearrange buttons" : "Lock button order"}
            className={`touch-button flex items-center gap-1 rounded-xl px-4 py-3 text-base font-semibold transition-colors ${isLocked ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"}`}
          >
            {isLocked
              ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            }
          </button>
        </div>

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
              <p className="text-base font-bold">Switch employee</p>
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
              <p className="text-base text-zinc-700">Cashier</p>
              <p className="mt-2 text-2xl font-semibold">{context.employee.displayName}</p>
              <p className="text-base text-zinc-800">{context.employee.roleKey}</p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
              <p className="text-base text-zinc-700">Location</p>
              <p className="mt-2 text-2xl font-semibold">{context.location.name}</p>
              <p className="text-base text-zinc-800">{context.location.address1}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-base text-zinc-800">
              Session opened {formatDateTime(context.session.createdAt)}
            </div>
            <form action={registerLogoutAction}>
              <button className="touch-button rounded-2xl bg-zinc-900 px-5 text-base font-semibold text-white">Close session</button>
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
              <label className="grid gap-1 text-base font-medium text-zinc-700">
                <span>Opening float</span>
                <input name="openingFloat" type="number" step="0.01" defaultValue="200.00" className="rounded-2xl border border-zinc-300 bg-white px-4 py-3" />
              </label>
              <label className="grid gap-1 text-base font-medium text-zinc-700 md:col-span-2">
                <span>Opening note</span>
                <textarea name="openedNote" className="min-h-24 rounded-2xl border border-zinc-300 bg-white px-4 py-3" placeholder="Drawer counted and receipt printer loaded." />
              </label>
              <button className="touch-button rounded-2xl bg-teal-700 px-5 text-base font-semibold text-white md:col-span-2">Open shift</button>
            </form>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-6">
        <SectionCard title="Recent shifts" description="Previous shifts at this location.">
          <div className="space-y-3">
            {recentShifts.length === 0 ? (
              <p className="text-base text-zinc-700">No shifts opened yet.</p>
            ) : (
              recentShifts.map((shift) => (
                <div key={shift.id} className="rounded-2xl border border-zinc-200 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{shift.employee?.displayName ?? "Unknown"}</p>
                      <p className="text-base text-zinc-700">Opened {formatDateTime(shift.openedAt)}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-sm font-semibold ${shift.status === "open" ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-700"}`}>{shift.status}</span>
                  </div>
                  <div className="mt-3 text-base text-zinc-700">
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
                <span className="rounded-full bg-teal-50 px-2 py-0.5 text-sm font-semibold text-teal-700">Enabled</span>
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
