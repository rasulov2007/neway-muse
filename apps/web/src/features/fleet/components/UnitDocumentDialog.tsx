import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CloudUpload, FileText } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  Button,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { useAutoExpiry } from '@/features/documents/auto-expiry';
import { toBase64 } from '@/features/operations/credential-ocr';
import { uploadComplianceDocument } from '@/features/safety/compliance-api';
import { documentTypesFor } from '../unit-documents';

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Attaching a document to a unit, as the owner drew it (2026-09-21).
 *
 * Asks for the type, the file (a drop zone, since most of these are photographed or dragged
 * in), the dates it carries, who issued it and a note. The type comes from the catalog for the
 * unit's kind, and from the card that opened the dialog — an "Upload file" on the Annual
 * inspection card asks for an annual inspection, not the first type in the list. A type that
 * expires insists on the expiry date, because a registration with no expiry on record is one
 * nobody will be reminded about. Replacing a document is the same form with the type fixed: the
 * new file becomes the current version and the old one stays in the history.
 */
export function UnitDocumentDialog({
  ownerType,
  ownerId,
  ownerLabel,
  replaceCode,
  initialCode,
  initialFile,
  onClose,
}: {
  ownerType: 'truck' | 'trailer';
  ownerId: string;
  ownerLabel: string;
  /** Fixes the type when replacing an existing document. */
  replaceCode?: string;
  /** The type of the card the dialog was opened from. */
  initialCode?: string;
  /** A file dropped onto the tab, already chosen. */
  initialFile?: File | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const types = useMemo(() => documentTypesFor(ownerType), [ownerType]);
  // Type, issue date and expiry move together: a fixed-term type (an annual inspection) fills
  // the expiry from the issue date until somebody types one by hand.
  const dates = useAutoExpiry({ code: replaceCode ?? initialCode ?? types[0]?.code ?? '' });
  const { code, setCode, issuedOn, setIssuedOn, expiresOn, setExpiresOn } = dates;
  const type = types.find((t) => t.code === code) ?? null;
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [over, setOver] = useState(false);
  const [authority, setAuthority] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose the file first');
      if (!type) throw new Error('Choose the document type');
      if (type.hasExpiry && !expiresOn)
        throw new Error(`${type.name} expires — enter the expiry date`);
      const notes = [authority.trim() ? `Issued by: ${authority.trim()}` : '', note.trim()]
        .filter(Boolean)
        .join('\n');
      return uploadComplianceDocument({
        ownerType,
        ownerId,
        ownerLabel,
        requirementCode: type.code,
        title: `${type.name} — ${ownerLabel}`,
        fileName: file.name,
        contentType: file.type || 'application/pdf',
        sizeBytes: file.size,
        issuedOn: issuedOn || null,
        expiresOn: expiresOn || null,
        notes: notes || null,
        content: await toBase64(file),
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['compliance-documents'] });
      await queryClient.invalidateQueries({ queryKey: ['compliance'] });
      await queryClient.invalidateQueries({ queryKey: ['fleet'] });
      toast({
        tone: 'success',
        title: `${result.document.title} attached`,
        description: expiresOn ? `Expires ${expiresOn}.` : 'No expiry on this document.',
      });
      onClose();
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
  }

  const expiryRequired = type?.hasExpiry ?? false;
  // The button stays live once there is a file; a missing expiry is said on click, not hidden
  // behind a greyed button (owner, 2026-09-22: people chose a file and could not see why nothing saved).
  const valid = Boolean(file && type);
  const expiryMissing = expiryRequired && !expiresOn;

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={
        <span className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-nw-accent-tint text-nw-accent">
            <FileText className="size-[18px]" aria-hidden />
          </span>
          {replaceCode ? `Replace ${type?.name ?? 'document'}` : 'Add document'}
        </span>
      }
      description={`${ownerLabel} · ${ownerType === 'truck' ? 'Vehicle' : 'Trailer'} documents`}
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            <span aria-hidden className="text-nw-urgent-text">
              *
            </span>{' '}
            Required fields
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={upload.isPending}
            disabled={!valid}
            onClick={() => {
              setError(null);
              upload.mutate();
            }}
          >
            {replaceCode ? 'Replace document' : 'Add document'}
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

        <FormField label="Document type" required description={type?.description}>
          <Select
            aria-label="Document type"
            options={types.map((t) => ({ value: t.code, label: t.name }))}
            value={code}
            onValueChange={setCode}
            disabled={Boolean(replaceCode)}
          />
        </FormField>

        <FormField label="Document file" required description="PDF or image · Maximum 20 MB.">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              choose(Array.from(event.dataTransfer?.files ?? [])[0] ?? null);
            }}
            className={cn(
              'flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors',
              file
                ? 'border-success-border bg-success-soft'
                : 'border-nw-accent/40 bg-nw-accent-tint/40',
              over && 'border-nw-accent bg-nw-accent-tint',
            )}
          >
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              aria-label="Document file"
              accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff"
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
            />
            <CloudUpload className="size-7 text-nw-accent" aria-hidden />
            {file ? (
              <>
                <span className="truncate text-sm font-semibold text-ink">{file.name}</span>
                <button
                  type="button"
                  className="text-xs font-semibold text-nw-accent-ink underline"
                  onClick={() => fileInput.current?.click()}
                >
                  choose another file
                </button>
              </>
            ) : (
              <>
                <span className="text-sm font-semibold text-ink">Drop your file here</span>
                <span className="text-xs text-muted">
                  or{' '}
                  <button
                    type="button"
                    className="font-semibold text-nw-accent-ink underline"
                    onClick={() => fileInput.current?.click()}
                  >
                    browse files
                  </button>
                </span>
              </>
            )}
          </div>
        </FormField>

        <h3 className="text-sm font-bold text-ink">Document details</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Issue date (optional)">
            <DatePicker
              aria-label="Issue date"
              value={issuedOn}
              onIsoChange={(e) => setIssuedOn(e)}
            />
          </FormField>
          <FormField
            label="Expiry date"
            required={expiryRequired}
            description={
              dates.hint ??
              (expiryRequired
                ? 'Required - the reminder and the hold read this date.'
                : 'Leave blank if it never expires.')
            }
            error={error && expiryMissing ? error : undefined}
          >
            <DatePicker
              aria-label="Expiry date"
              value={expiresOn}
              onIsoChange={(e) => setExpiresOn(e)}
            />
          </FormField>
        </div>
        <FormField
          label="Issuing state / authority"
          description={
            type?.authority ? `For example, ${type.authority}.` : 'For example, your state DMV.'
          }
        >
          <Input
            value={authority}
            onChange={(e) => setAuthority(e.target.value)}
            placeholder="Illinois SOS"
          />
        </FormField>
        <FormField label="Note (optional)">
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note about this document…"
          />
        </FormField>
      </div>
    </Modal>
  );
}
