"use client";

import dynamic from "next/dynamic";

const DashboardCharts = dynamic(
  () => import("./dashboard-charts").then((m) => ({ default: m.DashboardCharts })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading charts…
      </div>
    ),
  }
);

export { DashboardCharts };
