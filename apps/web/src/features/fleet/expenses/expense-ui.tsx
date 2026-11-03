import type { ReactNode } from 'react';
import {
  Banknote,
  Droplets,
  FileBadge,
  Fuel,
  Milestone,
  Package,
  PackageOpen,
  Receipt,
  Scale,
  SquareParking,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  FLEET_PAYMENT_STATUS_LABEL,
  FLEET_RECOVERY_STATUS_LABEL,
  type FleetExpenseCategory,
  type FleetPaymentStatus,
  type FleetRecoveryStatus,
} from '@neway/shared';
import { Badge, StatusSymbol, cn, type BadgeTone } from '@/design-system';

// ---------------------------------------------------------------------------- status badges

/**
 * The six status looks: a symbol and a word in the family colour, never colour alone. `info`
 * is the "i" circle (waiting on someone else); `moving` is the arrow circle (under way).
 */
export type ExpenseLook = 'done' | 'warning' | 'urgent' | 'neutral' | 'moving' | 'info';

const LOOK_TONE: Record<ExpenseLook, BadgeTone> = {
  done: 'success',
  warning: 'warning',
  urgent: 'danger',
  neutral: 'neutral',
  moving: 'info',
  info: 'info',
};

export function LookBadge({ look, children, size = 'md' }: { look: ExpenseLook; children: ReactNode; size?: 'sm' | 'md' }) {
  return (
    <Badge
      tone={LOOK_TONE[look]}
      size={size}
      dot
      icon={look === 'info' ? <StatusSymbol family="info" size={size === 'sm' ? 12 : 13} className="text-nw-moving-icon" /> : undefined}
    >
      {children}
    </Badge>
  );
}

const PAYMENT_LOOK: Record<FleetPaymentStatus, ExpenseLook> = {
  paid: 'done',
  reimbursed: 'done',
  unpaid: 'warning',
  not_billed: 'neutral',
  partially_paid: 'warning',
  reimbursement_pending: 'warning',
  reimbursement_approved: 'moving',
  reimbursement_rejected: 'urgent',
  paid_externally: 'info',
  draft: 'neutral',
  void: 'neutral',
};

const RECOVERY_LOOK: Record<FleetRecoveryStatus, ExpenseLook> = {
  none: 'neutral',
  not_posted: 'info',
  pending_review: 'warning',
  approved: 'moving',
  in_settlement: 'moving',
  partially_deducted: 'warning',
  deducted: 'done',
  disputed: 'urgent',
  paused: 'warning',
  cancelled: 'neutral',
};

/** Whether the vendor (or the driver) has been paid. Separate from recovery on purpose. */
export function PaymentStatusBadge({ status, size }: { status: FleetPaymentStatus; size?: 'sm' | 'md' }) {
  return (
    <LookBadge look={PAYMENT_LOOK[status]} size={size}>
      {FLEET_PAYMENT_STATUS_LABEL[status]}
    </LookBadge>
  );
}

/** Where recovering the charge from the driver stands. "No recovery" stays quiet. */
export function RecoveryStatusBadge({ status, size }: { status: FleetRecoveryStatus; size?: 'sm' | 'md' }) {
  if (status === 'none') return <span className="text-xs text-nw-text-3">No recovery</span>;
  return (
    <LookBadge look={RECOVERY_LOOK[status]} size={size}>
      {FLEET_RECOVERY_STATUS_LABEL[status]}
    </LookBadge>
  );
}

export function FromMaintenanceBadge() {
  return (
    <Badge tone="neutral" variant="outline" size="sm" icon={<Wrench aria-hidden />}>
      From Maintenance
    </Badge>
  );
}

// ---------------------------------------------------------------------------- categories

const CATEGORY_ICON: Record<FleetExpenseCategory, LucideIcon> = {
  cash_advance: Banknote,
  parking: SquareParking,
  truck_wash: Droplets,
  repair_maintenance: Wrench,
  tolls: Milestone,
  fuel: Fuel,
  permits: FileBadge,
  scale: Scale,
  lumper: PackageOpen,
  supplies: Package,
  other: Receipt,
};

/** The category with its icon; the word is always there. */
export function CategoryLabel({ category, label, className }: { category: FleetExpenseCategory; label: string; className?: string }) {
  const Icon = CATEGORY_ICON[category] ?? Receipt;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span className="grid size-5 shrink-0 place-items-center rounded-md bg-nw-accent-tint text-nw-accent-ink" aria-hidden>
        <Icon className="size-3" />
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------- number cards

/**
 * One KPI. The value is "Loading…" until the data is in; a zero only ever appears as a real
 * zero. With `onOpen` the card opens the rows behind it.
 */
export function ExpenseKpi({
  icon,
  label,
  value,
  hint,
  onOpen,
  tone = 'primary',
}: {
  icon: ReactNode;
  label: string;
  value: string | null;
  hint?: ReactNode;
  onOpen?: () => void;
  tone?: 'primary' | 'warning' | 'neutral';
}) {
  const body = (
    <>
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
          tone === 'warning'
            ? 'bg-nw-warning-bg text-nw-warning-icon'
            : tone === 'neutral'
              ? 'bg-nw-neutral-bg text-nw-neutral-icon'
              : 'bg-nw-accent-tint text-nw-accent-ink',
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-[12.5px] font-semibold text-nw-text-2">{label}</span>
        <span className="tabular block text-[22px] leading-[1.2] font-bold tracking-[-0.02em] text-nw-text">
          {value === null ? <span className="text-sm font-medium text-nw-text-3">Loading…</span> : value}
        </span>
        {hint ? <span className="block text-xs text-nw-text-3">{hint}</span> : null}
      </span>
    </>
  );
  const frame = 'flex min-w-0 items-start gap-3 rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3.5';
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className={cn(frame, 'cursor-pointer text-left transition-colors hover:bg-nw-hover focus-visible:ring-2 focus-visible:ring-nw-accent focus-visible:outline-none')}
    >
      {body}
    </button>
  ) : (
    <div className={frame}>{body}</div>
  );
}

/** A labelled value in a detail section. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-3 py-1.5 text-[13px]">
      <dt className="text-nw-text-3">{label}</dt>
      <dd className="min-w-0 break-words text-nw-text">{children}</dd>
    </div>
  );
}
