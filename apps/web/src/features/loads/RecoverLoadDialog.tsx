import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { listDrivers, listTrucks, recoverLoad, splitLoadForRecovery, type Load } from '@/demo';
import { isDispatchBlocked, type DispatchBlockedError } from '@/demo/dispatch-guard';
import { Button, FormField, Input, Modal, Select, Textarea, useToast } from '@/design-system';
import { DispatchOverrideDialog } from '@/features/fleet/pti/DispatchOverrideDialog';
import { formatMoney, formatNumber } from '@/lib/format';

/**
 * Recovering a load.
 *
 * A truck breaks down, a driver runs out of hours, and the freight still has to move: somebody
 * else takes it from where it is. Two facts have to be captured at that moment, because nobody
 * can reconstruct them later — who is taking it, and how far the first driver actually got. The
 * second one is the money: it decides how the linehaul divides, and the desk sees that division
 * here, before committing it, rather than as a surprise on a settlement three weeks later.
 */
const ALL = 10_000;

export function RecoverLoadDialog({
  load,
  open,
  onOpenChange,
}: {
  load: Load;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [driverId, setDriverId] = useState('');
  const [truckId, setTruckId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Tracking usually knows how far in they are; the desk corrects it from the phone call.
  const [miles, setMiles] = useState(() =>
    String(Math.max(0, load.loadedMiles - (load.milesRemaining ?? 0))),
  );

  const drivers = useQuery({
    queryKey: ['drivers', 'picker'],
    queryFn: () => listDrivers({ pageSize: ALL, sort: 'name' }),
  });
  const trucks = useQuery({
    queryKey: ['trucks', 'picker'],
    queryFn: () => listTrucks({ pageSize: ALL }),
  });

  const pickedDriver = (drivers.data?.data ?? []).find((d) => d.id === driverId);
  const pickedTruck = (trucks.data?.data ?? []).find((t) => t.id === truckId);
  const milesCompleted = Number(miles);

  /*
   * The preview runs the same function the write runs, so what the desk approves here is exactly
   * what posts. A preview computed a second way is a preview that can lie.
   */
  const preview = useMemo(() => {
    const linehaul = load.charges?.find((c) => c.type === 'linehaul')?.amount ?? load.rate ?? 0;
    return splitLoadForRecovery({
      loadedMiles: load.loadedMiles,
      emptyMiles: load.emptyMiles,
      linehaul,
      milesCompleted: Number.isFinite(milesCompleted) ? milesCompleted : 0,
      outgoing: {
        driverId: load.driverId,
        driverName: load.driverName,
        truckId: load.truckId,
        unitNumber: load.truckUnit,
      },
      incoming: {
        driverId: pickedDriver?.id ?? null,
        driverName: pickedDriver?.name ?? null,
        truckId: pickedTruck?.id ?? null,
        unitNumber: pickedTruck?.unitNumber ?? null,
      },
      reason,
      at: new Date().toISOString(),
      existing: load.segments,
    }).slice(-2);
  }, [load, milesCompleted, pickedDriver, pickedTruck, reason]);

  // The unit is held (§9.1): the store refused, the dialog asks why it is going out anyway.
  const [blocked, setBlocked] = useState<DispatchBlockedError | null>(null);

  const recover = useMutation({
    mutationFn: (override?: string) =>
      recoverLoad({
        loadId: load.id,
        driverId: driverId || null,
        truckId: truckId || null,
        dispatchOverride: override ? { reason: override } : null,
        reason: reason.trim(),
        milesCompleted,
      }),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['loads'] }),
        queryClient.invalidateQueries({ queryKey: ['load'] }),
        queryClient.invalidateQueries({ queryKey: ['settlements'] }),
        queryClient.invalidateQueries({ queryKey: ['accounting'] }),
      ]);
      toast({
        tone: 'success',
        title: `${updated.loadNumber} recovered`,
        description: `${formatMoney(preview[0]?.linehaulRevenue ?? 0)} and ${formatMoney(
          preview[1]?.linehaulRevenue ?? 0,
        )} are waiting on the two drivers' settlements.`,
      });
      onOpenChange(false);
    },
    onError: (err: unknown, override) => {
      if (isDispatchBlocked(err) && !override) {
        setBlocked(err);
        return;
      }
      setError(err instanceof Error ? err.message : 'The load could not be recovered.');
    },
  });

  const driverOptions = [
    { value: '', label: 'Nobody yet — put it back on the board' },
    ...(drivers.data?.data ?? [])
      .filter((d) => d.id !== load.driverId)
      .map((d) => ({ value: d.id, label: `${d.name} · ${d.driverNumber}` })),
  ];
  const truckOptions = [
    { value: '', label: 'No truck' },
    ...(trucks.data?.data ?? [])
      .filter((t) => t.id !== load.truckId)
      .map((t) => ({ value: t.id, label: `Unit ${t.unitNumber}` })),
  ];

  const milesValid =
    Number.isFinite(milesCompleted) && milesCompleted >= 0 && milesCompleted <= load.loadedMiles;
  const ready = reason.trim().length >= 3 && milesValid;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Recover ${load.loadNumber}`}
      description={`${load.origin.city}, ${load.origin.state} → ${load.destination.city}, ${load.destination.state} · ${formatNumber(load.loadedMiles)} loaded mi · ${formatMoney(load.rate)}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={recover.isPending}
            disabled={!ready}
            onClick={() => {
              setError(null);
              recover.mutate();
            }}
          >
            Recover and split pay
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Takes it over" description="The driver finishing the run.">
            <Select options={driverOptions} value={driverId} onValueChange={setDriverId} />
          </FormField>
          <FormField label="On truck">
            <Select options={truckOptions} value={truckId} onValueChange={setTruckId} />
          </FormField>
        </div>

        <FormField
          label="Miles completed"
          required
          description={`How far ${load.driverName ?? 'the outgoing driver'} got, measured from the start of the run.`}
          error={milesValid ? undefined : `Enter a number between 0 and ${load.loadedMiles}.`}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={load.loadedMiles}
            value={miles}
            onChange={(event) => setMiles(event.target.value)}
          />
        </FormField>

        <FormField
          label="What happened"
          required
          description="Recorded on the load and on both settlements, so the split can be explained."
        >
          <Textarea
            rows={2}
            value={reason}
            placeholder="Breakdown at MM 142 — unit 2703 towed, freight moved to 2711."
            onChange={(event) => setReason(event.target.value)}
          />
        </FormField>

        {/* What the desk is actually approving: the money, before it posts. */}
        <section aria-label="Pay split" className="rounded-lg border border-line-soft p-3">
          <p className="eyebrow mb-2">Pay split</p>
          <div className="flex flex-col gap-2">
            {preview.map((segment, index) => (
              <div
                key={segment.id}
                className="flex items-center justify-between gap-3 rounded-md border border-line-soft px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {index === 1 ? (
                    <ArrowRight aria-hidden className="size-4 shrink-0 text-faint" />
                  ) : (
                    <span aria-hidden className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {segment.driverName ?? 'Unassigned'}
                    </span>
                    <span className="block text-xs text-muted">
                      {formatNumber(segment.loadedMiles)} loaded mi
                      {segment.emptyMiles > 0 ? ` · ${formatNumber(segment.emptyMiles)} empty` : ''}
                    </span>
                  </span>
                </span>
                <span className="tabular shrink-0 text-sm font-semibold text-ink">
                  {formatMoney(segment.linehaulRevenue)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Each driver is paid for the miles they turn. Both lines land on their settlements as
            drafts for accounting to approve.
          </p>
        </section>

        {error ? (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-text"
          >
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            {error}
          </p>
        ) : null}
      </div>
      <DispatchOverrideDialog
        blocked={blocked}
        onCancel={() => setBlocked(null)}
        onOverride={(override) => recover.mutateAsync(override)}
      />
    </Modal>
  );
}
