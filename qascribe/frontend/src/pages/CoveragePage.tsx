import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getCoverageRollup, listSessions } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Pagination } from '../components/Pagination';
import {
  parseList, useListPageUrlState,
} from '../hooks/useDebouncedSearchParam';
import type { CoverageRollupItem, Severity } from '../types';

const PAGE_SIZE = 30;
const PRIORITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'] as const;

type CoverageSort = 'occurrences_desc' | 'priority_desc' | 'latest_desc';
const DEFAULT_SORT: CoverageSort = 'occurrences_desc';
const SORTS: { key: CoverageSort; label: string }[] = [
  { key: 'occurrences_desc', label: 'Most occurrences first' },
  { key: 'priority_desc', label: 'Highest priority first' },
  { key: 'latest_desc', label: 'Most recent first' },
];

const PRIORITY_RANK: Record<Severity, number> = {
  critical: 4, high: 3, medium: 2, low: 1,
};

type Tint = { bg: string; fg: string; border: string };

const PRIORITY_TINT: Record<Severity, Tint> = {
  critical: { bg: 'rgba(248,113,113,0.18)', fg: '#fca5a5', border: 'rgba(248,113,113,0.4)' },
  high: { bg: 'rgba(248,113,113,0.12)', fg: '#f87171', border: 'rgba(248,113,113,0.25)' },
  medium: { bg: 'rgba(251,191,36,0.12)', fg: '#fbbf24', border: 'rgba(251,191,36,0.25)' },
  low: { bg: '#1f1f25', fg: '#a8a8b3', border: '#2a2a32' },
};

