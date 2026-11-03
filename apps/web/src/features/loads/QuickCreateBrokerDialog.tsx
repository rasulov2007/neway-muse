import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, FormField, Input, Modal, useToast } from '@/design-system';
import { createBroker, type Broker } from '@/demo';
import { FormBlock } from '@/features/forms/FormBlock';

/**
 * Adding a broker without leaving the load.
 *
 * A rate confirmation arrives from a broker the system has never seen, and the dispatcher is half
 * way through booking the load. Sending them to the Brokers page to come back and start again is
 * the reason load entry feels slow, so the missing record is created here and selected on the spot.
 *
 * Only what a broker cannot exist without is asked for. Their rating, volume and payment behaviour
 * are computed from the freight they actually give you, and typing them here would invent numbers
 * the risk engine would then have to distrust.
 */
export function QuickCreateBrokerDialog({
  name,
  onClose,
  onCreated,
}: {
  name: string;
  onClose: () => void;
  onCreated: (broker: Broker) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [brokerName, setBrokerName] = useState(name);
  const [mcNumber, setMcNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createBroker({
        name: brokerName.trim(),
        mcNumber: mcNumber.trim().toUpperCase().startsWith('MC-')
          ? mcNumber.trim().toUpperCase()
          : `MC-${mcNumber.trim()}`,
        usdot: '',
        addressLine1: street.trim(),
        city: city.trim(),
        state: state.trim().toUpperCase(),
        zip: zip.trim(),
        paymentTermsDays: 30,
        contactName: brokerName.trim(),
        contactEmail: email.trim() || billingEmail.trim(),
        contactPhone: phone.trim(),
        doNotUse: false,
        doNotUseReason: null,
      }),
    onSuccess: async (broker) => {
      await queryClient.invalidateQueries({ queryKey: ['brokers'] });
      await queryClient.invalidateQueries({ queryKey: ['operations'] });
      toast({
        tone: 'success',
        title: `${broker.name} added`,
        description: 'Selected on this load. Payment terms default to Net 30 on their record.',
      });
      onCreated(broker);
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The broker could not be created'),
  });

  // The address travels with the broker, so an invoice has somewhere to go; only the name and the
  // MC number are what a broker cannot exist without.
  const valid = brokerName.trim() !== '' && mcNumber.trim() !== '';

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      title="New broker"
      description="Enough to book the load. The rest goes on their record later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            loading={create.isPending}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            Create and select
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not created">
            {error}
          </Alert>
        ) : null}

        <FormBlock>
          <div className="sm:col-span-2">
            <FormField label="Broker name" required>
              <Input value={brokerName} onChange={(event) => setBrokerName(event.target.value)} />
            </FormField>
          </div>
          <FormField label="MC number" required description="MC-123456, or just the digits.">
            <Input
              value={mcNumber}
              onChange={(event) => setMcNumber(event.target.value)}
              placeholder="MC-123456"
              className="uppercase"
            />
          </FormField>
          <FormField label="Phone">
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 214 555 0180"
            />
          </FormField>
          <FormField label="Email">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="dispatch@broker.com"
            />
          </FormField>
          <div className="sm:col-span-2">
            <FormField label="Billing address" description="Where their invoices are sent.">
              <Input
                value={street}
                onChange={(event) => setStreet(event.target.value)}
                placeholder="410 Commerce Dr"
              />
            </FormField>
          </div>
          <FormField label="City">
            <Input
              value={city}
              onChange={(event) => setCity(event.target.value)}
              placeholder="Dallas"
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="State">
              <Input
                value={state}
                maxLength={2}
                className="uppercase"
                onChange={(event) => setState(event.target.value)}
                placeholder="TX"
              />
            </FormField>
            <FormField label="ZIP">
              <Input
                value={zip}
                onChange={(event) => setZip(event.target.value)}
                placeholder="75201"
              />
            </FormField>
          </div>
          <FormField label="Billing email">
            <Input
              type="email"
              value={billingEmail}
              onChange={(event) => setBillingEmail(event.target.value)}
              placeholder="ap@broker.com"
            />
          </FormField>
        </FormBlock>
      </div>
    </Modal>
  );
}
