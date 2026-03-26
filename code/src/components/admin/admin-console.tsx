import type { InputHTMLAttributes } from "react";
import { adminLogoutAction, adjustInventoryAction, createCategoryAction, createEmployeeAction, createProductAction, toggleEmployeeAction, updateOrganizationAction, updateLocationAction, editCategoryAction, deleteCategoryAction, editProductAction, deleteProductAction, editVariantAction, deleteVariantAction } from "@/app/admin/actions";
import { BarcodeLabelPrinter } from "@/components/admin/barcode-label-printer";
import { BehaviorDashboard } from "@/components/admin/behavior-dashboard";
import { BulkProductImport } from "@/components/admin/bulk-product-import";
import { BundleManager } from "@/components/admin/bundle-manager";
import { DashboardCharts } from "@/components/admin/dashboard-charts";
import { EmployeeScheduler } from "@/components/admin/employee-scheduler";
import { InventoryBrowser } from "@/components/admin/inventory-browser";
import { BarcodeLookup } from "@/components/admin/barcode-lookup";
import { GiftCardManager } from "@/components/admin/gift-card-manager";
import { LayawayManager } from "@/components/admin/layaway-manager";
import { PurchaseOrderManager } from "@/components/admin/purchase-order-manager";
import { SupplierManager } from "@/components/admin/supplier-manager";
import { ReorderSuggestions } from "@/components/admin/reorder-suggestions";
import { ReturnsManager } from "@/components/admin/returns-manager";
import { CustomerDatabase } from "@/components/admin/customer-database";
import { ExpenseTracker } from "@/components/admin/expense-tracker";
import { StocktakeManager } from "@/components/admin/stocktake-manager";
import { StoreCreditManager } from "@/components/admin/store-credit-manager";
import { TransferManager } from "@/components/admin/transfer-manager";
import { DashboardKPIs } from "@/components/admin/dashboard-kpis";
import { LowStockAutoReorder } from "@/components/admin/low-stock-reorder";
import { ProfitMarginDashboard } from "@/components/admin/profit-margin-dashboard";
import { RecountScheduler } from "@/components/admin/recount-scheduler";
import { TimesheetView } from "@/components/admin/timesheet-view";
import { ZReport } from "@/components/admin/z-report";
import { SalesReports } from "@/components/admin/sales-reports";
import { DataExport } from "@/components/admin/data-export";
import { CustomerReceiptLookup } from "@/components/admin/customer-receipt-lookup";
import { DiscountScheduler } from "@/components/admin/discount-scheduler";
import { EmployeePerformance } from "@/components/admin/employee-performance";
import { TaxReport } from "@/components/admin/tax-report";
import { SalesDigestSettings } from "@/components/admin/sales-digest-settings";
import { OrderCalendar } from "@/components/admin/order-calendar";
import { DailyManagerReport } from "@/components/admin/daily-manager-report";
import { MultiLocationDashboard } from "@/components/admin/multi-location-dashboard";
import { LoyaltyTiers } from "@/components/admin/loyalty-tiers";
import { PayrollSummary } from "@/components/admin/payroll-summary";
import { AdminLayout, SectionPanel } from "@/components/admin/admin-sidebar";
import { SectionCard } from "@/components/ui/section-card";
import { canManageEmployeeRole } from "@/lib/authz";
import { hasPermission, roleDefinitions } from "@/lib/domain/permissions";
import type { RoleKey } from "@/lib/domain/types";
import type { LocalStoreData } from "@/lib/persistence/types";
import { formatDateTime } from "@/lib/utils/date";

