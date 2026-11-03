import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { listDrivers, listTrailers, listTrucks, loadWriteMessage, type Load } from '@/demo';
import { assertDispatchAllowed, isDispatchBlocked } from '@/demo/dispatch-guard';
import { Button, Combobox, FormField, Modal, useToast } from '@/design-system';
import { apiPost } from '@/lib/api-client';

const ALL = 1000;

/**
 * Assign from the load page (owner, 2026-10-20): an unassigned load gets its driver here without
 * opening the whole edit form. Picking the driver fills the unit they are on; truck and trailer
 * stay editable. Same server door as the edit form (POST /loads/:id/assignment).
 */
export function AssignDriverDialog({ load, onClose }: { load: Load; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const drivers = useQuery({ queryKey: ['drivers', 'picker'], queryFn: () => listDrivers({ pageSize: ALL }) });
  const trucks = useQuery({ queryKey: ['trucks', 'picker'], queryFn: () => listTrucks({ pageSize: ALL }) });
  const trailers = useQuery({ queryKey: ['trailers', 'picker'], queryFn: () => listTrailers({ pageSize: ALL }) });
  const [driverId, setDriverId] = useState<string | null>(null);
  const [truckId, setTruckId] = useState<string | null>(load.truckId ?? null);
  const [trailerId, setTrailerId] = useState<string | null>(load.trailerId ?? null);

  const driverRows = drivers.data?.data ?? [];
  const driverOptions = driverRows.map((d) => ({ value: d.id, label: `${d.name} · ${d.driverNumber}`, description: d.currentTruckUnit ? `Unit ${d.currentTruckUnit}` : 'No unit assigned' }));
  const truckOptions = (trucks.data?.data ?? []).map((t) => ({ value: t.id, label: t.unitNumber, description: [t.make, t.model].filter(Boolean).join(' ') || undefined }));
  const trailerOptions = (trailers.data?.data ?? []).map((t) => ({ value: t.id, label: t.unitNumber, description: t.type }));

  const chooseDriver = (id: string | null) => {
    setDriverId(id);
    const d = driverRows.find((x) => x.id === id);
    if (d?.currentTruckId) setTruckId(d.currentTruckId);
    if (d?.currentTrailerId) setTrailerId(d.currentTrailerId);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (truckId) await assertDispatchAllowed({ id: truckId, unitNumber: truckOptions.find((t) => t.value === truckId)?.label ?? truckId }, { ref: load.loadNumber }, null);
      const driver = driverRows.find((d) => d.id === driverId);
      return apiPost(`/loads/${encodeURIComponent(load.id)}/assignment`, {
        driverId,
        driverName: driver?.name ?? null,
        truckId,
        truckUnit: truckOptions.find((t) => t.value === truckId)?.label ?? null,
        trailerId,
        trailerUnit: trailerOptions.find((t) => t.value === trailerId)?.label ?? null,
        expectedUpdatedAt: load.updatedAt,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['load'] }),
        queryClient.invalidateQueries({ queryKey: ['loads'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ]);
      toast({ tone: 'success', title: `${load.loadNumber} assigned`, description: driverRows.find((d) => d.id === driverId)?.name });
      onClose();
    },
    onError: (err) =>
      toast({
        tone: 'danger',
        title: 'Not assigned',
        description: isDispatchBlocked(err) ? `${err.message} Use Edit load to dispatch it with an override.` : loadWriteMessage(err, 'Try again.'),
      }),
  });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Assign ${load.loadNumber}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!driverId} loading={save.isPending} onClick={() => save.mutate()} data-testid="assign-driver-save">
            Assign
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Driver" required>
          <Combobox options={driverOptions} value={driverId} onValueChange={chooseDriver} loading={drivers.isLoading} placeholder="Pick the driver" searchPlaceholder="Type a driver name or number…" emptyMessage="No driver matches" />
        </FormField>
        <FormField label="Truck" description="Filled from the driver's unit; change it if needed.">
          <Combobox options={truckOptions} value={truckId} onValueChange={setTruckId} loading={trucks.isLoading} placeholder="No truck" searchPlaceholder="Type a unit number…" emptyMessage="No truck matches" />
        </FormField>
        <FormField label="Trailer">
          <Combobox options={trailerOptions} value={trailerId} onValueChange={setTrailerId} loading={trailers.isLoading} placeholder="No trailer" searchPlaceholder="Type a trailer number…" emptyMessage="No trailer matches" />
        </FormField>
      </div>
    </Modal>
  );
}
