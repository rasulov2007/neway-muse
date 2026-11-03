import { loadStatusLabel } from '@/features/loads/loads-search';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  Ban,
  Download,
  Ellipsis,
  Eye,
  FileText,
  MapPinned,
  MessageSquare,
  PackageCheck,
  Pin,
  PinOff,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { HOME_ZONE, cancelRequires, documentExpected, formatInstant, orderNotes } from '@neway/shared';
import {
  addLoadNote,
  demoCurrentUser,
  fetchLeadStatus,
  getDriver,
  getLoad,
  getTruck,
  loadWriteMessage,
  pinLoadNote,
  uploadLoadDocument,
  type Load,
  type LoadNote,
} from '@/demo';
import { now as clockNow } from '@/lib/clock';
import { useAccount } from '@/features/auth/auth-context';
import { MessageDriverButton } from '@/features/inbox/MessageDriverButton';
import { CancelLoadDialog } from './CancelLoadDialog';
import { RecordEventDialog } from './RecordEventDialog';
import { ActivityPanel, InstructionsPanel, LoadFacts, LoadJourney, MoneyPanel, NextPanel, PaperworkPanel, PeoplePanel, RoutePanel } from './LoadOverview';
import { CloseProblemDialog, FlagLoadDialog } from './FlagLoadDialog';
import { useLoadProblems } from './useLoadProblems';
import { LOAD_PROBLEM_KIND_LABELS, type LoadProblem } from '@neway/shared';
import { Flag } from 'lucide-react';

type LoadDocumentType = Load['documents'][number]['type'];
import {
  BackButton,
  Avatar,
  Badge,
  Button,
  Card,
  CardSkeleton,
  Checkbox,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  MenuItem,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  Textarea,
  Timeline,
  useToast,
} from '@/design-system';
import {
  formatRelative,
} from '@/lib/format';
import { LoadFinancials } from './LoadFinancials';
import { PayDatePanel } from './PayDatePanel';
import { LoadRouteCard } from './LoadRouteCard';
import { LateChargesPanel } from './LateChargesPanel';
import {
  DOCUMENT_TYPE_LABEL,
  LOAD_TABS,
  type LoadTab,
  TRACKING_EVENT_KINDS,
  eventTone,
  formatBytes,
  formatShortDateTime,
} from './loadUtils';
import { downloadFile, hasFile, uploadFile } from '@/lib/files';
import { DocumentViewer } from '@/features/documents';
import { DocumentThumbnail } from './DocumentThumbnail';
import { AttachFilesDialog } from './AttachFilesDialog';
import { RemoveDocumentDialog } from './RemoveDocumentDialog';
import { PaperworkChip } from './PaperworkChip';

function isLoadTab(value: unknown): value is LoadTab {
  return typeof value === 'string' && (LOAD_TABS as readonly string[]).includes(value);
}

const TAB_ITEMS = [
  { value: 'overview', label: 'Overview' },
  { value: 'tracking', label: 'Tracking' },
  { value: 'documents', label: 'Documents' },
  { value: 'financial', label: 'Financial' },
  { value: 'notes', label: 'Notes' },
];

const NOTE_KIND_TONE = { internal: 'neutral', broker: 'info', driver: 'violet' } as const;

interface LoadDetailPageProps {
  loadNumber: string;
}

/** Route component for `/loads/$loadNumber`; reads the param and renders the page. */
export function LoadDetailRoute() {
  const { loadNumber } = useParams({ from: '/loads/$loadNumber' });
  return <LoadDetailPage loadNumber={loadNumber} />;
}

