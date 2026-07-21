import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "BUPOS | The retail system behind the counter",
  description: "See how BUPOS connects selling, stock, purchasing, customers, and store operations for uniform and specialty retailers.",
};

const workflows = [
  { number: "01", title: "Sell without losing the thread", text: "A clear cart, product lookup, customer display, tender, receipt, return, and shift flow keep the counter moving.", detail: "Register · POS · Customer display · Returns · Gift cards", image: "/demo/register-products.png", alt: "BUPOS product tiles in the register" },
  { number: "02", title: "Know what is on the shelf", text: "Product records, inventory history, stocktakes, adjustments, reorder suggestions, and transfers give stock a visible trail.", detail: "Products · Inventory ledger · Stocktakes · Reordering · Transfers", image: "/demo/register-view.png", alt: "BUPOS register with product and stock context" },
  { number: "03", title: "Give managers a next move", text: "Purchasing, receiving, cash, shifts, reports, employees, roles, customers, and online selling live in one operating picture.", detail: "Purchase orders · Reports · Cash drawer · Customers · Online selling", image: "/demo/register-sale.png", alt: "BUPOS sale panel showing the current transaction" },
];

const capabilities = [
  ["Counter", "Register, POS, customer display, tenders, receipts, returns, exchanges, gift cards, store credit, special orders, and layaways."],
  ["Stock", "Products, variants, bundles, modifiers, inventory ledger, adjustments, stocktakes, forecasting, reorder suggestions, labels, and transfers."],
  ["Buy", "Suppliers, purchase orders, receiving, supplier returns, and supplier performance."],
  ["Understand", "Sales reports, transaction search, shift reports, cash drawer, exports, and store-level views."],
  ["Customers", "Customer records, preferences, segments, loyalty, promotions, online selling, and reconciliation."],
  ["Operate", "Employees, roles, clock-in, settings, audit, help, and diagnostics."],
];

const roles = [
  { label: "For the person at the counter", title: "See the sale. Make the next move.", text: "Large targets, quick product lookup, visible sale state, and customer-facing totals keep attention where it belongs: with the customer." },
  { label: "For the manager on duty", title: "Know what needs attention today.", text: "Cash, shifts, returns, low stock, receiving, roles, and reports have dedicated places instead of becoming a scavenger hunt." },
  { label: "For the owner or operator", title: "Keep the store’s work connected.", text: "The system follows the product from catalog to sale to inventory movement, and follows the day from open shift to closeout." },
];

