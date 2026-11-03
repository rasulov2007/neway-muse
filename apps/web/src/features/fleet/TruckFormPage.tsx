import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { createTruck, fetchTruckVendors, listDrivers } from '@/demo';
import { FormBlock, FormBlockWide } from '@/features/forms/FormBlock';
import {
  MissingDocumentsWarning,
  UnitCreationDocuments,
} from './components/UnitCreationDocuments';
import {
  uploadUnitDocuments,
  type UnitDocumentFiles,
} from './components/unit-creation-documents';
import {
  BackButton,
  Button,
  Combobox,
  ControlledField,
  DatePicker,
  Form,
  FormActions,
  Input,
  PageHeader,
  RadioGroup,
  Select,
  getStatus,
  useToast,
  useZodForm,
} from '@/design-system';
import { useInvalidateFleet } from './useFleet';
import {
  FIRST_SERVICE_INTERVAL_MILES,
  HOME_LOCATIONS,
  OWNERSHIP_OPTIONS,
  TRUCK_MAKES,
  TRUCK_STATUSES,
  US_STATES,
  firstServiceDate,
  toIsoDate,
  truckFormDefaults,
  truckFormSchema,
  type TruckFormValues,
} from './TruckFormSchema';

const MAKE_OPTIONS = TRUCK_MAKES.map((m) => ({ value: m, label: m }));
const STATE_OPTIONS = US_STATES.map((s) => ({ value: s, label: s }));
const STATUS_OPTIONS = TRUCK_STATUSES.map((s) => ({ value: s, label: getStatus(s).label }));
const LOCATION_OPTIONS = HOME_LOCATIONS.map((l) => ({ value: l, label: l }));

export function TruckFormPage() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/fleet/trucks" />}
        title="Add truck"
        description="Register a power unit so it can be dispatched, maintained and tracked."
      />
      <div className="flex w-full max-w-220 flex-col gap-(--section-gap)">
        <TruckForm
          onCancel={() => void navigate({ href: '/fleet/trucks' })}
          onCreated={(truck) =>
            void navigate({ to: '/fleet/trucks/$truckId', params: { truckId: truck.id } })
          }
        />
      </div>
    </div>
  );
}

/**
 * Registering a truck, page-free.
 *
 * Kept separate from the route so the Trucks list can raise it in a dialog: adding a unit is a
 * short form and leaving the list to fill it in loses the reader's place.
 */
