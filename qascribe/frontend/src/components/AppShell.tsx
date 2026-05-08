import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { getArtifactStats } from '../api/client';

export function AppShell() {
  const { data: stats } = useQuery({
    queryKey: ['artifacts', 'stats'],
    queryFn: getArtifactStats,
    staleTime: 60_000,
  });
  const highSeverityCount = stats?.open_high_severity_count ?? 0;
  const testCaseCount = stats?.total_test_cases ?? 0;
  const coverageCount = stats?.total_coverage_gaps ?? 0;

  return (
    <div className="flex min-h-screen bg-bg-0">
      <aside className="flex w-56 flex-col border-r-0.5 border-border-0 bg-bg-1 px-3 py-4">
        <Link to="/" className="mb-6 flex items-center gap-2 px-2">
          <img src="/logo.svg" alt="QAScribe logo" width={22} height={22} />
          <span className="text-base font-medium text-fg-0">QAScribe</span>
        </Link>
        <nav className="flex flex-col gap-0.5 text-sm">
          <SideNavLink to="/" label="Dashboard" />
          <SideNavLink to="/sessions" label="Sessions" />
          <SideNavLink
            to="/bugs"
            label="Bug reports"
            trailing={
              highSeverityCount > 0 ? <RedBadge n={highSeverityCount} /> : null
            }
          />
          <SideNavLink
            to="/coverage"
            label="Coverage"
            trailing={coverageCount > 0 ? <NeutralBadge n={coverageCount} /> : null}
          />
          <SideNavLink
            to="/test-case-reports"
            label="Test case reports"
            trailing={testCaseCount > 0 ? <NeutralBadge n={testCaseCount} /> : null}
          />
          <SideNavLink to="/settings" label="Settings" />
        </nav>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

function SideNavLink({
  to, label, trailing,
}: {
  to: string;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `relative flex items-center justify-between rounded-md px-2 py-1.5 transition-colors ${
          isActive
            ? 'bg-bg-2 font-medium text-fg-0 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-gradient-to-b before:from-accent-green before:to-accent-cyan before:shadow-glow-accent before:content-[""]'
            : 'text-fg-1 hover:bg-bg-2 hover:text-fg-0'
        }`
      }
    >
      <span>{label}</span>
      {trailing}
    </NavLink>
  );
}

function RedBadge({ n }: { n: number }) {
  return (
    <span
      className="inline-flex min-w-[16px] items-center justify-center rounded-full px-[5px] text-[10px] font-medium tabular-nums"
      style={{
        backgroundColor: 'rgba(248,113,113,0.12)',
        color: '#f87171',
        border: '0.5px solid rgba(248,113,113,0.35)',
        lineHeight: '14px',
      }}
    >
      {n}
    </span>
  );
}

function NeutralBadge({ n }: { n: number }) {
  return (
    <span
      className="inline-flex min-w-[16px] items-center justify-center rounded-full px-[5px] text-[10px] font-medium tabular-nums"
      style={{
        backgroundColor: '#1f1f25',
        color: '#a8a8b3',
        lineHeight: '14px',
      }}
    >
      {n}
    </span>
  );
}
