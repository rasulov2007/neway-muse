import { Archive, Check, Eye, Import, Upload } from 'lucide-react';
import { useState } from 'react';
import { DOT_APP_DOCUMENTS, DOT_APP_STEP_TITLES, type DotAppStepId, type DotAppTemplateOverview, type DotAppTemplateRow } from '@neway/shared';
import { Alert, Button, Checkbox, ConfirmDialog, FormField, Input, Modal, PageHeader, Select, Textarea, useToast } from '@/design-system';
import { PermissionGate } from '@/features/admin/components/AdminKit';
import { usePermissionCheck } from '@/features/admin/useAdmin';
import { templatesApi, useTemplate, useTemplateOverview, useTemplatesMutation } from '@/features/dot-application/api';
import { FamilyBadge, type DotAppFamily } from '@/features/dot-application/status';
import { FilePick } from '@/features/hr/recruit/journey/JourneyKit';
import { errorText } from '@/features/hr/recruit/journey/journey-utils';
import { longDateTime } from '@/features/hr/recruit/recruit-format';
import { LegalText } from '@/features/safety/dot-applications/kit';
import { uploadFile } from '@/lib/files';

export const TEMPLATES_PERMISSION = 'application_templates.manage';

export function DocumentTemplatesPage() {
  const check = usePermissionCheck(TEMPLATES_PERMISSION);
  return (
    <PermissionGate check={check} permission={TEMPLATES_PERMISSION} what="document templates">
      <DocumentTemplates />
    </PermissionGate>
  );
}

const VERSION_LOOK: Record<DotAppTemplateRow['status'], { family: DotAppFamily; label: string }> = {
  draft: { family: 'warning', label: 'Draft' },
  approved: { family: 'done', label: 'Approved' },
  retired: { family: 'neutral', label: 'Retired' },
};

function stepTitle(step: string): string {
  if (step === 'employer') return 'Safety — employer forms';
  if (step === 'onboarding') return 'Safety — onboarding';
  return DOT_APP_STEP_TITLES[step as DotAppStepId] ?? step;
}

/**
 * Admin → Document templates (owner brief 2026-10-27): each company's own legal documents for the
 * DOT driver application, by version. A document is used only once it is approved for this company;
 * one company's documents are never used for another.
 */
