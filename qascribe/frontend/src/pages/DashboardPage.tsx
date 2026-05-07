import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  exportArtifacts, getArtifactStats, getCoverageRollup, getSessionStatus,
  listSessions, triggerBlobDownload,
  type ExportArtifactType, type ExportFormat,
} from '../api/client';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import type { ArtifactStats, CoverageRollupResponse, SessionListItem } from '../types';

const RECENT_LIMIT = 5;
const STATS_STALE_MS = 30_000;

// ---------- shared helpers ----------

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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

// ---------- icons ----------

function ArrowRight({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8h9M9 4l4 4-4 4" />
    </svg>
  );
}

function CheckIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3.5 3.5L13 5" />
    </svg>
  );
}

function FileIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
  );
}

// ---------- page ----------

export function DashboardPage() {
  const statsQuery = useQuery({
    queryKey: ['artifacts', 'stats'],
    queryFn: getArtifactStats,
    staleTime: STATS_STALE_MS,
  });
  const recentQuery = useQuery({
    queryKey: ['sessions', 'recent', { limit: RECENT_LIMIT }],
    queryFn: () => listSessions(RECENT_LIMIT),
    staleTime: STATS_STALE_MS,
  });
  const coverageQuery = useQuery({
    queryKey: ['artifacts', 'coverage-rollup'],
    queryFn: getCoverageRollup,
    staleTime: STATS_STALE_MS,
  });

  const sessions = recentQuery.data;
  const lastSession = sessions && sessions.length > 0 ? sessions[0] : null;

  // Welcome empty state: brand-new user, no sessions, recent query resolved.
  const isBrandNew =
    !recentQuery.isLoading && !recentQuery.isError && sessions?.length === 0;

  if (isBrandNew) {
    return <WelcomeEmptyState />;
  }

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <PageHeader lastSessionAt={lastSession?.created_at} />

      <Hero stats={statsQuery.data} isLoading={statsQuery.isLoading} />

      <RecentSessions
        sessions={sessions}
        isLoading={recentQuery.isLoading}
        isError={recentQuery.isError}
        onRetry={() => recentQuery.refetch()}
      />

      <AtAGlance
        stats={statsQuery.data}
        coverage={coverageQuery.data}
        isLoading={statsQuery.isLoading || coverageQuery.isLoading}
        isError={statsQuery.isError}
        onRetry={() => statsQuery.refetch()}
      />

      <QuickExports stats={statsQuery.data} isLoading={statsQuery.isLoading} />
    </div>
  );
}

// ---------- 1. Page header ----------

function PageHeader({ lastSessionAt }: { lastSessionAt?: string }) {
  return (
    <header className="mb-6 flex items-end justify-between">
      <div>
        <h1 className="text-base font-medium text-fg-0">Dashboard</h1>
        <p className="mt-1 text-[11.5px] text-fg-2">
          Welcome back
          {lastSessionAt && (
            <>
              {' · '}
              <span className="text-fg-1">
                Last session {formatRelativeTime(lastSessionAt)}
              </span>
            </>
          )}
        </p>
      </div>
      <Link to="/sessions/new" className="btn-primary">
        + New session
      </Link>
    </header>
  );
}

// ---------- 2. Hero — Needs your attention ----------

const AMBER = '#fbbf24';
const RED = '#f87171';
const GREEN = '#4ade80';

function Hero({
  stats, isLoading,
}: {
  stats?: ArtifactStats;
  isLoading: boolean;
}) {
  if (isLoading || !stats) {
    return (
      <section className="mb-7 grid grid-cols-2 gap-3">
        <HeroSkeleton accent={AMBER} />
        <HeroSkeleton accent={RED} />
      </section>
    );
  }

  const unreviewed = stats.bugs_by_review_status.unreviewed ?? 0;
  const highSevConfirmed = stats.high_severity_confirmed_count ?? 0;

  return (
    <section className="mb-7 grid grid-cols-2 gap-3">
      <HeroCard
        accent={AMBER}
        label="needs your review"
        to={
          unreviewed > 0
            ? '/bugs?review=unreviewed'
            : '/bugs'
        }
        valueNode={
          unreviewed > 0 ? (
            <span
              className="text-[26px] font-medium leading-none tabular-nums"
              style={{ color: AMBER }}
            >
              {unreviewed}
            </span>
          ) : (
            <span style={{ color: GREEN }} className="inline-flex items-center">
              <CheckIcon size={22} />
            </span>
          )
        }
        body={
          unreviewed > 0
            ? `${unreviewed} unreviewed ${unreviewed === 1 ? 'bug' : 'bugs'} from your sessions`
            : 'All caught up'
        }
      />
      <HeroCard
        accent={RED}
        label="high severity, confirmed"
        to="/bugs?severity=critical,high&review=confirmed"
        valueNode={
          <span
            className="text-[26px] font-medium leading-none tabular-nums"
            style={{ color: highSevConfirmed > 0 ? RED : '#a8a8b3' }}
          >
            {highSevConfirmed}
          </span>
        }
        body={
          highSevConfirmed > 0
            ? 'tracked bugs awaiting fix'
            : 'No high-severity bugs confirmed'
        }
      />
    </section>
  );
}

