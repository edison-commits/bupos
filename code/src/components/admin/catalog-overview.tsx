import {
  categories,
  employees,
  inventory,
  modifierGroups,
  products,
  variants,
} from "@/lib/data/mock-data";
import { roleDefinitions } from "@/lib/domain/permissions";
import { SectionCard } from "@/components/ui/section-card";

const catalogKpis = [
  { label: "Categories", value: categories.length },
  { label: "Products", value: products.length },
  { label: "Variants", value: variants.length },
  { label: "Modifier groups", value: modifierGroups.length },
  { label: "Employees", value: employees.length },
  { label: "Inventory rows", value: inventory.length },
];

export function CatalogOverview() {
  return (
    <div className="grid gap-6">
      <SectionCard title="Foundation snapshot" description="The admin shell is meant to own catalog, inventory, staff, and audit surfaces before any reporting or back-office sprawl.">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {catalogKpis.map((kpi) => (
            <div key={kpi.label} className="kpi rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4">
              <p className="text-sm text-zinc-500">{kpi.label}</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight">{kpi.value}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Role direction" description="Permissions are explicit and intentionally boring so the cash-control model stays inspectable.">
          <div className="space-y-3">
            {roleDefinitions.map((role) => (
              <div key={role.key} className="rounded-2xl border border-zinc-200 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{role.label}</h3>
                    <p className="text-sm text-zinc-600">{role.description}</p>
                  </div>
                  <span className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-white">
                    {role.permissions.length} perms
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {role.permissions.map((permission) => (
                    <span key={permission} className="rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-800">
                      {permission}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Touch-friendly catalog browse" description="Products are modeled with categories, variants, images, and optional modifier-group attachments.">
          <div className="space-y-3">
            {products.map((product) => (
              <div key={product.id} className="rounded-2xl border border-zinc-200 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{product.name}</h3>
                    <p className="mt-1 text-sm text-zinc-600">{product.description}</p>
                  </div>
                  {product.isTouchFavorite ? (
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">Favorite</span>
                  ) : null}
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.18em] text-zinc-500">
                  {variants.filter((variant) => variant.productId === product.id).length} variants · {product.modifierGroupIds.length} modifier groups
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
