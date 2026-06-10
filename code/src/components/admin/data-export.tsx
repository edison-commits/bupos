"use client";

import type { LocalStoreData } from "@/lib/persistence/types";
import { csvCell } from "@/lib/format/csv-sanitize";

interface DataExportProps {
  store: LocalStoreData;
}

// R39-A2-7: delegate to the shared `csvCell` helper so every cell
// is formula-injection-sanitized (leading `=`/`+`/`-`/`@`/`\t`/`\r`
// prefix with `'` before quoting). The prior inline helper only
// double-quoted cells, which does NOT stop Excel from executing
// `"=HYPERLINK(…)"` when opened. Server-side `/api/export` uses the
// same shared helper so prevention stays in sync.
function downloadCSV(filename: string, headers: string[], rows: string[][]) {
  const csv = [
    headers.map((h) => csvCell(h)).join(","),
    ...rows.map((r) => r.map((cell) => csvCell(cell)).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataExport({ store }: DataExportProps) {
  const handleExportTransactions = () => {
    const headers = [
      "Date",
      "Transaction ID",
      "Employee",
      "Tender Type",
      "Amount",
      "Tax",
      "Discount",
      "Grand Total",
    ];
    const rows = store.transactionEventPlaceholders
      .filter((evt) => evt.eventKind === "transaction_placeholder")
      .map((evt) => {
        const emp = store.employees.find(
          (e) => e.id === evt.actorEmployeeId
        );
        const tenders = store.transactionTenderPlaceholders.filter(
          (t) => t.transactionId === evt.transactionId
        );
        const primaryTender =
          tenders.length > 0
            ? tenders[0].tenderType
            : evt.payload?.primary_tender_type ?? "unknown";
        const totalAmount = tenders.reduce((sum, t) => sum + t.amount, 0);

        return [
          evt.createdAt,
          evt.transactionId.slice(0, 8),
          emp?.displayName ?? "Unknown",
          primaryTender,
          totalAmount.toFixed(2),
          evt.payload?.tax_total ?? "0.00",
          evt.payload?.discount_amount ?? "0.00",
          evt.payload?.grand_total ?? "0.00",
        ];
      });

    downloadCSV(
      `transactions_${new Date().toISOString().split("T")[0]}.csv`,
      headers,
      rows
    );
  };

  const handleExportInventory = () => {
    const headers = [
      "SKU",
      "Product Name",
      "Variant Name",
      "On Hand",
      "Reserved",
      "Reorder Point",
      "Retail Value",
      "Cost Value",
    ];
    const rows = store.inventory.map((inv) => {
      const variant = store.variants.find(
        (v) => v.id === inv.productVariantId
      );
      const product = variant
        ? store.products.find((p) => p.id === variant.productId)
        : null;
      const retailValue = variant ? variant.price * inv.onHand : 0;
      const costValue = variant?.cost ? variant.cost * inv.onHand : 0;

      return [
        variant?.sku ?? "unknown",
        product?.name ?? "Unknown",
        variant?.name ?? "Unknown",
        String(inv.onHand),
        String(inv.reserved),
        String(inv.reorderPoint),
        retailValue.toFixed(2),
        costValue.toFixed(2),
      ];
    });

    downloadCSV(
      `inventory_${new Date().toISOString().split("T")[0]}.csv`,
      headers,
      rows
    );
  };

  const handleExportTenderSummary = () => {
    const headers = ["Tender Type", "Count", "Total Amount"];
    const tenderMap: Record<string, { count: number; total: number }> = {};

    store.transactionTenderPlaceholders.forEach((tender) => {
      if (!tenderMap[tender.tenderType]) {
        tenderMap[tender.tenderType] = { count: 0, total: 0 };
      }
      tenderMap[tender.tenderType].count += 1;
      tenderMap[tender.tenderType].total += tender.amount;
    });

    const rows = Object.entries(tenderMap).map(([type, data]) => [
      type,
      String(data.count),
      data.total.toFixed(2),
    ]);

    downloadCSV(
      `tender_summary_${new Date().toISOString().split("T")[0]}.csv`,
      headers,
      rows
    );
  };

  // P3.3: QuickBooks Online journal-import CSV (3-column format: one row per
  // account per day, paired Debits/Credits columns). Per local calendar day:
  //   Debits — tender totals by account (Cash on Hand, Card Clearing,
  //            gift-card/store-credit liabilities); transactions with no
  //            tender rows fall back to Undeposited Funds at grand_total.
  //   Credits — Sales Revenue (grand_total − tax) + Sales Tax Payable (tax).
  // Returns (negative amounts) flip to the opposite column so every figure
  // is positive, as the QBO importer expects. Days are bucketed in the
  // BROWSER'S timezone — same convention as the other exports on this panel.
  const handleExportQuickBooksJournal = () => {
    const TENDER_ACCOUNTS: Record<string, string> = {
      cash: "Cash on Hand",
      card: "Card Clearing",
      gift_card: "Gift Card Liability",
      store_credit: "Store Credit Liability",
      loyalty: "Loyalty Redemptions",
    };
    const localDay = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };

    // day → account → net amount (positive = debit for tender accounts,
    // positive = credit for revenue/tax; sign flips column at emit time).
    const days = new Map<string, Map<string, number>>();
    const bump = (day: string, account: string, amount: number) => {
      if (!days.has(day)) days.set(day, new Map());
      const m = days.get(day)!;
      m.set(account, (m.get(account) ?? 0) + amount);
    };

    const tendersByTxn = new Map<string, { tenderType: string; amount: number }[]>();
    store.transactionTenderPlaceholders.forEach((t) => {
      const arr = tendersByTxn.get(t.transactionId);
      if (arr) arr.push(t); else tendersByTxn.set(t.transactionId, [t]);
    });

    store.transactionEventPlaceholders
      .filter((evt) => evt.eventKind === "transaction_placeholder")
      .forEach((evt) => {
        const day = localDay(evt.createdAt);
        const grand = Number(evt.payload?.grand_total ?? 0);
        const tax = Number(evt.payload?.tax_total ?? 0);
        // Credit side: revenue (net of tax) + tax payable.
        bump(day, "credit:Sales Revenue", grand - tax);
        bump(day, "credit:Sales Tax Payable", tax);
        // Debit side: tenders (or Undeposited Funds when none recorded).
        const tenders = tendersByTxn.get(evt.transactionId) ?? [];
        if (tenders.length === 0) {
          bump(day, "debit:Undeposited Funds", grand);
        } else {
          tenders.forEach((t) => {
            const account = TENDER_ACCOUNTS[t.tenderType] ?? "Other Tenders Clearing";
            bump(day, `debit:${account}`, t.amount);
          });
        }
      });

    const headers = ["JournalNo", "JournalDate", "AccountName", "Debits", "Credits", "Description"];
    const rows: string[][] = [];
    [...days.keys()].sort().forEach((day) => {
      const journalNo = `BUPOS-${day.replace(/-/g, "")}`;
      [...days.get(day)!.entries()].forEach(([key, amount]) => {
        if (Math.abs(amount) < 0.005) return; // drop zero lines
        const [side, account] = key.split(":", 2) as ["debit" | "credit", string];
        // Negative nets (refund-heavy days) flip to the opposite column.
        const effSide = amount >= 0 ? side : side === "debit" ? "credit" : "debit";
        const abs = Math.abs(amount).toFixed(2);
        rows.push([
          journalNo,
          day,
          account,
          effSide === "debit" ? abs : "",
          effSide === "credit" ? abs : "",
          `BuPOS daily sales ${day}`,
        ]);
      });
    });

    downloadCSV(
      `quickbooks_journal_${new Date().toISOString().split("T")[0]}.csv`,
      headers,
      rows
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={handleExportTransactions}
        className="touch-button rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800"
      >
        Export Transactions CSV
      </button>
      <button
        onClick={handleExportInventory}
        className="touch-button rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800"
      >
        Export Inventory CSV
      </button>
      <button
        onClick={handleExportTenderSummary}
        className="touch-button rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800"
      >
        Export Tender Summary CSV
      </button>
      <button
        onClick={handleExportQuickBooksJournal}
        className="touch-button rounded-2xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800"
      >
        Export QuickBooks Journal CSV
      </button>
      <p className="text-xs text-zinc-500">
        The QuickBooks export is a daily sales journal (debits: tenders; credits: Sales Revenue + Sales Tax
        Payable) in QBO&apos;s 3-column journal-import format — import via Settings → Import Data → Journal Entries.
      </p>
    </div>
  );
}
