import type { PublishProductInput } from "./types";

/**
 * Pure BuPOS-product → channel-publish mapping. No DB or secrets, so it can be
 * unit-tested directly. Kept separate from repo.ts (which does the I/O) because
 * the option-derivation is the subtle, bug-prone part worth covering in tests.
 */

export interface PublishCandidateVariant {
  variantId: string;
  sku: string;
  price: number;
  compareAtPrice: number | null;
  name: string;
  sizeLabel: string | null;
  colorLabel: string | null;
  onHand: number;
}

function distinct(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * Derive a product's options from its variants' size/color labels (or a single
 * "Title" option for label-less products) and attach each variant's option
 * coordinates. A variant missing a label its siblings have gets "Default" for
 * that dimension, so the option value list and the per-variant coordinate agree.
 */
export function buildPublishInput(
  product: { name: string; description: string | null },
  variants: PublishCandidateVariant[],
  shopifyLocationId: string,
  status: "ACTIVE" | "DRAFT" = "ACTIVE",
): PublishProductInput {
  const norm = (s: string | null) => (s && s.trim() ? s.trim() : null);
  const hasSize = variants.some((v) => norm(v.sizeLabel));
  const hasColor = variants.some((v) => norm(v.colorLabel));

  let options: { name: string; values: string[] }[];
  let optionValuesFor: (v: PublishCandidateVariant) => { optionName: string; name: string }[];

  if (hasSize || hasColor) {
    const sizeVal = (v: PublishCandidateVariant) => norm(v.sizeLabel) ?? "Default";
    const colorVal = (v: PublishCandidateVariant) => norm(v.colorLabel) ?? "Default";
    options = [];
    if (hasSize) options.push({ name: "Size", values: distinct(variants.map(sizeVal)) });
    if (hasColor) options.push({ name: "Color", values: distinct(variants.map(colorVal)) });
    optionValuesFor = (v) => {
      const ov: { optionName: string; name: string }[] = [];
      if (hasSize) ov.push({ optionName: "Size", name: sizeVal(v) });
      if (hasColor) ov.push({ optionName: "Color", name: colorVal(v) });
      return ov;
    };
  } else if (variants.length === 1) {
    // Single label-less variant → Shopify's canonical default option.
    options = [{ name: "Title", values: ["Default Title"] }];
    optionValuesFor = () => [{ optionName: "Title", name: "Default Title" }];
  } else {
    // Multiple label-less variants → one "Title" option keyed by variant name
    // (SKU fallback guarantees a unique coordinate per variant).
    const titleVal = (v: PublishCandidateVariant) => norm(v.name) ?? v.sku;
    options = [{ name: "Title", values: distinct(variants.map(titleVal)) }];
    optionValuesFor = (v) => [{ optionName: "Title", name: titleVal(v) }];
  }

  return {
    title: product.name,
    descriptionHtml: product.description,
    status,
    options,
    variants: variants.map((v) => ({
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      optionValues: optionValuesFor(v),
      onHand: v.onHand,
    })),
    shopifyLocationId,
  };
}