function HeroCard({
  accent, label, valueNode, body, to,
}: {
  accent: string;
  label: string;
  valueNode: ReactNode;
  body: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group relative flex items-center gap-4 rounded-lg bg-[#0d0d11] px-4 py-[14px] transition-colors"
      style={{
        borderLeft: `2px solid ${accent}`,
        border: `0.5px solid #1f1f25`,
        borderLeftWidth: 2,
        borderLeftColor: accent,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#2a2a32';
        e.currentTarget.style.borderLeftColor = accent;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#1f1f25';
        e.currentTarget.style.borderLeftColor = accent;
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
          {label}
        </div>
        <div className="mt-1.5 flex items-center gap-3">{valueNode}</div>
        <div className="mt-1.5 text-[12px] text-fg-1">{body}</div>
      </div>
      <span className="shrink-0 text-fg-2 transition-transform group-hover:translate-x-0.5 group-hover:text-fg-0">
        <ArrowRight size={16} />
      </span>
    </Link>
  );
}

function HeroSkeleton({ accent }: { accent: string }) {
  return (
    <div
      className="relative rounded-lg bg-[#0d0d11] px-4 py-[14px]"
      style={{
        border: `0.5px solid #1f1f25`,
        borderLeft: `2px solid ${accent}`,
      }}
    >
      <div className="h-3 w-32 animate-pulse rounded bg-bg-2" />
      <div className="mt-2 h-7 w-16 animate-pulse rounded bg-bg-2" />
      <div className="mt-2 h-3 w-48 animate-pulse rounded bg-bg-2" />
    </div>
  );
}

// ---------- 3. Recent sessions ----------

const RECENT_GRID = 'grid-cols-[2fr,80px,70px,70px,12px]';

function RecentSessions({
  sessions, isLoading, isError, onRetry,
}: {
  sessions?: SessionListItem[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="mb-7">
      <SectionHeader
        title="recent sessions"
        rightLink={{ to: '/sessions', label: 'View all' }}
      />
      <div className="card overflow-hidden">
        <div
          className={`grid ${RECENT_GRID} items-center gap-3 border-b-0.5 border-border-0 px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2`}
        >
          <span>Session</span>
          <span>Status</span>
          <span className="text-right">Artifacts</span>
          <span className="text-right">Bugs</span>
          <span />
        </div>
        {isError ? (
          <SectionError
            message="Couldn't load recent sessions."
            onRetry={onRetry}
          />
        ) : isLoading ? (
          <div className="divide-y-0.5 divide-border-0">
            {Array.from({ length: 3 }).map((_, i) => (
              <RecentSkeletonRow key={i} />
            ))}
          </div>
        ) : (
          <RecentSessionRows sessions={sessions ?? []} />
        )}
      </div>
    </section>
  );
}

function RecentSessionRows({ sessions }: { sessions: SessionListItem[] }) {
  const navigate = useNavigate();
  // We requested limit=RECENT_LIMIT, so backend already returns at most that
  // many. The "more than 5" hint is a soft heuristic — show the link any time
  // we got a full page back.
  const showMore = sessions.length >= RECENT_LIMIT;

  return (
    <>
      <div className="divide-y-0.5 divide-border-0">
        {sessions.map((s) => (
          <button
            key={s.session_id}
            onClick={() => navigate(`/sessions/${s.session_id}`)}
            className={`grid w-full ${RECENT_GRID} items-center gap-3 px-3.5 py-[11px] text-left transition-colors hover:bg-[#12121a]`}
          >
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-fg-0">
                {s.title}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-fg-2 tabular-nums">
                {formatDuration(s.duration_seconds)} · {formatRelativeTime(s.created_at)}
              </div>
            </div>
            <StatusPill status={s.status} />
            <span className="text-right text-[12px] tabular-nums text-fg-1">
              {s.artifact_count} artifacts
            </span>
            <span className="text-right text-[12px] tabular-nums text-fg-1">
              <BugCountForSession sessionId={s.session_id} fallback={0} />
            </span>
            <span className="text-fg-2">
              <ArrowRight size={12} />
            </span>
          </button>
        ))}
      </div>
      {showMore && (
        <div className="border-t-0.5 border-border-0 px-3.5 py-2 text-right">
          <Link
            to="/sessions"
            className="text-[11.5px] text-fg-2 transition-colors hover:text-fg-0"
          >
            View all sessions →
          </Link>
        </div>
      )}
    </>
  );
}

// Per-row bug count: SessionListItem carries only a combined artifact_count,
// so we lazily fetch session status per visible row to break it out.
function BugCountForSession({
  sessionId, fallback,
}: {
  sessionId: string;
  fallback: number;
}) {
  const { data } = useQuery({
    queryKey: ['session-status-bug-count', sessionId],
    queryFn: () => getSessionStatus(sessionId),
    staleTime: STATS_STALE_MS,
  });
  const n = data?.artifact_counts.bug_report ?? fallback;
  return <>{n} bugs</>;
}

function RecentSkeletonRow() {
  return (
    <div className={`grid ${RECENT_GRID} items-center gap-3 px-3.5 py-[11px]`}>
      <div className="space-y-1.5">
        <div className="h-3 w-1/2 animate-pulse rounded bg-bg-2" />
        <div className="h-2.5 w-1/3 animate-pulse rounded bg-bg-2" />
      </div>
      <div className="h-4 w-14 animate-pulse rounded-full bg-bg-2" />
      <div className="ml-auto h-3 w-12 animate-pulse rounded bg-bg-2" />
      <div className="ml-auto h-3 w-10 animate-pulse rounded bg-bg-2" />
      <div />
    </div>
  );
}

// ---------- 4. At a glance ----------

function AtAGlance({
  stats, coverage, isLoading, isError, onRetry,
}: {
  stats?: ArtifactStats;
  coverage?: CoverageRollupResponse;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="mb-7">
      <SectionHeader title="at a glance" />
      {isError ? (
        <div className="card">
          <SectionError
            message="Couldn't load summary panels."
            onRetry={onRetry}
          />
        </div>
      ) : isLoading || !stats ? (
        <div className="grid grid-cols-3 gap-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <GlancePanelSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2.5">
          <BugsPanel stats={stats} />
          <TestCasesPanel stats={stats} />
          <CoveragePanel stats={stats} coverage={coverage} />
        </div>
      )}
    </section>
  );
}

function GlancePanelShell({
  to, header, value, detail,
}: {
  to: string;
  header: string;
  value: ReactNode;
  detail: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="group block rounded-lg bg-[#0d0d11] px-3.5 py-3 transition-colors"
      style={{ border: '0.5px solid #1f1f25' }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#2a2a32')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#1f1f25')}
    >
      <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
        <span>{header}</span>
        <span className="text-fg-2 transition-transform group-hover:translate-x-0.5 group-hover:text-fg-0">
          <ArrowRight size={12} />
        </span>
      </div>
      <div className="mt-1.5 text-[20px] font-medium leading-none tabular-nums text-fg-0">
        {value}
      </div>
      <div className="mt-1.5 text-[11px] text-fg-1">{detail}</div>
    </Link>
  );
}

function BugsPanel({ stats }: { stats: ArtifactStats }) {
  const total = stats.total_bug_reports;
  const r = stats.bugs_by_review_status;
  const confirmed = r.confirmed ?? 0;
  const unreviewed = r.unreviewed ?? 0;
  const dismissed = r.dismissed ?? 0;
  const needs = r.needs_more_info ?? 0;

  return (
    <GlancePanelShell
      to="/bugs"
      header="bugs"
      value={total}
      detail={
        <span className="tabular-nums">
          <span style={{ color: GREEN }}>{confirmed} confirmed</span>
          <span className="text-fg-2"> · </span>
          <span style={{ color: AMBER }}>{unreviewed} unreviewed</span>
          <span className="text-fg-2"> · </span>
          <span className="text-fg-2">{dismissed} dismissed</span>
          {needs > 0 && (
            <>
              <span className="text-fg-2"> · </span>
              <span style={{ color: '#a78bfa' }}>{needs} needs info</span>
            </>
          )}
        </span>
      }
    />
  );
}

function TestCasesPanel({ stats }: { stats: ArtifactStats }) {
  const edited = stats.test_cases_user_edited_this_month;
  return (
    <GlancePanelShell
      to="/test-plans"
      header="test cases"
      value={stats.total_test_cases}
      detail={
        <span className="tabular-nums">
          {edited} user-edited this month
        </span>
      }
    />
  );
}

function CoveragePanel({
  stats, coverage,
}: {
  stats: ArtifactStats;
  coverage?: CoverageRollupResponse;
}) {
  // Prefer the dedup-rollup count for the headline number; fall back to raw
  // total if the rollup query is still loading.
  const uniqueCount = coverage?.total ?? stats.total_coverage_gaps;
  const recurring = coverage
    ? coverage.items.filter((i) => i.occurrences > 1).length
    : 0;
  return (
    <GlancePanelShell
      to="/coverage"
      header="coverage gaps"
      value={uniqueCount}
      detail={
        <span className="tabular-nums">
          {coverage ? `${recurring} raised in 2+ sessions` : 'Loading…'}
        </span>
      }
    />
  );
}

function GlancePanelSkeleton() {
  return (
    <div
      className="rounded-lg bg-[#0d0d11] px-3.5 py-3"
      style={{ border: '0.5px solid #1f1f25' }}
    >
      <div className="h-3 w-20 animate-pulse rounded bg-bg-2" />
      <div className="mt-2 h-5 w-12 animate-pulse rounded bg-bg-2" />
      <div className="mt-2 h-3 w-40 animate-pulse rounded bg-bg-2" />
    </div>
  );
}

// ---------- 5. Quick exports footer ----------

function QuickExports({
  stats, isLoading,
}: {
  stats?: ArtifactStats;
  isLoading: boolean;
}) {
  const toast = useToast();
  const [busyFormat, setBusyFormat] = useState<ExportFormat | null>(null);
  const last7 = stats?.artifacts_created_last_7_days;
  const bugs7 = last7?.bug_report ?? 0;
  const tcs7 = last7?.test_case ?? 0;

  async function downloadWeekly(format: ExportFormat) {
    if (busyFormat) return;
    setBusyFormat(format);
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const date_from = weekAgo.toISOString().slice(0, 10);
    const date_to = today.toISOString().slice(0, 10);
    const types: ExportArtifactType[] = ['bugs', 'test_cases', 'coverage_gaps'];
    try {
      for (const t of types) {
        const { blob, filename } = await exportArtifacts(t, format, {
          date_from, date_to,
        });
        triggerBlobDownload(blob, filename);
      }
      toast.push(`Exported 3 ${format.toUpperCase()} files`, 'success');
    } catch {
      toast.push('Export failed', 'error');
    } finally {
      setBusyFormat(null);
    }
  }

  return (
    <section>
      <SectionHeader title="quick exports" />
      <div
        className="flex items-center justify-between rounded-lg bg-bg-1 px-4 py-3"
        style={{ border: '0.5px solid #1f1f25' }}
      >
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg-0">
            This week's report
          </div>
          <div className="mt-0.5 text-[11px] text-fg-2 tabular-nums">
            {isLoading || !stats
              ? 'Loading last 7 days…'
              : `${bugs7} bugs, ${tcs7} test cases`}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <ExportButton
            label={busyFormat === 'json' ? 'Preparing…' : 'JSON'}
            onClick={() => downloadWeekly('json')}
            disabled={busyFormat !== null}
          />
          <ExportButton
            label={busyFormat === 'csv' ? 'Preparing…' : 'CSV'}
            onClick={() => downloadWeekly('csv')}
            disabled={busyFormat !== null}
          />
          <ExportButton
            label="Word"
            disabled
            title="Word export coming soon"
            onClick={() => undefined}
          />
        </div>
      </div>
    </section>
  );
}

function ExportButton({
  label, onClick, disabled, title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md border-0.5 border-border-0 bg-transparent px-2.5 py-1 text-[11.5px] font-medium text-fg-1 transition-colors hover:bg-bg-2 hover:text-fg-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-1"
    >
      <FileIcon />
      {label}
      {disabled && <span className="text-fg-2">(later)</span>}
    </button>
  );
}

// ---------- shared bits ----------

function SectionHeader({
  title, rightLink,
}: {
  title: string;
  rightLink?: { to: string; label: string };
}) {
  return (
    <div className="mb-2 flex items-end justify-between px-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
        {title}
      </span>
      {rightLink && (
        <Link
          to={rightLink.to}
          className="text-[11px] text-fg-2 transition-colors hover:text-fg-0"
        >
          {rightLink.label} →
        </Link>
      )}
    </div>
  );
}

function SectionError({
  message, onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-3.5 py-7 text-sm">
      <span className="text-fg-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="text-accent-green underline-offset-2 hover:underline"
      >
        Retry
      </button>
    </div>
  );
}

// ---------- empty state ----------

function WelcomeEmptyState() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-8 py-12 text-center">
      <span className="mb-4 block h-10 w-10 rounded-xl bg-gradient-to-br from-accent-green to-accent-cyan p-[2px] shadow-glow-accent">
        <span className="block h-full w-full rounded-[10px] bg-bg-1" />
      </span>
      <h1 className="text-lg font-medium text-fg-0">Welcome to QAScribe</h1>
      <p className="mt-2 text-[13px] text-fg-2">
        Record your first QA session to get started.
      </p>
      <Link to="/sessions/new" className="btn-primary mt-6">
        + New session
      </Link>
    </div>
  );
}
