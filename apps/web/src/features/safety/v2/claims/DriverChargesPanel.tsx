import { Link } from '@tanstack/react-router';
import { DRIVER_CHARGE_BASIS_LABEL, isActiveCharge } from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { isEnabled } from '@/lib/feature-flags';
import { cn } from '@/design-system';
import { useDriverCharges } from '../api';
import { money, td, th } from '../ui';
import { chargePill } from './parts';

/**
 * A driver's claim charges on the driver profile (Claims v2 §5.5): state, amount, recovered and
 * the claim, with what is still open. Hidden when the driver has none or the reader may not see them.
 */
export function DriverChargesPanel({ driverId }: { driverId: string }) {
  const account = useAccount();
  const allowed = Boolean(account && (account.permissions.includes('safety.view') || account.permissions.includes('accounting.view'))) && isEnabled('safety_v2') && isEnabled('claims_v2');
  const list = useDriverCharges({ driverId }, allowed);
  const rows = list.data ?? [];
  if (!allowed || rows.length === 0) return null;
  const open = rows.filter((c) => isActiveCharge(c.state)).reduce((s, c) => s + c.remainingCents, 0);
  const recovered = rows.reduce((s, c) => s + c.recoveredCents, 0);
  return (
    <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel" aria-label="Charges" data-testid="driver-charges-panel">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-nw-border px-4 py-3">
        <h2 className="text-[15px] font-bold text-nw-text">Charges</h2>
        <span className="text-xs text-nw-text-3">
          {money(open)} open · {money(recovered)} recovered
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead className="bg-nw-subtle">
            <tr>
              <th className={th}>Charge</th>
              <th className={th}>Basis</th>
              <th className={th}>Status</th>
              <th className={cn(th, 'text-right')}>Amount</th>
              <th className={cn(th, 'text-right')}>Recovered</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nw-border">
            {rows.map((c) => (
              <tr key={c.id}>
                <td className={td}>
                  {c.claimId ? (
                    <Link to="/safety/claims/$claimId" params={{ claimId: c.claimId }} className="font-semibold text-nw-accent-ink underline underline-offset-2">
                      {c.claimNumber}
                    </Link>
                  ) : null}
                  <span className="block text-xs text-nw-text-3">{c.number}</span>
                </td>
                <td className={td}>{DRIVER_CHARGE_BASIS_LABEL[c.basis]}</td>
                <td className={td}>{chargePill(c.state)}</td>
                <td className={cn(td, 'tabular text-right')}>{money(c.amountCents)}</td>
                <td className={cn(td, 'tabular text-right')}>{money(c.recoveredCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
