"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatCurrency } from "@/lib/format";

type Product = {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number;
  tone: string;
};

type CartLine = Product & { quantity: number };

const products: Product[] = [
  { id: 1, name: "Classic Polo", category: "Uniforms", price: 28, stock: 42, tone: "bg-teal-100 text-teal-800" },
  { id: 2, name: "Work Pants", category: "Uniforms", price: 44, stock: 18, tone: "bg-slate-100 text-slate-800" },
  { id: 3, name: "Safety Vest", category: "Safety", price: 16, stock: 27, tone: "bg-amber-100 text-amber-800" },
  { id: 4, name: "Name Patch", category: "Accessories", price: 8, stock: 64, tone: "bg-violet-100 text-violet-800" },
  { id: 5, name: "Oxford Shirt", category: "Uniforms", price: 36, stock: 11, tone: "bg-blue-100 text-blue-800" },
  { id: 6, name: "Shop Apron", category: "Accessories", price: 22, stock: 23, tone: "bg-rose-100 text-rose-800" },
];

const barClasses = ["h-[35%]", "h-[48%]", "h-[42%]", "h-[62%]", "h-[56%]", "h-[78%]", "h-[68%]", "h-[92%]", "h-[74%]", "h-[84%]", "h-[58%]", "h-[44%]"];

const money = (value: number) => formatCurrency(value);

