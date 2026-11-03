import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { Ban, DollarSign, Send } from 'lucide-react';
import { useState } from 'react';
import { daysPastDue } from '@neway/shared';
import {
  BackButton,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  Timeline,
  useToast,
  type TimelineItem,
} from '@/design-system';
import { issueInvoice } from '@/demo';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { AccountingFactList, AccountingPanel, Money } from './components/AccountingKit';
import { InvoiceDocuments } from './components/InvoiceDocuments';
import { JournalEntryCard } from './components/JournalEntryCard';
import { InvoiceRevisionsPanel } from './InvoiceRevisionsPanel';
import { RecordPaymentDialog } from './components/RecordPaymentDialog';
import { VoidInvoiceDialog } from './components/VoidInvoiceDialog';
import { useAccounting, useInvalidateAccounting } from './useAccounting';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'lines', label: 'Line items' },
  { value: 'payments', label: 'Payments' },
  { value: 'ledger', label: 'Accounting' },
  { value: 'documents', label: 'Documents' },
  { value: 'activity', label: 'Activity' },
];

export function InvoiceDetailRoute() {
  const { invoiceId } = useParams({ from: '/accounting/invoices/$invoiceId' });
  return <InvoiceDetailPage invoiceId={invoiceId} />;
}

/**
 * The invoice workspace — full screen.
 *
 * The Accounting tab is the point of it: the journal entries this invoice produced, with their
 * debits and credits, so anybody can see exactly what it did to the books rather than trusting that
 * it did something.
 */
