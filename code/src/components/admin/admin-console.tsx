/* eslint-disable @typescript-eslint/no-unused-vars, @next/next/no-img-element */
import dynamic from "next/dynamic";
import type { InputHTMLAttributes } from "react";
import { adminLogoutAction, adjustInventoryAction, createCategoryAction, createEmployeeAction, createProductAction, toggleEmployeeAction, updateOrganizationAction, updateLocationAction, editCategoryAction, deleteCategoryAction, editProductAction, deleteProductAction, editVariantAction, deleteVariantAction } from "@/app/admin/actions";
// R48: shared double-submit guard. Every `<form action={...Action}>`
// that mutates server state in this file is wrapped so a fast
// double-tap can't fire two concurrent invocations.
import { SubmitGuardForm } from "@/components/shared/submit-guard-form";
// R50/R51: step-up <PasswordGate> wrapper. Three server actions in
// this file gate on requireStepUp and read `actorPassword` from
// FormData — the backend was wired in R49 but the UI prompt was
// deferred. R50 audit flagged this; this wraps the three forms.
import { PasswordGatedForm } from "@/components/shared/password-gated-form";

// Lightweight/always-used components: keep static
import { DashboardKPIs } from "@/components/admin/dashboard-kpis";
import { DashboardCharts } from "@/components/admin/dashboard-charts-lazy";
import { AdminLayout, SectionPanel } from "@/components/admin/admin-sidebar";
import { SectionCard } from "@/components/ui/section-card";
import { TimezoneBootstrap } from "@/components/system/timezone-bootstrap";

// Heavy / section-specific components: code-split with next/dynamic so they
// don't ship on first load. SSR disabled to avoid duplicate render work.
const BarcodeLabelPrinter = dynamic(() => import("@/components/admin/barcode-label-printer").then(m => ({ default: m.BarcodeLabelPrinter })));
const BehaviorDashboard = dynamic(() => import("@/components/admin/behavior-dashboard").then(m => ({ default: m.BehaviorDashboard })));
const BulkProductImport = dynamic(() => import("@/components/admin/bulk-product-import").then(m => ({ default: m.BulkProductImport })));
const BundleManager = dynamic(() => import("@/components/admin/bundle-manager").then(m => ({ default: m.BundleManager })));
const EmployeeScheduler = dynamic(() => import("@/components/admin/employee-scheduler").then(m => ({ default: m.EmployeeScheduler })));
const InventoryBrowser = dynamic(() => import("@/components/admin/inventory-browser").then(m => ({ default: m.InventoryBrowser })));
const BarcodeLookup = dynamic(() => import("@/components/admin/barcode-lookup").then(m => ({ default: m.BarcodeLookup })));
const GiftCardManager = dynamic(() => import("@/components/admin/gift-card-manager").then(m => ({ default: m.GiftCardManager })));
const LayawayManager = dynamic(() => import("@/components/admin/layaway-manager").then(m => ({ default: m.LayawayManager })));
const PurchaseOrderManager = dynamic(() => import("@/components/admin/purchase-order-manager").then(m => ({ default: m.PurchaseOrderManager })));
const SupplierManager = dynamic(() => import("@/components/admin/supplier-manager").then(m => ({ default: m.SupplierManager })));
const ReorderSuggestions = dynamic(() => import("@/components/admin/reorder-suggestions").then(m => ({ default: m.ReorderSuggestions })));
const ReturnsManager = dynamic(() => import("@/components/admin/returns-manager").then(m => ({ default: m.ReturnsManager })));
const CustomerDatabase = dynamic(() => import("@/components/admin/customer-database").then(m => ({ default: m.CustomerDatabase })));
const ExpenseTracker = dynamic(() => import("@/components/admin/expense-tracker").then(m => ({ default: m.ExpenseTracker })));
const StocktakeManager = dynamic(() => import("@/components/admin/stocktake-manager").then(m => ({ default: m.StocktakeManager })));
const StoreCreditManager = dynamic(() => import("@/components/admin/store-credit-manager").then(m => ({ default: m.StoreCreditManager })));
const TransferManager = dynamic(() => import("@/components/admin/transfer-manager").then(m => ({ default: m.TransferManager })));
const LowStockAutoReorder = dynamic(() => import("@/components/admin/low-stock-reorder").then(m => ({ default: m.LowStockAutoReorder })));
const ProfitMarginDashboard = dynamic(() => import("@/components/admin/profit-margin-dashboard").then(m => ({ default: m.ProfitMarginDashboard })));
const RecountScheduler = dynamic(() => import("@/components/admin/recount-scheduler").then(m => ({ default: m.RecountScheduler })));
const TimesheetView = dynamic(() => import("@/components/admin/timesheet-view").then(m => ({ default: m.TimesheetView })));
const ZReport = dynamic(() => import("@/components/admin/z-report").then(m => ({ default: m.ZReport })));
const SalesReports = dynamic(() => import("@/components/admin/sales-reports").then(m => ({ default: m.SalesReports })));
const DataExport = dynamic(() => import("@/components/admin/data-export").then(m => ({ default: m.DataExport })));
const CustomerReceiptLookup = dynamic(() => import("@/components/admin/customer-receipt-lookup").then(m => ({ default: m.CustomerReceiptLookup })));
const DiscountScheduler = dynamic(() => import("@/components/admin/discount-scheduler").then(m => ({ default: m.DiscountScheduler })));
const EmployeePerformance = dynamic(() => import("@/components/admin/employee-performance").then(m => ({ default: m.EmployeePerformance })));
const TaxReport = dynamic(() => import("@/components/admin/tax-report").then(m => ({ default: m.TaxReport })));
const SalesDigestSettings = dynamic(() => import("@/components/admin/sales-digest-settings").then(m => ({ default: m.SalesDigestSettings })));
const OrderCalendar = dynamic(() => import("@/components/admin/order-calendar").then(m => ({ default: m.OrderCalendar })));
const DailyManagerReport = dynamic(() => import("@/components/admin/daily-manager-report").then(m => ({ default: m.DailyManagerReport })));
const MultiLocationDashboard = dynamic(() => import("@/components/admin/multi-location-dashboard").then(m => ({ default: m.MultiLocationDashboard })));
const LoyaltyTiers = dynamic(() => import("@/components/admin/loyalty-tiers").then(m => ({ default: m.LoyaltyTiers })));
const PayrollSummary = dynamic(() => import("@/components/admin/payroll-summary").then(m => ({ default: m.PayrollSummary })));

