import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { listSessions } from '../api/client';
import { StatusPill } from '../components/StatusPill';

const ROW_GRID = 'grid-cols-[1fr,110px,90px,40px]';

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

export function SessionsPage() {
  const navigate = useNavigate();
  const {
    data: sessions,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => listSessions(),
    refetchInterval: 5000,
  });

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-base font-medium text-fg-0">Sessions</h1>
          <p className="mt-1 text-[11.5px] text-fg-2">
            All testing recordings and their generated artifacts
          </p>
        </div>
        <Link to="/sessions/new" className="btn-primary">
          + New session
        </Link>
      </header>

      <div className="card overflow-hidden">
        <div
          className={`grid ${ROW_GRID} items-center gap-4 border-b-0.5 border-border-0 px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2`}
        >
          <span>Session</span>
          <span>Status</span>
          <span className="text-right">Artifacts</span>
          <span />
        </div>

        {isError ? (
          <div className="flex items-center justify-between px-3.5 py-7 text-sm">
            <span className="text-fg-1">Couldn't load sessions.</span>
            <button
              onClick={() => refetch()}
              className="text-accent-green underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        ) : isLoading ? (
          <div className="divide-y-0.5 divide-border-0">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : sessions && sessions.length === 0 ? (
          <div className="px-3.5 py-[30px] text-center">
            <p className="text-sm font-medium text-fg-0">No sessions yet</p>
            <p className="mx-auto mt-1 max-w-md text-[12.5px] text-fg-2">
              Create your first session to see test cases, bug reports, and coverage gaps appear here.
            </p>
            <Link to="/sessions/new" className="btn-primary mt-4">
              + New session
            </Link>
          </div>
        ) : (
          <div className="divide-y-0.5 divide-border-0">
            {sessions?.map((s) => (
              <button
                key={s.session_id}
                onClick={() => navigate(`/sessions/${s.session_id}`)}
                className={`grid w-full ${ROW_GRID} items-center gap-4 px-3.5 py-[11px] text-left transition-colors hover:bg-bg-2`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-fg-0">{s.title}</div>
                  <div className="mt-0.5 truncate text-[11px] text-fg-2">
                    <span className="text-fg-1">{s.test_focus}</span>
                    {' · '}
                    <span className="tabular-nums">{formatDuration(s.duration_seconds)}</span>
                    {' · '}
                    {formatRelativeTime(s.created_at)}
                  </div>
                </div>
                <StatusPill status={s.status} />
                <span className="text-right text-[12px] tabular-nums text-fg-1">
                  {s.artifact_count}
                </span>
                <span className="text-right text-[12px] text-fg-2">→</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className={`grid ${ROW_GRID} items-center gap-4 px-3.5 py-[11px]`}>
      <div className="space-y-1.5">
        <div className="h-3 w-1/2 animate-pulse rounded bg-bg-2" />
        <div className="h-2.5 w-3/4 animate-pulse rounded bg-bg-2" />
      </div>
      <div className="h-4 w-16 animate-pulse rounded-full bg-bg-2" />
      <div className="ml-auto h-3 w-8 animate-pulse rounded bg-bg-2" />
      <div />
    </div>
  );
}
