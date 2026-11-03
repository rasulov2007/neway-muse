import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ExternalLink, FileText } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState } from '@/design-system';
import { getLoad } from '@/demo';
import { DOCUMENT_TYPE_LABEL } from '@/features/loads/loadUtils';
import { ApiError } from '@/lib/api-client';
import { hasFile, openFile } from '@/lib/files';
import { formatIsoDate } from '@/lib/format';

/** The order an invoice packet is read in: the RC, the trip paperwork, then the extras. */
const ORDER = ['rate_confirmation', 'bol', 'pod', 'tonu', 'lumper_receipt', 'detention', 'layover', 'invoice', 'other'];

/**
 * The invoice's documents (owner, 2026-10-15: "documents are there but the tab is empty"). An
 * invoice owns no files of its own - its packet is its load's paperwork - so this reads the load
 * and lists the current files, each one opened in a new tab. Replaced and missing files are left
 * out; review states read as Accounting set them in the billing drawer.
 */
export function InvoiceDocuments({ loadNumber }: { loadNumber: string | null | undefined }) {
  const load = useQuery({
    queryKey: ['loads', 'one', loadNumber],
    queryFn: () => getLoad(loadNumber as string),
    enabled: Boolean(loadNumber),
  });

  if (!loadNumber) return <EmptyState title="No load on this invoice" description="An invoice written without a load has no load paperwork to show." />;
  if (load.isPending) return <p className="py-10 text-center text-sm text-nw-text-3">Loading…</p>;
  if (load.isError) {
    const refused = load.error instanceof ApiError && (load.error.status === 403 || load.error.status === 401);
    return refused ? (
      <EmptyState title="The load's documents need Loads access" description={`These files belong to load ${loadNumber}. Ask an administrator for the Loads view permission.`} />
    ) : (
      <ErrorState size="sm" title="The documents could not be loaded" error={load.error} onRetry={() => void load.refetch()} />
    );
  }
  const docs = (load.data?.documents ?? [])
    .filter((d) => d.status !== 'missing' && !(d as { supersededBy?: string | null }).supersededBy && hasFile(d))
    .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')));

  return (
    <section className="flex flex-col gap-3" aria-label="Invoice documents" data-testid="invoice-documents">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-nw-text-2">
          The paperwork on load{' '}
          <Link to="/loads/$loadNumber" params={{ loadNumber }} search={{ tab: 'documents' } as never} className="font-semibold text-nw-accent-ink hover:underline">
            {loadNumber}
          </Link>
          {docs.length ? ` · ${docs.length} file${docs.length === 1 ? '' : 's'}` : ''}
        </p>
      </div>
      {docs.length === 0 ? (
        <EmptyState title="No documents on the load yet" description="Upload the RC, BOL and POD on the load; they show here." />
      ) : (
        <ul className="flex flex-col divide-y divide-nw-border rounded-lg border border-nw-border bg-nw-panel">
          {docs.map((d) => {
            const review = (d as { review?: string | null }).review;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5" data-testid="invoice-document">
                <FileText aria-hidden className="size-4 shrink-0 text-nw-text-3" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-nw-text">
                    {DOCUMENT_TYPE_LABEL[d.type as keyof typeof DOCUMENT_TYPE_LABEL] ?? d.type}
                    {review === 'rejected' ? (
                      <Badge tone="danger" size="sm">Rejected</Badge>
                    ) : review === 'reviewed' || review === 'verified' ? (
                      <Badge tone="success" size="sm">Reviewed</Badge>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-nw-text-3" title={d.fileName ?? ''}>
                    {d.fileName ?? 'File'}
                    {d.uploadedAt ? ` · ${formatIsoDate(String(d.uploadedAt).slice(0, 10))}` : ''}
                    {d.uploadedBy ? ` · ${d.uploadedBy}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="outline" icon={<ExternalLink />} onClick={() => openFile(d)}>
                  Open
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
