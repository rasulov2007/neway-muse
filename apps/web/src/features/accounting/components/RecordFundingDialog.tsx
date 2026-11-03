import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, FormField, Input, Modal, Textarea } from '@/design-system';
import { recordFunding, type ServerInvoice } from '@/demo';
import { today as companyToday } from '@/lib/clock';
import { formatMoney } from '@/lib/format';

const toCents = (s: string): number | null => {
  const t = s.replace(/[$,\s]/g, '');
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/**
 * Record RTS funding (owner, 2026-10-15): the money RTS advanced against submitted invoices. One
 * funding can cover several invoices; the fee and any reserve come off it, and what reached the
 * bank is gross − fee − reserve - worked out here and checked again on the server. It is never a
 * customer receipt and is not added to outstanding invoices.
 */
export function RecordFundingDialog({ invoices, onClose }: { invoices: ServerInvoice[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reference, setReference] = useState('');
  const [fundedOn, setFundedOn] = useState(companyToday());
  const [fee, setFee] = useState('');
  const [reserve, setReserve] = useState('');
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>(() =>
    Object.fromEntries(invoices.map((i) => [i.id, Math.max(0, i.total - i.factoring.fundedGross).toFixed(2)])),
  );
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(invoices.map((i) => [i.id, true])));

  const allocations = invoices
    .filter((i) => on[i.id])
    .map((i) => ({ invoiceId: i.id, grossCents: toCents(picked[i.id] ?? '') }));
  const bad = allocations.some((a) => a.grossCents === null || a.grossCents === 0);
  const grossCents = allocations.reduce((s, a) => s + (a.grossCents ?? 0), 0);
  const feeCents = toCents(fee);
  const reserveCents = toCents(reserve);
  const netCents = feeCents === null || reserveCents === null ? null : grossCents - feeCents - reserveCents;
  const ready = reference.trim() !== '' && allocations.length > 0 && !bad && netCents !== null && netCents >= 0 && fee.trim() !== '';

  const save = useMutation({
    mutationFn: () =>
      recordFunding({
        provider: 'RTS',
        reference: reference.trim(),
        fundedOn,
        feeCents: feeCents ?? 0,
        reserveCents: reserveCents ?? 0,
        extraFees: [],
        allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, grossCents: a.grossCents ?? 0 })),
        netReceivedCents: netCents ?? 0,
        notes: notes.trim() || undefined,
      }),
    onSuccess: async (result) => {
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) return;
      await queryClient.invalidateQueries({ queryKey: ['accounting'] });
      onClose();
    },
  });
  const refused = save.data && typeof save.data === 'object' && 'ok' in save.data && save.data.ok === false ? (save.data as { blocked?: string }).blocked : null;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      size="lg"
      title="Record RTS funding"
      description="The money RTS advanced against submitted invoices. Fee and reserve come off; the rest is what reached the bank."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate()} data-testid="funding-save">
            Record funding
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="record-funding">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="RTS reference" required description="The schedule or funding number on RTS's notice.">
            <Input aria-label="RTS funding reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. SCH-778201" />
          </FormField>
          <FormField label="Funded on" required>
            <DatePicker aria-label="Funded on" value={fundedOn} onIsoChange={(v) => v && setFundedOn(v)} />
          </FormField>
        </div>

        <div className="overflow-x-auto rounded-lg border border-nw-border">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-nw-subtle text-left text-xs font-semibold text-nw-text-2">
              <tr>
                <th className="w-10 px-3 py-2" />
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2 text-right">Awaiting</th>
                <th className="px-3 py-2 text-right">Funded now ($)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nw-border">
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-2">
                    <Checkbox aria-label={`Include ${i.invoiceNumber}`} checked={on[i.id] ?? false} onCheckedChange={(v) => setOn((s) => ({ ...s, [i.id]: v === true }))} />
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-nw-text">{i.invoiceNumber}</span>
                    <span className="block text-xs text-nw-text-3">
                      {i.loadNumber} · {i.billToName}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(Math.max(0, i.total - i.factoring.fundedGross))}</td>
                  <td className="px-3 py-2">
                    <Input size="sm" inputMode="decimal" aria-label={`Funded now ${i.invoiceNumber}`} className="ml-auto w-32 text-right" disabled={!on[i.id]} value={picked[i.id] ?? ''} onChange={(e) => setPicked((s) => ({ ...s, [i.id]: e.target.value }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="RTS fee ($)" required description="As charged on this funding.">
            <Input inputMode="decimal" aria-label="RTS fee" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0.00" />
          </FormField>
          <FormField label="Reserve held ($)" description="Holdback, if any.">
            <Input inputMode="decimal" aria-label="Reserve held" value={reserve} onChange={(e) => setReserve(e.target.value)} placeholder="0.00" />
          </FormField>
          <div className="flex flex-col justify-center rounded-lg border border-nw-border bg-nw-subtle px-3 py-2 text-sm">
            <span className="text-xs text-nw-text-3">Gross {formatMoney(grossCents / 100)}</span>
            <span className="font-bold text-nw-text" data-testid="funding-net">
              Reaches the bank: {netCents === null ? '—' : formatMoney(netCents / 100)}
            </span>
          </div>
        </div>
        <FormField label="Notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        {bad ? <p className="text-xs text-nw-urgent-text">Each ticked invoice needs an amount above zero.</p> : null}
        {netCents !== null && netCents < 0 ? <p className="text-xs text-nw-urgent-text">Fee and reserve are more than the gross.</p> : null}
        {refused ? <Alert tone="danger" title="Not recorded">{refused}</Alert> : null}
        {save.error ? <Alert tone="danger" title="Not recorded">{save.error instanceof Error ? save.error.message : 'Try again.'}</Alert> : null}
      </div>
    </Modal>
  );
}
