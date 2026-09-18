import type { NextConfig } from "next";

// R24-H-1: prime the Cloudflare context in dev so the first
// `getCloudflareContext({async: true})` call inside a route handler
// doesn't pay the full miniflare-bootstrap cost on the hot path.
// Skipped outside `next dev` (guarded by NODE_ENV); prod runs via
// OpenNext which wires the context differently.
if (process.env.NODE_ENV === "development") {
  // Dynamic-import + swallow errors: if @opennextjs/cloudflare isn't
  // installed (production bundle already strips it), we fall through
  // silently. No hard dependency at Next.js config load time.
  import("@opennextjs/cloudflare")
    .then(async (mod) => {
      try {
        await mod.initOpenNextCloudflareForDev();
      } catch (err) {
        // Eat — common failure is "no wrangler.jsonc" in sub-repos;
        // the app still works, just without the primed context.
        console.warn(
          "[next.config] initOpenNextCloudflareForDev failed:",
          err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
        );
      }
    })
    .catch(() => {
      /* module not present in this environment */
    });
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg-cloudflare"],
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pg-cloudflare/dist/**/*",
      "./node_modules/pg-cloudflare/esm/**/*",
    ],
  },
  turbopack: {
    // This app lives under ~/Projects/bupos/code while ~/package-lock.json also
    // exists. Pinning the Turbopack root prevents Next from treating the home
    // directory as the project root and expanding file tracing/watching scope.
    root: process.cwd(),
  },
  // Optimize tree-shaking for heavy icon + chart libraries
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "plus.unsplash.com" },
    ],
  },
  // CSP is set dynamically (nonce-based) by middleware.ts — removed duplicate here
  // to avoid conflicting headers.
};

export default nextConfig;
