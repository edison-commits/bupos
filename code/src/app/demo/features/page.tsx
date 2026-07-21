import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "BUPOS Features | Retail POS for Uniform & Specialty Stores",
  description: "Explore the BUPOS register, inventory, purchasing, customer, reporting, online selling, and store operations toolkit.",
};

type Feature = { title: string; description: string; route: string };

const featureGroups: Array<{ eyebrow: string; title: string; description: string; features: Feature[] }> = [
  {
    eyebrow: "01 · Sell at the counter",
    title: "A register your team can understand quickly.",
    description: "Keep the sale visible from product selection to receipt, with store-aware register and customer-display surfaces built into the same system.",
    features: [
      { title: "Register & POS", description: "Product search, cart controls, discounts, promos, tenders, receipts, returns, exchanges, and shift-aware selling.", route: "/register · /pos" },
      { title: "Customer display", description: "A dedicated customer-facing screen for showing the current sale and total at the counter.", route: "/customer-display · /register/customer-display" },
      { title: "Store credit & gift cards", description: "Support store-credit and gift-card workflows alongside ordinary tender options.", route: "/admin/gift-cards · /api/store-credit" },
      { title: "Special orders & layaways", description: "Keep orders that are not simple walk-in sales visible to the team and tied to a workflow.", route: "/admin/special-orders · /admin/layaways" },
    ],
  },
  {
    eyebrow: "02 · Know your stock",
    title: "Inventory control that follows the product.",
    description: "Move from a product catalog to a clearer picture of what is on hand, what moved, what needs attention, and what should be ordered next.",
    features: [
      { title: "Products & variants", description: "Manage products, categories, pricing, modifiers, bundles, and import previews from a central catalog.", route: "/admin/products · /products" },
      { title: "Inventory ledger", description: "Review adjustments and inventory history instead of treating stock as an unexplained number.", route: "/admin/inventory · /admin/inventory/ledger" },
      { title: "Stocktakes & adjustments", description: "Run count and adjustment workflows with explicit review points for operational changes.", route: "/admin/stocktakes · /admin/inventory/adjustments" },
      { title: "Reorder planning", description: "Use reorder suggestions, forecasting, and supplier performance views to turn low stock into a next action.", route: "/api/reorder-suggestions · /admin/purchase-orders/supplier-performance" },
    ],
  },
  {
    eyebrow: "03 · Buy and receive",
    title: "Purchasing that connects back to the store.",
    description: "Give managers a path from supplier decision to receiving, transfers, and location-level inventory movement.",
    features: [
      { title: "Purchase orders", description: "Create and track purchase orders through draft, submission, partial receipt, and completion states.", route: "/admin/purchase-orders" },
      { title: "Receiving", description: "Record what arrived and keep receiving separate from the original order decision.", route: "/admin/receiving" },
      { title: "Supplier returns", description: "Track supplier-return work as an operational workflow rather than an ad hoc note.", route: "/admin/supplier-returns" },
      { title: "Location transfers", description: "Move stock between locations with a dedicated transfer surface and status visibility.", route: "/admin/transfers" },
    ],
  },
  {
    eyebrow: "04 · Understand the business",
    title: "Reports that point toward the next decision.",
    description: "Bring sales, shifts, products, categories, tenders, locations, and exports into the manager’s operating view.",
    features: [
      { title: "Sales reporting", description: "Review sales summaries, product and category performance, tender mix, and store-level comparisons.", route: "/admin/reports · /sales" },
      { title: "Transactions & returns", description: "Search transaction history and keep return processing connected to the original sale where supported.", route: "/admin/transactions · /admin/returns" },
      { title: "Shift & cash control", description: "Open, review, close, and report on shifts and cash-drawer activity.", route: "/admin/shifts · /admin/shift-close · /admin/cash-drawer" },
      { title: "Exports", description: "Move operational data into reports and downstream workflows through export surfaces.", route: "/api/export · /admin/reports" },
    ],
  },
  {
    eyebrow: "05 · Keep customers connected",
    title: "Customer context beyond the receipt.",
    description: "Give staff and managers a place to work with customer records, preferences, loyalty, segments, and online-order context.",
    features: [
      { title: "Customer records", description: "Find and manage customer information from the admin workspace and sale-related flows.", route: "/admin/customers" },
      { title: "Segments & preferences", description: "Organize customer context for more useful follow-up and store operations.", route: "/admin/customers/segments · /api/customers/preferences" },
      { title: "Loyalty & promotions", description: "Configure loyalty and promotional workflows without hiding them inside the register.", route: "/admin/loyalty · /admin/promos" },
      { title: "Online selling", description: "Connect online-selling operations, reconciliation, publishable products, and inventory sync workflows.", route: "/admin/online-selling · /admin/online-selling/reconciliation" },
    ],
  },
  {
    eyebrow: "06 · Run the store",
    title: "Manager controls for the work around the sale.",
    description: "Make the less-visible operating work findable: employees, permissions, clock-in, settings, labels, audit, and diagnostics.",
    features: [
      { title: "Employees & roles", description: "Manage employees and review the role-based controls that shape what each person can do.", route: "/admin/employees · /admin/roles" },
      { title: "Clock-in & accountability", description: "Give teams a dedicated clock-in surface and managers a way to review time-clock activity.", route: "/admin/clock-in · /register" },
      { title: "Labels & setup", description: "Support barcode-label work and store configuration from dedicated admin surfaces.", route: "/admin/labels · /admin/settings" },
      { title: "Audit & diagnostics", description: "Keep audit visibility and system diagnostics available when managers need to investigate.", route: "/admin/audit · /admin/help · /api/admin/diagnostics" },
    ],
  },
];

