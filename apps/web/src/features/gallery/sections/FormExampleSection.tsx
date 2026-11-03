import { addDays } from 'date-fns';
import { useState } from 'react';
import { z } from 'zod';
import {
  Button,
  Card,
  Checkbox,
  Combobox,
  ControlledField,
  DatePicker,
  Form,
  FormActions,
  FormSection,
  Input,
  RadioGroup,
  Select,
  Textarea,
  useToast,
  useZodForm,
} from '@/design-system';
import { GALLERY_NOW, truckOptions } from '../galleryData';
import { GallerySection } from './Section';

const serviceTypes = [
  { value: 'pm_service', label: 'PM service' },
  { value: 'oil_change', label: 'Oil change' },
  { value: 'brake_inspection', label: 'Brake inspection' },
  { value: 'dot_inspection', label: 'DOT inspection' },
  { value: 'tire_replacement', label: 'Tire replacement' },
];

const vendors = [
  { value: 'v_penske', label: 'Penske Truck Leasing · Joliet, IL' },
  { value: 'v_rush', label: 'Rush Truck Centers · Dallas, TX' },
  { value: 'v_inhouse', label: 'In-house shop · Chicago terminal' },
];

const priorityOptions = [
  { value: 'normal', label: 'Normal', description: 'Next available slot.' },
  { value: 'high', label: 'High', description: 'Within 48 hours; pull the unit off dispatch.' },
  { value: 'urgent', label: 'Urgent', description: 'Out of service until repaired.' },
];

const schema = z.object({
  truckId: z.string().min(1, 'Choose the truck to service.'),
  type: z.string().min(1, 'Choose a service type.'),
  vendor: z.string().min(1, 'Choose a vendor or the in-house shop.'),
  scheduledFor: z
    .date({ error: 'Pick a date.' })
    .refine((d) => d.getTime() >= GALLERY_NOW.getTime() - 86_400_000, 'Pick a date in the future.'),
  odometer: z
    .string()
    .min(1, 'Enter the current odometer.')
    .refine((v) => /^\d{1,3}(,\d{3})*$|^\d+$/.test(v), 'Digits only, e.g. 421,500.'),
  estimate: z
    .string()
    .refine(
      (v) => v === '' || /^\d+(\.\d{1,2})?$/.test(v),
      'Enter dollars and cents, e.g. 850.00.',
    ),
  priority: z.enum(['normal', 'high', 'urgent']),
  notifyDriver: z.boolean(),
  notes: z.string().max(500, 'Keep notes under 500 characters.'),
});

type Values = z.output<typeof schema>;

const SUBMIT_LATENCY_MS = 700;

export function FormExampleSection() {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const form = useZodForm(schema, {
    defaultValues: {
      truckId: truckOptions[0]?.value ?? '',
      type: '',
      vendor: '',
      scheduledFor: addDays(GALLERY_NOW, 3),
      odometer: '',
      estimate: '',
      priority: 'normal',
      notifyDriver: true,
      notes: '',
    },
  });

  async function onSubmit(values: Values) {
    setSubmitting(true);
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_LATENCY_MS));
    setSubmitting(false);
    const truck = truckOptions.find((t) => t.value === values.truckId)?.label ?? 'Truck';
    const type = serviceTypes.find((t) => t.value === values.type)?.label ?? 'Service';
    toast({
      tone: 'success',
      title: `${type} scheduled for ${truck}`,
      description: `${values.priority === 'urgent' ? 'Unit marked out of service. ' : ''}${
        values.notifyDriver ? 'The driver has been notified.' : ''
      }`,
      action: { label: 'View', onClick: () => undefined },
    });
    form.reset();
  }

  return (
    <GallerySection
      id="form"
      index={4}
      title="Form"
      note="useZodForm + Form + FormSection + ControlledField. Validation on blur first, then on change; the primary action sits bottom-right and the destructive one never next to it."
    >
      <Card
        title="Schedule maintenance"
        description="Books a shop slot and, when urgent, pulls the unit from dispatch."
      >
        <Form form={form} onSubmit={onSubmit}>
          <FormSection title="Service" description="What is being done, where and when.">
            <ControlledField
              name="truckId"
              label="Truck"
              required
              render={({ field }) => (
                <Combobox
                  id={field.id}
                  options={truckOptions}
                  value={field.value}
                  onValueChange={(v) => field.onChange(v ?? '')}
                  onBlur={field.onBlur}
                  placeholder="Select a truck"
                />
              )}
            />
            <ControlledField
              name="type"
              label="Service type"
              required
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={serviceTypes}
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                  placeholder="Choose a service"
                />
              )}
            />
            <ControlledField
              name="vendor"
              label="Vendor"
              required
              description="Approved vendors only; add new ones under Admin › Settings."
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={vendors}
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                  placeholder="Choose a vendor"
                />
              )}
            />
            <ControlledField
              name="scheduledFor"
              label="Scheduled for"
              required
              render={({ field }) => (
                <DatePicker
                  id={field.id}
                  value={field.value}
                  onChange={(d) => field.onChange(d)}
                  onBlur={field.onBlur}
                  minDate={GALLERY_NOW}
                />
              )}
            />
            <ControlledField
              name="odometer"
              label="Odometer"
              required
              description="Last reading: 421,500 mi."
              render={({ field }) => (
                <Input {...field} suffix="mi" inputMode="numeric" placeholder="421,900" />
              )}
            />
            <ControlledField
              name="estimate"
              label="Estimate"
              description="Optional. Leave blank if the vendor quotes on arrival."
              render={({ field }) => (
                <Input {...field} prefix="$" inputMode="decimal" placeholder="850.00" />
              )}
            />
          </FormSection>

          <FormSection
            title="Priority and notes"
            description="How urgent it is and what the shop needs to know."
          >
            <ControlledField
              name="priority"
              label="Priority"
              required
              render={({ field }) => (
                <RadioGroup
                  id={field.id}
                  options={priorityOptions}
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            <div className="flex flex-col gap-4">
              <ControlledField
                name="notes"
                label="Notes for the shop"
                render={({ field }) => (
                  <Textarea
                    {...field}
                    rows={4}
                    placeholder="Recurring DEF fault code SPN 3364; check the dosing unit."
                  />
                )}
              />
              <ControlledField
                name="notifyDriver"
                render={({ field }) => (
                  <Checkbox
                    id={field.id}
                    label="Notify the assigned driver"
                    description="Sends the appointment to the driver app."
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
          </FormSection>

          <FormActions>
            <Button
              variant="secondary"
              type="button"
              onClick={() => form.reset()}
              disabled={submitting}
            >
              Reset
            </Button>
            <Button variant="primary" type="submit" loading={submitting}>
              Schedule maintenance
            </Button>
          </FormActions>
        </Form>
      </Card>
    </GallerySection>
  );
}
