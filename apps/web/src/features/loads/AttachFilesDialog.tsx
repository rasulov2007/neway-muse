/* eslint-disable react-refresh/only-export-components -- the hook and the dialog that wraps it belong together */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CloudUpload, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import {
  demoCurrentUser,
  duplicateDocumentWarning,
  suggestionForLoadDocument,
  uploadLoadDocument,
  type DocumentType as LoadDocumentType,
  type Load,
} from '@/demo';
import { DOCUMENT_CHARGE_TYPE, type UploadSuggestion } from '@neway/shared';
import {
  Badge,
  Button,
  FormField,
  IconButton,
  Input,
  Modal,
  Select,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { addChargeAfterInvoicing, fetchInvoiceFamily } from '@/demo/accounting-server';
import { hashFile, uploadFile } from '@/lib/files';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';

/** The paperwork a load can carry, in the order the picker offers it (owner's mockup, 2026-09-21). */
const TYPE_OPTIONS: { value: LoadDocumentType; label: string }[] = [
  { value: 'rate_confirmation', label: 'Rate confirmation' },
  { value: 'bol', label: 'Bill of lading (BOL)' },
  { value: 'pod', label: 'Proof of delivery (POD)' },
  { value: 'detention', label: 'Detention' },
  { value: 'tonu', label: 'TONU' },
  { value: 'layover', label: 'Layover' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'lumper_receipt', label: 'Lumper receipt' },
  { value: 'other', label: 'Other' },
];

/** The title a type gets until the person types their own. */
const TITLE_FOR: Record<LoadDocumentType, string> = {
  rate_confirmation: 'Rate confirmation',
  bol: 'Bill of lading',
  pod: 'Proof of delivery',
  detention: 'Detention paperwork',
  tonu: 'TONU paperwork',
  layover: 'Layover paperwork',
  invoice: 'Invoice',
  lumper_receipt: 'Lumper receipt',
  other: 'Other paperwork',
};

/** What the filename suggests the paper is; the person can change it. */
function guessType(name: string): LoadDocumentType {
  const n = name.toLowerCase();
  if (/rate|rc\b|confirm/.test(n)) return 'rate_confirmation';
  if (/bol|lading/.test(n)) return 'bol';
  if (/pod|delivery/.test(n)) return 'pod';
  if (/detention/.test(n)) return 'detention';
  if (/tonu/.test(n)) return 'tonu';
  if (/layover/.test(n)) return 'layover';
  if (/lumper/.test(n)) return 'lumper_receipt';
  if (/invoice/.test(n)) return 'invoice';
  return 'other';
}

interface Row {
  key: string;
  file: File;
  type: LoadDocumentType;
  title: string;
  /** True once the person typed a title; the type no longer rewrites it. */
  titleEdited: boolean;
  state: 'ready' | 'uploading' | 'done' | 'failed' | 'duplicate';
  error?: string;
  /** Set when the person said "upload anyway" to a duplicate warning. */
  force?: boolean;
  /** The amount on a lumper, detention, layover or TONU paper; its charge goes with it (owner, 2026-11-02). */
  amount: string;
}

export interface AttachFilesOptions {
  load: Load;
  /** Pre-picks the type for the first file dropped (a row's Upload button). */
  initialType?: LoadDocumentType;
  /** A BOL or POD filed: the question the caller asks the person. */
  onSuggestion?: (suggestion: UploadSuggestion, type: LoadDocumentType) => void;
  /** Every row landed: the dialog closes here, the Paperwork sheet just clears. */
  onDone?: () => void;
}

/**
 * Attach files, as the owner drew it (2026-09-21): drop several papers at once, say what each
 * one is - rate confirmation, BOL, POD, detention, TONU, layover or other - give it a title, and
 * upload them together. Each file goes through the shared load-document upload and lands as
 * Received; review stays a separate action. The two rules the one-file path had are kept: the
 * same file under a second type is warned about before it lands, and a BOL or POD asks whether
 * to move the load afterwards (through `onSuggestion`; nothing moves by itself).
 *
 * The body is a hook so the same area sits inside a dialog of its own and inline on the
 * Paperwork sheet (the owner asked for the three cards to go, 2026-09-22).
 */
export function useAttachFiles({ load, initialType, onSuggestion, onDone }: AttachFilesOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const account = useAccount();
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState('');
  const [over, setOver] = useState(false);
  /** A Replace link named the type the next file gets; used once, then guessed again. */
  const [nextType, setNextType] = useState<LoadDocumentType | null>(null);

  const add = (files: File[]) => {
    const next: Row[] = [];
    const picked = nextType ?? initialType;
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        toast({ tone: 'danger', title: `${file.name} is over 10 MB` });
        continue;
      }
      // The first file takes the type of the button that opened this; the rest are guessed.
      const type = rows.length === 0 && next.length === 0 && picked ? picked : guessType(file.name);
      next.push({
        key: `${file.name}-${file.size}-${Date.now()}-${next.length}`,
        file,
        type,
        title: TITLE_FOR[type],
        titleEdited: false,
        state: 'ready',
        amount: '',
      });
    }
    setRows((r) => [...r, ...next]);
    setNextType(null);
  };
  /** Opens the file picker; with a type, the file it brings back is filed as that type. */
  const browse = (type?: LoadDocumentType) => {
    setNextType(type ?? null);
    input.current?.click();
  };
  const patch = (key: string, next: Partial<Row>) =>
    setRows((r) => r.map((row) => (row.key === key ? { ...row, ...next } : row)));
  const setType = (row: Row, type: LoadDocumentType) =>
    patch(row.key, {
      type,
      title: row.titleEdited ? row.title : TITLE_FOR[type],
      state: 'ready',
      error: undefined,
      force: false,
    });

  const upload = useMutation({
    mutationFn: async () => {
      let ok = 0;
      let first: { suggestion: UploadSuggestion; type: LoadDocumentType } | null = null;
      /** What each lumper amount became, for the toast: on the load, or a supplemental invoice. */
      const billed: string[] = [];
      const notBilled: string[] = [];
      for (const row of rows) {
        if (row.state === 'done') continue;
        patch(row.key, { state: 'uploading', error: undefined });
        try {
          const fileHash = await hashFile(row.file);
          if (!row.force) {
            const warning = duplicateDocumentWarning(load, {
              type: row.type,
              fileName: row.file.name,
              fileHash,
            });
            if (warning) {
              patch(row.key, { state: 'duplicate', error: warning.message });
              continue;
            }
          }
          const stored = await uploadFile(row.file);
          const chargeType = DOCUMENT_CHARGE_TYPE[row.type] ?? null;
          const amount = chargeType && Number(row.amount) > 0 ? Number(row.amount) : null;
          // An invoiced load (owner, 2026-11-02): the charge is billed on a supplemental invoice,
          // issued at once so it goes to RTS; a load not yet invoiced carries it into its invoice.
          const invoiced = amount !== null && Boolean(load.invoiceId);
          const updated = await uploadLoadDocument({
            loadId: load.id,
            type: row.type,
            fileName: row.file.name,
            sizeBytes: row.file.size,
            mimeType: row.file.type,
            fileUrl: stored.url,
            fileId: stored.id,
            uploadedBy: account?.name ?? demoCurrentUser.name,
            fileHash,
            title: row.title.trim() || undefined,
            note: notes.trim() || undefined,
            chargeAmount: invoiced ? null : amount,
          });
          if (amount !== null && invoiced && load.invoiceId && chargeType === 'tonu') {
            notBilled.push(`${load.loadNumber} is already invoiced: change the TONU fee with Create revision in Accounting.`);
          } else if (amount !== null && invoiced && load.invoiceId && chargeType) {
            const docId = updated.documents.find((d) => (d as { fileId?: string }).fileId === stored.id)?.id ?? null;
            try {
              const family = await fetchInvoiceFamily(load.invoiceId);
              const parent = family.find((i) => i.isCurrent && !(i as { supplementOf?: unknown }).supplementOf) ?? null;
              if (!parent) throw new Error('the invoice was not found');
              const out = await addChargeAfterInvoicing(parent.id, {
                requestKey: `${chargeType}-${stored.id}`,
                reason: notes.trim().length >= 3 ? notes.trim().slice(0, 500) : `${TITLE_FOR[row.type]} filed after invoicing`,
                charges: [
                  {
                    chargeType,
                    description: row.title.trim() || TITLE_FOR[row.type],
                    amount,
                    supportingDocumentIds: docId ? [docId] : [],
                    newFiles: [],
                    payableToDriver: false,
                  },
                ],
                issueNow: true,
                expectedUpdatedAt: parent.updatedAt,
              });
              if (out.ok) billed.push(`${out.invoice.invoiceNumber} ${amount.toFixed(2)}`);
              else notBilled.push(out.blocked ?? 'The supplemental invoice was refused.');
            } catch (e) {
              notBilled.push(e instanceof Error ? e.message : 'The supplemental invoice failed.');
            }
          } else if (amount !== null) {
            billed.push(`${amount.toFixed(2)} on ${load.loadNumber}`);
          }
          patch(row.key, { state: 'done' });
          ok += 1;
          const suggestion = suggestionForLoadDocument(updated, row.type);
          if (suggestion && !first) first = { suggestion, type: row.type };
        } catch (error) {
          patch(row.key, {
            state: 'failed',
            error: error instanceof Error ? error.message : 'The upload failed.',
          });
        }
      }
      return { ok, first, total: rows.filter((r) => r.state !== 'done').length, billed, notBilled };
    },
    onSuccess: async ({ ok, first, total, billed, notBilled }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['loads'] }),
        queryClient.invalidateQueries({ queryKey: ['load'] }),
        queryClient.invalidateQueries({ queryKey: ['accounting'] }),
      ]);
      if (billed.length > 0) toast({ tone: 'success', title: 'Charge added', description: billed.join(' · ') });
      if (notBilled.length > 0) toast({ tone: 'warning', title: 'File filed, charge not billed', description: notBilled.join(' · ') });
      if (ok > 0) {
        toast({
          tone: 'success',
          title: `${ok} file${ok === 1 ? '' : 's'} filed on ${load.loadNumber}`,
          description: 'Received. Review is a separate action.',
        });
      }
      // Everything landed: clear the sheet, then ask the one question the paperwork raised.
      if (ok === total) {
        setRows([]);
        setNotes('');
        onDone?.();
        if (first) onSuggestion?.(first.suggestion, first.type);
      }
    },
  });

  const pending = rows.filter(
    (r) => r.state === 'ready' || r.state === 'failed' || (r.state === 'duplicate' && r.force),
  ).length;

  const body: ReactNode = (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(Array.from(e.dataTransfer?.files ?? []));
        }}
        className={cn(
          'flex min-h-28 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-nw-border-strong bg-nw-subtle px-4 py-6 text-center transition-colors',
          over && 'border-nw-accent bg-nw-accent-tint',
        )}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          aria-label="Files"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <CloudUpload className="size-7 text-nw-text-3" aria-hidden />
        <span className="text-sm font-semibold text-ink">
          Drop files here or{' '}
          <button
            type="button"
            className="text-nw-accent-ink underline"
            onClick={() => input.current?.click()}
          >
            browse
          </button>
        </span>
        <span className="text-xs text-muted">PDF or image (PDF, JPG, PNG)</span>
      </div>

      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-nw-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-nw-border bg-nw-subtle text-left text-xs font-semibold text-nw-text-2">
                <th className="px-3 py-2">Document type</th>
                <th className="px-3 py-2">Title</th>
                {rows.some((r) => DOCUMENT_CHARGE_TYPE[r.type]) ? <th className="w-28 px-3 py-2">Amount</th> : null}
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Upload state</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const locked = row.state === 'uploading' || row.state === 'done';
                return (
                  <tr key={row.key} className="border-b border-nw-border align-top last:border-b-0">
                    <td className="w-44 px-3 py-2">
                      <Select
                        size="sm"
                        aria-label={`Type of ${row.file.name}`}
                        options={TYPE_OPTIONS}
                        value={row.type}
                        disabled={locked}
                        onValueChange={(v) => setType(row, v as LoadDocumentType)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        size="sm"
                        aria-label={`Title of ${row.file.name}`}
                        value={row.title}
                        disabled={locked}
                        onChange={(e) =>
                          patch(row.key, { title: e.target.value, titleEdited: true })
                        }
                      />
                    </td>
                    {rows.some((r) => DOCUMENT_CHARGE_TYPE[r.type]) ? (
                      <td className="w-28 px-3 py-2">
                        {DOCUMENT_CHARGE_TYPE[row.type] ? (
                          <Input
                            size="sm"
                            inputMode="decimal"
                            aria-label={`Amount of ${row.file.name}`}
                            placeholder="$0.00"
                            value={row.amount}
                            disabled={locked}
                            onChange={(e) => patch(row.key, { amount: e.target.value.replace(/[^0-9.]/g, '') })}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td
                      className="max-w-40 truncate px-3 py-2 text-nw-text-1"
                      title={row.file.name}
                    >
                      {row.file.name}
                    </td>
                    <td className="px-3 py-2">
                      {row.state === 'ready' ? (
                        <Badge tone="info" variant="soft" size="sm">
                          Ready to upload
                        </Badge>
                      ) : row.state === 'uploading' ? (
                        <Badge tone="info" variant="soft" size="sm">
                          Uploading…
                        </Badge>
                      ) : row.state === 'done' ? (
                        <Badge tone="success" variant="soft" size="sm">
                          Received
                        </Badge>
                      ) : row.state === 'duplicate' ? (
                        <span className="flex flex-col items-start gap-1">
                          <Badge tone="warning" variant="soft" size="sm">
                            Same file, second type
                          </Badge>
                          <span className="text-2xs text-muted">{row.error}</span>
                          {row.force ? (
                            <span className="text-2xs text-ink">Will upload anyway</span>
                          ) : (
                            <Button
                              size="sm"
                              variant="link"
                              onClick={() => patch(row.key, { force: true })}
                            >
                              Upload anyway
                            </Button>
                          )}
                        </span>
                      ) : (
                        <Badge tone="danger" variant="soft" size="sm" title={row.error}>
                          Failed - retry
                        </Badge>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <IconButton
                        label={`Remove ${row.file.name}`}
                        size="sm"
                        variant="ghost"
                        disabled={row.state === 'uploading'}
                        onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
                      >
                        <Trash2 />
                      </IconButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <FormField label="Notes (optional)">
        <Textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add any notes about these files…"
        />
      </FormField>
      <p className="text-xs text-muted">
        Successful uploads show <span className="font-medium text-ink">Received</span>. Review is a
        separate action.
        {rows.some((r) => DOCUMENT_CHARGE_TYPE[r.type])
          ? ' An amount on a lumper, detention or layover paper is added to the load as a charge billed to the broker; on a TONU it is the TONU fee.'
          : ''}
      </p>
    </div>
  );

  return {
    body,
    pending,
    isPending: upload.isPending,
    upload: () => upload.mutate(),
    browse,
  };
}

/** The Attach files area in a dialog of its own (Loads row menu, load page). */
export function AttachFilesDialog({
  load,
  open,
  onOpenChange,
  initialType,
  onSuggestion,
}: Omit<AttachFilesOptions, 'onDone'> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const attach = useAttachFiles({
    load,
    initialType,
    onSuggestion,
    onDone: () => onOpenChange(false),
  });
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && attach.isPending) return;
        onOpenChange(next);
      }}
      size="lg"
      title="Attach files"
      description={`Load ${load.loadNumber} · Add paperwork to this load.`}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={attach.isPending}
          >
            Cancel
          </Button>
          <Button
            loading={attach.isPending}
            disabled={attach.pending === 0}
            onClick={attach.upload}
          >
            Upload {attach.pending} file{attach.pending === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {attach.body}
    </Modal>
  );
}
