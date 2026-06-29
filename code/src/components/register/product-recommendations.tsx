'use client';
/* eslint-disable @next/next/no-img-element -- remote product images, width/height unknown */

import { useMemo } from 'react';
import type { Customer } from '@/lib/domain/types';
import { formatCurrency } from "@/lib/format";

interface ProductRecommendationsProps {
  currentCartItems: {
    productVariantId: string;
    productId: string;
    productName: string;
  }[];
  customer?: Customer;
  transactionEvents: {
    id: string;
    transactionId: string;
    eventKind: string;
    payload?: Record<string, string>;
    createdAt: string;
  }[];
  categories: {
    id: string;
    name: string;
  }[];
  products: {
    id: string;
    name: string;
    categoryId: string;
    imageUrl?: string;
    isActive: boolean;
  }[];
  variants: {
    id: string;
    productId: string;
    name: string;
    sku: string;
    price: number;
    sizeLabel?: string;
    colorLabel?: string;
    isActive: boolean;
  }[];
  inventory: {
    productVariantId: string;
    onHand: number;
  }[];
  onAddItem: (productId: string, variantId: string) => void;
}

interface RecommendationItem {
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  price: number;
  imageUrl?: string;
  score: number;
  reason: 'customer_preference' | 'frequently_bought_together' | 'category_suggestion';
  frequency: number;
  preferenceReasons: string[];
  inStock: boolean;
}

function normalize(value?: string) {
  return (value ?? '').trim().toLowerCase();
}

function includesNormalized(haystack: string | undefined, needle: string | undefined) {
  const h = normalize(haystack);
  const n = normalize(needle);
  return !!h && !!n && h.includes(n);
}

function addOrUpgradeRecommendation(
  recommendationMap: Map<string, RecommendationItem>,
  item: RecommendationItem,
) {
  const key = `${item.productId}-${item.variantId}`;
  const existing = recommendationMap.get(key);
  if (!existing || item.score > existing.score) {
    recommendationMap.set(key, item);
  }
}

