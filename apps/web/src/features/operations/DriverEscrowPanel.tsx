import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { TX_TREATMENT, type DriverTx } from '@neway/shared';
import { Alert, Badge, Button, FormField, Input, Modal, Select, useToast } from '@/design-system';
import { TERMINATION_REASON_LABEL, addManualCharge, fetchDriverAccount, terminationFor } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { today } from '@/lib/clock';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { OwnerBilledRepairs } from './OwnerBilledRepairs';
import { TerminateDriverDialog } from './TerminateDriverDialog';

/**
 * A driver's escrow, and the button that ends their employment.
 *
 * Since 2026-09-27 this reads and writes the one driver finance account on the server
 * (corrective brief, section 4): the same balance the Financial Account tab and the settlement
 * show. The old browser-side escrow store is read-only and imported once through Accounting.
 * Every movement is a transaction with a date, a reason and the name of whoever recorded it;
 * nothing here edits a past line.
 */
export function DriverEscrowPanel({
  driverId,
  driverName,
  terminated,
}: {
  driverId: string;
  driverName: string;
  terminated: boolean;
}) {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const [recording, setRecording] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const query = useQuery({ queryKey: ['accounting', 'driver-account', driverId], queryFn: () => fetchDriverAccount(driverId) });
  const record = terminationFor(driverId);

  if (query.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (query.isError) return <Alert tone="danger" title="The escrow could not be loaded" description={query.error instanceof Error ? query.error.message : undefined} />;
  const a = query.data;
  const balance = a.escrow.balanceCents ?? a.escrow.movementsCents;
  const entries = a.transactions.filter((t) => TX_TREATMENT[t.kind] === 'escrow' && t.state !== 'void');
  const shortOfTarget = balance === null ? null : Math.max(0, a.escrow.targetCents - balance);

  return (
    <div className="flex flex-col gap-4">
      <OwnerBilledRepairs driverId={driverId} />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Held today" value={formatMoney(balance / 100)} strong />
        <Figure label="Target" value={formatMoney(a.escrow.targetCents / 100)} />
        <Figure
          label="Still to collect"
          value={shortOfTarget === null ? 'Opening not reconciled' : shortOfTarget > 0 ? formatMoney(shortOfTarget / 100) : 'Fully held'}
          tone={shortOfTarget === null || shortOfTarget > 0 ? 'warn' : 'good'}
        />
        <Figure label="Collection" value={a.escrow.collectionEnabled ? `On · ${formatMoney((a.profile.current?.escrow.perSettlementCents ?? 0) / 100)} per statement` : 'Off'} />
      </div>
      <p className="text-xs text-muted">
        Same balance as the <Link to="/drivers/$driverId" params={{ driverId }} search={{ tab: 'financial' }} className="text-primary-text underline">Financial account</Link>. Escrow and debt are separate: nothing here is applied to a debt unless Accounting records an offset.
      </p>

      {record ? (
        <Alert
          tone="warning"
          title={`Terminated ${formatIsoDate(record.effectiveOn)} — ${TERMINATION_REASON_LABEL[record.reason]}`}
          description={
            record.shortfall > 0
              ? `${formatMoney(record.escrowApplied)} was taken from escrow and ${formatMoney(record.shortfall)} went to their final settlement.`
              : record.escrowRefund > 0
                ? `${formatMoney(record.escrowRefund)} of escrow is owed back to them.`
                : 'Escrow settled in full.'
          }
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canEdit ? (
          <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
            Record escrow movement
          </Button>
        ) : <span className="text-xs text-muted">Accounting records escrow movements.</span>}
        {!terminated ? (
          <Button size="sm" variant="danger" onClick={() => setTerminating(true)}>
            Terminate driver
          </Button>
        ) : null}
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted">
          No escrow has been recorded for {driverName}. Until it is, a termination charge has
          nothing to come out of and goes straight to their final settlement.
        </p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <KindBadge kind={entry.kind} />
                  <span className="text-sm text-ink">{entry.description}</span>
                  {entry.source === 'legacy_escrow' ? <Badge tone="neutral" size="sm">Imported</Badge> : null}
                </span>
                <span className="block text-xs text-muted">
                  {formatIsoDate(entry.onDate)}{entry.reason ? ` · ${entry.reason}` : ''}
                </span>
              </span>
              <span
                className={
                  entry.kind === 'escrow_deposit'
                    ? 'tabular text-sm font-medium text-success-text'
                    : 'tabular text-sm font-medium text-danger-text'
                }
              >
                {entry.kind === 'escrow_deposit' ? '+' : '−'}
                {formatMoney(entry.amountCents / 100)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {recording ? (
        <EscrowDialog
          driverId={driverId}
          balanceCents={balance ?? 0}
          onClose={() => setRecording(false)}
        />
      ) : null}

      {terminating ? (
        <TerminateDriverDialog
          driverId={driverId}
          driverName={driverName}
          escrowHeldCents={balance ?? 0}
          onClose={() => setTerminating(false)}
        />
      ) : null}
    </div>
  );
}

function KindBadge({ kind }: { kind: DriverTx['kind'] }) {
  if (kind === 'escrow_deposit') {
    return (
      <Badge tone="success" size="sm">
        Paid in
      </Badge>
    );
  }
  if (kind === 'escrow_refund') {
    return (
      <Badge tone="neutral" size="sm">
        Refunded
      </Badge>
    );
  }
  return (
    <Badge tone="danger" size="sm">
      Charged
    </Badge>
  );
}

function Figure({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn';
  strong?: boolean;
}) {
  const colour =
    tone === 'warn' ? 'text-warning-text' : tone === 'good' ? 'text-success-text' : 'text-ink';
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <p
        className={`tabular mt-1 ${strong ? 'text-xl font-bold' : 'text-sm font-medium'} ${colour}`}
      >
        {value}
      </p>
    </div>
  );
}

/** Recording money in, or paying some of it back. Charges are made by the termination dialog. */
function EscrowDialog({
  driverId,
  balanceCents,
  onClose,
}: {
  driverId: string;
  balanceCents: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'escrow_deposit' | 'escrow_refund'>('escrow_deposit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('Escrow deposit');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const cents = Math.round(Number(amount) * 100);
      if (!(cents > 0)) throw new Error('An escrow entry has to be more than zero');
      if (kind === 'escrow_refund' && cents > balanceCents) throw new Error(`Only ${formatMoney(balanceCents / 100)} is held; a refund cannot exceed it`);
      return addManualCharge(driverId, { kind, amountCents: cents, onDate: today(), description: kind === 'escrow_deposit' ? 'Escrow deposit' : 'Escrow refund', reason: reason.trim() || 'Escrow', approvalRequired: false });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounting'] });
      toast({ tone: 'success', title: 'Escrow updated' });
      onClose();
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The entry could not be recorded'),
  });

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      title="Record an escrow movement"
      description={`${formatMoney(balanceCents / 100)} is held for this driver today.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            Record it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not recorded">
            {error}
          </Alert>
        ) : null}
        <FormField label="Kind">
          <Select
            options={[
              { value: 'escrow_deposit', label: 'Paid in by the driver' },
              { value: 'escrow_refund', label: 'Refunded to the driver' },
            ]}
            value={kind}
            onValueChange={(value) => setKind(value as 'escrow_deposit' | 'escrow_refund')}
          />
        </FormField>
        <FormField label="Amount" required>
          <Input prefix="$" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500.00" />
        </FormField>
        <FormField label="Reason" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
