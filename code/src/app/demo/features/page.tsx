import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "BUPOS | Complete retail operations, in one place",
  description: "Explore the complete BUPOS retail operating system: register, inventory, purchasing, customers, reporting, online selling, staff, and controls.",
};

const screens = [
  { label: "Dashboard", title: "See the day at a glance.", text: "Sales, transactions, shifts, payment methods, employee performance, and recent activity start in one manager view.", image: "/showcase/admin-dashboard.png", alt: "Authenticated BUPOS sales dashboard" },
  { label: "Catalog", title: "Build the catalog the counter actually uses.", text: "Products, variants, categories, bundles, modifiers, CSV import, labels, and pricing give the team a dependable product record.", image: "/showcase/admin-products.png", alt: "Authenticated BUPOS product catalog screen" },
  { label: "Inventory", title: "Give every item a visible trail.", text: "Inventory, ledger, adjustments, stocktakes, transfers, forecasting, and reorder suggestions keep the stockroom connected to the register.", image: "/showcase/admin-inventory.png", alt: "Authenticated BUPOS inventory screen" },
  { label: "Purchasing", title: "Move from need to receiving.", text: "Suppliers, purchase orders, supplier performance, receiving, and supplier returns keep buying work tied to what arrived and what sold.", image: "/showcase/admin-purchasing.png", alt: "Authenticated BUPOS purchase orders screen" },
  { label: "Reporting", title: "Turn store activity into a next step.", text: "Sales summaries, store views, transaction search, shift reports, cash drawer, exports, EOD reports, and audit history make the day explainable.", image: "/showcase/admin-reports.png", alt: "Authenticated BUPOS reports screen" },
  { label: "Customers", title: "Remember the person, not just the sale.", text: "Customer records, preferences, segments, loyalty, promotions, special orders, returns, and store credit keep service personal and accountable.", image: "/showcase/admin-customers.png", alt: "Authenticated BUPOS customer management screen" },
];

const featureGroups = [
  ["Sell", "Register, POS, transactions, tenders, receipts, email receipts, returns, exchanges, gift cards, store credit, special orders, layaways, customer display, and paired customer-facing display."],
  ["Catalog", "Products, variants, categories, bundles, modifiers, pricing, CSV import, labels, product search, and product publishing."],
  ["Stock", "Inventory, inventory ledger, adjustments, stocktakes, transfers, forecasting, reorder suggestions, location stock, offline sync, and inventory reconciliation."],
  ["Buy", "Suppliers, purchase orders, supplier performance, receiving, supplier returns, purchase-order forecasting, and receiving history."],
  ["Customers", "Customer records, preferences, segments, loyalty tiers, promotions, promo codes, special orders, store credit, gift cards, and customer self-signup."],
  ["Run the day", "Dashboard, shifts, shift close, clock-in, cash drawer, pay-ins, pay-outs, expenses, tax configuration, and end-of-day reporting."],
  ["Understand", "Sales reports, sales by store, transaction search, returns search, shift reports, exports, audit events, health checks, diagnostics, and support packets."],
  ["Online selling", "Online selling setup, publishable products, channel product mapping, Shopify reconciliation, online-order reconciliation, webhooks, and POS-authoritative inventory and price sync."],
  ["People and control", "Employees, roles, permissions, role review, location assignment, settings, audit, approvals, command palette, help, and diagnostics."],
  ["Resilience", "Offline register behavior, offline status, safe sync, register terminal linking, session controls, customer display state, and explicit auth boundaries."],
];

