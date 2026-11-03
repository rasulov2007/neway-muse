import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Alert, Badge, Button } from '@/design-system';
import { fetchDriverAccount, fetchDriverReview, type DriverReviewRow } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { formatMoney } from '@/lib/format';
import { ProfileDialog } from '@/features/operations/DriverFinancialAccountTab';

/**
 * The financial review, one row per driver (corrective brief 2, section 2). Issues are kept
 * apart - rate reading, basis, plan not reviewed, opening balances, payee, email - and the one
 * action opens the canonical profile editor preloaded with what is on record. Billing is never
 * blocked by any of these; earnings preview is shown wherever it can be computed.
 */
export function DriverReviewPanel({ compact = false }: { compact?: boolean }) {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const review = useQuery({ queryKey: ['accounting', 'driver-review'], queryFn: fetchDriverReview, staleTime: 30_000 });
  const [editing, setEditing] = useState<string | null>(null);
  if (review.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (review.isError) return <Alert tone="danger" title="The driver review could not be loaded" description={review.error instanceof Error ? review.error.message : undefined} />;
  const rows = review.data.filter((r) => r.issues.length > 0);
  if (rows.length === 0) return compact ? null : <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">Every driver with completed loads has a reviewed pay plan and reconciled balances.</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line-soft px-3 py-2"><p className="text-sm font-semibold text-ink">Driver financial review <span className="font-normal text-muted">{rows.length} driver{rows.length === 1 ? '' : 's'}</span></p><span className="text-2xs text-muted">Earnings preview where computable; final net waits on reconciliation only</span></div>
      <table className="w-full text-sm">
        <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Driver</th><th className="px-3 py-2">Plan on record</th><th className="px-3 py-2">Issues</th><th className="px-3 py-2 text-right">Completed loads</th><th className="px-3 py-2 text-right">Earnings preview</th><th className="px-3 py-2" /></tr></thead>
        <tbody className="divide-y divide-line-soft">
          {rows.slice(0, compact ? 6 : rows.length).map((r) => (
            <tr key={r.driverId}>
              <td className="px-3 py-2"><Link to="/drivers/$driverId" params={{ driverId: r.driverId }} search={{ tab: 'financial' }} className="font-medium text-primary-text hover:underline">{r.name}</Link><span className="block text-xs text-muted">{r.driverNumber} · {r.contractType}</span></td>
              <td className="px-3 py-2 text-xs">{r.plan ? (r.plan.basis === 'n/a' ? `${r.plan.kind.replace(/_/g, ' ')} ${r.plan.rate}` : `${r.rate?.asPercent ?? r.plan.rate} of ${r.plan.basis}${r.rate?.ambiguous && !r.rateConfirmed ? ` (or ${r.rate.asMultiplier})` : ''}`) : 'None'}{r.profileSaved ? '' : <span className="block text-muted">from the roster, not reviewed</span>}</td>
              <td className="px-3 py-2"><span className="flex flex-wrap gap-1">{r.issues.map((i) => <Badge key={i.kind} tone={i.kind === 'rate_ambiguous' || i.kind === 'plan_unreviewed' ? 'warning' : 'neutral'} size="sm" title={i.detail}>{i.label}</Badge>)}</span></td>
              <td className="px-3 py-2 text-right tabular-nums">{r.completedLoads}{r.blockedLoads > 0 ? <span className="text-2xs text-warning-text"> ({r.blockedLoads} blocked)</span> : null}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.earnedPreviewCents === null ? <span className="text-muted">Cannot calculate</span> : formatMoney(r.earnedPreviewCents / 100)}</td>
              <td className="px-3 py-2 text-right">{canEdit ? <Button variant="secondary" size="sm" onClick={() => setEditing(r.driverId)}>Review pay plan</Button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing ? <ReviewDialog driverId={editing} row={rows.find((r) => r.driverId === editing)!} onClose={() => setEditing(null)} onDone={() => review.refetch()} /> : null}
    </div>
  );
}

export function ReviewDialog({ driverId, row, onClose, onDone }: { driverId: string; row: DriverReviewRow; onClose: () => void; onDone: () => Promise<unknown> }) {
  const account = useQuery({ queryKey: ['accounting', 'driver-account', driverId], queryFn: () => fetchDriverAccount(driverId) });
  if (account.isPending) return null;
  if (account.isError) return <Alert tone="danger" title="The account could not be loaded" />;
  return <ProfileDialog account={account.data} onClose={onClose} onDone={onDone} review={row} />;
}
