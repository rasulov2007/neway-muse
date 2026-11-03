import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  listDrivers,
  ownerShareOf,
  setWorkOrderBilling,
  suggestWorkOrderBilling,
  type RepairOrder,
} from '@/demo';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Combobox, FormField, Input, Tabs, useToast } from '@/design-system';
import { formatMoney } from '@/lib/format';
import { useInvalidateFleet } from '../useFleet';

/**
 * Who pays for this repair.
 *
 * Owner-operator and lease-operator repairs are the driver's cost. The default comes from the
 * unit's ownership and says where it came from, so the person can see why - and change it. A
 * split keeps part with the company and needs a note; the owner's share becomes a deduction on
 * their settlement, linked both ways.
 */
export function WorkOrderBillingPanel({ order }: { order: RepairOrder }) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const suggestion = suggestWorkOrderBilling(order);
  const billing = order.billing ?? null;
  const [party, setParty] = useState<'company' | 'owner'>(billing?.party ?? suggestion.party);
  const [driverId, setDriverId] = useState<string | null>(
    billing?.ownerDriverId ?? suggestion.ownerDriverId,
  );
  const [companyAmount, setCompanyAmount] = useState(
    billing?.companyAmount === null || billing?.companyAmount === undefined
      ? ''
      : String(billing.companyAmount),
  );
  const [note, setNote] = useState(billing?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const drivers = useQuery({
    queryKey: ['drivers', 'all'],
    queryFn: () => listDrivers({ pageSize: 10_000, sort: 'name' }),
  });
  const driverOptions = (drivers.data?.data ?? []).map((d) => ({
    value: d.id,
    label: d.name,
    description: `${d.driverNumber} · ${d.driverType.replace(/_/g, ' ')}`,
  }));

  const kept = companyAmount.trim() === '' ? null : Number(companyAmount.replace(/[^0-9.]/g, ''));
  const ownerShare = party === 'owner' ? Math.max(order.total - (kept ?? 0), 0) : 0;

  const save = useMutation({
    mutationFn: () =>
      setWorkOrderBilling({
        orderId: order.id,
        party,
        ownerDriverId: driverId,
        companyAmount: kept,
        note,
      }),
    onSuccess: async (saved) => {
      await invalidate();
      toast({
        tone: 'success',
        title:
          saved.billing?.party === 'owner'
            ? `${saved.roNumber} billed to ${saved.billing.ownerDriverName}`
            : `${saved.roNumber} billed to the company`,
        description:
          ownerShare > 0
            ? `${formatMoney(ownerShare)} goes to their settlement as a deduction.`
            : undefined,
      });
      setError(null);
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The billing could not be saved'),
  });

  const charged = ownerShareOf(order);

  return (
    <div className="flex flex-col gap-3">
      {billing ? null : (
        <Alert
          tone="info"
          title={`Suggested: ${suggestion.party === 'owner' ? suggestion.ownerDriverName : 'the company'}`}
          description={`Because ${suggestion.suggestedFrom}. Change it if that is not who pays.`}
        />
      )}
      <Tabs
        variant="segmented"
        items={[
          { value: 'company', label: 'Company' },
          { value: 'owner', label: 'Owner / driver' },
        ]}
        value={party}
        onValueChange={(next) => setParty(next as 'company' | 'owner')}
        aria-label="Bill to"
      />
      {party === 'owner' ? (
        <>
          <FormField label="Billed to" required>
            <Combobox
              options={driverOptions}
              value={driverId}
              onValueChange={setDriverId}
              placeholder={drivers.isPending ? 'Loading…' : 'Choose the driver'}
              searchPlaceholder="Type a name…"
              emptyMessage="No driver matches"
              loading={drivers.isPending}
            />
          </FormField>
          <FormField
            label="Company keeps"
            description="Leave empty and the whole amount goes to the driver. Anything here is a split."
          >
            <Input
              value={companyAmount}
              onChange={(e) => setCompanyAmount(e.target.value)}
              inputMode="decimal"
              prefix="$"
              placeholder="0.00"
            />
          </FormField>
          {kept !== null && kept > 0 ? (
            <FormField label="Why it is split" required>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Company covers the tyres, driver covers the damage"
              />
            </FormField>
          ) : null}
          <p className="text-sm text-secondary">
            {formatMoney(ownerShare)} to the driver
            {kept ? `, ${formatMoney(kept)} to the company` : ''} of {formatMoney(order.total)}.
          </p>
        </>
      ) : (
        <p className="text-sm text-secondary">
          The company pays all {formatMoney(order.total)} of this repair; it counts in fleet spend.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>
          Save billing
        </Button>
        {charged > 0 && billing?.ownerDriverId ? (
          <Link
            to="/drivers/$driverId"
            params={{ driverId: billing.ownerDriverId }}
            className="text-sm font-semibold text-nw-accent-ink hover:underline"
          >
            {formatMoney(charged)} on {billing.ownerDriverName}&rsquo;s settlement
          </Link>
        ) : null}
      </div>
    </div>
  );
}
