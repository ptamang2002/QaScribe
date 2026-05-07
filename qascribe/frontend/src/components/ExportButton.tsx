export function ExportButton({
  onClick, label = 'Export',
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border-0.5 border-border-0 bg-transparent px-3 py-1.5 text-[12px] font-medium text-fg-1 transition-colors hover:bg-bg-2 hover:text-fg-0"
    >
      <DownloadIcon />
      {label}
    </button>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v8m0 0l3-3m-3 3L5 7" />
      <path d="M2.5 12.5h11" />
    </svg>
  );
}
