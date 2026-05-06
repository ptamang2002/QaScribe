import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  getArtifactStats, listArtifacts, reviewArtifact, updateArtifact,
} from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Pagination } from '../components/Pagination';
import { REVIEW_VARIANTS, ReviewStatusPill } from '../components/ReviewStatusPill';
import { useToast } from '../components/Toast';
import {
  parseList, useListPageUrlState,
} from '../hooks/useDebouncedSearchParam';
import type {
  AggregatedArtifactItem, ArtifactListResponse, ArtifactSort, ArtifactStats,
  Priority, ReviewStatus, Severity,
} from '../types';

const PAGE_SIZE = 50;
const DEFAULT_SORT: ArtifactSort = 'created_desc';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'] as const;
const PRIORITIES: readonly Priority[] = ['P1', 'P2', 'P3', 'P4'] as const;
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

type Tint = { bg: string; fg: string; border: string };

const SEVERITY_TINT: Record<Severity, Tint> = {
  critical: { bg: 'rgba(248,113,113,0.18)', fg: '#fca5a5', border: 'rgba(248,113,113,0.4)' },
  high: { bg: 'rgba(248,113,113,0.12)', fg: '#f87171', border: 'rgba(248,113,113,0.25)' },
  medium: { bg: 'rgba(251,191,36,0.12)', fg: '#fbbf24', border: 'rgba(251,191,36,0.25)' },
  low: { bg: '#1f1f25', fg: '#a8a8b3', border: '#2a2a32' },
};

const PRIORITY_TINT: Record<Priority, Tint> = {
  P1: { bg: 'rgba(248,113,113,0.12)', fg: '#f87171', border: 'rgba(248,113,113,0.25)' },
  P2: { bg: 'rgba(251,191,36,0.12)', fg: '#fbbf24', border: 'rgba(251,191,36,0.25)' },
  P3: { bg: '#1f1f25', fg: '#a8a8b3', border: '#2a2a32' },
  P4: { bg: '#16161b', fg: '#6b6b75', border: '#222228' },
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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?\n]*[.!?]/);
  return (m ? m[0] : text).trim();
}

function bugTitle(c: Record<string, unknown>): string {
  const t = c.title as string | undefined;
  return t && t.trim() ? t : 'Untitled bug';
}

function bugDescription(c: Record<string, unknown>): string {
  const d = (c.description as string) || (c.summary as string) || '';
  return d.trim();
}

function bugSeverity(c: Record<string, unknown>): Severity | null {
  const s = (c.severity as string | undefined)?.toLowerCase();
  return s && (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : null;
}

function bugPriority(c: Record<string, unknown>): Priority | null {
  const p = c.priority as string | undefined;
  return p && (PRIORITIES as readonly string[]).includes(p) ? (p as Priority) : null;
}

function bugTags(c: Record<string, unknown>): string[] {
  const t = c.tags;
  if (!Array.isArray(t)) return [];
  return t.filter((x): x is string => typeof x === 'string');
}

export function BugReportsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

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
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const otherFiltersActive =
    q !== '' || sev.length > 0 || pri.length > 0 || sort !== DEFAULT_SORT;
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
  function setPage(n: number) {
    patchParams({ page: n <= 1 ? null : String(n) });
  }

  const listKey = [
    'artifacts', 'list',
    { type: 'bug_report', q, sev, pri, rev: reviewFilter, sort, page },
  ] as const;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      listArtifacts({
        type: 'bug_report',
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

  const reviewMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ReviewStatus }) =>
      reviewArtifact(id, { review_status: status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ['artifacts', 'list'] });
      const snapshots = queryClient.getQueriesData<ArtifactListResponse>({
        queryKey: ['artifacts', 'list'],
      });
      const nowIso = new Date().toISOString();
      for (const [key, value] of snapshots) {
        if (!value) continue;
        const nextItems = value.items.map((it) =>
          it.id === id
            ? {
                ...it,
                review_status: status,
                reviewed_at: nowIso,
              }
            : it,
        );
        queryClient.setQueryData<ArtifactListResponse>(key, {
          ...value,
          items: nextItems,
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, value] of ctx.snapshots) {
          queryClient.setQueryData(key, value);
        }
      }
      toast.push("Couldn't update review status", 'error');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['artifacts', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['artifacts', 'stats'] });
    },
  });

  function changeReview(id: string, status: ReviewStatus, prev: ReviewStatus) {
    reviewMutation.mutate({ id, status });
    // Show undo toast for forward transitions only — reverting to "unreviewed"
    // (an undo itself) doesn't get its own undo affordance.
    if (status !== 'unreviewed') {
      const label = REVIEW_VARIANTS[status].label.toLowerCase();
      toast.push(`Marked as ${label}`, 'success', {
        replaceKey: 'review-undo',
        action: {
          label: 'Undo',
          onClick: () => reviewMutation.mutate({ id, status: prev }),
        },
      });
    }
  }

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
      <header className="mb-5">
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
      </header>

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

      <div className="card mt-3.5 overflow-hidden">
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