export function DocumentTemplates() {
  const { toast } = useToast();
  const q = useTemplateOverview();
  const [preview, setPreview] = useState<{ id: string; approve: boolean } | null>(null);
  const [retiring, setRetiring] = useState<DotAppTemplateRow | null>(null);
  const [uploading, setUploading] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  const [importing, setImporting] = useState<{ id: string; title: string } | null>(null);
  const approveAll = useTemplatesMutation(() => templatesApi.approveDrafts());
  const importSet = useTemplatesMutation((setId: string) => templatesApi.importSet(setId));

  if (q.isPending) return <p className="text-sm text-nw-text-3">Loading…</p>;
  if (q.isError) return <Alert tone="danger" title="Document templates could not be loaded" description={errorText(q.error)} />;
  const o = q.data;
  const drafts = o.documents.flatMap((d) => d.versions).filter((v) => v.status === 'draft');
  const awaiting = o.documents.filter((d) => !d.current);

  return (
    <div className="flex flex-col gap-5" data-testid="document-templates">
      <PageHeader
        title="Document templates"
        description={`The legal documents of the DOT driver application for ${o.company.name}. The application can be sent once every document has an approved version.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {drafts.length > 0 ? (
              <Button variant="outline" icon={<Check />} onClick={() => setApprovingAll(true)} data-testid="approve-all-drafts">
                Approve all drafts ({drafts.length})
              </Button>
            ) : null}
            <Button variant="primary" icon={<Upload />} onClick={() => setUploading(true)} data-testid="upload-version">
              Upload a new version
            </Button>
          </div>
        }
      />
      {awaiting.length > 0 ? (
        <Alert tone="warning" title={`Awaiting ${o.company.name} approved documents (${awaiting.length})`} description="Until each one has an approved version, Recruiting keeps sending the earlier application." data-testid="templates-awaiting" />
      ) : (
        <Alert tone="success" title="Every document has an approved version" description="Recruiting sends the DOT driver application v2." />
      )}
      {o.importableSets.length > 0 ? (
        <section className="flex flex-col gap-3 rounded-[10px] border border-nw-border bg-nw-panel p-5" data-testid="importable-sets">
          <div>
            <h3 className="text-md font-bold text-nw-text">Import this company's documents</h3>
            <p className="mt-0.5 text-xs text-nw-text-3">
              A document set was verified word for word against this company's own PDFs. It can be imported only into its own company — never into another. Imported documents arrive as drafts; read each one, then approve it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {o.importableSets.map((s) => (
              <Button key={s.id} variant="outline" icon={<Import />} onClick={() => setImporting({ id: s.id, title: s.title })} data-testid={`import-${s.id}`}>
                Import {s.title} ({s.documents})
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      <section className="overflow-hidden rounded-[10px] border border-nw-border bg-nw-panel">
        <ul className="divide-y divide-nw-border" data-testid="templates-list">
          {o.documents.map((d) => (
            <li key={d.key} className="flex flex-col gap-2 px-5 py-4" data-testid={`template-${d.key}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-nw-text">{d.title}</p>
                  <p className="text-xs text-nw-text-3">{stepTitle(d.step)}</p>
                </div>
                {d.current ? (
                  <span className="flex flex-col items-end gap-0.5 text-right">
                    <FamilyBadge family="done">Approved · {d.current.version}</FamilyBadge>
                    <span className="text-xs text-nw-text-3">
                      {d.current.approvedByName ?? '—'} · {longDateTime(d.current.approvedAt)}
                    </span>
                  </span>
                ) : (
                  <FamilyBadge family="warning">Awaiting approved document</FamilyBadge>
                )}
              </div>
              {d.versions.length > 0 ? (
                <ul className="flex flex-col gap-1.5 rounded-lg border border-nw-border p-2">
                  {d.versions.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <FamilyBadge family={VERSION_LOOK[v.status].family} size="sm">
                        {VERSION_LOOK[v.status].label}
                      </FamilyBadge>
                      <span className="font-mono text-xs text-nw-text">{v.version}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-nw-text-3">
                        {v.sourceFileName ? `${v.sourceFileName} · ` : ''}added {longDateTime(v.createdAt)} by {v.createdByName}
                        {v.note ? ` · ${v.note}` : ''}
                      </span>
                      <Button size="sm" variant="ghost" icon={<Eye />} onClick={() => setPreview({ id: v.id, approve: false })}>
                        Preview
                      </Button>
                      {v.status === 'draft' ? (
                        <Button size="sm" variant="outline" icon={<Check />} onClick={() => setPreview({ id: v.id, approve: true })} data-testid={`approve-${v.id}`}>
                          Approve
                        </Button>
                      ) : null}
                      {v.status === 'approved' ? (
                        <Button size="sm" variant="ghost" icon={<Archive />} onClick={() => setRetiring(v)}>
                          Retire
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-nw-text-3">No versions on file.</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {preview ? <PreviewModal id={preview.id} approve={preview.approve} company={o.company.name} onClose={() => setPreview(null)} /> : null}
      {retiring ? <RetireModal row={retiring} onClose={() => setRetiring(null)} /> : null}
      {uploading ? <UploadModal overview={o} onClose={() => setUploading(false)} /> : null}
      <ConfirmDialog
        open={approvingAll}
        onOpenChange={setApprovingAll}
        title={`Approve all ${drafts.length} drafts?`}
        description={`Only when every draft has been read and is approved for ${o.company.name}. Each becomes the version drivers sign; the version it replaces is retired.`}
        confirmLabel="Approve all drafts"
        onConfirm={() =>
          approveAll.mutateAsync(undefined).then(
            (r) => toast({ tone: 'success', title: `${r.approved} documents approved` }),
            (e: unknown) => {
              toast({ tone: 'danger', title: 'Not approved', description: errorText(e) });
              throw e;
            },
          )
        }
      />
      <ConfirmDialog
        open={importing !== null}
        onOpenChange={(v) => (v ? undefined : setImporting(null))}
        title={`Import ${importing?.title ?? ''}?`}
        description={`The documents arrive as drafts for ${o.company.name}. Versions already on file are skipped.`}
        confirmLabel="Import"
        onConfirm={() =>
          importSet.mutateAsync(importing!.id).then(
            (r) => toast({ tone: 'success', title: `${r.created} imported`, description: r.skipped ? `${r.skipped} already on file` : undefined }),
            (e: unknown) => {
              toast({ tone: 'danger', title: 'Not imported', description: errorText(e) });
              throw e;
            },
          )
        }
      />
    </div>
  );
}

/** The template's content, read-only: its legal text sanitised, the rest as plain values. */
export function TemplateContent({ content }: { content: Record<string, unknown> }) {
  const entries = Object.entries(content).filter(([k]) => !['title', 'src', 'ver'].includes(k));
  return (
    <div className="flex flex-col gap-3" data-testid="template-content">
      {entries.map(([k, v]) => {
        const looksHtml = typeof v === 'string' && /<\/?[a-z][\s\S]*>/i.test(v);
        return (
          <div key={k} className="flex flex-col gap-1">
            <span className="text-xs font-semibold tracking-wide text-nw-text-3 uppercase">{k}</span>
            {looksHtml ? (
              <LegalText html={v} />
            ) : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? (
              <p className="text-sm whitespace-pre-wrap text-nw-text-2">{String(v)}</p>
            ) : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (
              <ul className="list-disc pl-5 text-sm text-nw-text-2">
                {(v as string[]).map((x, i) =>
                  /<\/?[a-z][\s\S]*>/i.test(x) ? (
                    <li key={i}>
                      <LegalText html={x} className="border-0 bg-transparent p-0" />
                    </li>
                  ) : (
                    <li key={i}>{x}</li>
                  ),
                )}
              </ul>
            ) : (
              <pre className="scroll-quiet max-h-64 overflow-auto rounded-lg border border-nw-border bg-nw-subtle p-3 text-xs whitespace-pre-wrap text-nw-text-2">{JSON.stringify(v, null, 2)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PreviewModal({ id, approve, company, onClose }: { id: string; approve: boolean; company: string; onClose: () => void }) {
  const { toast } = useToast();
  const q = useTemplate(id);
  const [read, setRead] = useState(false);
  const ok = useTemplatesMutation(() => templatesApi.approve(id));
  return (
    <Modal
      open
      size="lg"
      onOpenChange={(o) => (!o && !ok.isPending ? onClose() : undefined)}
      title={q.data ? `${q.data.title} · ${q.data.version}` : 'Document'}
      description={q.data ? `${q.data.source ?? 'No source recorded'} · sha-256 ${q.data.contentSha256.slice(0, 12)}…` : undefined}
      footer={
        approve ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={ok.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Check />}
              disabled={!read || !q.data || q.data.row.status !== 'draft'}
              loading={ok.isPending}
              data-testid="approve-confirm"
              onClick={() =>
                ok.mutate(undefined, {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Approved', description: q.data?.title });
                    onClose();
                  },
                  onError: (e) => toast({ tone: 'danger', title: 'Not approved', description: errorText(e) }),
                })
              }
            >
              Approve
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {q.isPending ? (
        <p className="text-sm text-nw-text-3">Loading…</p>
      ) : q.isError ? (
        <Alert tone="danger" title="Could not load the document" description={errorText(q.error)} />
      ) : (
        <div className="flex flex-col gap-4">
          <TemplateContent content={q.data.content} />
          {approve ? (
            <div className="rounded-lg border border-nw-border p-3">
              <Checkbox checked={read} onCheckedChange={(v) => setRead(v === true)} label={`I have read this document and it is approved for ${company}`} data-testid="approve-read" />
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function RetireModal({ row, onClose }: { row: DotAppTemplateRow; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const retire = useTemplatesMutation((r: string) => templatesApi.retire(row.id, r));
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(o) => (!o && !retire.isPending ? onClose() : undefined)}
      title={`Retire ${row.title} ${row.version}?`}
      description="Applications already sent keep the version they were sent with. New applications cannot be sent until another version is approved."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={retire.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={retire.isPending}
            disabled={reason.trim().length < 3}
            onClick={() =>
              retire.mutate(reason.trim(), {
                onSuccess: () => {
                  toast({ tone: 'success', title: 'Retired' });
                  onClose();
                },
                onError: (e) => toast({ tone: 'danger', title: 'Not retired', description: errorText(e) }),
              })
            }
          >
            Retire
          </Button>
        </>
      }
    >
      <FormField label="Reason" required>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </Modal>
  );
}

function UploadModal({ overview, onClose }: { overview: DotAppTemplateOverview; onClose: () => void }) {
  const { toast } = useToast();
  const docs = overview.documents.length ? overview.documents.map((d) => ({ key: d.key, title: d.title })) : DOT_APP_DOCUMENTS.map((d) => ({ key: d.key, title: d.title }));
  const [docKey, setDocKey] = useState(docs[0]?.key ?? '');
  const [version, setVersion] = useState('');
  const [title, setTitle] = useState(docs[0]?.title ?? '');
  const [content, setContent] = useState('{\n  "html": ""\n}');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useTemplatesMutation((body: Parameters<typeof templatesApi.create>[0]) => templatesApi.create(body));
  let parsed: Record<string, unknown> | null = null;
  let jsonError: string | null = null;
  try {
    const v: unknown = JSON.parse(content);
    if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    else jsonError = 'The content must be a JSON object.';
  } catch {
    jsonError = 'The content is not valid JSON.';
  }
  const ready = Boolean(docKey && version.trim() && title.trim().length >= 2 && parsed);
  return (
    <Modal
      open
      size="lg"
      onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}
      title="Upload a new version"
      description={`A new version arrives as a draft for ${overview.company.name}; it is used only after it is approved.`}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Upload />}
            disabled={!ready}
            loading={busy}
            data-testid="upload-confirm"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const source = file ? await uploadFile(file) : null;
                await create.mutateAsync({ docKey, version: version.trim(), title: title.trim(), content: { ...parsed!, title: title.trim(), ver: version.trim() }, sourceFileId: source?.id, note: note.trim() || undefined });
                toast({ tone: 'success', title: 'Draft added', description: `${title.trim()} ${version.trim()}` });
                onClose();
              } catch (e) {
                setError(errorText(e, 'The version was not saved.'));
              } finally {
                setBusy(false);
              }
            }}
          >
            Add draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="upload-modal">
        {error ? <Alert tone="danger" title="Not saved" description={error} /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Document" required className="sm:col-span-2">
            <Select
              aria-label="Document"
              value={docKey}
              onValueChange={(k) => {
                setDocKey(k);
                setTitle(docs.find((d) => d.key === k)?.title ?? '');
              }}
              options={docs.map((d) => ({ value: d.key, label: d.title }))}
            />
          </FormField>
          <FormField label="Version" required description="As printed on the source, e.g. AJ-HIR-2026.11">
            <Input value={version} onChange={(e) => setVersion(e.target.value)} />
          </FormField>
          <FormField label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>
        </div>
        <FilePick label="Source PDF (optional)" file={file} onFile={setFile} accept="application/pdf" />
        <FormField label="Content (advanced, JSON)" description="The document's structured content: html, check, certify, items … verbatim from the source." error={jsonError ?? undefined}>
          <Textarea rows={10} value={content} onChange={(e) => setContent(e.target.value)} className="font-mono text-xs" spellCheck={false} />
        </FormField>
        <FormField label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this version" />
        </FormField>
      </div>
    </Modal>
  );
}
