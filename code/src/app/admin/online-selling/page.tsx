'use client';

import { AdminTopNav } from "@/components/layout/admin-top-nav";
import { ShopifyConnectPanel } from "@/components/admin/online-selling/ShopifyConnectPanel";
import { OnlineSalesPanel } from "@/components/admin/online-selling/OnlineSalesPanel";
import { PublishPanel } from "@/components/admin/online-selling/PublishPanel";

export default function OnlineSellingPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <AdminTopNav />
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Online Selling</h1>
          <p className="text-gray-500">
            Connect a Shopify store. BuPOS pushes inventory counts to Shopify, and online orders
            draw down your chosen fulfillment location&apos;s stock.
          </p>
        </div>
        <OnlineSalesPanel />
        <PublishPanel />
        <ShopifyConnectPanel />
      </main>
    </div>
  );
}
