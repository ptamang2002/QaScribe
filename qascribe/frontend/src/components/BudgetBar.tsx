import { useQuery } from '@tanstack/react-query';
import { getBudgetStatus } from '../api/client';

export function BudgetBar() {
  const { data } = useQuery({
    queryKey: ['budget'],
    queryFn: getBudgetStatus,
    refetchInterval: 30000,
  });

  if (!data) {
    return (
      <div className="rounded-md border-0.5 border-border-0 p-3">
        <div className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
          Budget
        </div>
        <div className="mt-1 text-xs text-fg-2">Loading…</div>
      </div>
    );
  }

  const pct = (data.month_to_date_spend_usd / data.monthly_budget_usd) * 100;
  const fillClass =
    pct > 90
      ? 'bg-status-bad shadow-glow-bad'
      : pct > 75
        ? 'bg-status-warn shadow-glow-warn'
        : 'bg-gradient-to-r from-accent-green to-accent-cyan';

  return (
    <div className="rounded-md border-0.5 border-border-0 p-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
        Monthly budget
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-sm font-medium tabular-nums text-fg-0">
          ${data.month_to_date_spend_usd.toFixed(2)}
        </span>
        <span className="text-xs tabular-nums text-fg-2">
          / ${data.monthly_budget_usd.toFixed(2)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-2">
        <div
          className={`h-full rounded-full transition-all ${fillClass}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="mt-1 text-[11px] tabular-nums text-fg-2">
        ${data.remaining_usd.toFixed(2)} remaining
      </div>
    </div>
  );
}
