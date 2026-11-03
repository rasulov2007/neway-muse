import type { ReactNode } from 'react';
import { AlertTriangle, Info, TriangleAlert } from 'lucide-react';
import type { EmployeeAttentionItem, EmployeeStatus, UnavailableCheck } from '@neway/shared';
import { Badge, Card, Skeleton, cn } from '@/design-system';

/**
 * The pieces every People screen is built from.
 *
 * One file, so the list and the 360 cannot drift into two dialects of the same thing — a status
 * that is amber in one place and grey in the other is a status nobody trusts.
 */

// ------------------------------------------------------------------------------------- statuses

const STATUS_TONE: Record<EmployeeStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  on_leave: 'warning',
  suspended: 'warning',
  terminated: 'danger',
  archived: 'neutral',
};

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  active: 'Active',
  on_leave: 'On leave',
  suspended: 'Suspended',
  terminated: 'Terminated',
  archived: 'Archived',
};

/**
 * Employment status, and nothing else.
 *
 * Deliberately not the same badge as driver availability or login state: those are different
 * questions about the same person and showing them in one chip is how somebody ends up believing a
 * driver who is Off duty has left the company.
 */
export function EmployeeStatusBadge({ status }: { status: EmployeeStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} title="Employment status">
      {STATUS_LABEL[status]}
    </Badge>
  );
}

// ---------------------------------------------------------------------------------------- facts

export interface Fact {
  label: string;
  value: ReactNode;
  /** Hover text explaining where the value comes from, or why it is absent. */
  title?: string;
  emphasis?: boolean;
}

/** A definition list. `null` renders an em dash, never a zero or a blank. */
export function EmployeeFactList({ facts }: { facts: Fact[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted">{fact.label}</dt>
          <dd
            className={cn(
              'min-w-0 text-right',
              fact.emphasis ? 'font-semibold text-ink' : 'text-ink',
            )}
            title={fact.title}
          >
            {fact.value ?? <span className="text-faint">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function EmployeePanel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-md font-bold text-ink">{title}</h3>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

// -------------------------------------------------------------------------------- summary strip

export interface SummarySegment {
  key: string;
  label: string;
  /** `null` means the figure could not be computed. It renders as an em dash, never as zero. */
  count: number | null;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  onSelect: () => void;
}

/**
 * The workforce strip.
 *
 * Every segment is a filter. Clicking one narrows the list to exactly the rows it counted, because
 * both come from the same query — a tile that opens a list of a different size is a tile that
 * teaches people to distrust the page.
 */
export function EmployeeSummaryStrip({
  segments,
  activeKey,
  loading,
}: {
  segments: SummarySegment[];
  activeKey: string | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex gap-2 overflow-x-auto">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-36 shrink-0" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {segments.map((segment) => {
        const active = segment.key === activeKey;
        return (
          <button
            key={segment.key}
            type="button"
            aria-pressed={active}
            onClick={segment.onSelect}
            className={cn(
              'flex min-w-0 flex-col items-start gap-1 rounded-[10px] border px-4 py-3 text-left',
              'transition-colors duration-(--duration-base) ease-(--ease-standard)',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              active
                ? 'border-primary-border bg-primary-soft'
                : 'border-line bg-surface hover:bg-surface-hover',
            )}
          >
            <span className="text-[13px] font-medium text-muted">{segment.label}</span>
            <span
              className={cn(
                'text-2xl font-bold tabular-nums',
                segment.count === null && 'text-faint',
                segment.tone === 'success' && 'text-success-text',
                segment.tone === 'warning' && 'text-warning-text',
                segment.tone === 'danger' && 'text-danger-text',
                (!segment.tone || segment.tone === 'default') &&
                  segment.count !== null &&
                  'text-ink',
              )}
              title={segment.count === null ? 'Not available' : undefined}
            >
              {segment.count === null ? '—' : segment.count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------- needs attention

const SEVERITY_ICON = {
  critical: TriangleAlert,
  warning: AlertTriangle,
  info: Info,
};

/**
 * What needs attention on this person.
 *
 * Findings come from the engine, which only produces one from a fact it was actually given. What
 * could not be checked is listed underneath rather than passing silently, so an empty panel means
 * "nothing is wrong" and never "nothing was looked at".
 */
export function NeedsAttentionPanel({
  items,
  unavailable,
}: {
  items: EmployeeAttentionItem[];
  unavailable: UnavailableCheck[];
}) {
  // Absence is the all-clear, as everywhere else in the product: a panel that exists only to say
  // "nothing is wrong" is furniture, and this was the one place that drew it.
  if (items.length === 0 && unavailable.length === 0) return null;

  return (
    <Card className="p-4">
      <h3 className="text-md font-bold text-ink">Needs attention</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No outstanding items.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((item) => {
            const Icon = SEVERITY_ICON[item.severity];
            return (
              <li
                key={item.key}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border px-3 py-2',
                  item.severity === 'critical'
                    ? 'border-danger-border bg-danger-soft'
                    : item.severity === 'warning'
                      ? 'border-warning-border bg-warning-soft'
                      : 'border-line bg-surface-muted',
                )}
              >
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    item.severity === 'critical'
                      ? 'text-danger-text'
                      : item.severity === 'warning'
                        ? 'text-warning-text'
                        : 'text-muted',
                  )}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      'block text-sm font-medium',
                      item.severity === 'critical'
                        ? 'text-danger-text'
                        : item.severity === 'warning'
                          ? 'text-warning-text'
                          : 'text-ink',
                    )}
                  >
                    {item.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{item.detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {unavailable.length > 0 ? (
        <p className="mt-3 border-t border-line-soft pt-3 text-xs text-faint">
          Not checked: {unavailable.map((u) => `${u.label} (needs ${u.requires})`).join('; ')}.
        </p>
      ) : null}
    </Card>
  );
}

// --------------------------------------------------------------------------------- phase 11 tab

/**
 * A workforce module that this phase does not deliver.
 *
 * The tab is present because the employee record is what it will hang off, and absent content is
 * more honest than invented content: no sample PTO balance, no placeholder review score. When the
 * module ships it replaces this panel and nothing about the employee record changes.
 */
export function ComingInPhase({ module, description }: { module: string; description: string }) {
  return (
    <Card className="p-8">
      <div className="mx-auto flex max-w-prose flex-col items-center gap-2 text-center">
        <Badge tone="neutral">Phase 11</Badge>
        <h3 className="text-md font-bold text-ink">{module} is not built yet</h3>
        <p className="text-sm text-secondary">{description}</p>
        <p className="text-xs text-faint">
          This employee record is the one it will attach to — nothing here will be migrated or
          re-created when it ships.
        </p>
      </div>
    </Card>
  );
}
