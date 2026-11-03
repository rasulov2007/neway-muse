import { Archive, FileText, Film, Image as ImageIcon, Lock, Upload } from 'lucide-react';
import { useState } from 'react';
import { safetyRules as R, accidentsV2 as A } from '@neway/shared';
import { Button, Drawer, Modal, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { openFile, uploadFile } from '@/lib/files';
import { accApi, problemText, useAccWrite, useCaseEvents, useEvidence } from './api';
import { CheckLine } from './AccidentsBoardPage';
import { Empty, Field, KV, LoadError, Loading, NInput, NSelect, Panel, Restricted } from './ui';

type D = A.CaseDetailResponse;

/**
 * Evidence & documents (SPEC §1.4 / §8.3, prototype screens/CaseTabs2.tsx EvidenceTab): what the case should have,
 * category chips, cards (lock cards for restricted documents the viewer may not see), upload with a category, a drawer
 * with versions, a new version, removal with a reason (never deleted) and the audit history. Under a legal hold nothing
 * can be removed — the server refuses it and so does the database.
 */
export function EvidenceTab({ d }: { d: D }) {
  const id = d.case.id;
  const [cat, setCat] = useState('all');
  const [showRemoved, setShowRemoved] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<File[] | null>(null);
  const q = useEvidence(id, showRemoved);
  const canUpload = d.permissions.edit || d.permissions.editUnits || d.permissions.bills || d.permissions.claimMoney;
  const items = q.data?.items ?? [];
  const visible = items.filter((e) => cat === 'all' || e.category === cat);
  const counts = A.EVIDENCE_CATEGORIES.map((k) => [k, items.filter((e) => e.category === k && !e.removed).length] as const).filter(([, n]) => n > 0);
  const hold = q.data?.legalHold ?? null;
  const current = sel ? items.find((x) => x.id === sel) : undefined;
  return (
    <div className="mt-3 flex flex-col gap-3">
      <Panel title="What this case should have" id="expected-evidence" sub="Based on the facts — e.g. a police report when police responded">
        <div className="flex flex-wrap gap-2">
          {d.computed.expectedEvidence.map((e) => <span key={e.label} title={e.why}><CheckLine ok={e.ok}>{e.label}</CheckLine></span>)}
        </div>
      </Panel>
      <Panel
        title="Evidence & documents"
        id="evidence"
        pad={false}
        actions={
          <>
            <label className="inline-flex items-center gap-1.5 text-xs text-nw-text-2">
              <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
              Show removed
            </label>
            {canUpload ? (
              <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-nw-accent px-3 text-sm font-semibold text-nw-on-accent hover:bg-nw-accent-hover" id="upload-evidence">
                <Upload className="size-4" aria-hidden />
                Upload
                <input
                  type="file"
                  multiple
                  hidden
                  accept="image/*,video/*,application/pdf,.doc,.docx"
                  onChange={(e) => {
                    const fl = e.target.files;
                    if (fl?.length) setPicked(Array.from(fl));
                    e.target.value = '';
                  }}
                />
              </label>
            ) : null}
          </>
        }
      >
        <div className="flex flex-wrap gap-1.5 px-4 pt-3">
          <Chip active={cat === 'all'} onClick={() => setCat('all')} count={items.filter((x) => !x.removed).length}>All</Chip>
          {counts.map(([k, n]) => <Chip key={k} active={cat === k} onClick={() => setCat(k)} count={n}>{k}</Chip>)}
        </div>
        {hold ? (
          <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-nw-warning-border bg-nw-warning-bg px-3 py-2 text-xs text-nw-warning-text" id="legal-hold">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>Legal hold since {R.fmtShort(hold.since, undefined, nowMs())}: {hold.reason}. Nothing on this case can be removed.</span>
          </div>
        ) : null}
        {q.isLoading ? <Loading /> : q.error ? <div className="p-4"><LoadError error={q.error} /></div> : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-4">
            {visible.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setSel(x.id)}
                data-ev={x.name ?? 'restricted'}
                className={cn('flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-nw-border bg-nw-panel text-left hover:bg-nw-hover', x.removed && 'opacity-60')}
              >
                <div className="relative flex h-24 items-center justify-center bg-nw-subtle text-nw-text-3">
                  {x.locked ? (
                    <span className="flex flex-col items-center gap-1 text-xs font-semibold"><Lock className="size-5" aria-hidden />Restricted</span>
                  ) : (
                    <KindIcon kind={x.kind} />
                  )}
                  {x.version > 1 ? <span className="absolute top-1.5 right-1.5 rounded-[5px] bg-nw-panel px-1.5 text-[11px] font-bold text-nw-text-2">v{x.version}</span> : null}
                </div>
                <div className="px-2.5 py-2">
                  <div className="truncate text-sm font-semibold text-nw-text" title={x.name ?? undefined}>{x.locked ? 'Restricted document' : x.name}</div>
                  <div className="truncate text-xs text-nw-text-3">{x.category}{x.removed ? ' · removed' : ''}</div>
                  <div className="truncate text-xs text-nw-text-3">{x.locked ? '' : `${x.uploadedBy ?? '—'} · `}{R.fmtShort(x.uploadedAt, undefined, nowMs())}</div>
                </div>
              </button>
            ))}
            {visible.length === 0 ? <div className="col-span-full"><Empty title="Nothing in this category" /></div> : null}
          </div>
        )}
      </Panel>
      {picked ? <UploadDialog d={d} files={picked} onClose={() => setPicked(null)} /> : null}
      {current ? <EvidenceDrawer d={d} e={current} legalHold={Boolean(hold)} onClose={() => setSel(null)} /> : null}
    </div>
  );
}

