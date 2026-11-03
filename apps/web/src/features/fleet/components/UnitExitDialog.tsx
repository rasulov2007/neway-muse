import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  DatePicker,
  FormField,
  IconButton,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import {
  DAMAGE_PARTS,
  EXIT_REASON_FIELDS,
  UNIT_EXIT_REASON_LABEL,
  listDrivers,
  recordUnitExit,
  updateUnitExit,
  type UnitContentItem,
  type UnitExitRecord,
  type UnitDamageItem,
  type UnitExitReason,
} from '@/demo';
import { today as companyToday } from '@/lib/clock';
import { FormBlock } from '@/features/forms/FormBlock';
import { formatMoney } from '@/lib/format';
import { useFleet, useInvalidateFleet } from '../useFleet';

/**
 * Taking a unit off the road, and saying what happened to it.
 *
 * The reason decides the questions. A sale asks what it fetched and who bought it; a theft asks
 * what was inside and which police report it is on; a fire or a wreck asks what burned or broke,
 * and what the load in the trailer was worth. Everything here is typed by a person — nothing is
 * inferred, and the running exposure at the bottom only adds up what has actually been entered.
 */
export function UnitExitDialog({
  entity,
  unitId,
  unitNumber,
  toStatus,
  actionLabel,
  existing = null,
  onClose,
}: {
  entity: 'truck' | 'trailer';
  unitId: string;
  unitNumber: string;
  toStatus: string;
  actionLabel: string;
  /** An account already on file: the dialog fills it in and saves changes to it (owner, 2026-10-10). */
  existing?: UnitExitRecord | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const today = companyToday();

  const [reason, setReason] = useState<UnitExitReason>(existing?.reason ?? 'mechanical');
  const [occurredOn, setOccurredOn] = useState(existing?.occurredOn ?? today);
  const [narrative, setNarrative] = useState(existing?.narrative ?? '');
  /*
   * The odometer and the driver are prefilled from the unit (acceptance test A13).
   *
   * Whoever takes a truck off the road is standing next to a problem, not next to a record. Asking
   * them to go and look up the mileage is how the field ends up empty, and an exit with no
   * odometer cannot be costed afterwards. Both stay editable: the prefill is a starting point, and
   * the person on the spot knows better than the record does.
   */
  const fleet = useFleet();
  const unit =
    entity === 'truck' ? (fleet.data?.trucks ?? []).find((row) => row.truck.id === unitId) : null;
  /** `null` means nobody has typed here yet, so the unit's own reading still stands. */
  const [odometerTyped, setOdometerTyped] = useState<string | null>(
    existing ? (existing.odometer === null ? '' : String(existing.odometer)) : null,
  );
  const odometer = odometerTyped ?? (unit?.truck.odometer ? String(unit.truck.odometer) : '');

  const [salePrice, setSalePrice] = useState(text(existing?.salePrice));
  const [buyer, setBuyer] = useState(existing?.buyer ?? '');
  const [titleTransferred, setTitleTransferred] = useState(existing?.titleTransferred ?? false);

  const [policeReport, setPoliceReport] = useState(existing?.policeReport ?? '');
  const [stolenFrom, setStolenFrom] = useState(existing?.stolenFrom ?? '');
  const [recovered, setRecovered] = useState(existing?.recovered ?? false);

  const [contents, setContents] = useState<UnitContentItem[]>(existing?.contents ?? []);
  const [damage, setDamage] = useState<UnitDamageItem[]>(existing?.damage ?? []);
  const [injuries, setInjuries] = useState(existing?.injuries ?? false);
  const [driverPicked, setDriverPicked] = useState<string | null>(
    existing ? (existing.driverId ?? '') : null,
  );
  const driverId = driverPicked ?? unit?.truck.currentDriverId ?? '';

  const [claimNumber, setClaimNumber] = useState(existing?.insuranceClaimNumber ?? '');
  const [insuredValue, setInsuredValue] = useState(text(existing?.insuredValue));
  const [deductible, setDeductible] = useState(text(existing?.deductible));
  const [expectedRecovery, setExpectedRecovery] = useState(text(existing?.expectedRecovery));
  const [error, setError] = useState<string | null>(null);

  const drivers = useQuery({
    queryKey: ['drivers', 'unit-exit'],
    queryFn: () => listDrivers({ pageSize: 10_000 }),
  });
  const driverRows = drivers.data?.data ?? [];
  const asks = EXIT_REASON_FIELDS[reason];

  const num = (value: string) => (value.trim() === '' ? null : Number(value));
  const lost = contents
    .filter((item) => !item.recovered)
    .reduce((sum, item) => sum + item.value, 0);
  const repairs = damage.reduce((sum, item) => sum + item.estimate, 0);
  const recovery = num(expectedRecovery) ?? num(salePrice) ?? 0;
  const exposure = Math.round((lost + repairs - recovery) * 100) / 100;

  const save = useMutation({
    mutationFn: () => {
      const driver = driverRows.find((d) => d.id === driverId) ?? null;
      const fields = {
        occurredOn,
        reason,
        narrative,
        odometer: num(odometer),
        salePrice: asks.sale ? num(salePrice) : null,
        buyer: asks.sale ? buyer.trim() || null : null,
        titleTransferred: asks.sale ? titleTransferred : null,
        policeReport: asks.theft ? policeReport.trim() || null : null,
        stolenFrom: asks.theft ? stolenFrom.trim() || null : null,
        recovered: asks.theft ? recovered : null,
        contents: asks.contents ? contents.filter((item) => item.label.trim()) : [],
        damage: asks.damage ? damage.filter((item) => item.part.trim()) : [],
        injuries: asks.damage ? injuries : null,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? null,
        loadNumber: null,
        insuranceClaimNumber: asks.claim ? claimNumber.trim() || null : null,
        insuredValue: asks.claim ? num(insuredValue) : null,
        deductible: asks.claim ? num(deductible) : null,
        expectedRecovery: num(expectedRecovery) ?? (asks.sale ? num(salePrice) : null),
      };
      return existing
        ? updateUnitExit(existing.id, {
            ...fields,
            driverName: driver?.name ?? (driverId === existing.driverId ? existing.driverName : null),
            loadNumber: existing.loadNumber,
          })
        : recordUnitExit({ entity, unitId, unitNumber, toStatus, ...fields });
    },
    onSuccess: async (record) => {
      await invalidate();
      if (existing) {
        toast({ tone: 'success', title: `${record.unitNumber}: account saved` });
        onClose();
        return;
      }
      toast({
        tone: 'success',
        title: `${record.unitNumber} is ${record.toStatus.replace(/_/g, ' ')}`,
        description: `${UNIT_EXIT_REASON_LABEL[record.reason]} — recorded against the unit.`,
      });
      onClose();
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'That could not be recorded'),
  });

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="lg"
      title={existing ? `Edit — ${unitNumber}` : `${actionLabel} — ${unitNumber}`}
      description="What happened to this unit, in enough detail to answer an insurer or an auditor later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={existing ? 'primary' : 'danger'}
            loading={save.isPending}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {existing ? 'Save changes' : actionLabel}
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

        <FormBlock title="What happened">
          <FormField label="Reason" required>
            <Select
              options={Object.entries(UNIT_EXIT_REASON_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
              value={reason}
              onValueChange={(value) => setReason(value as UnitExitReason)}
            />
          </FormField>
          <FormField label="Date" required>
            <DatePicker value={occurredOn} onIsoChange={(e) => setOccurredOn(e)} />
          </FormField>
          <div className="sm:col-span-2">
            <FormField
              label="Account"
              required
              description="How it happened, in your own words. This is what gets read a year from now."
            >
              <Textarea
                rows={3}
                value={narrative}
                onChange={(e) => setNarrative(e.target.value)}
                placeholder={PLACEHOLDER[reason]}
              />
            </FormField>
          </div>
          <FormField label="Odometer">
            <Input
              inputMode="numeric"
              value={odometer}
              onChange={(e) => setOdometerTyped(e.target.value)}
              placeholder="482,000"
            />
          </FormField>
          <FormField label="Driver at the time">
            <Combobox
              options={driverRows.map((d) => ({
                value: d.id,
                label: `${d.name} · ${d.driverNumber}`,
              }))}
              value={driverId || null}
              onValueChange={(value) => setDriverPicked(value ?? '')}
              placeholder="Nobody / unassigned"
              searchPlaceholder="Type a driver name…"
              emptyMessage="No driver matches"
              loading={drivers.isPending}
            />
          </FormField>
        </FormBlock>

        {asks.sale ? (
          <FormBlock title="The sale">
            <FormField label="Sale price" required>
              <Input
                inputMode="decimal"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
                placeholder="38000"
              />
            </FormField>
            <FormField label="Buyer">
              <Input
                value={buyer}
                onChange={(e) => setBuyer(e.target.value)}
                placeholder="Midwest Truck Sales"
              />
            </FormField>
            <div className="sm:col-span-2">
              <Checkbox
                checked={titleTransferred}
                onCheckedChange={(next) => setTitleTransferred(next === true)}
                label="Title has been signed over"
              />
            </div>
          </FormBlock>
        ) : null}

        {asks.theft ? (
          <FormBlock title="The theft">
            <FormField label="Police report number">
              <Input
                value={policeReport}
                onChange={(e) => setPoliceReport(e.target.value)}
                placeholder="CPD-2026-88142"
              />
            </FormField>
            <FormField label="Taken from">
              <Input
                value={stolenFrom}
                onChange={(e) => setStolenFrom(e.target.value)}
                placeholder="Truck stop, Gary IN"
              />
            </FormField>
            <FormField label="Unit found">
              <div role="radiogroup" aria-label="Unit found" className="flex flex-wrap gap-2">
                {([true, false] as const).map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    role="radio"
                    aria-checked={recovered === value}
                    onClick={() => setRecovered(value)}
                    className={
                      recovered === value
                        ? value
                          ? 'inline-flex h-9 items-center rounded-md border border-nw-done-text bg-nw-done-bg px-4 text-sm font-semibold text-nw-done-text'
                          : 'inline-flex h-9 items-center rounded-md border border-nw-urgent-text bg-nw-urgent-bg px-4 text-sm font-semibold text-nw-urgent-text'
                        : 'inline-flex h-9 items-center rounded-md border border-nw-border bg-nw-panel px-4 text-sm text-nw-text-2 hover:bg-nw-hover'
                    }
                  >
                    {value ? 'Yes' : 'No'}
                  </button>
                ))}
              </div>
            </FormField>
          </FormBlock>
        ) : null}

        {asks.contents ? (
          <FormBlock
            title="What was in it"
            hint="Freight, tools, the driver's own property — anything that went with the unit."
          >
            <div className="flex flex-col gap-2 sm:col-span-2">
              {contents.map((item, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[minmax(0,1fr)_7rem_auto_2rem] items-center gap-2"
                >
                  <Input
                    aria-label="What it was"
                    value={item.label}
                    placeholder="Pallet jack"
                    onChange={(e) =>
                      setContents((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, label: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label="Value"
                    inputMode="decimal"
                    value={item.value === 0 ? '' : String(item.value)}
                    placeholder="0"
                    onChange={(e) =>
                      setContents((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, value: Number(e.target.value) || 0 } : row,
                        ),
                      )
                    }
                  />
                  <Checkbox
                    checked={item.recovered}
                    onCheckedChange={(next) =>
                      setContents((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, recovered: next === true } : row,
                        ),
                      )
                    }
                    label="Recovered"
                  />
                  <IconButton
                    label={`Remove item ${index + 1}`}
                    variant="ghost"
                    size="sm"
                    onClick={() => setContents((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <X />
                  </IconButton>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Plus />}
                onClick={() =>
                  setContents((rows) => [...rows, { label: '', value: 0, recovered: false }])
                }
              >
                Add what was in it
              </Button>
            </div>
          </FormBlock>
        ) : null}

        {asks.damage ? (
          <FormBlock
            title="What broke"
            hint="One row per part, with what it will cost to put right."
          >
            <div className="flex flex-col gap-2 sm:col-span-2">
              {damage.map((item, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[10rem_minmax(0,1fr)_7rem_auto_2rem] items-center gap-2"
                >
                  <Select
                    aria-label="Part"
                    options={[
                      { value: '', label: 'Part…' },
                      ...DAMAGE_PARTS.map((part) => ({ value: part, label: part })),
                    ]}
                    value={item.part}
                    onValueChange={(value) =>
                      setDamage((rows) =>
                        rows.map((row, i) => (i === index ? { ...row, part: value } : row)),
                      )
                    }
                  />
                  <Input
                    aria-label="Damage note"
                    value={item.note}
                    placeholder="Bent beyond repair"
                    onChange={(e) =>
                      setDamage((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, note: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label="Repair estimate"
                    inputMode="decimal"
                    value={item.estimate === 0 ? '' : String(item.estimate)}
                    placeholder="0"
                    onChange={(e) =>
                      setDamage((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, estimate: Number(e.target.value) || 0 } : row,
                        ),
                      )
                    }
                  />
                  <Checkbox
                    checked={item.repairable}
                    onCheckedChange={(next) =>
                      setDamage((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, repairable: next === true } : row,
                        ),
                      )
                    }
                    label="Repairable"
                  />
                  <IconButton
                    label={`Remove damage ${index + 1}`}
                    variant="ghost"
                    size="sm"
                    onClick={() => setDamage((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <X />
                  </IconButton>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Plus />}
                onClick={() =>
                  setDamage((rows) => [
                    ...rows,
                    { part: '', note: '', repairable: true, estimate: 0 },
                  ])
                }
              >
                Add what broke
              </Button>
              <Checkbox
                checked={injuries}
                onCheckedChange={(next) => setInjuries(next === true)}
                label="Somebody was hurt"
              />
            </div>
          </FormBlock>
        ) : null}

        {asks.claim ? (
          <FormBlock title="Insurance">
            <FormField label="Claim number">
              <Input
                value={claimNumber}
                onChange={(e) => setClaimNumber(e.target.value)}
                placeholder="CLM-2026-4471"
              />
            </FormField>
            <FormField label="Insured value">
              <Input
                inputMode="decimal"
                value={insuredValue}
                onChange={(e) => setInsuredValue(e.target.value)}
              />
            </FormField>
            <FormField label="Deductible">
              <Input
                inputMode="decimal"
                value={deductible}
                onChange={(e) => setDeductible(e.target.value)}
              />
            </FormField>
            <FormField label="Expected recovery" description="What you expect to get back.">
              <Input
                inputMode="decimal"
                value={expectedRecovery}
                onChange={(e) => setExpectedRecovery(e.target.value)}
              />
            </FormField>
          </FormBlock>
        ) : null}

        <div className="rounded-lg border border-line bg-surface-muted p-4">
          <h3 className="text-md font-bold text-ink">What this costs, on what you have entered</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Line label="Contents not recovered" value={formatMoney(lost)} />
            <Line label="Repair estimates" value={formatMoney(repairs)} />
            <Line label="Expected recovery" value={formatMoney(recovery)} />
            <Line
              label="Net exposure"
              value={formatMoney(exposure)}
              tone={exposure > 0 ? 'bad' : 'good'}
            />
          </dl>
          <p className="mt-2 text-xs text-muted">
            Nothing is estimated for you. A figure left blank counts as nothing, not as zero loss.
          </p>
        </div>
      </div>
    </Modal>
  );
}

const PLACEHOLDER: Record<UnitExitReason, string> = {
  sold: 'Sold at auction after the second engine failure.',
  stolen: 'Taken overnight from the fuel island; trailer left behind.',
  fire: 'Fire started at the APU and spread to the cab while parked.',
  accident: 'Rear-ended a stopped car on I-65; frame bent behind the cab.',
  totaled: 'Insurer declared a total loss after the rollover.',
  mechanical: 'Engine failed at 640,000 miles; not worth a rebuild.',
  lease_returned: 'Lease term ended; returned to the lessor with normal wear.',
  age_retired: 'Retired on mileage as part of the fleet replacement plan.',
  other: 'What happened, in your own words.',
};

function Line({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-secondary">{label}</dt>
      <dd
        className={
          tone === 'bad'
            ? 'tabular font-medium text-danger-text'
            : tone === 'good'
              ? 'tabular font-medium text-success-text'
              : 'tabular font-medium text-ink'
        }
      >
        {value}
      </dd>
    </div>
  );
}

/** A stored number as the text an input holds; nothing stays blank. */
function text(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}
