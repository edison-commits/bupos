"use client";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-xl font-bold text-zinc-800">Something went wrong</h2>
      <p className="text-sm text-zinc-500">{error.message || "An unexpected error occurred."}</p>
      <button onClick={reset} className="rounded-2xl bg-zinc-900 px-5 py-3 text-sm font-bold text-white hover:bg-zinc-800">Try again</button>
    </div>
  );
}
