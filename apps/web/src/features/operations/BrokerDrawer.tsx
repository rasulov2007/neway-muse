import { loadStatusLabel } from '@/features/loads/loads-search';
import { useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Drawer, EmptyState, StatusBadge, Tabs } from '@/design-system';
import { hrefs, linkClass, useGo } from '@/features/dashboard/links';
import { formatDate, formatMoney, formatNumber, formatPhone } from '@/lib/format';
import { BROKER_RISK_LABEL, BROKER_RISK_TONE, DASH } from './operations-ui';
import type { OperationalBroker } from './useOperations';

export interface BrokerDrawerProps {
  /** The broker resolved from `?broker=`; the drawer is open while it is set. */
  broker: OperationalBroker | null;
  onClose: () => void;
}

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'risk', label: 'Risk' },
  { value: 'loads', label: 'Loads' },
  { value: 'financial', label: 'Financial' },
] as const;

type BrokerTab = (typeof TABS)[number]['value'];

/** Most recent freight first; a broker page is read newest-first, and the list is capped. */
const LOAD_LIMIT = 25;

/**
 * Right-side read of one broker. The row already carries the grade; this is where the grade has to
 * justify itself, so the Risk tab is the reason this drawer exists.
 */
export function BrokerDrawer({ broker, onClose }: BrokerDrawerProps) {
  const open = broker !== null;
  const id = broker?.broker.id;

  // The active tab resets whenever a different broker opens.
  const [tabState, setTabState] = useState<{ id: string | undefined; tab: BrokerTab }>({
    id,
    tab: 'overview',
  });
  const tab = tabState.id === id ? tabState.tab : 'overview';

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={broker?.broker.name ?? ''}
      description={
        broker ? `MC ${broker.broker.mcNumber} · ${broker.broker.status.replace('_', ' ')}` : ''
      }
      headerExtra={broker ? <StatusBadge status={broker.broker.status} /> : null}
      tabs={
        broker ? (
          <Tabs
            items={[...TABS]}
            value={tab}
            onValueChange={(next) => setTabState({ id, tab: next as BrokerTab })}
            size="sm"
            aria-label="Broker sections"
            listClassName="-mb-px border-b-0"
          />
        ) : null
      }
      bodyClassName="bg-app"
    >
      {broker ? (
        <div className="flex flex-col gap-4">
          <QuickActions />
          {tab === 'overview' ? <OverviewTab row={broker} /> : null}
          {tab === 'risk' ? <RiskTab row={broker} /> : null}
          {tab === 'loads' ? <LoadsTab row={broker} /> : null}
          {tab === 'financial' ? <FinancialTab row={broker} /> : null}
        </div>
      ) : null}
    </Drawer>
  );
}

