import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { WorkOrder, WorkOrderWithCost } from '@neway/shared';
import { StatusSymbol } from '@/design-system';
import { apiGet } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';
import { formatMoney } from '@/lib/format';

/**
 * Repairs charged to a driver, as accounting has to see them.
 *
 * Two groups, and the difference between them is the whole point. A charge the driver has been
 * told about is money the next settlement takes off their pay. A charge the driver has **not**
 * been told about is money nobody may take - it is said here in full, in red, with the order and
 * the driver named, because the alternative is a deduction appearing on somebody's pay that they
 * were never warned about.
 *
 * The work orders are the server's; this panel only reads them.
 */
function hasCost(o: WorkOrder | WorkOrderWithCost): o is WorkOrderWithCost {
  return 'total' in o;
}

export function DriverChargePanel() {
  const orders = useQuery({
    queryKey: ['work-orders', 'driver-charges'],
    queryFn: () => apiGet<(WorkOrder | WorkOrderWithCost)[]>('/fleet/work-orders'),
    enabled: isEnabled('fleet_v2'),
    staleTime: 60_000,
    // An accountant without maintenance.view simply does not get this panel.
    retry: false,
  });
  const charges = (orders.data ?? []).filter((o) => o.charge.party === 'driver');
  if (orders.isError || charges.length === 0) return null;

  const held = charges.filter((o) => o.charge.driverInformed !== true);
  const running = charges.filter((o) => o.charge.driverInformed === true);
  const sum = (rows: (WorkOrder | WorkOrderWithCost)[]) =>
    rows.reduce((t, o) => (hasCost(o) ? t + o.total : t), 0);

  return (
    <section
      aria-label="Repairs charged to drivers"
      className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4"
    >
      <h2 className="text-sm font-bold text-ink">Repairs charged to drivers</h2>

      {held.length > 0 ? (
        <div className="rounded-md border border-nw-urgent-text bg-nw-urgent-bg px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-bold text-nw-urgent-text">
            <StatusSymbol family="urgent" size={14} className="text-nw-urgent-icon" />
            {held.length === 1
              ? '1 charge is held: the driver has not been told'
              : `${held.length} charges are held: those drivers have not been told`}
            {sum(held) > 0 ? ` · ${formatMoney(sum(held))}` : ''}
          </h3>
          <p className="mt-1 text-xs font-semibold text-nw-urgent-text">
            Do not deduct any of this. Nothing comes off a driver's pay until the repair log
            records that the driver was told.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs font-semibold text-nw-urgent-text">
            {held.map((o) => (
              <li key={o.id}>
                <Link to="/fleet/shop/$orderId" params={{ orderId: o.id }} className="hover:underline">
                  {o.number}
                </Link>{' '}
                · Unit {o.unitNumber}
                {o.charge.driverName ? ` · ${o.charge.driverName}` : ''}
                {hasCost(o) ? ` · ${formatMoney(o.total)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {running.length > 0 ? (
        <div className="rounded-md border border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">
            Deducted from driver earnings
            {sum(running) > 0 ? ` · ${formatMoney(sum(running))}` : ''}
          </h3>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
            {running.map((o) => (
              <li key={o.id}>
                <Link to="/fleet/shop/$orderId" params={{ orderId: o.id }} className="hover:underline">
                  {o.number}
                </Link>{' '}
                · {o.charge.driverName ?? 'driver'}
                {hasCost(o) ? ` · ${formatMoney(o.total)}` : ''}
                {o.charge.informedAt ? ' · driver informed' : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
