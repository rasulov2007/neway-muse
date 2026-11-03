import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { emptyCdlExtract, type CdlExtract } from '@neway/shared';
import { createDriver, listTrucks } from '@/demo';
import { uploadComplianceDocument } from '@/features/safety/compliance-api';
import { FormBlock } from '@/features/forms/FormBlock';
import {
  BackButton,
  Alert,
  Button,
  Checkbox,
  Combobox,
  ControlledField,
  DatePicker,
  Form,
  FormActions,
  Input,
  PageHeader,
  Select,
  useToast,
  useZodForm,
} from '@/design-system';
import { CdlTemplateBlock } from './CdlTemplateBlock';
import { CredentialDropzone, type CredentialState } from './CredentialDropzone';
import { parseCdlText, toCdlExtract } from './credential-ocr';
import {
  CDL_CLASSES,
  DRIVER_TYPES,
  ENDORSEMENTS,
  LANGUAGES,
  LEASE_PAY_KINDS,
  PAY_KINDS,
  SECONDARY_PHONE_LABELS,
  calendarDay,
  daysUntil,
  driverFormSchema,
  type DriverFormValues,
} from './DriverFormSchema';
import { ageOn } from '@neway/shared';
import { today } from '@/lib/clock';

/**
 * Adds a driver and opens their qualification file.
 *
 * The new hire lands off duty and non-dispatchable, with every safety requirement outstanding. That
 * is deliberate and is stated on the form: a driver record that looked ready to dispatch the moment
 * it was typed would be the single most dangerous thing this system could do.
 */
/**
 * The route: hiring a driver with its own address, for a link or a bookmark.
 *
 * The form itself is the export that matters — the roster opens it over the list, which is where
 * a driver is actually added, and a page that took over the screen for it was one more place to
 * come back from.
 */
export function DriverFormPage() {
  const navigate = useNavigate();
  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/drivers" />}
        title="Add driver"
        description="Identity, licence and pay. Safety collects the documents next."
      />
      <div className="flex w-full max-w-220 flex-col gap-(--section-gap)">
        <DriverForm
          onCancel={() => void navigate({ href: '/drivers' })}
          onCreated={(driverId) =>
            void navigate({ href: `/drivers?driver=${encodeURIComponent(driverId)}` })
          }
        />
      </div>
    </div>
  );
}

/**
 * Two readings of the same file, combined.
 *
 * The licence is read first and the medical card second; each knows only its own half. Merging
 * keeps whatever is already there — including anything a person has corrected in between — and
 * only fills the blanks.
 */
function mergeExtract(current: CdlExtract, incoming: CdlExtract): CdlExtract {
  const merged: CdlExtract = { ...current };
  for (const key of Object.keys(incoming) as Array<keyof CdlExtract>) {
    if (key === 'needsReview' || key === 'source') continue;
    const next = incoming[key];
    const held = merged[key];
    const empty = held === null || held === '' || (Array.isArray(held) && held.length === 0);
    if (empty && next !== null && !(Array.isArray(next) && next.length === 0)) {
      merged[key] = next as never;
    }
  }
  merged.needsReview = [...new Set([...current.needsReview, ...incoming.needsReview])].filter(
    (field) => {
      const held = merged[field as keyof CdlExtract];
      return held === null || held === '' || (Array.isArray(held) && held.length === 0);
    },
  );
  merged.source = 'ocr';
  return merged;
}

/**
 * What a caller already knows about the driver (owner, 2026-10-26): the Daily board opens this form
 * for a board row that has no driver file, with the row's name, phone and dispatcher, and the row
 * id so the server links the new file to that row. Everything else is typed - never invented.
 */
export interface DriverFormPrefill {
  firstName?: string;
  lastName?: string;
  phone?: string;
  dispatcherId?: string;
  boardRowId?: string;
}

