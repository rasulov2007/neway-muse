import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Combobox, FormField, Modal, useToast } from '@/design-system';
import { assignDriverTruckRecord, listTrucks, type Driver } from '@/demo';

/**
 * Which truck a driver is in.
 *
 * The pairing had no screen at all: a driver could only be put in a unit at the moment the unit
 * was created, so a driver who changed trucks — which is most of them, most months — could not be
 * moved without editing the database.
 *
 * Both sides move together on the server, and anybody displaced is named here before it happens:
 * taking a unit that already has a driver in it takes that driver out, and saying so first is the
 * difference between a deliberate swap and a surprise.
 */
export function AssignTruckDialog({
  driver,
  onClose,
}: {
  driver: Pick<Driver, 'id' | 'name' | 'currentTruckId' | 'currentTruckUnit'>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [truckId, setTruckId] = useState<string | null>(driver.currentTruckId);
  const [error, setError] = useState<string | null>(null);

  const trucks = useQuery({
    queryKey: ['trucks', 'assignable'],
    queryFn: () => listTrucks({ pageSize: 10_000 }),
  });

  const rows = (trucks.data?.data ?? []).filter(
    (truck) => !['sold', 'inactive'].includes(truck.status),
  );
  const options = rows.map((truck) => ({
    value: truck.id,
    label: `Unit ${truck.unitNumber}`,
    description: truck.currentDriverName
      ? `${truck.status.replace(/_/g, ' ')} · currently ${truck.currentDriverName}`
      : `${truck.status.replace(/_/g, ' ')} · no driver`,
  }));
  const chosen = rows.find((truck) => truck.id === truckId) ?? null;
  const displaced =
    chosen?.currentDriverName && chosen.currentDriverId !== driver.id
      ? chosen.currentDriverName
      : null;

  const save = useMutation({
    mutationFn: (target: string | null) => assignDriverTruckRecord(driver.id, target),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['drivers'] }),
        queryClient.invalidateQueries({ queryKey: ['trucks'] }),
        queryClient.invalidateQueries({ queryKey: ['fleet'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ]);
      toast({
        tone: 'success',
        title: updated.currentTruckUnit
          ? `${driver.name} is in unit ${updated.currentTruckUnit}`
          : `${driver.name} has no truck`,
        description: driver.currentTruckUnit
          ? `Previously unit ${driver.currentTruckUnit}.`
          : undefined,
      });
      onClose();
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The assignment could not be saved'),
  });

  const unchanged = (truckId ?? null) === (driver.currentTruckId ?? null);

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      title={driver.currentTruckUnit ? 'Change truck' : 'Assign a truck'}
      description={
        driver.currentTruckUnit
          ? `${driver.name} is in unit ${driver.currentTruckUnit}.`
          : `${driver.name} has no truck.`
      }
      footer={
        <>
          {/* One click out of the truck (owner, 2026-10-12), instead of clearing the picker. */}
          {driver.currentTruckId ? (
            <Button
              variant="danger"
              className="mr-auto"
              loading={save.isPending && save.variables === null}
              disabled={save.isPending}
              onClick={() => {
                setError(null);
                save.mutate(null);
              }}
              data-testid="unassign-truck"
            >
              Unassign
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending && save.variables !== null}
            disabled={unchanged || save.isPending}
            onClick={() => {
              setError(null);
              save.mutate(truckId);
            }}
          >
            {truckId ? 'Assign' : 'Take out of the truck'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not saved">
            {error}
          </Alert>
        ) : null}

        <FormField
          label="Truck"
          description="Sold and inactive units are not listed. Clearing this takes the driver out of their truck."
        >
          <Combobox
            aria-label="Truck"
            options={options}
            value={truckId}
            onValueChange={setTruckId}
            placeholder={trucks.isPending ? 'Loading…' : 'No truck'}
            searchPlaceholder="Type a unit number…"
            emptyMessage="No unit matches"
            loading={trucks.isPending}
          />
        </FormField>

        {displaced ? (
          <Alert
            tone="warning"
            title={`${displaced} comes out of that unit`}
            description="A truck carries one driver. Assigning this one takes the other out; nothing else about them changes."
          />
        ) : null}
      </div>
    </Modal>
  );
}
