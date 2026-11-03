import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Download, FileText, History, Info, MapPin, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import {
  COMPANY_DOCUMENT_DEFS,
  COMPANY_DOCUMENT_STATUS_LABEL,
  companyDocumentDef,
  type CompanyDocument,
  type CompanyDocumentKind,
  type CompanyDocumentSlot,
  type CompanyDocumentStatus,
  type CompanyProfileFields,
  type CompanyProfileView,
  type TrailerYard,
} from '@neway/shared';
import { Badge, Button, DatePicker, Drawer, ErrorState, FormField, Input, Modal, StatusSymbol, Textarea, cn, useToast, type StatusSymbolFamily } from '@/design-system';
import { API_BASE_URL } from '@/lib/api';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { openFile, uploadFile } from '@/lib/files';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { sessionToken } from '@/lib/session';

/**
 * Company info (owner, 2026-10-19), kept quiet on purpose: who the carrier is, the papers a broker
 * asks for, the yards. One line at the top says whether the broker packet can go out; the papers
 * are one list with a symbol and a word for each; the profile reads as plain facts and is edited
 * in a side panel. Nothing here is a tile.
 */

const KEY = ['company', 'profile'] as const;
const STATUS_FAMILY: Record<CompanyDocumentStatus, StatusSymbolFamily> = { valid: 'done', expiring: 'warning', expired: 'urgent', missing: 'warning' };
const STATUS_TONE: Record<CompanyDocumentStatus, 'success' | 'warning' | 'danger' | 'neutral'> = { valid: 'success', expiring: 'warning', expired: 'danger', missing: 'warning' };

function StatusWord({ status }: { status: CompanyDocumentStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} size="sm" icon={<StatusSymbol family={STATUS_FAMILY[status]} size={12} />}>
      {COMPANY_DOCUMENT_STATUS_LABEL[status]}
    </Badge>
  );
}

