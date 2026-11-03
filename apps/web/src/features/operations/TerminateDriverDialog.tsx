import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import {
  TERMINATION_REASON_LABEL,
  addManualCharge,
  defaultEquipment,
  terminateDriver,
  type IssuedEquipmentItem,
  type TerminationReason,
  type TerminationRecord,
} from '@/demo';
import { today as companyToday } from '@/lib/clock';
import { FormBlock } from '@/features/forms/FormBlock';
import { formatMoney } from '@/lib/format';

/**
 * Ending a driver's employment.
 *
 * The dialog exists because a termination is a settlement, not a status change. It asks the three
 * things that decide money — why they are leaving, what company property did not come back, and
 * whether there is an accident to account for — and shows, before anything is saved, exactly what
 * will be taken from the driver's escrow and what will be owed back to them.
 *
 * Nothing is estimated: charges are the replacement costs on the items actually ticked as missing,
 * and escrow can only ever cover what was recorded as held.
 */
export function TerminateDriverDialog({
  driverId,
  driverName,
  escrowHeldCents,
  onClose,
  onTerminated,
}: {
  driverId: string;
  /** The balance the canonical driver account reports; the charge is taken from it there. */
  escrowHeldCents: number;
  driverName: string;
  onClose: () => void;
  /** Receives the settled record, so a caller can end the employment record too. */
  onTerminated?: (record: TerminationRecord) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const account = { balance: escrowHeldCents / 100 };
  const [effectiveOn, setEffectiveOn] = useState(companyToday());
  const [reason, setReason] = useState<TerminationReason>('resigned');
  const [reasonNote, setReasonNote] = useState('');
  const [rehireEligible, setRehireEligible] = useState(true);
  const [equipment, setEquipment] = useState<IssuedEquipmentItem[]>(defaultEquipment());
  const [accident, setAccident] = useState(false);
  const [accidentNote, setAccidentNote] = useState('');
  const [accidentCharge, setAccidentCharge] = useState('');
  const [otherCharge, setOtherCharge] = useState('');
  const [otherChargeNote, setOtherChargeNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const missing = equipment.filter((item) => !item.returned);
  const equipmentCharge = missing.reduce((sum, item) => sum + item.replacementCost, 0);
  const accidentAmount = accident ? Math.max(0, Number(accidentCharge) || 0) : 0;
  const otherAmount = Math.max(0, Number(otherCharge) || 0);
  const charges = equipmentCharge + accidentAmount + otherAmount;
  const applied = Math.min(charges, account.balance);
  const shortfall = Math.round((charges - applied) * 100) / 100;
  const refund = Math.round((account.balance - applied) * 100) / 100;

  const run = useMutation({
    mutationFn: async () => {
      const record = await terminateDriver({
        driverId,
        effectiveOn,
        reason,
        reasonNote,
        rehireEligible,
        equipment,
        accident,
        accidentNote,
        accidentCharge: accidentAmount,
        otherCharge: otherAmount,
        otherChargeNote,
        escrowHeld: account.balance,
      });
      // The charge against escrow is a transaction on the one account, with the termination as its reason.
      if (record.escrowApplied > 0) {
        await addManualCharge(driverId, { kind: 'escrow_offset', amountCents: Math.round(record.escrowApplied * 100), onDate: effectiveOn, description: `Termination charges — ${record.id}`, reason: `Terminated ${effectiveOn}: equipment ${formatMoney(record.equipmentCharge)}, accident ${formatMoney(record.accidentCharge)}, other ${formatMoney(record.otherCharge)}`, approvalRequired: false });
      }
      return record;
    },
    onSuccess: async (record) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['drivers'] }),
        queryClient.invalidateQueries({ queryKey: ['accounting'] }),
      ]);
      toast({
        tone: 'success',
        title: `${record.driverName} is terminated`,
        description:
          record.shortfall > 0
            ? `${formatMoney(record.escrowApplied)} taken from escrow; ${formatMoney(record.shortfall)} goes to their final settlement.`
            : record.escrowRefund > 0
              ? `${formatMoney(record.escrowRefund)} of escrow is owed back to them.`
              : 'Escrow settled in full.',
      });
      onTerminated?.(record);
      onClose();
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The termination could not be recorded'),
  });

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="lg"
      title={`Terminate ${driverName}`}
      description="Why they are leaving, what came back, and what that does to their escrow."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={run.isPending}
            onClick={() => {
              setError(null);
              run.mutate();
            }}
          >
            Terminate driver
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Alert tone="danger" title="Not recorded">
            {error}
          </Alert>
        ) : null}

        <FormBlock title="Why they are leaving">
          <FormField label="Reason" required>
            <Select
              options={Object.entries(TERMINATION_REASON_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
              value={reason}
              onValueChange={(value) => setReason(value as TerminationReason)}
            />
          </FormField>
          <FormField label="Last day" required>
            <DatePicker
              value={effectiveOn}
              onIsoChange={(e) => setEffectiveOn(e)}
            />
          </FormField>
          <div className="sm:col-span-2">
            <FormField
              label="Note"
              description="What a reference call would need. Kept on the record."
            >
              <Textarea
                rows={2}
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
              />
            </FormField>
          </div>
          <div className="sm:col-span-2">
            <Checkbox
              checked={rehireEligible}
              onCheckedChange={(next) => setRehireEligible(next === true)}
              label="Eligible for rehire"
            />
          </div>
        </FormBlock>

        <FormBlock
          title="Company property"
          hint="Untick anything that did not come back. Its replacement cost is charged."
        >
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            {equipment.map((item, index) => (
              <label
                key={item.code}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-surface-hover"
              >
                <span className="flex items-center gap-2">
                  <Checkbox
                    checked={item.returned}
                    onCheckedChange={(next) =>
                      setEquipment((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, returned: next === true } : row,
                        ),
                      )
                    }
                  />
                  <span className="text-sm text-ink">{item.label}</span>
                </span>
                <span
                  className={
                    item.returned
                      ? 'text-xs text-muted'
                      : 'tabular text-sm font-medium text-danger-text'
                  }
                >
                  {item.returned ? 'Returned' : formatMoney(item.replacementCost)}
                </span>
              </label>
            ))}
          </div>
        </FormBlock>

        <FormBlock title="Accident and other charges">
          <div className="sm:col-span-2">
            <Checkbox
              checked={accident}
              onCheckedChange={(next) => setAccident(next === true)}
              label="There is an accident on this driver"
            />
          </div>
          {accident ? (
            <>
              <FormField
                label="Deductible charged"
                description="Leave at zero to record it without a charge."
              >
                <Input
                  inputMode="decimal"
                  value={accidentCharge}
                  onChange={(e) => setAccidentCharge(e.target.value)}
                  placeholder="0"
                />
              </FormField>
              <FormField label="What happened">
                <Input value={accidentNote} onChange={(e) => setAccidentNote(e.target.value)} />
              </FormField>
            </>
          ) : null}
          <FormField label="Other charge">
            <Input
              inputMode="decimal"
              value={otherCharge}
              onChange={(e) => setOtherCharge(e.target.value)}
              placeholder="0"
            />
          </FormField>
          <FormField label="What for">
            <Input value={otherChargeNote} onChange={(e) => setOtherChargeNote(e.target.value)} />
          </FormField>
        </FormBlock>

        <div className="rounded-lg border border-line bg-surface-muted p-4">
          <h3 className="text-md font-bold text-ink">What this settles</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Line label="Escrow held" value={formatMoney(account.balance)} />
            <Line label="Charges" value={formatMoney(charges)} />
            <Line label="Taken from escrow" value={formatMoney(applied)} />
            <Line
              label="Owed back to the driver"
              value={formatMoney(refund)}
              tone={refund > 0 ? 'good' : undefined}
            />
            {shortfall > 0 ? (
              <div className="col-span-2">
                <Line
                  label="Not covered by escrow"
                  value={`${formatMoney(shortfall)} — deducted from their final settlement`}
                  tone="bad"
                />
              </div>
            ) : null}
          </dl>
          {account.balance === 0 ? (
            <p className="mt-2 text-xs text-muted">
              No escrow has been recorded for this driver, so every charge follows them into
              Accounting instead.
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function Line({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-secondary">{label}</dt>
      <dd
        className={
          tone === 'good'
            ? 'tabular font-medium text-success-text'
            : tone === 'bad'
              ? 'tabular font-medium text-danger-text'
              : 'tabular font-medium text-ink'
        }
      >
        {value}
      </dd>
    </div>
  );
}
