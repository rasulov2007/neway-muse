import { CalendarDays, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  Button,
  DatePicker,
  DropdownMenu,
  FormField,
  MenuItem,
  MenuSeparator,
  Modal,
  cn,
} from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { PERIOD_LABELS, rangeLabel, type Period, type PeriodKey } from './recruiting-kit';

/**
 * The pieces every Recruiting screen is built from (owner's redesign, 2026-10-01): one number
 * card, one panel, one empty state and one reporting period. One file so the seven screens read as
 * one product — the same card on Leads, Campaigns, Analytics and a candidate's Costs.
 *
 * Every figure arrives from the server. A card whose number has not arrived yet says "Loading…";
 * a number that cannot be known is a dash with the reason beside it, never a zero.
 */

// ------------------------------------------------------------------------------ number card

export type StatTone = 'primary' | 'info' | 'violet' | 'warning';

const TONE_TILE: Record<StatTone, string> = {
  primary: 'bg-primary-soft text-primary-text',
  info: 'bg-info-soft text-info-text',
  violet: 'bg-violet-soft text-violet-text',
  warning: 'bg-nw-warning-bg text-nw-warning-icon',
};

export function StatCard({
  icon,
  label,
  value,
  hint,
  tone = 'primary',
  onClick,
  active,
  testId,
}: {
  icon: ReactNode;
  label: string;
  /** `null` while loading. A string such as "—" when the figure cannot be known. */
  value: ReactNode | null;
  hint?: ReactNode;
  tone?: StatTone;
  /** Makes the card a filter button. */
  onClick?: () => void;
  active?: boolean;
  testId?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick, 'aria-pressed': active ?? false } : {})}
      data-testid={testId}
      className={cn(
        'flex min-w-0 items-center gap-4 rounded-[10px] border bg-nw-panel px-4 py-3.5 text-left shadow-card',
        active ? 'border-primary-border ring-1 ring-primary-border' : 'border-nw-border',
        onClick &&
          'transition-colors duration-(--duration-fast) hover:bg-nw-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-full [&_svg]:size-5',
          TONE_TILE[tone],
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-secondary">{label}</span>
        <span
          className={cn(
            'tabular block truncate text-2xl leading-tight font-bold',
            value === null ? 'text-base font-medium text-muted' : 'text-ink',
          )}
        >
          {value === null ? 'Loading…' : value}
        </span>
        {hint ? <span className="block truncate text-xs text-muted">{hint}</span> : null}
      </span>
    </Tag>
  );
}

// ------------------------------------------------------------------------------------ panel

/** A white panel: radius 10, one hairline, no shadow (SPEC). */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  testId,
  headingLevel = 2,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section
      className={cn('min-w-0 rounded-[10px] border border-nw-border bg-nw-panel', className)}
      data-testid={testId}
    >
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3">
          <div className="min-w-0">
            {title ? <H className="text-md font-bold text-ink">{title}</H> : null}
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(title || actions ? 'px-4 pb-4' : 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Nothing to show yet, and the one useful next step. */
export function PanelEmpty({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-4 py-8 text-center', className)}>
      <span
        aria-hidden
        className="flex size-14 items-center justify-center rounded-full border border-nw-border bg-nw-subtle text-muted [&_svg]:size-6"
      >
        {icon}
      </span>
      <p className="text-base font-bold text-ink">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * The period control in the page header. Presets and a custom range; the choice lives in the URL,
 * so a refresh, a shared link and the back button all keep it.
 */
export function PeriodControl({
  period,
  today,
  onChange,
}: {
  period: Period;
  today: string;
  onChange: (next: { period?: PeriodKey; from?: string; to?: string }) => void;
}) {
  const [custom, setCustom] = useState(false);
  return (
    <>
      <DropdownMenu
        trigger={
          <Button
            variant="outline"
            aria-label={`Reporting period: ${period.key === 'custom' ? 'custom range' : PERIOD_LABELS[period.key]}, ${rangeLabel(period.from, period.to)}`}
            data-testid="period-control"
          >
            <CalendarDays aria-hidden className="size-4" />
            <span className="whitespace-nowrap">{rangeLabel(period.from, period.to)}</span>
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
        }
      >
        {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((key) => (
          <MenuItem key={key} onSelect={() => onChange({ period: key })}>
            <span className="flex w-full items-center justify-between gap-6">
              {PERIOD_LABELS[key]}
              {key === period.key ? <span className="text-primary-text">✓</span> : null}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => setCustom(true)}>
          <span className="flex w-full items-center justify-between gap-6">
            Custom range…
            {period.key === 'custom' ? <span className="text-primary-text">✓</span> : null}
          </span>
        </MenuItem>
      </DropdownMenu>
      {custom ? (
        <CustomRangeDialog
          initial={period}
          today={today}
          onClose={() => setCustom(false)}
          onApply={(from, to) => {
            onChange({ from, to });
            setCustom(false);
          }}
        />
      ) : null}
    </>
  );
}

function CustomRangeDialog({
  initial,
  today,
  onClose,
  onApply,
}: {
  initial: Period;
  today: string;
  onClose: () => void;
  onApply: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [tried, setTried] = useState(false);
  const errors = {
    from: !from ? 'Choose a start date' : null,
    to: !to ? 'Choose an end date' : from && to && to < from ? 'The end is before the start' : null,
  };
  const valid = !errors.from && !errors.to;
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Custom reporting period"
      description={`Dates are US Eastern business days. Today is ${formatIsoDate(today)}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setTried(true);
              if (valid) onApply(from, to);
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="From" required error={tried ? errors.from : null}>
          <DatePicker aria-label="From" value={from} onIsoChange={setFrom} />
        </FormField>
        <FormField label="To" required error={tried ? errors.to : null}>
          <DatePicker aria-label="To" value={to} onIsoChange={setTo} />
        </FormField>
      </div>
    </Modal>
  );
}
