import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, FormField, Input, Modal, Select, useToast } from '@/design-system';
import { createFuelTransaction } from '@/demo';
import { formatMiles, formatMoney } from '@/lib/format';
import { useInvalidateFleet, type FleetTruck } from '../useFleet';

/**
 * Records one fill by hand.
 *
 * The odometer field is not optional in spirit even though the record allows a zero: without it
 * the fill contributes to spend but to no MPG and no cost per mile, so the form says as much
 * rather than letting someone leave it blank and wonder later why the unit has no economy figure.
 */
export function AddFuelDialog({
  open,
  onOpenChange,
  trucks,
  onDone,
  defaultTruckId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trucks: FleetTruck[];
  onDone: () => void;
  defaultTruckId?: string;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();

  const [truckId, setTruckId] = useState(defaultTruckId ?? '');
  const [product, setProduct] = useState<'diesel' | 'def'>('diesel');
  const [gallons, setGallons] = useState('');
  const [price, setPrice] = useState('');
  const [odometer, setOdometer] = useState('');
  const [brand, setBrand] = useState('');
  const [station, setStation] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [card, setCard] = useState('');
  const [error, setError] = useState<string | null>(null);

  const truck = trucks.find((row) => row.truck.id === truckId);
  const amount = Number(gallons) * Number(price);

  const create = useMutation({
    mutationFn: () =>
      createFuelTransaction({
        truckId,
        driverId: truck?.truck.currentDriverId ?? null,
        loadId: truck?.truck.currentLoadId ?? null,
        at: new Date().toISOString(),
        station: {
          brand: brand.trim(),
          name: station.trim() || brand.trim(),
          city: city.trim(),
          state: state.trim().toUpperCase(),
        },
        product,
        gallons: Number(gallons),
        pricePerGallon: Number(price),
        odometer: odometer ? Number(odometer) : 0,
        cardLast4: card.trim(),
      }),
    onSuccess: async (transaction) => {
      await invalidate();
      toast({
        tone: transaction.anomalyFlags.length > 0 ? 'warning' : 'success',
        title: `Fill recorded on unit ${transaction.unitNumber}`,
        description:
          transaction.anomalyFlags.length > 0
            ? `Flagged: ${transaction.anomalyFlags.join(', ').replace(/_/g, ' ')}.`
            : `${transaction.gallons.toFixed(1)} gal · ${formatMoney(transaction.amount)}`,
      });
      onDone();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The fill could not be recorded.'),
  });

  const valid =
    truckId !== '' &&
    Number(gallons) > 0 &&
    Number(price) > 0 &&
    brand.trim() !== '' &&
    city.trim() !== '' &&
    /^[A-Za-z]{2}$/.test(state.trim());

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Add fuel transaction"
      description="For a fill that did not come through the card feed."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
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
            Record fill
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

        <FormField label="Truck" required>
          <Select
            options={trucks.map((row) => ({
              value: row.truck.id,
              label: `${row.truck.unitNumber} — ${row.truck.currentDriverName ?? 'unassigned'}`,
            }))}
            value={truckId}
            onValueChange={setTruckId}
            placeholder="Pick a unit"
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Product">
            <Select
              options={[
                { value: 'diesel', label: 'Diesel' },
                { value: 'def', label: 'DEF' },
              ]}
              value={product}
              onValueChange={(value) => setProduct(value as 'diesel' | 'def')}
            />
          </FormField>
          <FormField label="Gallons" required>
            <Input
              inputMode="decimal"
              value={gallons}
              onChange={(e) => setGallons(e.target.value)}
            />
          </FormField>
          <FormField label="Price per gallon" required>
            <Input prefix="$" money={false} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </FormField>
        </div>

        {amount > 0 ? (
          <p className="text-sm text-secondary">
            Total <span className="font-semibold text-ink">{formatMoney(amount)}</span>
          </p>
        ) : null}

        <FormField
          label="Odometer"
          description={
            truck
              ? `Last recorded ${formatMiles(truck.truck.odometer)}. Without a reading this fill counts toward spend but produces no MPG and no cost per mile.`
              : 'Without a reading this fill counts toward spend but produces no MPG and no cost per mile.'
          }
        >
          <Input
            inputMode="numeric"
            value={odometer}
            onChange={(e) => setOdometer(e.target.value)}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Vendor" required>
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Pilot" />
          </FormField>
          <FormField label="Station" description="Optional.">
            <Input
              value={station}
              onChange={(e) => setStation(e.target.value)}
              placeholder="Pilot #412"
            />
          </FormField>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_5rem_7rem] gap-3">
          <FormField label="City" required>
            <Input value={city} onChange={(e) => setCity(e.target.value)} />
          </FormField>
          <FormField label="State" required>
            <Input
              value={state}
              onChange={(e) => setState(e.target.value)}
              maxLength={2}
              className="uppercase"
            />
          </FormField>
          <FormField label="Card last 4">
            <Input value={card} onChange={(e) => setCard(e.target.value)} maxLength={4} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
