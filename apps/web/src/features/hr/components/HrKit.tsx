import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge, Card, Skeleton, cn } from '@/design-system';

/**
 * The pieces every Phase 11 page is built from.
 *
 * One file so five modules cannot drift into five dialects of the same thing. The employee context
 * header in particular is shared deliberately: opening a PTO request or an onboarding plan without
 * being told whose it is, and what they do, is how the wrong person's leave gets approved in a
 * workforce of hundreds.
 */

// ------------------------------------------------------------------------------------ kpi strip

export interface KpiSegment {
  key: string;
  label: string;
  /** `null` renders an em dash. Never a zero standing in for "not known". */
  value: number | null;
  suffix?: string;
  /** How to print the number; defaults to the locale's plain formatting. */
  format?: (value: number) => string;
  /** Why the value reads as it does (or as a dash); shown as the tile's title. */
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  onSelect?: () => void;
}

export function HrKpiStrip({
  segments,
  activeKey,
  loading,
}: {
  segments: KpiSegment[];
  activeKey?: string | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex gap-2 overflow-x-auto">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-36 shrink-0" />
        ))}
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {segments.map((segment) => {
        const active = activeKey !== undefined && segment.key === activeKey;
        const Tag = segment.onSelect ? 'button' : 'div';
        return (
          <Tag
            key={segment.key}
            {...(segment.onSelect
              ? { type: 'button' as const, onClick: segment.onSelect, 'aria-pressed': active }
              : {})}
            className={cn(
              'flex min-w-32 shrink-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left',
              'transition-colors duration-(--duration-base) ease-(--ease-standard)',
              segment.onSelect &&
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              active
                ? 'border-primary-border bg-primary-soft'
                : cn('border-line bg-surface', segment.onSelect && 'hover:bg-surface-hover'),
            )}
          >
            <span className="text-xs font-medium text-muted">{segment.label}</span>
            <span
              className={cn(
                'text-lg font-semibold tabular-nums',
                segment.value === null && 'text-faint',
                segment.tone === 'success' && 'text-success-text',
                segment.tone === 'warning' && 'text-warning-text',
                segment.tone === 'danger' && 'text-danger-text',
                (!segment.tone || segment.tone === 'default') &&
                  segment.value !== null &&
                  'text-ink',
              )}
              title={segment.hint ?? (segment.value === null ? 'Not available' : undefined)}
            >
              {segment.value === null
                ? '—'
                : segment.format
                  ? segment.format(segment.value)
                  : segment.value.toLocaleString()}
              {segment.value !== null && segment.suffix ? (
                <span className="ml-1 text-xs font-normal text-muted">{segment.suffix}</span>
              ) : null}
            </span>
          </Tag>
        );
      })}
    </div>
  );
}

// --------------------------------------------------------------------------- employee context

/**
 * Whose record this is.
 *
 * Shown at the top of every Phase 11 workspace. The employee number is a link into the Employee 360,
 * because the id — not the name — is the relationship, and two people can share a name.
 */
export function EmployeeContext({
  employeeId,
  name,
  employeeNumber,
  position,
  department,
  status,
  trailing,
}: {
  employeeId: string;
  name: string;
  employeeNumber: string;
  position?: string;
  department?: string;
  status?: string;
  trailing?: ReactNode;
}) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          to="/hr/employees/$employeeId"
          params={{ employeeId }}
          className="text-sm font-semibold text-primary-text hover:underline"
        >
          {name}
        </Link>
        <span className="font-mono text-xs text-faint">{employeeNumber}</span>
        {position ? <span className="text-sm text-secondary">{position}</span> : null}
        {department ? <span className="text-xs text-muted">{department}</span> : null}
        {status ? <Badge tone="neutral">{status.replace(/_/g, ' ')}</Badge> : null}
      </div>
      {trailing}
    </Card>
  );
}

// ---------------------------------------------------------------------------------- status pill

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<string, Tone> = {
  // recruiting
  applied: 'neutral',
  screening: 'info',
  interview: 'info',
  assessment: 'info',
  offer: 'warning',
  hired: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
  // shared lifecycle
  draft: 'neutral',
  open: 'info',
  sent: 'warning',
  accepted: 'success',
  declined: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
  on_hold: 'warning',
  filled: 'success',
  closed: 'neutral',
  // onboarding
  not_started: 'neutral',
  in_progress: 'info',
  blocked: 'danger',
  completed: 'success',
  pending: 'neutral',
  skipped: 'neutral',
  // attendance
  present: 'success',
  absent: 'danger',
  late: 'warning',
  partial: 'warning',
  on_leave: 'info',
  holiday: 'neutral',
  missing: 'danger',
  // pto
  submitted: 'warning',
  approved: 'success',
  // performance
  at_risk: 'warning',
  acknowledged: 'info',
  planned: 'neutral',
  active: 'success',
};

/** `on_hold` → "On hold": statuses read as words, in sentence case. */
function sentence(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function HrStatus({ value, title }: { value: string; title?: string }) {
  return (
    <Badge tone={TONES[value] ?? 'neutral'} title={title} dot>
      {sentence(value)}
    </Badge>
  );
}

// -------------------------------------------------------------------------------------- progress

/** A progress bar that refuses to draw when there is no progress to describe. */
export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  if (value === null) {
    return (
      <span className="text-xs text-faint" title="Nothing to measure yet">
        —
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-nw-track">
        <span
          className={cn(
            'block h-full rounded-full',
            value >= 100 ? 'bg-success' : value >= 50 ? 'bg-primary' : 'bg-warning',
          )}
          style={{ width: `${Math.max(2, value)}%` }}
        />
      </span>
      <span className="text-xs tabular-nums text-muted">{label ?? `${value}%`}</span>
    </span>
  );
}

// ------------------------------------------------------------------------------------- panels

export function HrPanel({
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

export function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 text-right text-ink">
        {value ?? <span className="text-faint">—</span>}
      </span>
    </div>
  );
}
