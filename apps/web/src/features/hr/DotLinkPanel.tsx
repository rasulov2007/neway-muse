import { Copy, Eye, Info, Send } from 'lucide-react';
import { useState } from 'react';
import type { DotApplication, DotLinkCreated, DotLinkStagedFile, DotLinkStatus, HiringCase } from '@neway/shared';
import { Alert, Button, ConfirmDialog, FormField, Input, Modal, Textarea, useToast } from '@/design-system';
import { ReceiptPreview } from '@/features/accounting/ReceiptPreview';
import { ApiError } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { formatDateTime } from '@/lib/format';
import { dotLinkProgress } from './dot-link-progress';
import { dotLinkFileUrl, hiringApi, useDotLinkFiles, useHiringMutation } from './useHiring';

/**
 * Sending the DOT application to the driver (owner, 2026-10-07).
 *
 * The recruiter makes a private link; the driver fills the application in on a phone, submits it
 * and uploads the CDL. The address is shown once, when it is made — the server keeps only a
 * digest — so "send it again" means "create a new link", which turns the old one off.
 */

/** The status line and the "Send to driver" button above the DOT application. */
export function DotLinkBar({
  hiringCase,
  link,
  loading,
  canEdit,
  submitted,
}: {
  hiringCase: HiringCase;
  link: DotLinkStatus | null | undefined;
  loading: boolean;
  canEdit: boolean;
  submitted: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<DotLinkCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useHiringMutation(async () => hiringApi.createDotLink(hiringCase.id));
  const live = link?.state === 'live';
  // Nothing left for the driver to send: the application is in and the CDL came through the link.
  const done = submitted && Boolean(link?.cdlUploadedAt);

  const make = async () => {
    setError(null);
    try {
      setCreated(await create.mutateAsync(undefined));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The link could not be created.');
      throw e;
    }
  };

  const onOpen = () => {
    setCreated(null);
    setError(null);
    setOpen(true);
    // No live link yet: opening the dialog is the request for one.
    if (!live) void make().catch(() => toast({ tone: 'danger', title: 'The link was not created' }));
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid="dot-link-bar">
      {loading ? (
        <span className="text-xs text-muted">Loading…</span>
      ) : link ? (
        <span className="flex items-center gap-1.5 text-xs text-muted" data-testid="dot-link-status">
          <Info aria-hidden className="size-3.5 shrink-0 text-info-text" />
          <span>
            <span className="font-semibold text-secondary">Driver link: </span>
            {dotLinkProgress(link)}
          </span>
        </span>
      ) : null}
      {canEdit && !done ? (
        <Button variant="outline" size="sm" icon={<Send />} onClick={onOpen} data-testid="send-to-driver">
          Send to driver
        </Button>
      ) : null}
      {open ? (
        <SendToDriverDialog
          caseId={hiringCase.id}
          link={link ?? null}
          submitted={submitted}
          created={created}
          creating={create.isPending}
          error={error}
          onCreate={make}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function SendToDriverDialog({
  caseId,
  link,
  submitted,
  created,
  creating,
  error,
  onCreate,
  onClose,
}: {
  caseId: string;
  link: DotLinkStatus | null;
  submitted: boolean;
  created: DotLinkCreated | null;
  creating: boolean;
  error: string | null;
  onCreate: () => Promise<void>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<'new' | 'off' | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revoke = useHiringMutation(async () => hiringApi.revokeDotLink(caseId));
  const live = link?.state === 'live';

  const onCopy = async (url: string) => {
    try {
      await copyText(url);
      toast({ tone: 'success', title: 'Link copied' });
    } catch {
      toast({ tone: 'warning', title: 'Copy is not available here', description: 'Select the link and copy it by hand.' });
    }
  };

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title="Send the DOT application to the driver"
      description={
        submitted
          ? 'The application is submitted. The driver can use the link to upload the CDL.'
          : 'The driver opens the link on a phone, fills the application in and uploads the CDL. Everything lands here.'
      }
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4" data-testid="send-to-driver-dialog">
        {error || revokeError ? (
          <Alert tone="danger" title="Not done">
            {error ?? revokeError}
          </Alert>
        ) : null}
        {created ? (
          <>
            <FormField label="Link for the driver" description={`Works until ${formatDateTime(created.expiresAt)}.`}>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={created.url}
                  aria-label="Link for the driver"
                  onFocus={(e) => e.currentTarget.select()}
                  data-testid="dot-link-url"
                />
                <Button variant="primary" icon={<Copy />} onClick={() => void onCopy(created.url)}>
                  Copy link
                </Button>
              </div>
            </FormField>
            <Alert tone="warning" title="Send it only to the driver">
              Anyone with this link can fill in this driver's application. Send it only to the driver. It is shown only now; to
              send it again later, create a new link.
            </Alert>
          </>
        ) : creating ? (
          <p className="text-sm text-muted">Creating the link…</p>
        ) : live && link ? (
          <>
            <div className="rounded-lg border border-line px-3 py-2 text-sm text-ink" data-testid="dot-link-current">
              <p className="font-semibold">A link is already with the driver</p>
              <p className="mt-1 text-xs text-muted">{dotLinkProgress(link)}</p>
              <p className="mt-1 text-xs text-muted">Works until {formatDateTime(link.expiresAt)}.</p>
            </div>
            <p className="text-xs text-muted">
              The address was shown when the link was made and is not kept. To send it again, create a new link — the old one stops
              working.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setConfirm('new')}>
                Create a new link
              </Button>
              <Button variant="ghost" onClick={() => setConfirm('off')}>
                Turn off link
              </Button>
            </div>
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm === 'new'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title="Create a new link?"
        description="The link you sent before stops working. The driver keeps everything already saved."
        confirmLabel="Create a new link"
        onConfirm={async () => {
          await onCreate();
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'off'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title="Turn off the link?"
        description="The driver will see that the link was turned off. Anything already saved stays on the application."
        confirmLabel="Turn off link"
        tone="danger"
        onConfirm={async () => {
          setRevokeError(null);
          try {
            await revoke.mutateAsync(undefined);
            toast({ tone: 'success', title: 'Link turned off' });
            setConfirm(null);
            onClose();
          } catch (e) {
            setRevokeError(e instanceof ApiError ? e.message : 'The link was not turned off.');
            throw e;
          }
        }}
      />
    </Modal>
  );
}

/**
 * The review gate (owner, 2026-10-07): the driver's Submit is their certification and is never
 * blocked, but nothing reaches the qualification file until a recruiter accepts it.
 */
export function DriverReviewBanner({
  hiringCase,
  application,
  canEdit,
}: {
  hiringCase: HiringCase;
  application: DotApplication;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const accept = useHiringMutation(async () => hiringApi.acceptDotApplication(hiringCase.id));
  const back = useHiringMutation(async () => hiringApi.returnDotApplication(hiringCase.id, note.trim()));
  return (
    <div className="flex flex-col gap-3" data-testid="dot-review-banner">
      <Alert
        tone="warning"
        title="Submitted by the driver — needs review"
        actions={
          canEdit ? (
            <>
              <Button variant="primary" size="sm" onClick={() => setConfirm(true)} data-testid="dot-accept">
                Accept
              </Button>
              <Button variant="outline" size="sm" onClick={() => setReturning(true)} data-testid="dot-return">
                Return to driver
              </Button>
            </>
          ) : (
            <span className="text-xs">Accepting or returning it takes recruiting.manage.</span>
          )
        }
      >
        {application.certifiedName ?? 'The driver'} certified and submitted it through the link on{' '}
        {application.certifiedAt ? formatDateTime(application.certifiedAt) : '—'}. It is frozen as they signed it. Nothing is in
        the qualification file until you accept it; returning it lets the driver correct it and certify again.
      </Alert>
      {error ? <Alert tone="danger" title="Not done">{error}</Alert> : null}
      <StagedDriverFiles caseId={hiringCase.id} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Accept the driver's application?"
        description="It is filed in the qualification file as the driver certified it: the PDF, Safety's verification case and the previous-employer consents. The CDL the driver sent is filed with it, waiting for Safety's review."
        confirmLabel="Accept and file"
        onConfirm={async () => {
          setError(null);
          try {
            await accept.mutateAsync(undefined);
            toast({ tone: 'success', title: 'Accepted and filed' });
          } catch (e) {
            setError(e instanceof ApiError ? e.message : 'The application was not accepted.');
            throw e;
          }
        }}
      />
      <Modal
        open={returning}
        onOpenChange={(open) => !open && setReturning(false)}
        size="sm"
        title="Return to the driver"
        description="The driver sees your note on the link, corrects the application and certifies it again. Their earlier certification stays in the history."
        footer={
          <>
            <Button variant="secondary" onClick={() => setReturning(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={note.trim().length < 3}
              loading={back.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await back.mutateAsync(undefined);
                  toast({ tone: 'success', title: 'Returned to the driver' });
                  setReturning(false);
                  setNote('');
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : 'The application was not returned.');
                  setReturning(false);
                }
              }}
            >
              Return to driver
            </Button>
          </>
        }
      >
        <FormField label="What should the driver fix?" required>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-label="What should the driver fix?" />
        </FormField>
      </Modal>
    </div>
  );
}

/** The CDL files the driver sent through the link, with a preview; filed ones say so. */
export function StagedDriverFiles({ caseId, unfiledOnly = false }: { caseId: string; unfiledOnly?: boolean }) {
  const files = useDotLinkFiles(caseId);
  const [viewing, setViewing] = useState<DotLinkStagedFile | null>(null);
  if (files.isPending) return <p className="text-xs text-muted">Loading…</p>;
  const list = (Array.isArray(files.data) ? files.data : []).filter((f) => !unfiledOnly || !f.filedAt);
  if (list.length === 0) return null;
  return (
    <div className="rounded-[10px] border border-line bg-surface" data-testid="dot-staged-files">
      <ul className="divide-y divide-line-soft">
        {list.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <span className="min-w-48 flex-1">
              <span className="font-semibold text-ink">{f.label}</span>
              <span className="block text-xs text-muted">
                {f.fileName} · {formatDateTime(f.uploadedAt)}
              </span>
            </span>
            <span className="flex items-center gap-1.5 text-xs text-secondary">
              <Info aria-hidden className="size-3.5 text-info-text" />
              {f.filedAt ? `Uploaded by the driver — filed ${formatDateTime(f.filedAt)}` : 'Uploaded by the driver — filed when you accept'}
            </span>
            <Button variant="ghost" size="sm" icon={<Eye />} onClick={() => setViewing(f)}>
              View
            </Button>
          </li>
        ))}
      </ul>
      {viewing ? (
        <Modal open onOpenChange={(open) => !open && setViewing(null)} title={viewing.label} size="lg">
          <ReceiptPreview url={dotLinkFileUrl(caseId, viewing.id)} fileName={viewing.fileName} />
        </Modal>
      ) : null}
    </div>
  );
}
