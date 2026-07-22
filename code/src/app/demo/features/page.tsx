import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "BUPOS | Retail POS for uniform stores",
  description:
    "A connected POS for uniform and specialty retail: sell at the counter, track sizes and stock, manage purchasing, and understand the day.",
  openGraph: {
    title: "BUPOS | Retail POS for uniform stores",
    description:
      "See the register, inventory, purchasing, reporting, and customer workflows in BUPOS.",
    images: [
      {
        url: "/demo/register-sale.png",
        width: 3840,
        height: 2264,
        alt: "BUPOS register showing a sample retail sale",
      },
    ],
  },
};

const screens = [
  {
    label: "Dashboard",
    title: "See what sold and what needs attention.",
    text: "Sales, transactions, shifts, payment methods, employee performance, and recent activity start in one manager view.",
    image: "/showcase/admin-dashboard.png",
    alt: "BUPOS sales dashboard with sample store activity",
  },
  {
    label: "Catalog",
    title: "Keep sizes, colors, and variants connected.",
    text: "Products, variants, categories, bundles, modifiers, labels, and pricing give the counter a dependable product record.",
    image: "/showcase/admin-products.png",
    alt: "BUPOS product catalog with sample products and variants",
  },
  {
    label: "Inventory",
    title: "Know what is on the shelf before you promise it.",
    text: "Inventory, ledger, adjustments, stocktakes, transfers, forecasting, and reorder suggestions keep the stockroom connected to the register.",
    image: "/showcase/admin-inventory.png",
    alt: "BUPOS inventory screen with sample stock levels",
  },
  {
    label: "Purchasing",
    title: "See what was ordered, what arrived, and what is next.",
    text: "Suppliers, purchase orders, receiving, supplier performance, and returns keep buying work tied to the store floor.",
    image: "/showcase/admin-purchasing.png",
    alt: "BUPOS purchase orders screen with a sample replenishment order",
  },
  {
    label: "Reporting",
    title: "Close the day with an explanation, not a mystery.",
    text: "Sales summaries, transaction search, shift reports, cash drawer, exports, EOD reports, and audit history make the numbers useful.",
    image: "/showcase/admin-reports.png",
    alt: "BUPOS reports screen with sample sales results",
  },
  {
    label: "Customers",
    title: "Remember the person, not just the sale.",
    text: "Customer records, preferences, segments, loyalty, promotions, special orders, returns, and store credit keep service personal and accountable.",
    image: "/showcase/admin-customers.png",
    alt: "BUPOS customer management screen with sample loyalty records",
  },
];