const PURPLE: Tint = {
  bg: 'rgba(167,139,250,0.12)',
  fg: '#a78bfa',
  border: 'rgba(167,139,250,0.3)',
};

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export function CoveragePage() {
  const {
    searchParams, q, inputValue, setInputValue, patchParams, clearAll,
  } = useListPageUrlState();

  const pri = parseList<Severity>(searchParams.get('priority'), PRIORITIES);
  const rawSort = searchParams.get('sort') as CoverageSort | null;
  const sort = SORTS.some((s) => s.key === rawSort)
    ? (rawSort as CoverageSort)
    : DEFAULT_SORT;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const filtersActive = q !== '' || pri.length > 0 || sort !== DEFAULT_SORT;

  function togglePriority(p: Severity) {
    const next = pri.includes(p) ? pri.filter((x) => x !== p) : [...pri, p];
    patchParams({ priority: next.length ? next.join(',') : null, page: null });
  }
  function setSort(s: CoverageSort) {
    patchParams({ sort: s === DEFAULT_SORT ? null : s, page: null });
  }
  function setPage(n: number) {
    patchParams({ page: n <= 1 ? null : String(n) });
  }

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['coverage-rollup'],
    queryFn: getCoverageRollup,
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    let out = items;
    if (q) {
      const needle = q.toLowerCase();
      out = out.filter(
        (it) =>
          it.title.toLowerCase().includes(needle) ||
          (it.description ?? '').toLowerCase().includes(needle),
      );
    }
    if (pri.length > 0) {
      out = out.filter((it) => pri.includes(it.highest_priority));
    }
    out = [...out];
    if (sort === 'occurrences_desc') {
      out.sort(
        (a, b) =>
          b.occurrences - a.occurrences || a.title.localeCompare(b.title),
      );
    } else if (sort === 'priority_desc') {
      out.sort(
        (a, b) =>
          PRIORITY_RANK[b.highest_priority] - PRIORITY_RANK[a.highest_priority] ||
          b.occurrences - a.occurrences,
      );
    } else {
      out.sort(
        (a, b) =>
          new Date(b.latest_seen).getTime() - new Date(a.latest_seen).getTime(),
      );
    }
    return out;
  }, [items, q, pri, sort]);

  const totalUnique = items.length;
  const totalSessions = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => i.session_ids.forEach((s) => set.add(s)));
    return set.size;
  }, [items]);

  const totalFiltered = filtered.length;
  const offset = (page - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(offset, offset + PAGE_SIZE);
  const showPagination = totalFiltered > PAGE_SIZE;

  const showEverEmpty = !isLoading && totalUnique === 0;
  const showFilteredEmpty =
    !isLoading && totalFiltered === 0 && !showEverEmpty;

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-5">
        <h1 className="text-base font-medium text-fg-0">Coverage gaps</h1>
        <p className="mt-1 text-[11.5px] text-fg-2">
          {totalUnique > 0 ? (
            <>
              <span className="tabular-nums">{totalUnique}</span> unique gap
              {totalUnique === 1 ? '' : 's'}
              {' across '}
              <span className="tabular-nums">{totalSessions}</span>{' '}
              session{totalSessions === 1 ? '' : 's'}
            </>
          ) : (
            'Recurring untested flows surfaced from your sessions'
          )}
        </p>
      </header>

      <FilterBar
        inputValue={inputValue}
        onInputChange={setInputValue}
        pri={pri}
        sort={sort}
        onTogglePriority={togglePriority}
        onSortChange={setSort}
        filtersActive={filtersActive}
        onClear={clearAll}
      />

      <div className="mt-3.5">
        {isError ? (
          <div className="card flex items-center justify-between px-3.5 py-7 text-sm">
            <span className="text-fg-1">Couldn't load coverage gaps.</span>
            <button
              onClick={() => refetch()}
              className="text-accent-green underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        ) : isLoading && !data ? (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : showEverEmpty ? (
          <div className="card">
            <EmptyState
              title="No coverage gaps yet"
              body="Coverage gaps will appear here once you record QA sessions and the synthesis pipeline finishes."
              action={
                <Link to="/sessions/new" className="btn-primary">
                  + Record a session
                </Link>
              }
            />
          </div>
        ) : showFilteredEmpty ? (
          <div className="card">
            <EmptyState
              title="No gaps match these filters"
              body="Try adjusting or clearing them."
              action={
                <button onClick={clearAll} className="btn-secondary">
                  Clear filters
                </button>
              }
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {pageItems.map((g, i) => {
                const key = `${offset + i}-${g.title}`;
                const expanded = expandedKey === key;
                return (
                  <GapCard
                    key={key}
                    gap={g}
                    expanded={expanded}
                    onToggle={() => setExpandedKey(expanded ? null : key)}
                  />
                );
              })}
            </div>
            {showPagination && (
              <div className="mt-3.5 overflow-hidden rounded-lg border-0.5 border-border-0 bg-bg-1">
                <Pagination
                  page={page}
                  total={totalFiltered}
                  pageSize={PAGE_SIZE}
                  onPage={setPage}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FilterBar({
  inputValue, onInputChange,
  pri, sort,
  onTogglePriority, onSortChange,
  filtersActive, onClear,
}: {
  inputValue: string;
  onInputChange: (v: string) => void;
  pri: Severity[];
  sort: CoverageSort;
  onTogglePriority: (p: Severity) => void;
  onSortChange: (s: CoverageSort) => void;
  filtersActive: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="input"
        style={{ width: 280 }}
        type="search"
        placeholder="search coverage gap titles..."
        value={inputValue}
        onChange={(e) => onInputChange(e.target.value)}
      />
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {PRIORITIES.map((p) => (
          <FilterPill
            key={p}
            label={p}
            active={pri.includes(p)}
            onClick={() => onTogglePriority(p)}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-border-0" />
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as CoverageSort)}
          className="rounded-md border-0.5 border-border-0 bg-bg-1 px-2.5 py-[5px] text-[11.5px] text-fg-1 transition-colors hover:bg-bg-2 focus:border-accent-green focus:outline-none focus:ring-2 focus:ring-accent-green/30"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            onClick={onClear}
            className="rounded-md px-2 py-[5px] text-[11.5px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg-0"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function FilterPill({
  label, active, onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex items-center rounded-full border-0.5 px-2.5 py-[3px] text-[11px] font-medium capitalize transition-colors"
      style={
        active
          ? { backgroundColor: PURPLE.bg, borderColor: PURPLE.border, color: PURPLE.fg }
          : { backgroundColor: 'transparent', borderColor: '#2a2a32', color: '#a8a8b3' }
      }
    >
      {label}
    </button>
  );
}

function GapCard({
  gap, expanded, onToggle,
}: {
  gap: CoverageRollupItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = PRIORITY_TINT[gap.highest_priority];
  const recurring = gap.occurrences > 1;
  return (
    <div
      className={`overflow-hidden rounded-lg border-0.5 border-border-0 bg-bg-1 transition-all duration-150 hover:-translate-y-px hover:bg-[#13131a] ${
        expanded ? 'md:col-span-2' : ''
      }`}
      style={{ borderLeft: '2px solid #a78bfa' }}
    >
      <button
        onClick={onToggle}
        className="block w-full px-3.5 py-3 text-left"
        aria-expanded={expanded}
      >
        <div className="text-[13px] font-medium text-fg-0">{gap.title}</div>
        {gap.description && (
          <p
            className="mt-1 overflow-hidden text-[11px] leading-[1.5] text-fg-1"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {gap.description}
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center rounded-full border-0.5 px-2 py-[2px] text-[10.5px] font-medium tabular-nums"
            style={
              recurring
                ? { backgroundColor: PURPLE.bg, borderColor: PURPLE.border, color: PURPLE.fg }
                : { backgroundColor: '#1f1f25', borderColor: '#2a2a32', color: '#a8a8b3' }
            }
          >
            Raised in {gap.occurrences} session{gap.occurrences === 1 ? '' : 's'}
          </span>
          <span
            className="inline-flex items-center rounded-full border-0.5 px-2 py-[2px] text-[10.5px] font-medium capitalize"
            style={{ backgroundColor: t.bg, borderColor: t.border, color: t.fg }}
          >
            {gap.highest_priority}
          </span>
          <span className="ml-auto text-[10.5px] text-fg-2">
            Latest:{' '}
            <span className="tabular-nums">
              {formatRelativeTime(gap.latest_seen)}
            </span>
          </span>
        </div>
      </button>
      {expanded && (
        <ExpandedSessions
          sessionIds={gap.session_ids}
          firstSeen={gap.first_seen}
          latestSeen={gap.latest_seen}
          onClose={onToggle}
        />
      )}
    </div>
  );
}

function ExpandedSessions({
  sessionIds, firstSeen, latestSeen, onClose,
}: {
  sessionIds: string[];
  firstSeen: string;
  latestSeen: string;
  onClose: () => void;
}) {
  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => listSessions(),
    staleTime: 60_000,
  });
  const titleById = new Map<string, { title: string; created_at: string }>();
  (sessions ?? []).forEach((s) =>
    titleById.set(s.session_id, { title: s.title, created_at: s.created_at }),
  );

  return (
    <div className="border-t-0.5 border-border-0 bg-bg-0/40 px-3.5 py-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
          Raised in {sessionIds.length} session
          {sessionIds.length === 1 ? '' : 's'}
        </div>
        <button
          onClick={onClose}
          aria-label="Collapse"
          className="rounded px-1.5 py-0.5 text-[11px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg-0"
        >
          ✕
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {sessionIds.map((id) => {
          const meta = titleById.get(id);
          return (
            <li
              key={id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-bg-2"
            >
              <div className="min-w-0">
                <div className="truncate text-[12px] text-fg-1">
                  {meta?.title ?? (
                    <span
                      className="text-[11px] text-fg-2"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {id.slice(0, 8)}
                    </span>
                  )}
                </div>
                {meta && (
                  <div className="mt-0.5 text-[10.5px] text-fg-2">
                    {formatRelativeTime(meta.created_at)}
                  </div>
                )}
              </div>
              <Link
                to={`/sessions/${id}#coverage`}
                className="flex-none text-[11px] text-accent-green underline-offset-2 hover:underline"
              >
                Jump to session →
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 text-[10.5px] text-fg-2">
        First seen{' '}
        <span className="tabular-nums">{formatRelativeTime(firstSeen)}</span>
        {' · '}
        Latest{' '}
        <span className="tabular-nums">{formatRelativeTime(latestSeen)}</span>
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="rounded-lg border-0.5 border-border-0 bg-bg-1 px-3.5 py-3">
      <div className="h-3 w-2/3 animate-pulse rounded bg-bg-2" />
      <div className="mt-2 h-2.5 w-full animate-pulse rounded bg-bg-2" />
      <div className="mt-1 h-2.5 w-5/6 animate-pulse rounded bg-bg-2" />
      <div className="mt-3 flex gap-1.5">
        <div className="h-4 w-24 animate-pulse rounded-full bg-bg-2" />
        <div className="h-4 w-14 animate-pulse rounded-full bg-bg-2" />
      </div>
    </div>
  );
}
