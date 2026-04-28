import { useEffect, useState } from 'react';

export function Pagination({
  page, total, pageSize, onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (n: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  const [jump, setJump] = useState(String(page));
  useEffect(() => {
    setJump(String(page));
  }, [page]);

  function commitJump() {
    const n = parseInt(jump, 10);
    if (Number.isFinite(n)) {
      const clamped = Math.max(1, Math.min(totalPages, n));
      if (clamped !== page) onPage(clamped);
      setJump(String(clamped));
    } else {
      setJump(String(page));
    }
  }

  return (
    <div className="flex items-center justify-between border-t-0.5 border-border-0 px-3.5 py-2.5">
      <span className="text-[11px] tabular-nums text-fg-2">
        Showing {start}–{end} of {total}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="rounded-md border-0.5 border-border-0 bg-bg-1 px-2 py-[3px] text-[11px] text-fg-1 transition-colors hover:bg-bg-2 hover:text-fg-0 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← Prev
        </button>
        <span className="flex items-center gap-1 text-[11px] text-fg-2">
          Page
          <input
            type="text"
            inputMode="numeric"
            value={jump}
            onChange={(e) => setJump(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={commitJump}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className="w-10 rounded-md border-0.5 border-border-0 bg-bg-1 px-1.5 py-[3px] text-center text-[11px] tabular-nums text-fg-0 focus:border-accent-green focus:outline-none focus:ring-2 focus:ring-accent-green/30"
          />
          <span className="tabular-nums">of {totalPages}</span>
        </span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          className="rounded-md border-0.5 border-border-0 bg-bg-1 px-2 py-[3px] text-[11px] text-fg-1 transition-colors hover:bg-bg-2 hover:text-fg-0 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
