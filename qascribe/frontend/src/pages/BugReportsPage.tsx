import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getArtifactStats, listArtifacts } from '../api/client';
import {
  BugCard, PRIORITIES, PRIORITY_TINT, SEVERITIES, SEVERITY_TINT, type Tint,
} from '../components/BugCard';
import { EmptyState } from '../components/EmptyState';
import { ExportButton } from '../components/ExportButton';
import { ExportModal } from '../components/ExportModal';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';
import { useBugReviewMutation } from '../hooks/useBugReviewMutation';
import {
  parseList, useListPageUrlState,
} from '../hooks/useDebouncedSearchParam';
import type {
  ArtifactSort, ArtifactStats, Priority, ReviewStatus, Severity,
} from '../types';

const PAGE_SIZE = 50;
const DEFAULT_SORT: ArtifactSort = 'created_desc';

const SORTS: { key: ArtifactSort; label: string }[] = [
  { key: 'created_desc', label: 'Newest first' },
  { key: 'created_asc', label: 'Oldest first' },
  { key: 'severity_desc', label: 'Severity (high→low)' },
  { key: 'priority_desc', label: 'Priority (high→low)' },
];

type ReviewFilter = ReviewStatus | 'all';
const REVIEW_FILTERS: readonly ReviewFilter[] = [
  'unreviewed', 'confirmed', 'dismissed', 'needs_more_info', 'all',
] as const;
const DEFAULT_REVIEW: ReviewFilter = 'unreviewed';

const REVIEW_FILTER_LABEL: Record<ReviewFilter, string> = {
  unreviewed: 'Unreviewed',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
  needs_more_info: 'Needs info',
  all: 'All',
};

// Filter-pill accent colors per task spec. Dismissed + All use neutral.
const REVIEW_FILTER_ACCENT: Record<ReviewFilter, string | null> = {
  unreviewed: '#fbbf24',
  confirmed: '#4ade80',
  dismissed: null,
  needs_more_info: '#a78bfa',
  all: null,
};

