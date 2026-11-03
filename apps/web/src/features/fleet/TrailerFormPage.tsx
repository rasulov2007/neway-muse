import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { FormBlock, FormBlockWide } from '@/features/forms/FormBlock';
import {
  BackButton,
  Alert,
  Button,
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
import { createTrailer } from '@/demo';
import {
  MissingDocumentsWarning,
  UnitCreationDocuments,
} from './components/UnitCreationDocuments';
import {
  uploadUnitDocuments,
  type UnitDocumentFiles,
} from './components/unit-creation-documents';
import { US_STATES } from './TruckFormSchema';
import { trailerFormDefaults, trailerFormSchema, type TrailerFormValues } from './TrailerFormSchema';
import { useInvalidateFleet } from './useFleet';

const TRAILER_TYPES = [
  { value: 'dry_van', label: 'Dry van' },
  { value: 'reefer', label: 'Reefer' },
  { value: 'flatbed', label: 'Flatbed' },
] as const;

const OWNERSHIP = [
  { value: 'owned', label: 'Company owned' },
  { value: 'leased', label: 'Leased' },
] as const;

function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Adds a trailer.
 *
 * Short by design. A trailer has no odometer, no fuel economy and no economics of its own, so
 * there is nothing here to earn — only what it is, what plate it carries and when its annual
 * inspection falls due. It arrives available and unattached.
 */
/** The page wrapper, so `/fleet/trailers/new` keeps working; the register raises the same form. */
export function TrailerFormPage() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/fleet/trailers" />}
        title="Add trailer"
        description="What it is, what plate it carries, and when it is next due for inspection."
      />
      <div className="flex w-full max-w-220 flex-col gap-(--section-gap)">
        <TrailerForm
          onCancel={() => void navigate({ to: '/fleet/trailers' })}
          onCreated={(trailerId) =>
            void navigate({ to: '/fleet/trailers/$trailerId', params: { trailerId } })
          }
        />
      </div>
    </div>
  );
}

/** The form itself, page-free so the trailers register can raise it over the list. */
export function TrailerForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (trailerId: string) => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [files, setFiles] = useState<UnitDocumentFiles>({});
  const form = useZodForm(trailerFormSchema, { defaultValues: trailerFormDefaults });

  async function onSubmit(values: TrailerFormValues) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // What the form did not get stays absent on the record. Ownership alone defaults to company
      // owned, which is what the rest of the product assumes.
      const trailer = await createTrailer({
        unitNumber: values.unitNumber,
        vin: values.vin,
        year: values.year,
        model: values.model,
        type: values.type,
        lengthFt: values.lengthFt,
        plate: values.plate,
        plateState: values.plateState,
        ownership: values.ownership ?? 'owned',
        nextInspectionDate: values.nextInspectionDate
          ? toIsoDate(values.nextInspectionDate)
          : undefined,
      });
      // The unit exists from here on. The documents are uploaded against it, and a file that
      // does not upload is reported by name — it never reads as a trailer that was not created.
      const inspectionExpiry = values.nextInspectionDate
        ? toIsoDate(values.nextInspectionDate)
        : undefined;
      const failed = await uploadUnitDocuments({
        scope: 'trailer',
        ownerId: trailer.id,
        ownerLabel: `Trailer ${trailer.unitNumber}`,
        files,
        expiresOn: { trailer_annual_inspection: inspectionExpiry },
      });
      await invalidate();
      toast({
        tone: 'success',
        title: `Trailer ${trailer.unitNumber} added`,
        description: 'Available and unattached. Attach it from the unit that will pull it.',
      });
      if (failed.length > 0) {
        toast({
          tone: 'warning',
          title: `${failed.join(', ')} did not upload`,
          description: `Trailer ${trailer.unitNumber} was created. Attach the file again from its Documents tab.`,
        });
      }
      onCreated(trailer.id);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'The trailer could not be added.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-3">
        <Alert
          tone="info"
          title="A trailer arrives available and unattached"
          description="Pairing a trailer to a truck is done from the unit, which owns the pairing, so the two records can never disagree about what is hooked to what."
        />

        {submitError ? (
          <p role="alert" className="text-sm text-danger-text">
            {submitError}
          </p>
        ) : null}

        <Form form={form} onSubmit={onSubmit} className="gap-(--section-gap)">
          <FormBlock title="Identity" hint="How the trailer is identified in the yard.">
            <ControlledField
              name="unitNumber"
              label="Trailer number"
              required
              render={({ field }) => <Input {...field} placeholder="5218" autoComplete="off" />}
            />
            <ControlledField
              name="vin"
              label="VIN"
              required
              description="17 characters, no I, O or Q."
              render={({ field }) => (
                <Input {...field} placeholder="1GRAA0623KJ123456" className="uppercase" />
              )}
            />
            {/* Model and year; no make (owner, 2026-10-22: "take Make off"). */}
            <ControlledField
              name="model"
              label="Model"
              required
              render={({ field }) => <Input {...field} placeholder="4000D-X" maxLength={40} />}
            />
            <ControlledField
              name="year"
              label="Year"
              required
              render={({ field }) => (
                <Input {...field} type="number" inputMode="numeric" placeholder="2026" />
              )}
            />
          </FormBlock>

          <FormBlock title="Equipment" hint="What freight it can take.">
            <ControlledField
              name="type"
              label="Type"
              required
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={[...TRAILER_TYPES]}
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            <ControlledField
              name="lengthFt"
              label="Length"
              description="Optional. 20–60 ft."
              render={({ field }) => (
                <Input {...field} type="number" inputMode="numeric" suffix="ft" placeholder="53" />
              )}
            />
            <ControlledField
              name="ownership"
              label="Ownership"
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={[...OWNERSHIP]}
                  value={field.value ?? undefined}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </FormBlock>

          <FormBlock
            title="Registration"
            hint="Plate and the annual inspection date. Both are optional here and can be added from the trailer's page once known."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <ControlledField
                name="plate"
                label="Plate"
                render={({ field }) => <Input {...field} className="uppercase" />}
              />
              <ControlledField
                name="plateState"
                label="Plate state"
                render={({ field }) => (
                  <Select
                    id={field.id}
                    options={US_STATES.map((s) => ({ value: s, label: s }))}
                    value={field.value ?? undefined}
                    onValueChange={field.onChange}
                    onBlur={field.onBlur}
                    placeholder="Not set"
                  />
                )}
              />
            </div>
            <ControlledField
              name="nextInspectionDate"
              label="Next annual inspection"
              render={({ field }) => (
                <DatePicker
                  id={field.id}
                  value={field.value ?? null}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </FormBlock>

          <FormBlock
            title="Documents"
            hint="The paperwork the trailer carries. The registration and the annual inspection certificate decide whether it can be dispatched; the rest are offered here because this is when the folder is open."
          >
            <FormBlockWide>
              <UnitCreationDocuments
                scope="trailer"
                files={files}
                onFile={(code, file) => setFiles((current) => ({ ...current, [code]: file }))}
                disabled={submitting}
              />
            </FormBlockWide>
            <FormBlockWide>
              <MissingDocumentsWarning scope="trailer" files={files} />
            </FormBlockWide>
          </FormBlock>

          <FormActions>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Add trailer
            </Button>
          </FormActions>
        </Form>
      </div>
    </div>
  );
}
