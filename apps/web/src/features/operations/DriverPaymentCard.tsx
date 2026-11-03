import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CreditCard } from 'lucide-react';
import { Badge, Card } from '@/design-system';
import { fetchPayees } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { formatIsoDate } from '@/lib/format';

/**
 * How this driver is paid, read from the one sealed payee record (corrective brief, section 6).
 *
 * This card no longer writes. Bank details were moved out of the roster's plaintext table on
 * 2026-09-27: they are entered once, through Accounting › Settlements › Payee, stored sealed,
 * and shown here only as the last four digits. A wrong number is replaced there, never shown.
 */
export function DriverPaymentCard({ driverId }: { driverId: string }) {
  const account = useAccount();
  const canSee = account?.permissions.includes('accounting.view') ?? false;
  const payees = useQuery({ queryKey: ['accounting', 'payees'], queryFn: fetchPayees, enabled: canSee });

  return (
    <Card
      padding="md"
      title={
        <span className="flex items-center gap-2">
          <CreditCard className="size-4 text-primary" aria-hidden />
          Accounting &amp; payment details
        </span>
      }
    >
      {!canSee ? (
        <p className="text-sm text-muted">Payment details are held by Accounting.</p>
      ) : payees.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : payees.isError ? (
        <p className="text-sm text-danger-text">The payee record could not be loaded.</p>
      ) : (() => {
        const payee = payees.data.find((p) => p.partyType === 'driver' && p.partyId === driverId) ?? null;
        if (!payee) {
          return (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-muted">No payee on file. Until one is verified, this driver cannot be included in a payment batch.</p>
              <Link to="/accounting/settlements" className="text-primary-text underline">Set up the payee in Accounting</Link>
            </div>
          );
        }
        return (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div><dt className="eyebrow">Legal name</dt><dd className="mt-1 text-ink">{payee.legalName}</dd></div>
            <div><dt className="eyebrow">Account</dt><dd className="mt-1 text-ink">{payee.accountType ? `${payee.accountType} ···· ${payee.accountLast4 ?? '????'}` : 'Not entered'}</dd></div>
            <div><dt className="eyebrow">Routing</dt><dd className="mt-1 text-ink">{payee.routingLast4 ? `···· ${payee.routingLast4}` : 'Not entered'}</dd></div>
            <div><dt className="eyebrow">Verification</dt><dd className="mt-1">{payee.verifiedAt ? <Badge tone="success" size="sm">Verified {formatIsoDate(payee.verifiedAt.slice(0, 10))}</Badge> : <Badge tone="warning" size="sm">Not verified</Badge>}</dd></div>
            <div className="col-span-2 text-xs text-muted">Sealed on the server; replaced, never shown. <Link to="/accounting/settlements" className="text-primary-text underline">Replace or verify in Accounting</Link></div>
          </dl>
        );
      })()}
    </Card>
  );
}