export function AdminConsole({
  store,
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
  const canManageCatalog = hasPermission(adminRole, "catalog.manage");
  const canAdjustInventory = hasPermission(adminRole, "inventory.adjust");
  const canManageEmployees = hasPermission(adminRole, "employee.manage");
  const manageableRoles = roleDefinitions.filter((role) => canManageEmployeeRole(adminRole, role.key));

  const productRows = store.products.map((product) => ({
    ...product,
    category: store.categories.find((entry) => entry.id === product.categoryId),
    variants: store.variants.filter((entry) => entry.productId === product.id),
  }));

  const inventoryRows = store.inventory.map((row) => ({
    ...row,
    variant: store.variants.find((entry) => entry.id === row.productVariantId),
    location: store.locations.find((entry) => entry.id === row.locationId),
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
      {notice ? <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}

      {/* ━━ Dashboard ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <SectionPanel sectionKey="dashboard">
        <SectionCard title="Dashboard" description="Real-time key performance indicators for today.">
          <DashboardKPIs store={store} locationId={store.locations[0]?.id ?? ""} />
        </SectionCard>

        <SectionCard title="Sales summary" description="Transaction activity and tender breakdown.">
          <SalesSummary store={store} />
        </SectionCard>

        <SectionCard title="Customer activity" description="Top customers by spend and visit frequency.">
          <CustomerActivity customers={store.customers} />
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
            <Metric label="Categories" value={String(store.categories.length)} />
            <Metric label="Products" value={String(store.products.length)} />
            <Metric label="Variants" value={String(store.variants.length)} />
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
                      {variant.sku} · ${variant.price.toFixed(2)}
                    </span>
                  ))}
                </div>
                
                {canManageCatalog && (
                  <details className="mt-3 cursor-pointer">
                    <summary className="text-xs font-semibold text-teal-700 hover:text-teal-800">Edit product</summary>
                    <div className="mt-3 space-y-3 rounded-xl bg-zinc-50 p-3">
                      <form action={editProductAction} className="grid gap-2">
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
                      </form>
                      <form action={deleteProductAction}>
                        <input type="hidden" name="productId" value={product.id} />
                        <button className="touch-button w-full rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">Delete product</button>
                      </form>
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
                              <form action={editVariantAction} className="grid gap-2">
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
                                <button className="touch-button rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white">Save variant</button>
                              </form>
                              <form action={deleteVariantAction}>
                                <input type="hidden" name="variantId" value={variant.id} />
                                <button className="touch-button w-full rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">Delete variant</button>
                              </form>
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
                        <form action={editCategoryAction} className="grid gap-2">
                          <input type="hidden" name="categoryId" value={cat.id} />
                          <Input name="name" label="Category name" defaultValue={cat.name} />
                          <Input name="imageUrl" label="Image URL" defaultValue={cat.imageUrl ?? ""} />
                          <button className="touch-button rounded-2xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white">Save category</button>
                        </form>
                        <form action={deleteCategoryAction}>
                          <input type="hidden" name="categoryId" value={cat.id} />
                          <button className="touch-button w-full rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">Delete category</button>
                        </form>
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
              <form action={createCategoryAction} className="grid gap-3">
                <Input name="name" label="Category name" placeholder="Outerwear" />
                <Input name="imageUrl" label="Image URL" placeholder="https://..." />
                <button className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white">Add category</button>
              </form>
            ) : (
              <LockedMessage message="This role can view catalog structure but cannot change it." />
            )}
          </SectionCard>

          <SectionCard title="Create product + starter variant" description="Adds a product, its default variant, and an initial inventory row.">
            {canManageCatalog ? (
              <form action={createProductAction} className="grid gap-3 md:grid-cols-2">
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
                <button className="touch-button rounded-2xl bg-zinc-900 px-5 text-sm font-semibold text-white md:col-span-2">Create product</button>
              </form>
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
            <form action={adjustInventoryAction} className="mt-5 grid gap-3 md:grid-cols-3">
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
              <button className="touch-button rounded-2xl bg-amber-600 px-5 text-sm font-semibold text-white md:col-span-3">Record adjustment</button>
            </form>
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
          <InventorySummary store={store} inventoryRows={inventoryRows} />
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
                        <form action={toggleEmployeeAction}>
                          <input type="hidden" name="employeeId" value={employee.id} />
                          <button className={`rounded-full px-3 py-1 text-xs font-semibold text-white ${employee.isActive ? "bg-zinc-800" : "bg-red-700"}`}>
                            {employee.isActive ? "Active" : "Inactive"}
                          </button>
                        </form>
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
              <form action={createEmployeeAction} className="grid gap-3 md:grid-cols-2">
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
                <button className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white md:col-span-2">Create employee</button>
              </form>
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
          <SalesSummary store={store} />
        </SectionCard>

        <div className="grid gap-6 xl:grid-cols-2">
          <SectionCard title="Shift history" description="Closed shifts with cash reconciliation.">
            <ShiftHistory store={store} />
          </SectionCard>

          <SectionCard title="Employee activity" description="Sales, voids, and exceptions per employee.">
            <EmployeeActivity store={store} />
          </SectionCard>
        </div>

        <SectionCard title="Customer database" description="Search, add, and manage customers. Track loyalty points, spend history, and store credit.">
          <CustomerDatabase />
        </SectionCard>

        <SectionCard title="Customer activity" description="Top customers by spend and visit frequency.">
          <CustomerActivity customers={store.customers} />
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
            <CashierExceptions store={store} />
          </SectionCard>

          <SectionCard title="Discrepancy correlation" description="Cash variance patterns by cashier.">
            <DiscrepancyCorrelation store={store} />
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
            <Metric label="Transaction tenders" value={String(store.transactionTenderPlaceholders.length)} />
            <Metric label="Lifecycle events" value={String(store.transactionEventPlaceholders.length)} />
            <Metric label="Exceptions" value={String(store.transactionExceptionPlaceholders.length)} />
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
          <form action={updateOrganizationAction} className="grid gap-3 md:grid-cols-2">
            <Input name="name" label="Store name" defaultValue={store.organization.name} />
            <Input name="legalName" label="Legal name" defaultValue={store.organization.legalName} />
            <Input name="phone" label="Phone" type="tel" defaultValue={store.organization.phone ?? ""} />
            <Input name="email" label="Email" type="email" defaultValue={store.organization.email ?? ""} />
            <Input name="website" label="Website" defaultValue={store.organization.website ?? ""} />
            <div className="md:col-span-2">
              <button className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white">Save store info</button>
            </div>
          </form>
        </SectionCard>

        {store.locations.map((loc) => (
          <SectionCard key={loc.id} title={`Location: ${loc.name}`} description="Address, phone, and sales tax rate.">
            <form action={updateLocationAction} className="grid gap-3 md:grid-cols-2">
              <input type="hidden" name="locationId" value={loc.id} />
              <Input name="locationName" label="Location name" defaultValue={loc.name} />
              <Input name="address1" label="Address" defaultValue={loc.address1} />
              <Input name="city" label="City" defaultValue={loc.city} />
              <Input name="region" label="State / Region" defaultValue={loc.region} />
              <Input name="postalCode" label="Postal code" defaultValue={loc.postalCode} />
              <Input name="locationPhone" label="Phone" type="tel" defaultValue={loc.phone ?? ""} />
              <Input name="taxRate" label="Tax rate (%)" type="number" step="0.01" defaultValue={String((loc.taxRate * 100).toFixed(2))} />
              <div className="md:col-span-2">
                <button className="touch-button rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white">Save location</button>
              </div>
            </form>
          </SectionCard>
        ))}

        <SectionCard title="Receipt customization" description="Header and footer text shown on printed receipts.">
          <form action={updateOrganizationAction} className="grid gap-3">
            <input type="hidden" name="name" value={store.organization.name} />
            <input type="hidden" name="legalName" value={store.organization.legalName} />
            <label className="grid gap-1 text-sm font-medium text-zinc-700">
              <span>Receipt header (appears above store name)</span>
              <textarea name="receiptHeader" rows={2} className="rounded-2xl border border-zinc-300 bg-white px-4 py-3" defaultValue={store.organization.receiptHeader ?? ""} />
            </label>
            <label className="grid gap-1 text-sm font-medium text-zinc-700">
              <span>Receipt footer</span>
              <textarea name="receiptFooter" rows={2} className="rounded-2xl border border-zinc-300 bg-white px-4 py-3" defaultValue={store.organization.receiptFooter ?? "Thank you for shopping with us!"} />
            </label>
            <button className="touch-button w-fit rounded-2xl bg-teal-700 px-5 text-sm font-semibold text-white">Save receipt text</button>
          </form>
        </SectionCard>
      </SectionPanel>
    </AdminLayout>
  );
}

/* ── Extracted sub-components ─────────────────────────────────────── */

function SalesSummary({ store }: { store: LocalStoreData }) {
  const txnEvents = store.transactionEventPlaceholders.filter(
    (e) => e.eventKind === "transaction_placeholder" && e.payload?.grand_total && e.transactionId !== "txn_register_shift_placeholder" && e.transactionId !== "txn_inventory_placeholder",
  );
  const totalSales = txnEvents.filter((e) => !e.payload?.is_return).reduce((s, e) => s + Number(e.payload?.grand_total ?? 0), 0);
  const totalReturns = txnEvents.filter((e) => e.payload?.is_return === "true").reduce((s, e) => s + Math.abs(Number(e.payload?.grand_total ?? 0)), 0);
  const netSales = totalSales - totalReturns;
  const txnCount = txnEvents.filter((e) => !e.payload?.is_return).length;
  const returnCount = txnEvents.filter((e) => e.payload?.is_return === "true").length;
  const avgTicket = txnCount > 0 ? totalSales / txnCount : 0;

  const tenderMap = new Map<string, { total: number; count: number }>();
  for (const t of store.transactionTenderPlaceholders) {
    if (t.transactionId === "txn_register_shift_placeholder") continue;
    const existing = tenderMap.get(t.tenderType) ?? { total: 0, count: 0 };
    existing.total += t.amount;
    existing.count += 1;
    tenderMap.set(t.tenderType, existing);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Transactions" value={String(txnCount)} />
        <Metric label="Total sales" value={`$${totalSales.toFixed(2)}`} />
        <Metric label="Returns" value={`${returnCount} / $${totalReturns.toFixed(2)}`} />
        <Metric label="Avg ticket" value={`$${avgTicket.toFixed(2)}`} />
      </div>
      <div className="rounded-2xl bg-zinc-50 px-4 py-3">
        <p className="text-sm font-semibold text-zinc-600">Net sales: <span className="text-lg text-zinc-900">${netSales.toFixed(2)}</span></p>
      </div>
      {tenderMap.size > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">By tender type</p>
          {Array.from(tenderMap.entries()).map(([type, data]) => (
            <div key={type} className="flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-2 text-sm">
              <span className="capitalize">{type === "store_credit" ? "Store credit" : type}</span>
              <span className="font-semibold">{data.count} · ${data.total.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ShiftHistory({ store }: { store: LocalStoreData }) {
  const closedShifts = store.shifts
    .filter((s) => s.status === "closed")
    .slice(0, 10)
    .map((s) => ({ ...s, employee: store.employees.find((e) => e.id === s.employeeId) }));
  if (closedShifts.length === 0) return <p className="text-sm text-zinc-600">No closed shifts yet.</p>;
  return (
    <div className="space-y-2">
      {closedShifts.map((shift) => (
        <div key={shift.id} className="rounded-2xl border border-zinc-200 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">{shift.employee?.displayName ?? "Unknown"}</p>
              <p className="text-xs text-zinc-500">{formatDateTime(shift.openedAt)} — {shift.closedAt ? formatDateTime(shift.closedAt) : "open"}</p>
            </div>
            <div className="text-right">
              <p className="text-sm">Float ${shift.openingFloat.toFixed(2)}</p>
              {typeof shift.closingVariance === "number" && (
                <p className={`text-sm font-semibold ${shift.closingVariance === 0 ? "text-emerald-700" : Math.abs(shift.closingVariance) <= 1 ? "text-amber-700" : "text-red-700"}`}>
                  Variance {shift.closingVariance >= 0 ? "+" : ""}${shift.closingVariance.toFixed(2)}
                </p>
              )}
              {shift.blindClose && <p className="text-xs text-zinc-400">blind close</p>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmployeeActivity({ store }: { store: LocalStoreData }) {
  const employeeStats = store.employees.filter((e) => e.isActive).map((emp) => {
    const empTxns = store.transactionEventPlaceholders.filter(
      (e) => e.actorEmployeeId === emp.id && e.eventKind === "transaction_placeholder" && e.payload?.grand_total && !e.payload?.is_return && e.transactionId !== "txn_register_shift_placeholder",
    );
    const empVoids = store.transactionEventPlaceholders.filter(
      (e) => e.actorEmployeeId === emp.id && e.eventKind === "transaction_placeholder" && e.payload?.is_return === "true",
    );
    const totalSales = empTxns.reduce((s, e) => s + Number(e.payload?.grand_total ?? 0), 0);
    return { employee: emp, txnCount: empTxns.length, totalSales, voidCount: empVoids.length };
  }).filter((s) => s.txnCount > 0 || s.voidCount > 0);

  if (employeeStats.length === 0) return <p className="text-sm text-zinc-600">No employee activity recorded yet.</p>;
  return (
    <div className="space-y-2">
      {employeeStats.map((stat) => (
        <div key={stat.employee.id} className="flex items-center justify-between rounded-2xl bg-zinc-50 px-4 py-3">
          <div>
            <p className="font-semibold">{stat.employee.displayName}</p>
            <p className="text-xs text-zinc-500">{stat.employee.roleKey}</p>
          </div>
          <div className="text-right text-sm">
            <p>{stat.txnCount} sales · ${stat.totalSales.toFixed(2)}</p>
            {stat.voidCount > 0 && <p className="text-amber-700">{stat.voidCount} returns</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function CustomerActivity({ customers }: { customers: LocalStoreData["customers"] }) {
  const sorted = [...customers].sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 10);
  if (sorted.length === 0) return <p className="text-sm text-zinc-600">No customers yet.</p>;
  return (
    <div className="space-y-2">
      {sorted.map((c) => (
        <div key={c.id} className="flex items-center justify-between rounded-2xl bg-zinc-50 px-4 py-3">
          <div className="flex flex-1 items-center gap-3">
            <div>
              <p className="font-semibold">{c.firstName} {c.lastName}</p>
              <p className="text-xs text-zinc-500">{c.email ?? c.phone ?? "No contact"}</p>
            </div>
            {c.taxExempt && (
              <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">TAX EXEMPT</span>
            )}
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">${c.totalSpend.toFixed(2)}</p>
            <p className="text-xs text-zinc-500">{c.visitCount} visits · {c.loyaltyPoints} pts</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function CashierExceptions({ store }: { store: LocalStoreData }) {
  const exceptions = store.transactionExceptionPlaceholders.map((exc) => {
    const event = store.transactionEventPlaceholders.find((e) => e.transactionId === exc.transactionId);
    const actor = event ? store.employees.find((e) => e.id === event.actorEmployeeId) : null;
    return { ...exc, event, actor };
  });
  const voidEvents = store.transactionEventPlaceholders.filter(
    (e) => e.eventKind === ("cart_voided" as string) || e.eventKind === ("transaction_voided" as string),
  ).map((e) => ({ ...e, actor: store.employees.find((emp) => emp.id === e.actorEmployeeId) }));
  const discountThreshold = store.registerConfiguration.approvalThresholds.discountOver;
  const largeDiscountTxns = store.transactionEventPlaceholders.filter((e) => {
    if (e.eventKind !== ("discount_applied" as string)) return false;
    return Number(e.payload?.discount_amount ?? 0) > discountThreshold;
  }).map((e) => ({ ...e, actor: store.employees.find((emp) => emp.id === e.actorEmployeeId) }));

  const hasData = exceptions.length > 0 || voidEvents.length > 0 || largeDiscountTxns.length > 0;
  if (!hasData) return <p className="text-sm text-zinc-600">No exceptions recorded yet.</p>;

  return (
    <div className="space-y-4">
      {exceptions.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Approval exceptions ({exceptions.length})</p>
          {exceptions.slice(0, 10).map((exc) => (
            <div key={exc.id} className={`flex items-center justify-between rounded-xl px-4 py-2 text-sm ${exc.resolvedAt ? "bg-emerald-50" : "bg-amber-50"}`}>
              <div>
                <p className="font-medium">{exc.exceptionCode.replace(/_/g, " ")}</p>
                <p className="text-xs text-zinc-500">{exc.actor?.displayName ?? "Unknown"} · {exc.transactionId.slice(0, 8)}</p>
              </div>
              <span className={`text-xs font-semibold ${exc.resolvedAt ? "text-emerald-700" : "text-amber-700"}`}>
                {exc.resolvedAt ? "Resolved" : "Pending"}
              </span>
            </div>
          ))}
        </div>
      )}
      {voidEvents.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Voids ({voidEvents.length})</p>
          {voidEvents.slice(0, 10).map((evt) => (
            <div key={evt.id} className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-2 text-sm">
              <div>
                <p className="font-medium">{evt.eventKind.replace(/_/g, " ")}</p>
                <p className="text-xs text-zinc-500">{evt.actor?.displayName ?? "Unknown"} · {formatDateTime(evt.createdAt)}</p>
              </div>
              <span className="text-xs text-red-700">{evt.payload?.reason_code ?? "No reason"}</span>
            </div>
          ))}
        </div>
      )}
      {largeDiscountTxns.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Large discounts ({largeDiscountTxns.length})</p>
          {largeDiscountTxns.slice(0, 10).map((evt) => (
            <div key={evt.id} className="flex items-center justify-between rounded-xl bg-purple-50 px-4 py-2 text-sm">
              <div>
                <p className="font-medium">${evt.payload?.discount_amount ?? "?"}</p>
                <p className="text-xs text-zinc-500">{evt.actor?.displayName ?? "Unknown"} · {formatDateTime(evt.createdAt)}</p>
              </div>
              <span className="text-xs text-purple-700">Over ${discountThreshold}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiscrepancyCorrelation({ store }: { store: LocalStoreData }) {
  const closedShifts = store.shifts.filter((s) => s.status === "closed" && typeof s.closingVariance === "number");
  if (closedShifts.length === 0) return <p className="text-sm text-zinc-600">No closed shifts with variance data yet.</p>;

  const rows = closedShifts.map((shift) => {
    const emp = store.employees.find((e) => e.id === shift.employeeId);
    const shiftVoids = store.transactionEventPlaceholders.filter(
      (e) => e.actorEmployeeId === shift.employeeId &&
        (e.eventKind === ("cart_voided" as string) || e.eventKind === ("item_removed" as string)) &&
        e.createdAt >= shift.openedAt && (!shift.closedAt || e.createdAt <= shift.closedAt),
    ).length;
    const shiftReturns = store.transactionEventPlaceholders.filter(
      (e) => e.actorEmployeeId === shift.employeeId && e.eventKind === "transaction_placeholder" &&
        e.payload?.is_return === "true" && e.createdAt >= shift.openedAt && (!shift.closedAt || e.createdAt <= shift.closedAt),
    ).length;
    return { shift, emp, shiftVoids, shiftReturns };
  }).sort((a, b) => Math.abs(b.shift.closingVariance ?? 0) - Math.abs(a.shift.closingVariance ?? 0));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-5 gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 px-4">
        <span>Cashier</span>
        <span className="text-right">Variance</span>
        <span className="text-right">Voids</span>
        <span className="text-right">Returns</span>
        <span className="text-right">Blind</span>
      </div>
      {rows.slice(0, 10).map((row) => {
        const variance = row.shift.closingVariance ?? 0;
        const varColor = variance === 0 ? "text-emerald-700" : Math.abs(variance) <= 1 ? "text-amber-700" : "text-red-700";
        return (
          <div key={row.shift.id} className="grid grid-cols-5 gap-2 rounded-xl bg-zinc-50 px-4 py-2 text-sm items-center">
            <span className="truncate font-medium">{row.emp?.displayName ?? "?"}</span>
            <span className={`text-right font-semibold ${varColor}`}>{variance >= 0 ? "+" : ""}${variance.toFixed(2)}</span>
            <span className="text-right">{row.shiftVoids}</span>
            <span className="text-right">{row.shiftReturns}</span>
            <span className="text-right">{row.shift.blindClose ? "Yes" : "No"}</span>
          </div>
        );
      })}
    </div>
  );
}

function InventorySummary({ store, inventoryRows }: { store: LocalStoreData; inventoryRows: { id: string; onHand: number; reserved: number; reorderPoint: number; productVariantId: string; variant?: { id: string; name: string; sku: string; price: number; cost?: number; productId: string }; location?: { name: string } }[] }) {
  const totalOnHand = store.inventory.reduce((s, i) => s + i.onHand, 0);
  const totalReserved = store.inventory.reduce((s, i) => s + i.reserved, 0);
  const totalRetailValue = store.inventory.reduce((s, inv) => {
    const variant = store.variants.find((v) => v.id === inv.productVariantId);
    return s + (variant ? variant.price * inv.onHand : 0);
  }, 0);
  const totalCostValue = store.inventory.reduce((s, inv) => {
    const variant = store.variants.find((v) => v.id === inv.productVariantId);
    return s + (variant?.cost ? variant.cost * inv.onHand : 0);
  }, 0);
  const lowStockCount = store.inventory.filter((i) => i.onHand <= i.reorderPoint).length;
  const outOfStockCount = store.inventory.filter((i) => i.onHand === 0).length;
  const adjustmentCount = store.inventoryAdjustments.length;
  const netAdjustment = store.inventoryAdjustments.reduce((s, a) => s + a.delta, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Total on hand" value={String(totalOnHand)} />
        <Metric label="Reserved" value={String(totalReserved)} />
        <Metric label="Retail value" value={`$${totalRetailValue.toFixed(2)}`} />
        <Metric label="Cost value" value={`$${totalCostValue.toFixed(2)}`} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Low stock items" value={String(lowStockCount)} />
        <Metric label="Out of stock" value={String(outOfStockCount)} />
        <Metric label="Adjustments" value={String(adjustmentCount)} />
        <Metric label="Net adjustment" value={`${netAdjustment >= 0 ? "+" : ""}${netAdjustment}`} />
      </div>
      {store.inventory.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Stock by variant</p>
          {store.inventory.map((inv) => {
            const variant = store.variants.find((v) => v.id === inv.productVariantId);
            const product = variant ? store.products.find((p) => p.id === variant.productId) : null;
            const pct = inv.reorderPoint > 0 ? Math.round((inv.onHand / (inv.reorderPoint * 3)) * 100) : 100;
            const barColor = inv.onHand === 0 ? "bg-red-500" : inv.onHand <= inv.reorderPoint ? "bg-amber-500" : "bg-emerald-500";
            return (
              <div key={inv.id} className="flex items-center gap-3 rounded-xl bg-zinc-50 px-4 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{product?.name ?? "?"} — {variant?.name ?? inv.productVariantId}</p>
                  <p className="text-xs text-zinc-500">{variant?.sku}</p>
                </div>
                <div className="w-24">
                  <div className="h-2 rounded-full bg-zinc-200">
                    <div className={`h-2 rounded-full ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                </div>
                <span className="w-16 text-right font-semibold">{inv.onHand}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Shared helpers ───────────────────────────────────────────────── */

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

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