export default function DemoFeaturesPage() {
  return (
    <main className="min-h-[100dvh] bg-[#f4f1eb] text-[#15201f]">
      <header className="border-b border-[#15201f]/15 bg-[#f4f1eb]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <Link href="/demo" className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0b8279] font-black text-white">B</span><span className="font-semibold tracking-[-0.02em]">BasicUniformPOS</span></Link>
          <nav className="flex items-center gap-5 text-sm"><Link href="#workflows" className="hidden text-[#52605d] hover:text-[#0b8279] sm:inline">How it works</Link><Link href="#capabilities" className="hidden text-[#52605d] hover:text-[#0b8279] sm:inline">Capabilities</Link><Link href="/demo" className="rounded-full bg-[#15201f] px-4 py-2 font-semibold text-white hover:bg-[#0b8279]">Try the demo</Link></nav>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 pb-12 pt-16 sm:px-8 sm:pb-20 sm:pt-24">
        <div className="grid items-end gap-10 lg:grid-cols-[0.9fr_1.1fr]">
          <div><p className="mb-6 text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Retail software for the real work</p><h1 className="max-w-xl text-5xl font-semibold leading-[0.98] tracking-[-0.06em] sm:text-7xl">The system behind a better store day.</h1></div>
          <div className="max-w-xl pb-1 lg:justify-self-end"><p className="text-xl leading-8 text-[#52605d]">BUPOS connects the counter, the stockroom, purchasing, customers, and the manager’s view—without making the team piece together what happened.</p><div className="mt-7 flex flex-wrap items-center gap-4"><Link href="/demo" className="rounded-full bg-[#0b8279] px-5 py-3 font-semibold text-white shadow-sm hover:bg-[#086b64]">Open the interactive demo</Link><span className="text-sm text-[#697572]">No login · simulated data only</span></div></div>
        </div>
        <div className="mt-14 overflow-hidden rounded-[1.5rem] border border-[#15201f]/15 bg-white shadow-[0_24px_70px_rgba(21,32,31,0.12)]"><Image src="/demo/register-view.png" alt="BUPOS interactive register demo showing products and a current sale" width={3840} height={2264} priority className="h-auto w-full" /></div>
        <p className="mt-4 flex items-center justify-between text-xs uppercase tracking-[0.16em] text-[#697572]"><span>Actual BUPOS demo screen</span><span>Tap through register · inventory · manager view</span></p>
      </section>

      <section className="border-y border-[#15201f]/12 bg-[#15201f] text-[#f4f1eb]"><div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-8 lg:grid-cols-3">{roles.map((role) => <article key={role.label} className="border-l border-[#f4f1eb]/25 pl-5"><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8fd0c6]">{role.label}</p><h2 className="mt-4 text-2xl font-semibold tracking-[-0.03em]">{role.title}</h2><p className="mt-3 leading-7 text-[#c7d0cd]">{role.text}</p></article>)}</div></section>

      <section id="workflows" className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">The product, in use</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">A store story, not a wall of features.</h2><p className="mt-5 text-lg leading-8 text-[#52605d]">Follow the work in the order people actually experience it.</p></div><div className="mt-14 space-y-20">{workflows.map((workflow, index) => <article key={workflow.number} className={`grid items-center gap-10 lg:grid-cols-2 ${index % 2 ? "lg:[&>div:first-child]:order-2" : ""}`}><div><p className="font-mono text-sm font-bold text-[#0b8279]">{workflow.number}</p><h3 className="mt-4 max-w-md text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">{workflow.title}</h3><p className="mt-5 max-w-lg text-lg leading-8 text-[#52605d]">{workflow.text}</p><p className="mt-6 max-w-lg border-t border-[#15201f]/15 pt-4 text-xs font-bold uppercase leading-6 tracking-[0.13em] text-[#697572]">{workflow.detail}</p></div><figure className="overflow-hidden rounded-[1.25rem] border border-[#15201f]/15 bg-white shadow-[0_16px_40px_rgba(21,32,31,0.1)]"><Image src={workflow.image} alt={workflow.alt} width={3840} height={2264} className="h-auto w-full object-cover" /><figcaption className="border-t border-[#15201f]/10 px-4 py-3 text-xs text-[#697572]">Fixture data · public preview · no external actions</figcaption></figure></article>)}</div></section>

      <section id="capabilities" className="bg-white"><div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr]"><div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Capability map</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">The breadth is there. The paths stay clear.</h2><p className="mt-5 text-lg leading-8 text-[#52605d]">These are the working areas in BUPOS today, grouped around store jobs rather than software jargon.</p></div><div className="divide-y divide-[#15201f]/12 border-y border-[#15201f]/15">{capabilities.map(([title, text]) => <div key={title} className="grid gap-3 py-5 sm:grid-cols-[9rem_1fr]"><h3 className="font-semibold text-[#0b8279]">{title}</h3><p className="leading-7 text-[#52605d]">{text}</p></div>)}</div></div></div></section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="grid items-center gap-10 rounded-[1.5rem] bg-[#d7ebe7] p-7 sm:p-12 lg:grid-cols-[1fr_auto]"><div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Start with the safe version</p><h2 className="mt-4 max-w-2xl text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">See the counter before you hand over a store login.</h2><p className="mt-5 max-w-2xl text-lg leading-8 text-[#405552]">The public demo uses fixture data. It does not create an account, charge a payment, change inventory, or write to production.</p></div><Link href="/demo" className="rounded-full bg-[#15201f] px-6 py-3.5 text-center font-semibold text-white hover:bg-[#0b8279]">Walk through BUPOS</Link></div></section>

      <footer className="border-t border-[#15201f]/15 px-5 py-8 sm:px-8"><div className="mx-auto flex max-w-6xl flex-col gap-3 text-sm text-[#697572] sm:flex-row sm:items-center sm:justify-between"><span>BasicUniformPOS · public product showcase</span><div className="flex gap-5"><Link href="/demo" className="hover:text-[#0b8279]">Interactive demo</Link><Link href="/" className="hover:text-[#0b8279]">Main site</Link></div></div></footer>
    </main>
  );
}