/** Only destinations that exist today; a button that opens a placeholder is worse than no button. */
function QuickActions() {
  const go = useGo();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={() => go(hrefs.loads)}>
        Open loads
      </Button>
      <Button variant="secondary" size="sm" onClick={() => go(hrefs.invoices)}>
        Open invoices
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------------

function Definition({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

/** A figure the system genuinely could not derive. Never `$0`, never `0%`. */
function Unknown({ reason }: { reason: string }) {
  return (
    <span className="text-faint italic" title={reason}>
      Insufficient data
    </span>
  );
}

function Metric({
  label,
  value,
  format,
  reason,
}: {
  label: string;
  value: number | null;
  format: (value: number) => ReactNode;
  reason: string;
}) {
  return (
    <Definition label={label}>
      {value === null ? <Unknown reason={reason} /> : format(value)}
    </Definition>
  );
}

function Notes({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line} className="text-xs text-muted">
          {line}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

function OverviewTab({ row }: { row: OperationalBroker }) {
  const broker = row.broker;
  return (
    <div className="flex flex-col gap-4">
      {broker.doNotUse ? (
        <Alert
          tone="danger"
          title="Flagged do not use"
          description={
            broker.doNotUseReason ??
            'No reason was recorded against this flag on the broker record.'
          }
        />
      ) : null}

      <Card padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Contact">
            <span className="block truncate">{broker.primaryContact.name}</span>
            <a
              className={`${linkClass} block truncate text-xs`}
              href={`mailto:${broker.primaryContact.email}`}
            >
              {broker.primaryContact.email}
            </a>
            <span className="block text-xs text-muted">
              {formatPhone(broker.primaryContact.phone)}
            </span>
          </Definition>
          <Definition label="Address">
            {broker.address.line1}
            <span className="block text-xs text-muted">
              {broker.address.city}, {broker.address.state} {broker.address.zip}
            </span>
          </Definition>
          <Definition label="MC / USDOT">
            {broker.mcNumber}
            <span className="block text-xs text-muted">USDOT {broker.usdot}</span>
          </Definition>
          <Definition label="Payment terms">{broker.paymentTermsDays} days</Definition>
          <Definition label="Rating">
            {broker.rating === null ? (
              <span className="text-faint">Not rated yet</span>
            ) : (
              formatNumber(broker.rating, 1)
            )}
          </Definition>
          <Definition label="Status">
            <StatusBadge status={broker.status} size="sm" />
          </Definition>
        </dl>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------------------------

/**
 * The whole derivation, not a verdict.
 *
 * Every scored factor is listed with its points, and every check that could not run is listed with
 * what it needs. A level with no visible factors would be exactly the unexplained grade the risk
 * engine exists to avoid, so the empty case says so in words.
 */
function RiskTab({ row }: { row: OperationalBroker }) {
  const risk = row.risk;
  return (
    <div className="flex flex-col gap-4">
      <Card padding="md">
        <div className="flex items-center gap-3">
          <Badge tone={BROKER_RISK_TONE[risk.level]}>{BROKER_RISK_LABEL[risk.level]}</Badge>
          <span className="tabular text-sm text-secondary">
            Score {formatNumber(risk.score, 1)}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted">{risk.summary}</p>
      </Card>

      <Card title="Factors" description="What produced this level" padding="sm">
        {risk.factors.length === 0 ? (
          <EmptyState
            size="sm"
            title="No factor scored against this broker"
            description={risk.summary}
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {risk.factors.map((factor) => (
              <li key={factor.key} className="flex items-start gap-3 py-2">
                <p className="min-w-0 flex-1 text-sm text-ink">{factor.observation}</p>
                <p className="tabular shrink-0 text-sm font-medium text-secondary">
                  +{formatNumber(factor.points, 1)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Not assessed"
        description="Checks this deployment cannot run yet"
        padding="sm"
        data-testid="broker-risk-not-assessed"
      >
        <ul className="flex flex-col gap-1">
          {risk.notAssessed.map((item) => (
            <li key={item.factor} className="text-xs text-muted">
              <span className="text-secondary">{item.factor}</span> — needs {item.requires}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------------------------

function LoadsTab({ row }: { row: OperationalBroker }) {
  const go = useGo();
  const loads = row.loads
    .slice()
    .sort((a, b) => b.bookedAt.localeCompare(a.bookedAt))
    .slice(0, LOAD_LIMIT);

  if (loads.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          title="No loads from this broker"
          description="Freight booked through this broker will appear here."
        />
      </Card>
    );
  }

  return (
    <Card
      title="Loads"
      description={`Most recent ${loads.length} of ${row.loads.length}`}
      padding="sm"
    >
      <ul className="divide-y divide-line-soft">
        {loads.map((load) => (
          <li key={load.id} className="flex items-start gap-3 py-2">
            <div className="min-w-0 flex-1">
              <button
                type="button"
                className={`${linkClass} text-sm`}
                onClick={() => go(hrefs.load(load.loadNumber))}
              >
                {load.loadNumber}
              </button>
              <p className="truncate text-xs text-muted">
                {load.origin.city}, {load.origin.state} → {load.destination.city},{' '}
                {load.destination.state} · {formatDate(load.bookedAt)}
              </p>
              {/* The broker→customer connection: whose freight this broker actually moved. */}
              <button
                type="button"
                className={`${linkClass} text-xs`}
                onClick={() => go(hrefs.customer(load.customerId))}
              >
                {load.customerName}
              </button>
            </div>
            <p className="tabular shrink-0 text-sm text-secondary">{formatMoney(load.rate)}</p>
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

function FinancialTab({ row }: { row: OperationalBroker }) {
  const performance = row.performance;
  const payment = row.payment;
  const moneyReason =
    performance.reasons.join(' · ') ||
    'No priced load on file for this broker, so money cannot be computed';
  const paymentReason =
    payment.reasons.join(' · ') || 'No paid invoice carries both an issue and a payment date';

  return (
    <div className="flex flex-col gap-4">
      <Card title="Freight" padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Metric
            label="Revenue"
            value={performance.revenue}
            format={(v) => formatMoney(v)}
            reason={moneyReason}
          />
          <Metric
            label="Total cost"
            value={performance.totalCost}
            format={(v) => formatMoney(v)}
            reason={moneyReason}
          />
          <Metric
            label="Profit"
            value={performance.profit}
            format={(v) => formatMoney(v)}
            reason={moneyReason}
          />
          <Metric
            label="Margin"
            value={performance.marginPct}
            format={(v) => <span className={v < 0 ? 'text-danger-text' : undefined}>{v}%</span>}
            reason={moneyReason}
          />
          <Metric
            label="Rev / loaded mi"
            value={performance.revenuePerLoadedMile}
            format={(v) => formatMoney(v)}
            reason={moneyReason}
          />
          <Metric
            label="Rev / total mi"
            value={performance.revenuePerTotalMile}
            format={(v) => formatMoney(v)}
            reason={moneyReason}
          />
          <Metric
            label="Profit / total mi"
            value={performance.profitPerTotalMile}
            format={(v) => formatMoney(v)}
            reason={moneyReason}
          />
        </dl>
        <Notes lines={performance.reasons} />
        {performance.unavailable.length > 0 ? (
          <div className="mt-3">
            <p className="eyebrow">Not tracked yet</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {performance.unavailable.map((item) => (
                <li key={item.metric} className="text-xs text-muted">
                  <span className="text-secondary">{item.metric}</span> — needs {item.requires}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card title="Payment" padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Invoices">{formatNumber(payment.invoices)}</Definition>
          <Metric
            label="Avg days to pay"
            value={payment.avgDaysToPay}
            format={(v) => `${formatNumber(v)} days`}
            reason={paymentReason}
          />
          <Metric
            label="Paid on time"
            value={payment.paidOnTimePct}
            format={(v) => `${v}%`}
            reason={paymentReason}
          />
          <Metric
            label="Outstanding"
            value={payment.outstanding}
            format={(v) => formatMoney(v)}
            reason="No invoice carries an open balance"
          />
          <Definition label="Overdue">
            {payment.overdueCount === 0 ? (
              DASH
            ) : (
              <span className="text-danger-text">
                {formatNumber(payment.overdueCount)}
                {payment.overdueAmount === null ? '' : ` · ${formatMoney(payment.overdueAmount)}`}
              </span>
            )}
          </Definition>
          <Definition label="Disputed">
            {payment.disputedCount === 0 ? DASH : formatNumber(payment.disputedCount)}
          </Definition>
        </dl>
        <Notes lines={payment.reasons} />
      </Card>
    </div>
  );
}
