import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DISPATCH_DRIVER_DOCUMENT_CODES, partsOf, type ComplianceDocument } from '@neway/shared';
import { Button, Card, StatusBadge } from '@/design-system';
import { listComplianceDocuments } from '@/features/safety/compliance-api';
import { formatDateTime } from '@/lib/format';
import { CdlPairViewer, type CdlSide } from './CdlPairViewer';
import type { OperationalDriver } from './useOperations';

/**
 * The CDL alone, front and back, for the dispatch view of a driver (owner, 2026-10-26: "from
 * Documents only the CDL"). Read-only: the row says what is on file and View opens both sides.
 * The server returns only the CDL to a dispatch reader; the filter here is the same rule again.
 */
export function DriverCdlDocument({ row }: { row: OperationalDriver }) {
  const driverId = row.driver.id;
  const [open, setOpen] = useState(false);
  const documents = useQuery({
    queryKey: ['compliance-documents', 'driver', driverId, 'cdl'],
    queryFn: () => listComplianceDocuments({ ownerType: 'driver', ownerId: driverId }),
  });
  const sides = useMemo<CdlSide[]>(() => {
    const latest = new Map<string, ComplianceDocument>();
    for (const doc of documents.data ?? []) {
      if (!DISPATCH_DRIVER_DOCUMENT_CODES.has(doc.requirementCode)) continue;
      const current = latest.get(doc.requirementCode);
      if (!current || doc.uploadedAt > current.uploadedAt) latest.set(doc.requirementCode, doc);
    }
    // No item: this view never offers an upload.
    return partsOf('cdl').map((r) => ({ code: r.code, label: r.partLabel ?? r.name, item: null, document: latest.get(r.code) ?? null }));
  }, [documents.data]);

  const onFile = sides.filter((side) => side.document !== null);
  const missing = sides.filter((side) => side.document === null).map((side) => side.label);
  const newest = onFile
    .map((side) => side.document!)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];

  return (
    <Card padding="none" title="CDL" description="The driver's commercial licence, front and back.">
      <div className="flex flex-wrap items-center gap-3 border-t border-nw-border px-4 py-3" data-testid="dispatch-cdl-row">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <FileText className="size-4 shrink-0 text-nw-text-3" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">CDL</span>
            {newest ? <span className="block text-xs text-nw-text-3">Uploaded {formatDateTime(newest.uploadedAt)}</span> : null}
          </span>
        </span>
        {documents.isPending ? (
          <span className="text-sm text-muted">Loading…</span>
        ) : documents.isError ? (
          <span className="text-sm text-muted">The CDL could not be loaded.</span>
        ) : (
          <>
            {missing.length === 0 ? (
              <StatusBadge status="received" label="On file" size="sm" />
            ) : onFile.length === 0 ? (
              <StatusBadge status="missing" label="Not on file" size="sm" />
            ) : (
              <StatusBadge status="missing" label={`Incomplete · ${missing.join(' and ')} missing`} size="sm" />
            )}
            {onFile.length > 0 ? (
              <Button size="sm" variant="link" onClick={() => setOpen(true)}>
                View
              </Button>
            ) : null}
          </>
        )}
      </div>
      {open ? (
        <CdlPairViewer
          title="CDL"
          subtitle={`${row.driver.name} · ${row.driver.driverNumber}`}
          sides={sides}
          onUpload={() => setOpen(false)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Card>
  );
}
