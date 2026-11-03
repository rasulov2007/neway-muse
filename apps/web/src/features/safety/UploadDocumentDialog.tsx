import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { EvaluatedItem, WorkAuthorizationKind } from '@neway/shared';
import {
  WorkAuthorizationKindField,
  asksWorkAuthorizationKind,
  workAuthorizationExtract,
} from '@/features/documents/WorkAuthorizationKindField';
import {
  DatePicker,
  Alert,
  Button,
  FormField,
  Input,
  Modal,
  Textarea,
  useToast,
} from '@/design-system';
import { uploadComplianceDocument } from './compliance-api';
import { toBase64 } from '@/features/operations/credential-ocr';

/**
 * Attaches a document to a requirement.
 *
 * Two things this dialog is careful to say out loud:
 *
 *  - What attaching actually does. The requirement moves from `missing` to `pending_verification`,
 *    which the compliance engine treats as neither satisfied nor failing — so a dispatch hold on
 *    that requirement **is released**, and a reviewer still has to check the file. The dialog states
 *    that plainly rather than implying either more or less than happens: someone releasing a hold
 *    should know they have released it.
 *  - What is kept. The file itself is stored against the document, so it can be opened again from
 *    the qualification file; a format the store will not take is refused here rather than accepted
 *    and lost.
 */
export interface UploadDocumentDialogProps {
  item: EvaluatedItem;
  /** `driver`, `truck`, `trailer` or `company` — the owner the document hangs off. */
  ownerType: 'driver' | 'truck' | 'trailer' | 'company';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MAX_BYTES = 20 * 1024 * 1024;

export function UploadDocumentDialog({
  item,
  ownerType,
  open,
  onOpenChange,
}: UploadDocumentDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(item.requirementName);
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState(item.expiresOn ?? '');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Which paper a Work authorization is (owner, 2026-10-26): required for that type only.
  const [kind, setKind] = useState<WorkAuthorizationKind | ''>('');
  const needsKind = asksWorkAuthorizationKind(item.requirementCode);

  /** The requirement carries an expiry when the engine already tracks one for it. */
  const tracksExpiry = item.expiresOn !== null || item.daysRemaining !== null;

  const upload = useMutation({
    mutationFn: async () => {
      if (needsKind && !kind) throw new Error('Choose which work authorization document this is');
      const content = file ? await toBase64(file) : undefined;
      return uploadComplianceDocument({
        ...workAuthorizationExtract(item.requirementCode, kind),
        ownerType,
        ownerId: item.entityId,
        ownerLabel: item.entityLabel,
        requirementCode: item.requirementCode,
        title,
        fileName: file?.name ?? `${item.requirementCode}.pdf`,
        contentType: file?.type || 'application/pdf',
        sizeBytes: file?.size ?? 0,
        issuedOn: issuedOn || null,
        expiresOn: expiresOn || null,
        notes: notes.trim() ? notes.trim() : null,
        content,
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['compliance'] });
      // The requirement row reads its pending file from here to offer Verify in place (owner,
      // 2026-10-16: after an upload the reviewer had to go to Documents to verify it).
      await queryClient.invalidateQueries({ queryKey: ['compliance-documents'] });
      await queryClient.invalidateQueries({ queryKey: ['safety'] });
      await queryClient.invalidateQueries({ queryKey: ['operations'] });
      toast({
        tone: 'success',
        title: `${result.document.title} attached`,
        description: item.blocksDispatch
          ? `The ${item.requirementName.toLowerCase()} hold is released. It still needs verifying.`
          : 'It is pending review.',
      });
      onOpenChange(false);
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The document could not be attached.'),
  });

  function choose(next: File | null) {
    if (next && next.size > MAX_BYTES) {
      setError('That file is larger than 20 MB.');
      return;
    }
    setError(null);
    setFile(next);
    if (next && title === item.requirementName) {
      setTitle(`${item.requirementName} — ${next.name.replace(/\.[^.]+$/, '')}`);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Attach ${item.requirementName}`}
      description={`For ${item.entityLabel}.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={upload.isPending}
            disabled={!file || !title.trim() || (needsKind && !kind)}
            onClick={() => {
              setError(null);
              upload.mutate();
            }}
          >
            Attach document
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        {needsKind ? <WorkAuthorizationKindField value={kind} onChange={setKind} /> : null}

        <FormField label="File" required>
          <div className="flex items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.doc,.docx"
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
            />
            <Button variant="secondary" onClick={() => fileInput.current?.click()}>
              Choose file…
            </Button>
            <span className="min-w-0 truncate text-sm text-secondary">
              {file
                ? `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`
                : 'No file chosen'}
            </span>
          </div>
        </FormField>

        <FormField label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Issued on" description="Optional.">
            <DatePicker value={issuedOn} onIsoChange={setIssuedOn} />
          </FormField>
          <FormField
            label="Expires on"
            required={tracksExpiry}
            description={
              tracksExpiry
                ? 'This requirement expires, so the date drives the renewal warnings.'
                : 'Leave empty if it does not expire.'
            }
          >
            <DatePicker value={expiresOn} onIsoChange={setExpiresOn} />
          </FormField>
        </div>

        <FormField label="Notes" description="Optional.">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>

        {item.blocksDispatch ? (
          <Alert
            tone="warning"
            title="This releases the dispatch hold"
            description={`${item.requirementName} currently blocks dispatch. Attaching a document moves it to "pending verification", which lifts that hold — a reviewer still has to check the file, but the driver becomes dispatchable in the meantime.`}
          />
        ) : (
          <Alert
            tone="info"
            title="It goes to pending verification"
            description="A reviewer checks the document against the requirement before it counts as satisfied."
          />
        )}

        <p className="text-xs text-faint">
          The file is kept against this requirement and can be opened from the qualification file.
          JPG, PNG and PDF are stored; anything else is recorded by name only.
        </p>
      </div>
    </Modal>
  );
}
