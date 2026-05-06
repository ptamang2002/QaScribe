import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  action?: ToastAction;
  replaceKey?: string;
}

interface PushOptions {
  action?: ToastAction;
  // Toasts sharing a replaceKey supersede each other — only the latest renders.
  replaceKey?: string;
}

interface ToastContextValue {
  push: (message: string, kind?: Toast['kind'], options?: PushOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_ACCENT: Record<Toast['kind'], string> = {
  success: '#4ade80',
  error: '#f87171',
  warning: '#fbbf24',
  info: '#22d3ee',
};

const TOAST_TTL_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback(
    (message: string, kind: Toast['kind'] = 'info', options?: PushOptions) => {
      const id = Date.now() + Math.random();
      const replaceKey = options?.replaceKey;
      setToasts((prev) => {
        const filtered = replaceKey
          ? prev.filter((t) => t.replaceKey !== replaceKey)
          : prev;
        return [...filtered, { id, message, kind, action: options?.action, replaceKey }];
      });
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_TTL_MS);
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="fixed right-4 top-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            toast={t}
            onDismiss={() =>
              setToasts((prev) => prev.filter((x) => x.id !== t.id))
            }
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);
  return (
    <div
      className={`flex min-w-[240px] max-w-sm items-center gap-3 rounded-md border-0.5 border-border-0 bg-bg-1 px-3 py-2 text-[12.5px] text-fg-0 shadow-lg transition-all duration-200 ${
        visible ? 'translate-x-0 opacity-100' : 'translate-x-3 opacity-0'
      }`}
      style={{ borderLeft: `2px solid ${TOAST_ACCENT[toast.kind]}` }}
    >
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.onClick();
            onDismiss();
          }}
          className="shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium text-accent-cyan transition-colors hover:bg-bg-2 hover:underline"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside ToastProvider');
  return ctx;
}