export function BugReportsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [exportOpen, setExportOpen] = useState(false);

  const {
    searchParams, q, inputValue, setInputValue, patchParams, clearAll,
  } = useListPageUrlState();

  const sev = parseList(searchParams.get('severity'), SEVERITIES);
  const pri = parseList(searchParams.get('priority'), PRIORITIES);
  const rawSort = searchParams.get('sort') as ArtifactSort | null;
  const sort = SORTS.some((s) => s.key === rawSort)
    ? (rawSort as ArtifactSort)
    : DEFAULT_SORT;
  const rawReview = searchParams.get('review');
  const reviewFilter: ReviewFilter = REVIEW_FILTERS.includes(rawReview as ReviewFilter)
    ? (rawReview as ReviewFilter)
    : DEFAULT_REVIEW;
  const sessionIdFilter = searchParams.get('session_id') || undefined;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const otherFiltersActive =
    q !== '' ||
    sev.length > 0 ||
    pri.length > 0 ||
    sort !== DEFAULT_SORT ||
    sessionIdFilter !== undefined;
  const filtersActive = otherFiltersActive || reviewFilter !== DEFAULT_REVIEW;

  function toggleSeverity(s: Severity) {
    const next = sev.includes(s) ? sev.filter((x) => x !== s) : [...sev, s];
    patchParams({ severity: next.length ? next.join(',') : null, page: null });
  }
  function togglePriority(p: Priority) {
    const next = pri.includes(p) ? pri.filter((x) => x !== p) : [...pri, p];
    patchParams({ priority: next.length ? next.join(',') : null, page: null });
  }
  function setSort(s: ArtifactSort) {
    patchParams({ sort: s === DEFAULT_SORT ? null : s, page: null });
  }
  function setReview(r: ReviewFilter) {
    if (r === reviewFilter) return;
    patchParams({ review: r === DEFAULT_REVIEW ? null : r, page: null });
  }
  function clearSessionFilter() {
    patchParams({ session_id: null, page: null });
  }
  function setPage(n: number) {
    patchParams({ page: n <= 1 ? null : String(n) });
  }

  const listKey = [
    'artifacts', 'list',
    { type: 'bug_report', q, sev, pri, rev: reviewFilter, sort, page, sessionId: sessionIdFilter },
  ] as const;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      listArtifacts({
        type: 'bug_report',
        session_id: sessionIdFilter,
        search: q || undefined,
        severity: sev.length ? sev : undefined,
        priority: pri.length ? pri : undefined,
        review_status: reviewFilter === 'all' ? undefined : reviewFilter,
        sort,
        page,
        page_size: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const { data: stats } = useQuery({
    queryKey: ['artifacts', 'stats'],
    queryFn: getArtifactStats,
    staleTime: 60_000,
  });

  const { changeReview } = useBugReviewMutation();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const distinctSessions = new Set(items.map((i) => i.session_id)).size;
  const allFitOnPage = items.length === total;

  const showEverEmpty =
    !isLoading && total === 0 && stats !== undefined && stats.total_bug_reports === 0;
  const showFilteredEmpty =
    !isLoading && total === 0 && !showEverEmpty && stats !== undefined;

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-medium text-fg-0">Bug reports</h1>
          <p className="mt-1 text-[11.5px] text-fg-2">
            {total > 0 ? (
              <>
                <span className="tabular-nums">{total}</span> bug
                {total === 1 ? '' : 's'}
                {distinctSessions > 0 && (
                  <>
                    {' across '}
                    <span className="tabular-nums">
                      {distinctSessions}
                      {!allFitOnPage && '+'}
                    </span>{' '}
                    session{distinctSessions === 1 && allFitOnPage ? '' : 's'}
                  </>
                )}
              </>
            ) : (
              'All bugs surfaced from your testing sessions'
            )}
          </p>
        </div>
        <ExportButton onClick={() => setExportOpen(true)} />
      </header>

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        artifactType="bugs"
        initialFilters={{
          session_id: sessionIdFilter,
          review_status:
            reviewFilter === 'all' ? undefined : [reviewFilter as ReviewStatus],
          severity: sev.length ? sev : undefined,
          priority: pri.length ? pri : undefined,
        }}
      />

      {sessionIdFilter && (
        <div className="mb-3 flex items-center gap-2 rounded-md border-0.5 border-border-0 bg-bg-1 px-3 py-2 text-[11.5px] text-fg-1">
          <span>Filtered to a single session.</span>
          <button
            type="button"
            onClick={clearSessionFilter}
            className="text-accent-cyan hover:underline"
          >
            Show all
          </button>
        </div>
      )}

      <ReviewFilterBar
        active={reviewFilter}
        stats={stats}
        onSelect={setReview}
      />

      <div className="mt-3">
        <FilterBar
          inputValue={inputValue}
          onInputChange={setInputValue}
          sev={sev}
          pri={pri}
          sort={sort}
          onToggleSeverity={toggleSeverity}
          onTogglePriority={togglePriority}
          onSortChange={setSort}
          filtersActive={filtersActive}
          onClear={clearAll}
        />
      </div>

      <div className="card mt-3.5">
        {isError ? (
          <div className="flex items-center justify-between px-3.5 py-7 text-sm">
            <span className="text-fg-1">Couldn't load bug reports.</span>
            <button
              onClick={() => refetch()}
              className="text-accent-green underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        ) : isLoading && !data ? (
          <div className="divide-y-0.5 divide-border-0">
            {Array.from({ length: 4 }).map((_, i) => (
              <BugSkeletonCard key={i} />
            ))}
          </div>
        ) : showEverEmpty ? (
          <EmptyState
            title="No bugs surfaced yet"
            body="Record a session to get started."
            action={
              <Link to="/sessions/new" className="btn-primary">
                + Record a session
              </Link>
            }
          />
        ) : showFilteredEmpty ? (
          <FilteredEmptyState
            reviewFilter={reviewFilter}
            otherFiltersActive={otherFiltersActive}
            stats={stats}
            onClear={clearAll}
          />
        ) : (
          <>
            <div className="divide-y-0.5 divide-border-0">
              {items.map((bug) => (
                <BugCard
                  key={bug.id}
                  bug={bug}
                  sessionId={bug.session_id}
                  sessionTitle={bug.session_title}
                  sessionDurationSeconds={bug.session_duration_seconds}
                  context="bugs-page"
                  onReview={(status) =>
                    changeReview(bug.id, status, bug.review_status)
                  }
                  onSavedRecategorize={() => {
                    queryClient.invalidateQueries({ queryKey: ['artifacts', 'list'] });
                    queryClient.invalidateQueries({ queryKey: ['artifacts', 'stats'] });
                    toast.push('Bug updated', 'success');
                  }}
                  onRecategorizeError={() =>
                    toast.push("Couldn't save changes", 'error')
                  }
                />
              ))}
            </div>
            <Pagination
              page={page}
              total={total}
              pageSize={PAGE_SIZE}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---- Review filter bar (top row) ----

function ReviewFilterBar({
  active, stats, onSelect,
}: {
  active: ReviewFilter;
  stats: ArtifactStats | undefined;
  onSelect: (r: ReviewFilter) => void;
}) {
  function countFor(f: ReviewFilter): number | null {
    if (!stats) return null;
    if (f === 'all') return stats.total_bug_reports;
    return stats.bugs_by_review_status[f] ?? 0;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {REVIEW_FILTERS.map((f) => {
        const isActive = f === active;
        const accent = REVIEW_FILTER_ACCENT[f];
        const count = countFor(f);
        const style: React.CSSProperties = isActive
          ? accent
            ? {
                backgroundColor: `${accent}1f`,
                borderColor: `${accent}66`,
                color: accent,
              }
            : { backgroundColor: '#1f1f25', borderColor: '#3a3a44', color: '#e4e4ec' }
          : { backgroundColor: 'transparent', borderColor: '#2a2a32', color: '#a8a8b3' };
        return (
          <button
            key={f}
            type="button"
            onClick={() => onSelect(f)}
            aria-pressed={isActive}
            className="inline-flex items-center gap-1.5 rounded-full border-0.5 px-3 py-[5px] text-[11.5px] font-medium transition-colors"
            style={style}
          >
            {REVIEW_FILTER_LABEL[f]}
            {count !== null && (
              <span className="tabular-nums opacity-70">({count})</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---- Existing search/severity/priority/sort bar ----

function FilterBar({
  inputValue, onInputChange,
  sev, pri, sort,
  onToggleSeverity, onTogglePriority, onSortChange,
  filtersActive, onClear,
}: {
  inputValue: string;
  onInputChange: (v: string) => void;
  sev: Severity[];
  pri: Priority[];
  sort: ArtifactSort;
  onToggleSeverity: (s: Severity) => void;
  onTogglePriority: (p: Priority) => void;
  onSortChange: (s: ArtifactSort) => void;
  filtersActive: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="input"
        style={{ width: 280 }}
        type="search"
        placeholder="search bug titles and descriptions..."
        value={inputValue}
        onChange={(e) => onInputChange(e.target.value)}
      />
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {SEVERITIES.map((s) => (
          <FilterPill
            key={s}
            label={s}
            active={sev.includes(s)}
            tint={SEVERITY_TINT[s]}
            onClick={() => onToggleSeverity(s)}
            uppercase={false}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-border-0" />
        {PRIORITIES.map((p) => (
          <FilterPill
            key={p}
            label={p}
            active={pri.includes(p)}
            tint={PRIORITY_TINT[p]}
            onClick={() => onTogglePriority(p)}
            uppercase
          />
        ))}
        <span className="mx-1 h-4 w-px bg-border-0" />
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as ArtifactSort)}
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
  label, active, tint, onClick, uppercase,
}: {
  label: string;
  active: boolean;
  tint: Tint;
  onClick: () => void;
  uppercase: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center rounded-full border-0.5 px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
        uppercase ? 'uppercase tracking-[0.4px]' : 'capitalize'
      }`}
      style={
        active
          ? { backgroundColor: tint.bg, borderColor: tint.border, color: tint.fg }
          : { backgroundColor: 'transparent', borderColor: '#2a2a32', color: '#a8a8b3' }
      }
    >
      {label}
    </button>
  );
}

// ---- Filtered empty state (per-filter copy) ----

function FilteredEmptyState({
  reviewFilter, otherFiltersActive, stats, onClear,
}: {
  reviewFilter: ReviewFilter;
  otherFiltersActive: boolean;
  stats: ArtifactStats | undefined;
  onClear: () => void;
}) {
  if (otherFiltersActive) {
    return (
      <EmptyState
        title="No bugs match these filters"
        body="Try adjusting or clearing them."
        action={
          <button onClick={onClear} className="btn-secondary">
            Clear filters
          </button>
        }
      />
    );
  }
  if (reviewFilter === 'unreviewed') {
    const reviewedCount = stats
      ? stats.bugs_by_review_status.confirmed +
        stats.bugs_by_review_status.dismissed +
        stats.bugs_by_review_status.needs_more_info
      : 0;
    return (
      <div className="flex flex-col items-center px-3.5 py-[30px] text-center">
        <div
          className="mb-2 flex h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: '#4ade8022', color: '#4ade80' }}
        >
          <svg
            width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        </div>
        <p className="text-sm font-medium text-fg-0">All caught up.</p>
        <p className="mt-1 text-[12.5px] text-fg-2">
          <span className="tabular-nums">{reviewedCount}</span> bug
          {reviewedCount === 1 ? '' : 's'} reviewed.
        </p>
      </div>
    );
  }
  if (reviewFilter === 'confirmed') {
    return (
      <EmptyState
        title="No confirmed bugs yet"
        body="Once you review and confirm a bug, it'll show up here."
      />
    );
  }
  if (reviewFilter === 'dismissed') {
    return <EmptyState title="No dismissed bugs" body="" />;
  }
  if (reviewFilter === 'needs_more_info') {
    return <EmptyState title="Nothing flagged for follow-up" body="" />;
  }
  return (
    <EmptyState
      title="No bugs match these filters"
      body="Try adjusting or clearing them."
      action={
        <button onClick={onClear} className="btn-secondary">
          Clear filters
        </button>
      }
    />
  );
}

// ---- Skeleton ----

function BugSkeletonCard() {
  return (
    <div className="px-3.5 py-3" style={{ borderLeft: '2px solid #2a2a32' }}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-3 w-2/3 animate-pulse rounded bg-bg-2" />
          <div className="h-2.5 w-5/6 animate-pulse rounded bg-bg-2" />
          <div className="h-2.5 w-1/3 animate-pulse rounded bg-bg-2" />
        </div>
        <div className="h-4 w-20 animate-pulse rounded-full bg-bg-2" />
      </div>
      <div className="mt-3 flex gap-1.5">
        <div className="h-6 w-20 animate-pulse rounded-md bg-bg-2" />
        <div className="h-6 w-20 animate-pulse rounded-md bg-bg-2" />
        <div className="h-6 w-24 animate-pulse rounded-md bg-bg-2" />
      </div>
    </div>
  );
}
