"use client";

import { useState, memo } from "react";
import type { TenderType, ApprovalThresholds, LoyaltyConfig, GiftCard } from "@/lib/domain/types";
import type { CartTotals } from "@/lib/cart/types";
import { VirtualNumpad } from "@/components/ui/virtual-numpad";
import { VirtualKeyboard } from "@/components/ui/virtual-keyboard";

export interface TenderEntry {
  type: TenderType;
  amount: number;
  metadata?: Record<string, string>;
}

interface TenderPanelProps {
  totals: CartTotals;
  supportedTenders: TenderType[];
  approvalThresholds: ApprovalThresholds;
  discountAmount: number;
  onConfirm: (tenders: TenderEntry[]) => void;
  onCancel: () => void;
  processing: boolean;
  customerLoyaltyPoints?: number;
  loyaltyConfig?: LoyaltyConfig;
  customerStoreCreditBalance?: number;
  giftCards: GiftCard[];
}

export const TenderPanel = memo(function TenderPanel({
  totals,
  supportedTenders,
  approvalThresholds,
  discountAmount,
  onConfirm,
  onCancel,
  processing,
  customerLoyaltyPoints,
  loyaltyConfig,
  customerStoreCreditBalance,
  giftCards,
}: TenderPanelProps) {
  const [mode, setMode] = useState<"single" | "split">("single");
  const [selectedTender, setSelectedTender] = useState<TenderType>("cash");
  const [cashGiven, setCashGiven] = useState<string>("");
  const [loyaltyRedeemAmount, setLoyaltyRedeemAmount] = useState<string>("");
  const [splitTenders, setSplitTenders] = useState<TenderEntry[]>([]);
  const [splitType, setSplitType] = useState<TenderType>("cash");
  const [splitAmount, setSplitAmount] = useState<string>("");
  const [giftCardCode, setGiftCardCode] = useState<string>("");
  const [giftCardLookup, setGiftCardLookup] = useState<GiftCard | null>(null);
  const [giftCardError, setGiftCardError] = useState<string | null>(null);
  const [giftCardRedeemAmount, setGiftCardRedeemAmount] = useState<string>("");

  // Tip state
  const [tipPercent, setTipPercent] = useState<number | null>(null);
  const [customTip, setCustomTip] = useState<string>("");
  const [showCustomTip, setShowCustomTip] = useState(false);

  // Virtual input state
  type ActiveInput = "cash" | "loyalty" | "gift_card" | "split" | "gift_code" | "tip" | null;
  const [activeInput, setActiveInput] = useState<ActiveInput>(null);

  const tipAmount = showCustomTip ? (Number(customTip) || 0) : (tipPercent != null ? Number((totals.grandTotal * tipPercent / 100).toFixed(2)) : 0);
  const grandTotal = totals.grandTotal + tipAmount;

  // Loyalty calculations
  const availablePoints = customerLoyaltyPoints ?? 0;
  const loyaltyValue = loyaltyConfig
    ? Number((availablePoints * loyaltyConfig.redemptionValuePerPoint).toFixed(2))
    : 0;
  const canRedeemLoyalty = loyaltyConfig ? availablePoints >= loyaltyConfig.minimumRedemption : false;
  const maxLoyaltyRedeem = Math.min(loyaltyValue, grandTotal);
  const cashGivenNum = Number(cashGiven) || 0;
  const changeDue = selectedTender === "cash" ? Math.max(0, cashGivenNum - grandTotal) : 0;
  const loyaltyRedeemNum = Number(loyaltyRedeemAmount) || 0;
  const loyaltySufficient = selectedTender !== "loyalty" || (canRedeemLoyalty && loyaltyRedeemNum > 0 && loyaltyRedeemNum <= maxLoyaltyRedeem);
  const cashSufficient = (selectedTender !== "cash" || cashGivenNum >= grandTotal) && (selectedTender !== "loyalty" || loyaltySufficient);

  // Split tender calculations
  const splitAllocated = splitTenders.reduce((sum, t) => sum + t.amount, 0);
  const splitRemaining = Math.max(0, Number((grandTotal - splitAllocated).toFixed(2)));
  const splitComplete = splitRemaining <= 0.005;

  // Threshold warnings
  const warnings: string[] = [];
  if (discountAmount > approvalThresholds.discountOver) {
    warnings.push(`Discount ($${discountAmount.toFixed(2)}) exceeds $${approvalThresholds.discountOver.toFixed(2)} threshold`);
  }

  // Gift card validation
  const giftCardRedeemNum = Number(giftCardRedeemAmount) || 0;
  const giftCardSufficient = selectedTender !== "gift_card" || (giftCardLookup != null && giftCardRedeemNum > 0 && giftCardRedeemNum <= giftCardLookup.balance && giftCardRedeemNum <= grandTotal);
  const storeCreditSufficient = selectedTender !== "store_credit" || (customerStoreCreditBalance != null && customerStoreCreditBalance >= grandTotal);

  function handleSingleConfirm() {
    if (selectedTender === "loyalty") {
      const redeemAmt = Number(loyaltyRedeemAmount) || 0;
      if (redeemAmt <= 0 || redeemAmt > maxLoyaltyRedeem) return;
      onConfirm([{ type: "loyalty", amount: Number(redeemAmt.toFixed(2)) }]);
      return;
    }
    if (selectedTender === "gift_card") {
      if (!giftCardLookup || giftCardRedeemNum <= 0) return;
      onConfirm([{ type: "gift_card", amount: Number(giftCardRedeemNum.toFixed(2)), metadata: { gift_card_id: giftCardLookup.id, gift_card_code: giftCardLookup.code } }]);
      return;
    }
    const amount = selectedTender === "cash" ? cashGivenNum : grandTotal;
    onConfirm([{ type: selectedTender, amount }]);
  }

  function handleAddSplitTender() {
    const amt = Number(splitAmount) || 0;
    if (amt <= 0) return;
    const capped = Math.min(amt, splitRemaining);
    setSplitTenders([...splitTenders, { type: splitType, amount: Number(capped.toFixed(2)) }]);
    setSplitAmount("");
  }

  function handleRemoveSplitTender(index: number) {
    setSplitTenders(splitTenders.filter((_, i) => i !== index));
  }

  function handleSplitConfirm() {
    onConfirm(splitTenders);
  }

  function handleNumpadPress(key: string) {
    if (key === "backspace") {
      setCashGiven(cashGiven.slice(0, -1));
    } else if (key === ".") {
      if (!cashGiven.includes(".")) setCashGiven(cashGiven + ".");
    } else {
      if (cashGiven.length < 10) setCashGiven(cashGiven + key);
    }
  }

  const quickCashAmounts = computeQuickCash(grandTotal);
  const tenderTypeIcons: Record<string, string> = {
    cash: "💵",
    card: "💳",
    store_credit: "💰",
    loyalty: "⭐",
    gift_card: "🎁",
  };

  return (
    <div className="fixed inset-0 z-50 flex bg-black/40">
      {/* Left side backdrop (semi-transparent) */}
      <div className="hidden md:block" style={{ width: "25%" }} onClick={onCancel} />

      {/* Right side payment panel — wider to fit bigger buttons */}
      <div className="w-full flex-col bg-white md:shadow-2xl flex" style={{ maxWidth: "75%" }}>
        {/* Header */}
        <div className="relative border-b border-[var(--border-subtle)] px-8 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={processing}
            className="absolute top-4 left-8 touch-button text-4xl font-bold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="Back"
          >
            ←
          </button>

          <div className="text-center">
            <p className="text-lg font-semibold text-[var(--text-secondary)] uppercase tracking-wide">Amount due</p>
            <p className="mt-1 text-5xl font-extrabold text-teal-600">${grandTotal.toFixed(2)}</p>
          </div>
        </div>

        {/* Tip UI */}
        <div className="border-b border-[var(--border-subtle)] px-8 py-4">
          <p className="text-base font-bold text-[var(--text-secondary)] uppercase tracking-wide mb-3">Add tip</p>
          <div className="flex gap-3">
            {[15, 18, 20].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => { setTipPercent(pct); setShowCustomTip(false); setCustomTip(""); }}
                className={`flex-1 rounded-2xl px-4 py-4 text-center font-bold transition-all ${
                  !showCustomTip && tipPercent === pct
                    ? "text-white shadow-md"
                    : "bg-[var(--surface-panel-muted)] text-[var(--text-secondary)] hover:bg-zinc-200"
                }`}
                style={!showCustomTip && tipPercent === pct ? { background: 'var(--surface-accent)' } : undefined}
              >
                <span className="text-2xl">{pct}%</span>
                <p className="text-base mt-0.5 opacity-80">${(totals.grandTotal * pct / 100).toFixed(2)}</p>
              </button>
            ))}
            <button
              type="button"
              onClick={() => { setShowCustomTip(true); setTipPercent(null); setActiveInput("tip"); }}
              className={`flex-1 rounded-2xl px-4 py-4 text-center font-bold transition-all ${
                showCustomTip
                  ? "text-white shadow-md"
                  : "bg-[var(--surface-panel-muted)] text-[var(--text-secondary)] hover:bg-zinc-200"
              }`}
              style={showCustomTip ? { background: 'var(--surface-accent)' } : undefined}
            >
              <span className="text-2xl">Custom</span>
              {showCustomTip && customTip ? <p className="text-base mt-0.5 opacity-80">${(Number(customTip) || 0).toFixed(2)}</p> : null}
            </button>
            {(tipPercent != null || (showCustomTip && Number(customTip) > 0)) && (
              <button
                type="button"
                onClick={() => { setTipPercent(null); setShowCustomTip(false); setCustomTip(""); }}
                className="rounded-2xl px-4 py-4 text-center font-bold bg-[var(--surface-panel-muted)] text-red-500 hover:bg-red-50 transition-all"
              >
                <span className="text-lg">No tip</span>
              </button>
            )}
          </div>
          {tipAmount > 0 && (
            <p className="mt-2 text-lg font-semibold text-center" style={{ color: 'var(--surface-accent)' }}>
              Tip: ${tipAmount.toFixed(2)} — New total: ${grandTotal.toFixed(2)}
            </p>
          )}
        </div>

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="border-b border-amber-200 bg-amber-50 px-8 py-4">
            {warnings.map((w) => (
              <p key={w} className="text-xl font-semibold text-amber-800">{w}</p>
            ))}
          </div>
        )}

        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="px-8 py-4">
            {/* Mode toggle */}
            {supportedTenders.includes("split") && (
              <div className="mb-4 flex gap-3">
                <button
                  type="button"
                  onClick={() => setMode("single")}
                  className={`flex-1 rounded-xl px-6 py-4 text-xl font-bold transition-all ${
                    mode === "single"
                      ? "bg-zinc-900 text-white"
                      : "bg-[var(--surface-panel)] text-[var(--text-secondary)] hover:bg-zinc-100"
                  }`}
                >
                  Single
                </button>
                <button
                  type="button"
                  onClick={() => setMode("split")}
                  className={`flex-1 rounded-xl px-6 py-4 text-xl font-bold transition-all ${
                    mode === "split"
                      ? "bg-zinc-900 text-white"
                      : "bg-[var(--surface-panel)] text-[var(--text-secondary)] hover:bg-zinc-100"
                  }`}
                >
                  Split
                </button>
              </div>
            )}

            {mode === "single" ? (
              <div className="space-y-4">
                {/* Tender type selection — large pill buttons */}
                <div>
                  <div className="flex gap-3 overflow-x-auto">
                    {supportedTenders.filter((t) => t !== "split").map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setSelectedTender(t)}
                        className={`touch-button flex items-center gap-2 rounded-full border-3 px-6 py-3 whitespace-nowrap transition-all ${
                          selectedTender === t
                            ? "border-teal-600 bg-teal-50"
                            : "border-[var(--border-subtle)] bg-white hover:border-[var(--text-secondary)]"
                        }`}
                      >
                        <span className="text-2xl">{tenderTypeIcons[t] || "💳"}</span>
                        <span className="text-lg font-bold capitalize">
                          {t === "store_credit" ? "Credit" : t === "loyalty" ? "Loyalty" : t === "gift_card" ? "Gift Card" : t}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Cash section with inline numpad side by side */}
                {selectedTender === "cash" && (
                  <div className="flex gap-4">
                    {/* Left: amount display + quick cash + change */}
                    <div className="flex-1 flex flex-col gap-3 min-w-0">
                      {/* Cash tendered display */}
                      <div className="rounded-2xl px-4 py-4 text-center border-3 border-teal-400 bg-teal-50/50">
                        <p className="text-base text-[var(--text-secondary)] font-semibold">Cash tendered</p>
                        <p className="text-4xl font-extrabold text-[var(--text-primary)]">
                          ${cashGivenNum.toFixed(2)}
                        </p>
                      </div>

                      {/* Quick cash amounts */}
                      {quickCashAmounts.length > 0 && (
                        <div className="grid grid-cols-2 gap-2">
                          {quickCashAmounts.map((amt) => (
                            <button
                              key={amt}
                              type="button"
                              onClick={() => setCashGiven(amt.toFixed(2))}
                              className="touch-button rounded-2xl border-3 border-teal-600 bg-teal-50 px-3 py-7 text-2xl font-bold text-teal-700 hover:bg-teal-100 active:bg-teal-200 transition-colors"
                            >
                              ${amt.toFixed(2)}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Change due */}
                      {cashGivenNum > 0 && (
                        <div className="rounded-2xl bg-emerald-100 px-4 py-4 text-center border-3 border-emerald-400">
                          <p className="text-base font-semibold text-emerald-700">Change due</p>
                          <p className="text-4xl font-extrabold text-emerald-700">${changeDue.toFixed(2)}</p>
                        </div>
                      )}
                    </div>

                    {/* Right: inline 10-key numpad — BIG round buttons */}
                    <div className="shrink-0" style={{ width: "320px" }}>
                      <div className="grid grid-cols-3 gap-2">
                        <CashKey label="7" onPress={() => handleNumpadPress("7")} />
                        <CashKey label="8" onPress={() => handleNumpadPress("8")} />
                        <CashKey label="9" onPress={() => handleNumpadPress("9")} />
                        <CashKey label="4" onPress={() => handleNumpadPress("4")} />
                        <CashKey label="5" onPress={() => handleNumpadPress("5")} />
                        <CashKey label="6" onPress={() => handleNumpadPress("6")} />
                        <CashKey label="1" onPress={() => handleNumpadPress("1")} />
                        <CashKey label="2" onPress={() => handleNumpadPress("2")} />
                        <CashKey label="3" onPress={() => handleNumpadPress("3")} />
                        <CashKey label="0" onPress={() => handleNumpadPress("0")} />
                        <CashKey label="." onPress={() => handleNumpadPress(".")} />
                        <CashKey label="⌫" onPress={() => handleNumpadPress("backspace")} variant="action" />
                        <button
                          type="button"
                          onClick={() => setCashGiven("")}
                          className="col-span-3 flex items-center justify-center rounded-2xl bg-zinc-200 text-zinc-600 h-14 text-xl font-bold active:bg-zinc-300 transition-colors touch-manipulation select-none"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Card payment */}
                {selectedTender === "card" && (
                  <div className="rounded-2xl bg-blue-100 px-8 py-8 text-center border-3 border-blue-400">
                    <p className="text-lg font-semibold text-blue-700">Card payment</p>
                    <p className="text-4xl font-extrabold text-blue-900">${grandTotal.toFixed(2)}</p>
                    <p className="mt-2 text-xl text-blue-700">Confirm to record card tender</p>
                  </div>
                )}

                {/* Store credit */}
                {selectedTender === "store_credit" && (
                  <div className="rounded-2xl bg-purple-100 px-8 py-8 text-center border-3 border-purple-400">
                    <p className="text-lg font-semibold text-purple-700">Store credit</p>
                    <p className="text-4xl font-extrabold text-purple-900">${grandTotal.toFixed(2)}</p>
                    {customerStoreCreditBalance != null && customerStoreCreditBalance > 0 ? (
                      <p className="mt-2 text-xl text-purple-700">Balance: ${customerStoreCreditBalance.toFixed(2)}</p>
                    ) : (
                      <p className="mt-2 text-xl text-red-600 font-semibold">
                        {customerStoreCreditBalance === 0 ? "No balance available" : "Attach a customer first"}
                      </p>
                    )}
                  </div>
                )}

                {/* Gift card */}
                {selectedTender === "gift_card" && (
                  <div className="space-y-4">
                    <label className="block">
                      <span className="text-lg font-bold text-[var(--text-secondary)] uppercase tracking-wide">Gift card code</span>
                      <div className="mt-3 flex gap-3">
                        <div className="relative flex-1">
                          <input
                            type="text"
                            value={giftCardCode}
                            onChange={(e) => { setGiftCardCode(e.target.value); setGiftCardError(null); }}
                            onFocus={() => setActiveInput("gift_code")}
                            placeholder="e.g. GC-2026-001"
                            autoFocus
                            className="w-full rounded-xl border-3 border-[var(--border-subtle)] bg-white px-6 py-5 pr-12 text-2xl font-semibold"
                            inputMode="none"
                          />
                          <button
                            type="button"
                            onClick={() => setActiveInput("gift_code")}
                            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-md p-2 text-zinc-400 hover:text-teal-600"
                          >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><line x1="6" y1="8" x2="6" y2="8.01" /><line x1="10" y1="8" x2="10" y2="8.01" /><line x1="14" y1="8" x2="14" y2="8.01" /><line x1="18" y1="8" x2="18" y2="8.01" /><line x1="8" y1="16" x2="16" y2="16" /></svg>
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const found = giftCards.find((gc) => gc.code === giftCardCode && gc.status === "active");
                            if (found) {
                              setGiftCardLookup(found);
                              setGiftCardError(null);
                              setGiftCardRedeemAmount(Math.min(found.balance, grandTotal).toFixed(2));
                            } else {
                              setGiftCardLookup(null);
                              setGiftCardError("Card not found or not active");
                            }
                          }}
                          className="rounded-xl bg-zinc-900 px-8 py-5 text-xl font-bold text-white hover:bg-zinc-800 transition-colors"
                        >
                          Look up
                        </button>
                      </div>
                    </label>
                    {giftCardError && <p className="text-xl font-semibold text-red-600">{giftCardError}</p>}
                    {giftCardLookup && (
                      <>
                        <div className="rounded-2xl bg-emerald-100 px-8 py-6 text-center border-3 border-emerald-400">
                          <p className="text-lg font-semibold text-emerald-700">Card balance</p>
                          <p className="mt-1 text-4xl font-extrabold text-emerald-900">${giftCardLookup.balance.toFixed(2)}</p>
                        </div>
                        <label className="block">
                          <span className="text-lg font-bold text-[var(--text-secondary)] uppercase tracking-wide">Redeem amount</span>
                          <button
                            type="button"
                            onClick={() => setActiveInput("gift_card")}
                            className="mt-3 w-full rounded-xl border-3 border-[var(--border-subtle)] bg-white px-6 py-5 text-right text-3xl font-bold hover:border-teal-300 transition-colors"
                          >
                            ${(Number(giftCardRedeemAmount) || 0).toFixed(2)}
                          </button>
                        </label>
                        <button
                          type="button"
                          onClick={() => setGiftCardRedeemAmount(Math.min(giftCardLookup.balance, grandTotal).toFixed(2))}
                          className="w-full rounded-xl border-3 border-emerald-400 bg-emerald-50 px-6 py-5 text-xl font-bold text-emerald-700 hover:bg-emerald-100 transition-colors"
                        >
                          Max: ${Math.min(giftCardLookup.balance, grandTotal).toFixed(2)}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* Loyalty */}
                {selectedTender === "loyalty" && (
                  <div className="space-y-4">
                    {!canRedeemLoyalty ? (
                      <div className="rounded-2xl bg-[var(--surface-panel)] px-8 py-8 text-center">
                        <p className="text-xl font-semibold text-[var(--text-secondary)]">
                          {availablePoints === 0
                            ? "No loyalty points available. Attach a customer first."
                            : `Only ${availablePoints} points — minimum ${loyaltyConfig?.minimumRedemption ?? 100} required.`}
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="rounded-2xl bg-amber-100 px-8 py-6 text-center border-3 border-amber-400">
                          <p className="text-lg font-semibold text-amber-700">Available points</p>
                          <p className="mt-1 text-3xl font-extrabold text-amber-900">{availablePoints} pts = ${loyaltyValue.toFixed(2)}</p>
                        </div>
                        <label className="block">
                          <span className="text-lg font-bold text-[var(--text-secondary)] uppercase tracking-wide">Redeem amount</span>
                          <button
                            type="button"
                            onClick={() => setActiveInput("loyalty")}
                            className="mt-3 w-full rounded-xl border-3 border-[var(--border-subtle)] bg-white px-6 py-5 text-right text-3xl font-bold hover:border-teal-300 transition-colors"
                          >
                            {loyaltyRedeemAmount ? `$${(Number(loyaltyRedeemAmount) || 0).toFixed(2)}` : `$${Math.min(loyaltyValue, grandTotal).toFixed(2)}`}
                          </button>
                        </label>
                        <button
                          type="button"
                          onClick={() => setLoyaltyRedeemAmount(maxLoyaltyRedeem.toFixed(2))}
                          className="w-full rounded-xl border-3 border-amber-400 bg-amber-50 px-6 py-5 text-xl font-bold text-amber-700 hover:bg-amber-100 transition-colors"
                        >
                          Max: ${maxLoyaltyRedeem.toFixed(2)}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* Split tender mode */
              <div className="space-y-5">
                {/* Allocated tenders list */}
                {splitTenders.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-lg font-bold text-[var(--text-secondary)] uppercase tracking-wide">Allocated</p>
                    {splitTenders.map((t, i) => {
                      const runningTotal = splitTenders.slice(0, i + 1).reduce((s, x) => s + x.amount, 0);
                      return (
                        <div key={`${t.type}-${i}`} className="flex items-center justify-between rounded-xl border-3 border-emerald-400 bg-emerald-50/30 px-6 py-5">
                          <div className="flex items-center gap-3">
                            <span className="text-2xl">{tenderTypeIcons[t.type] || "💳"}</span>
                            <div>
                              <span className="text-xl font-bold capitalize">
                                {t.type === "store_credit" ? "Store Credit" : t.type === "loyalty" ? "Loyalty" : t.type === "gift_card" ? "Gift Card" : t.type}
                              </span>
                              <p className="text-base text-[var(--text-secondary)]">Running: ${runningTotal.toFixed(2)}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-2xl font-extrabold text-emerald-700">${t.amount.toFixed(2)}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveSplitTender(i)}
                              className="touch-button rounded text-red-600 hover:text-red-800 font-bold text-2xl"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Progress bar */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-lg font-bold text-[var(--text-secondary)] uppercase tracking-wide">Progress</p>
                    <p className="text-xl font-bold text-[var(--text-primary)]">
                      ${splitAllocated.toFixed(2)} / ${grandTotal.toFixed(2)}
                    </p>
                  </div>
                  <div className="w-full h-6 bg-[var(--surface-panel)] rounded-full overflow-hidden border-3 border-[var(--border-subtle)]">
                    <div
                      className="h-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all duration-300"
                      style={{ width: `${Math.min((splitAllocated / grandTotal) * 100, 100)}%` }}
                    />
                  </div>
                </div>

                {/* Remaining */}
                <div className={`rounded-2xl px-8 py-6 text-center border-3 ${
                  splitRemaining <= 0.005
                    ? "bg-emerald-100 border-emerald-400"
                    : "bg-[var(--surface-panel)] border-[var(--border-subtle)]"
                }`}>
                  <p className="text-lg font-semibold text-[var(--text-secondary)]">Remaining</p>
                  <p className={`mt-1 text-4xl font-extrabold ${splitRemaining <= 0.005 ? "text-emerald-900" : "text-[var(--text-primary)]"}`}>
                    ${splitRemaining.toFixed(2)}
                  </p>
                </div>

                {/* Add tender */}
                {!splitComplete && (
                  <div className="space-y-3">
                    <p className="text-lg font-bold text-[var(--text-secondary)] uppercase tracking-wide">Add another payment</p>
                    <div className="flex gap-3">
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl">{tenderTypeIcons[splitType] || "💳"}</span>
                        <select
                          value={splitType}
                          onChange={(e) => setSplitType(e.target.value as TenderType)}
                          className="rounded-xl border-3 border-[var(--border-subtle)] bg-white pl-14 pr-6 py-5 text-xl font-semibold appearance-none"
                        >
                          {supportedTenders.filter((t) => t !== "split").map((t) => (
                            <option key={t} value={t}>
                              {t === "store_credit" ? "Store Credit" : t === "loyalty" ? "Loyalty" : t === "gift_card" ? "Gift Card" : t}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveInput("split")}
                        className="flex-1 rounded-xl border-3 border-dashed border-[var(--border-subtle)] bg-white px-6 py-5 text-right text-xl font-semibold hover:border-teal-300 transition-colors"
                        style={{ color: splitAmount ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                      >
                        {splitAmount || splitRemaining.toFixed(2)}
                      </button>
                      <button
                        type="button"
                        onClick={handleAddSplitTender}
                        className="touch-button rounded-xl bg-teal-600 px-8 py-5 text-xl font-bold text-white hover:bg-teal-700 transition-colors"
                      >
                        + Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Confirm button */}
        <div className="border-t border-[var(--border-subtle)] px-8 py-4 mt-auto">
          <button
            type="button"
            disabled={processing || (mode === "single" && (!cashSufficient || !giftCardSufficient || !storeCreditSufficient)) || (mode === "split" && !splitComplete)}
            onClick={mode === "single" ? handleSingleConfirm : handleSplitConfirm}
            className={`touch-button w-full rounded-2xl px-8 py-6 text-2xl font-bold transition-all ${
              processing || (mode === "single" && (!cashSufficient || !giftCardSufficient || !storeCreditSufficient)) || (mode === "split" && !splitComplete)
                ? "cursor-not-allowed bg-zinc-300 text-zinc-500"
                : "bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:from-emerald-600 hover:to-teal-700 active:from-emerald-700 active:to-teal-800 shadow-lg"
            }`}
          >
            {processing ? "Processing..." : "Confirm payment"}
          </button>
        </div>
      </div>

      {/* Virtual Numpad for gift card redeem */}
      <VirtualNumpad
        visible={activeInput === "gift_card"}
        value={giftCardRedeemAmount}
        onChange={setGiftCardRedeemAmount}
        onEnter={() => setActiveInput(null)}
        onClose={() => setActiveInput(null)}
        label="Gift card redeem"
        allowDecimal={true}
      />

      {/* Virtual Numpad for loyalty redeem */}
      <VirtualNumpad
        visible={activeInput === "loyalty"}
        value={loyaltyRedeemAmount}
        onChange={setLoyaltyRedeemAmount}
        onEnter={() => setActiveInput(null)}
        onClose={() => setActiveInput(null)}
        label="Loyalty redeem"
        allowDecimal={true}
      />

      {/* Virtual Numpad for split amount */}
      <VirtualNumpad
        visible={activeInput === "split"}
        value={splitAmount}
        onChange={setSplitAmount}
        onEnter={() => { setActiveInput(null); handleAddSplitTender(); }}
        onClose={() => setActiveInput(null)}
        label="Split amount"
        allowDecimal={true}
      />

      {/* Virtual Numpad for custom tip */}
      <VirtualNumpad
        visible={activeInput === "tip"}
        value={customTip}
        onChange={setCustomTip}
        onEnter={() => setActiveInput(null)}
        onClose={() => setActiveInput(null)}
        label="Custom tip amount"
        allowDecimal={true}
      />

      {/* Virtual Keyboard for gift card code */}
      <VirtualKeyboard
        visible={activeInput === "gift_code"}
        value={giftCardCode}
        onChange={(v) => { setGiftCardCode(v); setGiftCardError(null); }}
        onEnter={() => {
          setActiveInput(null);
          const found = giftCards.find((gc) => gc.code === giftCardCode && gc.status === "active");
          if (found) {
            setGiftCardLookup(found);
            setGiftCardError(null);
            setGiftCardRedeemAmount(Math.min(found.balance, grandTotal).toFixed(2));
          } else {
            setGiftCardLookup(null);
            setGiftCardError("Card not found or not active");
          }
        }}
        onClose={() => setActiveInput(null)}
        label="Gift card code"
      />
    </div>
  );
});

function CashKey({
  label,
  onPress,
  variant = "default",
}: {
  label: string;
  onPress: () => void;
  variant?: "default" | "action";
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className={`flex items-center justify-center rounded-full aspect-square font-bold transition-colors active:scale-95 touch-manipulation select-none shadow-sm ${
        variant === "action"
          ? "bg-zinc-300 text-zinc-700 active:bg-zinc-400"
          : "bg-zinc-100 text-zinc-900 active:bg-zinc-200 hover:bg-zinc-200"
      }`}
      style={{ fontSize: "clamp(2rem, 5vw, 4rem)", lineHeight: 1 }}
    >
      {label}
    </button>
  );
}

function computeQuickCash(total: number): number[] {
  const exact = Number(total.toFixed(2));
  const amounts = [exact];
  const rounded = Math.ceil(total);
  if (rounded > exact) amounts.push(rounded);
  const next5 = Math.ceil(total / 5) * 5;
  if (next5 > exact && !amounts.includes(next5)) amounts.push(next5);
  const next10 = Math.ceil(total / 10) * 10;
  if (next10 > exact && !amounts.includes(next10)) amounts.push(next10);
  const next20 = Math.ceil(total / 20) * 20;
  if (next20 > exact && !amounts.includes(next20) && amounts.length < 5) amounts.push(next20);
  return amounts.slice(0, 5);
}
