import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  deleteArtifact, getArtifacts, getSessionStatus, getSessionVideoUrl,
  getWorkflow, retrySession, updateArtifact,
} from '../api/client';
import type { Artifact, ArtifactType, WorkflowStep } from '../types';
import { BugCard } from '../components/BugCard';
import { useToast } from '../components/Toast';
import { useBugReviewMutation } from '../hooks/useBugReviewMutation';

type SubTab = 'workflow' | 'test_cases' | 'bugs' | 'coverage' | 'transcript';

const STEP_COLOR: Record<WorkflowStep['kind'], string> = {
  action: '#6b6b75',
  voice_annotation: '#22d3ee',
  anomaly: '#f87171',
};

const ARTIFACT_BORDER: Record<ArtifactType, string> = {
  test_case: '#4ade80',
  bug_report: '#f87171',
  coverage_gap: '#a78bfa',
};

function formatTimestamp(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id!;
  const [tab, setTabState] = useState<SubTab>(() => {
    const hash = window.location.hash.slice(1) as SubTab;
    return ['workflow', 'test_cases', 'bugs', 'coverage', 'transcript'].includes(hash)
      ? hash
      : 'workflow';
  });
  const setTab = (t: SubTab) => {
    setTabState(t);
    window.history.replaceState(null, '', `#${t}`);
  };

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getSessionStatus(sessionId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && (data.status === 'queued' || data.status === 'processing')) return 3000;
      return false;
    },
  });

  const queryClient = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: () => retrySession(sessionId),
    onSuccess: () => {
      toast.push('Re-queued — processing started', 'success');
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['artifacts', sessionId] });
    },
    onError: (err: any) => {
      toast.push(
        err?.response?.data?.detail || err.message || 'Retry failed',
        'error',
      );
    },
  });

  // Hoisted artifacts query — TanStack dedupes the identical key with child
  // queries below, so this is a shared cache read, not a duplicate fetch.
  // We need it here to compute the unreviewed-bug badge count and to mute
  // dismissed-bug links in the workflow timeline.
  const isCompleted = session?.status === 'completed';
  const { data: artifacts } = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => getArtifacts(sessionId),
    enabled: !!sessionId && isCompleted,
  });

  if (!session) {
    return <SessionSkeleton />;
  }

  const isProcessing = session.status === 'queued' || session.status === 'processing';
  const cost = session.actual_cost_usd ?? session.estimated_cost_usd;
  const unreviewedBugCount = artifacts
    ? artifacts.filter(
        (a) => a.artifact_type === 'bug_report' && a.review_status === 'unreviewed',
      ).length
    : undefined;

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <Link
        to="/"
        className="inline-flex items-center rounded-[5px] px-2 py-1 text-[11px] text-fg-2 transition-colors hover:bg-bg-1 hover:text-fg-0"
      >
        ← back to sessions
      </Link>
      <header className="mt-3">
        <h1 className="text-base font-medium text-fg-0">{session.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-fg-2">
          <span className="tabular-nums">
            {Math.round(session.duration_seconds)}s duration
          </span>
          <span>·</span>
          <span className="capitalize">{session.test_focus}</span>
          {cost != null && (
            <>
              <span>·</span>
              <span className="tabular-nums">
                ${cost.toFixed(3)}
                {session.actual_cost_usd != null ? ' actual' : ' est'}
              </span>
            </>
          )}
        </div>
        {(session.error_message ||
          session.status === 'failed' ||
          session.status === 'rejected_budget') && (
          <div className="mt-3 space-y-2">
            {session.error_message && (
              <div
                className="rounded-md border-0.5 px-3 py-2 text-[12px]"
                style={{
                  backgroundColor: 'rgba(248,113,113,0.08)',
                  borderColor: 'rgba(248,113,113,0.25)',
                  color: '#f87171',
                }}
              >
                {session.error_message}
              </div>
            )}
            {(session.status === 'failed' ||
              session.status === 'rejected_budget') && (
              <button
                onClick={() => retry.mutate()}
                disabled={retry.isPending}
                className="btn-primary"
              >
                {retry.isPending ? 'Re-queueing…' : 'Retry processing'}
              </button>
            )}
          </div>
        )}
      </header>

      {isProcessing ? (
        <ProcessingPanel />
      ) : isCompleted ? (
        <>
          <div className="mt-6 flex border-b-0.5 border-border-0">
            <Tab
              active={tab === 'workflow'}
              onClick={() => setTab('workflow')}
              label="Workflow"
            />
            <Tab
              active={tab === 'test_cases'}
              onClick={() => setTab('test_cases')}
              label="Test cases"
              count={session.artifact_counts.test_case}
            />
            <Tab
              active={tab === 'bugs'}
              onClick={() => setTab('bugs')}
              label="Bugs"
              // Show unreviewed-only count (matches dashboard "needs attention"
              // logic). Hide the badge when zero or while artifacts load.
              count={
                unreviewedBugCount && unreviewedBugCount > 0
                  ? unreviewedBugCount
                  : undefined
              }
              countRedTint
            />
            <Tab
              active={tab === 'coverage'}
              onClick={() => setTab('coverage')}
              label="Coverage gaps"
              count={session.artifact_counts.coverage_gap}
            />
            <Tab
              active={tab === 'transcript'}
              onClick={() => setTab('transcript')}
              label="Transcript"
            />
          </div>

          <div key={tab} className="tab-fade-in mt-5">
            {tab === 'workflow' && (
              <WorkflowTab sessionId={sessionId} artifacts={artifacts} />
            )}
            {tab === 'test_cases' && (
              <ArtifactsList sessionId={sessionId} type="test_case" />
            )}
            {tab === 'bugs' && <BugsList sessionId={sessionId} />}
            {tab === 'coverage' && (
              <ArtifactsList sessionId={sessionId} type="coverage_gap" />
            )}
            {tab === 'transcript' && <TranscriptTab sessionId={sessionId} />}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Tab({
  active, onClick, label, count, countRedTint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  countRedTint?: boolean;
}) {
  const underline = active
    ? 'after:absolute after:bottom-[-1px] after:left-3 after:right-3 after:h-[1.5px] after:rounded-full after:bg-gradient-to-r after:from-accent-green after:to-accent-cyan after:shadow-glow-accent after:content-[""]'
    : '';
  return (
    <button
      onClick={onClick}
      className={`relative px-3.5 py-2 text-[12px] transition-colors duration-150 ${
        active ? 'text-fg-0' : 'text-fg-2 hover:text-fg-1'
      } ${underline}`}
    >
      {label}
      {count !== undefined && (
        <CountBadge n={count} active={active} redTint={countRedTint} />
      )}
    </button>
  );
}

function CountBadge({
  n, active, redTint,
}: { n: number; active: boolean; redTint?: boolean }) {
  const useRed = redTint && n > 0;
  const bg = useRed
    ? 'rgba(248,113,113,0.12)'
    : active
      ? 'rgba(74,222,128,0.12)'
      : '#1f1f25';
  const fg = useRed ? '#f87171' : active ? '#4ade80' : '#a8a8b3';
  return (
    <span
      className="ml-1.5 inline-flex items-center rounded-full px-[6px] py-[1px] text-[10px] font-medium tabular-nums"
      style={{ backgroundColor: bg, color: fg }}
    >
      {n}
    </span>
  );
}

function ProcessingPanel() {
  return (
    <div className="card mt-6 px-6 py-8 text-center">
      <div className="inline-flex items-center gap-2">
        <span
          className="pulse-dot block h-[5px] w-[5px] rounded-full"
          style={{ backgroundColor: '#4ade80', boxShadow: '0 0 6px #4ade80' }}
        />
        <span className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
          Processing
        </span>
      </div>
      <div className="mt-3 text-[13px] font-medium text-fg-0">
        Generating your artifacts
      </div>
      <div className="mt-1 text-[11px] text-fg-2">
        Gemini perception → Whisper transcription → Claude synthesis
      </div>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="h-3 w-32 animate-pulse rounded bg-bg-1" />
      <div className="mt-4 h-5 w-72 animate-pulse rounded bg-bg-1" />
      <div className="mt-2 h-3 w-96 animate-pulse rounded bg-bg-1" />
      <div className="mt-6 flex gap-4 border-b-0.5 border-border-0 pb-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-3 w-16 animate-pulse rounded bg-bg-1" />
        ))}
      </div>
      <div className="mt-5 grid grid-cols-[1fr_1.1fr] gap-3.5">
        <div className="h-72 animate-pulse rounded-lg bg-bg-1" />
        <div className="h-72 animate-pulse rounded-lg bg-bg-1" />
      </div>
    </div>
  );
}

