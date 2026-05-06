import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { updateArtifact } from '../api/client';
import { REVIEW_VARIANTS, ReviewStatusPill } from './ReviewStatusPill';
import type { Priority, ReviewStatus, Severity } from '../types';

// ---- Shared constants & helpers ----

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'] as const;
export const PRIORITIES: readonly Priority[] = ['P1', 'P2', 'P3', 'P4'] as const;

export type Tint = { bg: string; fg: string; border: string };

export const SEVERITY_TINT: Record<Severity, Tint> = {
  critical: { bg: 'rgba(248,113,113,0.18)', fg: '#fca5a5', border: 'rgba(248,113,113,0.4)' },
  high: { bg: 'rgba(248,113,113,0.12)', fg: '#f87171', border: 'rgba(248,113,113,0.25)' },
  medium: { bg: 'rgba(251,191,36,0.12)', fg: '#fbbf24', border: 'rgba(251,191,36,0.25)' },
  low: { bg: '#1f1f25', fg: '#a8a8b3', border: '#2a2a32' },
};

export const PRIORITY_TINT: Record<Priority, Tint> = {
  P1: { bg: 'rgba(248,113,113,0.12)', fg: '#f87171', border: 'rgba(248,113,113,0.25)' },
  P2: { bg: 'rgba(251,191,36,0.12)', fg: '#fbbf24', border: 'rgba(251,191,36,0.25)' },
  P3: { bg: '#1f1f25', fg: '#a8a8b3', border: '#2a2a32' },
  P4: { bg: '#16161b', fg: '#6b6b75', border: '#222228' },
};

export function formatRelativeTime(iso: string): string {
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

export function formatDuration(seconds: number): string {
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

// ---- Cells ----

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

// ---- Icons ----

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

function ReReviewPopover({
  open, current, onSelect, onClose, children,
}: {
  open: boolean;
  current: ReviewStatus;
  onSelect: (s: ReviewStatus) => void;
  onClose: () => void;
  children: ReactNode;
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

function RecategorizeForm({
  bug, sessionId, onCancel, onSaved, onError,
}: {
  bug: BugCardBug;
  sessionId: string;
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
      return updateArtifact(sessionId, bug.id, nextContent);
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

// ---- Public BugCard ----

export interface BugCardBug {
  id: string;
  content: Record<string, unknown>;
  review_status: ReviewStatus;
  created_at: string;
  user_edited: boolean;
}

export interface BugCardProps {
  bug: BugCardBug;
  sessionId: string;
  // Only rendered when context === 'bugs-page'.
  sessionTitle?: string;
  sessionDurationSeconds?: number;
  context: 'bugs-page' | 'session-detail';
  onReview: (status: ReviewStatus) => void;
  onSavedRecategorize: () => void;
  onRecategorizeError: () => void;
}

export function BugCard({
  bug, sessionId, sessionTitle, sessionDurationSeconds, context,
  onReview, onSavedRecategorize, onRecategorizeError,
}: BugCardProps) {
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
  const showSessionMeta = context === 'bugs-page';

  function viewInSession() {
    navigate(`/sessions/${sessionId}#tab=bugs`);
  }
  function viewInBugReports() {
    navigate(`/bugs?session_id=${sessionId}`);
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
          {showSessionMeta ? (
            <button
              type="button"
              onClick={viewInSession}
              className="block max-w-full truncate text-left text-[13px] font-medium text-fg-0 hover:underline"
            >
              {title}
            </button>
          ) : (
            <div className="block max-w-full truncate text-[13px] font-medium text-fg-0">
              {title}
            </div>
          )}
          {blurb && (
            <div className="mt-0.5 truncate text-[11.5px] text-fg-2">{blurb}</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-2">
            {showSessionMeta && (
              <>
                {sessionTitle && (
                  <>
                    <span className="truncate">{sessionTitle}</span>
                    <span>·</span>
                  </>
                )}
                {sessionDurationSeconds !== undefined && (
                  <>
                    <span className="tabular-nums">
                      {formatDuration(sessionDurationSeconds)}
                    </span>
                    <span>·</span>
                  </>
                )}
                <span>{formatRelativeTime(bug.created_at)}</span>
              </>
            )}
            <SeverityCell severity={sev} />
            <PriorityCell priority={pri} />
            {bug.user_edited && !showSessionMeta && (
              <span className="text-[10.5px] text-fg-2">edited</span>
            )}
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
          {showSessionMeta ? (
            <button
              type="button"
              onClick={viewInSession}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg-0"
            >
              View in session
              <Icon name="external" />
            </button>
          ) : (
            <button
              type="button"
              onClick={viewInBugReports}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg-0"
            >
              View in Bug Reports
              <Icon name="external" />
            </button>
          )}
        </div>
      )}

      {editing && (
        <RecategorizeForm
          bug={bug}
          sessionId={sessionId}
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
