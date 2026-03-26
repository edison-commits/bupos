"use client";

import { useState, useRef } from "react";
import { cn } from "@/lib/utils/cn";

export interface ImportRow {
  name: string;
  category: string;
  sku: string;
  variantName: string;
  price: number;
  cost: number;
  barcode: string;
  sizeLabel: string;
  colorLabel: string;
  openingStock: number;
  reorderPoint: number;
}

interface BulkProductImportProps {
  categories: { id: string; name: string }[];
  onImport?: (rows: ImportRow[]) => Promise<{ success: boolean; created: number; errors: string[] }>;
}

type ImportStatus = "idle" | "previewing" | "importing" | "done" | "error";

const EXPECTED_COLUMNS = [
  "name",
  "category",
  "sku",
  "variantName",
  "price",
  "cost",
  "barcode",
  "sizeLabel",
  "colorLabel",
  "openingStock",
  "reorderPoint",
];

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map((line) => parseCSVLine(line));

  return { headers, rows };
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function rowsToImportData(headers: string[], rows: string[][]): { data: ImportRow[]; errors: string[] } {
  const errors: string[] = [];
  const data: ImportRow[] = [];

  // Create header map
  const headerMap = new Map(headers.map((h, i) => [h.toLowerCase(), i]));

  // Check for missing columns
  const missingColumns = EXPECTED_COLUMNS.filter((col) => !headerMap.has(col.toLowerCase()));
  if (missingColumns.length > 0) {
    errors.push(`Missing columns: ${missingColumns.join(", ")}`);
    return { data, errors };
  }

  // Parse rows
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const rowNum = rowIdx + 2; // +2 because +1 for header, +1 for 1-based indexing

    try {
      const getCol = (col: string) => row[headerMap.get(col.toLowerCase()) ?? -1] ?? "";

      const name = getCol("name").trim();
      const category = getCol("category").trim();
      const sku = getCol("sku").trim();
      const variantName = getCol("variantName").trim();
      const price = parseFloat(getCol("price"));
      const cost = parseFloat(getCol("cost"));
      const barcode = getCol("barcode").trim();
      const sizeLabel = getCol("sizeLabel").trim();
      const colorLabel = getCol("colorLabel").trim();
      const openingStock = parseInt(getCol("openingStock"), 10);
      const reorderPoint = parseInt(getCol("reorderPoint"), 10);

      // Validation
      if (!name) errors.push(`Row ${rowNum}: name is required`);
      if (!category) errors.push(`Row ${rowNum}: category is required`);
      if (!sku) errors.push(`Row ${rowNum}: sku is required`);
      if (isNaN(price)) errors.push(`Row ${rowNum}: price must be a valid number`);
      if (isNaN(cost)) errors.push(`Row ${rowNum}: cost must be a valid number`);
      if (isNaN(openingStock)) errors.push(`Row ${rowNum}: openingStock must be a valid number`);
      if (isNaN(reorderPoint)) errors.push(`Row ${rowNum}: reorderPoint must be a valid number`);

      // Only add if basic fields are valid
      if (name && category && sku && !isNaN(price) && !isNaN(cost) && !isNaN(openingStock) && !isNaN(reorderPoint)) {
        data.push({
          name,
          category,
          sku,
          variantName: variantName || "Standard",
          price,
          cost,
          barcode: barcode || "",
          sizeLabel: sizeLabel || "",
          colorLabel: colorLabel || "",
          openingStock,
          reorderPoint,
        });
      }
    } catch (err) {
      errors.push(`Row ${rowNum}: Failed to parse row (${err instanceof Error ? err.message : "Unknown error"})`);
    }
  }

  return { data, errors };
}