async function downloadPacket(): Promise<string> {
  const token = sessionToken();
  const res = await fetch(`${API_BASE_URL}/company/packet`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{}' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `The packet could not be prepared (${res.status}).`);
  }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'broker_packet.zip';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export function CompanyInfoPage() {
  const { toast } = useToast();
  const query = useQuery({ queryKey: KEY, queryFn: () => apiGet<CompanyProfileView>('/company/profile') });
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState<{ kind: CompanyDocumentKind; replaces: CompanyDocument | null } | null>(null);
  const packet = useMutation({
    mutationFn: downloadPacket,
    onSuccess: (name) => toast({ tone: 'success', title: 'Broker packet downloaded', description: name }),
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Packet not ready', description: e instanceof Error ? e.message : undefined }),
  });

  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  const v = query.data;
  const p = v?.profile;
  const packetSlots = v?.documents.filter((s) => s.inPacket) ?? [];
  const readyCount = packetSlots.filter((s) => s.status === 'valid' || s.status === 'expiring').length;
  const notReady = packetSlots.length - readyCount;

  return (
    <div className="flex w-full flex-col gap-5" data-testid="company-info-page">
      <nav aria-label="Breadcrumb" className="text-sm text-nw-text-3">
        Settings <span className="mx-1.5">/</span> <span className="text-nw-text-2">Company info</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <span className="grid size-14 shrink-0 place-items-center rounded-xl border border-nw-border bg-nw-panel text-nw-accent-ink" aria-hidden>
            <Building2 className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[26px] leading-tight font-bold text-nw-text">{v ? p!.legalName || 'Company name not set' : 'Loading…'}</h1>
            <p className="text-sm text-nw-text-2">{p?.dba ? `DBA ${p.dba}` : 'Company profile'}</p>
            {v ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <IdChip label="MC" value={p!.mcNumber} />
                <IdChip label="DOT" value={p!.dotNumber} />
                {p!.scac ? <IdChip label="SCAC" value={p!.scac} /> : null}
              </div>
            ) : null}
          </div>
        </div>
        {v ? (
          <div className="flex flex-wrap gap-2">
            {v.canEdit ? (
              <Button variant="outline" icon={<Pencil />} onClick={() => setEditing(true)} data-testid="company-edit">
                Edit company
              </Button>
            ) : null}
            <Button variant="primary" icon={<Download />} disabled={!v.packet.ready} loading={packet.isPending} onClick={() => packet.mutate()} data-testid="broker-packet">
              Download broker packet
            </Button>
          </div>
        ) : null}
      </header>

      {v ? (
        <div
          role="status"
          className={cn(
            'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border px-4 py-3',
            v.packet.ready ? 'border-nw-done-border bg-nw-done-bg' : 'border-nw-warning-border bg-nw-warning-bg',
          )}
        >
          <StatusSymbol family={v.packet.ready ? 'done' : 'warning'} size={20} className={v.packet.ready ? 'text-nw-done-icon' : 'text-nw-warning-icon'} />
          <p className="min-w-0 flex-1 text-sm">
            <span className={cn('font-bold', v.packet.ready ? 'text-nw-done-text' : 'text-nw-warning-text')}>{v.packet.ready ? 'Broker packet ready' : 'Broker packet incomplete'}</span>
            <span className={cn('ml-3', v.packet.ready ? 'text-nw-done-text' : 'text-nw-warning-text')}>
              {v.packet.ready ? 'W-9, COI, MC authority and NOA are current.' : packetHold(v.documents, notReady)}
            </span>
          </p>
          <span className="flex items-center gap-3 text-sm text-nw-text-2">
            {readyCount} of {packetSlots.length} ready
            <span className="h-2 w-36 overflow-hidden rounded-full bg-nw-panel" aria-hidden>
              <span className={cn('block h-full rounded-full', v.packet.ready ? 'bg-nw-done-icon' : 'bg-nw-warning-icon')} style={{ width: `${packetSlots.length ? (readyCount / packetSlots.length) * 100 : 0}%` }} />
            </span>
          </span>
        </div>
      ) : null}

      {!v ? (
        <p className="text-sm text-nw-text-3">Loading…</p>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <Card
              title="Documents"
              subtitle="Required for your broker packet"
              action={
                v.canEdit ? (
                  <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setUploading({ kind: 'other', replaces: null })}>
                    Add document
                  </Button>
                ) : null
              }
            >
              <ul className="divide-y divide-nw-border px-5" data-testid="company-documents">
                {v.documents.map((slot, i) => (
                  <DocumentRow key={slot.current?.id ?? `${slot.kind}-${i}`} slot={slot} canEdit={v.canEdit} onUpload={() => setUploading({ kind: slot.kind, replaces: slot.current })} />
                ))}
              </ul>
              <p className="mx-5 flex items-center gap-1.5 border-t border-nw-border py-3 text-xs text-nw-text-3 italic">
                <Info className="size-3.5 not-italic" aria-hidden /> Broker packet includes these four documents.
              </p>
            </Card>

            <Card
              title="MC & DOT numbers"
              subtitle={p!.mcNumber || p!.dotNumber ? undefined : 'Add your registration numbers in company details.'}
              action={
                v.canEdit ? (
                  <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(true)}>
                    Edit details
                  </Button>
                ) : null
              }
            >
              {p!.mcNumber || p!.dotNumber || p!.ein || p!.scac ? (
                <dl className="grid grid-cols-2 gap-4 px-5 pb-4 text-sm sm:grid-cols-4">
                  {(
                    [
                      ['MC #', p!.mcNumber],
                      ['DOT #', p!.dotNumber],
                      ['EIN', p!.ein],
                      ['SCAC', p!.scac],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-nw-text-3">{label}</dt>
                      <dd className="font-semibold text-nw-text tabular-nums">{value || <span className="font-normal text-nw-text-3">Not added</span>}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <Card
              title="Company details"
              action={
                v.canEdit ? (
                  <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                ) : null
              }
            >
              <dl className="px-5 pb-2 text-sm">
                <Fact label="EIN">{p!.ein}</Fact>
                <Fact label="Phone">{p!.phone}</Fact>
                <Fact label="Email">{p!.email}</Fact>
                <Fact label="Physical address">{p!.physicalAddress}</Fact>
                <Fact label="Mailing address">{p!.mailingAddress && p!.mailingAddress !== p!.physicalAddress ? p!.mailingAddress : p!.mailingAddress ? 'Same as physical' : ''}</Fact>
                <Fact label="Insurance agent">{[p!.insuranceAgent, p!.insuranceAgentPhone, p!.insuranceAgentEmail].filter(Boolean).join(' · ')}</Fact>
                <Fact label="Factoring">{[p!.factoringCompany, p!.noaReference && `NOA ${p!.noaReference}`].filter(Boolean).join(' · ')}</Fact>
                <Fact label="Recruiting reply-to email">{p!.recruitingReplyTo ?? ''}</Fact>
                <Fact label="Accounting reply-to email">{p!.accountingReplyTo ?? ''}</Fact>
              </dl>
              {v.updatedAt ? <p className="px-5 pb-3 text-xs text-nw-text-3">Last changed {formatDateTime(v.updatedAt)}{v.updatedBy ? ` by ${v.updatedBy}` : ''}</p> : null}
            </Card>

            <Card
              title="Trailer yards"
              action={
                v.canEdit ? (
                  <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setEditing(true)}>
                    Add yard
                  </Button>
                ) : null
              }
            >
              {p!.trailerYards.length === 0 ? (
                <div className="flex flex-col items-center gap-1 px-5 pt-2 pb-6 text-center">
                  <span className="mb-1 grid size-10 place-items-center rounded-full bg-nw-subtle text-nw-text-2" aria-hidden>
                    <MapPin className="size-5" />
                  </span>
                  <p className="text-sm font-semibold text-nw-text">No trailer yards added</p>
                  <p className="text-xs text-nw-text-3 italic">Add a yard for parking and fleet operations.</p>
                </div>
              ) : (
                <ul className="divide-y divide-nw-border px-5 pb-2 text-sm">
                  {p!.trailerYards.map((y) => (
                    <li key={y.id} className="flex gap-3 py-2.5">
                      <MapPin className="mt-0.5 size-4 shrink-0 text-nw-text-3" aria-hidden />
                      <span className="min-w-0">
                        <span className="block font-semibold text-nw-text">{y.name}</span>
                        {y.address ? <span className="block text-nw-text-2">{y.address}</span> : null}
                        {y.note ? <span className="block text-xs text-nw-text-3">{y.note}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {editing && v ? <EditProfile view={v} onClose={() => setEditing(false)} /> : null}
      {uploading ? <UploadDocument kind={uploading.kind} replaces={uploading.replaces} onClose={() => setUploading(null)} /> : null}
    </div>
  );
}

/** Why the packet cannot go, in one line: how many to upload, and which have expired. */
function packetHold(slots: readonly CompanyDocumentSlot[], notReady: number): string {
  const expired = slots.filter((x) => x.inPacket && x.status === 'expired').map((x) => x.label);
  const missing = slots.filter((x) => x.inPacket && x.status === 'missing').length;
  const parts = [missing ? `Upload ${missing} required document${missing === 1 ? '' : 's'}` : '', expired.length ? `replace the expired ${expired.join(', ')}` : ''].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} to enable download.` : `${notReady} document(s) still needed.`;
}

/** A card as the mockup draws it: title, optional subtitle, one action on the right. */
function Card({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-[10px] border border-nw-border bg-nw-panel">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div>
          <h2 className="text-base font-bold text-nw-text">{title}</h2>
          {subtitle ? <p className="text-xs text-nw-text-2">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function IdChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full bg-nw-segment px-2.5 py-0.5 text-xs text-nw-text-2">
      <span className="font-semibold text-nw-text">{label}</span> {value || 'Not added'}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3 border-b border-nw-border py-2 last:border-0">
      <dt className="text-nw-text-3">{label}</dt>
      <dd className="min-w-0 break-words text-nw-text">{children || <span className="text-nw-text-3">Not added</span>}</dd>
    </div>
  );
}

function DocumentRow({ slot, canEdit, onUpload }: { slot: CompanyDocumentSlot; canEdit: boolean; onUpload: () => void }) {
  const [showHistory, setShowHistory] = useState(false);
  const [removing, setRemoving] = useState<CompanyDocument | null>(null);
  const d = slot.current;
  return (
    <li className="py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-nw-subtle text-nw-text-2" aria-hidden>
          <FileText className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-nw-text">{slot.label}</p>
          {d ? (
            <button type="button" onClick={() => openFile({ fileId: d.fileId, fileName: d.fileName })} className="mt-0.5 inline-flex max-w-full items-center gap-1.5 text-xs text-nw-accent-ink hover:underline">
              <FileText className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{d.fileName}</span>
            </button>
          ) : (
            <p className="mt-0.5 text-xs text-nw-text-3">{slot.required ? 'Required · Not uploaded' : 'Not uploaded'}</p>
          )}
        </div>
        {d ? <div className="w-28 text-xs text-nw-text-2 tabular-nums">{d.expiresOn ? `Expires ${formatIsoDate(d.expiresOn)}` : 'No expiry'}</div> : null}
        <StatusWord status={slot.status} />
        <div className="flex items-center gap-1">
          {slot.history.length > 0 ? (
            <Button size="sm" variant="ghost" icon={<History />} onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>
              {slot.history.length}
            </Button>
          ) : null}
          {canEdit ? (
            <Button size="sm" variant="outline" icon={<Upload />} onClick={onUpload}>
              {d ? 'Replace' : 'Upload'}
            </Button>
          ) : null}
          {canEdit && d ? (
            <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label={`Remove ${slot.label}`} onClick={() => setRemoving(d)} />
          ) : null}
        </div>
      </div>
      {showHistory ? (
        <ul className="mt-2 ml-1 border-l border-nw-border pl-3 text-xs text-nw-text-2">
          {slot.history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2 py-1">
              <span className="text-nw-text-3">v{h.versionNumber}</span>
              <button type="button" className="text-nw-accent-ink hover:underline" onClick={() => openFile({ fileId: h.fileId, fileName: h.fileName })}>
                {h.fileName}
              </button>
              <span className="text-nw-text-3">· {formatDateTime(h.uploadedAt)} · {h.uploadedBy}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {removing ? <RemoveDocument doc={removing} onClose={() => setRemoving(null)} /> : null}
    </li>
  );
}

function useSave<T>(fn: (input: T) => Promise<CompanyProfileView>, done: string, onDone: () => void) {
  const client = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (view) => {
      client.setQueryData(KEY, view);
      toast({ tone: 'success', title: done });
      onDone();
    },
    onError: (e: unknown) => {
      toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined });
      void client.invalidateQueries({ queryKey: KEY });
    },
  });
}

function UploadDocument({ kind, replaces, onClose }: { kind: CompanyDocumentKind; replaces: CompanyDocument | null; onClose: () => void }) {
  const def = companyDocumentDef(kind);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [chosenKind, setChosenKind] = useState<CompanyDocumentKind>(kind);
  const [title, setTitle] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState('');
  const chosen = companyDocumentDef(chosenKind);
  const save = useSave(
    async () => {
      const stored = await uploadFile(file!);
      return apiPost<CompanyProfileView>('/company/documents', { kind: chosenKind, title: title.trim() || undefined, fileId: stored.id, issuedOn: issuedOn || null, expiresOn: expiresOn || null, note: note.trim() || null });
    },
    `${title.trim() || chosen.label} uploaded`,
    onClose,
  );
  const ready = Boolean(file) && (chosenKind !== 'coi' || Boolean(expiresOn)) && (chosenKind !== 'other' || title.trim().length > 0);
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="md"
      title={replaces ? `Replace ${def.label}` : kind === 'other' ? 'Add document' : `Upload ${def.label}`}
      description={replaces ? `The current file (${replaces.fileName}) stays on record as an earlier version.` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || save.isPending} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Upload
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {kind === 'other' ? (
          <>
            <FormField label="Kind">
              <select value={chosenKind} onChange={(e) => setChosenKind(e.target.value as CompanyDocumentKind)} className="h-9 rounded-md border border-nw-border bg-nw-field px-2 text-sm text-nw-text">
                {COMPANY_DOCUMENT_DEFS.map((d) => (
                  <option key={d.kind} value={d.kind}>
                    {d.label}
                  </option>
                ))}
              </select>
            </FormField>
            {chosenKind === 'other' ? (
              <FormField label="Name" required>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Operating agreement" />
              </FormField>
            ) : null}
          </>
        ) : null}
        <FormField label="File" required>
          <input ref={fileRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" icon={<Upload />} onClick={() => fileRef.current?.click()}>
              Choose file
            </Button>
            <span className="truncate text-sm text-nw-text-2">{file?.name ?? 'No file chosen'}</span>
            {file ? <Button size="sm" variant="ghost" icon={<X />} aria-label="Clear file" onClick={() => setFile(null)} /> : null}
          </div>
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Issued">
            <DatePicker value={issuedOn || null} onIsoChange={(x) => setIssuedOn(x ?? '')} />
          </FormField>
          <FormField label="Expires" required={chosenKind === 'coi'}>
            <DatePicker value={expiresOn || null} onIsoChange={(x) => setExpiresOn(x ?? '')} />
          </FormField>
        </div>
        <FormField label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}

function RemoveDocument({ doc, onClose }: { doc: CompanyDocument; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useSave((r: string) => apiPost<CompanyProfileView>(`/company/documents/${encodeURIComponent(doc.id)}/void`, { reason: r }), `${doc.title} removed`, onClose);
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title={`Remove ${doc.title}`}
      description="It leaves the page and the broker packet, and stays on record with your reason."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep
          </Button>
          <Button variant="primary" disabled={reason.trim().length < 3 || save.isPending} loading={save.isPending} onClick={() => save.mutate(reason.trim())}>
            Remove
          </Button>
        </>
      }
    >
      <FormField label="Why" required>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Uploaded the wrong file" />
      </FormField>
    </Modal>
  );
}

const PROFILE_FIELDS: Array<{ key: keyof CompanyProfileFields; label: string; section: string; wide?: boolean }> = [
  { key: 'legalName', label: 'Legal name', section: 'Identity', wide: true },
  { key: 'dba', label: 'DBA', section: 'Identity', wide: true },
  { key: 'mcNumber', label: 'MC #', section: 'Identity' },
  { key: 'dotNumber', label: 'DOT #', section: 'Identity' },
  { key: 'ein', label: 'EIN', section: 'Identity' },
  { key: 'scac', label: 'SCAC', section: 'Identity' },
  { key: 'phone', label: 'Phone', section: 'Contact' },
  { key: 'email', label: 'Email', section: 'Contact' },
  { key: 'physicalAddress', label: 'Physical address', section: 'Addresses', wide: true },
  { key: 'mailingAddress', label: 'Mailing address', section: 'Addresses', wide: true },
  { key: 'insuranceAgent', label: 'Agent', section: 'Insurance agent', wide: true },
  { key: 'insuranceAgentPhone', label: 'Phone', section: 'Insurance agent' },
  { key: 'insuranceAgentEmail', label: 'Email', section: 'Insurance agent' },
  { key: 'factoringCompany', label: 'Factoring company', section: 'Factoring' },
  { key: 'noaReference', label: 'NOA reference', section: 'Factoring' },
  { key: 'recruitingReplyTo', label: 'Recruiting reply-to email', section: 'Email replies' },
  { key: 'accountingReplyTo', label: 'Accounting reply-to email', section: 'Email replies' },
];

function EditProfile({ view, onClose }: { view: CompanyProfileView; onClose: () => void }) {
  const [f, setF] = useState<CompanyProfileFields>(view.profile);
  const save = useSave((body: CompanyProfileFields) => apiPatch<CompanyProfileView>('/company/profile', { ...body, version: view.version }), 'Company info saved', onClose);
  const set = (k: keyof CompanyProfileFields, value: string) => setF((s) => ({ ...s, [k]: value }));
  const setYard = (i: number, patch: Partial<TrailerYard>) => setF((s) => ({ ...s, trailerYards: s.trailerYards.map((y, j) => (j === i ? { ...y, ...patch } : y)) }));
  const sections = [...new Set(PROFILE_FIELDS.map((x) => x.section))];
  const yardsValid = f.trailerYards.every((y) => y.name.trim().length > 0);
  return (
    <Drawer
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="md"
      title="Edit company info"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!yardsValid || save.isPending} loading={save.isPending} onClick={() => save.mutate(f)} data-testid="company-save">
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {sections.map((section) => (
          <fieldset key={section} className="flex flex-col gap-3">
            <legend className="mb-1 text-xs font-semibold tracking-[0.08em] text-nw-text-3 uppercase">{section}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {PROFILE_FIELDS.filter((x) => x.section === section).map((x) => (
                <FormField key={x.key} label={x.label} className={x.wide ? 'sm:col-span-2' : undefined}>
                  <Input value={String(f[x.key] ?? '')} onChange={(e) => set(x.key, e.target.value)} />
                </FormField>
              ))}
            </div>
          </fieldset>
        ))}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-xs font-semibold tracking-[0.08em] text-nw-text-3 uppercase">Trailer yards</legend>
          {f.trailerYards.map((y, i) => (
            <div key={y.id} className="grid gap-2 rounded-lg border border-nw-border p-3">
              <div className="flex items-end gap-2">
                <FormField label="Name" required className="flex-1">
                  <Input value={y.name} onChange={(e) => setYard(i, { name: e.target.value })} />
                </FormField>
                <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label={`Remove ${y.name || 'yard'}`} onClick={() => setF((s) => ({ ...s, trailerYards: s.trailerYards.filter((_, j) => j !== i) }))} />
              </div>
              <FormField label="Address">
                <Input value={y.address} onChange={(e) => setYard(i, { address: e.target.value })} />
              </FormField>
              <FormField label="Note">
                <Input value={y.note} onChange={(e) => setYard(i, { note: e.target.value })} placeholder="Gate code, hours, contact" />
              </FormField>
            </div>
          ))}
          <Button size="sm" variant="outline" icon={<Plus />} className="w-fit" onClick={() => setF((s) => ({ ...s, trailerYards: [...s.trailerYards, { id: `yard_${crypto.randomUUID().slice(0, 8)}`, name: '', address: '', note: '' }] }))}>
            Add yard
          </Button>
        </fieldset>
      </div>
    </Drawer>
  );
}
