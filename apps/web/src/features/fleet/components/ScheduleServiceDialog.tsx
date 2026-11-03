import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Button,
  Combobox,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  useToast,
} from '@/design-system';
import {
  listFleetVendors,
  maintenanceTypeLabel,
  scheduleService,
  type MaintenanceType,
} from '@/demo';
import { formatMiles } from '@/lib/format';
import { useInvalidateFleet, type FleetTruck } from '../useFleet';
import { VendorFormDialog } from './VendorFormDialog';

/** A picked date as the `YYYY-MM-DD` the records store, in local time rather than UTC. */
function toIsoDate(date: Date | null): string {
  if (!date) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Books a service against one unit.
 *
 * This dialog only ever opens from inside a unit — there is no global "schedule maintenance"
 * button, because a service booking with no unit attached is not a booking. The type list is the
 * unit's own PM schedule where it has one, so booking an oil change updates the oil-change row
 * rather than creating a second, competing answer to when that unit is due.
 */

const FALLBACK_TYPES: MaintenanceType[] = [
  'pm_service',
  'oil_change',
  'brake_inspection',
  'tire_rotation',
  'dot_inspection',
  'coolant',
  'transmission',
  'engine',
  'dpf',
  'battery',
  'electrical',
  'other',
];

export interface ScheduleServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  truck: FleetTruck;
  onDone: () => void;
}

export function ScheduleServiceDialog({
  open,
  onOpenChange,
  truck,
  onDone,
}: ScheduleServiceDialogProps) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();

  const scheduled = truck.schedule.filter((item) => item.status !== 'ok');
  const options = (scheduled.length > 0 ? scheduled : truck.schedule).map((item) => ({
    value: item.id,
    label: `${item.typeLabel} — ${item.milesUntilDue <= 0 ? `${formatMiles(Math.abs(item.milesUntilDue))} over` : `${formatMiles(item.milesUntilDue)} to go`}`,
  }));

  const [itemId, setItemId] = useState<string>(options[0]?.value ?? '');
  const [type, setType] = useState<MaintenanceType>(truck.truck.nextServiceType);
  const [date, setDate] = useState<Date | null>(null);
  /*
   * The shop is picked, never typed (acceptance test A15).
   *
   * Free text here is how one shop became four rows: "TA Truck", "TA Truck Service",
   * "trailer rtire shop". Every one of them split that shop's spend, so the vendor ranking was
   * wrong and no page could say what a shop had cost. A name that has no record yet opens the
   * vendor form, so the booking still happens - it just leaves a record behind instead of a string.
   */
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [newVendorName, setNewVendorName] = useState<string | null>(null);
  const vendors = useQuery({ queryKey: ['vendors', 'options'], queryFn: () => listFleetVendors() });
  const vendorOptions = useMemo(
    () =>
      (vendors.data ?? []).map((v) => ({
        value: v.id,
        label: v.name,
        description: [
          v.city && v.state ? `${v.city}, ${v.state}` : v.city,
          v.kind.replace(/_/g, ' '),
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    [vendors.data],
  );
  const vendor = (vendors.data ?? []).find((v) => v.id === vendorId) ?? null;
  const [dueOdometer, setDueOdometer] = useState<string>(String(truck.truck.nextServiceOdometer));
  const [error, setError] = useState<string | null>(null);

  const selectedItem = truck.schedule.find((item) => item.id === itemId);

  const book = useMutation({
    mutationFn: () =>
      scheduleService({
        truckId: truck.truck.id,
        maintenanceItemId: itemId || null,
        type: selectedItem?.type ?? type,
        scheduledFor: toIsoDate(date),
        vendorName: vendor?.name ?? null,
        vendorId: vendor?.id ?? null,
        nextDueOdometer: dueOdometer ? Number(dueOdometer) : null,
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.blocked ?? 'The service could not be booked.');
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: `Service booked for unit ${truck.truck.unitNumber}`,
        description: `${maintenanceTypeLabel(selectedItem?.type ?? type)} on ${toIsoDate(date)}.`,
      });
      onDone();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The service could not be booked.'),
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Schedule maintenance — unit ${truck.truck.unitNumber}`}
      description="Booking a service updates both the unit's next-service date and the PM row it belongs to, so the trucks list and the maintenance list cannot drift apart."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={book.isPending}
            disabled={!date}
            onClick={() => {
              setError(null);
              book.mutate();
            }}
          >
            Book service
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

        {options.length > 0 ? (
          <FormField
            label="Service"
            description="From this unit's own PM schedule, so the booking lands on the right row."
          >
            <Select options={options} value={itemId} onValueChange={setItemId} />
          </FormField>
        ) : (
          <FormField label="Service" description="This unit has no PM schedule yet.">
            <Select
              options={FALLBACK_TYPES.map((value) => ({
                value,
                label: maintenanceTypeLabel(value),
              }))}
              value={type}
              onValueChange={(value) => setType(value as MaintenanceType)}
            />
          </FormField>
        )}

        <FormField label="Date" required>
          <DatePicker
            value={date}
            onChange={(next) => setDate(next ?? null)}
            placeholder="Pick a date"
          />
        </FormField>

        <FormField
          label="Due odometer"
          description="Leave as is unless the shop agreed a different mileage."
        >
          <Input
            inputMode="numeric"
            value={dueOdometer}
            onChange={(e) => setDueOdometer(e.target.value)}
          />
        </FormField>

        <FormField
          label="Shop"
          description="Optional. Picked from the vendor list, so one shop stays one record."
        >
          <Combobox
            aria-label="Shop"
            options={vendorOptions}
            value={vendorId}
            onValueChange={setVendorId}
            onCreate={(typed) => setNewVendorName(typed)}
            createLabel={(typed) => `+ Create vendor "${typed}"`}
            placeholder="Search vendors…"
            searchPlaceholder="Name, city or type"
            emptyMessage="No vendor matches"
            loading={vendors.isPending}
          />
        </FormField>

        {newVendorName !== null ? (
          <VendorFormDialog
            name={newVendorName}
            onClose={() => setNewVendorName(null)}
            onSaved={(created) => {
              setNewVendorName(null);
              void vendors.refetch().then(() => setVendorId(created.id));
            }}
          />
        ) : null}
      </div>
    </Modal>
  );
}
