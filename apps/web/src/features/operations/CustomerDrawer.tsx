import { loadStatusLabel } from '@/features/loads/loads-search';
import { useState, type ReactNode } from 'react';
import { Button, Card, Drawer, EmptyState, StatusBadge, Tabs } from '@/design-system';
import { hrefs, linkClass, useGo } from '@/features/dashboard/links';
import { formatDate, formatMoney, formatNumber, formatPhone } from '@/lib/format';
import { DASH } from './operations-ui';
import type { OperationalCustomer } from './useOperations';

export interface CustomerDrawerProps {
  /** The resolved row for `?customer=`; the drawer is open while it is non-null. */
  customer: OperationalCustomer | null;
  onClose: () => void;
}

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'loads', label: 'Loads' },
  { value: 'financial', label: 'Financial' },
  { value: 'performance', label: 'Performance' },
] as const;

type CustomerTab = (typeof TABS)[number]['value'];

/** The most recent loads worth reading in a drawer; the full list lives on the loads page. */
const LOAD_LIMIT = 25;

/**
 * A computed figure the system could not produce.
 *
 * Rendering `$0` or `0%` here would be a lie — "we earned nothing" and "we cannot price this
 * freight" are different answers — so every null money or rate value goes through this instead.
 */
export function InsufficientData({ reason }: { reason?: string }) {
  return (
    <span className="text-faint italic" title={reason}>
      Insufficient data
    </span>
  );
}

/** Right-side quick read of one customer relationship. Opens for `?customer=`. */
export function CustomerDrawer({ customer, onClose }: CustomerDrawerProps) {
  const open = customer !== null;
  const id = customer?.customer.id;

  // The active tab resets whenever a different customer opens.
  const [tabState, setTabState] = useState<{ id: string | undefined; tab: CustomerTab }>({
    id,
    tab: 'overview',
  });
  const tab = tabState.id === id ? tabState.tab : 'overview';
  const setTab = (next: CustomerTab) => setTabState({ id, tab: next });

  const record = customer?.customer;

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={record?.name ?? ''}
      description={
        record
          ? `${record.status === 'on_hold' ? 'On hold' : record.status === 'inactive' ? 'Inactive' : 'Active'} · MC ${record.mcNumber ?? DASH}`
          : undefined
      }
      headerExtra={record ? <StatusBadge status={record.status} /> : null}
      tabs={
        record ? (
          <Tabs
            items={[...TABS]}
            value={tab}
            onValueChange={(next) => setTab(next as CustomerTab)}
            size="sm"
            aria-label="Customer sections"
            listClassName="-mb-px border-b-0"
          />
        ) : null
      }
      bodyClassName="bg-app"
    >
      {customer ? (
        <div className="flex flex-col gap-4">
          <QuickActions onViewProfitability={() => setTab('financial')} />
          {tab === 'overview' ? <OverviewTab row={customer} /> : null}
          {tab === 'loads' ? <LoadsTab row={customer} /> : null}
          {tab === 'financial' ? <FinancialTab row={customer} /> : null}
          {tab === 'performance' ? <PerformanceTab row={customer} /> : null}
        </div>
      ) : null}
    </Drawer>
  );
}

/**
 * Only actions that actually work.
 *
 * The loads list has no customer filter yet, so there is no "open this customer's loads" button —
 * a dead button that silently drops the filter would be worse than no button.
 */
function QuickActions({ onViewProfitability }: { onViewProfitability: () => void }) {
  const go = useGo();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={onViewProfitability}>
        View profitability
      </Button>
      <Button size="sm" variant="ghost" onClick={() => go(hrefs.loads)}>
        All loads
      </Button>
    </div>
  );
}

function Definition({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

/** Muted lines explaining why a figure above is missing or partial. */
function Reasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-0.5">
      {reasons.map((reason) => (
        <li key={reason} className="text-xs text-muted">
          {reason}
        </li>
      ))}
    </ul>
  );
}

function money(value: number | null, reason?: string) {
  return value === null ? <InsufficientData reason={reason} /> : formatMoney(value);
}

