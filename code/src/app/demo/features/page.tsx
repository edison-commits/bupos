import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "BUPOS — POS for uniform & workwear stores",
  description:
    "Web-first POS for uniform and workwear stores — size runs, an offline-capable register, and full back office in one system.",
  alternates: { canonical: "/demo/features" },
  openGraph: {
    title: "BUPOS — POS for uniform & workwear stores",
    description:
      "Web-first POS for uniform and workwear stores — size runs, an offline-capable register, and full back office in one system.",
    images: [
      {
        url: "/og/bupos-features.png",
        width: 1200,
        height: 630,
        alt: "BUPOS POS for uniform and workwear stores",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "BUPOS — POS for uniform & workwear stores",
    description:
      "Web-first POS for uniform and workwear stores — size runs, an offline-capable register, and full back office in one system.",
    images: ["/og/bupos-features.png"],
  },
};

const screens = [
  {
    label: "Register",
    title: "Ring it up fast.",
    text: "Scan, size, tender, done. Returns, exchanges, gift cards, store credit, special orders, and layaways all live at the counter — and the register keeps working when the internet doesn't.",
    image: "/demo/register-sale.png",
    alt: "BUPOS register showing a sample retail sale",
  },
  {
    label: "Dashboard",
    title: "See the day at a glance.",
    text: "Sales, transactions, shifts, payment methods, employee performance, and recent activity start in one manager view.",
    image: "/showcase/admin-dashboard.png",
    alt: "BUPOS sales dashboard with sample store activity",
  },
  {
    label: "Inventory",
    title: "Every item leaves a trail.",
    text: "Adjustments, stocktakes, transfers, and reorder suggestions — with full size-run visibility, so you know you're out of 34×30 before the customer tells you.",
    image: "/showcase/admin-inventory.png",
    alt: "BUPOS inventory screen with sample stock levels",
  },
  {
    label: "Customers",
    title: "Remember the person, not just the sale.",
    text: "Customer records, preferences, segments, loyalty, promotions, special orders, returns, and store credit keep service personal and accountable.",
    image: "/showcase/admin-customers.png",
    alt: "BUPOS customer management screen with sample loyalty records",
  },
  {
    label: "Purchasing",
    title: "From reorder point to receiving dock.",
    text: "Suppliers, purchase orders, receiving, supplier performance, and returns keep buying work tied to the store floor.",
    image: "/showcase/admin-purchasing.png",
    alt: "BUPOS purchase orders screen with a sample replenishment order",
  },
  {
    label: "Catalog",
    title: "Build the catalog the counter actually uses.",
    text: "Products, variants, categories, bundles, labels, and pricing give the counter a dependable product record, with size grids across waist, inseam, and fit.",
    image: "/showcase/admin-products.png",
    alt: "BUPOS product catalog with sample products and variants",
  },
  {
    label: "Reporting",
    title: "Close the day with answers.",
    text: "What sold, who sold it, what's in the drawer, and what to reorder — before you lock up.",
    image: "/showcase/admin-reports.png",
    alt: "BUPOS reports screen with sample sales results",
  },
];

const tradeFeatures = [
  ["Size-run matrices", "Buy, stock, and sell across waist × inseam grids. See holes in the run at a glance instead of scrolling a variant list."],
  ["Special orders & layaways", "First-class features, not workarounds — because in this trade, they are part of the everyday counter."],
];

const featureGroups = [
  ["Sell", "Register, POS, tenders, receipts, returns, exchanges, gift cards, store credit, special orders, layaways, and customer display."],
  ["Catalog", "Products, variants, categories, bundles, pricing, CSV import, labels, product search, and publishing."],
  ["Stock", "Inventory, ledger, adjustments, stocktakes, transfers, forecasting, reorder suggestions, location stock, and offline sync."],
  ["Buy", "Suppliers, purchase orders, supplier performance, receiving, supplier returns, forecasting, and receiving history."],
  ["Customers", "Customer records, preferences, segments, loyalty, promotions, promo codes, store credit, gift cards, and self-signup."],
  ["Run the day", "Dashboard, shifts, shift close, clock-in, cash drawer, pay-ins, pay-outs, expenses, tax configuration, and EOD reporting."],
  ["Understand", "Sales reports, store views, transaction search, returns search, shift reports, exports, and audit history."],
  ["Online selling", "Publishable products, channel mapping, Shopify reconciliation, online-order reconciliation, webhooks, and POS-authoritative inventory sync."],
  ["People and control", "Employees, roles, permissions, location assignment, settings, approvals, and help."],
  ["Works offline", "Offline register behavior, safe sync, terminal linking, session controls, and secure sign-in for every terminal."],
];

export default function DemoFeaturesPage() {
  return (
    <main className="min-h-[100dvh] bg-[#f4f1eb] text-[#15201f]">
      <header className="border-b border-[#15201f]/15 bg-[#f4f1eb]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <Link href="/demo" className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0b8279] font-black text-white">B</span>
            <span className="font-semibold tracking-[-0.02em]">BUPOS</span>
          </Link>
          <nav className="flex items-center gap-5 text-sm">
            <Link href="#screens" className="hidden text-[#30413d] hover:text-[#0b8279] sm:inline">See BUPOS</Link>
            <Link href="#features" className="hidden text-[#30413d] hover:text-[#0b8279] sm:inline">The full list</Link>
            <Link href="/support" className="hidden text-[#30413d] hover:text-[#0b8279] sm:inline">Evaluation &amp; support</Link>
            <Link href="/demo" className="rounded-full bg-[#15201f] px-4 py-2 font-semibold text-white hover:bg-[#0b8279]">Try the demo</Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 pb-16 pt-14 sm:px-8 sm:pb-24 sm:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[0.82fr_1.18fr]">
          <div>
            <p className="mb-6 text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">POS for uniform &amp; workwear retail</p>
            <h1 className="max-w-xl text-5xl font-semibold leading-[0.98] tracking-[-0.06em] sm:text-7xl">Everything behind the counter.</h1>
            <p className="mt-7 max-w-xl text-xl leading-8 text-[#30413d]">BUPOS runs the register, the stockroom, purchasing, and customer accounts in one system — built around how uniform and workwear stores actually sell.</p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link href="/demo" className="rounded-full bg-[#0b8279] px-5 py-3 font-semibold text-white shadow-sm hover:bg-[#086b64]">Try the live demo</Link>
              <Link href="/support" className="rounded-full border border-[#15201f]/20 px-5 py-3 font-semibold text-[#15201f] hover:border-[#0b8279] hover:text-[#0b8279]">Evaluation &amp; support</Link>
            </div>
            <p className="mt-5 text-sm text-[#52605d]">No signup. Nothing to install. Sample store data.</p>
          </div>
          <figure className="overflow-hidden rounded-[1.5rem] border border-[#15201f]/15 bg-white shadow-[0_24px_70px_rgba(21,32,31,0.14)]">
            <Image src="/demo/register-sale.png" alt="BUPOS register showing a sample retail sale" width={1920} height={1132} priority className="h-auto w-full" />
            <figcaption className="border-t border-[#15201f]/10 px-5 py-3 text-xs text-[#52605d]">Sample register view · simulated store data</figcaption>
          </figure>
        </div>
      </section>

      <section className="border-y border-[#15201f]/12 bg-[#15201f] text-[#f4f1eb]">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-8 lg:grid-cols-3">
          <article className="border-l border-[#f4f1eb]/25 pl-5"><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8fd0c6]">At the counter</p><h2 className="mt-4 text-2xl font-semibold tracking-[-0.03em]">Keep the sale moving.</h2><p className="mt-3 leading-7 text-[#c7d0cd]">Find the right variant, attach the customer, take payment, and keep the total clear.</p></article>
          <article className="border-l border-[#f4f1eb]/25 pl-5"><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8fd0c6]">In the stockroom</p><h2 className="mt-4 text-2xl font-semibold tracking-[-0.03em]">Make every item explainable.</h2><p className="mt-3 leading-7 text-[#c7d0cd]">See what is available, what moved, what needs attention, and what has been ordered.</p></article>
          <article className="border-l border-[#f4f1eb]/25 pl-5"><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8fd0c6]">At close</p><h2 className="mt-4 text-2xl font-semibold tracking-[-0.03em]">Give tomorrow a clean start.</h2><p className="mt-3 leading-7 text-[#c7d0cd]">Reconcile the day with shifts, cash, reports, exports, and a visible audit trail.</p></article>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <div className="grid items-center gap-10 rounded-[1.5rem] bg-[#d7ebe7] p-7 sm:p-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Real product screens</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">This is the actual application.</h2></div>
          <p className="text-lg leading-8 text-[#405552]">Every screenshot below is the real BUPOS product, shown with a sample store loaded. What you see here is what your team would use.</p>
        </div>
      </section>

      <section id="screens" aria-label="BUPOS product screens" className="border-y border-[#15201f]/12 bg-[#15201f] text-[#f4f1eb]">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <div className="grid gap-10 md:grid-cols-2">{screens.map((screen) => <figure key={screen.label} className="overflow-hidden rounded-[1.25rem] border border-[#f4f1eb]/20 bg-white text-[#15201f] shadow-[0_18px_50px_rgba(0,0,0,0.2)]"><Image src={screen.image} alt={screen.alt} width={1280} height={720} loading="eager" className="h-auto w-full" /><figcaption className="p-5"><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#0b8279]">{screen.label}</p><h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{screen.title}</h3><p className="mt-2 leading-7 text-[#30413d]">{screen.text}</p></figcaption></figure>)}</div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <div className="rounded-[1.5rem] bg-[#d7ebe7] p-7 sm:p-12">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Built for this trade</p>
          <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">Generic POS wasn&apos;t built for size runs and special orders. BUPOS was.</h2>
          <p className="mt-5 max-w-3xl text-lg leading-8 text-[#405552]">A 34×30 work pant is not just another SKU. Uniform retail needs the run, the counter conversation, and the order history to stay connected.</p>
          <div className="mt-10 grid gap-5 md:grid-cols-2">{tradeFeatures.map(([title, text]) => <article key={title} className="rounded-2xl bg-white/75 p-6"><h3 className="text-xl font-semibold">{title}</h3><p className="mt-3 leading-7 text-[#30413d]">{text}</p></article>)}</div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <div className="grid items-center gap-10 rounded-[1.5rem] border border-[#15201f]/15 bg-white p-7 sm:p-12 lg:grid-cols-[1fr_0.9fr]">
          <div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Switching?</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">Still on QuickBooks POS?</h2><p className="mt-5 text-lg leading-8 text-[#30413d]">BUPOS includes a QuickBooks-ready daily sales journal export. Review your current catalog, register, and reporting workflow before deciding what a future migration would need.</p></div>
          <div className="rounded-2xl bg-[#f4f1eb] p-6"><p className="font-semibold">A useful evaluation checklist</p><ul className="mt-4 space-y-3 text-[#30413d]"><li>• Map your register, catalog, and reporting workflow.</li><li>• Review what should move and what should be reconciled.</li><li>• Test the sample checkout and manager views with your questions in mind.</li></ul><Link href="/support" className="mt-6 inline-flex rounded-full bg-[#15201f] px-5 py-3 font-semibold text-white hover:bg-[#0b8279]">Review evaluation notes</Link></div>
        </div>
      </section>

      <section id="features" className="bg-white"><div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">The full list</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">Everything else it does.</h2><p className="mt-5 text-lg leading-8 text-[#30413d]">The complete BUPOS feature set, grouped by the jobs a store has to get done.</p></div><div className="mt-10 divide-y divide-[#15201f]/12 border-y border-[#15201f]/15">{featureGroups.map(([title, text]) => <details key={title} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 font-semibold text-[#0b8279]"><span>{title}</span><span className="text-2xl font-normal text-[#52605d] transition-transform group-open:rotate-45">+</span></summary><p className="max-w-3xl pt-4 leading-7 text-[#30413d]">{text}</p></details>)}</div></div></section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="grid items-center gap-10 rounded-[1.5rem] bg-[#d7ebe7] p-7 sm:p-12 lg:grid-cols-[1fr_auto]"><div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Safe product evaluation</p><h2 className="mt-4 max-w-2xl text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">See it for yourself.</h2><p className="mt-5 max-w-2xl text-lg leading-8 text-[#405552]">The demo runs in your browser with sample store data. No account, no install, and no production writes. No real payment is processed.</p></div><div className="flex flex-wrap gap-3"><Link href="/demo" className="rounded-full bg-[#15201f] px-6 py-3.5 text-center font-semibold text-white hover:bg-[#0b8279]">Open the demo</Link><Link href="/support" className="rounded-full border border-[#15201f]/20 px-6 py-3.5 text-center font-semibold hover:border-[#0b8279] hover:text-[#0b8279]">Evaluation &amp; support</Link></div></div></section>

      <footer className="border-t border-[#15201f]/15 px-5 py-8 sm:px-8"><div className="mx-auto flex max-w-6xl flex-col gap-3 text-sm text-[#52605d] sm:flex-row sm:items-center sm:justify-between"><span>BasicUniformPOS · Web-first POS for uniform &amp; workwear retail · © 2026 BasicUniformPOS</span><div className="flex flex-wrap gap-5"><Link href="/demo" className="hover:text-[#0b8279]">Demo</Link><Link href="#features" className="hover:text-[#0b8279]">Features</Link><Link href="/privacy" className="hover:text-[#0b8279]">Privacy</Link><Link href="/terms" className="hover:text-[#0b8279]">Terms</Link><Link href="/support" className="hover:text-[#0b8279]">Support</Link></div></div></footer>
    </main>
  );
}
