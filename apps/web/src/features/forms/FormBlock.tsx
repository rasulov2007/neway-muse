import type { ReactNode } from 'react';
import { cn } from '@/design-system';

/**
 * One group of fields inside a creation dialog.
 *
 * This is the Add Load layout, extracted so every "Add …" dialog reads the same way: a quiet
 * heading, then a two-column grid of labelled controls. No card, no left-hand description column —
 * a dialog is already a box, and putting a box inside it just eats the width the fields need.
 */
export function FormBlock({
  title,
  hint,
  children,
  className,
}: {
  title?: string;
  /** One short line under the heading. Anything longer belongs on the field itself. */
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      {title ? (
        <header>
          <h3 className="text-md font-bold text-ink">{title}</h3>
          {hint ? <p className="text-xs text-muted">{hint}</p> : null}
        </header>
      ) : null}
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

/** A field that should take the full width of the grid above. */
export function FormBlockWide({ children }: { children: ReactNode }) {
  return <div className="sm:col-span-2">{children}</div>;
}
