import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  Eye,
  FileText,
  Image as ImageIcon,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useMemo, useState, type DragEvent } from 'react';
import type { ComplianceDocument } from '@neway/shared';
import {
  Badge,
  Button,
  ErrorState,
  ConfirmDialog,
  IconButton,
  SectionCard,
  Skeleton,
  cn,
  useToast,
} from '@/design-system';
import { unitDocumentRules } from '@/demo';
import { DocumentViewer } from '@/features/documents';
import {
  deleteComplianceDocument,
  listComplianceDocuments,
} from '@/features/safety/compliance-api';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { ExpiryBadge } from '@/features/documents/ExpiryBadge';
import { today } from '@/lib/clock';
import {
  documentExpiryStatus,
  documentRuleFor,
  documentTypesFor,
  fetchDocumentBlob,
} from '../unit-documents';
import { UnitDocumentDialog } from './UnitDocumentDialog';


/** One card on the grid: a document type the unit can carry, with whatever is on file for it. */
interface TypeCard {
  code: string;
  name: string;
  /** The newest version, when one is on file. */
  current: ComplianceDocument | null;
  /** Older versions, newest first, kept viewable. */
  earlier: ComplianceDocument[];
}

/**
 * The unit's paperwork: registration, title, inspection, insurance card, and the rest.
 *
 * Every card is a real document type from the catalog, and every file is a real document in the
 * compliance store — the same rows Safety reviews. The status pill is read off the expiry date
 * today. A type with nothing on file is shown as "Not uploaded" rather than hidden, so the grid is
 * also the checklist of what the unit is supposed to carry.
 */
