import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card } from '@/design-system';
import { fetchSupplements, getInvoiceFromServer, type Load } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { AddChargeAfterInvoicingDialog } from '@/features/accounting/AddChargeAfterInvoicingDialog';
import { formatMoney } from '@/lib/format';

/**
 * A layover, detention or lumper that comes in after the load's invoice went to RTS (owner,
 * 2026-10-21): offered here, on the load, to Accounting. The invoice already sent is not changed;
 * the charge is billed on a supplemental invoice for the same load.
 */
export function LateChargesPanel({ load }: { load: Load }) {
  const account = useAccount();
  const canView = account?.permissions.includes('accounting.view') ?? false;
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const invoiceId = load.invoiceId;
  const invoice = useQuery({ queryKey: ['accounting', 'invoice', invoiceId], queryFn: () => getInvoiceFromServer(invoiceId!), enabled: Boolean(invoiceId && canView) });
  const supps = useQuery({ queryKey: ['accounting', 'invoice-supplements', invoiceId], queryFn: () => fetchSupplements(invoiceId!), enabled: Boolean(invoiceId && canView) });
  if (!invoiceId || !canView) return null;
  if (invoice.isPending || supps.isPending) return <Card title="Charges after invoicing"><p className="text-sm text-muted">Loading…</p></Card>;
  if (!invoice.data || !supps.data) return null;
  const check = supps.data.check;
  const list = supps.data.supplements.filter((s) => s.status !== 'void');
  return (
    <Card
      title="Charges after invoicing"
      description={check.ok ? `${check.why}, so it is not changed. A layover, detention or lumper that came later is billed on a supplemental invoice for this load.` : `${invoice.data.invoiceNumber} has not gone to RTS: a late charge is added to it with Create revision on the invoice page.`}
      actions={canEdit && check.ok ? <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>Add charge after invoicing</Button> : <Link to="/accounting/invoices/$invoiceId" params={{ invoiceId }} className="text-sm font-semibold text-primary-text hover:underline">Open {invoice.data.invoiceNumber}</Link>}
    >
      {list.length === 0 ? (
        <p className="text-sm text-muted">No supplemental invoice for this load.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-soft">
          {list.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <Link to="/accounting/invoices/$invoiceId" params={{ invoiceId: s.id }} className="font-semibold text-primary-text hover:underline">{s.invoiceNumber}</Link>
                <span className="block text-xs text-muted">{s.lines.map((l) => l.description).join(', ')}{s.supplementOf?.reason ? ` · ${s.supplementOf.reason}` : ''}</span>
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={s.status === 'draft' ? 'warning' : s.status === 'funded' || s.status === 'paid' ? 'success' : 'info'} size="sm">{s.status.replace(/_/g, ' ')}</Badge>
                <span className="tabular-nums">{formatMoney(s.total)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <AddChargeAfterInvoicingDialog
          invoice={invoice.data}
          nextSequence={supps.data.supplements.reduce((m, s) => Math.max(m, s.supplementOf?.sequence ?? 0), 0) + 1}
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await Promise.all([queryClient.invalidateQueries({ queryKey: ['accounting'] }), queryClient.invalidateQueries({ queryKey: ['loads'] }), queryClient.invalidateQueries({ queryKey: ['load'] })]);
          }}
        />
      ) : null}
    </Card>
  );
}
