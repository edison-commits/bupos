"use client";

import dynamic from "next/dynamic";

const DailyManagerReport = dynamic(
  () =>
    import("./daily-manager-report").then((m) => ({
      default: m.DailyManagerReport,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading report…
      </div>
    ),
  },
);

export { DailyManagerReport };