function WorkflowTab({
  sessionId, artifacts,
}: {
  sessionId: string;
  artifacts: Artifact[] | undefined;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const { data: videoUrl } = useQuery({
    queryKey: ['video', sessionId],
    queryFn: () => getSessionVideoUrl(sessionId),
  });
  const { data: workflow } = useQuery({
    queryKey: ['workflow', sessionId],
    queryFn: () => getWorkflow(sessionId),
  });

  const dismissedBugIds = useMemo(() => {
    if (!artifacts) return new Set<string>();
    return new Set(
      artifacts
        .filter(
          (a) => a.artifact_type === 'bug_report' && a.review_status === 'dismissed',
        )
        .map((a) => a.id),
    );
  }, [artifacts]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(v.currentTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTime);
    };
  }, [videoUrl]);

  const seekTo = (ts: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = ts;
      videoRef.current.play().catch(() => undefined);
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  };

  const markers = useMemo(() => workflow?.steps || [], [workflow]);
  const duration = workflow?.duration_seconds || 1;
  const progressPct = Math.min(100, (currentTime / duration) * 100);

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seekTo(Math.max(0, Math.min(1, pct)) * duration);
  };

  return (
    <div className="grid grid-cols-[1fr_1.1fr] gap-3.5">
      <div className="card overflow-hidden">
        <div className="relative aspect-video bg-bg-0">
          {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              className="h-full w-full"
              onClick={togglePlay}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-fg-2">
              Loading video…
            </div>
          )}
          {videoUrl && !playing && (
            <button
              onClick={togglePlay}
              aria-label="Play"
              className="absolute inset-0 flex items-center justify-center"
            >
              <span
                className="flex h-14 w-14 items-center justify-center rounded-full"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  border: '0.5px solid rgba(255,255,255,0.15)',
                  backdropFilter: 'blur(4px)',
                  WebkitBackdropFilter: 'blur(4px)',
                }}
              >
                <span
                  className="ml-1 block h-0 w-0"
                  style={{
                    borderTop: '10px solid transparent',
                    borderBottom: '10px solid transparent',
                    borderLeft: '16px solid #f0f0f5',
                  }}
                />
              </span>
            </button>
          )}
        </div>
        <div className="border-t-0.5 border-border-0 px-3.5 py-3">
          <div
            onClick={onTrackClick}
            className="relative h-[3px] cursor-pointer rounded-full bg-bg-2"
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent-green to-accent-cyan"
              style={{ width: `${progressPct}%` }}
            />
            {markers.map((step) => {
              const left = (step.timestamp_seconds / duration) * 100;
              const color = STEP_COLOR[step.kind];
              return (
                <button
                  key={step.step_number}
                  onClick={(e) => {
                    e.stopPropagation();
                    seekTo(step.timestamp_seconds);
                  }}
                  className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-150"
                  style={{
                    left: `${left}%`,
                    backgroundColor: color,
                    boxShadow: step.kind === 'action' ? 'none' : `0 0 6px ${color}`,
                  }}
                  title={`${formatTimestamp(step.timestamp_seconds)} — ${step.kind}`}
                />
              );
            })}
          </div>
          <div className="mt-2 flex justify-between text-[10.5px] tabular-nums text-fg-2">
            <span>{formatTimestamp(currentTime)}</span>
            <span>{formatTimestamp(duration)}</span>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
            Steps
          </h3>
          <span className="text-[10px] tabular-nums text-fg-2">
            {markers.length} total
          </span>
        </div>
        <div className="max-h-[340px] space-y-1 overflow-y-auto pr-1">
          {markers.length === 0 ? (
            <div className="card px-3.5 py-7 text-center text-[12px] text-fg-2">
              No workflow data yet — re-run the session to generate it.
            </div>
          ) : (
            markers.map((step) => (
              <StepRow
                key={step.step_number}
                step={step}
                onSeek={seekTo}
                dismissedBugIds={dismissedBugIds}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StepRow({
  step, onSeek, dismissedBugIds,
}: {
  step: WorkflowStep;
  onSeek: (ts: number) => void;
  dismissedBugIds: Set<string>;
}) {
  const color = STEP_COLOR[step.kind];
  const isAnomaly = step.kind === 'anomaly';
  const linkedCount = step.linked_artifact_ids.length;
  // The anomaly happened regardless of triage outcome — keep the marker
  // visible but mute the link text when every linked bug was dismissed.
  const allLinkedDismissed =
    linkedCount > 0 &&
    step.linked_artifact_ids.every((id) => dismissedBugIds.has(id));
  return (
    <button
      onClick={() => onSeek(step.timestamp_seconds)}
      className="flex w-full items-start gap-2.5 rounded-r-[5px] py-[9px] pl-[11px] pr-[11px] text-left transition-colors hover:bg-bg-2"
      style={{
        borderLeft: `2px solid ${color}`,
        backgroundColor: isAnomaly ? 'rgba(248,113,113,0.04)' : undefined,
      }}
    >
      <span className="mt-[1px] inline-block min-w-[18px] text-[10px] tabular-nums text-fg-2">
        {step.step_number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-fg-0">{step.summary}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-fg-2">
          <span className="tabular-nums">{formatTimestamp(step.timestamp_seconds)}</span>
          <span>·</span>
          <span className="capitalize">{step.kind.replace('_', ' ')}</span>
          {linkedCount > 0 && (
            <>
              <span>·</span>
              <span
                style={{
                  color: allLinkedDismissed ? '#6b6b75' : '#f87171',
                  textDecoration: allLinkedDismissed ? 'line-through' : undefined,
                }}
              >
                linked to {linkedCount} bug
              </span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function BugsList({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { changeReview } = useBugReviewMutation();

  const { data: artifacts, isLoading } = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => getArtifacts(sessionId),
  });
  const bugs = artifacts?.filter((a) => a.artifact_type === 'bug_report') ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card h-20 animate-pulse" />
        ))}
      </div>
    );
  }
  if (bugs.length === 0) {
    return (
      <div className="card px-3.5 py-7 text-center text-[12px] text-fg-2">
        No bug reports generated for this session.
      </div>
    );
  }

  return (
    <div className="card divide-y-0.5 divide-border-0">
      {bugs.map((bug) => (
        <BugCard
          key={bug.id}
          bug={bug}
          sessionId={sessionId}
          context="session-detail"
          onReview={(status) => changeReview(bug.id, status, bug.review_status)}
          onSavedRecategorize={() => {
            queryClient.invalidateQueries({ queryKey: ['artifacts', sessionId] });
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
  );
}

function ArtifactsList({
  sessionId, type,
}: { sessionId: string; type: ArtifactType }) {
  const { data: artifacts, isLoading } = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => getArtifacts(sessionId),
  });
  const filtered = artifacts?.filter((a) => a.artifact_type === type) || [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card h-20 animate-pulse" />
        ))}
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <div className="card px-3.5 py-7 text-center text-[12px] text-fg-2">
        No {type.replace('_', ' ')}s generated for this session.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filtered.map((a) => (
        <ArtifactCard key={a.id} sessionId={sessionId} artifact={a} />
      ))}
    </div>
  );
}

function severityVariant(
  value: string | undefined,
): { bg: string; fg: string; border: string } | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === 'high' || v === 'critical')
    return { bg: 'rgba(248,113,113,0.12)', fg: '#f87171', border: 'rgba(248,113,113,0.25)' };
  if (v === 'medium')
    return { bg: 'rgba(251,191,36,0.12)', fg: '#fbbf24', border: 'rgba(251,191,36,0.25)' };
  return { bg: '#1f1f25', fg: '#a8a8b3', border: '#2a2a32' };
}

