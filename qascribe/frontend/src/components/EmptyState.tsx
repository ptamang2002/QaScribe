import type { ReactNode } from 'react';

export function EmptyState({
  title, body, action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-3.5 py-[30px] text-center">
      <p className="text-sm font-medium text-fg-0">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[12.5px] text-fg-2">{body}</p>
      {action && <div className="mt-4 inline-flex">{action}</div>}
    </div>
  );
}
