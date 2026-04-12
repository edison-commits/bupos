"use client";

import dynamic from "next/dynamic";

const DiscountScheduler = dynamic(
  () =>
    import("./discount-scheduler").then((m) => ({
      default: m.DiscountScheduler,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading scheduler…
      </div>
    ),
  },
);

export { DiscountScheduler };
