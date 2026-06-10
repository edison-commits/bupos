'use client';

export interface PaginationInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Standard list-footer pagination: range summary, page size, prev/next. */
export function PaginationBar({
  pagination,
  onPageChange,
  onPageSizeChange,
}: {
  pagination: PaginationInfo;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const { page, pageSize, total, totalPages } = pagination;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)', color: 'var(--text-secondary)' }}
    >
      <span>
        Showing <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{from}–{to}</span> of{' '}
        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{total}</span>
      </span>
      <div className="flex items-center gap-2">
        <select
          aria-label="Rows per page"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="rounded-md border px-2 py-1 text-sm"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-panel)', color: 'var(--text-primary)' }}
        >
          {[25, 50, 100, 200].map((s) => <option key={s} value={s}>{s} / page</option>)}
        </select>
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          Previous
        </button>
        <span className="tabular-nums">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          Next
        </button>
      </div>
    </div>
  );
}
