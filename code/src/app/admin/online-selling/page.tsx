'use client';

import Link from "next/link";
import { ShopifyConnectPanel } from "@/components/admin/online-selling/ShopifyConnectPanel";
import { OnlineSalesPanel } from "@/components/admin/online-selling/OnlineSalesPanel";
import { PublishPanel } from "@/components/admin/online-selling/PublishPanel";

export default function OnlineSellingPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Online Selling</h1>
            <p className="text-gray-500">
              Connect a Shopify store. BuPOS pushes inventory counts to Shopify, and online orders
              draw down your chosen fulfillment location&apos;s stock.
            </p>
          </div>
          <Link href="/admin/online-selling/reconciliation" className="inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">
            Reconcile inventory
          </Link>
        </div>
        <OnlineSalesPanel />
        <PublishPanel />
        <ShopifyConnectPanel />
      </main>
    </div>
  );
}
