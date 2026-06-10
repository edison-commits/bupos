/**
 * Online Selling (Shopify channel) — pure-logic unit tests (no DB):
 * AES-GCM secret encryption, webhook HMAC verification, and order parsing.
 */
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/channels/crypto";
import { shopifyProvider } from "@/lib/channels/shopify";
import { signWebhookBody, mockProvider, mockPriceSetCalls, mockInventorySetCalls, resetMock } from "@/lib/channels/shopify.mock";

describe("channels/crypto: AES-256-GCM secret storage", () => {
  it("round-trips a token and uses the versioned format", async () => {
    const enc = await encryptSecret("shpat_supersecrettoken");
    expect(enc.startsWith("gcm1.")).toBe(true);
    expect(enc).not.toContain("shpat_supersecrettoken"); // ciphertext, not plaintext
    expect(await decryptSecret(enc)).toBe("shpat_supersecrettoken");
  });
  it("uses a random IV (two encryptions of the same value differ)", async () => {
    const a = await encryptSecret("same");
    const b = await encryptSecret("same");
    expect(a).not.toBe(b);
    expect(await decryptSecret(a)).toBe("same");
    expect(await decryptSecret(b)).toBe("same");
  });
  it("returns null on tampered / malformed / missing input", async () => {
    const enc = await encryptSecret("x");
    expect(await decryptSecret(enc.slice(0, -2) + "zz")).toBeNull(); // tampered tag
    expect(await decryptSecret("gcm1.notbase64!!")).toBeNull();
    expect(await decryptSecret("plain:text")).toBeNull(); // wrong format
    expect(await decryptSecret(null)).toBeNull();
  });
});

describe("channels/shopify: webhook HMAC verification", () => {
  const secret = "shopify-app-api-secret";
  const body = JSON.stringify({ id: 123, line_items: [{ sku: "ABC", quantity: 1 }] });

  it("accepts a correctly-signed body", async () => {
    const sig = await signWebhookBody(body, secret);
    expect(await shopifyProvider.verifyWebhookHmac(body, sig, secret)).toBe(true);
  });
  it("rejects a flipped signature, wrong secret, tampered body, and missing header", async () => {
    const sig = await signWebhookBody(body, secret);
    const flipped = sig.slice(0, -2) + (sig.endsWith("A") ? "BB" : "AA");
    expect(await shopifyProvider.verifyWebhookHmac(body, flipped, secret)).toBe(false);
    expect(await shopifyProvider.verifyWebhookHmac(body, sig, "wrong-secret")).toBe(false);
    expect(await shopifyProvider.verifyWebhookHmac(body + " ", sig, secret)).toBe(false);
    expect(await shopifyProvider.verifyWebhookHmac(body, null, secret)).toBe(false);
  });
});

describe("channels/shopify: order payload parsing", () => {
  it("extracts order id, number, and line items by SKU/qty", () => {
    const order = shopifyProvider.parseOrderPayload(JSON.stringify({
      admin_graphql_api_id: "gid://shopify/Order/55",
      name: "#1001",
      financial_status: "paid",
      currency: "USD",
      subtotal_price: "20.00",
      total_price: "22.00",
      line_items: [
        { sku: "SKU-1", quantity: 2, title: "Tee", variant_id: 9, price: "10.00" },
        { sku: "", quantity: 1, title: "No SKU", variant_id: 10, price: "5.00" },
      ],
    }));
    expect(order?.externalOrderId).toBe("gid://shopify/Order/55");
    expect(order?.orderNumber).toBe("#1001");
    expect(order?.financialStatus).toBe("paid");
    expect(order?.lines).toHaveLength(2);
    expect(order?.lines[0]).toMatchObject({ sku: "SKU-1", quantity: 2 });
    expect(order?.lines[1].sku).toBeNull(); // empty SKU normalized to null (unresolved)
  });
  it("returns null on unparseable / id-less payloads", () => {
    expect(shopifyProvider.parseOrderPayload("not json")).toBeNull();
    expect(shopifyProvider.parseOrderPayload(JSON.stringify({ line_items: [] }))).toBeNull();
  });
});

describe("channels/shopify: refund payload parsing (P3a)", () => {
  it("restocks ONLY lines Shopify itself restocked (restock_type != no_restock)", () => {
    const refund = shopifyProvider.parseRefundPayload(JSON.stringify({
      order_id: 55,
      refund_line_items: [
        { quantity: 2, restock_type: "return", line_item: { sku: "SKU-1" } },
        { quantity: 1, restock_type: "no_restock", line_item: { sku: "SKU-2" } }, // NOT restocked by Shopify
        { quantity: 1, restock_type: "cancel", line_item: { sku: "SKU-3" } },
      ],
    }));
    expect(refund?.externalOrderId).toBe("gid://shopify/Order/55");
    expect(refund?.restockLines).toEqual([
      { sku: "SKU-1", quantity: 2 },
      { sku: "SKU-3", quantity: 1 },
    ]);
  });
  it("drops zero-qty / sku-less lines and returns null without an order_id", () => {
    const refund = shopifyProvider.parseRefundPayload(JSON.stringify({
      order_id: 7,
      refund_line_items: [
        { quantity: 0, restock_type: "return", line_item: { sku: "SKU-1" } },
        { quantity: 3, restock_type: "return", line_item: { sku: "" } },
      ],
    }));
    expect(refund?.restockLines).toEqual([]);
    expect(shopifyProvider.parseRefundPayload(JSON.stringify({ refund_line_items: [] }))).toBeNull();
    expect(shopifyProvider.parseRefundPayload("not json")).toBeNull();
  });
});

describe("channels mock provider (P2): records push calls + product GID", () => {
  const creds = { shopDomain: "x.myshopify.com", accessToken: "t" };
  it("findVariantBySku returns the external product id for price updates", async () => {
    resetMock();
    const lookup = await mockProvider.findVariantBySku(creds, "SKU-9");
    expect(lookup.kind).toBe("unique");
    if (lookup.kind === "unique") expect(lookup.match.externalProductId).toContain("Product/SKU-9");
  });
  it("setVariantPrice + setInventory record their calls", async () => {
    resetMock();
    await mockProvider.setVariantPrice(creds, "gid://Product/1", "gid://Variant/1", 19.99, 24.99);
    await mockProvider.setInventory(creds, "gid://Item/1", "gid://Location/1", 7);
    expect(mockPriceSetCalls[0]).toMatchObject({ price: 19.99, compareAt: 24.99 });
    expect(mockInventorySetCalls[0]).toMatchObject({ onHand: 7 });
  });
});