const benefits = [
  ["One operating picture", "Register, inventory, purchasing, customers, and reports share a store-oriented system instead of living in disconnected tools."],
  ["Fewer counter surprises", "Clear cart, tender, receipt, shift, and customer-display surfaces help staff see what is happening before they commit the next action."],
  ["Manager attention where it belongs", "Reorders, receiving, cash, returns, roles, and audit work have dedicated places so important tasks are easier to find."],
  ["Designed for real store variation", "Location-aware workflows, special orders, layaways, transfers, bundles, modifiers, and uniform-specific products fit the work retailers actually do."],
];

const guardrails = ["No fake customer logos or invented performance claims", "Demo data stays clearly labeled as simulated", "Payment, refund, inventory, and customer actions remain explicit", "The public demo does not require a login or write to production data"];

export default function DemoFeaturesPage() {
  return (
    <main className="min-h-[100dvh] bg-slate-950 text-white">
      <header className="border-b border-white/10 bg-slate-950/95">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-5 sm:px-6">
          <Link href="/demo" className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-400 font-black text-teal-950">B</span><span className="font-bold tracking-tight">BasicUniformPOS</span></Link>
          <nav className="flex items-center gap-4 text-sm"><Link href="/demo" className="text-slate-300 hover:text-white">Interactive demo</Link><Link href="/" className="hidden rounded-lg bg-teal-400 px-3 py-2 font-bold text-teal-950 hover:bg-teal-300 sm:inline-flex">Back to site</Link></nav>
        </div>
      </header>

      <section className="relative overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_75%_15%,rgba(20,184,166,0.18),transparent_34%),radial-gradient(circle_at_15%_80%,rgba(14,116,144,0.16),transparent_30%)]" />
        <div className="relative mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-24">
          <div>
            <p className="mb-5 text-xs font-bold uppercase tracking-[0.22em] text-teal-300">Retail POS for uniform & specialty stores</p>
            <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">The store system your team can actually run.</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">BUPOS brings the counter, inventory, purchasing, customers, and manager operations into one practical workspace—so the next store decision is easier to see.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row"><Link href="/demo" className="rounded-xl bg-teal-400 px-5 py-3.5 text-center font-bold text-teal-950 shadow-lg shadow-teal-950/30 hover:bg-teal-300">Explore the interactive demo</Link><a href="#features" className="rounded-xl border border-white/20 px-5 py-3.5 text-center font-bold text-white hover:border-teal-300 hover:text-teal-200">See the feature map</a></div>
            <p className="mt-4 text-sm text-slate-400">Public preview · no account required · simulated data only</p>
          </div>
          <div className="rounded-3xl border border-white/15 bg-white/[0.07] p-5 shadow-2xl shadow-black/30 backdrop-blur sm:p-7">
            <div className="mb-5 flex items-center justify-between"><div><div className="text-xs font-bold uppercase tracking-[0.18em] text-teal-300">Today’s store view</div><div className="mt-2 text-xl font-bold">Everything important, at a glance.</div></div><span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-bold text-emerald-300">Demo mode</span></div>
            <div className="grid gap-3 sm:grid-cols-2"><PreviewPanel label="Register" value="Ready to sell" detail="2 open shifts" tone="teal" /><PreviewPanel label="Inventory" value="2 reorder soon" detail="6 products sampled" tone="amber" /><PreviewPanel label="Customers" value="Context available" detail="Records & segments" tone="blue" /><PreviewPanel label="Manager attention" value="3 items" detail="Review next actions" tone="rose" /></div>
            <div className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-4 text-sm text-slate-300">A product story, not a feature dump: start at the counter, follow the stock, understand the day, then act.</div>
          </div>
        </div>
      </section>

      <section className="bg-white py-16 text-slate-950 sm:py-20"><div className="mx-auto max-w-7xl px-4 sm:px-6"><div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-700">Why BUPOS</p><h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Less hunting. More confident store work.</h2><p className="mt-4 text-lg leading-8 text-slate-600">The benefit is not having more screens. It is giving each store job a clear place, a visible status, and a next useful action.</p></div><div className="mt-10 grid gap-4 md:grid-cols-2">{benefits.map(([title, description]) => <article key={title} className="rounded-2xl border border-slate-200 bg-slate-50 p-6"><div className="mb-4 h-2 w-12 rounded-full bg-teal-600" /><h3 className="text-xl font-bold">{title}</h3><p className="mt-3 leading-7 text-slate-600">{description}</p></article>)}</div></div></section>

      <section id="features" className="bg-slate-100 py-16 text-slate-950 sm:py-20"><div className="mx-auto max-w-7xl px-4 sm:px-6"><div className="max-w-3xl"><p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-700">Feature map</p><h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">One platform, organized around the way a store runs.</h2><p className="mt-4 text-lg leading-8 text-slate-600">Explore the capability areas below. The route references are included for transparency; the live interactive preview uses safe fixtures and does not open protected production surfaces.</p></div><div className="mt-12 space-y-14">{featureGroups.map((group) => <section key={group.title}><div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-700">{group.eyebrow}</p><h3 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">{group.title}</h3><p className="mt-3 leading-7 text-slate-600">{group.description}</p></div><div className="mt-6 grid gap-4 md:grid-cols-2">{group.features.map((feature) => <article key={feature.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-4"><h4 className="text-lg font-bold">{feature.title}</h4><span className="rounded-lg bg-teal-50 px-2 py-1 text-[10px] font-mono font-bold text-teal-800">{feature.route}</span></div><p className="mt-3 leading-7 text-slate-600">{feature.description}</p></article>)}</div></section>)}</div></div></section>

      <section className="bg-white py-16 text-slate-950 sm:py-20"><div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-start"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-700">A safer way to evaluate it</p><h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">See the product before you hand over a store login.</h2><p className="mt-4 text-lg leading-8 text-slate-600">This public preview is intentionally honest: it demonstrates the product story without pretending that fixture data is a customer account or that a simulated checkout charged anything.</p></div><div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 sm:p-8"><h3 className="text-xl font-bold">Preview guardrails</h3><ul className="mt-5 space-y-4">{guardrails.map((item) => <li key={item} className="flex gap-3 text-slate-700"><span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-black text-emerald-700">✓</span><span>{item}</span></li>)}</ul></div></div></section>

      <section className="bg-teal-800 py-16 text-white sm:py-20"><div className="mx-auto flex max-w-5xl flex-col items-start justify-between gap-8 px-4 sm:px-6 md:flex-row md:items-center"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-200">Next step</p><h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Walk through the store experience.</h2><p className="mt-3 max-w-2xl text-lg leading-8 text-teal-100">Start with the simulated register, then switch to inventory and manager view. No login or setup required.</p></div><Link href="/demo" className="shrink-0 rounded-xl bg-white px-5 py-3.5 font-bold text-teal-900 shadow-lg hover:bg-teal-50">Open the demo</Link></div></section>

      <footer className="border-t border-white/10 bg-slate-950 py-8 text-sm text-slate-400"><div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"><span>BasicUniformPOS · public feature showcase</span><div className="flex gap-4"><Link href="/demo" className="hover:text-white">Interactive demo</Link><Link href="/" className="hover:text-white">BasicUniformPOS</Link></div></div></footer>
    </main>
  );
}

function PreviewPanel({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "teal" | "amber" | "blue" | "rose" }) {
  const tones = { teal: "border-teal-300/25 bg-teal-400/10 text-teal-200", amber: "border-amber-300/25 bg-amber-400/10 text-amber-200", blue: "border-blue-300/25 bg-blue-400/10 text-blue-200", rose: "border-rose-300/25 bg-rose-400/10 text-rose-200" };
  return <div className={`rounded-2xl border p-4 ${tones[tone]}`}><div className="text-xs font-bold uppercase tracking-wide opacity-80">{label}</div><div className="mt-3 font-bold text-white">{value}</div><div className="mt-1 text-xs opacity-80">{detail}</div></div>;
}
