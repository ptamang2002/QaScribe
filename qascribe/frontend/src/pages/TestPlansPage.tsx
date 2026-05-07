import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { getArtifactStats, listArtifacts } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { ExportButton } from '../components/ExportButton';
import { ExportModal } from '../components/ExportModal';
import { Pagination } from '../components/Pagination';
import {
  parseList, useListPageUrlState,
} from '../hooks/useDebouncedSearchParam';
import type { AggregatedArtifactItem } from '../types';

const PAGE_SIZE = 50;
const ROW_GRID = 'grid-cols-[2fr,1fr,110px,1fr,90px,30px]';

const VALIDATION_TYPES = ['application', 'browser-native', 'server-side'] as const;
type ValidationType = (typeof VALIDATION_TYPES)[number];

const VALIDATION_LABEL: Record<ValidationType, string> = {
  application: 'Application',
  'browser-native': 'Browser-native',
  'server-side': 'Server-side',
};

type Tint = { bg: string; fg: string; border: string };

const VALIDATION_TINT: Record<ValidationType, Tint> = {
  application: { bg: 'rgba(34,211,238,0.12)', fg: '#22d3ee', border: 'rgba(34,211,238,0.25)' },
  'browser-native': { bg: 'rgba(167,139,250,0.12)', fg: '#a78bfa', border: 'rgba(167,139,250,0.25)' },
  'server-side': { bg: '#1f1f25', fg: '#a8a8b3', border: '#2a2a32' },
};

const FILTER_ACTIVE_TINT: Tint = {
  bg: 'rgba(34,211,238,0.12)',
  fg: '#22d3ee',
  border: 'rgba(34,211,238,0.3)',
};

type TestSort = 'created_desc' | 'created_asc' | 'title_asc' | 'title_desc';
const DEFAULT_SORT: TestSort = 'created_desc';

const SORTS: { key: TestSort; label: string }[] = [
  { key: 'created_desc', label: 'Newest first' },
  { key: 'created_asc', label: 'Oldest first' },
  { key: 'title_asc', label: 'Title A→Z' },
  { key: 'title_desc', label: 'Title Z→A' },
];

const VALIDATION_TAG_PREFIX = 'validation:';

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

function tcId(artifactId: string): string {
  return `TC-${artifactId.slice(0, 4).toUpperCase()}`;
}

function tcTitle(c: Record<string, unknown>): string {
  const t = c.title as string | undefined;
  return t && t.trim() ? t : 'Untitled test case';
}

function readTags(c: Record<string, unknown>): string[] {
  const t = c.tags;
  if (!Array.isArray(t)) return [];
  return t.filter((x): x is string => typeof x === 'string');
}

function validationTypeOf(tags: string[]): ValidationType | null {
  for (const tag of tags) {
    if (!tag.startsWith(VALIDATION_TAG_PREFIX)) continue;
    const v = tag.slice(VALIDATION_TAG_PREFIX.length);
    if ((VALIDATION_TYPES as readonly string[]).includes(v))
      return v as ValidationType;
  }
  return null;
}

function nonValidationTags(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith(VALIDATION_TAG_PREFIX));
}

function topTags(items: AggregatedArtifactItem[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const tags = nonValidationTags(readTags(it.content));
    const seen = new Set<string>();
    for (const tag of tags) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([t]) => t);
}

