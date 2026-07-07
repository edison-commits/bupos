/**
 * Online Selling (Shopify channel) — pure-logic unit tests (no DB):
 * AES-GCM secret encryption, webhook HMAC verification, and order parsing.
 */
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/channels/crypto";
import { shopifyProvider } from "@/lib/channels/shopify";
import { signWebhookBody, mockProvider, mockPriceSetCalls, mockInventorySetCalls, mockPublishCalls, resetMock } from "@/lib/channels/shopify.mock";
import { buildPublishInput, type PublishCandidateVariant } from "@/lib/channels/publish-mapping";

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
    const payloadStart = "gcm1.".length;
    const tampered = `${enc.slice(0, payloadStart)}${enc[payloadStart] === "A" ? "B" : "A"}${enc.slice(payloadStart + 1)}`;
    expect(await decryptSecret(tampered)).toBeNull(); // tampered iv/ciphertext payload
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

describe("channels/publish-mapping: BuPOS product → Shopify options (P3c)", () => {
  const v = (over: Partial<PublishCandidateVariant>): PublishCandidateVariant => ({
    variantId: "id", sku: "SKU", price: 10, compareAtPrice: null, name: "V", sizeLabel: null, colorLabel: null, onHand: 0, ...over,
  });

  it("a single label-less variant uses Shopify's default Title option", () => {
    const input = buildPublishInput({ name: "Plain Tee", description: null }, [v({ sku: "TEE-1", price: 12.5 })], "gid://shopify/Location/1");
    expect(input.title).toBe("Plain Tee");
    expect(input.status).toBe("ACTIVE");
    expect(input.options).toEqual([{ name: "Title", values: ["Default Title"] }]);
    expect(input.variants).toHaveLength(1);
    expect(input.variants[0]).toMatchObject({ sku: "TEE-1", price: 12.5, optionValues: [{ optionName: "Title", name: "Default Title" }] });
    expect(input.shopifyLocationId).toBe("gid://shopify/Location/1");
  });

  it("builds Size + Color options from labels with distinct values + per-variant coordinates", () => {
    const input = buildPublishInput({ name: "Polo", description: "desc" }, [
      v({ sku: "P-S-RED", sizeLabel: "S", colorLabel: "Red", price: 20, compareAtPrice: 25, onHand: 3 }),
      v({ sku: "P-M-RED", sizeLabel: "M", colorLabel: "Red", price: 20 }),
      v({ sku: "P-S-BLU", sizeLabel: "S", colorLabel: "Blue", price: 22 }),
    ], "loc");
    expect(input.descriptionHtml).toBe("desc");
    expect(input.options).toEqual([
      { name: "Size", values: ["S", "M"] },
      { name: "Color", values: ["Red", "Blue"] },
    ]);
    expect(input.variants[0].optionValues).toEqual([{ optionName: "Size", name: "S" }, { optionName: "Color", name: "Red" }]);
    expect(input.variants[0]).toMatchObject({ compareAtPrice: 25, onHand: 3 });
    expect(input.variants.map((x) => x.sku)).toEqual(["P-S-RED", "P-M-RED", "P-S-BLU"]);
  });

  it("a single-dimension product yields just that option", () => {
    const input = buildPublishInput({ name: "Cap", description: null }, [v({ sku: "C-S", sizeLabel: "S" }), v({ sku: "C-L", sizeLabel: "L" })], "loc");
    expect(input.options).toEqual([{ name: "Size", values: ["S", "L"] }]);
    expect(input.variants[1].optionValues).toEqual([{ optionName: "Size", name: "L" }]);
  });

  it("multiple label-less variants fall back to a Title option keyed by name", () => {
    const input = buildPublishInput({ name: "Bundle", description: null }, [v({ sku: "B1", name: "Small Bundle" }), v({ sku: "B2", name: "Large Bundle" })], "loc");
    expect(input.options).toEqual([{ name: "Title", values: ["Small Bundle", "Large Bundle"] }]);
    expect(input.variants[0].optionValues).toEqual([{ optionName: "Title", name: "Small Bundle" }]);
  });

  it("a variant missing a label its siblings have gets a 'Default' coordinate", () => {
    const input = buildPublishInput({ name: "Mixed", description: null }, [v({ sku: "M1", sizeLabel: "S" }), v({ sku: "M2", sizeLabel: null })], "loc");
    expect(input.options).toEqual([{ name: "Size", values: ["S", "Default"] }]);
    expect(input.variants[1].optionValues).toEqual([{ optionName: "Size", name: "Default" }]);
  });
});

describe("channels mock (P3c): publishProduct records the call + maps variants by SKU", () => {
  it("returns a sku-keyed variant mapping and records the publish", async () => {
    resetMock();
    const creds = { shopDomain: "x.myshopify.com", accessToken: "t" };
    const res = await mockProvider.publishProduct(creds, {
      title: "Polo", descriptionHtml: null, status: "ACTIVE",
      options: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: "P-S", price: 20, compareAtPrice: null, optionValues: [{ optionName: "Size", name: "S" }], onHand: 4 },
        { sku: "P-M", price: 20, compareAtPrice: null, optionValues: [{ optionName: "Size", name: "M" }], onHand: 2 },
      ],
      shopifyLocationId: "gid://shopify/Location/1",
    });
    expect(res.ok).toBe(true);
    expect(res.externalProductId).toContain("Product/Polo");
    expect(res.variants?.map((x) => x.sku)).toEqual(["P-S", "P-M"]);
    expect(res.variants?.[0].externalVariantId).toContain("ProductVariant/P-S");
    expect(mockPublishCalls[0]).toMatchObject({ title: "Polo", optionNames: ["Size"], skus: ["P-S", "P-M"], status: "ACTIVE" });
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