export function LoadDetailPage({ loadNumber }: LoadDetailPageProps) {
  // Polled: the Daily Board moves this load from another screen, and the page must follow.
  const load = useQuery({ queryKey: ['load', loadNumber], queryFn: () => getLoad(loadNumber), refetchInterval: 15_000 });

  if (load.isPending) return <LoadDetailSkeleton loadNumber={loadNumber} />;
  if (load.isError) {
    return (
      <div className="flex flex-col gap-(--section-gap)">
        <LoadHeaderShell loadNumber={loadNumber} />
        <div className="rounded-lg border border-line bg-surface shadow-xs">
          <ErrorState
            title="Unable to load this load"
            description="The load could not be fetched. Try again in a moment."
            error={load.error}
            onRetry={() => void load.refetch()}
            retrying={load.isFetching}
          />
        </div>
      </div>
    );
  }
  if (!load.data) {
    return (
      <div className="flex flex-col gap-(--section-gap)">
        <LoadHeaderShell loadNumber={loadNumber} />
        <div className="rounded-lg border border-line bg-surface shadow-xs">
          <EmptyState
            icon={<PackageCheck />}
            title="Load not found"
            description={`No load matches "${loadNumber}". It may have been renumbered or removed.`}
            action={
              <Button variant="primary" asChild>
                <Link to="/loads">Back to loads</Link>
              </Button>
            }
          />
        </div>
      </div>
    );
  }
  return <LoadDetail load={load.data} />;
}

function LoadHeaderShell({ loadNumber }: { loadNumber: string }) {
  return <PageHeader back={<BackButton fallback="/loads" />} title={`Load ${loadNumber}`} />;
}

function LoadDetailSkeleton({ loadNumber }: { loadNumber: string }) {
  return (
    <div className="flex flex-col gap-(--section-gap)" aria-busy>
      <LoadHeaderShell loadNumber={loadNumber} />
      <div className="rounded-lg border border-line bg-surface p-3 shadow-xs">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-4 w-28" />
            </div>
          ))}
        </div>
      </div>
      <CardSkeleton lines={5} />
      <CardSkeleton lines={6} />
    </div>
  );
}

