import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  exportArtifacts, getExportCount, triggerBlobDownload,
  type ExportArtifactType, type ExportFilters, type ExportFormat,
  type ValidationType,
} from '../api/client';
import type { Priority, ReviewStatus, Severity } from '../types';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'] as const;
const PRIORITIES: readonly Priority[] = ['P1', 'P2', 'P3', 'P4'] as const;
const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'unreviewed', 'confirmed', 'dismissed', 'needs_more_info',
] as const;
const VALIDATION_TYPES: readonly ValidationType[] = [
  'application', 'browser-native', 'server-side',
] as const;

const TYPE_LABEL: Record<ExportArtifactType, string> = {
  bugs: 'bug reports',
  test_cases: 'test cases',
  coverage_gaps: 'coverage gaps',
};

const REVIEW_LABEL: Record<ReviewStatus, string> = {
  unreviewed: 'Unreviewed',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
  needs_more_info: 'Needs info',
};

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  artifactType: ExportArtifactType;
  initialFilters?: ExportFilters;
}

export function ExportModal({
  open, onClose, artifactType, initialFilters,
}: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [filters, setFilters] = useState<ExportFilters>(initialFilters ?? {});
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state every time the modal is reopened so it reflects the URL
  // filters at the moment of clicking Export.
  useEffect(() => {
    if (open) {
      setFilters(initialFilters ?? {});
      setFormat('csv');
      setError(null);
      setDownloading(false);
    }
  }, [open, initialFilters]);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const countQuery = useQuery({
    queryKey: ['export-count', artifactType, filters],
    queryFn: () => getExportCount(artifactType, filters),
    enabled: open,
    staleTime: 5_000,
  });

  if (!open) return null;

  function patch(partial: Partial<ExportFilters>) {
    setFilters((prev) => ({ ...prev, ...partial }));
  }
  function toggleArrayFilter<T extends string>(
    key: keyof ExportFilters,
    value: T,
    current: readonly T[] | undefined,
  ) {
    const list = (current ?? []) as T[];
    const next = list.includes(value)
      ? list.filter((x) => x !== value)
      : [...list, value];
    patch({ [key]: next.length ? next : undefined } as Partial<ExportFilters>);
  }

  async function handleDownload() {
    setError(null);
    setDownloading(true);
    try {
      const { blob, filename } = await exportArtifacts(
        artifactType, format, filters,
      );
      triggerBlobDownload(blob, filename);
      onClose();
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Export failed. Please try again.';
      setError(message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Export ${TYPE_LABEL[artifactType]}`}
      onClick={onClose}
      style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
    >
      <div
        className="card w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4">
          <h2 className="text-sm font-medium text-fg-0">
            Export {TYPE_LABEL[artifactType]}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-fg-2">
            Download as a structured file.
          </p>
        </header>

        <Section label="Format">
          <div className="flex flex-wrap items-center gap-2">
            <FormatRadio
              label="JSON" value="json" active={format} onSelect={setFormat}
            />
            <FormatRadio
              label="CSV" value="csv" active={format} onSelect={setFormat}
            />
            <FormatRadio
              label="Word (coming soon)" value="word"
              active={format} onSelect={() => undefined} disabled
            />
          </div>
        </Section>

        <Section label="Date range (optional)">
          <div className="flex items-center gap-2">
            <input
              type="date"
              className="input"
              style={{ flex: 1 }}
              value={filters.date_from ?? ''}
              onChange={(e) =>
                patch({ date_from: e.target.value || undefined })
              }
              aria-label="Date from"
            />
            <span className="text-[11.5px] text-fg-2">to</span>
            <input
              type="date"
              className="input"
              style={{ flex: 1 }}
              value={filters.date_to ?? ''}
              onChange={(e) =>
                patch({ date_to: e.target.value || undefined })
              }
              aria-label="Date to"
            />
          </div>
        </Section>

        {artifactType === 'bugs' && (
          <>
            <Section label="Review status">
              <PillRow>
                {REVIEW_STATUSES.map((r) => (
                  <Pill
                    key={r}
                    label={REVIEW_LABEL[r]}
                    active={(filters.review_status ?? []).includes(r)}
                    onClick={() =>
                      toggleArrayFilter(
                        'review_status', r, filters.review_status,
                      )
                    }
                  />
                ))}
              </PillRow>
            </Section>
            <Section label="Severity">
              <PillRow>
                {SEVERITIES.map((s) => (
                  <Pill
                    key={s}
                    label={s}
                    active={(filters.severity ?? []).includes(s)}
                    onClick={() =>
                      toggleArrayFilter('severity', s, filters.severity)
                    }
                  />
                ))}
              </PillRow>
            </Section>
            <Section label="Priority">
              <PillRow>
                {PRIORITIES.map((p) => (
                  <Pill
                    key={p}
                    label={p}
                    active={(filters.priority ?? []).includes(p)}
                    onClick={() =>
                      toggleArrayFilter('priority', p, filters.priority)
                    }
                  />
                ))}
              </PillRow>
            </Section>
          </>
        )}

        {artifactType === 'test_cases' && (
          <Section label="Validation type">
            <PillRow>
              {VALIDATION_TYPES.map((v) => (
                <Pill
                  key={v}
                  label={v}
                  active={(filters.validation_type ?? []).includes(v)}
                  onClick={() =>
                    toggleArrayFilter(
                      'validation_type', v, filters.validation_type,
                    )
                  }
                />
              ))}
            </PillRow>
          </Section>
        )}

        {artifactType === 'coverage_gaps' && (
          <Section label="Priority">
            <PillRow>
              {SEVERITIES.map((p) => (
                <Pill
                  key={p}
                  label={p}
                  active={((filters.priority ?? []) as Severity[]).includes(p)}
                  onClick={() =>
                    toggleArrayFilter<Severity>(
                      'priority', p,
                      (filters.priority ?? []) as Severity[],
                    )
                  }
                />
              ))}
            </PillRow>
          </Section>
        )}

        <div className="mt-4 rounded-md border-0.5 border-border-0 bg-bg-2 px-3 py-2 text-[11.5px] text-fg-1">
          {countQuery.isLoading ? (
            <span className="text-fg-2">Calculating…</span>
          ) : countQuery.isError ? (
            <span className="text-status-bad">Couldn't load preview count.</span>
          ) : (
            <>
              This will export{' '}
              <span className="tabular-nums text-fg-0">
                {countQuery.data ?? 0}
              </span>{' '}
              {TYPE_LABEL[artifactType]}.
            </>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-md border-0.5 px-3 py-2 text-[11.5px]"
               style={{
                 backgroundColor: 'rgba(248,113,113,0.1)',
                 borderColor: 'rgba(248,113,113,0.3)',
                 color: '#fca5a5',
               }}>
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost"
            disabled={downloading}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="btn-primary"
            disabled={downloading || (countQuery.data ?? 0) === 0}
          >
            {downloading ? 'Preparing…' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3.5">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
        {label}
      </div>
      {children}
    </div>
  );
}

function PillRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}

const ACTIVE_TINT = {
  bg: 'rgba(34,211,238,0.12)',
  border: 'rgba(34,211,238,0.3)',
  fg: '#22d3ee',
};

function Pill({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex items-center rounded-full border-0.5 px-2.5 py-[3px] text-[11px] font-medium capitalize transition-colors"
      style={
        active
          ? {
              backgroundColor: ACTIVE_TINT.bg,
              borderColor: ACTIVE_TINT.border,
              color: ACTIVE_TINT.fg,
            }
          : { backgroundColor: 'transparent', borderColor: '#2a2a32', color: '#a8a8b3' }
      }
    >
      {label}
    </button>
  );
}

function FormatRadio({
  label, value, active, onSelect, disabled,
}: {
  label: string;
  value: string;
  active: string;
  onSelect: (v: ExportFormat) => void;
  disabled?: boolean;
}) {
  const isActive = active === value;
  return (
    <button
      type="button"
      onClick={() => !disabled && onSelect(value as ExportFormat)}
      disabled={disabled}
      title={disabled ? 'Word export coming soon' : undefined}
      aria-pressed={isActive}
      className="inline-flex items-center gap-2 rounded-md border-0.5 px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={
        isActive
          ? {
              backgroundColor: ACTIVE_TINT.bg,
              borderColor: ACTIVE_TINT.border,
              color: ACTIVE_TINT.fg,
            }
          : { backgroundColor: 'transparent', borderColor: '#2a2a32', color: '#a8a8b3' }
      }
    >
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{
          backgroundColor: isActive ? ACTIVE_TINT.fg : 'transparent',
          border: `1px solid ${isActive ? ACTIVE_TINT.fg : '#3a3a44'}`,
        }}
      />
      {label}
    </button>
  );
}
