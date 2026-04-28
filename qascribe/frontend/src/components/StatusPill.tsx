import type { SessionStatus } from '../types';

type Variant = {
  label: string;
  color: string;
  pulse?: boolean;
};

const VARIANTS: Record<SessionStatus, Variant> = {
  completed: { label: 'Done', color: '#4ade80' },
  processing: { label: 'Running', color: '#fbbf24', pulse: true },
  queued: { label: 'Queued', color: '#a78bfa' },
  failed: { label: 'Failed', color: '#f87171' },
  rejected_budget: { label: 'Over budget', color: '#f87171' },
};

export function StatusPill({ status }: { status: SessionStatus }) {
  const v = VARIANTS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium tabular-nums"
      style={{
        backgroundColor: `${v.color}14`,
        borderColor: `${v.color}33`,
        color: v.color,
      }}
    >
      <span
        className={`block h-[5px] w-[5px] rounded-full ${v.pulse ? 'pulse-dot' : ''}`}
        style={{
          backgroundColor: v.color,
          boxShadow: `0 0 6px ${v.color}`,
        }}
      />
      {v.label}
    </span>
  );
}
