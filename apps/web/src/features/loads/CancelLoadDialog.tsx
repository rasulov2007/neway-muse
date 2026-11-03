import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cancelRequires, type CancelOutcome } from '@neway/shared';
import { cancelLoad, loadWriteMessage, type Load } from '@/demo';
import { Alert, Button, FormField, Input, Modal, RadioGroup, Textarea, useToast } from '@/design-system';

/**
 * Cancelling a load (dispatch P0.1).
 *
 * Two outcomes: cancelled, or TONU - the truck was ordered and not used, and the broker owes a
 * fee. Both need a reason and who asked, because a cancel without those is the load a broker
 * disputes in three weeks. The rule about who may cancel is the server's: this dialog only says
 * what the server will say, before the button is pressed.
 */
export function CancelLoadDialog({
  load,
  open,
  onOpenChange,
  isLead,
}: {
  load: Load;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the signed-in person holds `dispatch.manage`, as the server reported it. */
  isLead: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<CancelOutcome>('cancelled');
  const [reason, setReason] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [fee, setFee] = useState('');
  // The broker's approval (rule 1.9): who said yes, how, and the reference that shows it.
  const [approvalBy, setApprovalBy] = useState('');
  const [approvalMethod, setApprovalMethod] = useState<'email' | 'phone' | 'other'>('email');
  const [approvalReference, setApprovalReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const requirement = cancelRequires(load.status);
  const blocked =
    requirement === 'forbidden'
      ? `${load.loadNumber} is past the pickup. A load with freight on the trailer is delivered or claimed, not cancelled.`
      : requirement === 'lead' && !isLead
        ? `${load.loadNumber} is already dispatched. Cancelling it takes the right to edit loads.`
        : null;

  const feeValue = fee.trim() === '' ? null : Number(fee);
  const feeValid = outcome !== 'tonu' || (feeValue !== null && Number.isFinite(feeValue) && feeValue >= 0);
  const ready =
    !blocked && reason.trim().length >= 3 && requestedBy.trim().length > 0 && feeValid && approvalBy.trim().length > 0;

  const cancel = useMutation({
    mutationFn: () =>
      cancelLoad(load.id, {
        outcome,
        reason: reason.trim(),
        requestedBy: requestedBy.trim(),
        approval: {
          by: approvalBy.trim(),
          method: approvalMethod,
          reference: approvalReference.trim() || null,
          at: new Date().toISOString(),
        },
        fee: outcome === 'tonu' ? feeValue : null,
      }),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['load'] }),
        queryClient.invalidateQueries({ queryKey: ['loads'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['accounting'] }),
      ]);
      onOpenChange(false);
      toast({
        tone: 'warning',
        title: updated.status === 'tonu' ? `${updated.loadNumber} marked TONU` : `${updated.loadNumber} cancelled`,
        description: `Driver and equipment released. Tell ${load.brokerName ?? load.customerName} yourself - no notice is sent from here.`,
      });
    },
    onError: (err) => setError(loadWriteMessage(err, 'The load could not be cancelled.')),
  });

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (cancel.isPending) return;
        if (!next) {
          setError(null);
          cancel.reset();
        }
        onOpenChange(next);
      }}
      size="md"
      title={`Cancel ${load.loadNumber}`}
      description={`${load.origin.city}, ${load.origin.state} → ${load.destination.city}, ${load.destination.state}${load.driverName ? ` · ${load.driverName}` : ''}`}
      dismissible={!cancel.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={cancel.isPending}>
            Keep load
          </Button>
          <Button
            variant="danger"
            loading={cancel.isPending}
            disabled={!ready}
            onClick={() => {
              setError(null);
              cancel.mutate();
            }}
          >
            {outcome === 'tonu' ? 'Mark TONU' : 'Cancel load'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {blocked ? <Alert tone="warning" title="Cannot cancel from here" description={blocked} /> : null}
        <FormField label="Outcome" required>
          <RadioGroup
            label="Outcome"
            value={outcome}
            onValueChange={(value) => setOutcome(value === 'tonu' ? 'tonu' : 'cancelled')}
            disabled={Boolean(blocked) || cancel.isPending}
            options={[
              {
                value: 'cancelled',
                label: 'Cancelled',
                description: 'The load is off the board. Nothing is billed.',
              },
              {
                value: 'tonu',
                label: 'TONU - truck ordered, not used',
                description: 'The truck was committed and the broker owes a fee.',
              },
            ]}
          />
        </FormField>
        {outcome === 'tonu' ? (
          <FormField
            label="TONU fee"
            required
            description="What the broker agreed to. $0 is an answer; blank is not."
            error={fee.trim() !== '' && !feeValid ? 'Enter a dollar amount' : undefined}
          >
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              prefix="$"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              disabled={Boolean(blocked) || cancel.isPending}
              placeholder="250"
            />
          </FormField>
        ) : null}
        <FormField label="Requested by" required description="The broker, the customer, or us.">
          <Input
            value={requestedBy}
            onChange={(e) => setRequestedBy(e.target.value)}
            disabled={Boolean(blocked) || cancel.isPending}
            placeholder={load.brokerName ?? load.customerName}
          />
        </FormField>
        <FormField
          label="Broker approval"
          required
          description="Who at the broker agreed to it, and how. A cancellation nobody approved is a dispute."
        >
          <div className="flex flex-col gap-2">
            <Input
              aria-label="Approved by"
              value={approvalBy}
              onChange={(e) => setApprovalBy(e.target.value)}
              disabled={Boolean(blocked) || cancel.isPending}
              placeholder="Name at the broker"
            />
            <RadioGroup
              label="How the approval came"
              value={approvalMethod}
              onValueChange={(value) => setApprovalMethod(value === 'phone' ? 'phone' : value === 'other' ? 'other' : 'email')}
              disabled={Boolean(blocked) || cancel.isPending}
              options={[
                { value: 'email', label: 'Email' },
                { value: 'phone', label: 'Phone' },
                { value: 'other', label: 'Other' },
              ]}
            />
            <Input
              value={approvalReference}
              onChange={(e) => setApprovalReference(e.target.value)}
              disabled={Boolean(blocked) || cancel.isPending}
              placeholder="Email subject, ticket, or a note on the call"
            />
          </div>
        </FormField>
        <FormField label="Reason" required>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={Boolean(blocked) || cancel.isPending}
            placeholder="Shipper not ready; rescheduled to next week"
          />
        </FormField>
        <p className="text-xs text-muted">
          {load.driverName || load.truckUnit || load.trailerUnit
            ? `Releases ${[
                load.driverName ? `driver ${load.driverName}` : null,
                load.truckUnit ? `unit ${load.truckUnit}` : null,
                load.trailerUnit ? `trailer ${load.trailerUnit}` : null,
              ]
                .filter(Boolean)
                .join(', ')}. `
            : ''}
          Recorded on the timeline with your name. This cannot be undone.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