export function ProductRecommendations({
  currentCartItems,
  customer,
  transactionEvents,
  categories,
  products,
  variants,
  inventory,
  onAddItem,
}: ProductRecommendationsProps) {
  const recommendations = useMemo(() => {
    const hasCustomerPreferences = (customer?.preferences?.length ?? 0) > 0;
    if (currentCartItems.length === 0 && !hasCustomerPreferences) return [];

    const cartProductIds = new Set(currentCartItems.map((item) => item.productId).filter(Boolean));
    const cartProductNames = new Set(currentCartItems.map((item) => item.productName));

    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    const productMap = new Map(products.map((p) => [p.id, p]));

    const activeVariantsByProductId = new Map<string, typeof variants>();
    for (const v of variants) {
      if (!v.isActive) continue;
      const bucket = activeVariantsByProductId.get(v.productId);
      if (bucket) bucket.push(v);
      else activeVariantsByProductId.set(v.productId, [v]);
    }

    const inventoryMap = new Map(
      inventory.map((i) => [i.productVariantId, i.onHand])
    );

    const recommendationMap = new Map<string, RecommendationItem>();

    // Strategy 0: explicit customer preference matching. This is intentionally
    // transparent and staff/customer-confirmed, not black-box AI.
    for (const preference of customer?.preferences ?? []) {
      const categoryNeedle = normalize(preference.category);
      const preferredColors = preference.preferredColors.map(normalize).filter(Boolean);
      const preferredBrands = preference.preferredBrands.map(normalize).filter(Boolean);
      const sizeNeedle = normalize(preference.sizeLabel);
      const fitNeedle = normalize(preference.fitPreference);

      for (const product of products) {
        if (!product.isActive || cartProductIds.has(product.id)) continue;
        const categoryName = categoryMap.get(product.categoryId)?.name;
        const productCategoryMatch =
          includesNormalized(categoryName, categoryNeedle) || includesNormalized(product.name, categoryNeedle);
        const productBrandMatch = preferredBrands.some((brand) => includesNormalized(product.name, brand));
        if (!productCategoryMatch && !productBrandMatch) continue;

        for (const variant of activeVariantsByProductId.get(product.id) ?? []) {
          const stock = inventoryMap.get(variant.id) ?? 0;
          if (stock <= 0) continue;

          const preferenceReasons: string[] = [];
          let score = 50;

          if (productCategoryMatch) {
            preferenceReasons.push(preference.category);
            score += 10;
          }
          if (sizeNeedle && includesNormalized(variant.sizeLabel || variant.name, sizeNeedle)) {
            preferenceReasons.push(`size ${preference.sizeLabel}`);
            score += 25;
          }
          const matchedColor = preferredColors.find((color) =>
            includesNormalized(variant.colorLabel || variant.name, color) || includesNormalized(product.name, color)
          );
          if (matchedColor) {
            preferenceReasons.push(`color ${matchedColor}`);
            score += 15;
          }
          const matchedBrand = preferredBrands.find((brand) =>
            includesNormalized(product.name, brand) || includesNormalized(variant.name, brand)
          );
          if (matchedBrand) {
            preferenceReasons.push(`brand ${matchedBrand}`);
            score += 15;
          }
          if (fitNeedle && includesNormalized(`${product.name} ${variant.name}`, fitNeedle)) {
            preferenceReasons.push(preference.fitPreference ?? 'preferred fit');
            score += 10;
          }

          addOrUpgradeRecommendation(recommendationMap, {
            productId: product.id,
            variantId: variant.id,
            productName: product.name,
            variantName: variant.name,
            price: variant.price,
            imageUrl: product.imageUrl,
            score,
            reason: 'customer_preference',
            frequency: 0,
            preferenceReasons,
            inStock: true,
          });
        }
      }
    }

    const transactionMap = new Map<
      string,
      { productIds: Set<string>; productNames: Set<string> }
    >();

    for (const event of transactionEvents) {
      if (event.eventKind === 'transaction_placeholder' && event.payload) {
        const itemVariantIds = event.payload.item_variant_ids;
        const itemProductIds = event.payload.item_product_ids;
        const itemProductNames = event.payload.item_product_names;

        if (!transactionMap.has(event.transactionId)) {
          transactionMap.set(event.transactionId, {
            productIds: new Set(),
            productNames: new Set(),
          });
        }

        const transaction = transactionMap.get(event.transactionId)!;

        if (itemVariantIds && typeof itemVariantIds === 'string') {
          itemVariantIds.split(',').forEach((id) => {
            const vid = id.trim();
            const v = variantMap.get(vid);
            if (v) {
              transaction.productIds.add(v.productId);
            }
          });
        }

        if (itemProductIds && typeof itemProductIds === 'string') {
          itemProductIds.split(',').forEach((id) => {
            transaction.productIds.add(id.trim());
          });
        }

        if (itemProductNames && typeof itemProductNames === 'string') {
          itemProductNames.split(',').forEach((name) => {
            transaction.productNames.add(name.trim());
          });
        }
      }
    }

    const productNameMatches = new Map<string, number>();
    for (const [, transaction] of transactionMap) {
      const hasCartItem = Array.from(transaction.productNames).some((name) =>
        cartProductNames.has(name)
      );

      if (hasCartItem) {
        for (const productName of transaction.productNames) {
          if (!cartProductNames.has(productName)) {
            productNameMatches.set(
              productName,
              (productNameMatches.get(productName) ?? 0) + 1
            );
          }
        }
      }
    }

    const productIdMatches = new Map<string, number>();
    for (const [, transaction] of transactionMap) {
      const hasCartItem = Array.from(transaction.productIds).some((id) =>
        cartProductIds.has(id)
      );

      if (hasCartItem) {
        for (const productId of transaction.productIds) {
          if (!cartProductIds.has(productId)) {
            productIdMatches.set(
              productId,
              (productIdMatches.get(productId) ?? 0) + 1
            );
          }
        }
      }
    }

    for (const [productId, frequency] of productIdMatches) {
      const product = productMap.get(productId);
      if (!product || !product.isActive) continue;

      const productVariants = activeVariantsByProductId.get(productId) ?? [];
      if (productVariants.length === 0) continue;

      for (const variant of productVariants) {
        const stock = inventoryMap.get(variant.id) ?? 0;
        if (stock <= 0) continue;

        addOrUpgradeRecommendation(recommendationMap, {
          productId,
          variantId: variant.id,
          productName: product.name,
          variantName: variant.name,
          price: variant.price,
          imageUrl: product.imageUrl,
          score: frequency * 10,
          reason: 'frequently_bought_together',
          frequency,
          preferenceReasons: [],
          inStock: true,
        });
      }
    }

    const cartCategories = new Set<string>();
    for (const cartItem of currentCartItems) {
      const product = productMap.get(cartItem.productId);
      if (product) {
        cartCategories.add(product.categoryId);
      }
    }

    const categoryProductCount = new Map<string, number>();
    for (const product of products) {
      if (
        product.isActive &&
        cartCategories.has(product.categoryId) &&
        !cartProductIds.has(product.id)
      ) {
        categoryProductCount.set(
          product.id,
          (categoryProductCount.get(product.id) ?? 0) + 1
        );
      }
    }

    for (const [productId, _count] of categoryProductCount) {
      const product = productMap.get(productId);
      if (!product) continue;

      const productVariants = activeVariantsByProductId.get(productId) ?? [];
      if (productVariants.length === 0) continue;

      for (const variant of productVariants) {
        const stock = inventoryMap.get(variant.id) ?? 0;
        if (stock <= 0) continue;

        addOrUpgradeRecommendation(recommendationMap, {
          productId,
          variantId: variant.id,
          productName: product.name,
          variantName: variant.name,
          price: variant.price,
          imageUrl: product.imageUrl,
          score: 3,
          reason: 'category_suggestion',
          frequency: 0,
          preferenceReasons: [],
          inStock: true,
        });
        break;
      }
    }

    return Array.from(recommendationMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [currentCartItems, customer, transactionEvents, categories, products, variants, inventory]);

  if (recommendations.length === 0) {
    return null;
  }

  return (
    <div className="animate-fadeIn mb-4">
      <div className="flex items-center gap-2 mb-3 px-4">
        <h3 className="text-sm font-semibold text-zinc-700">
          Recommended for you
        </h3>
        <div className="flex-1 h-px bg-zinc-200"></div>
      </div>

      <div className="overflow-x-auto px-4">
        <div className="flex gap-3 pb-2">
          {recommendations.map((item) => (
            <RecommendationCard
              key={`${item.productId}-${item.variantId}`}
              item={item}
              onAdd={() => onAddItem(item.productId, item.variantId)}
            />
          ))}
        </div>
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .animate-fadeIn {
          animation: fadeIn 300ms ease-in-out;
        }
      `}</style>
    </div>
  );
}

interface RecommendationCardProps {
  item: RecommendationItem;
  onAdd: () => void;
}

function RecommendationCard({ item, onAdd }: RecommendationCardProps) {
  const reasonLabel =
    item.reason === 'customer_preference'
      ? 'Matches customer preferences'
      : item.reason === 'frequently_bought_together'
        ? `Bought together ${item.frequency}x`
        : 'Popular in category';

  return (
    <div className="flex-shrink-0 w-56 rounded-2xl bg-zinc-50 border border-zinc-200 overflow-hidden transition-shadow hover:shadow-md">
      <div className="h-24 bg-zinc-200 overflow-hidden">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.productName}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-400 text-xs">
            No image
          </div>
        )}
      </div>

      <div className="p-3 flex flex-col gap-2">
        <div className="min-h-10">
          <p className="text-sm font-medium text-zinc-900 leading-tight">
            {item.productName}
          </p>
          {item.variantName && (
            <p className="text-xs text-zinc-500 line-clamp-1">
              {item.variantName}
            </p>
          )}
        </div>

        <p className="text-lg font-semibold text-teal-600">
          {formatCurrency(item.price)}
        </p>

        <span className="inline-flex text-xs font-medium text-teal-700 bg-teal-50 px-2 py-1 rounded-full w-fit">
          {reasonLabel}
        </span>
        {item.preferenceReasons.length > 0 && (
          <p className="line-clamp-2 text-xs text-zinc-500">
            {item.preferenceReasons.join(' · ')}
          </p>
        )}

        <button
          onClick={onAdd}
          className="mt-auto w-full px-3 py-2 bg-teal-600 hover:bg-teal-700 text-white font-medium text-sm rounded-lg transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  );
}