export function UnitDocumentsTab({
  ownerType,
  ownerId,
  ownerLabel,
}: {
  ownerType: 'truck' | 'trailer';
  ownerId: string;
  ownerLabel: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<{
    replaceCode?: string;
    code?: string;
    file?: File | null;
  } | null>(null);
  const [viewing, setViewing] = useState<ComplianceDocument | null>(null);
  const [deleting, setDeleting] = useState<ComplianceDocument | null>(null);
  const [dragging, setDragging] = useState(false);

  const query = useQuery({
    queryKey: ['compliance-documents', ownerType, ownerId],
    queryFn: () => listComplianceDocuments({ ownerType, ownerId }),
  });
  const rules = unitDocumentRules();

  // One card per catalog type, in catalog order; a document whose type has left the catalog still
  // gets a card at the end rather than vanishing.
  const cards = useMemo((): TypeCard[] => {
    const docs = (query.data ?? []).filter((d) => d.status !== 'rejected');
    const byCode = new Map<string, ComplianceDocument[]>();
    for (const d of docs) {
      const bucket = byCode.get(d.requirementCode);
      if (bucket) bucket.push(d);
      else byCode.set(d.requirementCode, [d]);
    }
    for (const bucket of byCode.values()) bucket.sort((a, b) => b.version - a.version);
    const types = documentTypesFor(ownerType);
    const known = new Set(types.map((t) => t.code));
    const fromCatalog = types.map((t) => {
      const [current = null, ...earlier] = byCode.get(t.code) ?? [];
      return { code: t.code, name: t.name, current, earlier };
    });
    const orphaned = [...byCode.entries()]
      .filter(([code]) => !known.has(code))
      .map(([code, list]) => {
        const [current = null, ...earlier] = list;
        return { code, name: code.replace(/_/g, ' '), current, earlier };
      });
    return [...fromCatalog, ...orphaned];
  }, [query.data, ownerType]);

  const uploaded = cards.filter((c) => c.current).length;

  const remove = useMutation({
    mutationFn: (doc: ComplianceDocument) => deleteComplianceDocument(doc.id),
    onSuccess: async (_, doc) => {
      await queryClient.invalidateQueries({ queryKey: ['compliance-documents'] });
      await queryClient.invalidateQueries({ queryKey: ['compliance'] });
      await queryClient.invalidateQueries({ queryKey: ['fleet'] });
      setDeleting(null);
      toast({ tone: 'warning', title: `${doc.title} deleted` });
    },
    onError: (e: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not deleted',
        description: e instanceof Error ? e.message : undefined,
      }),
  });

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    if (file) setAdding({ file });
  }

  return (
    <div
      className={cn(
        'rounded-xl border border-transparent transition-colors',
        dragging && 'border-dashed border-primary bg-primary-soft',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <SectionCard
        icon={<FileText />}
        title="Documents"
        description={`Organize this unit's paperwork. Drop a file here to add it.`}
        actions={
          <>
            <span className="text-xs text-muted">{uploaded} uploaded</span>
            <Button icon={<Upload />} onClick={() => setAdding({})}>
              Add document
            </Button>
          </>
        }
        footer="Documents with an expiry date are tracked on the fleet action queue."
      >
        {query.isPending ? (
          <div className="grid gap-3 md:grid-cols-2" aria-busy>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : query.isError ? (
          // A list that could not be read is said; a blank grid would read as "nothing uploaded".
          <ErrorState
            title="The documents could not be loaded"
            description="What is on file is not shown until this loads."
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <ul
            role="list"
            aria-label={`${ownerLabel} documents`}
            className="grid gap-3 md:grid-cols-2"
          >
            {cards.map((card) => (
              <TypeCardView
                key={card.code}
                card={card}
                blocks={documentRuleFor(card.code, rules, ownerType) === 'block'}
                onAdd={() => setAdding({ code: card.code })}
                onView={setViewing}
                onReplace={() => setAdding({ replaceCode: card.code })}
                onDelete={setDeleting}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      {adding ? (
        <UnitDocumentDialog
          ownerType={ownerType}
          ownerId={ownerId}
          ownerLabel={ownerLabel}
          replaceCode={adding.replaceCode}
          initialCode={adding.code}
          initialFile={adding.file ?? null}
          onClose={() => setAdding(null)}
        />
      ) : null}
      {viewing ? (
        <DocumentViewer
          source={{ kind: 'compliance', id: viewing.id }}
          title={viewing.title}
          subtitle={`${viewing.fileName} · uploaded ${formatDateTime(viewing.uploadedAt)} by ${viewing.uploadedBy}`}
          contentType={viewing.contentType}
          fileName={viewing.fileName}
          onClose={() => setViewing(null)}
          onReplace={() => {
            const code = viewing.requirementCode;
            setViewing(null);
            setAdding({ replaceCode: code });
          }}
          onDelete={() => {
            const doc = viewing;
            setViewing(null);
            remove.mutate(doc);
          }}
          deleting={remove.isPending}
          deleteTitle={`Delete ${viewing.title}?`}
          deleteDescription="The file and its record are removed. If the type is one the unit must carry, it reads as missing again."
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        tone="danger"
        title={deleting ? `Delete ${deleting.title}?` : ''}
        description="The file and its record are removed. If the type is one the unit must carry, it reads as missing again."
        confirmLabel="Delete document"
        cancelLabel="Keep it"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
      />
    </div>
  );
}

function FileIcon({ doc, className }: { doc: ComplianceDocument; className?: string }) {
  return doc.contentType.startsWith('image/') ? (
    <ImageIcon className={className} aria-hidden />
  ) : (
    <FileText className={className} aria-hidden />
  );
}

function TypeCardView({
  card,
  blocks,
  onAdd,
  onView,
  onReplace,
  onDelete,
}: {
  card: TypeCard;
  blocks: boolean;
  onAdd: () => void;
  onView: (doc: ComplianceDocument) => void;
  onReplace: () => void;
  onDelete: (doc: ComplianceDocument) => void;
}) {
  const doc = card.current;
  const todayIso = today();
  const status = doc ? documentExpiryStatus(doc, todayIso) : null;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text [&_svg]:size-4"
        >
          <FileText />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{card.name}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            {doc && status ? (
              <ExpiryBadge expiresOn={doc.expiresOn} today={todayIso} />
            ) : (
              <Badge tone="neutral" size="sm">
                Not uploaded
              </Badge>
            )}
            {status === 'expired' && blocks ? (
              <span className="text-xs text-danger-text">holds dispatch</span>
            ) : null}
          </p>
        </div>
      </div>

      {doc ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="flex max-w-full items-center gap-1.5 text-left text-sm text-primary-text hover:underline disabled:text-muted"
              disabled={!doc.hasFile}
              onClick={() => onView(doc)}
              title={
                doc.hasFile ? 'Open in the viewer' : 'The file itself is not held by this system'
              }
            >
              <FileIcon doc={doc} className="size-4 shrink-0" />
              <span className="truncate">{doc.fileName}</span>
            </button>
            <p className="mt-0.5 text-xs text-muted">
              Issued {doc.issuedOn ? formatIsoDate(doc.issuedOn) : '—'} · Expires{' '}
              {doc.expiresOn ? formatIsoDate(doc.expiresOn) : '—'}
            </p>
            <p className="text-xs text-muted">
              Uploaded by {doc.uploadedBy} · {formatDateTime(doc.uploadedAt)}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-0.5">
            <IconButton
              label={`View ${doc.fileName}`}
              variant="ghost"
              size="sm"
              disabled={!doc.hasFile}
              onClick={() => onView(doc)}
            >
              <Eye />
            </IconButton>
            <IconButton
              label={`Download ${doc.fileName}`}
              variant="ghost"
              size="sm"
              disabled={!doc.hasFile}
              onClick={() => void download(doc)}
            >
              <Download />
            </IconButton>
            <IconButton
              label={`Replace ${doc.fileName}`}
              variant="ghost"
              size="sm"
              onClick={onReplace}
            >
              <RefreshCw />
            </IconButton>
            <IconButton
              label={`Delete ${doc.fileName}`}
              variant="ghost"
              size="sm"
              onClick={() => onDelete(doc)}
            >
              <Trash2 />
            </IconButton>
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">No file uploaded.</p>
          <Button variant="secondary" size="sm" icon={<Upload />} onClick={onAdd}>
            Upload file
          </Button>
        </div>
      )}

      {card.earlier.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-ink">
            {card.earlier.length} earlier {card.earlier.length === 1 ? 'version' : 'versions'}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1 border-l border-line-soft pl-3">
            {card.earlier.map((old) => (
              <li key={old.id} className="flex flex-wrap items-center gap-x-2 text-muted">
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1 text-left text-primary-text hover:underline disabled:text-muted"
                  disabled={!old.hasFile}
                  onClick={() => onView(old)}
                >
                  <FileIcon doc={old} className="size-3.5 shrink-0" />
                  <span className="truncate">{old.fileName}</span>
                </button>
                <span>
                  v{old.version} · {formatDateTime(old.uploadedAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

async function download(doc: ComplianceDocument): Promise<void> {
  const blob = await fetchDocumentBlob(doc.id);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = doc.fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