export function TestPlansPage() {
  const navigate = useNavigate();
  const [exportOpen, setExportOpen] = useState(false);
  const {
    searchParams, q, inputValue, setInputValue, patchParams, clearAll,
  } = useListPageUrlState();

  const validation = parseList<ValidationType>(
    searchParams.get('validation'),
    VALIDATION_TYPES,
  );
  const tags = (searchParams.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const rawSort = searchParams.get('sort') as TestSort | null;
  const sort = SORTS.some((s) => s.key === rawSort)
    ? (rawSort as TestSort)
    : DEFAULT_SORT;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const filtersActive =
    q !== '' ||
    validation.length > 0 ||
    tags.length > 0 ||
    sort !== DEFAULT_SORT;

  function toggleValidation(v: ValidationType) {
    const next = validation.includes(v)
      ? validation.filter((x) => x !== v)
      : [...validation, v];
    patchParams({ validation: next.length ? next.join(',') : null, page: null });
  }

  function setTags(next: string[]) {
    patchParams({ tags: next.length ? next.join(',') : null, page: null });
  }

  function setSort(s: TestSort) {
    patchParams({ sort: s === DEFAULT_SORT ? null : s, page: null });
  }

  function setPage(n: number) {
    patchParams({ page: n <= 1 ? null : String(n) });
  }

  // Backend supports created_desc / created_asc only of our four sorts.
  // For title_*, fetch with default order and re-sort client-side on the page.
  const backendSort: 'created_desc' | 'created_asc' =
    sort === 'created_asc' ? 'created_asc' : 'created_desc';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['artifacts', 'list', { type: 'test_case', q, sort: backendSort, page }],
    queryFn: () =>
      listArtifacts({
        type: 'test_case',
        search: q || undefined,
        sort: backendSort,
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

  const tagOptions = useMemo(() => topTags(items, 10), [items]);

  const filtered = useMemo(() => {
    let out = items;
    if (validation.length > 0) {
      out = out.filter((it) => {
        const v = validationTypeOf(readTags(it.content));
        return v != null && validation.includes(v);
      });
    }
    if (tags.length > 0) {
      out = out.filter((it) => {
        const itTags = readTags(it.content);
        return tags.every((t) => itTags.includes(t));
      });
    }
    if (sort === 'title_asc' || sort === 'title_desc') {
      out = [...out].sort((a, b) => {
        const cmp = tcTitle(a.content).localeCompare(tcTitle(b.content));
        return sort === 'title_asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [items, validation, tags, sort]);

  const distinctSessions = new Set(filtered.map((i) => i.session_id)).size;
  const allFitOnPage = items.length === total;
  const localFiltersActive = validation.length > 0 || tags.length > 0;

  const showEverEmpty =
    !isLoading && total === 0 && stats !== undefined && stats.total_test_cases === 0;
  const showFilteredEmpty =
    !isLoading &&
    filtered.length === 0 &&
    !showEverEmpty &&
    (filtersActive || stats !== undefined);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-medium text-fg-0">Test plans</h1>
          <p className="mt-1 text-[11.5px] text-fg-2">
            {total > 0 ? (
              <>
                <span className="tabular-nums">{total}</span> test case
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
                {localFiltersActive && (
                  <span className="ml-2 text-fg-2">
                    · filtered on this page ({PAGE_SIZE} max)
                  </span>
                )}
              </>
            ) : (
              'All test cases generated from your testing sessions'
            )}
          </p>
        </div>
        <ExportButton onClick={() => setExportOpen(true)} />
      </header>

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        artifactType="test_cases"
        initialFilters={{
          validation_type: validation.length ? validation : undefined,
        }}
      />

      <FilterBar
        inputValue={inputValue}
        onInputChange={setInputValue}
        validation={validation}
        onToggleValidation={toggleValidation}
        tagOptions={tagOptions}
        selectedTags={tags}
        onTagsChange={setTags}
        sort={sort}
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
          <span>Validation</span>
          <span>Tags</span>
          <span className="text-right">Date</span>
          <span />
        </div>

        {isError ? (
          <div className="flex items-center justify-between px-3.5 py-7 text-sm">
            <span className="text-fg-1">Couldn't load test cases.</span>
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
              <TestSkeletonRow key={i} />
            ))}
          </div>
        ) : showEverEmpty ? (
          <EmptyState
            title="No test cases yet"
            body="Test cases will appear here once you record QA sessions and the synthesis pipeline finishes."
            action={
              <Link to="/sessions/new" className="btn-primary">
                + Record a session
              </Link>
            }
          />
        ) : showFilteredEmpty ? (
          <EmptyState
            title="No test cases match these filters"
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
              {filtered.map((tc) => (
                <TestRow
                  key={tc.id}
                  tc={tc}
                  onClick={() =>
                    navigate(`/sessions/${tc.session_id}#test_cases`)
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
  validation, onToggleValidation,
  tagOptions, selectedTags, onTagsChange,
  sort, onSortChange,
  filtersActive, onClear,
}: {
  inputValue: string;
  onInputChange: (v: string) => void;
  validation: ValidationType[];
  onToggleValidation: (v: ValidationType) => void;
  tagOptions: string[];
  selectedTags: string[];
  onTagsChange: (next: string[]) => void;
  sort: TestSort;
  onSortChange: (s: TestSort) => void;
  filtersActive: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="input"
        style={{ width: 280 }}
        type="search"
        placeholder="search test case titles..."
        value={inputValue}
        onChange={(e) => onInputChange(e.target.value)}
      />
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {VALIDATION_TYPES.map((v) => (
          <FilterPill
            key={v}
            label={VALIDATION_LABEL[v]}
            active={validation.includes(v)}
            onClick={() => onToggleValidation(v)}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-border-0" />
        <TagsDropdown
          options={tagOptions}
          selected={selectedTags}
          onChange={onTagsChange}
        />
        <span className="mx-1 h-4 w-px bg-border-0" />
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as TestSort)}
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
      className="inline-flex items-center rounded-full border-0.5 px-2.5 py-[3px] text-[11px] font-medium transition-colors"
      style={
        active
          ? {
              backgroundColor: FILTER_ACTIVE_TINT.bg,
              borderColor: FILTER_ACTIVE_TINT.border,
              color: FILTER_ACTIVE_TINT.fg,
            }
          : { backgroundColor: 'transparent', borderColor: '#2a2a32', color: '#a8a8b3' }
      }
    >
      {label}
    </button>
  );
}

function TagsDropdown({
  options, selected, onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function toggle(tag: string) {
    onChange(
      selected.includes(tag)
        ? selected.filter((t) => t !== tag)
        : [...selected, tag],
    );
  }

  const label =
    selected.length > 0 ? `Tags (${selected.length})` : 'Tags';
  const active = selected.length > 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md border-0.5 border-border-0 bg-bg-1 px-2.5 py-[5px] text-[11.5px] transition-colors hover:bg-bg-2"
        style={{ color: active ? '#22d3ee' : '#a8a8b3' }}
      >
        {label}
        <span className="text-[9px]">▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 z-20 mt-1 w-56 rounded-md border-0.5 border-border-0 bg-bg-1 p-1.5 shadow-lg"
          style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
        >
          {options.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-fg-2">
              No tags on this page.
            </div>
          ) : (
            <>
              <div className="mb-1 flex items-center justify-between px-1.5 pt-1">
                <span className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
                  Top tags
                </span>
                {selected.length > 0 && (
                  <button
                    onClick={() => onChange([])}
                    className="text-[10.5px] text-fg-2 hover:text-fg-0"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="max-h-64 overflow-y-auto">
                {options.map((tag) => {
                  const checked = selected.includes(tag);
                  return (
                    <label
                      key={tag}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11.5px] text-fg-1 hover:bg-bg-2"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(tag)}
                        className="h-3 w-3"
                        style={{ accentColor: '#22d3ee' }}
                      />
                      <span className="truncate">{tag}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ValidationCell({ value }: { value: ValidationType | null }) {
  if (!value) return <span className="text-[11px] text-fg-2">—</span>;
  const t = VALIDATION_TINT[value];
  return (
    <span
      className="inline-flex items-center rounded-full border-0.5 px-2 py-[2px] text-[10.5px] font-medium"
      style={{ backgroundColor: t.bg, borderColor: t.border, color: t.fg }}
    >
      {VALIDATION_LABEL[value]}
    </span>
  );
}

function TagPills({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="text-[11px] text-fg-2">—</span>;
  const visible = tags.slice(0, 3);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {visible.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded-full border-0.5 px-2 py-[1px] text-[10px] font-medium"
          style={{ backgroundColor: '#1f1f25', borderColor: '#2a2a32', color: '#a8a8b3' }}
        >
          {tag}
        </span>
      ))}
      {overflow > 0 && (
        <span className="text-[10.5px] tabular-nums text-fg-2">+{overflow} more</span>
      )}
    </div>
  );
}

function TestRow({
  tc, onClick,
}: { tc: AggregatedArtifactItem; onClick: () => void }) {
  const title = tcTitle(tc.content);
  const allTags = readTags(tc.content);
  const validation = validationTypeOf(allTags);
  const otherTags = nonValidationTags(allTags);

  return (
    <button
      onClick={onClick}
      className={`group grid w-full ${ROW_GRID} items-center gap-3 px-3.5 py-[11px] text-left transition-colors hover:bg-[#12121a]`}
    >
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2 tabular-nums">
          {tcId(tc.id)}
        </div>
        <div className="mt-0.5 truncate text-[13px] font-medium text-fg-0">
          {title}
        </div>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] text-fg-1">{tc.session_title}</div>
        <div className="mt-0.5 truncate text-[11px] text-fg-2">
          <span className="tabular-nums">
            {formatDuration(tc.session_duration_seconds)}
          </span>
          {' · '}
          {formatRelativeTime(tc.session_created_at)}
        </div>
      </div>
      <ValidationCell value={validation} />
      <TagPills tags={otherTags} />
      <span className="text-right text-[11px] tabular-nums text-fg-2">
        {formatRelativeTime(tc.created_at)}
      </span>
      <span className="text-right text-[12px] text-fg-2 transition-colors group-hover:text-fg-0">
        →
      </span>
    </button>
  );
}

function TestSkeletonRow() {
  return (
    <div className={`grid ${ROW_GRID} items-center gap-3 px-3.5 py-[11px]`}>
      <div className="space-y-1.5">
        <div className="h-2.5 w-12 animate-pulse rounded bg-bg-2" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-bg-2" />
      </div>
      <div className="space-y-1.5">
        <div className="h-3 w-3/4 animate-pulse rounded bg-bg-2" />
        <div className="h-2.5 w-1/2 animate-pulse rounded bg-bg-2" />
      </div>
      <div className="h-4 w-20 animate-pulse rounded-full bg-bg-2" />
      <div className="flex gap-1">
        <div className="h-4 w-12 animate-pulse rounded-full bg-bg-2" />
        <div className="h-4 w-14 animate-pulse rounded-full bg-bg-2" />
      </div>
      <div className="ml-auto h-3 w-12 animate-pulse rounded bg-bg-2" />
      <div />
    </div>
  );
}