function SeverityCell({ severity }: { severity: Severity | null }) {
  if (!severity) return <span className="text-[11px] text-fg-2">—</span>;
  const t = SEVERITY_TINT[severity];
  return (
    <span
      className="inline-flex items-center rounded-full border-0.5 px-2 py-[2px] text-[10.5px] font-medium capitalize"
      style={{ backgroundColor: t.bg, borderColor: t.border, color: t.fg }}
    >
      {severity}
    </span>
  );
}

function PriorityCell({ priority }: { priority: Priority | null }) {
  if (!priority) return <span className="text-[11px] text-fg-2">—</span>;
  const t = PRIORITY_TINT[priority];
  return (
    <span
      className="inline-flex items-center rounded-full border-0.5 px-2 py-[2px] text-[10px] font-medium uppercase tracking-[0.4px]"
      style={{ backgroundColor: t.bg, borderColor: t.border, color: t.fg }}
    >
      {priority}
    </span>
  );
}

// ---- Bug card ----

function BugCard({
  bug, onReview, onSavedRecategorize, onRecategorizeError,
}: {
  bug: AggregatedArtifactItem;
  onReview: (status: ReviewStatus) => void;
  onSavedRecategorize: () => void;
  onRecategorizeError: () => void;
}) {
  const navigate = useNavigate();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const title = bugTitle(bug.content);
  const desc = bugDescription(bug.content);
  const blurb = desc ? firstSentence(desc) : '';
  const sev = bugSeverity(bug.content);
  const pri = bugPriority(bug.content);
  const accent = REVIEW_VARIANTS[bug.review_status].color;
  const isTriaged =
    bug.review_status === 'confirmed' || bug.review_status === 'dismissed';
  const isDimmed = bug.review_status === 'dismissed';

  function viewInSession() {
    navigate(`/sessions/${bug.session_id}#tab=bugs`);
  }

  return (
    <div
      className="px-3.5 py-3 transition-opacity"
      style={{
        borderLeft: `2px solid ${accent}`,
        opacity: isDimmed ? 0.55 : 1,
      }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={viewInSession}
            className="block max-w-full truncate text-left text-[13px] font-medium text-fg-0 hover:underline"
          >
            {title}
          </button>
          {blurb && (
            <div className="mt-0.5 truncate text-[11.5px] text-fg-2">{blurb}</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-2">
            <span className="truncate">{bug.session_title}</span>
            <span>·</span>
            <span className="tabular-nums">
              {formatDuration(bug.session_duration_seconds)}
            </span>
            <span>·</span>
            <span>{formatRelativeTime(bug.created_at)}</span>
            <SeverityCell severity={sev} />
            <PriorityCell priority={pri} />
          </div>
        </div>
        <div className="shrink-0">
          <ReReviewPopover
            open={popoverOpen}
            current={bug.review_status}
            onSelect={(status) => {
              setPopoverOpen(false);
              if (status !== bug.review_status) onReview(status);
            }}
            onClose={() => setPopoverOpen(false)}
          >
            <ReviewStatusPill
              status={bug.review_status}
              interactive={isTriaged}
              onClick={(e) => {
                if (!isTriaged) return;
                e.stopPropagation();
                setPopoverOpen((v) => !v);
              }}
            />
          </ReReviewPopover>
        </div>
      </div>

      {(bug.review_status === 'unreviewed' ||
        bug.review_status === 'needs_more_info') && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <ActionButton
            label="Confirm"
            icon="check"
            hoverTint="#4ade80"
            onClick={() => onReview('confirmed')}
          />
          <ActionButton
            label="Dismiss"
            icon="x"
            hoverTint="#f87171"
            onClick={() => onReview('dismissed')}
          />
          <ActionButton
            label="Needs info"
            icon="help"
            hoverTint="#a78bfa"
            onClick={() => onReview('needs_more_info')}
          />
          <ActionButton
            label="Recategorize"
            icon="edit"
            hoverTint="#22d3ee"
            onClick={() => setEditing((v) => !v)}
            pressed={editing}
          />
          <button
            type="button"
            onClick={viewInSession}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg-0"
          >
            View in session
            <Icon name="external" />
          </button>
        </div>
      )}

      {editing && (
        <RecategorizeForm
          bug={bug}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onSavedRecategorize();
          }}
          onError={onRecategorizeError}
        />
      )}
    </div>
  );
}

// ---- Action buttons + icons ----