export function DemoConsole() {
  const [activeTab, setActiveTab] = useState<"register" | "inventory" | "reports">("register");
  const [cart, setCart] = useState<CartLine[]>([
    { ...products[0], quantity: 2 },
    { ...products[3], quantity: 1 },
  ]);
  const [message, setMessage] = useState("Demo register ready");

  const subtotal = useMemo(() => cart.reduce((sum, item) => sum + item.price * item.quantity, 0), [cart]);
  const tax = subtotal * 0.0825;
  const total = subtotal + tax;
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  function addToCart(product: Product) {
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      if (existing) return current.map((item) => item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      return [...current, { ...product, quantity: 1 }];
    });
    setMessage(`${product.name} added to cart`);
  }

  function removeFromCart(id: number) {
    setCart((current) => current.flatMap((item) => {
      if (item.id !== id) return [item];
      if (item.quantity > 1) return [{ ...item, quantity: item.quantity - 1 }];
      return [];
    }));
    setMessage("Cart updated");
  }

  function completeDemoSale() {
    setMessage(`Demo sale complete — ${money(total)} simulated, nothing was charged`);
    setCart([]);
  }

  return (
    <main className="min-h-[100dvh] bg-slate-100 text-slate-950">
      <div className="border-b border-teal-900/20 bg-teal-950 text-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-400 font-black text-teal-950">B</div>
              <span className="text-lg font-bold tracking-tight">BasicUniformPOS</span>
              <span className="rounded-full border border-teal-300/40 px-2 py-0.5 text-xs font-semibold text-teal-100">INTERACTIVE DEMO</span>
            </div>
            <p className="mt-2 text-sm text-teal-100">A safe, simulated store terminal — explore freely without an account.</p>
          </div>
          <Link href="/" className="text-sm font-semibold text-teal-100 underline decoration-teal-300 underline-offset-4 hover:text-white">Back to BasicUniformPOS</Link>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-teal-700">Demo store · Torrance sample location</p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">See the register in action.</h1>
            <p className="mt-2 max-w-2xl text-base text-slate-600">Add sample products, inspect stock, and preview the manager view. Every number on this page is fixture data; no sale, payment, or inventory change reaches BUPOS.</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <div className="flex items-center gap-2 font-bold"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Demo mode is on</div>
            <div className="mt-1 text-emerald-800">No login · no real data · no external actions</div>
          </div>
        </div>

        <div className="mb-5 flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm" role="tablist" aria-label="Demo views">
          {([
            ["register", "Register"],
            ["inventory", "Inventory"],
            ["reports", "Manager view"],
          ] as const).map(([tab, label]) => (
            <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)} className={`rounded-xl px-4 py-3 text-sm font-bold transition-colors ${activeTab === tab ? "bg-teal-700 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"}`}>
              {label}
            </button>
          ))}
          <div className="ml-auto hidden items-center px-3 text-sm text-slate-500 sm:flex"><span className="mr-2 font-mono text-xs">DEMO-001</span> Open shift · Alex Cashier</div>
        </div>

        {activeTab === "register" && (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Simulated register">
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div><h2 className="text-xl font-bold">Good morning, Alex</h2><p className="mt-1 text-sm text-slate-500">Choose a product to add it to the simulated cart.</p></div>
                <div className="rounded-xl bg-slate-100 px-3 py-2 text-right text-sm"><div className="font-bold text-slate-900">Open shift</div><div className="text-slate-500">Started 8:02 AM</div></div>
              </div>
              <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto]">
                <label className="flex items-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"><span className="mr-2 text-slate-400">⌕</span><input aria-label="Search demo products" className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400" placeholder="Search products" /></label>
                <button type="button" onClick={() => setMessage("Barcode scanner is simulated in this demo")} className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-bold text-slate-700 hover:border-teal-600 hover:text-teal-700">Scan item</button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((product) => <button key={product.id} type="button" onClick={() => addToCart(product)} className="group rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-teal-500 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-teal-600 focus:ring-offset-2"><div className={`mb-4 flex h-20 items-center justify-center rounded-xl text-3xl font-black ${product.tone}`}>{product.name.slice(0, 1)}</div><div className="font-bold group-hover:text-teal-700">{product.name}</div><div className="mt-1 flex items-center justify-between text-sm"><span className="text-slate-500">{product.category}</span><span className="font-bold">{money(product.price)}</span></div><div className="mt-3 text-xs text-slate-400">{product.stock} in stock · Tap to add</div></button>)}
              </div>
            </section>

            <aside className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Simulated cart">
              <div className="flex items-start justify-between"><div><h2 className="text-xl font-bold">Current sale</h2><p className="mt-1 text-sm text-slate-500">{itemCount} {itemCount === 1 ? "item" : "items"}</p></div><span className="rounded-full bg-teal-50 px-3 py-1 text-xs font-bold text-teal-800">#{""}1048</span></div>
              <div className="my-5 min-h-40 space-y-3 border-y border-slate-200 py-4">
                {cart.length === 0 ? <div className="flex min-h-32 items-center justify-center text-center text-sm text-slate-500">Your simulated cart is empty.<br />Tap a product to start.</div> : cart.map((item) => <div key={item.id} className="flex items-center justify-between gap-3"><div><div className="font-semibold">{item.name}</div><div className="text-xs text-slate-500">{item.quantity} × {money(item.price)}</div></div><button type="button" onClick={() => removeFromCart(item.id)} className="rounded-lg px-2 py-1 text-xs font-bold text-slate-500 hover:bg-red-50 hover:text-red-700">Remove</button></div>)}
              </div>
              <div className="space-y-2 text-sm"><div className="flex justify-between text-slate-600"><span>Subtotal</span><span>{money(subtotal)}</span></div><div className="flex justify-between text-slate-600"><span>Tax · 8.25%</span><span>{money(tax)}</span></div><div className="flex justify-between border-t border-slate-200 pt-3 text-lg font-bold"><span>Total</span><span>{money(total)}</span></div></div>
              <button type="button" onClick={completeDemoSale} disabled={cart.length === 0} className="mt-5 w-full rounded-xl bg-teal-700 px-4 py-4 text-base font-bold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300">Preview checkout</button>
              <p className="mt-3 text-center text-xs text-slate-500">{message}</p>
            </aside>
          </div>
        )}

        {activeTab === "inventory" && <DemoInventory />}
        {activeTab === "reports" && <DemoReports />}

        <div className="mt-8 grid gap-4 border-t border-slate-200 pt-6 text-sm text-slate-600 sm:grid-cols-3">
          <div><div className="font-bold text-slate-900">Built for the counter</div><p className="mt-1">Large touch targets, fast product lookup, and clear sale state.</p></div>
          <div><div className="font-bold text-slate-900">Built for managers</div><p className="mt-1">Inventory, shifts, reports, and approvals stay visible.</p></div>
          <div><div className="font-bold text-slate-900">Safe to explore</div><p className="mt-1">This preview has no account system, backend writes, or payment integration.</p></div>
        </div>
      </div>
    </main>
  );
}