function downloadTemplate() {
  const csv = EXPECTED_COLUMNS.join(",") + "\n";
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "product-import-template.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function BulkProductImport({ categories, onImport }: BulkProductImportProps) {
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [previewRows, setPreviewRows] = useState<ImportRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [missingColumns, setMissingColumns] = useState<string[]>([]);
  const [importedCount, setImportedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parsedDataRef = useRef<ImportRow[]>([]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const { headers, rows } = parseCSV(content);

        // Check for missing columns
        const headerSet = new Set(headers.map((h) => h.toLowerCase()));
        const missing = EXPECTED_COLUMNS.filter((col) => !headerSet.has(col.toLowerCase()));
        setMissingColumns(missing);

        const { data, errors: parseErrors } = rowsToImportData(headers, rows);

        setStatus("previewing");
        setTotalRows(data.length);
        setPreviewRows(data.slice(0, 10));
        setErrors(parseErrors);
        parsedDataRef.current = data;

        // Clear file input
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      } catch (err) {
        setStatus("error");
        setErrors([`Failed to parse file: ${err instanceof Error ? err.message : "Unknown error"}`]);
      }
    };

    reader.readAsText(file);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const file = e.dataTransfer.files?.[0];
    if (file && file.type === "text/csv") {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const content = ev.target?.result as string;
          const { headers, rows } = parseCSV(content);

          const headerSet2 = new Set(headers.map((h) => h.toLowerCase()));
          const missing = EXPECTED_COLUMNS.filter((col) => !headerSet2.has(col.toLowerCase()));
          setMissingColumns(missing);

          const { data, errors: parseErrors } = rowsToImportData(headers, rows);

          setStatus("previewing");
          setTotalRows(data.length);
          setPreviewRows(data.slice(0, 10));
          setErrors(parseErrors);
          parsedDataRef.current = data;
        } catch (err) {
          setStatus("error");
          setErrors([`Failed to parse file: ${err instanceof Error ? err.message : "Unknown error"}`]);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleImport = async () => {
    setStatus("importing");
    try {
      const fallback = async () => ({ success: true, created: 0, errors: ["Bulk import requires server action — coming soon."] });
      const result = await (onImport ?? fallback)(parsedDataRef.current);
      if (result.success) {
        setStatus("done");
        setImportedCount(result.created);
        setPreviewRows([]);
        setTotalRows(0);
        parsedDataRef.current = [];
        setErrors(result.errors);
      } else {
        setStatus("error");
        setErrors(result.errors || ["Import failed"]);
      }
    } catch (err) {
      setStatus("error");
      setErrors([`Import error: ${err instanceof Error ? err.message : "Unknown error"}`]);
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setPreviewRows([]);
    setTotalRows(0);
    setErrors([]);
    setMissingColumns([]);
    setImportedCount(0);
    parsedDataRef.current = [];
  };

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Bulk Product Import</h3>
        <p className="mt-1 text-sm text-zinc-600">Upload a CSV file to create multiple products at once</p>
      </div>

      {status === "idle" && (
        <div className="space-y-4">
          <div
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="rounded-2xl border-2 border-dashed border-zinc-300 bg-zinc-50 p-8 text-center hover:border-teal-400 hover:bg-teal-50 transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="flex flex-col items-center gap-2">
              <svg className="w-8 h-8 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
              </svg>
              <div>
                <p className="text-sm font-medium text-zinc-700">Drag and drop your CSV here</p>
                <p className="text-xs text-zinc-500">or click to select a file</p>
              </div>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileSelect}
            className="hidden"
          />

          <button
            onClick={downloadTemplate}
            className="w-full rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            Download template
          </button>
        </div>
      )}

      {(status === "previewing" || status === "importing" || status === "done" || status === "error") && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-700">
                {status === "done" ? `Imported ${importedCount} products` : `${totalRows} rows ready to import`}
              </p>
              <p className="text-xs text-zinc-500">Showing first 10 rows</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={downloadTemplate}
                className="rounded-xl border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
              >
                Download template
              </button>
              <button
                onClick={handleReset}
                className="rounded-xl border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>

          {missingColumns.length > 0 && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-3">
              <p className="text-sm font-medium text-amber-900">Missing columns:</p>
              <p className="text-xs text-amber-700">{missingColumns.join(", ")}</p>
            </div>
          )}

          {errors.length > 0 && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3">
              <p className="text-sm font-medium text-red-900">Errors found:</p>
              <div className="mt-1 space-y-0.5">
                {errors.slice(0, 5).map((error, i) => (
                  <p key={i} className="text-xs text-red-700">
                    • {error}
                  </p>
                ))}
                {errors.length > 5 && (
                  <p className="text-xs text-red-700">• ... and {errors.length - 5} more errors</p>
                )}
              </div>
            </div>
          )}

          {previewRows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50">
                    <th className="px-3 py-2 text-left font-medium text-zinc-600">Name</th>
                    <th className="px-3 py-2 text-left font-medium text-zinc-600">Category</th>
                    <th className="px-3 py-2 text-left font-medium text-zinc-600">SKU</th>
                    <th className="px-3 py-2 text-left font-medium text-zinc-600">Variant</th>
                    <th className="px-3 py-2 text-right font-medium text-zinc-600">Price</th>
                    <th className="px-3 py-2 text-right font-medium text-zinc-600">Cost</th>
                    <th className="px-3 py-2 text-right font-medium text-zinc-600">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i} className={cn("border-b border-zinc-100", i % 2 === 0 ? "bg-white" : "bg-zinc-50")}>
                      <td className="px-3 py-2 truncate">{row.name}</td>
                      <td className="px-3 py-2 truncate">{row.category}</td>
                      <td className="px-3 py-2 truncate text-zinc-600">{row.sku}</td>
                      <td className="px-3 py-2 truncate text-zinc-600">{row.variantName}</td>
                      <td className="px-3 py-2 text-right">${row.price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">${row.cost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{row.openingStock}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {status === "importing" && (
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 text-center">
              <p className="text-sm font-medium text-blue-900">Importing products...</p>
              <p className="mt-1 text-xs text-blue-700">Please wait while we process your data.</p>
            </div>
          )}

          {status === "done" && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-center">
              <p className="text-sm font-medium text-emerald-900">Import completed successfully!</p>
              <p className="mt-1 text-xs text-emerald-700">{importedCount} products have been created.</p>
            </div>
          )}

          <div className="flex gap-3">
            {status !== "done" && status !== "importing" && (
              <button
                onClick={handleImport}
                disabled={missingColumns.length > 0 || totalRows === 0}
                className={cn(
                  "flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition-colors touch-button",
                  missingColumns.length > 0 || totalRows === 0
                    ? "bg-zinc-200 text-zinc-500 cursor-not-allowed"
                    : "bg-teal-600 text-white hover:bg-teal-700"
                )}
              >
                Import {totalRows} products
              </button>
            )}
            {status !== "importing" && (
              <button
                onClick={handleReset}
                className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
              >
                {status === "done" ? "Import another file" : "Cancel"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
