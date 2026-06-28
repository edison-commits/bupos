import type { StockoutRisk } from "@/lib/inventory/forecast";
import { getInventoryForecast, type InventoryForecastRow } from "@/lib/inventory/forecast-report";
import { getPool } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";

export interface ForecastPurchaseOrderLineDraft {
  productVariantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitCost: number;
}

export interface ForecastPurchaseOrderDraft {
  supplierId: string;
  supplierName: string;
  locationId: string;
  locationName: string;
  lines: ForecastPurchaseOrderLineDraft[];
}

export type ForecastPurchaseOrderSkipReason = "missing_supplier" | "no_suggested_quantity";

export interface ForecastPurchaseOrderSkippedRow {
  productVariantId: string;
  sku: string;
  productName: string;
  reason: ForecastPurchaseOrderSkipReason;
}

export interface ForecastPurchaseOrderGroupingResult {
  drafts: ForecastPurchaseOrderDraft[];
  skipped: ForecastPurchaseOrderSkippedRow[];
}

export interface CreatePurchaseOrdersFromForecastParams {
  orgId: string;
  employeeId: string;
  locationId?: string;
  risks: StockoutRisk[];
  variantIds?: string[];
}

export interface CreatedForecastPurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  locationId: string;
  locationName: string;
  lineCount: number;
}

export interface CreatePurchaseOrdersFromForecastResult {
  orders: CreatedForecastPurchaseOrder[];
  skipped: ForecastPurchaseOrderSkippedRow[];
}

function draftKey(row: InventoryForecastRow): string {
  return `${row.supplierId ?? ""}:${row.locationId}`;
}

export function groupForecastRowsForPurchaseOrders(rows: InventoryForecastRow[]): ForecastPurchaseOrderGroupingResult {
  const draftsByKey = new Map<string, ForecastPurchaseOrderDraft>();
  const skipped: ForecastPurchaseOrderSkippedRow[] = [];

  for (const row of rows) {
    if (!row.supplierId) {
      skipped.push({
        productVariantId: row.variantId,
        sku: row.sku,
        productName: row.productName,
        reason: "missing_supplier",
      });
      continue;
    }
    if (row.suggestedReorderQty <= 0) {
      skipped.push({
        productVariantId: row.variantId,
        sku: row.sku,
        productName: row.productName,
        reason: "no_suggested_quantity",
      });
      continue;
    }

    const key = draftKey(row);
    let draft = draftsByKey.get(key);
    if (!draft) {
      draft = {
        supplierId: row.supplierId,
        supplierName: row.supplierName ?? "Unknown Supplier",
        locationId: row.locationId,
        locationName: row.locationName,
        lines: [],
      };
      draftsByKey.set(key, draft);
    }

    draft.lines.push({
      productVariantId: row.variantId,
      sku: row.sku,
      productName: row.productName,
      variantName: row.variantName,
      quantity: row.suggestedReorderQty,
      unitCost: row.unitCost,
    });
  }

  return {
    drafts: Array.from(draftsByKey.values()).sort((a, b) => {
      const supplier = a.supplierId.localeCompare(b.supplierId);
      if (supplier !== 0) return supplier;
      return a.locationId.localeCompare(b.locationId);
    }),
    skipped,
  };
}

function poPrefix(locationName: string, now: Date): string {
  const locCode = (locationName || "STR").slice(0, 3).toUpperCase();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${locCode}-PO-${yy}${mm}${dd}`;
}

export async function createPurchaseOrdersFromForecast(
  params: CreatePurchaseOrdersFromForecastParams,
): Promise<CreatePurchaseOrdersFromForecastResult> {
  const rows = await getInventoryForecast({ orgId: params.orgId, locationId: params.locationId, risk: "all", limit: 500 });
  const variantSet = params.variantIds ? new Set(params.variantIds) : null;
  const riskSet = new Set(params.risks);
  const selectedRows = rows.filter((row) => (variantSet ? variantSet.has(row.variantId) : riskSet.has(row.risk)));
  const grouped = groupForecastRowsForPurchaseOrders(selectedRows);
  if (grouped.drafts.length === 0) return { orders: [], skipped: grouped.skipped };

  const pool = await getPool();
  const client = await pool.connect();
  const created: CreatedForecastPurchaseOrder[] = [];

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [params.orgId]);
    const now = new Date();

    for (const draft of grouped.drafts) {
      let poResult: { rows: Array<Record<string, unknown>> } = { rows: [] };
      let poNumber = "";
      const prefix = poPrefix(draft.locationName, now);

      for (let attempt = 0; attempt < 5; attempt++) {
        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int as cnt FROM purchase_orders WHERE organization_id = $1 AND po_number LIKE $2`,
          [params.orgId, `${prefix}-%`],
        );
        const seq = (Number(countRows[0]?.cnt) || 0) + 1 + attempt;
        poNumber = `${prefix}-${String(seq).padStart(3, "0")}`;
        await client.query("SAVEPOINT sp_forecast_po_insert");
        try {
          poResult = await client.query(
            `INSERT INTO purchase_orders (organization_id, supplier_id, location_id, po_number, status, notes, expected_at)
             VALUES ($1, $2, $3, $4, 'draft', $5, null)
             RETURNING *`,
            [params.orgId, draft.supplierId, draft.locationId, poNumber, "Generated from inventory forecast"],
          );
          await client.query("RELEASE SAVEPOINT sp_forecast_po_insert");
          break;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT sp_forecast_po_insert").catch(() => {});
          const err = error as { code?: string };
          if (err.code !== "23505") throw error;
        }
      }

      if (poResult.rows.length === 0) throw new Error("Failed to generate unique PO number");
      const poId = String(poResult.rows[0].id);

      for (const line of draft.lines) {
        await client.query(
          `INSERT INTO purchase_order_lines (purchase_order_id, product_variant_id, quantity_ordered, unit_cost)
           VALUES ($1, $2, $3, $4)`,
          [poId, line.productVariantId, line.quantity, line.unitCost],
        );
      }

      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'purchase_order', $5, 'purchase_order_created', $6, now())`,
        [
          randomUUID(),
          params.orgId,
          draft.locationId,
          params.employeeId,
          poId,
          JSON.stringify({
            id: poId,
            po_number: poNumber,
            supplier_id: draft.supplierId,
            line_count: draft.lines.length,
            source: "inventory_forecast",
          }),
        ],
      );

      created.push({
        id: poId,
        poNumber,
        supplierId: draft.supplierId,
        supplierName: draft.supplierName,
        locationId: draft.locationId,
        locationName: draft.locationName,
        lineCount: draft.lines.length,
      });
    }

    await client.query("COMMIT");
    return { orders: created, skipped: grouped.skipped };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