function ActionButton({
  label, icon, hoverTint, onClick, pressed,
}: {
  label: string;
  icon: IconName;
  hoverTint: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const tinted = hover || pressed;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={pressed}
      className="inline-flex items-center gap-1.5 rounded-md border-0.5 px-2 py-1 text-[11.5px] font-medium transition-colors"
      style={{
        borderColor: tinted ? `${hoverTint}55` : '#2a2a32',
        backgroundColor: tinted ? `${hoverTint}14` : 'transparent',
        color: tinted ? hoverTint : '#a8a8b3',
      }}
    >
      <Icon name={icon} />
      {label}
    </button>
  );
}

type IconName = 'check' | 'x' | 'help' | 'edit' | 'external';

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'check':
      return (
        <svg {...common}>
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      );
    case 'help':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M6.2 6.2c.4-1.1 1.4-1.7 2.5-1.4 1 .3 1.6 1.2 1.3 2.2-.2.6-.7 1-1.3 1.2-.6.2-1 .6-1 1.2v.4" />
          <circle cx="8" cy="11.7" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...common}>
          <path d="M3 13l1-3 7-7 2 2-7 7-3 1z" />
        </svg>
      );
    case 'external':
      return (
        <svg {...common}>
          <path d="M9 3h4v4M13 3l-7 7M11 9v4H3V5h4" />
        </svg>
      );
  }
}

// ---- Re-review popover ----

function ReReviewPopover({
  open, current, onSelect, onClose, children,
}: {
  open: boolean;
  current: ReviewStatus;
  onSelect: (s: ReviewStatus) => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} className="relative">
      {children}
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border-0.5 border-border-0 bg-bg-1 p-1 shadow-lg"
        >
          <div className="px-2 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.5px] text-fg-2">
            Change status
          </div>
          {(Object.keys(REVIEW_VARIANTS) as ReviewStatus[]).map((s) => {
            const v = REVIEW_VARIANTS[s];
            const isCurrent = s === current;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onSelect(s)}
                disabled={isCurrent}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-fg-1 transition-colors hover:bg-bg-2 disabled:cursor-default disabled:opacity-50"
              >
                <span
                  className="block h-[6px] w-[6px] rounded-full"
                  style={{ backgroundColor: v.color }}
                />
                {v.label}
                {isCurrent && (
                  <span className="ml-auto text-[10px] text-fg-2">current</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Recategorize inline form ----

function RecategorizeForm({
  bug, onCancel, onSaved, onError,
}: {
  bug: AggregatedArtifactItem;
  onCancel: () => void;
  onSaved: () => void;
  onError: () => void;
}) {
  const [severity, setSeverity] = useState<string>(
    (bug.content.severity as string | undefined) ?? '',
  );
  const [priority, setPriority] = useState<string>(
    (bug.content.priority as string | undefined) ?? '',
  );
  const [tagsInput, setTagsInput] = useState<string>(
    bugTags(bug.content).join(', '),
  );

  const mutation = useMutation({
    mutationFn: () => {
      const nextTags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const nextContent: Record<string, unknown> = { ...bug.content };
      if (severity) nextContent.severity = severity;
      else delete nextContent.severity;
      if (priority) nextContent.priority = priority;
      else delete nextContent.priority;
      if (nextTags.length) nextContent.tags = nextTags;
      else delete nextContent.tags;
      return updateArtifact(bug.session_id, bug.id, nextContent);
    },
    onSuccess: onSaved,
    onError,
  });

  return (
    <div className="mt-3 rounded-md border-0.5 border-border-0 bg-bg-2/30 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="block text-[10.5px] uppercase tracking-[0.4px] text-fg-2">
            Severity
          </span>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="mt-1 w-full rounded-md border-0.5 border-border-0 bg-bg-1 px-2 py-1 text-[12px] text-fg-0 focus:border-accent-green focus:outline-none focus:ring-2 focus:ring-accent-green/30"
          >
            <option value="">—</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10.5px] uppercase tracking-[0.4px] text-fg-2">
            Priority
          </span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="mt-1 w-full rounded-md border-0.5 border-border-0 bg-bg-1 px-2 py-1 text-[12px] text-fg-0 focus:border-accent-green focus:outline-none focus:ring-2 focus:ring-accent-green/30"
          >
            <option value="">—</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10.5px] uppercase tracking-[0.4px] text-fg-2">
            Tags (comma-separated)
          </span>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="ui, regression, login"
            className="mt-1 w-full rounded-md border-0.5 border-border-0 bg-bg-1 px-2 py-1 text-[12px] text-fg-0 placeholder:text-fg-2 focus:border-accent-green focus:outline-none focus:ring-2 focus:ring-accent-green/30"
          />
        </label>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={mutation.isPending}
          className="btn-ghost"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="btn-primary"
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
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
