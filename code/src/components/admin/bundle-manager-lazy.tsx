"use client";

import dynamic from "next/dynamic";

const BundleManager = dynamic(
  () =>
    import("./bundle-manager").then((m) => ({
      default: m.BundleManager,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading bundles…
      </div>
    ),
  },
);

export { BundleManager };
