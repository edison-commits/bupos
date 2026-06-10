import "server-only";
import type { ChannelProvider } from "./types";
import { shopifyProvider } from "./shopify";

/**
 * Provider factory. Phase 1 has only Shopify. Tests opt into the in-memory
 * mock with CHANNEL_PROVIDER_MOCK=1 (so nothing hits the network).
 */
export function getChannelProvider(provider: string = "shopify"): ChannelProvider {
  if (process.env.CHANNEL_PROVIDER_MOCK === "1") {
    // Lazy require keeps the mock out of the production bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("./shopify.mock") as typeof import("./shopify.mock")).mockProvider;
  }
  switch (provider) {
    case "shopify":
      return shopifyProvider;
    default:
      return shopifyProvider;
  }
}

export type { ChannelProvider } from "./types";
