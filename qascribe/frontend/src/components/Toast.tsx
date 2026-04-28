import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'warning' | 'error';
}

interface ToastContextValue {
  push: (message: string, kind?: Toast['kind']) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_ACCENT: Record<Toast['kind'], string> = {
  success: '#4ade80',
  error: '#f87171',
  warning: '#fbbf24',
  info: '#22d3ee',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="fixed right-4 top-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);
  return (
    <div
      className={`min-w-[240px] max-w-sm rounded-md border-0.5 border-border-0 bg-bg-1 px-3 py-2 text-[12.5px] text-fg-0 shadow-lg transition-all duration-200 ${
        visible ? 'translate-x-0 opacity-100' : 'translate-x-3 opacity-0'
      }`}
      style={{ borderLeft: `2px solid ${TOAST_ACCENT[toast.kind]}` }}
    >
      {toast.message}
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside ToastProvider');
  return ctx;
}
