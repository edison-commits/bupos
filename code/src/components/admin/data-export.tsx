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
    </div>
  );
}
