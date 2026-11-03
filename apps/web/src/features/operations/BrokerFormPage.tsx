import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { createBroker } from '@/demo';
import { FormBlock } from '@/features/forms/FormBlock';
import {
  BackButton,
  Alert,
  Button,
  Checkbox,
  ControlledField,
  Form,
  FormActions,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
  useZodForm,
} from '@/design-system';
import {
  PAYMENT_TERMS,
  brokerFormSchema,
  normalizeMc,
  type BrokerFormValues,
} from './BrokerFormSchema';

/**
 * Adds a broker.
 *
 * Deliberately short. A broker's rating, volume, margin and payment behaviour are all computed from
 * the freight they actually give you, so asking anyone to type them here would create numbers the
 * system would then have to distrust.
 */
/**
 * The page wrapper, kept so `/brokers/new` still works and can be linked to. The register raises
 * the same form in a dialog, which is where it is normally met.
 */
export function BrokerFormPage() {
  const navigate = useNavigate();
  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/brokers" />}
        title="Add broker"
        description="Who they are, how to reach them, and how they pay."
      />
      <div className="flex w-full max-w-220 flex-col gap-(--section-gap)">
        <BrokerForm
          onCancel={() => void navigate({ href: '/brokers' })}
          onCreated={(brokerId) =>
            void navigate({ href: `/brokers?broker=${encodeURIComponent(brokerId)}` })
          }
        />
      </div>
    </div>
  );
}

/** The form itself, page-free so the brokers register can raise it over the list. */
export function BrokerForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (brokerId: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useZodForm(brokerFormSchema, {
    defaultValues: {
      name: '',
      mcNumber: '',
      usdot: '',
      addressLine1: '',
      city: '',
      state: '',
      zip: '',
      paymentTermsDays: 30,
      contactName: '',
      contactEmail: '',
      contactPhone: '',
      doNotUse: false,
      doNotUseReason: '',
    },
  });

  const doNotUse = form.watch('doNotUse');

  const create = useMutation({
    mutationFn: (values: BrokerFormValues) =>
      createBroker({
        name: values.name,
        mcNumber: normalizeMc(values.mcNumber),
        usdot: values.usdot ?? '',
        addressLine1: values.addressLine1,
        city: values.city,
        state: values.state,
        zip: values.zip,
        paymentTermsDays: values.paymentTermsDays,
        contactName: values.contactName,
        contactEmail: values.contactEmail,
        contactPhone: values.contactPhone,
        doNotUse: values.doNotUse,
        doNotUseReason: values.doNotUseReason?.trim() ? values.doNotUseReason.trim() : null,
      }),
    onSuccess: async (broker) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['brokers'] }),
      ]);
      toast({
        tone: 'success',
        title: `${broker.name} added`,
        description: broker.doNotUse
          ? 'Flagged do-not-use and placed on hold.'
          : 'Not rated until they have settled enough loads to grade.',
      });
      onCreated(broker.id);
    },
    onError: (error: unknown) => {
      setSubmitError(error instanceof Error ? error.message : 'The broker could not be added.');
    },
  });

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-3">
        <Alert
          tone="info"
          title="Risk and profitability are earned, not entered"
          description="A new broker starts unrated with no volume and no history. The risk engine reports 'not enough data' until they have settled enough loads to grade, and their margin and payment behaviour are computed from the freight they actually give you."
        />

        {submitError ? (
          <p role="alert" className="text-sm text-danger-text">
            {submitError}
          </p>
        ) : null}

        <Form
          form={form}
          onSubmit={(values: BrokerFormValues) => create.mutate(values)}
          className="gap-(--section-gap)"
        >
          <FormBlock title="Identity" hint="How the broker appears on a rate confirmation.">
            <ControlledField
              name="name"
              label="Broker name"
              required
              render={({ field }) => (
                <Input {...field} placeholder="Summit Freight Brokerage" autoComplete="off" />
              )}
            />
            <ControlledField
              name="mcNumber"
              label="MC number"
              description="Optional. When given it must be unique: MC-123456 or just the digits."
              render={({ field }) => (
                <Input
                  {...field}
                  placeholder="MC-123456"
                  autoComplete="off"
                  className="uppercase"
                />
              )}
            />
            <ControlledField
              name="usdot"
              label="USDOT"
              description="Optional; 5 to 8 digits."
              render={({ field }) => (
                <Input {...field} placeholder="1234567" inputMode="numeric" autoComplete="off" />
              )}
            />
          </FormBlock>

          <FormBlock title="Address" hint="Their billing address.">
            <ControlledField
              name="addressLine1"
              label="Street"
              required
              render={({ field }) => <Input {...field} placeholder="410 Commerce Dr" />}
            />
            <div className="grid grid-cols-[minmax(0,1fr)_5rem_7rem] gap-3">
              <ControlledField
                name="city"
                label="City"
                required
                render={({ field }) => <Input {...field} placeholder="Dallas" />}
              />
              <ControlledField
                name="state"
                label="State"
                required
                render={({ field }) => (
                  <Input {...field} placeholder="TX" maxLength={2} className="uppercase" />
                )}
              />
              <ControlledField
                name="zip"
                label="ZIP"
                required
                render={({ field }) => <Input {...field} placeholder="75201" inputMode="numeric" />}
              />
            </div>
          </FormBlock>

          <FormBlock
            title="Payment"
            hint="Terms are what days-to-pay is measured against, which is why they are required."
          >
            <ControlledField
              name="paymentTermsDays"
              label="Payment terms"
              required
              render={({ field }) => (
                <Select
                  id={field.id}
                  options={[...PAYMENT_TERMS]}
                  value={String(field.value)}
                  onValueChange={(value) => field.onChange(Number(value))}
                  onBlur={field.onBlur}
                />
              )}
            />
          </FormBlock>

          <FormBlock title="Contact" hint="Who to call about a load.">
            <ControlledField
              name="contactName"
              label="Contact name"
              required
              render={({ field }) => <Input {...field} placeholder="Olivia Morris" />}
            />
            <ControlledField
              name="contactEmail"
              label="Email"
              required
              render={({ field }) => (
                <Input {...field} type="email" placeholder="olivia@summitfreight.com" />
              )}
            />
            <ControlledField
              name="contactPhone"
              label="Phone"
              required
              render={({ field }) => <Input {...field} type="tel" placeholder="+1 214 555 0180" />}
            />
          </FormBlock>

          <FormBlock title="Standing" hint="Flag a broker you already know not to haul for.">
            <ControlledField
              name="doNotUse"
              label="Do not use"
              render={({ field }) => (
                <Checkbox
                  id={field.id}
                  checked={Boolean(field.value)}
                  onCheckedChange={field.onChange}
                  label="Do not book freight with this broker"
                  description="Places them on hold and grades them high risk immediately."
                />
              )}
            />
            {doNotUse ? (
              <ControlledField
                name="doNotUseReason"
                label="Reason"
                required
                description="Quoted verbatim as the reason for the high-risk grade."
                render={({ field }) => (
                  <Textarea
                    {...field}
                    rows={2}
                    placeholder="Two invoices past 90 days; collections referred."
                  />
                )}
              />
            ) : null}
          </FormBlock>

          <FormActions>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add broker
            </Button>
          </FormActions>
        </Form>
      </div>
    </div>
  );
}
