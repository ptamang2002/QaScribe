import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { getArtifactStats, listArtifacts } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Pagination } from '../components/Pagination';
import {
  parseList, useListPageUrlState,
} from '../hooks/useDebouncedSearchParam';
import type {
  AggregatedArtifactItem, ArtifactSort, Priority, Severity,
} from '../types';

const PAGE_SIZE = 50;
const ROW_GRID = 'grid-cols-[1.5fr,1fr,90px,70px,90px,30px]';
const DEFAULT_SORT: ArtifactSort = 'created_desc';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'] as const;
const PRIORITIES: readonly Priority[] = ['P1', 'P2', 'P3', 'P4'] as const;
const SORTS: { key: ArtifactSort; label: string }[] = [
  { key: 'created_desc', label: 'Newest first' },
  { key: 'created_asc', label: 'Oldest first' },
  { key: 'severity_desc', label: 'Severity (high→low)' },
  { key: 'priority_desc', label: 'Priority (high→low)' },
];

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

export function BugReportsPage() {
  const navigate = useNavigate();
  const {
    searchParams, q, inputValue, setInputValue, patchParams, clearAll,
  } = useListPageUrlState();

  const sev = parseList(searchParams.get('severity'), SEVERITIES);
  const pri = parseList(searchParams.get('priority'), PRIORITIES);
  const rawSort = searchParams.get('sort') as ArtifactSort | null;
  const sort = SORTS.some((s) => s.key === rawSort)
    ? (rawSort as ArtifactSort)
    : DEFAULT_SORT;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const filtersActive =
    q !== '' || sev.length > 0 || pri.length > 0 || sort !== DEFAULT_SORT;

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
  function setPage(n: number) {
    patchParams({ page: n <= 1 ? null : String(n) });
  }

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['artifacts', 'list', { type: 'bug_report', q, sev, pri, sort, page }],
    queryFn: () =>
      listArtifacts({
        type: 'bug_report',
        search: q || undefined,
        severity: sev.length ? sev : undefined,
        priority: pri.length ? pri : undefined,
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

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const distinctSessions = new Set(items.map((i) => i.session_id)).size;
  const allFitOnPage = items.length === total;

  const showEverEmpty =
    !isLoading && total === 0 && stats !== undefined && stats.total_bug_reports === 0;
  // Suppress filtered-empty flash while stats is still loading and no filters set,
  // so we don't show "no match" before deciding it's actually "no bugs ever".
  const showFilteredEmpty =
    !isLoading &&
    total === 0 &&
    !showEverEmpty &&
    (filtersActive || stats !== undefined);

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

      <div className="card mt-3.5 overflow-hidden">
        <div
          className={`grid ${ROW_GRID} items-center gap-3 border-b-0.5 border-border-0 px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2`}
        >
          <span>Title</span>
          <span>Session</span>
          <span>Severity</span>
          <span>Priority</span>
          <span className="text-right">Date</span>
          <span />
        </div>

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
            {Array.from({ length: 6 }).map((_, i) => (
              <BugSkeletonRow key={i} />
            ))}
          </div>
        ) : showEverEmpty ? (
          <EmptyState
            title="No bugs surfaced yet"
            body="Bug reports will appear here once you record QA sessions and the synthesis pipeline finishes."
            action={
              <Link to="/sessions/new" className="btn-primary">
                + Record a session
              </Link>
            }
          />
        ) : showFilteredEmpty ? (
          <EmptyState
            title="No bugs match these filters"
            body="Try adjusting or clearing them."
            action={
              <button onClick={clearAll} className="btn-secondary">
                Clear filters
              </button>
            }
          />
        ) : (
          <>
            <div className="divide-y-0.5 divide-border-0">
              {items.map((bug) => (
                <BugRow
                  key={bug.id}
                  bug={bug}
                  onClick={() =>
                    navigate(`/sessions/${bug.session_id}#bugs`)
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

function BugRow({
  bug, onClick,
}: { bug: AggregatedArtifactItem; onClick: () => void }) {
  const title = bugTitle(bug.content);
  const desc = bugDescription(bug.content);
  const blurb = desc ? firstSentence(desc) : '';
  const sev = bugSeverity(bug.content);
  const pri = bugPriority(bug.content);

  return (
    <button
      onClick={onClick}
      className={`group grid w-full ${ROW_GRID} items-center gap-3 px-3.5 py-[11px] text-left transition-colors hover:bg-[#12121a]`}
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-fg-0">{title}</div>
        {blurb && (
          <div className="mt-0.5 truncate text-[11px] text-fg-2">{blurb}</div>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] text-fg-1">{bug.session_title}</div>
        <div className="mt-0.5 truncate text-[11px] text-fg-2">
          <span className="tabular-nums">
            {formatDuration(bug.session_duration_seconds)}
          </span>
          {' · '}
          {formatRelativeTime(bug.session_created_at)}
        </div>
      </div>
      <SeverityCell severity={sev} />
      <PriorityCell priority={pri} />
      <span className="text-right text-[11px] tabular-nums text-fg-2">
        {formatRelativeTime(bug.created_at)}
      </span>
      <span className="text-right text-[12px] text-fg-2 transition-colors group-hover:text-fg-0">
        →
      </span>
    </button>
  );
}

function BugSkeletonRow() {
  return (
    <div className={`grid ${ROW_GRID} items-center gap-3 px-3.5 py-[11px]`}>
      <div className="space-y-1.5">
        <div className="h-3 w-2/3 animate-pulse rounded bg-bg-2" />
        <div className="h-2.5 w-5/6 animate-pulse rounded bg-bg-2" />
      </div>
      <div className="space-y-1.5">
        <div className="h-3 w-3/4 animate-pulse rounded bg-bg-2" />
        <div className="h-2.5 w-1/2 animate-pulse rounded bg-bg-2" />
      </div>
      <div className="h-4 w-16 animate-pulse rounded-full bg-bg-2" />
      <div className="h-4 w-10 animate-pulse rounded-full bg-bg-2" />
      <div className="ml-auto h-3 w-12 animate-pulse rounded bg-bg-2" />
      <div />
    </div>
  );
}