const featureGroups = [
  ["Sell", "Register, POS, tenders, receipts, returns, exchanges, gift cards, store credit, special orders, layaways, and customer display."],
  ["Catalog", "Products, variants, categories, bundles, modifiers, pricing, CSV import, labels, product search, and publishing."],
  ["Stock", "Inventory, ledger, adjustments, stocktakes, transfers, forecasting, reorder suggestions, location stock, and offline sync."],
  ["Buy", "Suppliers, purchase orders, supplier performance, receiving, supplier returns, forecasting, and receiving history."],
  ["Customers", "Customer records, preferences, segments, loyalty, promotions, promo codes, store credit, gift cards, and self-signup."],
  ["Run the day", "Dashboard, shifts, shift close, clock-in, cash drawer, pay-ins, pay-outs, expenses, tax configuration, and EOD reporting."],
  ["Understand", "Sales reports, store views, transaction search, returns search, shift reports, exports, audit events, health checks, and diagnostics."],
  ["Online selling", "Publishable products, channel mapping, Shopify reconciliation, online-order reconciliation, webhooks, and POS-authoritative inventory sync."],
  ["People and control", "Employees, roles, permissions, location assignment, settings, approvals, help, and diagnostics."],
  ["Works when the internet doesn't", "Offline register behavior, safe sync, terminal linking, session controls, and customer display state."],
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
            <Link href="#features" className="hidden text-[#30413d] hover:text-[#0b8279] sm:inline">Feature reference</Link>
            <a href="mailto:edison@idiotic.solutions?subject=BUPOS%20walkthrough" className="hidden text-[#30413d] hover:text-[#0b8279] sm:inline">Book a walkthrough</a>
            <Link href="/demo" className="rounded-full bg-[#15201f] px-4 py-2 font-semibold text-white hover:bg-[#0b8279]">Try the demo</Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 pb-16 pt-14 sm:px-8 sm:pb-24 sm:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[0.82fr_1.18fr]">
          <div>
            <p className="mb-6 text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Retail POS for uniform and specialty stores</p>
            <h1 className="max-w-xl text-5xl font-semibold leading-[0.98] tracking-[-0.06em] sm:text-7xl">Sell the right size. Know what is next.</h1>
            <p className="mt-7 max-w-xl text-xl leading-8 text-[#30413d]">BUPOS connects the register, size-and-color catalog, stockroom, purchasing, customers, and manager view—so the store team can stay with the customer instead of chasing the system.</p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link href="/demo" className="rounded-full bg-[#0b8279] px-5 py-3 font-semibold text-white shadow-sm hover:bg-[#086b64]">Try the no-login demo</Link>
              <a href="mailto:edison@idiotic.solutions?subject=BUPOS%20walkthrough" className="rounded-full border border-[#15201f]/20 px-5 py-3 font-semibold text-[#15201f] hover:border-[#0b8279] hover:text-[#0b8279]">Book a walkthrough</a>
            </div>
            <p className="mt-5 text-sm text-[#52605d]">No signup, nothing to install, and no real checkout actions.</p>
          </div>
          <figure className="overflow-hidden rounded-[1.5rem] border border-[#15201f]/15 bg-white shadow-[0_24px_70px_rgba(21,32,31,0.14)]">
            <Image src="/demo/register-sale.png" alt="BUPOS register showing a sample retail sale" width={3840} height={2264} priority className="h-auto w-full" />
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
          <div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Built around uniform-store work</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">A product record that respects the size run.</h2></div>
          <div className="space-y-4 text-lg leading-8 text-[#405552]"><p>Keep variants, sizes, colors, prices, and stock connected instead of making the counter search across separate tools.</p><p>Then carry that context into purchasing, customer records, loyalty, returns, and the manager&apos;s daily view.</p><p className="text-base text-[#30413d]">BUPOS is designed for the practical work of uniform and specialty retail—not a generic dashboard with a barcode bolted on.</p></div>
        </div>
      </section>

      <section id="screens" className="border-y border-[#15201f]/12 bg-[#15201f] text-[#f4f1eb]">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#8fd0c6]">See BUPOS in use</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">One store day, from sale to close.</h2><p className="mt-5 text-lg leading-8 text-[#c7d0cd]">These are real BUPOS product screens shown with sample store data. The same system follows the work from the register to the stockroom and back to the manager.</p></div>
          <div className="mt-14 grid gap-10 md:grid-cols-2">{screens.map((screen) => <figure key={screen.label} className="overflow-hidden rounded-[1.25rem] border border-[#f4f1eb]/20 bg-white text-[#15201f] shadow-[0_18px_50px_rgba(0,0,0,0.2)]"><Image src={screen.image} alt={screen.alt} width={1280} height={720} loading="eager" className="h-auto w-full" /><figcaption className="p-5"><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#0b8279]">{screen.label}</p><h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{screen.title}</h3><p className="mt-2 leading-7 text-[#30413d]">{screen.text}</p></figcaption></figure>)}</div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <div className="grid items-center gap-10 rounded-[1.5rem] border border-[#15201f]/15 bg-white p-7 sm:p-12 lg:grid-cols-[1fr_0.9fr]">
          <div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Switching systems?</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">Make the QuickBooks POS conversation concrete.</h2><p className="mt-5 text-lg leading-8 text-[#30413d]">BUPOS includes a QuickBooks-ready daily sales journal export. Book a walkthrough to review your current workflow, the data you need to preserve, and a practical migration plan before changing systems.</p></div>
          <div className="rounded-2xl bg-[#f4f1eb] p-6"><p className="font-semibold">A useful first conversation</p><ul className="mt-4 space-y-3 text-[#30413d]"><li>• Map your register, catalog, and reporting workflow.</li><li>• Review what should move and what should be reconciled.</li><li>• See the checkout and manager flows with your questions in mind.</li></ul><a href="mailto:edison@idiotic.solutions?subject=QuickBooks%20POS%20migration%20walkthrough" className="mt-6 inline-flex rounded-full bg-[#15201f] px-5 py-3 font-semibold text-white hover:bg-[#0b8279]">Talk through the switch</a></div>
        </div>
      </section>

      <section id="features" className="bg-white"><div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Feature reference</p><h2 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">The details are here when you need them.</h2><p className="mt-5 text-lg leading-8 text-[#30413d]">Start with the workflows above. Open the reference when you are comparing coverage.</p></div><div className="mt-10 divide-y divide-[#15201f]/12 border-y border-[#15201f]/15">{featureGroups.map(([title, text]) => <details key={title} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 font-semibold text-[#0b8279]"><span>{title}</span><span className="text-2xl font-normal text-[#52605d] transition-transform group-open:rotate-45">+</span></summary><p className="max-w-3xl pt-4 leading-7 text-[#30413d]">{text}</p></details>)}</div></div></section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"><div className="grid items-center gap-10 rounded-[1.5rem] bg-[#d7ebe7] p-7 sm:p-12 lg:grid-cols-[1fr_auto]"><div><p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">Start with a safe look</p><h2 className="mt-4 max-w-2xl text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">See the counter before you hand over a store login.</h2><p className="mt-5 max-w-2xl text-lg leading-8 text-[#405552]">The public demo uses simulated data. No signup, payment, inventory mutation, or production write is involved.</p></div><div className="flex flex-wrap gap-3"><Link href="/demo" className="rounded-full bg-[#15201f] px-6 py-3.5 text-center font-semibold text-white hover:bg-[#0b8279]">Try the demo</Link><a href="mailto:edison@idiotic.solutions?subject=BUPOS%20walkthrough" className="rounded-full border border-[#15201f]/20 px-6 py-3.5 text-center font-semibold hover:border-[#0b8279] hover:text-[#0b8279]">Book a walkthrough</a></div></div></section>

      <footer className="border-t border-[#15201f]/15 px-5 py-8 sm:px-8"><div className="mx-auto flex max-w-6xl flex-col gap-3 text-sm text-[#52605d] sm:flex-row sm:items-center sm:justify-between"><span>BUPOS · retail POS for uniform and specialty stores</span><div className="flex gap-5"><Link href="/demo" className="hover:text-[#0b8279]">Interactive demo</Link><a href="mailto:edison@idiotic.solutions?subject=BUPOS%20question" className="hover:text-[#0b8279]">Contact</a><Link href="/" className="hover:text-[#0b8279]">Main site</Link></div></div></footer>
    </main>
  );
}
