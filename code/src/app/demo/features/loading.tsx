export default function DemoFeaturesLoading() {
  return (
    <main className="min-h-[100dvh] bg-[#f4f1eb] text-[#15201f]">
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8">
        <div className="h-9 w-28 animate-pulse rounded-full bg-[#d7ebe7]" />
        <div className="grid gap-12 py-24 lg:grid-cols-2 lg:items-center">
          <div className="space-y-5">
            <div className="h-4 w-64 animate-pulse rounded bg-[#d7ebe7]" />
            <div className="h-24 max-w-xl animate-pulse rounded bg-[#d7ebe7]" />
            <div className="h-16 max-w-lg animate-pulse rounded bg-[#e5e1d9]" />
          </div>
          <div className="aspect-video animate-pulse rounded-3xl bg-[#d7ebe7]" />
        </div>
      </div>
    </main>
  );
}
