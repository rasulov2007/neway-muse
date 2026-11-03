import { Link } from '@tanstack/react-router';
import type { VendorMoneySummary } from '@neway/shared';
import { Card, EmptyState } from '@/design-system';
import { formatMoney } from '@/lib/format';

/**
 * Vendor trucks (owner, 2026-10-28): the money from vendors' own trucks, on its own.
 *
 * What the company keeps is already inside revenue and profit everywhere else, and these trucks'
 * driver pay, fuel and repairs are already out of company expenses; this card shows the whole
 * picture per truck so the vendor's side can be read too. Gross = company keeps + driver pay +
 * truck costs + vendor's net, on every row.
 */
export function VendorTrucksWidget({ summary, masked = false }: { summary: VendorMoneySummary; masked?: boolean }) {
  if (summary.trucks.length === 0) {
    return (
      <Card>
        <EmptyState
          size="sm"
          title="No vendor trucks in this period"
          description="Move a truck to a vendor from its page (⋮ › Move to vendor). Its company share then shows here."
        />
      </Card>
    );
  }
  const t = summary.totals;
  const money = (v: number) => (masked ? '••••' : formatMoney(v));
  return (
    <Card padding="none" data-testid="vendor-trucks">
      <div className="grid grid-cols-2 gap-3 border-b border-line p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Figure label="Vendor trucks" value={String(t.trucks)} sub={`${t.loads} loads`} />
        <Figure label="Gross" value={money(t.gross)} />
        <Figure label="Company keeps" value={money(t.companyShare)} strong sub="in company revenue" />
        <Figure label="Driver pay" value={money(t.driverPay)} sub="from the vendor’s part" />
        <Figure label="Truck costs" value={money(t.truckCosts)} sub="fuel, repairs, other" />
        <Figure label="Vendor’s net" value={money(t.vendorNet)} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Unit</th>
              <th className="px-4 py-2 font-medium">Vendor</th>
              <th className="px-4 py-2 text-right font-medium">Loads</th>
              <th className="px-4 py-2 text-right font-medium">Gross</th>
              <th className="px-4 py-2 text-right font-medium">Company keeps</th>
              <th className="px-4 py-2 text-right font-medium">Driver pay</th>
              <th className="px-4 py-2 text-right font-medium">Truck costs</th>
              <th className="px-4 py-2 text-right font-medium">Vendor’s net</th>
            </tr>
          </thead>
          <tbody>
            {summary.trucks.map((r) => (
              <tr key={`${r.truckId}|${r.vendorId}`} className="border-t border-line">
                <td className="px-4 py-2 font-semibold">
                  <Link to="/fleet/trucks/$truckId" params={{ truckId: r.truckId }} className="text-primary-text hover:underline">
                    {r.unitNumber}
                  </Link>
                </td>
                <td className="px-4 py-2 text-ink">
                  {r.vendorName} <span className="text-xs text-muted">· keeps {r.companyPercent}%</span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{r.loads}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.gross)}</td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-success-text">{money(r.companyShare)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.driverPay)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.truckCosts)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.vendorNet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Figure({ label, value, sub, strong = false }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-muted">{label}</span>
      <span className={strong ? 'text-lg font-semibold tabular-nums text-success-text' : 'text-lg font-semibold tabular-nums text-ink'}>{value}</span>
      {sub ? <span className="text-[11px] text-muted">{sub}</span> : null}
    </div>
  );
}
