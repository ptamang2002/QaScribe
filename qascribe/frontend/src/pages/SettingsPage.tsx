import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMe, getModelConfig, updateMyBudget } from '../api/client';
import type { RecordingSettings } from '../types';
import { useToast } from '../components/Toast';

const RECORDING_SETTINGS_KEY = 'qascribe.recordingSettings';

const DEFAULT_RECORDING: RecordingSettings = {
  resolution: '1080p',
  frameRate: 30,
  audioBitrate: 128,
  preferMp4: true,
};

function loadRecordingSettings(): RecordingSettings {
  try {
    const raw = localStorage.getItem(RECORDING_SETTINGS_KEY);
    if (!raw) return DEFAULT_RECORDING;
    return { ...DEFAULT_RECORDING, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_RECORDING;
  }
}

export function SettingsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: getModelConfig });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: getMe });
  const [budget, setBudget] = useState<number>(50);
  const [recording, setRecording] = useState<RecordingSettings>(loadRecordingSettings);

  useEffect(() => {
    if (me) setBudget(me.monthly_budget_usd);
  }, [me]);

  useEffect(() => {
    localStorage.setItem(RECORDING_SETTINGS_KEY, JSON.stringify(recording));
  }, [recording]);

  const saveBudget = useMutation({
    mutationFn: () => updateMyBudget(budget),
    onSuccess: () => {
      toast.push('Budget updated', 'success');
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: () => toast.push('Could not update budget', 'error'),
  });

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h1 className="text-base font-medium text-fg-0">Settings</h1>

      <Section
        title="Models in use"
        subtitle="To swap models, edit backend/.env (DEV_TIER vs PROD_TIER blocks) and restart uvicorn + celery."
      >
        <table className="w-full">
          <tbody>
            <ModelRow label="Video perception" value={models?.gemini_model} />
            <ModelRow label="Voice transcription" value={models?.stt_model} />
            <ModelRow label="Artifact synthesis" value={models?.claude_model} />
          </tbody>
        </table>
      </Section>

      <Section
        title="Pricing"
        subtitle="Current cost per million tokens (or per minute for STT)."
      >
        <table className="w-full">
          <tbody>
            <PriceRow
              label="Gemini input"
              value={models ? `$${models.gemini_input_price_per_m.toFixed(2)}/M tokens` : '—'}
            />
            <PriceRow
              label="Gemini output"
              value={models ? `$${models.gemini_output_price_per_m.toFixed(2)}/M tokens` : '—'}
            />
            <PriceRow
              label="Whisper STT"
              value={models ? `$${models.stt_price_per_minute.toFixed(3)}/minute` : '—'}
            />
            <PriceRow
              label="Claude input"
              value={models ? `$${models.claude_input_price_per_m.toFixed(2)}/M tokens` : '—'}
            />
            <PriceRow
              label="Claude output"
              value={models ? `$${models.claude_output_price_per_m.toFixed(2)}/M tokens` : '—'}
            />
          </tbody>
        </table>
      </Section>

      <Section
        title="Budget controls"
        subtitle="Per-job and platform-wide caps are set in backend/.env."
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-medium text-fg-1">
              Your monthly budget (USD)
            </label>
            <div className="mt-1 flex gap-2">
              <input
                type="number"
                min="1"
                max="10000"
                step="1"
                value={budget}
                onChange={(e) => setBudget(parseFloat(e.target.value) || 0)}
                className="input max-w-xs"
              />
              <button
                onClick={() => saveBudget.mutate()}
                disabled={saveBudget.isPending || budget === me?.monthly_budget_usd}
                className="btn-primary"
              >
                {saveBudget.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <MiniStat
              label="Per-session cap"
              value={`$${models?.per_job_max_usd.toFixed(2) ?? '—'}`}
              accent="#4ade80"
            />
            <MiniStat
              label="Max video duration"
              value={
                models ? `${Math.round(models.max_video_duration_seconds / 60)} min` : '—'
              }
              accent="#22d3ee"
            />
          </div>
        </div>
      </Section>

      <Section
        title="Recording defaults"
        subtitle="Used when you start a new in-browser recording. Stored locally in your browser."
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-fg-1">Resolution</label>
            <select
              className="input mt-1"
              value={recording.resolution}
              onChange={(e) =>
                setRecording((r) => ({
                  ...r,
                  resolution: e.target.value as RecordingSettings['resolution'],
                }))
              }
            >
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-fg-1">Frame rate</label>
            <select
              className="input mt-1"
              value={recording.frameRate}
              onChange={(e) =>
                setRecording((r) => ({
                  ...r,
                  frameRate: parseInt(e.target.value) as RecordingSettings['frameRate'],
                }))
              }
            >
              <option value={15}>15 fps</option>
              <option value={30}>30 fps</option>
              <option value={60}>60 fps</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-fg-1">Audio bitrate</label>
            <select
              className="input mt-1"
              value={recording.audioBitrate}
              onChange={(e) =>
                setRecording((r) => ({
                  ...r,
                  audioBitrate: parseInt(e.target.value) as RecordingSettings['audioBitrate'],
                }))
              }
            >
              <option value={64}>64 kbps</option>
              <option value={128}>128 kbps</option>
            </select>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="card mt-6 px-5 py-4">
      <h2 className="text-[13px] font-medium text-fg-0">{title}</h2>
      {subtitle && <p className="mt-1 text-[11.5px] text-fg-2">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ModelRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <tr className="border-t-0.5 border-border-0 first:border-t-0">
      <td className="py-2.5 text-[12px] text-fg-1">{label}</td>
      <td className="py-2.5 text-right">
        {value ? (
          <span className="inline-flex items-center gap-2">
            <span
              className="text-[12px] tabular-nums text-fg-0"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {value}
            </span>
            <CurrentPill />
          </span>
        ) : (
          <span className="text-[12px] text-fg-2">—</span>
        )}
      </td>
    </tr>
  );
}

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-t-0.5 border-border-0 first:border-t-0">
      <td className="py-2.5 text-[12px] text-fg-1">{label}</td>
      <td
        className="py-2.5 text-right text-[12px] tabular-nums text-fg-0"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {value}
      </td>
    </tr>
  );
}

function CurrentPill() {
  return (
    <span
      className="inline-flex items-center rounded-full bg-gradient-to-r from-accent-green to-accent-cyan px-[6px] py-[1px] text-[10px] font-medium tracking-[0.5px]"
      style={{ color: '#08080b' }}
    >
      CURRENT
    </span>
  );
}

function MiniStat({
  label, value, accent,
}: { label: string; value: string; accent: string }) {
  return (
    <div className="stat-card" style={{ '--accent': accent } as CSSProperties}>
      <div className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
        {label}
      </div>
      <div className="mt-1 text-[15px] font-medium tabular-nums text-fg-0">
        {value}
      </div>
    </div>
  );
}
