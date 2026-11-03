import type { ReactNode } from 'react';
import { cn } from '@/design-system';

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  /** Native tooltip (e.g. the reasons a value is "—"). */
  title?: string;
  onClick?: () => void;
  className?: string;
}

/** Smaller sibling of KpiCard for secondary numbers inside a widget (no delta, no border). */
export function StatTile({ label, value, hint, title, onClick, className }: StatTileProps) {
  const body = (
    <>
      <div className="eyebrow truncate">{label}</div>
      <div className="tabular mt-1 text-lg font-semibold text-ink">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </>
  );
  const base = 'min-w-0 rounded-md border border-line-soft bg-surface px-3 py-2.5';
  if (onClick) {
    return (
      <button
        type="button"
        title={title}
        onClick={onClick}
        className={cn(
          base,
          'text-left transition-colors duration-(--duration-base) hover:bg-surface-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          className,
        )}
      >
        {body}
      </button>
    );
  }
  return (
    <div title={title} className={cn(base, className)}>
      {body}
    </div>
  );
}
