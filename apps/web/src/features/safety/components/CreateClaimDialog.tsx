import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { CLAIM_KINDS } from '@neway/shared';
import { Button, FormField, Input, Modal, Select, Textarea, useToast } from '@/design-system';
import { createClaimFromAccident, type Claim } from '@/demo';
import { formatMoney } from '@/lib/format';
import { CLAIM_KIND_LABEL, DASH } from '../safety-ui';
import { SafetyFactList } from './SafetyKit';
import { useInvalidateSafety, type SafetyAccident } from '../useSafety';

/**
 * Opens a claim against an accident.
 *
 * Everything the TMS already knows is inherited, not retyped: driver, unit, trailer, load,
 * customer, broker, the description and the damage assessed so far. The panel showing what carries
 * over is not decoration — it is the difference between a claim that reconciles against the load it
 * came from and one that has to be matched up by hand later.
 *
 * The only fields asked for are the ones only a person can supply: which cover it falls under, who
 * the insurer is, and what to reserve.
 */
export function CreateClaimDialog({
  open,
  onOpenChange,
  accident,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accident: SafetyAccident;
  /** The claim that was opened, for a caller that wants to go there. */
  onDone: (claim: Claim) => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();

  const suggested =
    accident.accident.injuries.length > 0 || accident.accident.fatalities > 0
      ? 'liability'
      : 'physical_damage';

  const [kind, setKind] = useState<string>(suggested);
  const [insurer, setInsurer] = useState('');
  const [reserve, setReserve] = useState(
    accident.totalDamage === null ? '' : String(Math.round(accident.totalDamage)),
  );
  const [deductible, setDeductible] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createClaimFromAccident({
        accidentId: accident.accident.id,
        kind: kind as 'cargo' | 'liability' | 'physical_damage' | 'workers_comp',
        insurer,
        // An empty reserve stays null. An unreserved claim is an unknown liability, and recording
        // it as $0 would understate what the carrier is exposed to.
        reserveAmount: reserve.trim() ? Number(reserve) : null,
        deductible: deductible.trim() ? Number(deductible) : null,
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: async (claim) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `${claim.claimNumber} opened against ${accident.accident.accidentNumber}`,
        description:
          claim.reserveAmount === null
            ? 'Unreserved — the exposure will read as unknown until a reserve is set.'
            : `Reserved at ${formatMoney(claim.reserveAmount)}.`,
      });
      onDone(claim);
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The claim could not be opened.'),
  });

  const inherited = [
    { label: 'Accident', value: accident.accident.accidentNumber },
    { label: 'Date', value: accident.accident.at.slice(0, 10) },
    { label: 'Driver', value: accident.accident.driverName },
    { label: 'Unit', value: accident.accident.unitNumber },
    {
      label: 'Trailer',
      value: accident.accident.trailerUnit ?? <span className="text-faint">{DASH}</span>,
    },
    {
      label: 'Load',
      value: accident.accident.loadNumber ?? <span className="text-faint">{DASH}</span>,
    },
    {
      label: 'Assessed damage',
      value:
        accident.totalDamage === null ? (
          <span className="text-faint">Not yet assessed</span>
        ) : (
          formatMoney(accident.totalDamage)
        ),
    },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Create claim"
      description="Our own record of the claim. Everything the system already knows about this accident carries over; nothing is sent to the insurer from here."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!insurer.trim()}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            Open claim
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <p className="eyebrow">
            Carried over from the accident
          </p>
          <SafetyFactList facts={inherited} className="mt-1" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Cover"
            required
            description={
              suggested === 'liability'
                ? 'Suggested from the injuries on the file.'
                : 'Suggested from the damage on the file.'
            }
          >
            <Select
              options={CLAIM_KINDS.map((value) => ({
                value,
                label: CLAIM_KIND_LABEL[value] ?? value,
              }))}
              value={kind}
              onValueChange={setKind}
            />
          </FormField>
          <FormField label="Insurer" required>
            <Input
              value={insurer}
              onChange={(e) => setInsurer(e.target.value)}
              placeholder="Great West Casualty"
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Reserve"
            description="Leave empty to open it unreserved; the exposure then reads as unknown rather than zero."
          >
            <Input
              inputMode="decimal"
              value={reserve}
              onChange={(e) => setReserve(e.target.value)}
              prefix="$"
            />
          </FormField>
          <FormField label="Deductible">
            <Input
              inputMode="decimal"
              value={deductible}
              onChange={(e) => setDeductible(e.target.value)}
              prefix="$"
            />
          </FormField>
        </div>

        <FormField label="Notes" description="Optional.">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