import { canManageEmployeeRole } from "@/lib/authz";
import { hasPermission, roleDefinitions } from "@/lib/domain/permissions";
import type { RoleKey } from "@/lib/domain/types";
import type { LocalStoreData } from "@/lib/persistence/types";
import { formatDateTime } from "@/lib/utils/date";
import {
  SalesSummary as SalesSummaryWidget,
  ShiftHistory as ShiftHistoryWidget,
  EmployeeActivity as EmployeeActivityWidget,
  CustomerActivity as CustomerActivityWidget,
  CashierExceptions as CashierExceptionsWidget,
  DiscrepancyCorrelation as DiscrepancyCorrelationWidget,
  InventorySummary as InventorySummaryWidget,
  Metric as MetricWidget,
} from "@/components/admin/admin-dashboard-widgets";
import { formatCurrency } from "@/lib/format";

export function AdminConsole({
  store: rawStore,
  adminName,
  adminRole,
  notice,
  error,
}: {
  store: LocalStoreData;
  adminName: string;
  adminRole: RoleKey;
  notice?: string;
  error?: string;
}) {
  // Safety: ensure all array fields exist (RSC serialization may drop undefined,
  // and Neon connection drops can produce partial store data)
  const _defaults: Record<string, unknown[]> = {
    locations: [], employees: [], categories: [], products: [], variants: [],
    inventory: [], customers: [], modifierGroups: [], modifiers: [],
    authCredentials: [], sessions: [], shifts: [], registerSessions: [],
    payInOuts: [], promoCodes: [], roles: [],
    inventoryAdjustments: [], transactionEventPlaceholders: [],
    transactionTenderPlaceholders: [], transactionExceptionPlaceholders: [],
    giftCards: [], giftCardTransactions: [], storeCreditLedger: [],
    behaviorFlags: [], layaways: [], layawayPayments: [],
    stocktakes: [], stocktakeLines: [], transfers: [], transferLines: [],
    timeClockEntries: [], promoRedemptions: [], bundles: [],
    suppliers: [], purchaseOrders: [], registers: [], recountSchedules: [],
  };
  // Strip explicit `undefined` values from rawStore so they don't override defaults
  const cleanRaw = Object.fromEntries(Object.entries(rawStore).filter(([, v]) => v !== undefined));
  const store = { ..._defaults, ...cleanRaw } as LocalStoreData;
  const canManageCatalog = hasPermission(adminRole, "catalog.manage");
  const canAdjustInventory = hasPermission(adminRole, "inventory.adjust");
  const canManageEmployees = hasPermission(adminRole, "employee.manage");
  const manageableRoles = roleDefinitions.filter((role) => canManageEmployeeRole(adminRole, role.key));

  // Pre-build lookup maps once — avoids O(N*M) .find() calls inside .map() loops
  const categoriesById = new Map(store.categories.map(c => [c.id, c]));
  const variantsByProductId = new Map<string, typeof store.variants>();
  for (const v of store.variants) {
    const arr = variantsByProductId.get(v.productId);
    if (arr) arr.push(v); else variantsByProductId.set(v.productId, [v]);
  }
  const variantsById = new Map(store.variants.map(v => [v.id, v]));
  const locationsById = new Map(store.locations.map(l => [l.id, l]));

  const productRows = store.products.map((product) => ({
    ...product,
    category: categoriesById.get(product.categoryId),
    variants: variantsByProductId.get(product.id) ?? [],
  }));

  const inventoryRows = store.inventory.map((row) => ({
    ...row,
    variant: variantsById.get(row.productVariantId),
    location: locationsById.get(row.locationId),
  }));

  const sidebarHeader = (
    <div className="border-b border-zinc-100 px-3 pb-3">
      <p className="text-xs text-zinc-400">Signed in as</p>
      <p className="truncate text-sm font-semibold">{adminName}</p>
      <p className="text-xs text-zinc-500">{adminRole}</p>
      <form action={adminLogoutAction} className="mt-2">
        <button className="w-full rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200">Sign out</button>
      </form>
    </div>
  );

  return (
    <AdminLayout header={sidebarHeader}>
      <TimezoneBootstrap timezone={store.organization?.timezone} />
      {notice ? <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}

      {/* ━━ Dashboard ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="dashboard">
        <SectionCard title="Dashboard" description="Real-time key performance indicators for today.">
          <DashboardKPIs store={store} locationId={store.locations[0]?.id ?? ""} />
        </SectionCard>

        <SectionCard title="Sales summary" description="Transaction activity and tender breakdown.">
          <SalesSummaryWidget store={store} />
        </SectionCard>

        <SectionCard title="Customer activity" description="Top customers by spend and visit frequency.">
          <CustomerActivityWidget customers={store.customers} />
        </SectionCard>

        <SectionCard title="Analytics" description="Visual sales trends and distribution charts.">
          <DashboardCharts store={store} />
        </SectionCard>

        <SectionCard title="Multi-location comparison" description="Compare performance metrics across store locations side by side.">
          <MultiLocationDashboard store={store} />
        </SectionCard>
      </SectionPanel>

      {/* ━━ Catalog ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="catalog">
        <SectionCard title="Catalog snapshot" description="Categories and products with variant details.">
          <div className="grid gap-3 md:grid-cols-3">
            <MetricWidget label="Categories" value={String(store.categories.length)} />
            <MetricWidget label="Products" value={String(store.products.length)} />
            <MetricWidget label="Variants" value={String(store.variants.length)} />
          </div>
          
          <div className="mt-6 space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">Products</h3>
            {productRows.map((product) => (
              <div key={product.id} className="rounded-2xl border border-zinc-200 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-1 items-start gap-3">
                    {product.imageUrl && (
                      <img src={product.imageUrl} alt={product.name} className="h-12 w-12 shrink-0 rounded-xl object-cover" />
                    )}
                    <div>
                      <h3 className="font-semibold">{product.name}</h3>
                      <p className="text-sm text-zinc-600">{product.category?.name ?? "Uncategorized"}</p>
                    </div>
                  </div>
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700">{product.variants.length} variants</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
                  {product.variants.map((variant) => (
                    <span key={variant.id} className="rounded-full bg-teal-50 px-3 py-1 text-teal-800">
                      {variant.sku} · {formatCurrency(variant.price)}
                    </span>
                  ))}
                </div>
                
                {canManageCatalog && (
                  <details className="mt-3 cursor-pointer">
                    <summary className="text-xs font-semibold text-teal-700 hover:text-teal-800">Edit product</summary>
                    <div className="mt-3 space-y-3 rounded-xl bg-zinc-50 p-3">
                      <SubmitGuardForm action={editProductAction} className="grid gap-2">
                        <input type="hidden" name="productId" value={product.id} />
                        <Input name="name" label="Product name" defaultValue={product.name} />
                        <label className="grid gap-1 text-sm font-medium text-zinc-700">
                          <span>Category</span>
                          <select name="categoryId" defaultValue={product.categoryId} className="rounded-2xl border border-zinc-300 bg-white px-4 py-3">
                            {store.categories.map((category) => (
                              <option key={category.id} value={category.id}>{category.name}</option>
                            ))}
                          </select>
                        </label>
                        <Input name="description" label="Description" defaultValue={product.description ?? ""} />
                        <Input name="imageUrl" label="Image URL" defaultValue={product.imageUrl ?? ""} />
                        <label className="inline-flex items-center gap-3 text-sm font-medium text-zinc-700">
                          <input name="isActive" type="checkbox" defaultChecked={product.isActive} className="h-4 w-4 rounded border-zinc-300" />
                          Active
                        </label>
                        <label className="inline-flex items-center gap-3 text-sm font-medium text-zinc-700">
                          <input name="isTouchFavorite" type="checkbox" defaultChecked={product.isTouchFavorite} className="h-4 w-4 rounded border-zinc-300" />
                          Touch favorite
                        </label>
                        <button className="touch-button rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white">Save product</button>
                      </SubmitGuardForm>
                      <SubmitGuardForm action={deleteProductAction}>
                        <input type="hidden" name="productId" value={product.id} />
                        <button className="touch-button w-full rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">Delete product</button>
                      </SubmitGuardForm>
                    </div>
                  </details>
                )}
                
                {product.variants.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {product.variants.map((variant) => (
                      <div key={variant.id} className="border-t border-zinc-200 pt-2">
                        {canManageCatalog && (
                          <details className="cursor-pointer">
                            <summary className="text-xs font-semibold text-teal-700 hover:text-teal-800">Edit {variant.sku}</summary>
                            <div className="mt-2 space-y-2 rounded-xl bg-zinc-50 p-3">
                              <PasswordGatedForm
                                action={editVariantAction}
                                prompt={{
                                  title: `Reprice ${variant.sku}?`,
                                  description:
                                    "Changing price or cost is fraud-relevant. Confirm with your password — non-pricing edits (SKU, barcode, labels) don't require step-up.",
                                  confirmLabel: "Save variant",
                                  confirmVariant: "default",
                                }}
                                gateCondition={(_fd, form) => {
                                  // R51: mirror the server-side snapshot-compare
                                  // in editVariantAction (src/app/admin/actions.ts).
                                  // Step-up fires only when price or cost actually
                                  // changes vs. the pre-edit value. Checking
                                  // `.value !== .defaultValue` at submit-time
                                  // matches the server's `Math.abs(prior - new) > 0.005`
                                  // rule for practical UI purposes: identical
                                  // values don't prompt; any digit change does.
                                  const priceInp = form.querySelector<HTMLInputElement>('input[name="price"]');
                                  const costInp = form.querySelector<HTMLInputElement>('input[name="cost"]');
                                  const priceChanged = priceInp ? priceInp.value !== priceInp.defaultValue : false;
                                  const costChanged = costInp ? costInp.value !== costInp.defaultValue : false;
                                  return priceChanged || costChanged;
                                }}
                                className="grid gap-2"
                              >
                                <input type="hidden" name="variantId" value={variant.id} />
                                <Input name="name" label="Variant name" defaultValue={variant.name} />
                                <Input name="sku" label="SKU" defaultValue={variant.sku} />
                                <Input name="barcode" label="Barcode" defaultValue={variant.barcode ?? ""} />
                                <Input name="price" label="Price" type="number" step="0.01" defaultValue={String(variant.price)} />
                                <Input name="cost" label="Cost" type="number" step="0.01" defaultValue={String(variant.cost ?? "")} />
                                <Input name="sizeLabel" label="Size" defaultValue={variant.sizeLabel ?? ""} />
                                <Input name="colorLabel" label="Color" defaultValue={variant.colorLabel ?? ""} />
                                <label className="inline-flex items-center gap-3 text-sm font-medium text-zinc-700">
                                  <input name="isActive" type="checkbox" defaultChecked={variant.isActive} className="h-4 w-4 rounded border-zinc-300" />
                                  Active
                                </label>
                                <button type="submit" className="touch-button rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white">Save variant</button>
                              </PasswordGatedForm>
                              <SubmitGuardForm action={deleteVariantAction}>
                                <input type="hidden" name="variantId" value={variant.id} />
                                <button className="touch-button w-full rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">Delete variant</button>
                              </SubmitGuardForm>
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          
          {canManageCatalog && (
            <div className="mt-6 space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">Categories</h3>
              {store.categories.map((cat) => (
                <div key={cat.id} className="rounded-2xl border border-zinc-200 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-zinc-700">{cat.name}</span>
                    <details className="cursor-pointer">
                      <summary className="text-xs font-semibold text-teal-700 hover:text-teal-800">Edit</summary>
                      <div className="mt-2 space-y-2 rounded-xl bg-zinc-50 p-3">
                        <SubmitGuardForm action={editCategoryAction} className="grid gap-2">
                          <input type="hidden" name="categoryId" value={cat.id} />
                          <Input name="name" label="Category name" defaultValue={cat.name} />
                          <Input name="imageUrl" label="Image URL" defaultValue={cat.imageUrl ?? ""} />
                          <button className="touch-button rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white">Save category</button>
                        </SubmitGuardForm>
                        <SubmitGuardForm action={deleteCategoryAction}>
                          <input type="hidden" name="categoryId" value={cat.id} />
                          <button className="touch-button w-full rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">Delete category</button>
                        </SubmitGuardForm>
                      </div>
                    </details>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <div className="grid gap-6 xl:grid-cols-2">
          <SectionCard title="Create category" description="Minimal starter form for category structure.">
            {canManageCatalog ? (
              <SubmitGuardForm action={createCategoryAction} className="grid gap-3">
                <Input name="name" label="Category name" placeholder="Outerwear" />
                <Input name="imageUrl" label="Image URL" placeholder="https://..." />
                <button className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white">Add category</button>
              </SubmitGuardForm>
            ) : (
              <LockedMessage message="This role can view catalog structure but cannot change it." />
            )}
          </SectionCard>

          <SectionCard title="Create product + starter variant" description="Adds a product, its default variant, and an initial inventory row.">
            {canManageCatalog ? (
              <PasswordGatedForm
                action={createProductAction}
                prompt={{
                  title: "Create product + variant?",
                  description:
                    "Creating a product always sets a price on the starter variant — same fraud-relevant surface as a reprice. Confirm with your password.",
                  confirmLabel: "Create product",
                  confirmVariant: "default",
                }}
                className="grid gap-3 md:grid-cols-2"
              >
                <Input name="name" label="Product name" placeholder="Classic Zip Hoodie" />
                <label className="grid gap-1 text-sm font-medium text-zinc-700">
                  <span>Category</span>
                  <select name="categoryId" className="rounded-2xl border border-zinc-300 bg-white px-4 py-3">
                    {store.categories.map((category) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </select>
                </label>
                <Input name="sku" label="SKU" placeholder="TOP-HOOD-M-BLK" />
                <Input name="variantName" label="Variant label" placeholder="Medium / Black" />
                <Input name="price" label="Price" type="number" step="0.01" placeholder="48" />
                <Input name="cost" label="Cost" type="number" step="0.01" placeholder="18" />
                <Input name="barcode" label="Barcode" placeholder="0123456789012" />
                <Input name="sizeLabel" label="Size" placeholder="M" />
                <Input name="colorLabel" label="Color" placeholder="Black" />
                <Input name="openingStock" label="Opening stock" type="number" placeholder="12" />
                <Input name="reorderPoint" label="Reorder point" type="number" placeholder="4" />
                <Input name="imageUrl" label="Image URL" placeholder="https://..." />
                <label className="md:col-span-2 grid gap-1 text-sm font-medium text-zinc-700">
                  <span>Description</span>
                  <textarea name="description" className="min-h-28 rounded-2xl border border-zinc-300 bg-white px-4 py-3" placeholder="Touch-friendly featured product for the register grid." />
                </label>
                <label className="inline-flex items-center gap-3 text-sm font-medium text-zinc-700 md:col-span-2">
                  <input name="isTouchFavorite" type="checkbox" className="h-4 w-4 rounded border-zinc-300" />
                  Mark as touch favorite
                </label>
                <button type="submit" className="touch-button rounded-2xl bg-zinc-900 px-5 text-sm font-semibold text-white md:col-span-2">Create product</button>
              </PasswordGatedForm>
            ) : (
              <LockedMessage message="This role cannot create or edit products." />
            )}
          </SectionCard>
        </div>

        <SectionCard title="Product bundles" description="Sell groups of items together at a package price.">
          <BundleManager
            bundles={store.bundles ?? []}
            variants={store.variants}
            products={store.products}
          />
        </SectionCard>

        <SectionCard title="Bulk product import" description="Upload a CSV file to mass-create products with variants and opening stock.">
          <BulkProductImport
            categories={store.categories.map((c) => ({ id: c.id, name: c.name }))}
          />
        </SectionCard>

        <SectionCard title="Barcode label printing" description="Generate and print barcode labels for products. Uses Code128 barcodes from variant barcodes or SKUs.">
          <BarcodeLabelPrinter
            products={store.products}
            variants={store.variants}
          />
        </SectionCard>
      </SectionPanel>

      {/* ━━ Inventory ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="inventory">
        <SectionCard title="Barcode lookup &amp; add product" description="Scan or type a barcode to search your inventory and online UPC databases. Add new products directly from lookup results.">
          <BarcodeLookup categories={store.categories.map((c) => ({ id: c.id, name: c.name }))} />
        </SectionCard>

        <SectionCard title="Inventory browser" description="Search, filter, and browse inventory with server-side pagination. Click 'Matrix' on any product to see its size × color grid.">
          <InventoryBrowser categories={store.categories.map((c) => ({ id: c.id, name: c.name }))} />
        </SectionCard>

        <SectionCard title="Inventory levels" description="Current stock by variant and location.">
          <div className="space-y-3">
            {inventoryRows.map((row) => (
              <div key={row.id} className="rounded-2xl border border-zinc-200 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{row.variant?.name ?? row.productVariantId}</h3>
                    <p className="text-sm text-zinc-600">{row.variant?.sku ?? "No SKU"} · {row.location?.name}</p>
                  </div>
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-sm font-semibold text-zinc-800">On hand {row.onHand}</span>
                </div>
              </div>
            ))}
          </div>
          {canAdjustInventory ? (
            <PasswordGatedForm
              action={adjustInventoryAction}
              prompt={{
                title: "Confirm large inventory adjustment?",
                description:
                  "Large deltas can mint or destroy inventory value. Confirm with your password — small corrections don't require step-up.",
                confirmLabel: "Record adjustment",
                confirmVariant: "default",
              }}
              gateCondition={(fd) => {
                // R52-H: mirror server-side thresholds in
                // adjustInventoryAction (actions.ts:347-362).
                // |delta| > 5000 for owner/manager, > 500 for clerk.
                // Use the permissive manager threshold client-side so
                // the UI never prompts under it; the server re-
                // evaluates with the actor's real role. Submissions
                // that SHOULD gate (above threshold) get the prompt;
                // ones under it skip it and submit straight through.
                const delta = Number(fd.get("delta"));
                if (!Number.isFinite(delta)) return false;
                return Math.abs(delta) > 500;
              }}
              className="mt-5 grid gap-3 md:grid-cols-3"
            >
              <label className="grid gap-1 text-sm font-medium text-zinc-700 md:col-span-2">
                <span>Inventory row</span>
                <select name="inventoryLevelId" className="rounded-2xl border border-zinc-300 bg-white px-4 py-3">
                  {inventoryRows.map((row) => (
                    <option key={row.id} value={row.id}>{row.variant?.sku ?? row.id} · on hand {row.onHand}</option>
                  ))}
                </select>
              </label>
              <Input name="delta" label="Delta" type="number" placeholder="-1" />
              <label className="grid gap-1 text-sm font-medium text-zinc-700 md:col-span-2">
                <span>Reason</span>
                <select name="reason" className="rounded-2xl border border-zinc-300 bg-white px-4 py-3">
                  <option value="Cycle count correction">Cycle count correction</option>
                  <option value="Damaged / defective">Damaged / defective</option>
                  <option value="Received shipment">Received shipment</option>
                  <option value="Theft / shrinkage">Theft / shrinkage</option>
                  <option value="Transfer in">Transfer in</option>
                  <option value="Transfer out">Transfer out</option>
                  <option value="Return to vendor">Return to vendor</option>
                  <option value="Other">Other</option>
                </select>
              </label>
              <button type="submit" className="touch-button rounded-2xl bg-amber-600 px-5 text-sm font-semibold text-white md:col-span-3">Record adjustment</button>
            </PasswordGatedForm>
          ) : (
            <div className="mt-5"><LockedMessage message="This role can review inventory but cannot post adjustments." /></div>
          )}
          <div className="mt-5 space-y-2">
            <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">Recent adjustments</h3>
            {store.inventoryAdjustments.length === 0 ? (
              <p className="text-sm text-zinc-600">No inventory adjustments yet.</p>
            ) : (
              store.inventoryAdjustments.slice(0, 5).map((entry) => (
                <div key={entry.id} className="rounded-2xl bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
                  {entry.reason} · {entry.delta > 0 ? "+" : ""}{entry.delta} · resulting {entry.resultingOnHand} · {formatDateTime(entry.createdAt)}
                </div>
              ))
            )}
          </div>
        </SectionCard>

        <SectionCard title="Low stock alerts" description="Items at or below their reorder point.">
          {(() => {
            const lowStockRows = inventoryRows.filter((row) => row.onHand <= row.reorderPoint);
            if (lowStockRows.length === 0) {
              return <p className="text-sm text-zinc-600">All items are above their reorder points.</p>;
            }
            return (
              <div className="space-y-2">
                {lowStockRows.map((row) => (
                  <div key={row.id} className={`flex items-center justify-between rounded-2xl px-4 py-3 ${row.onHand === 0 ? "bg-red-50" : "bg-amber-50"}`}>
                    <div>
                      <p className="font-semibold">{row.variant?.name ?? row.productVariantId}</p>
                      <p className="text-xs text-zinc-500">{row.variant?.sku} · {row.location?.name}</p>
                    </div>
                    <div className="text-right">
                      <p className={`text-lg font-bold ${row.onHand === 0 ? "text-red-700" : "text-amber-700"}`}>{row.onHand}</p>
                      <p className="text-xs text-zinc-500">reorder at {row.reorderPoint}</p>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </SectionCard>

        <SectionCard title="Inventory summary" description="Stock levels, total value, and movement activity.">
          <InventorySummaryWidget store={store} />
        </SectionCard>

        <div className="grid gap-6 xl:grid-cols-2">
          <SectionCard title="Stocktakes" description="Physical inventory counts with expected vs actual comparison.">
            <StocktakeManager
              stocktakes={store.stocktakes}
              lines={store.stocktakeLines}
              locations={store.locations}
              variants={store.variants}
              products={store.products}
              categories={store.categories}
              employees={store.employees}
            />
          </SectionCard>

          <SectionCard title="Inter-store transfers" description="Move inventory between locations.">
            <TransferManager
              transfers={store.transfers}
              transferLines={store.transferLines}
              locations={store.locations}
              variants={store.variants}
              products={store.products}
              employees={store.employees}
            />
          </SectionCard>
        </div>

        <SectionCard title="Suppliers" description="Manage your vendors and suppliers. Add contact info, payment terms, and notes.">
          <SupplierManager />
        </SectionCard>

        <SectionCard title="Purchase orders" description="Create and track purchase orders from suppliers. Receive shipments to update inventory automatically.">
          <PurchaseOrderManager />
        </SectionCard>

        <SectionCard title="Low stock auto-reorder" description="Items below reorder point grouped by supplier. One-click to generate a draft PO.">
          <ReorderSuggestions />
        </SectionCard>

        <SectionCard title="Returns &amp; exchanges" description="Process returns, issue refunds or store credit, and automatically restock returned items.">
          <ReturnsManager />
        </SectionCard>

        <SectionCard title="Cycle count scheduler" description="Schedule automatic inventory cycle counts on a rotating basis.">
          <RecountScheduler
            schedules={store.recountSchedules ?? []}
            categories={store.categories}
            locations={store.locations}
          />
        </SectionCard>
      </SectionPanel>

      {/* ━━ Staff ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="staff">
        <div className="grid gap-6 xl:grid-cols-2">
          <SectionCard title="Employees" description="Manage employee accounts, roles and status.">
            <div className="space-y-3">
              {store.employees.map((employee) => {
                const canManageThisEmployee = canManageEmployees && canManageEmployeeRole(adminRole, employee.roleKey);
                return (
                  <div key={employee.id} className="rounded-2xl border border-zinc-200 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">{employee.displayName}</h3>
                        <p className="text-sm text-zinc-600">{employee.roleKey} · {employee.email ?? "PIN-only register user"}</p>
                      </div>
                      {canManageThisEmployee ? (
                        <PasswordGatedForm
                          action={toggleEmployeeAction}
                          prompt={{
                            title: employee.isActive
                              ? `Deactivate ${employee.displayName}?`
                              : `Reactivate ${employee.displayName}?`,
                            description:
                              "Confirm with your password — toggling employee status is privileged and step-up re-auth is required.",
                            confirmLabel: employee.isActive ? "Deactivate" : "Reactivate",
                            confirmVariant: employee.isActive ? "destructive" : "default",
                          }}
                        >
                          <input type="hidden" name="employeeId" value={employee.id} />
                          {/* R77-SEC-H: explicit "activate" |
                              "deactivate" instead of a blind toggle.
                              Prior shape let an attacker with a
                              stolen cookie chain deactivate →
                              reactivate to hide activity. Server now
                              rejects missing/invalid action. */}
                          <input
                            type="hidden"
                            name="action"
                            value={employee.isActive ? "deactivate" : "activate"}
                          />
                          <button type="submit" className={`rounded-full px-3 py-1 text-xs font-semibold text-white ${employee.isActive ? "bg-zinc-800" : "bg-red-700"}`}>
                            {employee.isActive ? "Active" : "Inactive"}
                          </button>
                        </PasswordGatedForm>
                      ) : (
                        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">Locked</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="Create employee" description="Provision new register and admin roles.">
            {canManageEmployees && manageableRoles.length > 0 ? (
              <PasswordGatedForm
                action={createEmployeeAction}
                prompt={{
                  title: "Create new employee?",
                  description:
                    "Provisioning an employee — especially an admin-capable role — is privilege-elevation. Confirm with your password.",
                  confirmLabel: "Create employee",
                  confirmVariant: "default",
                }}
                className="grid gap-3 md:grid-cols-2"
              >
                <Input name="firstName" label="First name" placeholder="Jordan" />
                <Input name="lastName" label="Last name" placeholder="Lee" />
                <label className="grid gap-1 text-sm font-medium text-zinc-700">
                  <span>Role</span>
                  <select name="roleKey" className="rounded-2xl border border-zinc-300 bg-white px-4 py-3">
                    {manageableRoles.map((role) => (
                      <option key={role.key} value={role.key}>{role.label}</option>
                    ))}
                  </select>
                </label>
                <Input name="pin" label="4-digit PIN" placeholder="4444" />
                <Input name="email" label="Email (optional for cashier)" placeholder="jordan@basicuniformpos.local" />
                <Input name="password" label="Password (needed for admin login roles)" type="password" placeholder="Temporary password" />
                <button type="submit" className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white md:col-span-2">Create employee</button>
              </PasswordGatedForm>
            ) : (
              <LockedMessage message="This role cannot provision employees." />
            )}
          </SectionCard>
        </div>

        <SectionCard title="Employee timesheet" description="Today's time clock activity.">
          <TimesheetView
            employees={store.employees}
            timeClockEntries={store.timeClockEntries}
            locationId={store.locations[0]?.id ?? ""}
          />
        </SectionCard>

        <SectionCard title="Suspicious behavior dashboard" description="Rule-based monitoring of employee activity patterns.">
          <BehaviorDashboard flags={store.behaviorFlags} employees={store.employees} />
        </SectionCard>

        <SectionCard title="Payroll summary" description="Calculate hours worked, overtime, gross pay from time clock data. Export CSV for payroll processing.">
          <PayrollSummary store={store} />
        </SectionCard>

        <SectionCard title="Employee scheduling" description="Plan weekly shifts, assign hours, copy schedules, and publish rosters.">
          <EmployeeScheduler employees={store.employees} />
        </SectionCard>
      </SectionPanel>

      {/* ━━ Sales ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="sales">
        <SectionCard title="Sales summary" description="Transaction activity and tender breakdown.">
          <SalesSummaryWidget store={store} />
        </SectionCard>

        <div className="grid gap-6 xl:grid-cols-2">
          <SectionCard title="Shift history" description="Closed shifts with cash reconciliation.">
            <ShiftHistoryWidget store={store} />
          </SectionCard>

          <SectionCard title="Employee activity" description="Sales, voids, and exceptions per employee.">
            <EmployeeActivityWidget store={store} />
          </SectionCard>
        </div>

        <SectionCard title="Customer database" description="Search, add, and manage customers. Track loyalty points, spend history, and store credit.">
          <CustomerDatabase />
        </SectionCard>

        <SectionCard title="Customer activity" description="Top customers by spend and visit frequency.">
          <CustomerActivityWidget customers={store.customers} />
        </SectionCard>

        <SectionCard title="Customer receipt lookup" description="Search past purchases by customer email or phone. Print or email receipts.">
          <CustomerReceiptLookup
            customers={store.customers}
            transactions={store.transactionEventPlaceholders}
            tenders={store.transactionTenderPlaceholders}
          />
        </SectionCard>

        <SectionCard title="Employee performance" description="Sales per hour, average ticket, void rate, and cash variance by cashier.">
          <EmployeePerformance
            employees={store.employees}
            transactions={store.transactionEventPlaceholders}
            tenders={store.transactionTenderPlaceholders}
            shifts={store.shifts}
            timeClockEntries={store.timeClockEntries}
            exceptions={store.transactionExceptionPlaceholders}
          />
        </SectionCard>

        <SectionCard title="Discount scheduling" description="Set up time-based promotions that auto-activate — happy hour, weekend sales, clearance events.">
          <DiscountScheduler
            categories={store.categories.map((c) => ({ id: c.id, name: c.name }))}
            products={store.products.map((p) => ({ id: p.id, name: p.name, categoryId: p.categoryId }))}
          />
        </SectionCard>
      </SectionPanel>

      {/* ━━ Reports ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="reports">
        <SectionCard title="Sales analytics" description="Sales breakdown by tender, employee, and time period.">
          <SalesReports store={store} />
        </SectionCard>

        <SectionCard title="End-of-day Z-Report" description="Comprehensive daily closing report.">
          <ZReport store={store} locationId={store.locations[0]?.id ?? ""} />
        </SectionCard>

        <div className="grid gap-6 xl:grid-cols-2">
          <SectionCard title="Cashier exception report" description="Flagged transactions, voids, and large discounts.">
            <CashierExceptionsWidget store={store} />
          </SectionCard>

          <SectionCard title="Discrepancy correlation" description="Cash variance patterns by cashier.">
            <DiscrepancyCorrelationWidget store={store} />
          </SectionCard>
        </div>

        <SectionCard title="Profit margins" description="Margin analysis by product, category, and inventory value.">
          <ProfitMarginDashboard
            products={store.products}
            variants={store.variants}
            categories={store.categories}
            inventory={store.inventory}
          />
        </SectionCard>

        <SectionCard title="Data export" description="Download transaction, inventory, and tender data as CSV for accounting software.">
          <DataExport store={store} />
        </SectionCard>

        <SectionCard title="Tax reporting" description="Generate tax period summaries with daily breakdowns for accountant handoff. Export to CSV.">
          <TaxReport store={store} />
        </SectionCard>

        <SectionCard title="Sales digest emails" description="Configure automated daily or weekly sales summary emails to your inbox.">
          <SalesDigestSettings store={store} />
        </SectionCard>

        <SectionCard title="Audit trail" description="Recent transaction events, exceptions, and audit entries.">
          <div className="grid gap-3 md:grid-cols-3">
            <MetricWidget label="Transaction tenders" value={String(store.transactionTenderPlaceholders.length)} />
            <MetricWidget label="Lifecycle events" value={String(store.transactionEventPlaceholders.length)} />
            <MetricWidget label="Exceptions" value={String(store.transactionExceptionPlaceholders.length)} />
          </div>
          {store.transactionEventPlaceholders.length > 0 && (
            <div className="mt-4 space-y-1">
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Recent events</p>
              {store.transactionEventPlaceholders.slice(0, 8).map((e) => (
                <div key={e.id} className="rounded-xl bg-zinc-50 px-4 py-2 text-sm text-zinc-700">
                  <span className="font-medium">{e.eventKind}</span> · {e.notes ?? e.transactionId.slice(0, 8)} · {formatDateTime(e.createdAt)}
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </SectionPanel>

      {/* ━━ Finance ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="finance">
        <SectionCard title="Expense tracker" description="Track store expenses by category with monthly summaries. Supports recurring expenses.">
          <ExpenseTracker />
        </SectionCard>

        <div className="grid gap-6 xl:grid-cols-2">
          <SectionCard title="Gift cards" description="Activate, reload, and manage gift card balances.">
            <GiftCardManager
              giftCards={store.giftCards}
              transactions={store.giftCardTransactions}
              employees={store.employees}
              customers={store.customers}
            />
          </SectionCard>

          <SectionCard title="Store credit" description="Issue and track store credit balances.">
            <StoreCreditManager
              customers={store.customers}
              ledger={store.storeCreditLedger}
              employees={store.employees}
            />
          </SectionCard>
        </div>

        <SectionCard title="Layaway orders" description="Deposit-now-pay-later workflows.">
          <LayawayManager
            layaways={store.layaways}
            payments={store.layawayPayments}
            customers={store.customers}
            employees={store.employees}
          />
        </SectionCard>

        <SectionCard title="Loyalty tiers" description="Configure bronze/silver/gold/platinum tiers with escalating earn rates, redemption bonuses, and perks.">
          <LoyaltyTiers
            customers={store.customers}
            currentConfig={store.registerConfiguration.loyalty}
          />
        </SectionCard>
      </SectionPanel>

      {/* ━━ Calendar ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="calendar">
        <SectionCard title="Order calendar" description="Plan ordering schedules, track shipments, and see estimated deliveries on a monthly calendar.">
          <OrderCalendar
            suppliers={store.suppliers ?? []}
            purchaseOrders={store.purchaseOrders ?? []}
            employees={store.employees.map((e) => ({ id: e.id, displayName: e.displayName }))}
            locations={store.locations.map((l) => ({ id: l.id, name: l.name, code: l.code }))}
            currentLocationId={store.locations[0]?.id ?? ""}
          />
        </SectionCard>
      </SectionPanel>

      {/* ━━ Daily Report ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="manager_report">
        <SectionCard title="Daily manager report" description="End-of-day operations snapshot with sales, staff performance, cash accountability, and action items.">
          <DailyManagerReport store={store} />
        </SectionCard>
      </SectionPanel>

      {/* ━━ Settings ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="settings">
        <SectionCard title="Store information" description="Business name, legal details, and contact info.">
          {/*
            Defensive: `store.organization` is populated by readStore
            on the happy path (postgres-read-store.ts:198 throws if
            missing), and admin/page.tsx redirects on readStore throw.
            But the React error boundary catching anything during a
            re-render still surfaces a useless "Admin Error" — making
            these accesses optional gives the user a recoverable UI
            even on a partial store snapshot.
          */}
          <SubmitGuardForm action={updateOrganizationAction} className="grid gap-3 md:grid-cols-2">
            <Input name="name" label="Store name" defaultValue={store.organization?.name ?? ""} />
            <Input name="legalName" label="Legal name" defaultValue={store.organization?.legalName ?? ""} />
            <Input name="phone" label="Phone" type="tel" defaultValue={store.organization?.phone ?? ""} />
            <Input name="email" label="Email" type="email" defaultValue={store.organization?.email ?? ""} />
            <Input name="website" label="Website" defaultValue={store.organization?.website ?? ""} />
            <div className="md:col-span-2">
              <button className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white">Save store info</button>
            </div>
          </SubmitGuardForm>
        </SectionCard>

        {store.locations.map((loc) => (
          <SectionCard key={loc.id} title={`Location: ${loc.name}`} description="Address, phone, and sales tax rate.">
            <PasswordGatedForm
              action={updateLocationAction}
              prompt={{
                title: "Confirm tax rate change?",
                description:
                  "Tax-rate mutation is the highest-fraud-risk admin change — skimming tax to external account is the classic vector. Confirm with your password.",
                confirmLabel: "Save location",
                confirmVariant: "default",
              }}
              gateCondition={(_fd, form) => {
                // R52-G: step-up fires ONLY when the taxRate input was
                // edited. Name/address/phone saves stay cookie-only.
                // The server-side gate in updateLocationAction
                // (actions.ts:934) ONLY checks `taxRate !== undefined`
                // — the field is always posted (defaultValue), so
                // every save used to trigger "password required" and
                // leave users stuck. Mirror the R51 editVariant
                // pattern: only prompt when the value actually
                // changed from defaultValue.
                const taxInp = form.querySelector<HTMLInputElement>('input[name="taxRate"]');
                return !!taxInp && taxInp.value !== taxInp.defaultValue;
              }}
              className="grid gap-3 md:grid-cols-2"
            >
              <input type="hidden" name="locationId" value={loc.id} />
              <Input name="locationName" label="Location name" defaultValue={loc.name} />
              <Input name="address1" label="Address" defaultValue={loc.address1} />
              <Input name="city" label="City" defaultValue={loc.city} />
              <Input name="region" label="State / Region" defaultValue={loc.region} />
              <Input name="postalCode" label="Postal code" defaultValue={loc.postalCode} />
              <Input name="locationPhone" label="Phone" type="tel" defaultValue={loc.phone ?? ""} />
              <Input name="taxRate" label="Tax rate (%)" type="number" step="0.01" defaultValue={String((loc.taxRate * 100).toFixed(2))} />
              <div className="md:col-span-2">
                <button type="submit" className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white">Save location</button>
              </div>
            </PasswordGatedForm>
          </SectionCard>
        ))}

        <SectionCard title="Receipt customization" description="Header and footer text shown on printed receipts.">
          <SubmitGuardForm action={updateOrganizationAction} className="grid gap-3">
            <input type="hidden" name="name" value={store.organization?.name ?? ""} />
            <input type="hidden" name="legalName" value={store.organization?.legalName ?? ""} />
            <label className="grid gap-1 text-sm font-medium text-zinc-700">
              <span>Receipt header (appears above store name)</span>
              <textarea name="receiptHeader" rows={2} className="rounded-2xl border border-zinc-300 bg-white px-4 py-3" defaultValue={store.organization?.receiptHeader ?? ""} />
            </label>
            <label className="grid gap-1 text-sm font-medium text-zinc-700">
              <span>Receipt footer</span>
              <textarea name="receiptFooter" rows={2} className="rounded-2xl border border-zinc-300 bg-white px-4 py-3" defaultValue={store.organization?.receiptFooter ?? "Thank you for shopping with us!"} />
            </label>
            <button className="touch-button w-fit rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white">Save receipt text</button>
          </SubmitGuardForm>
        </SectionCard>
      </SectionPanel>
    </AdminLayout>
  );
}

/* ── Shared helpers ───────────────────────────────────────────────── */

function Input({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium text-zinc-700">
      <span>{label}</span>
      <input {...props} className="rounded-2xl border border-zinc-300 bg-white px-4 py-3" />
    </label>
  );
}

function LockedMessage({ message }: { message: string }) {
  return <p className="rounded-2xl bg-zinc-100 px-4 py-3 text-sm text-zinc-700">{message}</p>;
}
