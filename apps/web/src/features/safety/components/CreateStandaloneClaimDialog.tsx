import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CLAIM_KINDS } from '@neway/shared';
import {
  Alert,
  Button,
  Combobox,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { createStandaloneClaim, listDrivers, listLoads, listTrucks, type Claim } from '@/demo';
import { useQuery } from '@tanstack/react-query';
import { parseMoney } from '@/lib/format';
import { CLAIM_KIND_LABEL } from '../safety-ui';
import { useInvalidateSafety } from '../useSafety';

/**
 * A claim with no accident behind it.
 *
 * Cargo soaked in a trailer, a windscreen on the interstate, a theft off the yard: real claims
 * that never produced an accident report. Until now the only way to open one was to invent an
 * accident, which put a collision on a driver's record that never happened.
 *
 * What it asks for is what only a person knows — the cover, the insurer, what happened and what to
 * reserve. Unit, driver and load are offered because a claim usually concerns one of them, and
 * each is searchable rather than typed: a claim that names "2701" as text cannot be reconciled
 * against anything.
 */
export function CreateStandaloneClaimDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (claim: Claim) => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();

  const [kind, setKind] = useState<string>('cargo');
  const [insurer, setInsurer] = useState('');
  const [description, setDescription] = useState('');
  const [reserve, setReserve] = useState('');
  const [deductible, setDeductible] = useState('');
  const [truckId, setTruckId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [loadId, setLoadId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trucks = useQuery({
    queryKey: ['trucks', 'claim'],
    queryFn: () => listTrucks({ pageSize: 10_000 }),
  });
  const drivers = useQuery({
    queryKey: ['drivers', 'claim'],
    queryFn: () => listDrivers({ pageSize: 10_000 }),
  });
  const loads = useQuery({
    queryKey: ['loads', 'claim'],
    queryFn: () => listLoads({ pageSize: 100 }),
  });

  const create = useMutation({
    mutationFn: () =>
      createStandaloneClaim({
        kind: kind as Claim['kind'],
        insurer,
        description,
        reserveAmount: parseMoney(reserve),
        deductible: parseMoney(deductible),
        notes: notes.trim() ? notes.trim() : null,
        truckId,
        driverId,
        loadId,
      }),
    onSuccess: async (claim) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `${claim.claimNumber} opened with ${claim.insurer}`,
        description: 'Our own record. Nothing has been sent to the insurer.',
      });
      onDone(claim);
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The claim could not be opened.'),
  });

  const valid = insurer.trim() !== '' && description.trim() !== '';

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="md"
      title="Create claim without an accident"
      description="For a loss with no accident report behind it. Our own record; nothing is sent to the insurer."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!valid}
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
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not opened">
            {error}
          </Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Cover" required>
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
              onChange={(event) => setInsurer(event.target.value)}
              placeholder="Great West Casualty"
            />
          </FormField>
        </div>

        <FormField
          label="What happened"
          required
          description="What the claim is for, in a sentence."
        >
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Reefer failed overnight; load of produce rejected at the receiver"
          />
        </FormField>

        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Unit" description="Optional.">
            <Combobox
              aria-label="Unit"
              options={(trucks.data?.data ?? []).map((truck) => ({
                value: truck.id,
                label: `Unit ${truck.unitNumber}`,
                description: `${truck.year} ${truck.make}`,
              }))}
              value={truckId}
              onValueChange={setTruckId}
              placeholder="None"
              searchPlaceholder="Type a unit number…"
              emptyMessage="No unit matches"
              loading={trucks.isPending}
            />
          </FormField>
          <FormField label="Driver" description="Optional.">
            <Combobox
              aria-label="Driver"
              options={(drivers.data?.data ?? []).map((driver) => ({
                value: driver.id,
                label: driver.name,
                description: driver.driverNumber,
              }))}
              value={driverId}
              onValueChange={setDriverId}
              placeholder="None"
              searchPlaceholder="Type a name…"
              emptyMessage="No driver matches"
              loading={drivers.isPending}
            />
          </FormField>
          <FormField label="Load" description="Optional.">
            <Combobox
              aria-label="Load"
              options={(loads.data?.data ?? []).map((load) => ({
                value: load.id,
                label: load.loadNumber,
                description: `${load.origin.city} → ${load.destination.city}`,
              }))}
              value={loadId}
              onValueChange={setLoadId}
              placeholder="None"
              searchPlaceholder="Type a load number…"
              emptyMessage="No load matches"
              loading={loads.isPending}
            />
          </FormField>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label="Reserve"
            description="What to set aside. Leave blank if it is not known yet."
          >
            <Input
              inputMode="decimal"
              value={reserve}
              onChange={(event) => setReserve(event.target.value)}
              placeholder="$5,000.00"
            />
          </FormField>
          <FormField label="Deductible">
            <Input
              inputMode="decimal"
              value={deductible}
              onChange={(event) => setDeductible(event.target.value)}
              placeholder="$2,500.00"
            />
          </FormField>
        </div>

        <FormField label="Notes">
          <Textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
