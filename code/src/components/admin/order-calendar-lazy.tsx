"use client";

import dynamic from "next/dynamic";

const OrderCalendar = dynamic(
  () =>
    import("./order-calendar").then((m) => ({
      default: m.OrderCalendar,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading calendar…
      </div>
    ),
  },
);

export { OrderCalendar };
