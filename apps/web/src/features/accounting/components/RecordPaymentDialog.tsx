import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { checkApplication, daysPastDue, proposeApplication } from '@neway/shared';
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { recordPayment, type Invoice, type Payment } from '@/demo';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { useAccounting, useInvalidateAccounting } from '../useAccounting';

/**
 * Receives a payment and applies it.
 *
 * The allocation is proposed oldest-debt-first — which is how a collections clerk works by hand —
 * and every line is editable. Nothing is written until the whole allocation passes: over-applying
 * to an invoice or applying more than was received aborts the payment rather than partially
 * applying it, because a half-applied payment is worse than a rejected one. Nobody knows which
 * half.
 */
export function RecordPaymentDialog({
  open,
  onOpenChange,
  partyId,
  partyName,
  partyType,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  partyName: string;
  partyType: 'customer' | 'broker';
  onDone: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateAccounting();
  const query = useAccounting('year');
  const bundle = query.data;
  const today = bundle?.today ?? '';

  const openInvoices = useMemo(
    () =>
      (bundle?.invoices ?? [])
        .filter(
          (i) =>
            i.billToId === partyId && i.balance > 0 && i.status !== 'void' && i.status !== 'draft',
        )
        .sort((a, b) => (daysPastDue(b.dueOn, today) ?? 0) - (daysPastDue(a.dueOn, today) ?? 0)),
    [bundle, partyId, today],
  );

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Payment['method']>('ach');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(today);
  const [notes, setNotes] = useState('');
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [autoAllocate, setAutoAllocate] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const received = Number(amount) || 0;

  const targets = openInvoices.map((i) => ({
    invoiceId: i.id,
    invoiceNumber: i.invoiceNumber,
    balance: i.balance,
  }));

  const proposed = useMemo(() => {
    if (!autoAllocate || received <= 0) return null;
    const dueDates = new Map(openInvoices.map((i) => [i.id, i.dueOn]));
    return proposeApplication(received, targets, today, dueDates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAllocate, received, openInvoices, today]);

  const lines = useMemo(() => {
    if (proposed) return proposed;
    return Object.entries(allocations)
      .map(([invoiceId, value]) => ({ invoiceId, amount: Number(value) || 0 }))
      .filter((l) => l.amount > 0);
  }, [proposed, allocations]);

  const check = checkApplication(received, lines, targets);

  const record = useMutation({
    mutationFn: () =>
      recordPayment({
        partyType,
        partyId,
        partyName,
        amount: received,
        method,
        receivedOn,
        reference,
        applications: lines,
        notes: notes.trim() || null,
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.blocked ?? 'The payment could not be recorded.');
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: `${formatMoney(received)} recorded from ${partyName}`,
        description:
          check.unapplied > 0
            ? `${formatMoney(check.unapplied)} is unapplied and held until it is allocated.`
            : `Applied to ${lines.length} invoice${lines.length === 1 ? '' : 's'}.`,
      });
      onDone();
    },
  });

  const allocatedFor = (invoice: Invoice) =>
    lines.find((l) => l.invoiceId === invoice.id)?.amount ?? 0;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Record payment from ${partyName}`}
      description="Allocate it across the open invoices. Nothing is written until the whole allocation is valid."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={record.isPending}
            disabled={received <= 0 || !reference.trim() || !check.ok || lines.length === 0}
            onClick={() => {
              setError(null);
              record.mutate();
            }}
          >
            Apply payment
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

        <div className="grid gap-4 sm:grid-cols-4">
          <FormField label="Amount received" required>
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              prefix="$"
            />
          </FormField>
          <FormField label="Method" required>
            <Select
              options={[
                { value: 'ach', label: 'ACH' },
                { value: 'check', label: 'Check' },
                { value: 'wire', label: 'Wire' },
                { value: 'card', label: 'Card' },
                { value: 'factoring', label: 'Factoring' },
                { value: 'cash', label: 'Cash' },
              ]}
              value={method}
              onValueChange={(v) => setMethod(v as Payment['method'])}
            />
          </FormField>
          <FormField label="Reference" required>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="ACH-884120"
            />
          </FormField>
          <FormField label="Received on" required>
            <DatePicker value={receivedOn} onIsoChange={(e) => setReceivedOn(e)} />
          </FormField>
        </div>

        <Checkbox
          checked={autoAllocate}
          onCheckedChange={(checked) => setAutoAllocate(checked === true)}
          label="Allocate oldest debt first"
          description="Uncheck to set each line yourself."
        />

        {openInvoices.length === 0 ? (
          <Alert
            tone="info"
            title="Nothing open to apply against"
            description={`${partyName} has no outstanding invoices. The payment would be held entirely unapplied.`}
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-xs font-semibold text-secondary">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Invoice</th>
                  <th className="px-3 py-2 text-left font-medium">Due</th>
                  <th className="px-3 py-2 text-right font-medium">Balance</th>
                  <th className="px-3 py-2 text-right font-medium">Apply</th>
                </tr>
              </thead>
              <tbody>
                {openInvoices.map((invoice) => {
                  const late = daysPastDue(invoice.dueOn, today) ?? 0;
                  const applied = allocatedFor(invoice);
                  return (
                    <tr key={invoice.id} className="border-t border-line-soft">
                      <td className="px-3 py-2 font-medium text-ink">{invoice.invoiceNumber}</td>
                      <td className={cn('px-3 py-2', late > 0 && 'text-danger-text')}>
                        {invoice.dueOn ? formatIsoDate(invoice.dueOn) : '—'}
                        {late > 0 ? <span className="ml-1 text-xs">({late}d late)</span> : null}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMoney(invoice.balance)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {autoAllocate ? (
                          <span
                            className={cn(
                              'tabular-nums',
                              applied > 0 ? 'font-medium text-ink' : 'text-faint',
                            )}
                          >
                            {applied > 0 ? formatMoney(applied) : '—'}
                          </span>
                        ) : (
                          <Input
                            inputMode="decimal"
                            className="w-28 text-right"
                            value={allocations[invoice.id] ?? ''}
                            onChange={(e) =>
                              setAllocations((prev) => ({ ...prev, [invoice.id]: e.target.value }))
                            }
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {check.errors.length > 0 ? (
          <Alert
            tone="danger"
            title="This allocation cannot be applied"
            description={check.errors.join('. ')}
          />
        ) : null}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-line-soft bg-surface px-4 py-3 text-sm">
          <span className="text-muted">
            Applying <span className="font-semibold text-ink">{formatMoney(check.applied)}</span> of{' '}
            {formatMoney(received)}
          </span>
          {check.unapplied > 0 ? (
            <span
              className="font-medium text-warning-text"
              title="Unapplied cash is held as a liability until it is allocated: the carrier is holding someone else's money against no specific invoice."
            >
              {formatMoney(check.unapplied)} unapplied
            </span>
          ) : (
            <span className="text-success-text">Fully applied</span>
          )}
        </div>

        <FormField label="Notes" description="Optional.">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
