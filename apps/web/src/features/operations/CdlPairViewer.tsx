import { Upload } from 'lucide-react';
import type { ComplianceDocument, EvaluatedItem } from '@neway/shared';
import { Button, Modal, StatusBadge } from '@/design-system';
import { DocumentPreview } from '@/features/documents';
import { formatDateTime } from '@/lib/format';

export interface CdlSide {
  code: string;
  /** "Front" or "Back". */
  label: string;
  item: EvaluatedItem | null;
  /** The file on this side, when one is on file. */
  document: ComplianceDocument | null;
}

/**
 * The CDL opened from its row (owner, 2026-10-26): the front on the left, the back on the right,
 * on paper in both modes, stacked on a phone. A side with no file says Missing and offers its
 * upload; each side with one offers Replace.
 */
export function CdlPairViewer({
  title,
  subtitle,
  sides,
  onUpload,
  onClose,
}: {
  title: string;
  subtitle?: string;
  sides: CdlSide[];
  /** Opens the upload for one side (the viewer closes first). */
  onUpload: (side: CdlSide) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={title}
      description={subtitle}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="cdl-pair-viewer">
        {sides.map((side) => {
          const doc = side.document;
          return (
            <section key={side.code} className="flex min-w-0 flex-col gap-2" data-testid={`cdl-side-${side.code}`}>
              <header className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold tracking-wide text-nw-text-2 uppercase">{side.label}</h3>
                {doc ? (
                  <StatusBadge status={side.item?.status ?? 'received'} size="sm" />
                ) : (
                  <StatusBadge status="missing" label="Missing" size="sm" />
                )}
              </header>
              {doc && doc.hasFile ? (
                <DocumentPreview
                  source={{ kind: 'compliance', id: doc.id }}
                  title={`${title} — ${side.label}`}
                  contentType={doc.contentType}
                  fileName={doc.fileName}
                  className="min-h-72"
                  imageClassName="max-h-[60vh]"
                  frameClassName="h-[60vh]"
                />
              ) : (
                <div className="nw-paper flex min-h-72 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-nw-border p-4 text-center">
                  <p className="text-sm font-semibold text-nw-paper-text">
                    {doc ? 'Recorded without a file' : 'Missing'}
                  </p>
                  {side.item ? (
                    <Button size="sm" variant="outline" icon={<Upload />} onClick={() => onUpload(side)}>
                      Upload {side.label.toLowerCase()}
                    </Button>
                  ) : null}
                </div>
              )}
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-nw-text-3">
                  {doc ? `${doc.fileName} · ${formatDateTime(doc.uploadedAt)}` : 'Not uploaded'}
                </span>
                {doc && side.item ? (
                  <Button size="sm" variant="link" onClick={() => onUpload(side)}>
                    Replace {side.label.toLowerCase()}
                  </Button>
                ) : null}
              </span>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