function KindIcon({ kind }: { kind: A.EvidenceItem['kind'] }) {
  const I = kind === 'photo' ? ImageIcon : kind === 'video' ? Film : FileText;
  return <I className="size-7" aria-hidden />;
}

function Chip({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold', active ? 'border-nw-accent bg-nw-accent-tint text-nw-accent-ink' : 'border-nw-border bg-nw-panel text-nw-text-2 hover:bg-nw-hover')}
    >
      {children}
      <span className="text-nw-text-3">{count}</span>
    </button>
  );
}

function UploadDialog({ d, files, onClose }: { d: D; files: File[]; onClose: () => void }) {
  const guess = files[0]?.type.startsWith('video') ? 'Dashcam / video' : files[0]?.type.startsWith('image') ? 'Damage photo' : 'Other';
  const [category, setCategory] = useState<(typeof A.EVIDENCE_CATEGORIES)[number]>(guess);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = useAccWrite((body: Omit<A.UploadEvidenceInput, 'version'>) => accApi.uploadEvidence(d.case.id, { version: d.version, ...body }), (r) => `${R.plural(r.ids.length, 'file')} uploaded · logged in the timeline`);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const stored = [];
      for (const f of files) stored.push({ fileId: (await uploadFile(f)).id });
      await write.mutateAsync({ files: stored, category, description: description.trim() || null });
      onClose();
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="md"
      title={`Upload ${R.plural(files.length, 'file')}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" id="confirm-upload" loading={busy} onClick={() => void go()}>Upload</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 text-sm text-nw-text">
          {files.map((f) => <li key={f.name}>{f.name} <span className="text-xs text-nw-text-3">· {Math.max(1, Math.round(f.size / 1024)).toLocaleString('en-US')} KB</span></li>)}
        </ul>
        <Field label="Category" htmlFor="ev-cat" hint={A.RESTRICTED_EVIDENCE.includes(category as (typeof A.RESTRICTED_EVIDENCE)[number]) ? 'Restricted — Safety Manager and owner only' : undefined}>
          <NSelect id="ev-cat" value={category} onChange={(v) => setCategory(v as typeof category)}>
            {A.EVIDENCE_CATEGORIES.filter((k) => d.permissions.restricted || !A.RESTRICTED_EVIDENCE.includes(k as (typeof A.RESTRICTED_EVIDENCE)[number])).map((k) => <option key={k}>{k}</option>)}
          </NSelect>
        </Field>
        <Field label="Description" htmlFor="ev-desc">
          <NInput id="ev-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {error ? <p className="text-xs text-nw-urgent-text">{error}</p> : null}
      </div>
    </Modal>
  );
}

function EvidenceDrawer({ d, e, legalHold, onClose }: { d: D; e: A.EvidenceItem; legalHold: boolean; onClose: () => void }) {
  const events = useCaseEvents(d.case.id);
  const [mode, setMode] = useState<null | 'version' | 'remove'>(null);
  const [txt, setTxt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const removeW = useAccWrite((reason: string) => accApi.removeEvidence(e.id, { reason }), 'Removed from view · retained in audit');
  const versionW = useAccWrite((body: A.EvidenceVersionInput) => accApi.evidenceVersion(e.id, body), 'New version saved — earlier versions kept');
  const open = async (v?: number) => {
    const r = await accApi.evidenceDownload(e.id, v);
    openFile({ fileId: r.fileId, fileName: r.fileName, mimeType: r.contentType });
  };
  const saveVersion = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const stored = await uploadFile(file);
      await versionW.mutateAsync({ fileId: stored.id, note: txt.trim() });
      setMode(null);
    } finally {
      setBusy(false);
    }
  };
  const hist = e.name ? (events.data ?? []).filter((v) => v.text.includes(e.name!) || v.text.includes(e.category)) : [];
  const canEdit = d.permissions.edit || d.permissions.editUnits || d.permissions.bills || d.permissions.claimMoney;
  return (
    <Drawer open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title={e.locked ? 'Restricted document' : e.name} description={`${e.category} · ${e.kind.toUpperCase()}${e.sizeKb !== null ? ` · ${e.sizeKb.toLocaleString('en-US')} KB` : ''}`}>
      {e.locked ? (
        <div className="flex flex-col gap-2" id="evidence-drawer">
          <Restricted text="This document is restricted" />
          <p className="text-xs text-nw-text-3">Only the Safety Manager and the owner can open {e.category.replace(' (restricted)', '').toLowerCase()} documents.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3" id="evidence-drawer">
          <div className="nw-paper flex h-40 items-center justify-center rounded-[10px] border border-nw-border">
            <Button variant="secondary" onClick={() => void open()}>Open file</Button>
          </div>
          {e.removed ? (
            <div className="flex items-start gap-2 rounded-md bg-nw-subtle px-3 py-2 text-xs text-nw-text-2">
              <Archive className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Removed from the case view by {e.removed.by ?? '—'} on {R.fmtShort(e.removed.at, undefined, nowMs())}: “{e.removed.reason}”. The file is retained in the audit archive.
            </div>
          ) : null}
          <dl>
            <KV k="Description">{e.description || <span className="text-nw-text-3">None</span>}</KV>
            <KV k="Uploaded">{e.uploadedBy ?? '—'} · {R.fmtShortDateTime(e.uploadedAt, R.EASTERN, nowMs())}</KV>
            <KV k="Access">{e.restricted ? 'Restricted — Safety Manager and owner' : 'Everyone with case access'}</KV>
          </dl>
          <div className="text-xs font-bold tracking-wide text-nw-text-2 uppercase">Versions</div>
          <ul className="flex flex-col divide-y divide-nw-border rounded-[10px] border border-nw-border">
            {(e.versions ?? []).map((v) => (
              <li key={v.v} className="flex flex-wrap items-baseline gap-x-2 px-3 py-2 text-sm">
                <b>v{v.v}</b>
                <span className="min-w-0 flex-1 text-nw-text">{v.note ?? v.fileName}</span>
                <span className="text-xs text-nw-text-3">{v.by} · {R.fmtShortDateTime(v.at, R.EASTERN, nowMs())}</span>
                {v.sha256 ? <span className="w-full truncate font-mono text-[11px] text-nw-text-3" title={v.sha256}>SHA-256 {v.sha256}</span> : null}
                <Button size="sm" variant="link" onClick={() => void open(v.v)}>Open</Button>
              </li>
            ))}
          </ul>
          {canEdit && !e.removed && mode === null ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<Upload />} onClick={() => { setMode('version'); setTxt(''); setFile(null); }}>Upload new version</Button>
              {d.permissions.edit ? (
                <Button size="sm" variant="ghost" icon={<Archive />} id="remove-evidence" disabled={legalHold} title={legalHold ? 'Legal hold is on' : undefined} onClick={() => { setMode('remove'); setTxt(''); }}>Remove from case</Button>
              ) : null}
            </div>
          ) : null}
          {mode === 'version' ? (
            <div className="flex flex-col gap-2 rounded-[10px] border border-nw-border p-3">
              <Field label="File" htmlFor="ev-file"><input id="ev-file" type="file" className="text-sm" onChange={(x) => setFile(x.target.files?.[0] ?? null)} /></Field>
              <Field label="What changed" htmlFor="ev-note"><NInput id="ev-note" value={txt} onChange={(x) => setTxt(x.target.value)} placeholder="e.g. Revised estimate after teardown" /></Field>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setMode(null)}>Cancel</Button>
                <Button size="sm" variant="primary" disabled={!file || txt.trim().length < 2} loading={busy} onClick={() => void saveVersion()}>Save version</Button>
              </div>
            </div>
          ) : null}
          {mode === 'remove' ? (
            <div className="flex flex-col gap-2 rounded-[10px] border border-nw-border p-3">
              <p className="text-xs text-nw-text-2">Evidence is never deleted. Removing hides it from the case view; the file and this action stay in the audit history.</p>
              <Field label="Reason (required)" htmlFor="remove-reason"><NInput id="remove-reason" value={txt} onChange={(x) => setTxt(x.target.value)} placeholder="e.g. Uploaded to the wrong case" /></Field>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setMode(null)}>Cancel</Button>
                <Button size="sm" variant="danger" id="confirm-remove" disabled={txt.trim().length < 3} loading={removeW.isPending} onClick={() => { removeW.mutate(txt.trim(), { onSuccess: onClose }); }}>Remove</Button>
              </div>
            </div>
          ) : null}
          <div className="text-xs font-bold tracking-wide text-nw-text-2 uppercase">Audit history</div>
          <ul className="flex flex-col gap-1.5">
            {hist.length === 0 ? <li className="text-xs text-nw-text-3">Uploaded with the case.</li> : hist.map((v) => (
              <li key={v.id} className="text-xs text-nw-text-2">
                <span className="text-nw-text-3">{R.fmtShortDateTime(v.loggedAt, R.EASTERN, nowMs())}</span> · {v.text} <span className="text-nw-text-3">· {v.actorName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );
}