export default function DemoFeaturesPage() {
  return (
    <main className="min-h-[100dvh] bg-[#f4f1eb] text-[#15201f]">
      <header className="border-b border-[#15201f]/15 bg-[#f4f1eb]"><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8"><Link href="/demo" className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0b8279] font-black text-white">B</span><span className="font-semibold tracking-[-0.02em]">BasicUniformPOS</span></Link><nav className="flex items-center gap-5 text-sm"><Link href="#screens" className="hidden text-[#52605d] hover:text-[#0b8279] sm:inline">Screens</Link><Link href="#features" className="hidden text-[#52605d] hover:text-[#0b8279] sm:inline">All features</Link><Link href="/demo" className="rounded-full bg-[#15201f] px-4 py-2 font-semibold text-white hover:bg-[#0b8279]">Try the demo</Link></nav></div></header>

      <section className="mx-auto max-w-6xl px-5 pb-16 pt-16 sm:px-8 sm:pb-24 sm:pt-24"><div className="grid items-end gap-10 lg:grid-cols-[0.9fr_1.1fr]"><div><p className="mb-6 text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">The BUPOS operating system</p><h1 className="max-w-xl text-5xl font-semibold leading-[0.98] tracking-[-0.06em] sm:text-7xl">Everything behind the counter.</h1></div><div className="max-w-xl pb-1 lg:justify-self-end"><p className="text-xl leading-8 text-[#52605d]">BUPOS brings selling, stock, purchasing, customers, staff, reporting, and online channels into one working system for uniform and specialty retail.</p><div className="mt-7 flex flex-wrap items-center gap-4"><Link href="/demo" className="rounded-full bg-[#0b8279] px-5 py-3 font-semibold text-white shadow-sm hover:bg-[#086b64]">Open the public demo</Link><span className="text-sm text-[#697572]">No login · simulated data only</span></div></div></div><p className="mt-12 max-w-2xl border-l-2 border-[#0b8279] pl-5 text-sm leading-7 text-[#52605d]">The screens below are captured from the authenticated BUPOS application running locally with the project&apos;s seeded fixture account. They are actual product screens, not the public demo shell.</p></section>

      <section id="screens" className="border-y border-[#15201f]/12 bg-[#15201f] text-[#f4f1eb]"><div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#8fd0c6]">Actual product screens</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">The work, in the system.</h2><p className="mt-5 text-lg leading-8 text-[#c7d0cd]">A look at the real authenticated BUPOS application: the manager&apos;s view, the catalog, inventory, purchasing, reporting, and customer records.</p></div><div className="mt-14 grid gap-10 md:grid-cols-2">{screens.map((screen) => <figure key={screen.label} className="overflow-hidden rounded-[1.25rem] border border-[#f4f1eb]/20 bg-white text-[#15201f] shadow-[0_18px_50px_rgba(0,0,0,0.2)]"><Image src={screen.image} alt={screen.alt} width={1280} height={720} loading="eager" className="h-auto w-full" /><figcaption className="p-5"><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#0b8279]">{screen.label}</p><h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{screen.title}</h3><p className="mt-2 leading-7 text-[#52605d]">{screen.text}</p><p className="mt-4 text-xs uppercase tracking-[0.13em] text-[#697572]">Authenticated app · local fixture data</p></figcaption></figure>)}</div></div></section>

      <section id="features" className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr]"><div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Complete feature map</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">The whole store, not just the shiny parts.</h2><p className="mt-5 text-lg leading-8 text-[#52605d]">Every current BUPOS feature area is listed here, grouped around the jobs a store has to get done.</p></div><div className="divide-y divide-[#15201f]/12 border-y border-[#15201f]/15">{featureGroups.map(([title, text]) => <div key={title} className="grid gap-3 py-5 sm:grid-cols-[10rem_1fr]"><h3 className="font-semibold text-[#0b8279]">{title}</h3><p className="leading-7 text-[#52605d]">{text}</p></div>)}</div></div></section>

      <section className="mx-auto max-w-6xl px-5 pb-16 sm:px-8 sm:pb-24"><div className="grid items-center gap-10 rounded-[1.5rem] bg-[#d7ebe7] p-7 sm:p-12 lg:grid-cols-[1fr_auto]"><div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Start safely</p><h2 className="mt-4 max-w-2xl text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">Explore the no-login version first.</h2><p className="mt-5 max-w-2xl text-lg leading-8 text-[#405552]">The public demo uses fixture data. It does not create an account, charge a payment, change inventory, or write to production.</p></div><Link href="/demo" className="rounded-full bg-[#15201f] px-6 py-3.5 text-center font-semibold text-white hover:bg-[#0b8279]">Walk through BUPOS</Link></div></section>

      <footer className="border-t border-[#15201f]/15 px-5 py-8 sm:px-8"><div className="mx-auto flex max-w-6xl flex-col gap-3 text-sm text-[#697572] sm:flex-row sm:items-center sm:justify-between"><span>BasicUniformPOS · public product showcase</span><div className="flex gap-5"><Link href="/demo" className="hover:text-[#0b8279]">Interactive demo</Link><Link href="/" className="hover:text-[#0b8279]">Main site</Link></div></div></footer>
    </main>
  );
}