function DemoInventory() {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="mb-6 flex items-end justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-700">Sample stock ledger</p><h2 className="mt-2 text-2xl font-bold">Inventory at a glance</h2></div><span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800">2 reorder soon</span></div><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><tr><th className="pb-3">Product</th><th className="pb-3">Category</th><th className="pb-3">On hand</th><th className="pb-3">Reorder point</th><th className="pb-3">Status</th></tr></thead><tbody>{products.map((product) => { const low = product.stock < 15; return <tr key={product.id} className="border-b border-slate-100"><td className="py-4 font-bold">{product.name}</td><td className="py-4 text-slate-500">{product.category}</td><td className="py-4 font-mono">{product.stock}</td><td className="py-4 font-mono">15</td><td className="py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${low ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-900"}`}>{low ? "Reorder soon" : "Healthy"}</span></td></tr>; })}</tbody></table></div></section>;
}

function DemoReports() {
  return <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]"><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-700">Today · simulated</p><h2 className="mt-2 text-2xl font-bold">Store health</h2><div className="mt-6 grid gap-4 sm:grid-cols-3"><Metric label="Sales" value="$2,486" detail="42 transactions" /><Metric label="Average ticket" value="$59.19" detail="↑ 8.4% vs last week" /><Metric label="Open shifts" value="2" detail="All terminals healthy" /></div><div className="mt-8 rounded-2xl bg-slate-50 p-5"><div className="mb-4 flex items-center justify-between"><span className="font-bold">Sales by hour</span><span className="text-xs text-slate-500">Fixture data</span></div><div className="flex h-36 items-end gap-2">{barClasses.map((barClass, index) => <div key={index} className="flex flex-1 flex-col items-center gap-2"><div className={`w-full rounded-t-lg bg-teal-600/80 ${barClass}`} /><span className="text-[10px] text-slate-400">{index + 8}</span></div>)}</div></div></div><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Manager attention</p><h2 className="mt-2 text-2xl font-bold">3 items</h2></div><span className="text-2xl">!</span></div><div className="mt-6 space-y-3"><Attention title="Work Pants stock is low" detail="11 units remaining" tone="amber" /><Attention title="Shift close pending" detail="Alex Cashier · Register 1" tone="slate" /><Attention title="Supplier order due" detail="Uniform Supply Co. · Tomorrow" tone="blue" /></div><button type="button" onClick={() => alert("Manager actions are disabled in the public demo.")} className="mt-6 w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-bold text-slate-700 hover:border-teal-600 hover:text-teal-700">Preview manager actions</button></div></section>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="rounded-2xl border border-slate-200 p-4"><div className="text-sm text-slate-500">{label}</div><div className="mt-2 text-2xl font-bold tracking-tight">{value}</div><div className="mt-1 text-xs text-slate-500">{detail}</div></div>; }
function Attention({ title, detail, tone }: { title: string; detail: string; tone: "amber" | "slate" | "blue" }) { const colors = { amber: "bg-amber-100 text-amber-900", slate: "bg-slate-100 text-slate-700", blue: "bg-blue-100 text-blue-900" }; return <div className="flex gap-3 rounded-xl border border-slate-200 p-3"><span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${colors[tone].split(" ")[0]}`} /><div><div className="text-sm font-bold">{title}</div><div className="mt-1 text-xs text-slate-500">{detail}</div></div></div>; }
