import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../Button';

export interface BulkActionBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Number of selected rows. */
  count: number;
  onClear: () => void;
  /** Actions rendered on the right (Buttons, menus). */
  children?: ReactNode;
  /** Noun for the count text: "3 loads selected". Defaults to "selected". */
  noun?: string;
}

/** Replaces a table toolbar while rows are selected: "3 selected · Clear" plus bulk actions. */
export function BulkActionBar({
  count,
  onClear,
  children,
  noun,
  className,
  ...rest
}: BulkActionBarProps) {
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className={cn(
        'flex min-h-12 flex-wrap items-center gap-2 border-b border-nw-border bg-nw-accent-tint px-3 py-2',
        className,
      )}
      {...rest}
    >
      <span aria-live="polite" className="tabular text-sm font-semibold text-nw-accent-ink">
        {count.toLocaleString('en-US')} {noun ? `${noun} ` : ''}selected
      </span>
      <span aria-hidden className="text-nw-accent-ink">
        ·
      </span>
      <Button variant="link" size="sm" onClick={onClear}>
        Clear
      </Button>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  );
}
