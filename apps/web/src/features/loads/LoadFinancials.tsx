import type { Load } from '@/demo';
import { Badge, Card, EmptyState, cn } from '@/design-system';
import { Receipt } from 'lucide-react';
import { formatMoney, formatRpm } from '@/lib/format';

function Line({
  label,
  amount,
  muted,
  className,
}: {
  label: string;
  amount: number;
  muted?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4 py-1.5 text-sm', className)}>
      <span className={muted ? 'text-secondary' : 'text-ink'}>{label}</span>
      <span className="tabular text-ink">{formatMoney(amount)}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2">
      <div className="eyebrow">{label}</div>
      <div className="tabular mt-0.5 text-lg font-semibold text-ink">{value}</div>
    </div>
  );
}

/** Revenue, expense lines, gross profit and per-mile stats; charges with billable/payable badges. */
export function LoadFinancials({ load }: { load: Load }) {
  const f = load.financials;
  const expenses = load.expenses;

  // A load booked minutes ago has a rate and miles but no costs yet. Saying so beats printing a
  // zero cost breakdown, which would read as a wildly profitable load.
  if (!f) {
    return (
      <Card title="Profit and loss" description="Costs have not posted against this load yet.">
        <EmptyState
          size="sm"
          icon={<Receipt />}
          title="No costs booked yet"
          description={`Revenue is ${formatMoney(load.rate)}. Fuel, driver pay and maintenance post against the load as it runs; profitability is calculated once they do.`}
        />
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-(--section-gap) xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card title="Profit and loss" description="Revenue less allocated costs for this load.">
        <div className="flex items-center justify-between gap-4 pb-2 text-sm">
          <span className="font-medium text-ink">Revenue</span>
          <span className="tabular font-semibold text-ink">{formatMoney(f.revenue)}</span>
        </div>
        <div className="border-t border-line-soft pt-1">
          {expenses.map((e) => (
            <Line key={e.id} label={e.description} amount={-e.amount} muted />
          ))}
        </div>
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-3 text-base">
          <span className="font-semibold text-ink">Gross profit</span>
          <span className="tabular font-semibold text-success-text">
            {formatMoney(f.grossProfit)}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Stat label="RPM" value={formatRpm(f.rpm)} />
          <Stat label="CPM" value={formatRpm(f.costPerMile)} />
          <Stat label="PPM" value={formatRpm(f.profitPerMile)} />
        </div>
      </Card>
      <Card title="Charges" description="Line items on the rate confirmation.">
        <ul className="flex flex-col">
          {load.charges.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 border-b border-line-soft py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-ink">{c.description}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge tone={c.billable ? 'info' : 'neutral'} size="sm">
                    {c.billable ? 'Billable' : 'Not billable'}
                  </Badge>
                  <Badge tone={c.payableToDriver ? 'success' : 'neutral'} size="sm">
                    {c.payableToDriver ? 'Payable to driver' : 'Company'}
                  </Badge>
                </div>
              </div>
              <span className="tabular shrink-0 text-sm text-ink">{formatMoney(c.amount)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-sm">
          <span className="font-medium text-ink">Total</span>
          <span className="tabular font-semibold text-ink">
            {formatMoney(load.charges.reduce((sum, c) => sum + c.amount, 0))}
          </span>
        </div>
      </Card>
    </div>
  );
}
