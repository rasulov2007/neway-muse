import { ChartBar, Table } from 'lucide-react';
import { useId, useState, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { ErrorState } from '../ErrorState';
import { Skeleton } from '../Skeleton';
import type { ChartTableView } from './types';

export interface ChartContainerProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** Plot height in px (the axis band is included). */
  height?: number;
  loading?: boolean;
  empty?: boolean;
  /** Replace the default "No data" empty state. */
  emptyState?: ReactNode;
  /** Truthy renders an error state; pass the error itself for dev details. */
  error?: unknown;
  onRetry?: () => void;
  /** Right side of the header (filters belong above the dashboard, not here). */
  toolbar?: ReactNode;
  /** Rendered under the plot. Wrappers generate one for >= 2 series. */
  legend?: ReactNode;
  footer?: ReactNode;
  /** Table twin of the chart; adds a "View as table" toggle. */
  tableView?: ChartTableView;
  /** Accessible name of the plot; defaults to the title. */
  ariaLabel?: string;
  /** Drop the card chrome when the chart sits inside another Card. */
  bare?: boolean;
  children?: ReactNode;
}

/** Card around a chart: header, states (loading / empty / error), plot, legend, footer. */
export function ChartContainer({
  title,
  description,
  height = 240,
  loading = false,
  empty = false,
  emptyState,
  error,
  onRetry,
  toolbar,
  legend,
  footer,
  tableView,
  ariaLabel,
  bare = false,
  className,
  children,
  ...rest
}: ChartContainerProps) {
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();
  const hasHeader = Boolean(title || description || toolbar || tableView);
  const label = ariaLabel ?? (typeof title === 'string' ? title : 'Chart');
  const stateShown = loading || Boolean(error) || empty;

  let body: ReactNode;
  if (loading) {
    body = <Skeleton className="h-full w-full" />;
  } else if (error) {
    body = (
      <ErrorState
        size="sm"
        className="h-full py-0"
        title="Unable to load chart"
        description="The data for this chart could not be loaded."
        onRetry={onRetry}
        error={error}
      />
    );
  } else if (empty) {
    body = emptyState ?? (
      <EmptyState
        size="sm"
        className="h-full py-0"
        icon={<ChartBar />}
        title="No data"
        description="Nothing to show for this selection."
      />
    );
  } else if (showTable && tableView) {
    body = (
      <div className="scroll-quiet h-full overflow-auto">
        <ChartTable view={tableView} caption={label} />
      </div>
    );
  } else {
    body = (
      <div role="img" aria-label={label} className="h-full w-full">
        {children}
      </div>
    );
  }

  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      aria-busy={loading || undefined}
      className={cn(
        'flex min-w-0 flex-col',
        !bare && 'rounded-lg border border-line bg-surface shadow-xs',
        className,
      )}
      {...rest}
    >
      {hasHeader ? (
        <header className={cn('flex items-start justify-between gap-3 pt-3 pb-2', !bare && 'px-4')}>
          <div className="min-w-0">
            {title ? (
              <h3 id={titleId} className="text-base font-semibold text-ink">
                {title}
              </h3>
            ) : null}
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          {toolbar || tableView ? (
            <div className="flex shrink-0 items-center gap-1">
              {toolbar}
              {tableView ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={showTable ? <ChartBar /> : <Table />}
                  aria-pressed={showTable}
                  disabled={stateShown}
                  onClick={() => setShowTable((v) => !v)}
                >
                  {showTable ? 'View as chart' : 'View as table'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </header>
      ) : null}
      <div className={cn('flex flex-col', !bare && 'px-4', hasHeader ? 'pb-3' : 'py-3')}>
        <div className="relative w-full" style={{ height }}>
          {body}
        </div>
        {legend && !stateShown && !showTable ? <div className="mt-2">{legend}</div> : null}
      </div>
      {footer ? (
        <footer
          className={cn('border-t border-line-soft py-2 text-xs text-muted', !bare && 'px-4')}
        >
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

function ChartTable({ view, caption }: { view: ChartTableView; caption: string }) {
  return (
    <table className="w-full border-collapse text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {view.columns.map((col) => (
            <th
              key={col.key}
              scope="col"
              className={cn(
                'border-b border-line py-1.5 pr-3 text-2xs font-medium tracking-eyebrow text-muted uppercase',
                col.align === 'right' ? 'text-right' : 'text-left',
              )}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {view.rows.map((row, r) => (
          <tr key={r}>
            {view.columns.map((col) => (
              <td
                key={col.key}
                className={cn(
                  'border-b border-line-soft py-1.5 pr-3 text-secondary',
                  col.align === 'right' ? 'tabular text-right' : 'text-left',
                )}
              >
                {row[col.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