function ArtifactCard({
  sessionId, artifact,
}: { sessionId: string; artifact: Artifact }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(artifact.content, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (content: Record<string, unknown>) =>
      updateArtifact(sessionId, artifact.id, content),
    onSuccess: () => {
      toast.push('Saved', 'success');
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ['artifacts', sessionId] });
    },
    onError: () => toast.push('Could not save', 'error'),
  });

  const remove = useMutation({
    mutationFn: () => deleteArtifact(sessionId, artifact.id),
    onSuccess: () => {
      toast.push('Deleted', 'info');
      queryClient.invalidateQueries({ queryKey: ['artifacts', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });

  const title =
    (artifact.content.title as string) ||
    (artifact.content.untested_flow as string) ||
    'Untitled';
  const description =
    (artifact.content.description as string) ||
    (artifact.content.summary as string) ||
    '';
  const severity = artifact.content.severity as string | undefined;
  const priority = artifact.content.priority as string | undefined;
  const outcome = artifact.content.outcome as string | undefined;
  const testType = artifact.content.test_type as string | undefined;

  const accent = ARTIFACT_BORDER[artifact.artifact_type];
  const sev = severityVariant(severity);

  function trySave() {
    try {
      const parsed = JSON.parse(draft);
      setJsonError(null);
      update.mutate(parsed);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      className="rounded-[6px] border-0.5 border-border-0 bg-bg-1 px-3.5 py-3"
      style={{ borderLeft: `2px solid ${accent}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg-0">{title}</div>
          {description && (
            <div className="mt-1 text-[11px] leading-[1.5] text-fg-1">{description}</div>
          )}
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {!editing && !confirmDelete && (
            <>
              <IconButton onClick={() => setEditing(true)} label="Edit">
                ✎
              </IconButton>
              <IconButton onClick={() => setConfirmDelete(true)} label="Delete">
                ✕
              </IconButton>
            </>
          )}
          {confirmDelete && (
            <>
              <span className="text-[11px] text-fg-1">Delete?</span>
              <button
                onClick={() => remove.mutate()}
                className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: '#f87171', color: '#08080b' }}
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-md px-2 py-0.5 text-[11px] text-fg-1 hover:bg-bg-2"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {(sev || priority || outcome || testType || artifact.user_edited) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {sev && (
            <Pill bg={sev.bg} fg={sev.fg} border={sev.border}>
              severity: {severity}
            </Pill>
          )}
          {priority && <Pill>priority: {priority}</Pill>}
          {outcome && <Pill>{outcome}</Pill>}
          {testType && <Pill>{testType}</Pill>}
          {artifact.user_edited && <Pill>edited</Pill>}
        </div>
      )}

      {editing ? (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={{ fontFamily: 'var(--font-mono)' }}
            className="block w-full rounded-md border-0.5 border-border-0 bg-bg-0 p-3 text-[11.5px] text-fg-0 focus:border-accent-green focus:outline-none focus:ring-2 focus:ring-accent-green/30"
            rows={Math.min(20, draft.split('\n').length + 2)}
          />
          {jsonError && (
            <div
              className="mt-2 rounded-md border-0.5 px-3 py-2 text-[11px]"
              style={{
                backgroundColor: 'rgba(248,113,113,0.08)',
                borderColor: 'rgba(248,113,113,0.25)',
                color: '#f87171',
              }}
            >
              JSON error: {jsonError}
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => {
                setEditing(false);
                setDraft(JSON.stringify(artifact.content, null, 2));
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              onClick={trySave}
              disabled={update.isPending}
              className="btn-primary"
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2 hover:text-fg-1">
            JSON
          </summary>
          <pre
            style={{ fontFamily: 'var(--font-mono)' }}
            className="mt-2 overflow-x-auto rounded-md border-0.5 border-border-0 bg-bg-0 p-2.5 text-[10.5px] leading-[1.5] text-fg-1"
          >
            {JSON.stringify(artifact.content, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function Pill({
  children, bg, fg, border,
}: {
  children: ReactNode;
  bg?: string;
  fg?: string;
  border?: string;
}) {
  return (
    <span
      className="inline-flex items-center rounded-full px-[7px] py-[2px] text-[10px] font-medium"
      style={{
        backgroundColor: bg || '#1f1f25',
        color: fg || '#a8a8b3',
        border: `1px solid ${border || '#2a2a32'}`,
      }}
    >
      {children}
    </span>
  );
}

function IconButton({
  onClick, label, children,
}: {
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded text-[12px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg-0"
    >
      {children}
    </button>
  );
}

function TranscriptTab({ sessionId }: { sessionId: string }) {
  const { data: workflow } = useQuery({
    queryKey: ['workflow', sessionId],
    queryFn: () => getWorkflow(sessionId),
  });
  const segments = workflow?.steps.filter((s) => s.kind === 'voice_annotation') || [];

  if (segments.length === 0) {
    return (
      <div className="card px-3.5 py-7 text-center text-[12px] text-fg-2">
        No voice transcript for this session.
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border-0.5 border-border-0 bg-bg-1 p-3.5"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <div className="text-[12px] leading-[1.7]">
        {segments.map((s) => (
          <div key={s.step_number}>
            <span className="tabular-nums text-fg-2">
              [{formatTimestamp(s.timestamp_seconds)}]
            </span>{' '}
            <span className="text-fg-1">{s.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
