import type { HTMLAttributes, ReactNode } from 'react';
import { SectionLabel, cn } from '@/design-system';

interface GallerySectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  id: string;
  /** Eyebrow, e.g. "01". */
  index: number;
  title: string;
  /** One-line usage note under the title. */
  note: string;
  children: ReactNode;
}

/** One gallery section: eyebrow + h2 + usage note, then the examples. The id is the index anchor. */
export function GallerySection({
  id,
  index,
  title,
  note,
  className,
  children,
  ...rest
}: GallerySectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn('flex scroll-mt-20 flex-col gap-5', className)}
      {...rest}
    >
      <header className="flex flex-col gap-1 border-b border-line pb-3">
        <SectionLabel>Section {String(index).padStart(2, '0')}</SectionLabel>
        <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p className="text-sm text-muted">{note}</p>
      </header>
      {children}
    </section>
  );
}

interface ExampleGridProps extends HTMLAttributes<HTMLDivElement> {
  /** Column count at lg+. Defaults to auto-fit tiles of ~280px. */
  columns?: 1 | 2 | 3 | 4;
}

const columnClasses: Record<NonNullable<ExampleGridProps['columns']>, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 lg:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
};

/** Light grid of examples. */
export function ExampleGrid({ columns, className, ...rest }: ExampleGridProps) {
  return (
    <div
      className={cn(
        'grid gap-4',
        columns ? columnClasses[columns] : 'grid-cols-[repeat(auto-fit,minmax(17rem,1fr))]',
        className,
      )}
      {...rest}
    />
  );
}

interface ExampleProps extends HTMLAttributes<HTMLDivElement> {
  /** Small muted caption: "Primary · md", "Loading", "Invalid". */
  caption: string;
  /** Let the example span the full grid width. */
  wide?: boolean;
  /** Render the children on the page background instead of a surface (for cards, tables, KPIs). */
  bare?: boolean;
  /** Align children in a row that wraps (buttons, badges). */
  row?: boolean;
  children: ReactNode;
}

/** One example tile: caption above, the component(s) below. */
export function Example({ caption, wide, bare, row, className, children, ...rest }: ExampleProps) {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2', wide && 'col-span-full', className)}
      {...rest}
    >
      <p className="text-xs text-muted">{caption}</p>
      <div
        className={cn(
          'min-w-0 flex-1',
          !bare && 'rounded-lg border border-line bg-surface p-4',
          row && 'flex flex-wrap items-center gap-3',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Small group label inside a section (e.g. "Soft" / "Outline"). */
export function ExampleGroup({
  title,
  children,
  className,
  ...rest
}: { title: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col gap-3', className)} {...rest}>
      <h3 className="text-md font-bold text-ink">{title}</h3>
      {children}
    </div>
  );
}
