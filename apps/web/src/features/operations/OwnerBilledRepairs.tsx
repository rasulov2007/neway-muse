import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { ownerBilledOrdersFor, ownerShareOf } from '@/demo';
import { formatMoney } from '@/lib/format';
import { formatIsoDate } from '@/lib/format';

/**
 * Repairs this driver is paying for.
 *
 * An owner-operator's shop bill is their cost, and it reaches their settlement as a deduction.
 * Showing it here is the other half of that link: the work order names the driver, and the
 * driver's page names the work orders.
 */
export function OwnerBilledRepairs({ driverId }: { driverId: string }) {
  const orders = useMemo(() => ownerBilledOrdersFor(driverId), [driverId]);
  const owed = orders.reduce((sum, order) => sum + ownerShareOf(order), 0);
  if (orders.length === 0) return null;
  return (
    <section className="rounded-lg border border-line bg-surface">
      <h3 className="flex items-center justify-between border-b border-line-soft px-4 py-2">
        <span className="eyebrow">Shop charges billed to this driver</span>
        <span className="text-sm font-bold text-ink">{formatMoney(owed)}</span>
      </h3>
      <ul className="divide-y divide-line-soft">
        {orders.slice(0, 6).map((order) => (
          <li key={order.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="min-w-0">
              <Link
                to="/fleet/maintenance/$orderId"
                params={{ orderId: order.id }}
                className="text-sm font-medium text-nw-accent-ink hover:underline"
              >
                {order.roNumber}
              </Link>
              <span className="block truncate text-xs text-muted">
                {order.summary} · unit {order.unitNumber}
                {order.completedAt ? ` · ${formatIsoDate(order.completedAt.slice(0, 10))}` : ''}
              </span>
            </span>
            <span className="shrink-0 text-sm font-medium text-ink tabular-nums">
              {formatMoney(ownerShareOf(order))}
              {order.billing?.companyAmount ? (
                <span className="block text-xs font-normal text-muted">
                  company kept {formatMoney(order.billing.companyAmount)}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {orders.length > 6 ? (
        <p className="border-t border-line-soft px-4 py-2 text-xs text-muted">
          and {orders.length - 6} more
        </p>
      ) : null}
    </section>
  );
}
