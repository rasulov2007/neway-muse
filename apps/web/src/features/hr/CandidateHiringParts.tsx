import { Link } from '@tanstack/react-router';
import { CircleCheck, Eye, Upload, UserMinus } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  DROP_REASONS,
  HIRING_DOCUMENTS,
  HIRING_DOCUMENT_STATE_LABELS,
  HIRING_DOCUMENT_TIMING,
  HIRING_DOCUMENT_TIMING_LABELS,
  HIRING_END_REASON_LABELS,
  JOURNEY_LABELS,
  JOURNEY_STUCK_AFTER_DAYS,
  JOURNEY_WAITING_ON,
  hiringDocumentState,
  isJourneyExit,
  journeyPlaceOfCase,
  journeySteps,
  lastLiveStep,
  type CdlExtract,
  type ComplianceDocument,
  type HiringCase,
  type HiringDocumentState,
  type JourneyStep,
  type WorkAuthorizationKind,
} from '@neway/shared';
import {
  WorkAuthorizationKindField,
  asksWorkAuthorizationKind,
} from '@/features/documents/WorkAuthorizationKindField';
import {
  Alert,
  Badge,
  Button,
  Card,
  FormField,
  Input,
  Modal,
  Select,
  StatusSymbol,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { ReceiptPreview } from '@/features/accounting/ReceiptPreview';
import { toBase64 } from '@/features/operations/credential-ocr';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { CdlMuseReading, canMuseRead, type CdlReadingState } from './CdlMuseReading';
import { StagedDriverFiles } from './DotLinkPanel';
import { caseDocumentFileUrl, hiringApi, useCaseDocuments, useHiringMutation } from './useHiring';

/**
 * The driver card's own parts (owner, 2026-09-29): the journey across the top — the way a load
 * shows Booked → Delivered — the papers HR collects with Safety's answer on each, and the one
 * way a recruiter ends a case. Disqualifying stays Safety's, in the qualification file.
 */

export function HiringJourney({ hiringCase }: { hiringCase: HiringCase }) {
  const place = journeyPlaceOfCase(hiringCase.state);
  const steps = journeySteps(place, isJourneyExit(place) ? lastLiveStep(hiringCase) : null);
  const limit = isJourneyExit(place) ? null : JOURNEY_STUCK_AFTER_DAYS[place as JourneyStep];
  const stuck = limit !== null && hiringCase.daysInState > limit;
  return (
    <Card padding="sm" aria-label="Hiring journey" data-testid="hiring-journey">
      <ol className="scroll-quiet flex items-start overflow-x-auto px-2 pt-1 pb-2">
        {steps.map((step, i) => (
          <li key={step.step} className={cn('flex items-start', i > 0 && 'flex-1')}>
            {i > 0 ? (
              <span
                aria-hidden
                className={cn(
                  'mx-2 mt-3.5 h-0.5 min-w-6 flex-1 rounded-full',
                  step.state === 'todo' || step.state === 'stopped'
                    ? 'bg-line-strong'
                    : 'bg-success',
                )}
              />
            ) : null}
            <span
              className="flex w-24 shrink-0 flex-col items-center gap-1 text-center"
              aria-current={step.state === 'current' ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex size-7 items-center justify-center rounded-full text-xs font-bold',
                  step.state === 'done' && 'bg-success text-inverse',
                  step.state === 'current' &&
                    (stuck
                      ? 'bg-surface text-danger-text ring-2 ring-danger'
                      : 'bg-surface text-primary-text ring-2 ring-primary'),
                  step.state === 'stopped' && 'bg-surface ring-2 ring-danger',
                  step.state === 'todo' && 'bg-neutral-soft text-faint',
                )}
              >
                {step.state === 'done' ? (
                  <CircleCheck className="size-4" />
                ) : step.state === 'stopped' ? (
                  <StatusSymbol family="urgent" size={14} className="text-nw-urgent-icon" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  'text-xs font-semibold whitespace-nowrap',
                  step.state === 'todo' ? 'text-faint' : 'text-ink',
                )}
              >
                {step.label}
              </span>
              {step.state === 'current' ? (
                <span
                  className={cn(
                    'text-2xs leading-tight',
                    stuck ? 'font-semibold text-danger-text' : 'text-muted',
                  )}
                >
                  {hiringCase.daysInState} day{hiringCase.daysInState === 1 ? '' : 's'}
                  {stuck ? ` · stuck (limit ${limit})` : ''}
                </span>
              ) : null}
              {step.state === 'stopped' ? (
                <span className="text-2xs font-semibold leading-tight text-danger-text">
                  {JOURNEY_LABELS[place]} here
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="border-t border-line px-3 pt-2 text-xs text-muted">
        {isJourneyExit(place) ? (
          <>
            <span className="font-semibold text-ink">{JOURNEY_LABELS[place]}</span>
            {hiringCase.endReason ? ` · ${HIRING_END_REASON_LABELS[hiringCase.endReason]}` : ''}
            {hiringCase.endNote ? ` — ${hiringCase.endNote}` : ''}
          </>
        ) : (
          <>
            <span className="font-semibold text-ink">Waiting on:</span>{' '}
            {JOURNEY_WAITING_ON[place as JourneyStep]}
            {place === 'safety_review' || place === 'documents' ? (
              <>
                {' · '}Safety approves or disqualifies in the qualification file; the offer opens
                only after approval.
              </>
            ) : null}
          </>
        )}
      </p>
    </Card>
  );
}

const STATE_FAMILY: Record<
  HiringDocumentState,
  'urgent' | 'warning' | 'done' | 'neutral' | 'moving'
> = {
  missing: 'neutral',
  waiting_for_safety: 'moving',
  approved: 'done',
  rejected: 'urgent',
  expired: 'warning',
};
const STATE_TONE: Record<
  HiringDocumentState,
  'neutral' | 'info' | 'success' | 'danger' | 'warning'
> = {
  missing: 'neutral',
  waiting_for_safety: 'info',
  approved: 'success',
  rejected: 'danger',
  expired: 'warning',
};

/** HR's checklist: upload each paper, see Safety's answer, open what is on file. */
export function CandidateDocuments({
  hiringCase,
  canEdit,
}: {
  hiringCase: HiringCase;
  canEdit: boolean;
}) {
  const docs = useCaseDocuments(hiringCase.id);
  const [uploading, setUploading] = useState<{ code: string; label: string } | null>(null);
  const [viewing, setViewing] = useState<ComplianceDocument | null>(null);

  if (docs.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (docs.error)
    return (
      <Alert tone="danger" title="Could not load the documents">
        {docs.error instanceof Error ? docs.error.message : null}
      </Alert>
    );
  const { driverId, documents } = docs.data;
  if (!driverId) {
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="info" title="No driver file yet">
          Submit the DOT application first (or accept the one the driver sent) — it opens the driver
          file the documents go into, and Safety reviews them there.
        </Alert>
        <StagedDriverFiles caseId={hiringCase.id} />
      </div>
    );
  }
  const latest = (code: string) =>
    [...documents]
      .filter((d) => d.requirementCode === code)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0] ?? null;
  const beforeHire = HIRING_DOCUMENTS.filter((d) => d.timing === 'before_hire');
  const ready = beforeHire.filter(
    (d) => hiringDocumentState(documents, d.code) === 'approved',
  ).length;

  return (
    <div className="flex flex-col gap-4" data-testid="candidate-documents">
      <Card padding="none">
        <div className="flex flex-wrap items-center gap-3 p-4">
          <StatusSymbol
            family={ready === beforeHire.length ? 'done' : 'moving'}
            size={16}
            className={ready === beforeHire.length ? 'text-nw-done-icon' : 'text-nw-moving-icon'}
          />
          <p className="text-sm text-ink">
            <span className="font-bold">
              {ready} of {beforeHire.length}
            </span>{' '}
            papers needed before hire are approved by Safety.
          </p>
          <span className="text-xs text-muted">
            Uploads go to Safety's review queue as “Waiting for Safety”.
          </span>
        </div>
      </Card>
      {HIRING_DOCUMENT_TIMING.map((timing) => (
        <Card key={timing} padding="none" className="overflow-hidden">
          <header className="border-b border-line px-4 py-2.5">
            <h3 className="text-sm font-bold text-ink">{HIRING_DOCUMENT_TIMING_LABELS[timing]}</h3>
          </header>
          <ul className="divide-y divide-line-soft">
            {HIRING_DOCUMENTS.filter((d) => d.timing === timing).map((d) => {
              const state = hiringDocumentState(documents, d.code);
              const doc = latest(d.code);
              return (
                <li
                  key={d.code}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                  data-testid={`doc-${d.code}`}
                >
                  <span className="min-w-56 flex-1">
                    <span className="font-semibold text-ink">{d.label}</span>
                    {d.rule ? <span className="ml-1.5 text-2xs text-faint">§{d.rule}</span> : null}
                    {doc ? (
                      <span className="block text-2xs text-muted">
                        {doc.fileName} · {formatDateTime(doc.uploadedAt)}
                      </span>
                    ) : null}
                    {state === 'rejected' && doc?.rejectionReason ? (
                      <span className="block text-xs text-danger-text">
                        Safety: {doc.rejectionReason}
                      </span>
                    ) : null}
                  </span>
                  <Badge tone={STATE_TONE[state]} size="sm">
                    <StatusSymbol family={STATE_FAMILY[state]} size={11} />
                    {HIRING_DOCUMENT_STATE_LABELS[state]}
                  </Badge>
                  {doc ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Eye />}
                      onClick={() => setViewing(doc)}
                    >
                      View
                    </Button>
                  ) : null}
                  {canEdit ? (
                    <Button
                      variant={
                        state === 'missing' || state === 'rejected' || state === 'expired'
                          ? 'outline'
                          : 'ghost'
                      }
                      size="sm"
                      icon={<Upload />}
                      onClick={() => setUploading({ code: d.code, label: d.label })}
                    >
                      {state === 'missing' ? 'Upload' : 'Replace'}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
      <p className="text-xs text-muted">
        Safety sees every upload in its review queue and on{' '}
        <Link to="/safety/review" className="text-primary-text hover:underline">
          Safety › Review
        </Link>
        .
      </p>
      {uploading ? (
        <UploadCandidateDocument
          caseId={hiringCase.id}
          code={uploading.code}
          label={uploading.label}
          onClose={() => setUploading(null)}
        />
      ) : null}
      {viewing ? (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open) setViewing(null);
          }}
          title={viewing.title}
          size="lg"
          footer={
            <Button variant="secondary" onClick={() => setViewing(null)}>
              Back to candidate
            </Button>
          }
        >
          <ReceiptPreview
            url={caseDocumentFileUrl(hiringCase.id, viewing.id)}
            fileName={viewing.fileName}
          />
        </Modal>
      ) : null}
    </div>
  );
}

export function UploadCandidateDocument({
  caseId,
  code,
  label,
  onClose,
}: {
  caseId: string;
  code: string;
  label: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [expiresOn, setExpiresOn] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Which paper a Work authorization is (owner, 2026-10-26): required for that type only.
  const [kind, setKind] = useState<WorkAuthorizationKind | ''>('');
  const needsKind = asksWorkAuthorizationKind(code);
  // Read with Muse (hackathon, 2026-11-03): a CDL photo is read before upload; the recruiter
  // checks the fields and only a confirmed reading travels with the file.
  const museCdl = code === 'cdl';
  const [reading, setReading] = useState<CdlReadingState>({ status: 'idle' });
  const [draft, setDraft] = useState<CdlExtract | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const readRun = useRef(0);
  const read = async (chosen: File | null) => {
    if (!museCdl || !chosen || !canMuseRead(chosen)) return;
    const run = ++readRun.current;
    setReading({ status: 'reading' });
    setDraft(null);
    setConfirmed(false);
    try {
      const result = await hiringApi.readCdl(caseId, {
        fileName: chosen.name,
        contentType: chosen.type as 'application/pdf',
        content: await toBase64(chosen),
      });
      if (run !== readRun.current) return;
      setReading({ status: 'done', result });
      setDraft(result.extract);
    } catch (e) {
      if (run !== readRun.current) return;
      setReading({
        status: 'error',
        message: e instanceof ApiError || e instanceof Error ? e.message : 'Muse did not answer.',
      });
    }
  };
  const hasReading = museCdl && reading.status === 'done' && draft !== null;
  const effectiveExpiresOn = hasReading ? (draft.cdlExpiresOn ?? '') : expiresOn;
  const mutation = useHiringMutation(async () => {
    if (!file) throw new Error('Choose a file');
    if (needsKind && !kind) throw new Error('Choose which work authorization document this is');
    if (hasReading && !confirmed) throw new Error('Tick that you checked the fields against the licence');
    return hiringApi.uploadDocument(caseId, {
      ...(needsKind && kind ? { workAuthorizationKind: kind } : {}),
      ...(hasReading
        ? {
            // What is still empty stays marked for Safety to read off the card.
            extracted: {
              ...draft,
              source: 'ocr' as const,
              needsReview: draft.needsReview.filter((f) => {
                const v = draft[f as keyof CdlExtract];
                return v === null || (Array.isArray(v) && v.length === 0 && f !== 'endorsements' && f !== 'restrictions');
              }),
            },
            issuedOn: draft.cdlIssuedOn,
          }
        : {}),
      requirementCode: code,
      title: label,
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      expiresOn: effectiveExpiresOn || null,
      notes: notes.trim() || null,
      content: await toBase64(file),
    });
  });
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Upload · ${label}`}
      size={museCdl ? 'lg' : undefined}
      description="It goes into the driver's file and to Safety's review queue."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              !file || (needsKind && !kind) || reading.status === 'reading' || (hasReading && !confirmed)
            }
            loading={mutation.isPending}
            onClick={() => {
              setError(null);
              mutation.mutate(undefined, {
                onSuccess: () => {
                  toast({
                    tone: 'success',
                    title: `${label} uploaded`,
                    description: 'Waiting for Safety.',
                  });
                  onClose();
                },
                onError: (e) =>
                  setError(
                    e instanceof ApiError
                      ? e.message
                      : e instanceof Error
                        ? e.message
                        : 'Upload failed',
                  ),
              });
            }}
          >
            Upload
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not uploaded">
            {error}
          </Alert>
        ) : null}
        {needsKind ? <WorkAuthorizationKindField value={kind} onChange={setKind} /> : null}
        <FormField
          label="File"
          required
          description="PDF or a photo, up to the qualification file's size limit."
        >
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={<Upload />}
              onClick={() => input.current?.click()}
            >
              Choose file
            </Button>
            <span className="truncate text-sm text-muted">{file?.name ?? 'Nothing chosen'}</span>
            <input
              ref={input}
              type="file"
              accept="application/pdf,image/*"
              aria-label="Document file"
              className="hidden"
              onChange={(e) => {
                const chosen = e.target.files?.[0] ?? null;
                setFile(chosen);
                // A licence is read as soon as it is chosen; the recruiter still confirms it.
                void read(chosen);
              }}
            />
          </div>
        </FormField>
        {museCdl ? (
          <CdlMuseReading
            file={file}
            state={reading}
            draft={draft}
            confirmed={confirmed}
            onRead={() => void read(file)}
            onDraftChange={(next) => {
              setDraft(next);
              setConfirmed(false);
            }}
            onConfirmedChange={setConfirmed}
          />
        ) : null}
        {hasReading ? null : (
          <FormField
            label="Expires on"
            description="Only for papers that expire (CDL, medical card)."
          >
            <Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          </FormField>
        )}
        <FormField label="Note for Safety">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}

const DROP_LABELS: Record<(typeof DROP_REASONS)[number], string> = {
  unresponsive: 'Stopped answering',
  took_another_job: 'Took another job',
  pay: 'Pay',
  home_time: 'Home time',
  no_show_orientation: 'Did not come to orientation',
  other: 'Other',
};

/** The recruiter's way out for a case Safety has not ended: a reason, a confirmation, history kept. */
export function DropCaseDialog({
  hiringCase,
  onClose,
}: {
  hiringCase: HiringCase;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<(typeof DROP_REASONS)[number]>('unresponsive');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const mutation = useHiringMutation(() =>
    hiringApi.dropCase(hiringCase.id, { reason, note: note.trim() || null }),
  );
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Drop ${hiringCase.candidateName} from hiring?`}
      description="The case ends as Dropped with this reason. Nothing is deleted; the history stays on the record."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={mutation.isPending}
            disabled={reason === 'other' && note.trim().length === 0}
            onClick={() => {
              setError(null);
              mutation.mutate(undefined, {
                onSuccess: () => {
                  toast({
                    tone: 'success',
                    title: `${hiringCase.candidateName} dropped from hiring`,
                  });
                  onClose();
                },
                onError: (e) =>
                  setError(e instanceof ApiError ? e.message : 'Could not drop the case'),
              });
            }}
          >
            Drop from hiring
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not dropped">
            {error}
          </Alert>
        ) : null}
        <FormField label="Reason" required>
          <Select
            aria-label="Drop reason"
            value={reason}
            onValueChange={(v) => setReason(v as typeof reason)}
            options={DROP_REASONS.map((r) => ({ value: r, label: DROP_LABELS[r] }))}
          />
        </FormField>
        <FormField
          label="Note"
          description={reason === 'other' ? 'Required for Other.' : 'Optional.'}
        >
          <Textarea
            rows={2}
            aria-label="Drop note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
        <p className="text-xs text-muted">
          Disqualifying is Safety's decision and is made in the qualification file.
        </p>
      </div>
    </Modal>
  );
}

/** Whether a recruiter may still drop the case: not ended, not hired. */
export function canDropCase(hiringCase: HiringCase): boolean {
  const place = journeyPlaceOfCase(hiringCase.state);
  return !isJourneyExit(place) && place !== 'hired' && place !== 'first_load';
}

export function DropCaseButton({ hiringCase }: { hiringCase: HiringCase }) {
  const [open, setOpen] = useState(false);
  if (!canDropCase(hiringCase)) return null;
  return (
    <>
      <Button variant="outline" icon={<UserMinus />} onClick={() => setOpen(true)}>
        Drop
      </Button>
      {open ? <DropCaseDialog hiringCase={hiringCase} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
