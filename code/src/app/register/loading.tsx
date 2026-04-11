export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--surface-app)" }}>
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-t-transparent" style={{ borderColor: "var(--border-strong)", borderTopColor: "transparent" }} />
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Loading…</p>
      </div>
    </div>
  );
}