function LoadDetail({ load }: { load: Load }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // The name the server will put on a note: the session's, or the dataset's own person in demo mode.
  const account = useAccount();
  const authorName = account?.name ?? demoCurrentUser.name;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: unknown };
  const tab: LoadTab = isLoadTab(search.tab) ? search.tab : 'overview';
  const [statusOpen, setStatusOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  // A stop button opened the event dialog with its kind and stop already chosen.
  const [event, setEvent] = useState<{ kind?: 'arrived' | 'loaded' | 'departed' | 'check_call' | 'eta_changed'; stopId?: string } | null>(null);
  const [closing, setClosing] = useState<LoadProblem | null>(null);
  // Open flags (rule 1.10): shown at the top until somebody closes them with a note.
  const problems = useLoadProblems(load.id);
  const openFlags = (problems.data ?? []).filter((p) => !p.closedAt);

  /**
   * Whether this person may cancel after dispatch. The server answers from the roles it holds;
   * the menu item reads it to say the right thing, and the server refuses regardless.
   */
  const lead = useQuery({ queryKey: ['loads', 'me', 'lead'], queryFn: fetchLeadStatus, staleTime: 60_000 });
  const isLead = lead.data?.isLead ?? false;
  const cancelRule = cancelRequires(load.status);

  /**
   * Notes go through the server: the author is the signed-in person as the session knows them,
   * the time is the server's, and the note is on every other screen the moment it lands.
   */
  const addNote = useMutation({
    mutationFn: (input: { body: string; pinned: boolean }) =>
      addLoadNote(load.id, { kind: 'internal', ...input }),
    onSuccess: async (updated, input) => {
      await queryClient.invalidateQueries({ queryKey: ['load'] });
      toast({
        tone: 'success',
        title: input.pinned ? 'Note pinned' : 'Note added',
        description: `${updated.loadNumber} · visible to the dispatch team now.`,
      });
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Note not saved', description: loadWriteMessage(err, 'Try again.') }),
  });
  const pinNote = useMutation({
    mutationFn: (input: { noteId: string; pinned: boolean }) =>
      pinLoadNote(load.id, input.noteId, input.pinned),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['load'] }),
    onError: (err) =>
      toast({ tone: 'danger', title: 'Note not changed', description: loadWriteMessage(err, 'Try again.') }),
  });

  const truck = useQuery({
    queryKey: ['truck', load.truckId],
    queryFn: () => getTruck(load.truckId ?? ''),
    enabled: Boolean(load.truckId),
  });
  const driver = useQuery({
    queryKey: ['driver', load.driverId],
    queryFn: () => getDriver(load.driverId ?? ''),
    enabled: Boolean(load.driverId),
  });

  function setTab(next: string) {
    if (!isLoadTab(next)) return;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, tab: next }),
      replace: true,
      resetScroll: false, // switching tabs must not fling the page to the top
    });
  }

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/loads" />}
        title={`Load ${load.loadNumber}`}
        meta={
          <>
            <StatusBadge status={load.status} label={loadStatusLabel(load.status)} />
            <PaperworkChip load={load} />
            {load.exception ? <StatusBadge status={load.exception.code} /> : null}
            <span className="text-xs text-muted">
              Updated {formatRelative(load.updatedAt, { now: clockNow() })}
            </span>
          </>
        }
        actions={
          <>
            <MessageDriverButton loadId={load.id} driverId={load.driverId} />
            <Button variant="secondary" icon={<MessageSquare />} onClick={() => setTab('notes')}>
              Add note
            </Button>
            <DropdownMenu
              trigger={
                <IconButton label="More actions" variant="secondary">
                  <Ellipsis />
                </IconButton>
              }
            >
              <MenuItem icon={<Flag />} onSelect={() => setFlagOpen(true)}>
                Flag load
              </MenuItem>
              {cancelRule !== 'forbidden' ? (
                <MenuItem icon={<Ban />} destructive onSelect={() => setCancelOpen(true)}>
                  {cancelRule === 'lead' && !isLead ? 'Cancel load (lead only)' : 'Cancel load'}
                </MenuItem>
              ) : null}
            </DropdownMenu>
            <Button variant="primary" onClick={() => setStatusOpen(true)}>
              Record an event
            </Button>
          </>
        }
      />

      {openFlags.length > 0 ? (
        <section aria-label="Open flags" className="flex flex-col gap-2">
          {openFlags.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-warning-border bg-warning-soft px-4 py-3">
              <StatusBadge status="warning" label={LOAD_PROBLEM_KIND_LABELS[p.kind] ?? p.kind} />
              <span className="min-w-0 flex-1 text-sm text-ink">{p.note}</span>
              <span className="text-xs text-muted">
                {p.openedByName} · {formatInstant(p.openedAt, HOME_ZONE).text}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setClosing(p)}>
                Close flag
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      <LoadFacts load={load} />
      {load.invoiceId ? (
        <p className="rounded-lg border border-info-border bg-info-soft px-3 py-2 text-xs text-info-text">
          Invoiced on {load.invoiceId}. The billed facts and documents are Accountingâ€™s now; edits, reassignment and cancellation are refused for everybody else. Notes stay open. Ask Accounting for a correction.
        </p>
      ) : null}
      {/* What has to happen next, then the journey: one glance says where the load is and what it still needs. */}
      <NextPanel load={load} onRecord={(initial) => setEvent(initial)} onDocuments={() => setTab('documents')} />
      <LoadJourney load={load} />

      <Tabs
        items={TAB_ITEMS}
        value={tab}
        onValueChange={setTab}
        aria-label="Load sections"
        className="flex flex-col gap-(--section-gap)"
      >
        <TabsContent value="overview">
          <div className="grid grid-cols-1 gap-(--section-gap) xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-(--section-gap)">
              <RoutePanel load={load} onRecord={(initial) => setEvent(initial)} onTracking={() => setTab('tracking')} />
              <ActivityPanel load={load} author={authorName} />
            </div>
            <div className="flex flex-col gap-(--section-gap)">
              <PeoplePanel load={load} driver={driver.data ?? null} truck={truck.data ?? null} />
              <LoadRouteCard load={load} />
              <InstructionsPanel load={load} />
              <PaperworkPanel load={load} onUploadBol={() => setEvent({ kind: 'loaded' })} onDocuments={() => setTab('documents')} />
              <MoneyPanel load={load} onFinancial={() => setTab('financial')} />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="tracking">
          <TrackingTab load={load} truckLocation={truck.data?.location ?? null} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsTab load={load} />
        </TabsContent>
        <TabsContent value="financial">
          <div className="flex flex-col gap-(--section-gap)">
            {/* When the load counts for driver pay; Accounting can set it (owner, 2026-10-21). */}
            <PayDatePanel load={load} />
            {/* A layover or detention after the invoice went to RTS: a supplemental invoice (owner, 2026-10-21). */}
            <LateChargesPanel load={load} />
            <LoadFinancials load={load} />
          </div>
        </TabsContent>
        <TabsContent value="notes">
          <NotesTab
            notes={load.notes}
            author={authorName}
            pending={addNote.isPending}
            onAdd={(body, pinned) => addNote.mutate({ body, pinned })}
            onPin={(noteId, pinned) => pinNote.mutate({ noteId, pinned })}
          />
        </TabsContent>
      </Tabs>

      {statusOpen ? <RecordEventDialog load={load} open={statusOpen} onOpenChange={setStatusOpen} /> : null}
      {event ? <RecordEventDialog key={`${event.kind ?? ''}-${event.stopId ?? ''}`} load={load} open initial={event} onOpenChange={(next) => (next ? undefined : setEvent(null))} /> : null}
      {flagOpen ? <FlagLoadDialog load={load} open={flagOpen} onOpenChange={setFlagOpen} /> : null}
      {closing ? <CloseProblemDialog problem={closing} open onOpenChange={(next) => (next ? undefined : setClosing(null))} /> : null}
      {cancelOpen ? (
        <CancelLoadDialog
          load={load}
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          isLead={isLead}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------




// The six-step lifecycle bar, NWF-style: green checks behind, a blue numbered
// dot for where the load stands now, grey ahead. Cancelled loads show the bar
// frozen where they died (the header badge already says cancelled).



// ---------------------------------------------------------------------------------------------


function TrackingTab({
  load,
  truckLocation,
}: {
  load: Load;
  truckLocation: { city: string; state: string; updatedAt: string; speedMph: number } | null;
}) {
  const events = [...load.timeline]
    .filter((e) => TRACKING_EVENT_KINDS.has(e.kind))
    .sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="grid grid-cols-1 gap-(--section-gap) xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card padding="none">
        <div className="bg-surface-muted">
          <EmptyState
            icon={<MapPinned />}
            title="Live tracking arrives in Phase 6"
            description="The map, breadcrumb trail and geofence alerts are delivered with the telematics integration."
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft px-(--card-padding) py-3 text-sm">
          <span className="text-muted">Last known position</span>
          <span className="text-ink">
            {truckLocation
              ? `${truckLocation.city}, ${truckLocation.state} · ${truckLocation.speedMph} mph · ${formatRelative(truckLocation.updatedAt, { now: clockNow() })}`
              : 'No position reported'}
          </span>
        </div>
      </Card>
      <Card title="Tracking events" description="Geofence entries, exits and ETA changes.">
        {events.length ? (
          <Timeline
            dense
            items={events.map((e) => ({
              id: e.id,
              at: e.at,
              title: e.title,
              description: e.detail ?? undefined,
              tone: eventTone(e.kind),
            }))}
            formatTime={(d) => formatInstant(d.toISOString(), HOME_ZONE).text}
          />
        ) : (
          <EmptyState size="sm" title="No tracking events yet" />
        )}
      </Card>
    </div>
  );
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';

function DocumentsTab({ load }: { load: Load }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const account = useAccount();
  const fileRef = useRef<HTMLInputElement>(null);
  // Which slot the file picker was opened for. State, not a ref: the Upload button reads it
  // during render to show its spinner, and a ref read in render is not a subscription.
  const [pendingType, setPendingType] = useState<LoadDocumentType | null>(null);
  // The document the shared viewer is showing. Every filed row opens here — PDFs included; the
  // old path handed a rate confirmation to `openFile`, which is a new tab, not a viewer.
  const [viewingDoc, setViewingDoc] = useState<Load['documents'][number] | null>(null);

  const upload = useMutation({
    mutationFn: async (p: { type: LoadDocumentType; file: File }) => {
      if (p.file.size > MAX_UPLOAD_BYTES) throw new Error('The file is over 10 MB.');
      const stored = await uploadFile(p.file);
      return uploadLoadDocument({
        loadId: load.id,
        type: p.type,
        fileName: p.file.name,
        sizeBytes: p.file.size,
        mimeType: p.file.type,
        fileUrl: stored.url,
        fileId: stored.id,
        uploadedBy: account?.name ?? demoCurrentUser.name,
      });
    },
    onSuccess: async (_l, p) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['load'] }),
        queryClient.invalidateQueries({ queryKey: ['loads'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ]);
      toast({ tone: 'success', title: `${DOCUMENT_TYPE_LABEL[p.type]} uploaded` });
    },
    onError: (error: unknown) =>
      toast({
        tone: 'danger',
        title: 'Upload failed',
        description: error instanceof Error ? error.message : 'Try a PDF or an image.',
      }),
  });

  const pickFile = (type: LoadDocumentType) => {
    setPendingType(type);
    fileRef.current?.click();
  };
  const openDoc = (doc: Load['documents'][number]) => {
    if (!hasFile(doc)) {
      toast({
        tone: 'info',
        title: 'No file on record',
        description: 'Seeded paperwork has no image — upload one to replace it.',
      });
      return;
    }
    setViewingDoc(doc);
  };

  // Attach files (several at once, any type) lives in its own dialog; a row's Upload opens it
  // with that type picked.
  const [attaching, setAttaching] = useState<LoadDocumentType | 'any' | null>(null);
  const [removing, setRemoving] = useState<Load['documents'][number] | null>(null);
  // A removed file stays on the record (and in the audit) but leaves the list (owner, 2026-11-02).
  const isRemoved = (d: Load['documents'][number]) => Boolean((d as { removedAt?: string | null }).removedAt);
  // The three documents billing always needs are always ON the list — a load
  // with no POD record still shows a POD row with its Upload button.
  const required: LoadDocumentType[] = ['rate_confirmation', 'bol', 'pod'];
  // Every document of a type is listed, not only the first. A two-stop load carries a POD per
  // delivery (and a BOL per pickup); showing `find()`'s first match hid the second one even
  // though it was filed and on the timeline. Where a document names its stop, the row says which.
  const stopLabel = (doc: Load['documents'][number]): string | null => {
    const stopId = (doc as { stopId?: string }).stopId;
    if (!stopId) return null;
    const stop = load.stops.find((st) => st.id === stopId);
    return stop ? (stop.facilityName?.trim() || `${stop.city}, ${stop.state}`) : null;
  };
  const labelled = (doc: Load['documents'][number], index: number, of: number): Load['documents'][number] => {
    if (of < 2) return doc;
    const where = stopLabel(doc);
    return { ...doc, title: `${doc.title} · ${where ?? `${index + 1} of ${of}`}` };
  };
  const rows: Load['documents'] = [
    ...required.flatMap((type) => {
      const filed = load.documents.filter((d) => d.type === type && !isRemoved(d) && d.status !== 'missing' && d.fileName.trim() !== '');
      if (filed.length > 0) return filed.map((d, i) => labelled(d, i, filed.length));
      return [
        load.documents.find((d) => d.type === type && !isRemoved(d)) ?? {
          id: `slot_${type}`,
          type,
          title: DOCUMENT_TYPE_LABEL[type],
          fileName: '',
          sizeBytes: 0,
          uploadedAt: '',
          uploadedBy: '',
          status: 'missing' as const,
        },
      ];
    }),
    ...load.documents.filter((d) => !required.includes(d.type) && !isRemoved(d)),
  ];

  return (
    <Card
      padding="none"
      title="Documents"
      description="Rate confirmation, BOL and POD — upload straight from here; click a row to view."
      actions={
        <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => setAttaching('any')}>
          Add document
        </Button>
      }
    >
      {attaching ? (
        <AttachFilesDialog
          load={load}
          open
          initialType={attaching === 'any' ? undefined : attaching}
          onOpenChange={(next) => !next && setAttaching(null)}
        />
      ) : null}
      <div className="hidden grid-cols-[3rem_minmax(0,2fr)_6rem_minmax(0,2fr)_7rem_auto] gap-3 border-b border-nw-border bg-nw-subtle px-(--card-padding) py-2 text-xs font-semibold text-nw-text-2 md:grid">
        <span />
        <span>Document</span>
        <span>Type</span>
        <span>Uploaded</span>
        <span>Status</span>
        <span className="text-right">Actions</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && pendingType) upload.mutate({ type: pendingType, file });
          e.target.value = '';
        }}
      />
      <ul className="flex flex-col">
        {rows.map((doc) => {
          const missing = doc.status === 'missing';
          const owed = missing && documentExpected(load, doc.type);
          const isImage = (doc.mimeType ?? '').startsWith('image/');
          return (
            <li
              key={doc.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line-soft px-(--card-padding) py-2.5 last:border-b-0 md:grid-cols-[3rem_minmax(0,2fr)_6rem_minmax(0,2fr)_7rem_auto]"
            >
              {/* thumbnail of the uploaded image, or a quiet placeholder */}
              <button
                type="button"
                onClick={() => openDoc(doc)}
                className={`hidden size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-nw-border md:flex ${
                  // A real image is a document preview: it stays on paper in both modes.
                  hasFile(doc) && isImage ? 'nw-paper' : 'bg-nw-subtle'
                }`}
                title={missing ? 'Nothing uploaded yet' : `View ${doc.title}`}
              >
                {hasFile(doc) && isImage ? (
                  <DocumentThumbnail doc={doc} alt={doc.title} className="size-full object-cover" />
                ) : (
                  <FileText aria-hidden className="size-4 text-faint" />
                )}
              </button>
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => openDoc(doc)}
                  className="block max-w-full truncate text-left text-sm font-medium text-ink hover:underline"
                >
                  {doc.title}
                </button>
                <div className="truncate text-xs text-muted">
                  {missing ? 'Not uploaded yet' : `${doc.fileName} · ${formatBytes(doc.sizeBytes)}`}
                </div>
              </div>
              <Badge tone="neutral" variant="outline" className="hidden md:inline-flex">
                {DOCUMENT_TYPE_LABEL[doc.type]}
              </Badge>
              <div className="hidden text-xs text-muted md:block">
                {missing ? (owed ? '—' : 'Not yet due') : `${doc.uploadedBy} · ${formatShortDateTime(doc.uploadedAt)}`}
              </div>
              <div className="hidden md:block">
                {missing ? (
                  <StatusBadge status="missing" />
                ) : (
                  // Where the paper stands with a person: received on upload, reviewed, verified.
                  // Nothing here is "pending" - the file is in; the review is a separate action.
                  <span className="flex flex-col items-start gap-0.5">
                    <StatusBadge status={doc.review ?? (doc.status === 'verified' ? 'verified' : 'received')} />
                    {(doc.review ?? 'received') === 'received' ? (
                      <span className="text-2xs text-muted">Needs review</span>
                    ) : null}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-end gap-1">
                {missing ? (
                  <>
                    <StatusBadge status="missing" className="md:hidden" />
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Upload />}
                      loading={upload.isPending && pendingType === doc.type}
                      onClick={() => setAttaching(doc.type)}
                    >
                      Upload
                    </Button>
                  </>
                ) : (
                  <>
                    {hasFile(doc) ? (
                      <IconButton label={`View ${doc.title}`} onClick={() => openDoc(doc)}>
                        <Eye />
                      </IconButton>
                    ) : null}
                    <IconButton label={`Replace ${doc.title}`} onClick={() => pickFile(doc.type)}>
                      <Upload />
                    </IconButton>
                    <IconButton
                      label={`Download ${doc.title}`}
                      onClick={() => {
                        if (!downloadFile(doc, doc.fileName)) {
                          toast({ tone: 'info', title: 'No file on record for this document' });
                        }
                      }}
                    >
                      <Download />
                    </IconButton>
                    <IconButton label={`Delete ${doc.title}`} onClick={() => setRemoving(doc)}>
                      <Trash2 />
                    </IconButton>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {removing ? <RemoveDocumentDialog load={load} doc={removing} onClose={() => setRemoving(null)} /> : null}
      {viewingDoc ? (
        <DocumentViewer
          source={{ kind: 'file', file: viewingDoc }}
          title={viewingDoc.title}
          subtitle={`${viewingDoc.fileName}${viewingDoc.uploadedBy ? ` · ${viewingDoc.uploadedBy}` : ''}${
            viewingDoc.uploadedAt ? ` · ${formatShortDateTime(viewingDoc.uploadedAt)}` : ''
          }`}
          contentType={viewingDoc.mimeType}
          fileName={viewingDoc.fileName}
          onClose={() => setViewingDoc(null)}
          onReplace={() => {
            const type = viewingDoc.type;
            setViewingDoc(null);
            pickFile(type);
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * Notes, pinned first. A note is written by the signed-in person and persisted through the
 * server before it appears here, so what this list shows is what every other dispatcher sees.
 */
function NotesTab({
  notes,
  author,
  pending,
  onAdd,
  onPin,
}: {
  notes: LoadNote[];
  author: string;
  pending: boolean;
  onAdd: (body: string, pinned: boolean) => void;
  onPin: (noteId: string, pinned: boolean) => void;
}) {
  const [draft, setDraft] = useState('');
  const [pinned, setPinned] = useState(false);
  const sorted = orderNotes(notes);
  return (
    <div className="grid grid-cols-1 gap-(--section-gap) xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card title="Notes" description={`${notes.length} notes on this load`}>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted">No notes yet.</p>
        ) : (
          <ul className="flex flex-col" aria-label="Notes">
            {sorted.map((note) => (
              <li
                key={note.id}
                className="flex gap-3 border-b border-line-soft py-3 first:pt-0 last:border-b-0 last:pb-0"
              >
                <Avatar name={note.authorName} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{note.authorName}</span>
                    <Badge tone={NOTE_KIND_TONE[note.kind]} size="sm">
                      {note.kind}
                    </Badge>
                    {note.pinned ? (
                      <Badge tone="warning" size="sm" variant="outline">
                        Pinned
                      </Badge>
                    ) : null}
                    <span className="text-xs text-muted">
                      {formatRelative(note.at, { now: clockNow() })}
                    </span>
                    <IconButton
                      label={
                        note.pinned
                          ? `Unpin note by ${note.authorName}`
                          : `Pin note by ${note.authorName}`
                      }
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => onPin(note.id, !note.pinned)}
                    >
                      {note.pinned ? <PinOff /> : <Pin />}
                    </IconButton>
                  </div>
                  <p className="mt-1 text-sm whitespace-pre-line text-secondary">{note.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Add note" description={`Posted as ${author}.`}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const body = draft.trim();
            if (!body || pending) return;
            onAdd(body, pinned);
            setDraft('');
            setPinned(false);
          }}
        >
          <FormField
            label="Note"
            description="Internal by default; brokers and drivers do not see it."
          >
            <Textarea
              rows={4}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add context for the next dispatcher…"
              disabled={pending}
            />
          </FormField>
          <Checkbox
            label="Pin to the top"
            description="For the thing the next shift has to know first."
            checked={pinned}
            onCheckedChange={(value) => setPinned(value === true)}
            disabled={pending}
          />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={!draft.trim()} loading={pending}>
              Add note
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

