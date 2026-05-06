import type { ReviewStatus } from '../types';

type Variant = { label: string; color: string };

export const REVIEW_VARIANTS: Record<ReviewStatus, Variant> = {
  unreviewed: { label: 'Unreviewed', color: '#fbbf24' },
  confirmed: { label: 'Confirmed', color: '#4ade80' },
  dismissed: { label: 'Dismissed', color: '#5f5f6b' },
  needs_more_info: { label: 'Needs info', color: '#a78bfa' },
};

export function ReviewStatusPill({
  status,
  interactive = false,
  onClick,
}: {
  status: ReviewStatus;
  interactive?: boolean;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const v = REVIEW_VARIANTS[status];
  const baseClasses =
    'inline-flex items-center gap-1.5 rounded-full border-0.5 px-2 py-[2px] text-[10.5px] font-medium tabular-nums';
  const style = {
    backgroundColor: `${v.color}1f`,
    borderColor: `${v.color}55`,
    color: v.color,
  };

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`Change review status (currently ${v.label})`}
        className={`${baseClasses} cursor-pointer transition-opacity hover:opacity-80`}
        style={style}
      >
        <span
          className="block h-[5px] w-[5px] rounded-full"
          style={{ backgroundColor: v.color }}
        />
        {v.label}
        <span className="text-[9px] opacity-70">▾</span>
      </button>
    );
  }

  return (
    <span className={baseClasses} style={style}>
      <span
        className="block h-[5px] w-[5px] rounded-full"
        style={{ backgroundColor: v.color }}
      />
      {v.label}
    </span>
  );
}