function percent(value: number | null, reason?: string) {
  return value === null ? <InsufficientData reason={reason} /> : `${value}%`;
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

function OverviewTab({ row }: { row: OperationalCustomer }) {
  const c = row.customer;
  return (
    <Card padding="md">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Definition label="Primary contact">
          <span className="block truncate">{c.primaryContact.name || DASH}</span>
          <span className="block truncate text-xs text-muted">
            {c.primaryContact.email || DASH}
          </span>
          <span className="block text-xs text-muted">
            {c.primaryContact.phone ? formatPhone(c.primaryContact.phone) : DASH}
          </span>
        </Definition>
        <Definition label="Address">
          <span className="block">{c.address.line1}</span>
          <span className="block text-xs text-muted">
            {c.address.city}, {c.address.state} {c.address.zip}
          </span>
        </Definition>
        <Definition label="Payment terms">Net {formatNumber(c.paymentTermsDays)} days</Definition>
        <Definition label="Credit limit">{formatMoney(c.creditLimit)}</Definition>
        <Definition label="MC number">{c.mcNumber ?? DASH}</Definition>
        <Definition label="USDOT">{c.usdot ?? DASH}</Definition>
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------------------------

function LoadsTab({ row }: { row: OperationalCustomer }) {
  const go = useGo();
  // Most recent first by pickup: it is the one date every load has, booked or delivered.
  const loads = [...row.loads]
    .sort((a, b) => Date.parse(b.pickupAt) - Date.parse(a.pickupAt))
    .slice(0, LOAD_LIMIT);

  if (loads.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          size="sm"
          title="No loads for this customer"
          description="Freight booked for this customer will appear here."
        />
      </Card>
    );
  }

  return (
    <Card
      title="Recent loads"
      description={`${formatNumber(loads.length)} of ${formatNumber(row.loads.length)}`}
      padding="sm"
    >
      <ul className="divide-y divide-line-soft">
        {loads.map((load) => (
          <li key={load.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                <button
                  type="button"
                  className={linkClass}
                  onClick={() => go(hrefs.load(load.loadNumber))}
                >
                  {load.loadNumber}
                </button>
                {/* The customer→broker connection: whose freight this actually was. */}
                {load.brokerId ? (
                  <>
                    <span className="text-faint"> · </span>
                    <button
                      type="button"
                      className={linkClass}
                      onClick={() => go(hrefs.broker(load.brokerId as string))}
                    >
                      {load.brokerName ?? 'Broker'}
                    </button>
                  </>
                ) : null}
              </p>
              <p className="truncate text-xs text-muted">
                {load.origin.city}, {load.origin.state} → {load.destination.city},{' '}
                {load.destination.state} · {formatDate(load.pickupAt)}
              </p>
            </div>
            <p className="tabular shrink-0 text-right text-sm text-secondary">
              {formatMoney(load.rate)}
            </p>
            <div className="shrink-0">
              <StatusBadge status={load.status} label={loadStatusLabel(load.status)} size="sm" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Financial
// ---------------------------------------------------------------------------------------------

function FinancialTab({ row }: { row: OperationalCustomer }) {
  const p = row.performance;
  const pay = row.payment;
  const perfReason = p.reasons.join(' · ');
  const payReason = pay.reasons.join(' · ');

  return (
    <div className="flex flex-col gap-4">
      <Card title="Profitability" padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Revenue">{money(p.revenue, perfReason)}</Definition>
          <Definition label="Total cost">{money(p.totalCost, perfReason)}</Definition>
          <Definition label="Profit">{money(p.profit, perfReason)}</Definition>
          <Definition label="Margin">{percent(p.marginPct, perfReason)}</Definition>
          <Definition label="Rev / loaded mi">
            {money(p.revenuePerLoadedMile, perfReason)}
          </Definition>
          <Definition label="Rev / total mi">{money(p.revenuePerTotalMile, perfReason)}</Definition>
          <Definition label="Profit / total mi">
            {money(p.profitPerTotalMile, perfReason)}
          </Definition>
          <Definition label="Deadhead">{percent(p.deadheadPct, perfReason)}</Definition>
        </dl>
        <Reasons reasons={p.reasons} />
      </Card>

      <Card title="How they pay" padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Invoices">{formatNumber(pay.invoices)}</Definition>
          <Definition label="Avg days to pay">
            {pay.avgDaysToPay === null ? (
              <InsufficientData reason={payReason} />
            ) : (
              `${formatNumber(pay.avgDaysToPay)} days`
            )}
          </Definition>
          <Definition label="Paid on time">{percent(pay.paidOnTimePct, payReason)}</Definition>
          <Definition label="Outstanding">{money(pay.outstanding, payReason)}</Definition>
          <Definition label="Overdue">
            {pay.overdueAmount === null ? (
              <InsufficientData reason={payReason} />
            ) : (
              `${formatMoney(pay.overdueAmount)} · ${formatNumber(pay.overdueCount)} invoices`
            )}
          </Definition>
          <Definition label="Disputed">{formatNumber(pay.disputedCount)}</Definition>
        </dl>
        <Reasons reasons={pay.reasons} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------------

function PerformanceTab({ row }: { row: OperationalCustomer }) {
  const p = row.performance;
  const reason = p.reasons.join(' · ');
  const c = p.coverage;

  return (
    <div className="flex flex-col gap-4">
      <Card title="How they run" padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="On-time pickup">{percent(p.onTimePickupPct, reason)}</Definition>
          <Definition label="On-time delivery">{percent(p.onTimeDeliveryPct, reason)}</Definition>
          <Definition label="Avg dwell">
            {p.avgDwellMinutes === null ? (
              <InsufficientData reason={reason} />
            ) : (
              `${formatNumber(p.avgDwellMinutes)} min`
            )}
          </Definition>
          <Definition label="Detention">
            {p.detentionMinutes === null ? (
              <InsufficientData reason={reason} />
            ) : (
              `${formatNumber(p.detentionMinutes)} min`
            )}
          </Definition>
          <Definition label="Cancellation rate">
            {percent(p.cancellationRatePct, reason)}
          </Definition>
          <Definition label="Loads">
            {formatNumber(p.counts.total)} total · {formatNumber(p.counts.active)} active ·{' '}
            {formatNumber(p.counts.delivered)} delivered
          </Definition>
        </dl>
        {/* Coverage in plain words: how much of the set these numbers actually stand on. */}
        <p className="mt-3 text-xs text-muted">
          Priced {formatNumber(c.priced)} of {formatNumber(c.loads)} loads ·{' '}
          {formatNumber(c.timedDeliveries)} deliveries timed · {formatNumber(c.timedPickups)}{' '}
          pickups timed
        </p>
        <Reasons reasons={p.reasons} />
      </Card>

      {p.unavailable.length > 0 ? (
        <Card title="Not tracked yet" padding="md">
          <ul className="flex flex-col gap-0.5">
            {p.unavailable.map((item) => (
              <li key={item.metric} className="text-xs text-muted">
                <span className="text-secondary">{item.metric}</span> — needs {item.requires}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