export function InvoiceDetailPage({ invoiceId }: { invoiceId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateAccounting();
  const query = useAccounting('year');
  const [tab, setTab] = useState('overview');
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);

  const bundle = query.data;
  const invoice =
    bundle?.byInvoiceId.get(invoiceId) ??
    bundle?.invoices.find((i) => i.invoiceNumber === invoiceId);

  const issue = useMutation({
    mutationFn: () => issueInvoice({ invoiceId: invoice?.id ?? '' }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({ tone: 'success', title: `${result.invoice?.invoiceNumber} issued` });
    },
  });

  if (query.isPending) {
    return (
      <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!invoice || !bundle) {
    return (
      <EmptyState
        title="That invoice is not on file"
        description="It may have been removed, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/accounting/invoices' })}>
            Back to invoices
          </Button>
        }
      />
    );
  }

  const lines = bundle.invoiceLines.filter((l) => l.invoiceId === invoice.id);
  const entries = bundle.journal.filter((e) => e.reference?.id === invoice.id);
  const payments = bundle.payments.filter((p) =>
    p.applications.some((a) => a.invoiceId === invoice.id),
  );
  const late = daysPastDue(invoice.dueOn, bundle.today) ?? 0;

  const timeline: TimelineItem[] = [];
  if (invoice.issuedOn) {
    timeline.push({
      id: 'issued',
      at: `${invoice.issuedOn}T12:00:00Z`,
      title: 'Invoice issued',
      description: `${formatMoney(invoice.total)} to ${invoice.billToName}`,
      tone: 'info',
    });
  }
  for (const payment of payments) {
    const applied = payment.applications.find((a) => a.invoiceId === invoice.id);
    timeline.push({
      id: `pay-${payment.id}`,
      at: payment.createdAt,
      title: `${formatMoney(applied?.amount ?? 0)} received`,
      description: `${payment.method.toUpperCase()} · ${payment.reference}`,
      tone: 'success',
    });
  }
  timeline.sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)));

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/accounting/invoices" />}
        title={invoice.invoiceNumber}
        description={`${invoice.billToName} · ${formatMoney(invoice.total)}`}
        actions={
          <>
            {invoice.status === 'draft' ? (
              <Button variant="primary" icon={<Send />} onClick={() => issue.mutate()}>
                Issue invoice
              </Button>
            ) : null}
            {invoice.balance > 0 && invoice.status !== 'void' && invoice.status !== 'draft' ? (
              <Button variant="primary" icon={<DollarSign />} onClick={() => setPaying(true)}>
                Record payment
              </Button>
            ) : null}
            {invoice.status !== 'void' && invoice.paid === 0 ? (
              <Button variant="secondary" icon={<Ban />} onClick={() => setVoiding(true)}>
                Void
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={invoice.status} />
        {late > 0 && invoice.balance > 0 ? (
          <Badge tone="danger">{late} days past due</Badge>
        ) : invoice.balance > 0 ? (
          <Badge tone="success">In terms</Badge>
        ) : null}
        <span className="text-sm text-muted">
          Net {invoice.paymentTermsDays} · balance {formatMoney(invoice.balance)}
        </span>
      </div>

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Invoice">
        <TabsContent value="overview" className="pt-4">
          {/* Versions, revisions and both kinds of note, straight from the server's record. */}
          <div className="mb-4"><InvoiceRevisionsPanel invoiceId={invoice.id} /></div>
          <div className="grid gap-4 lg:grid-cols-3">
            <AccountingPanel title="Invoice">
              <AccountingFactList
                facts={[
                  { label: 'Invoice #', value: invoice.invoiceNumber },
                  {
                    label: 'Issued',
                    value: invoice.issuedOn ? formatIsoDate(invoice.issuedOn) : 'Not issued',
                  },
                  { label: 'Due', value: invoice.dueOn ? formatIsoDate(invoice.dueOn) : '—' },
                  { label: 'Terms', value: `Net ${invoice.paymentTermsDays}` },
                  { label: 'Subtotal', value: <Money value={invoice.subtotal} /> },
                  { label: 'Total', value: <Money value={invoice.total} />, emphasis: true },
                ]}
              />
            </AccountingPanel>

            <AccountingPanel title="Bill to">
              <AccountingFactList
                facts={[
                  {
                    label: invoice.billToType === 'broker' ? 'Broker' : 'Customer',
                    value:
                      invoice.billToType === 'broker' ? (
                        <Link
                          to="/brokers"
                          search={{ broker: invoice.billToId }}
                          className="text-primary-text hover:underline"
                        >
                          {invoice.billToName}
                        </Link>
                      ) : (
                        <Link
                          to="/customers"
                          search={{ customer: invoice.billToId }}
                          className="text-primary-text hover:underline"
                        >
                          {invoice.billToName}
                        </Link>
                      ),
                  },
                  {
                    label: 'Load',
                    value: (
                      <Link
                        to="/loads/$loadNumber"
                        params={{ loadNumber: invoice.loadNumber }}
                        className="text-primary-text hover:underline"
                      >
                        {invoice.loadNumber}
                      </Link>
                    ),
                  },
                ]}
              />
            </AccountingPanel>

            <AccountingPanel title="Payment">
              <AccountingFactList
                facts={[
                  { label: 'Invoiced', value: <Money value={invoice.total} /> },
                  { label: 'Paid', value: <Money value={invoice.paid} /> },
                  { label: 'Balance', value: <Money value={invoice.balance} />, emphasis: true },
                  {
                    label: 'Paid on',
                    value: invoice.paidOn ? formatIsoDate(invoice.paidOn) : '—',
                  },
                ]}
              />
            </AccountingPanel>
          </div>
        </TabsContent>

        <TabsContent value="lines" className="pt-4">
          <Card className="p-4">
            <table className="w-full text-sm">
              <thead className="text-xs font-semibold text-secondary">
                <tr>
                  <th className="py-2 text-left font-medium">Charge</th>
                  <th className="py-2 text-left font-medium">Description</th>
                  <th className="py-2 text-right font-medium">Qty</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-t border-line-soft">
                    <td className="py-2">{line.chargeType.replace(/_/g, ' ')}</td>
                    <td className="py-2 text-secondary">{line.description}</td>
                    <td className="py-2 text-right tabular-nums">{line.quantity}</td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(line.rate)}</td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(line.amount)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-line-strong font-semibold">
                  <td className="py-2" colSpan={4}>
                    Total
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatMoney(invoice.total)}</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </TabsContent>

        <TabsContent value="payments" className="pt-4">
          {payments.length === 0 ? (
            <EmptyState
              title="Nothing received yet"
              description="Payments applied to this invoice appear here with their reference and method."
            />
          ) : (
            <Card className="p-4">
              <ul className="divide-y divide-line-soft">
                {payments.map((payment) => {
                  const applied = payment.applications.find((a) => a.invoiceId === invoice.id);
                  return (
                    <li key={payment.id} className="flex items-center justify-between gap-4 py-3">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-ink">
                          {payment.reference}
                        </span>
                        <span className="block text-xs text-muted">
                          {payment.method.toUpperCase()} · {formatIsoDate(payment.receivedOn)}
                        </span>
                      </span>
                      <span className="text-sm font-medium tabular-nums text-ink">
                        {formatMoney(applied?.amount ?? 0)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="ledger" className="pt-4">
          {entries.length === 0 ? (
            <EmptyState
              title="Nothing posted yet"
              description="A draft invoice has not touched the books. Issuing it debits accounts receivable and credits revenue."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {entries.map((entry) => (
                <JournalEntryCard key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="documents" className="pt-4">
          <InvoiceDocuments loadNumber={invoice.loadNumber} />
        </TabsContent>

        <TabsContent value="activity" className="pt-4">
          <Card className="p-4">
            {timeline.length === 0 ? (
              <p className="text-sm text-faint">Nothing has happened to this invoice yet.</p>
            ) : (
              <Timeline items={timeline} />
            )}
          </Card>
        </TabsContent>
      </Tabs>

      {paying ? (
        <RecordPaymentDialog
          open
          onOpenChange={setPaying}
          partyId={invoice.billToId}
          partyName={invoice.billToName}
          partyType={invoice.billToType}
          onDone={() => setPaying(false)}
        />
      ) : null}

      {voiding ? (
        <VoidInvoiceDialog
          open
          onOpenChange={setVoiding}
          invoice={invoice}
          onDone={() => setVoiding(false)}
        />
      ) : null}
    </div>
  );
}