export function DriverForm({
  onCancel,
  onCreated,
  prefill,
}: {
  onCancel: () => void;
  onCreated: (driverId: string) => void;
  prefill?: DriverFormPrefill;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  /*
   * The two cards. They are the evidence behind the two dates below, and a qualification file
   * opened without them is one somebody has to chase later — so neither the button nor the
   * submit handler will proceed until both are attached.
   */
  const [cdlCard, setCdlCard] = useState<CredentialState>({ phase: 'empty' });
  /*
   * The structured file behind the cards.
   *
   * Filled by the reader, corrected by the person, and filed with the CDL document itself — so the
   * extract and the photograph it came from cannot drift apart.
   */
  const [cdlDetails, setCdlDetails] = useState<CdlExtract>(() => emptyCdlExtract());
  /*
   * Whether the licence carries a different name from the one the driver goes by. Off by default:
   * for nearly everyone the two are the same, and asking for the name twice is how the same thing
   * got typed twice. When it is off, the primary name is filed as the legal name - a real value,
   * never a blank that later reads as missing.
   */
  const [legalNameDiffers, setLegalNameDiffers] = useState(false);
  /*
   * The back of the licence and a photograph of the driver.
   *
   * Collected here because this is when somebody has the card in their hand, and optional because
   * neither stops a driver being hired: a missing photograph is an administrative gap, not a
   * safety one, and a rule that held a driver off a load for it is a rule people work around.
   */
  const [cdlBack, setCdlBack] = useState<CredentialState>({ phase: 'empty' });

  /*
   * The units a driver can actually be given: on the roster, not sold or out of service, and with
   * nobody already in them. Offering a taken unit would make the form the place where two drivers
   * end up on one truck.
   */
  const freeTrucks = useQuery({
    queryKey: ['trucks', 'unassigned'],
    queryFn: () => listTrucks({ pageSize: 10_000 }),
  });
  const truckOptions = (freeTrucks.data?.data ?? [])
    // A unit nobody is in and that can actually run: offering one that is out of service or in
    // the shop is offering an assignment dispatch would refuse.
    .filter(
      (truck) =>
        !truck.currentDriverId &&
        !['sold', 'inactive', 'out_of_service', 'in_shop'].includes(truck.status),
    )
    .map((truck) => ({
      value: truck.id,
      label: `Unit ${truck.unitNumber}`,
      description: `${truck.year} ${truck.make} ${truck.model} · ${truck.status.replace(/_/g, ' ')}`,
    }));

  const form = useZodForm(driverFormSchema, {
    defaultValues: {
      firstName: prefill?.firstName ?? '',
      lastName: prefill?.lastName ?? '',
      phone: prefill?.phone ?? '',
      secondaryPhone: '',
      secondaryPhoneLabel: '',
      email: '',
      driverType: 'company',
      cdlState: '',
      cdlClass: 'A',
      cdlEndorsements: [],
      cdlExpiresOn: '',
      medicalCardExpiresOn: '',
      dateOfBirth: '',
      hireDate: new Date().toISOString().slice(0, 10),
      homeCity: '',
      homeState: '',
      dispatcherId: prefill?.dispatcherId ?? '',
      truckId: '',
      payKind: 'per_mile',
      payRate: 0.6,
      preferredLanguage: 'en',
    },
  });

  /**
   * What was read off a card goes into the form, and only where the form is still empty.
   *
   * Overwriting something a person typed is how a correction gets silently undone; the reader is
   * an assistant, not an authority. Every value it sets is an ordinary field they can see and
   * change before anything is saved.
   */
  function applyCdl(text: string): string | null {
    const read = parseCdlText(text);
    setCdlDetails((current) => mergeExtract(current, toCdlExtract({ cdlText: text })));
    const filled: string[] = [];
    const set = (field: keyof DriverFormValues, value: string | string[] | null, label: string) => {
      if (value === null || (Array.isArray(value) && value.length === 0)) return;
      const current = form.getValues(field);
      if (Array.isArray(current) ? current.length > 0 : String(current ?? '').trim() !== '') return;
      form.setValue(field, value as never, { shouldDirty: true, shouldValidate: true });
      filled.push(label);
    };
    set('cdlExpiresOn', read.expiresOn, 'expiry');
    set('cdlState', read.state, 'state');
    set('cdlClass', read.cdlClass, 'class');
    set('cdlEndorsements', read.endorsements, 'endorsements');
    set('firstName', read.firstName, 'first name');
    set('lastName', read.lastName, 'last name');
    // A licence printing a different name from the one typed is exactly the case the checkbox
    // exists for; the reader turns it on so the difference is not lost.
    const legal = toCdlExtract({ cdlText: text });
    const typedFirst = String(form.getValues('firstName') ?? '')
      .trim()
      .toLowerCase();
    const typedLast = String(form.getValues('lastName') ?? '')
      .trim()
      .toLowerCase();
    if (
      (legal.legalFirstName && legal.legalFirstName.trim().toLowerCase() !== typedFirst) ||
      (legal.legalLastName && legal.legalLastName.trim().toLowerCase() !== typedLast)
    ) {
      setLegalNameDiffers(true);
    }
    return filled.length > 0
      ? `Read from the card: ${filled.join(', ')}. Check them against it.`
      : null;
  }


  const cdlExpiry = form.watch('cdlExpiresOn');
  const cdlDays = cdlExpiry ? daysUntil(cdlExpiry) : null;
  const dateOfBirth = form.watch('dateOfBirth');
  const todayIso = today();
  const age = dateOfBirth ? ageOn(dateOfBirth, todayIso) : null;

  const create = useMutation({
    mutationFn: async (values: DriverFormValues) => {
      const cdl = cdlCard.phase === 'ready' ? cdlCard.value : null;
      if (!cdl) {
        throw new Error('Attach the CDL before adding the driver.');
      }
      const driver = await createDriver({
        firstName: values.firstName,
        lastName: values.lastName,
        phone: values.phone,
        secondaryPhone: values.secondaryPhone.trim() || null,
        secondaryPhoneLabel:
          values.secondaryPhone.trim() && values.secondaryPhoneLabel
            ? values.secondaryPhoneLabel
            : null,
        email: values.email,
        driverType: values.driverType,
        cdlState: values.cdlState,
        cdlClass: values.cdlClass,
        cdlEndorsements: values.cdlEndorsements,
        cdlExpiresOn: values.cdlExpiresOn,
        // Recruiting collects the DOT medical card (owner, 2026-10-12): it opens as missing.
        medicalCardExpiresOn: null,
        dateOfBirth: values.dateOfBirth?.trim() || null,
        hireDate: values.hireDate,
        homeCity: values.homeCity,
        homeState: values.homeState,
        dispatcherId: values.dispatcherId,
        // Paired on the spot when a unit was chosen; the server moves both sides together.
        truckId: values.truckId ? values.truckId : null,
        payPlan: { kind: values.payKind, rate: LEASE_PAY_KINDS.has(values.payKind) ? 0 : values.payRate },
        preferredLanguage: values.preferredLanguage,
        boardRowId: prefill?.boardRowId ?? null,
      });

      /*
       * The cards are filed against the driver that now exists, on the same two requirement codes
       * the compliance engine, the driver profile, the employee profile and dispatch eligibility
       * all read. There is no second copy of these dates anywhere: the expiry filed here is the
       * expiry on the form, which is the expiry on the driver record.
       */
      const filed = await Promise.allSettled([
        uploadComplianceDocument({
          ownerType: 'driver',
          ownerId: driver.id,
          ownerLabel: driver.name,
          requirementCode: 'cdl',
          title: `CDL — ${driver.name}`,
          fileName: cdl.file.name,
          contentType: cdl.file.type,
          sizeBytes: cdl.file.size,
          issuedOn: cdlDetails.cdlIssuedOn,
          expiresOn: values.cdlExpiresOn,
          content: cdl.content,
          // The file Safety keeps, as the person confirmed it. Unless they said the licence
          // carries a different name, the legal name IS the name above.
          // The date of birth is entered once, on the driver, and filed with the licence too.
          extracted: legalNameDiffers
            ? {
                ...cdlDetails,
                cdlClass: values.cdlClass,
                cdlExpiresOn: values.cdlExpiresOn,
                dateOfBirth: values.dateOfBirth?.trim() || cdlDetails.dateOfBirth,
              }
            : {
                ...cdlDetails,
                cdlClass: values.cdlClass,
                cdlExpiresOn: values.cdlExpiresOn,
                dateOfBirth: values.dateOfBirth?.trim() || cdlDetails.dateOfBirth,
                legalFirstName: values.firstName.trim(),
                legalMiddleName: null,
                legalLastName: values.lastName.trim(),
              },
        }),
      ]);
      // The optional cards are filed the same way; failing to file one is worth saying, not
      // worth refusing the driver over.
      const extras = await Promise.allSettled([
        cdlBack.phase === 'ready'
          ? uploadComplianceDocument({
              ownerType: 'driver',
              ownerId: driver.id,
              ownerLabel: driver.name,
              requirementCode: 'cdl_back',
              title: `CDL back — ${driver.name}`,
              fileName: cdlBack.value.file.name,
              contentType: cdlBack.value.file.type,
              sizeBytes: cdlBack.value.file.size,
              issuedOn: null,
              expiresOn: null,
              content: cdlBack.value.content,
            })
          : Promise.resolve(null),
      ]);

      const failed: string[] = [];
      if (filed[0]?.status === 'rejected') failed.push('CDL');
      if (extras[0]?.status === 'rejected') failed.push('CDL back');
      return { driver, failed };
    },
    onSuccess: async ({ driver, failed }) => {
      // Operations and Safety both read derived bundles; both must recompute for the new hire to
      // show up as non-compliant rather than not at all.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['compliance'] }),
        queryClient.invalidateQueries({ queryKey: ['drivers'] }),
      ]);
      if (failed.length > 0) {
        // The driver exists; saying otherwise would send somebody looking for a record that is
        // already there. What did not happen is named exactly.
        toast({
          tone: 'warning',
          title: `${driver.name} added as ${driver.driverNumber}`,
          description: `The ${failed.join(' and ')} could not be filed. Attach ${failed.length > 1 ? 'them' : 'it'} again from Safety.`,
        });
      } else {
        toast({
          tone: 'success',
          title: `${driver.name} added as ${driver.driverNumber}`,
          description:
            'The CDL is on file, pending verification. Recruiting adds the medical card; off duty and not dispatchable until safety verifies them.',
        });
      }
      onCreated(driver.id);
    },
    onError: (error: unknown) => {
      setSubmitError(error instanceof Error ? error.message : 'The driver could not be added.');
    },
  });

  const documentsReady = cdlCard.phase === 'ready';

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <>
        <Alert
          tone="info"
          title="The driver starts off duty and not dispatchable"
          description="Adding a driver opens their qualification file with the CDL unverified, and every other safety requirement — the DOT medical card included, which Recruiting collects — missing. They appear in Safety immediately and cannot be assigned a load until the documents are collected and verified."
        />

        {submitError ? (
          <p role="alert" className="text-sm text-danger-text">
            {submitError}
          </p>
        ) : null}

        <Form
          form={form}
          onSubmit={(values: DriverFormValues) => {
            // The button is disabled without them; this is the check that actually holds.
            if (!documentsReady) {
              setSubmitError(
                'Attach the CDL and the medical certificate before adding the driver.',
              );
              return;
            }
            setSubmitError(null);
            create.mutate(values);
          }}
          className="gap-(--section-gap)"
        >
          <FormBlock
            title="Identity"
            hint="How the driver is addressed day to day, and how they are reached."
          >
            <ControlledField
              name="firstName"
              label="First name"
              required
              render={({ field }) => <Input {...field} placeholder="James" autoComplete="off" />}
            />
            <ControlledField
              name="lastName"
              label="Last name"
              required
              render={({ field }) => <Input {...field} placeholder="Wilson" autoComplete="off" />}
            />
            <div className="sm:col-span-2">
              <Checkbox
                label="Legal name differs from the above (as printed on the CDL)"
                description={
                  legalNameDiffers
                    ? 'Enter the name exactly as the licence prints it in the CDL details below.'
                    : 'Leave unchecked and the name above is filed as the legal name.'
                }
                checked={legalNameDiffers}
                onCheckedChange={(next) => {
                  const on = next === true;
                  setLegalNameDiffers(on);
                  if (on) {
                    // Start from the name already typed, so only the difference needs typing.
                    setCdlDetails((current) => ({
                      ...current,
                      legalFirstName: current.legalFirstName ?? form.getValues('firstName') ?? null,
                      legalLastName: current.legalLastName ?? form.getValues('lastName') ?? null,
                    }));
                  }
                }}
              />
            </div>
            <ControlledField
              name="phone"
              label="Phone"
              required
              render={({ field }) => <Input {...field} type="tel" placeholder="+1 312 555 0142" />}
            />
            <div className="grid grid-cols-[minmax(0,1fr)_9rem] gap-2">
              <ControlledField
                name="secondaryPhone"
                label="Secondary phone"
                render={({ field }) => (
                  <Input {...field} type="tel" placeholder="Optional" autoComplete="off" />
                )}
              />
              <ControlledField
                name="secondaryPhoneLabel"
                label="Label"
                render={({ field }) => (
                  <Select
                    id={field.id}
                    options={[{ value: '', label: 'None' }, ...SECONDARY_PHONE_LABELS]}
                    value={field.value}
                    onValueChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
            <ControlledField
              name="email"
              label="Email"
              required
              render={({ field }) => (
                <Input {...field} type="email" placeholder="james.wilson@example.com" />
              )}
            />
            <ControlledField
              name="preferredLanguage"
              label="Preferred language"
              description="Used for driver messages and documents."
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={[...LANGUAGES]}
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            <ControlledField
              name="dateOfBirth"
              label="Date of birth"
              description={
                age !== null && age >= 0 ? `${age} years old.` : 'Optional. The driver must be 18 or older.'
              }
              render={({ field }) => (
                <DatePicker
                  id={field.id}
                  value={field.value}
                  onIsoChange={(iso) => {
                    field.onChange(iso);
                    // Said at once, not only on Add driver: the button waits for the CDL.
                    void form.trigger('dateOfBirth');
                  }}
                  onBlur={field.onBlur}
                  maxDate={calendarDay(todayIso)}
                />
              )}
            />
          </FormBlock>

          <FormBlock
            title="Documents"
            hint="The licence is required; the back of the card is collected when it is to hand. The DOT medical card and the photograph come from Recruiting. Everything is filed against the driver and read to fill in the details below."
          >
            <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
              <CredentialDropzone
                label="CDL — front of the card"
                hint="A photo of the licence itself."
                state={cdlCard}
                onState={setCdlCard}
                onText={applyCdl}
                disabled={create.isPending}
              />
              <CredentialDropzone
                label="CDL — back of the card"
                hint="The reverse, which carries the restrictions."
                state={cdlBack}
                onState={setCdlBack}
                onText={() => null}
                disabled={create.isPending}
                optional
              />
            </div>
          </FormBlock>

          <FormBlock
            title="Licence"
            hint="These two dates open the qualification file, which is why both are required."
          >
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
              <ControlledField
                name="cdlState"
                label="State"
                required
                render={({ field }) => (
                  <Input {...field} placeholder="IL" maxLength={2} className="uppercase" />
                )}
              />
              <ControlledField
                name="cdlClass"
                label="CDL class"
                required
                render={({ field }) => (
                  <Select
                    id={field.id}
                    options={[...CDL_CLASSES]}
                    value={field.value}
                    onValueChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
            <ControlledField
              name="cdlEndorsements"
              label="Endorsements"
              description="Dispatch uses these to match a driver to hazmat and tanker freight."
              render={({ field }) => {
                const selected: string[] = Array.isArray(field.value) ? field.value : [];
                return (
                  <div className="flex flex-col gap-1.5">
                    {ENDORSEMENTS.map((option) => (
                      <Checkbox
                        key={option.value}
                        checked={selected.includes(option.value)}
                        onCheckedChange={(checked) =>
                          field.onChange(
                            checked
                              ? [...selected, option.value]
                              : selected.filter((v) => v !== option.value),
                          )
                        }
                        label={option.label}
                      />
                    ))}
                  </div>
                );
              }}
            />
            <ControlledField
              name="cdlExpiresOn"
              label="CDL expires"
              required
              description={
                cdlDays === null
                  ? undefined
                  : cdlDays < 0
                    ? 'This licence has already expired.'
                    : `${cdlDays} days from today.`
              }
              render={({ field }) => (
                <DatePicker
                  id={field.id}
                  value={field.value}
                  onIsoChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </FormBlock>

          <CdlTemplateBlock
            value={cdlDetails}
            onChange={setCdlDetails}
            disabled={create.isPending}
            showLegalName={legalNameDiffers}
            showMedical={false}
            showDateOfBirth={false}
          />

          <FormBlock title="Employment" hint="Where the driver is based and who runs them.">
            <ControlledField
              name="driverType"
              label="Driver type"
              required
              description="Decides how settlements treat their pay."
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={[...DRIVER_TYPES]}
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            <ControlledField
              name="hireDate"
              label="Hire date"
              required
              render={({ field }) => (
                <DatePicker
                  id={field.id}
                  value={field.value}
                  onIsoChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <ControlledField
                name="homeCity"
                label="Home city"
                required
                render={({ field }) => <Input {...field} placeholder="Chicago" />}
              />
              <ControlledField
                name="homeState"
                label="State"
                required
                render={({ field }) => (
                  <Input {...field} placeholder="IL" maxLength={2} className="uppercase" />
                )}
              />
            </div>
            <ControlledField
              name="truckId"
              label="Truck"
              description="Optional. Only units with no driver on them are listed; a driver can be paired later."
              render={({ field }) => (
                <Combobox
                  id={field.id}
                  options={truckOptions}
                  value={field.value || null}
                  onValueChange={(value) => field.onChange(value ?? '')}
                  onBlur={field.onBlur}
                  placeholder={freeTrucks.isPending ? 'Loading…' : 'No truck yet'}
                  searchPlaceholder="Type a unit number…"
                  emptyMessage="No free unit matches"
                  loading={freeTrucks.isPending}
                />
              )}
            />
            {/* The dispatcher is added on the driver's own page (owner, 2026-10-13), not here. */}
          </FormBlock>

          <FormBlock title="Pay" hint="How this driver is paid on settlements.">
            <ControlledField
              name="payKind"
              label="Pay plan"
              required
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={[...PAY_KINDS]}
                  value={field.value}
                  onValueChange={(v) => {
                    field.onChange(v);
                    // Lease owner and leasing to owner run as lease operators; owner truck as an
                    // owner-operator (owner, 2026-10-12).
                    if (v === 'owner_truck') form.setValue('driverType', 'owner_operator', { shouldDirty: true });
                    else if (LEASE_PAY_KINDS.has(v)) form.setValue('driverType', 'lease_operator', { shouldDirty: true });
                  }}
                  onBlur={field.onBlur}
                />
              )}
            />
            {LEASE_PAY_KINDS.has(form.watch('payKind')) ? (
              <p className="self-end pb-2 text-xs text-nw-text-3" data-testid="lease-pay-note">
                Paid the whole gross, less the lease sheet’s charges and the $3,000 deposit ($350 a week). Accounting can change any charge on the driver’s financial profile.
              </p>
            ) : (
              <ControlledField
                name="payRate"
                label={form.watch('payKind') === 'per_mile' ? 'Rate per mile' : 'Percent of linehaul'}
                required
                render={({ field }) => (
                  <Input
                    {...field}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    placeholder="0.60"
                  />
                )}
              />
            )}
          </FormBlock>

          <FormActions>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              icon={<ShieldAlert />}
              loading={create.isPending}
              disabled={!documentsReady}
              title={
                documentsReady ? undefined : 'Attach the CDL and the medical certificate first'
              }
            >
              Add driver
            </Button>
          </FormActions>
        </Form>
      </>
    </div>
  );
}
