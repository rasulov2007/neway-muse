import type { ReactNode } from 'react';
import { CLAIM_STAGE_LABEL, DRIVER_CHARGE_STATE_LABEL, DRIVER_CHARGE_STATE_TONE, type DriverChargeState, type SafetyClaim } from '@neway/shared';
import { StatusSymbol, cn } from '@/design-system';

export type Tone = 'urgent' | 'warning' | 'done' | 'moving' | 'neutral' | 'info';

const PILL: Record<Tone, string> = {
  urgent: 'border-nw-urgent-border bg-nw-urgent-bg text-nw-urgent-text [&_svg]:text-nw-urgent-icon',
  warning: 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text [&_svg]:text-nw-warning-icon',
  done: 'border-nw-done-border bg-nw-done-bg text-nw-done-text [&_svg]:text-nw-done-icon',
  moving: 'border-nw-moving-border bg-nw-moving-bg text-nw-moving-text [&_svg]:text-nw-moving-icon',
  neutral: 'border-nw-neutral-border bg-nw-neutral-bg text-nw-neutral-text [&_svg]:text-nw-neutral-icon',
  info: 'border-nw-moving-border bg-nw-moving-bg text-nw-moving-text [&_svg]:text-nw-moving-icon',
};

/** A status: symbol, word and colour, never colour alone. */
export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap', PILL[tone], className)}>
      <StatusSymbol family={tone} size={12} className="shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

export const chargePill = (state: DriverChargeState, className?: string) => (
  <Pill tone={DRIVER_CHARGE_STATE_TONE[state]} className={className}>
    {DRIVER_CHARGE_STATE_LABEL[state]}
  </Pill>
);

/** The claim's status in words the list reads (Claims v2 mockup). */
export function claimStatusOf(c: SafetyClaim): { tone: Tone; label: string } {
  if (c.voidedAt) return { tone: 'neutral', label: 'Void' };
  if (c.driverCharge?.state === 'disputed') return { tone: 'urgent', label: 'Disputed' };
  switch (c.stage) {
    case 'opened':
      return { tone: 'moving', label: c.liabilityParty ? 'Liability decided' : 'Under investigation' };
    case 'submitted':
    case 'insurer_review':
      return { tone: 'moving', label: 'Awaiting insurance' };
    case 'decision':
      return { tone: 'warning', label: 'Insurer decision' };
    case 'payment':
      return { tone: 'warning', label: 'Settlement pending' };
    case 'closed':
      return { tone: 'done', label: 'Closed' };
    default:
      return { tone: 'neutral', label: CLAIM_STAGE_LABEL[c.stage] };
  }
}

const KPI_TONE: Record<'plain' | 'urgent' | 'warning' | 'good', string> = {
  plain: 'border-nw-border bg-nw-panel',
  urgent: 'border-nw-urgent-border bg-[linear-gradient(180deg,var(--nw-urgent-bg),var(--nw-panel)_70%)]',
  warning: 'border-nw-warning-border bg-[linear-gradient(180deg,var(--nw-warning-bg),var(--nw-panel)_70%)]',
  good: 'border-nw-border bg-nw-panel',
};
const KPI_VALUE: Record<'plain' | 'urgent' | 'warning' | 'good', string> = {
  plain: 'text-nw-text',
  urgent: 'text-nw-urgent-text',
  warning: 'text-nw-warning-text',
  good: 'text-nw-done-text',
};

/** A number card: label, big figure, a line under it; clicking filters the list. */
export function Kpi({ label, value, sub, tone = 'plain', onClick, active }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'plain' | 'urgent' | 'warning' | 'good'; onClick?: () => void; active?: boolean }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex min-h-[108px] flex-col rounded-[12px] border px-4 py-3 text-left shadow-(--nw-shadow-card)',
        KPI_TONE[tone],
        onClick && 'cursor-pointer transition-colors hover:border-nw-accent',
        active && 'border-nw-accent ring-2 ring-nw-accent-tint',
      )}
    >
      <span className="text-[12.5px] font-semibold text-nw-text-2">{label}</span>
      <span className={cn('tabular mt-1 text-[24px] leading-tight font-extrabold', KPI_VALUE[tone])}>{value}</span>
      {sub ? <span className="mt-1 text-[11.5px] text-nw-text-3">{sub}</span> : null}
    </Tag>
  );
}

/** One labelled bar, for the right-hand summaries. */
export function BarRow({ label, value, share, display }: { label: string; value: number; share: number; display: string }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] items-center gap-3 py-1.5 text-[13px]">
      <span className="text-nw-text-2">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-nw-track" aria-hidden>
        <span className="block h-full rounded-full bg-nw-accent" style={{ width: `${Math.max(value > 0 ? 3 : 0, share * 100)}%` }} />
      </span>
      <span className="tabular text-right font-semibold text-nw-text">{display}</span>
    </li>
  );
}
