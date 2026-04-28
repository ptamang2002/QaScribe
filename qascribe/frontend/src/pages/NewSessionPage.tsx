import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  createSession, estimateSession, getBudgetStatus, getModelConfig,
} from '../api/client';
import type { CostEstimate, RecordingSettings } from '../types';
import { useScreenRecorder } from '../hooks/useScreenRecorder';
import { detectBrowserSupport } from '../hooks/useBrowserSupport';
import { RecordingBar } from '../components/RecordingBar';
import { useToast } from '../components/Toast';

type Mode = 'upload' | 'record';

const DEFAULT_SETTINGS: RecordingSettings = {
  resolution: '1080p',
  frameRate: 30,
  audioBitrate: 128,
  preferMp4: true,
};

export function NewSessionPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('upload');
  const [title, setTitle] = useState(`Session ${new Date().toLocaleString()}`);
  const [testFocus, setTestFocus] = useState('exploratory');
  const [file, setFile] = useState<File | null>(null);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  const { data: budget } = useQuery({ queryKey: ['budget'], queryFn: getBudgetStatus });
  const { data: modelConfig } = useQuery({ queryKey: ['models'], queryFn: getModelConfig });

  const submit = useMutation({
    mutationFn: async (input: { file: File | Blob; filename: string }) =>
      createSession(title, testFocus, input.file, input.filename),
    onSuccess: (data) => {
      toast.push('Session created — processing started', 'success');
      navigate(`/sessions/${data.session_id}`);
    },
    onError: (err: any) => {
      toast.push(err?.response?.data?.detail || err.message || 'Upload failed', 'error');
    },
  });

  async function handleFileSelect(f: File) {
    setFile(f);
    setEstimate(null);
    setEstimating(true);
    try {
      const est = await estimateSession(f);
      setEstimate(est);
    } catch (err: any) {
      toast.push(err?.response?.data?.detail || 'Could not estimate cost', 'error');
    } finally {
      setEstimating(false);
    }
  }

  function handleUploadSubmit() {
    if (!file) return;
    submit.mutate({ file, filename: file.name });
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="text-base font-medium text-fg-0">New testing session</h1>
      <p className="mt-1 text-[11.5px] text-fg-2">
        Choose how to capture your testing session.
      </p>

      <div className="mt-6 grid grid-cols-[1fr_320px] gap-6">
        <div>
          <div className="grid grid-cols-2 gap-3">
            <ModeCard
              active={mode === 'upload'}
              title="Upload existing video"
              subtitle="Drop an MP4, MOV, or WebM file you've already recorded"
              onClick={() => setMode('upload')}
            />
            <ModeCard
              active={mode === 'record'}
              title="Record now"
              subtitle="Capture screen and voice in your browser"
              onClick={() => setMode('record')}
            />
          </div>

          <div className="mt-6">
            {mode === 'upload' ? (
              <UploadPanel
                file={file}
                estimate={estimate}
                estimating={estimating}
                onFile={handleFileSelect}
                onSubmit={handleUploadSubmit}
                submitting={submit.isPending}
              />
            ) : (
              <RecordPanel
                onRecordingReady={(blob, filename) =>
                  submit.mutate({ file: blob, filename })
                }
                submitting={submit.isPending}
              />
            )}
          </div>
        </div>

        <aside className="space-y-3">
          <div className="card px-4 py-3.5">
            <h2 className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
              Session details
            </h2>
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-fg-1">Title</label>
                <input
                  className="input mt-1"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-1">Test focus</label>
                <select
                  className="input mt-1"
                  value={testFocus}
                  onChange={(e) => setTestFocus(e.target.value)}
                >
                  <option value="exploratory">Exploratory</option>
                  <option value="regression">Regression</option>
                  <option value="smoke">Smoke</option>
                  <option value="accessibility">Accessibility</option>
                </select>
              </div>
            </div>
          </div>

          <div className="card px-4 py-3.5">
            <h2 className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
              Cost preview
            </h2>
            <p className="mt-1 text-[11px] text-fg-2">
              Final estimate appears after file selection
            </p>
            <table className="mt-3 w-full text-[11.5px]">
              <tbody>
                <tr>
                  <td className="py-1 text-fg-1">Gemini (video)</td>
                  <td className="py-1 text-right tabular-nums text-fg-0">
                    {modelConfig
                      ? `$${modelConfig.gemini_input_price_per_m.toFixed(2)}/M in`
                      : '—'}
                  </td>
                </tr>
                <tr>
                  <td className="py-1 text-fg-1">Whisper (voice)</td>
                  <td className="py-1 text-right tabular-nums text-fg-0">
                    {modelConfig
                      ? `$${modelConfig.stt_price_per_minute.toFixed(3)}/min`
                      : '—'}
                  </td>
                </tr>
                <tr>
                  <td className="py-1 text-fg-1">Claude (synthesis)</td>
                  <td className="py-1 text-right tabular-nums text-fg-0">
                    {modelConfig
                      ? `$${modelConfig.claude_input_price_per_m.toFixed(2)}/M in`
                      : '—'}
                  </td>
                </tr>
                {estimate && (
                  <tr className="border-t-0.5 border-border-0">
                    <td className="pt-2 font-medium text-fg-0">Estimated total</td>
                    <td className="pt-2 text-right font-medium tabular-nums text-fg-0">
                      ${estimate.estimated_cost_with_safety_margin_usd.toFixed(3)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="mt-3 border-t-0.5 border-border-0 pt-2.5 text-[11px] text-fg-1">
              Cap per session:{' '}
              <span className="font-medium tabular-nums text-fg-0">
                ${modelConfig?.per_job_max_usd.toFixed(2) ?? '—'}
              </span>
              <br />
              Monthly remaining:{' '}
              <span className="font-medium tabular-nums text-fg-0">
                ${budget?.remaining_usd.toFixed(2) ?? '—'}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ModeCard({
  active, title, subtitle, onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border-0.5 px-4 py-3.5 text-left transition-[transform,border-color,background-color] duration-200 hover:-translate-y-px ${
        active ? 'border-accent-green' : 'border-border-0 bg-bg-1 hover:border-border-1'
      }`}
      style={
        active
          ? { backgroundColor: 'rgba(74,222,128,0.05)' }
          : undefined
      }
    >
      <div className="text-[13px] font-medium text-fg-0">{title}</div>
      <div className="mt-1 text-[11.5px] text-fg-2">{subtitle}</div>
    </button>
  );
}

function UploadPanel({
  file, estimate, estimating, onFile, onSubmit, submitting,
}: {
  file: File | null;
  estimate: CostEstimate | null;
  estimating: boolean;
  onFile: (f: File) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center transition-colors ${
          dragOver
            ? 'border-accent-green bg-bg-2'
            : 'border-border-1 bg-bg-1 hover:border-fg-2'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
        <div className="text-[13px] font-medium text-fg-0">
          {file ? file.name : 'Drop video here, or click to browse'}
        </div>
        <div className="mt-1 text-[11.5px] text-fg-2">
          MP4, MOV, WebM up to 500 MB
        </div>
      </div>

      {estimating && (
        <div className="mt-4 rounded-md border-0.5 border-border-0 bg-bg-1 px-3 py-2 text-[12px] text-fg-1">
          Probing video and estimating cost…
        </div>
      )}
      {estimate && (
        <div className="mt-4 rounded-lg border-0.5 border-border-0 bg-bg-1 px-3.5 py-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
            Pre-flight estimate
          </div>
          <div className="mt-2 grid grid-cols-3 gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.5px] text-fg-2">Duration</div>
              <div className="mt-0.5 text-[15px] font-medium tabular-nums text-fg-0">
                {Math.round(estimate.duration_seconds)}s
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.5px] text-fg-2">Voice track</div>
              <div className="mt-0.5 text-[15px] font-medium text-fg-0">
                {estimate.has_voice_track ? 'Yes' : 'No'}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.5px] text-fg-2">Estimated cost</div>
              <div className="mt-0.5 text-[15px] font-medium tabular-nums text-fg-0">
                ${estimate.estimated_cost_with_safety_margin_usd.toFixed(3)}
              </div>
            </div>
          </div>
          {estimate.would_exceed_per_job_cap && (
            <div
              className="mt-3 rounded-md border-0.5 px-3 py-2 text-[11px]"
              style={{
                backgroundColor: 'rgba(248,113,113,0.08)',
                borderColor: 'rgba(248,113,113,0.25)',
                color: '#f87171',
              }}
            >
              This video would exceed your per-session budget cap.
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <button
              onClick={onSubmit}
              disabled={submitting || estimate.would_exceed_per_job_cap}
              className="btn-primary"
            >
              {submitting ? 'Uploading…' : 'Process this session'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecordPanel({
  onRecordingReady, submitting,
}: {
  onRecordingReady: (blob: Blob, filename: string) => void;
  submitting: boolean;
}) {
  const toast = useToast();
  const support = useMemo(detectBrowserSupport, []);
  const [url, setUrl] = useState('https://');
  const [micDeviceId, setMicDeviceId] = useState<string>('');
  const [captureSystemAudio, setCaptureSystemAudio] = useState(true);
  const [settings, setSettings] = useState<RecordingSettings>(DEFAULT_SETTINGS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recorder = useScreenRecorder({
    micDeviceId: micDeviceId || undefined,
    captureSystemAudio,
    maxDurationSeconds: 3570,
    warnAtSeconds: 3300,
    settings,
    onWarning: (msg) => toast.push(msg, 'warning'),
    onAutoStop: () => toast.push('Recording stopped — reached 60 minute cap', 'warning'),
  });

  useEffect(() => {
    if (recorder.result) {
      setPreviewUrl(URL.createObjectURL(recorder.result.blob));
    }
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.result]);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((devices) => {
      setMicDevices(devices.filter((d) => d.kind === 'audioinput'));
    }).catch(() => undefined);
  }, []);

  if (!support.fullySupported) {
    return (
      <div className="card px-4 py-3.5">
        <div className="text-[13px] font-medium text-fg-0">
          {support.isSafari ? 'Limited support in Safari' : 'Browser not supported'}
        </div>
        <p className="mt-1 text-[11.5px] text-fg-1">
          {support.isSafari
            ? 'Safari supports microphone-only recording. For full screen + tab audio capture, use Chrome or Edge.'
            : 'Your browser does not support screen recording. Use Chrome, Edge, or Firefox.'}
        </p>
      </div>
    );
  }

  if (recorder.state === 'recording') {
    return (
      <RecordingBar
        elapsedSeconds={recorder.elapsedSeconds}
        onStop={recorder.stop}
        onCancel={() => recorder.reset()}
        warningMessage={recorder.warningMessage}
      />
    );
  }

  if (recorder.state === 'stopped' && recorder.result && previewUrl) {
    const fileName = `recording-${Date.now()}.${
      recorder.result.mimeType.includes('mp4') ? 'mp4' : 'webm'
    }`;
    return (
      <div className="card px-4 py-3.5">
        <div className="text-[13px] font-medium text-fg-0">Recording complete</div>
        <div className="mt-1 text-[11px] tabular-nums text-fg-2">
          {Math.round(recorder.result.durationSeconds)}s ·{' '}
          {(recorder.result.blob.size / (1024 * 1024)).toFixed(1)} MB ·{' '}
          {recorder.result.mimeType}
        </div>
        <video
          src={previewUrl}
          controls
          className="mt-3 w-full rounded-md border-0.5 border-border-0"
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => onRecordingReady(recorder.result!.blob, fileName)}
            disabled={submitting}
            className="btn-primary"
          >
            {submitting ? 'Uploading…' : 'Use this recording'}
          </button>
          <button onClick={recorder.reset} className="btn-secondary">
            Discard, try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="card px-4 py-3.5">
        <h3 className="text-[13px] font-medium text-fg-0">URL to test</h3>
        <p className="mt-0.5 text-[11.5px] text-fg-2">
          Open the URL in a new tab, then choose that tab when starting the recording.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            className="input flex-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
          />
          <button
            onClick={() => {
              try {
                const u = new URL(url);
                window.open(u.toString(), '_blank', 'noopener');
              } catch {
                toast.push('Enter a valid URL with http:// or https://', 'warning');
              }
            }}
            className="btn-secondary"
          >
            Open in tab ↗
          </button>
        </div>
      </div>

      <div className="card px-4 py-3.5">
        <h3 className="text-[13px] font-medium text-fg-0">Audio inputs</h3>
        <div className="mt-3 space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-fg-1">Microphone</label>
            <select
              className="input mt-1"
              value={micDeviceId}
              onChange={(e) => setMicDeviceId(e.target.value)}
            >
              <option value="">Default microphone</option>
              {micDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
            {micDevices.some((d) => !d.label) && (
              <p className="mt-1 text-[11px] text-fg-2">
                Allow microphone access once to see device names.
              </p>
            )}
          </div>
          <label className="flex items-start gap-2 text-[12.5px] text-fg-1">
            <input
              type="checkbox"
              checked={captureSystemAudio}
              onChange={(e) => setCaptureSystemAudio(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Capture page audio (recorded as a separate track)
              <span className="block text-[11px] text-fg-2">
                When the share dialog appears, tick "Share tab audio" too.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="card px-4 py-3.5">
        <button
          onClick={() => setShowAdvanced((s) => !s)}
          className="flex w-full items-center justify-between text-[13px] font-medium text-fg-0"
        >
          <span>Recording quality (advanced)</span>
          <span className="text-[11px] text-fg-2">{showAdvanced ? 'Hide' : 'Show'}</span>
        </button>
        {showAdvanced && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-fg-1">Resolution</label>
              <select
                className="input mt-1"
                value={settings.resolution}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    resolution: e.target.value as RecordingSettings['resolution'],
                  }))
                }
              >
                <option value="1080p">1080p (recommended)</option>
                <option value="720p">720p (low bandwidth)</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-1">Frame rate</label>
              <select
                className="input mt-1"
                value={settings.frameRate}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    frameRate: parseInt(e.target.value) as RecordingSettings['frameRate'],
                  }))
                }
              >
                <option value={30}>30 fps (recommended)</option>
                <option value={15}>15 fps (small file)</option>
                <option value={60}>60 fps (motion-heavy)</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-1">Audio bitrate</label>
              <select
                className="input mt-1"
                value={settings.audioBitrate}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    audioBitrate: parseInt(e.target.value) as RecordingSettings['audioBitrate'],
                  }))
                }
              >
                <option value={128}>128 kbps stereo</option>
                <option value={64}>64 kbps mono (voice)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {recorder.errorMessage && (
        <div
          className="rounded-md border-0.5 px-3 py-2 text-[11.5px]"
          style={{
            backgroundColor: 'rgba(248,113,113,0.08)',
            borderColor: 'rgba(248,113,113,0.25)',
            color: '#f87171',
          }}
        >
          {recorder.errorMessage}
        </div>
      )}

      <button
        onClick={recorder.start}
        disabled={recorder.state === 'requesting_permissions'}
        className="btn-primary"
      >
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: '#f87171' }}
        />
        {recorder.state === 'requesting_permissions'
          ? 'Requesting access…'
          : 'Start recording'}
      </button>
    </div>
  );
}
