interface RecordingBarProps {
  elapsedSeconds: number;
  onStop: () => void;
  onCancel: () => void;
  warningMessage?: string | null;
}

export function RecordingBar({
  elapsedSeconds,
  onStop,
  onCancel,
  warningMessage,
}: RecordingBarProps) {
  const mins = Math.floor(elapsedSeconds / 60);
  const secs = Math.floor(elapsedSeconds % 60);
  const time = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  return (
    <div
      className="fixed left-1/2 top-4 z-50 -translate-x-1/2 transform rounded-full border-0.5 border-border-0 bg-bg-1 px-4 py-2"
      style={{ boxShadow: '0 0 14px rgba(248,113,113,0.35)' }}
    >
      <div className="flex items-center gap-3">
        <span
          className="pulse-dot block h-3 w-3 rounded-full"
          style={{ backgroundColor: '#f87171', boxShadow: '0 0 6px #f87171' }}
        />
        <span
          className="text-[13px] tabular-nums text-fg-0"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {time}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-[0.5px] text-fg-2">
          Recording
        </span>
        <div className="mx-1 h-4 w-px bg-border-0" />
        <button
          onClick={onStop}
          className="rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-shadow hover:shadow-glow-bad"
          style={{ backgroundColor: '#f87171', color: '#08080b' }}
        >
          Stop
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-[11.5px] text-fg-1 transition-colors hover:bg-bg-2 hover:text-fg-0"
        >
          Cancel
        </button>
      </div>
      {warningMessage && (
        <div
          className="mt-2 rounded-md border-0.5 px-3 py-1 text-[11px]"
          style={{
            backgroundColor: 'rgba(251,191,36,0.10)',
            borderColor: 'rgba(251,191,36,0.25)',
            color: '#fbbf24',
          }}
        >
          {warningMessage}
        </div>
      )}
    </div>
  );
}