export function TruckForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (truck: { id: string; unitNumber: string }) => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [files, setFiles] = useState<UnitDocumentFiles>({});
  const form = useZodForm(truckFormSchema, { defaultValues: truckFormDefaults });
  // A vendor truck (owner, 2026-10-28) names its vendor and what the company keeps.
  const isVendor = form.watch('ownership') === 'vendor';
  const [vendorChoice, setVendorChoice] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [vendorPercent, setVendorPercent] = useState('');
  const [vendorError, setVendorError] = useState<string | null>(null);
  const truckVendors = useQuery({ queryKey: ['truck-vendors'], queryFn: fetchTruckVendors, enabled: isVendor });
  const vendorOptions = [
    ...(truckVendors.data ?? []).map((v) => ({ value: v.id, label: v.name })),
    { value: '__new__', label: '+ New vendor' },
  ];
  const newVendor = vendorChoice === '__new__' || (vendorChoice === '' && (truckVendors.data?.length ?? 0) === 0);

  const drivers = useQuery({
    queryKey: ['drivers', 'all'],
    queryFn: () => listDrivers({ pageSize: 10_000, sort: 'name' }),
  });
  const driverOptions = (drivers.data?.data ?? []).map((d) => ({
    value: d.id,
    label: d.name,
    description: `${d.driverNumber} · ${d.currentTruckUnit ? `Unit ${d.currentTruckUnit}` : 'No unit'} · ${getStatus(d.status).label}`,
  }));

  async function onSubmit(values: TruckFormValues) {
    let vendor: { vendorId?: string; vendorName?: string; companyPercent: number } | undefined;
    if (values.ownership === 'vendor') {
      const pct = Number(vendorPercent);
      const problem =
        newVendor && vendorName.trim().length < 2
          ? 'Type the vendor’s name'
          : !newVendor && !vendorChoice
            ? 'Choose the vendor'
            : vendorPercent.trim() === '' || !Number.isFinite(pct) || pct < 0 || pct > 100
              ? 'What the company keeps: a percentage from 0 to 100'
              : null;
      if (problem) {
        setVendorError(problem);
        return;
      }
      vendor = newVendor ? { vendorName: vendorName.trim(), companyPercent: pct } : { vendorId: vendorChoice, companyPercent: pct };
    }
    setVendorError(null);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const truck = await createTruck({
        unitNumber: values.unitNumber,
        vin: values.vin,
        year: values.year,
        make: values.make,
        model: values.model,
        // Everything the form did not get stays absent: the record never carries a plate,
        // colour or terminal nobody entered. Ownership alone defaults — company owned is what
        // settlements and lease accounting assume.
        plate: values.plate,
        plateState: values.plateState,
        ownership: values.ownership ?? 'owned',
        odometer: values.odometer,
        inServiceDate: values.inServiceDate ? toIsoDate(values.inServiceDate) : undefined,
        homeTerminal: values.homeLocation,
        status: values.status,
        driverId: values.driverId,
        // A first PM at the standard interval, so the unit is never in the fleet with no service
        // schedule at all. It can be rebooked from the unit at any time.
        serviceIntervalMiles: FIRST_SERVICE_INTERVAL_MILES,
        nextServiceType: 'pm_service',
        nextServiceDate: firstServiceDate(values.inServiceDate),
        ...(vendor ? { vendor } : {}),
      });
      // The unit exists from here on. A file that does not upload is reported by name; it never
      // reads as a truck that was not created.
      const failed = await uploadUnitDocuments({
        scope: 'truck',
        ownerId: truck.id,
        ownerLabel: `Unit ${truck.unitNumber}`,
        files,
      });
      await invalidate();
      if (failed.length > 0) {
        toast({
          tone: 'warning',
          title: `${failed.join(', ')} did not upload`,
          description: `Unit ${truck.unitNumber} was created. Attach the file again from its Documents tab.`,
        });
      }
      toast({
        tone: 'success',
        title: `Unit ${truck.unitNumber} added`,
        description: `${truck.year} ${truck.make} ${truck.model}. It arrives available, with no driver, no telematics feed and no measured fuel economy.`,
      });
      onCreated(truck);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'The truck could not be added.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-(--section-gap)">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Info aria-hidden className="size-4 shrink-0" />
        Trailers are added under Fleet › Trailers.
      </p>

      {submitError ? (
        <p role="alert" className="text-sm text-danger-text">
          {submitError}
        </p>
      ) : null}

      <Form form={form} onSubmit={onSubmit} className="gap-(--section-gap)">
        <FormBlock
          title="Truck information"
          hint="Identity and registration as it appears on the title and cab card."
        >
          <ControlledField
            name="unitNumber"
            label="Unit number"
            required
            description="2–8 characters; shown everywhere the truck appears."
            render={({ field }) => (
              <Input {...field} placeholder="2790" autoComplete="off" maxLength={8} />
            )}
          />
          <ControlledField
            name="vin"
            label="VIN"
            required
            description="17 characters, no I, O or Q."
            render={({ field }) => (
              <Input
                {...field}
                placeholder="1FUJGLDR5LLAB1234"
                autoComplete="off"
                maxLength={17}
                className="font-mono uppercase"
              />
            )}
          />
          <ControlledField
            name="make"
            label="Make"
            required
            render={({ field }) => (
              <Select
                id={field.id}
                options={MAKE_OPTIONS}
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
                placeholder="Select a make"
              />
            )}
          />
          <ControlledField
            name="model"
            label="Model"
            required
            render={({ field }) => <Input {...field} placeholder="Cascadia" />}
          />
          <ControlledField
            name="year"
            label="Year"
            required
            description="1995 – 2027."
            render={({ field }) => (
              <Input {...field} type="number" inputMode="numeric" placeholder="2024" />
            )}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <ControlledField
              name="plate"
              label="Plate"
              description="Optional until the unit is registered."
              render={({ field }) => (
                <Input {...field} placeholder="P123456" className="uppercase" />
              )}
            />
            <ControlledField
              name="plateState"
              label="State"
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={STATE_OPTIONS}
                  value={field.value ?? undefined}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                  placeholder="IL"
                />
              )}
            />
          </div>
          <ControlledField
            name="ownership"
            label="Ownership"
            className="lg:col-span-2"
            render={({ field }) => (
              <RadioGroup
                id={field.id}
                options={OWNERSHIP_OPTIONS.map((o) => ({ ...o }))}
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
                orientation="horizontal"
                className="pt-1"
              />
            )}
          />
          {isVendor ? (
            <div className="grid gap-3 lg:col-span-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink">Vendor</span>
                <Select
                  aria-label="Vendor"
                  options={vendorOptions}
                  value={vendorChoice || (newVendor ? '__new__' : '')}
                  placeholder={truckVendors.isPending ? 'Loading…' : 'Choose the vendor'}
                  onValueChange={setVendorChoice}
                />
              </label>
              {newVendor ? (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink">New vendor’s name</span>
                  <Input aria-label="New vendor’s name" value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="The person whose truck it is" />
                </label>
              ) : null}
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink">Company keeps</span>
                <Input aria-label="Company keeps" inputMode="decimal" suffix="%" value={vendorPercent} onChange={(e) => setVendorPercent(e.target.value)} placeholder="20" />
              </label>
              <p className={vendorError ? 'text-xs text-danger-text lg:col-span-3' : 'text-xs text-muted lg:col-span-3'}>
                {vendorError ?? 'Percent of the truck’s gross that stays with the company. The driver is paid out of the vendor’s part, as Accounting sets; the truck’s repairs and fuel are the vendor’s.'}
              </p>
            </div>
          ) : null}
        </FormBlock>

        <FormBlock
          title="Assignment"
          hint="Where the truck lives and who drives it. Both can change later from the truck page."
        >
          <ControlledField
            name="status"
            label="Status"
            required
            render={({ field }) => (
              <Select
                id={field.id}
                options={STATUS_OPTIONS}
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
              />
            )}
          />
          <ControlledField
            name="homeLocation"
            label="Home location"
            description="Optional. Terminal used for maintenance routing and empty-mile accounting."
            render={({ field }) => (
              <Select
                id={field.id}
                options={LOCATION_OPTIONS}
                value={field.value ?? undefined}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
                placeholder="Not set"
              />
            )}
          />
          <ControlledField
            name="driverId"
            label="Assigned driver"
            description="Optional. Search by name or driver number."
            className="lg:col-span-2"
            render={({ field }) => (
              <Combobox
                id={field.id}
                options={driverOptions}
                loading={drivers.isPending}
                value={field.value ?? null}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
                placeholder="Unassigned"
                searchPlaceholder="Search drivers…"
                emptyMessage="No matching drivers"
              />
            )}
          />
        </FormBlock>

        <FormBlock
          title="Service history"
          hint="Where the unit starts, so its first PM and its cost per mile are measured from a real baseline. Without an in-service date the first PM is measured from today; the date can be added from the unit's page."
        >
          <ControlledField
            name="inServiceDate"
            label="In service since"
            description="Optional. Needed before PM scheduling can be measured from a real date."
            render={({ field }) => (
              <DatePicker
                id={field.id}
                value={field.value ?? null}
                onChange={field.onChange}
                onBlur={field.onBlur}
              />
            )}
          />
          <ControlledField
            name="odometer"
            label="Odometer"
            required
            description="Reading at the time of entry."
            render={({ field }) => (
              <Input {...field} type="number" inputMode="numeric" suffix="mi" min={0} />
            )}
          />
        </FormBlock>

        <FormBlock
          title="Documents"
          hint="The paperwork the unit carries. The registration, the DOT annual inspection and the insurance card decide whether it can be dispatched. Safety still owns expiry and verification; this only puts the files on the unit from day one."
        >
          <FormBlockWide>
            <UnitCreationDocuments
              scope="truck"
              files={files}
              onFile={(code, file) => setFiles((current) => ({ ...current, [code]: file }))}
              disabled={submitting}
            />
          </FormBlockWide>
          <FormBlockWide>
            <MissingDocumentsWarning scope="truck" files={files} />
          </FormBlockWide>
        </FormBlock>

        <FormActions>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            Create truck
          </Button>
        </FormActions>
      </Form>
    </div>
  );
}
