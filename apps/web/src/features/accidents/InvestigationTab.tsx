import { CircleHelp, Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { safetyRules as R, accidentsV2 as A } from '@neway/shared';
import { Button, Modal, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { accApi, useAccWrite } from './api';
import { DeptChip, Empty, Field, NInput, NSelect, NTextarea, Panel, Person, ProvTag, Restricted, ToneBadge } from './ui';

type D = A.CaseDetailResponse;

/**
 * Investigation tab (SPEC §1.4, prototype screens/CaseTabs1.tsx InvestigationTab): facts, open questions, statements,
 * contributing factors and the conclusion; submit → approve by a Safety Manager or the owner (self-approval is marked); the five
 * determinations as recorded human decisions; the evidence-reviewed checklist; corrective actions (Safety review rows).
 */
export function InvestigationTab({ d }: { d: D }) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[1.55fr_1fr]">
      <div className="flex min-w-0 flex-col gap-3">
        <InvestigationPanel d={d} />
        <CorrectiveActions d={d} />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Determinations d={d} />
        <Checklist d={d} />
      </div>
    </div>
  );
}

const STATUS = {
  not_started: { tone: 'warning', label: 'Not started' },
  in_progress: { tone: 'moving', label: 'In progress' },
  in_review: { tone: 'warning', label: 'Awaiting approval' },
  complete: { tone: 'done', label: 'Complete' },
} as const;

const LEVEL_LABEL = { possible: 'Possible', confirmed: 'Confirmed', ruled_out: 'Ruled out' } as const;
const NEXT_LEVEL = { possible: 'confirmed', confirmed: 'ruled_out', ruled_out: 'possible' } as const;

function SubHead({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 mb-1.5 flex items-center gap-2 text-xs font-bold tracking-wide text-nw-text-2 uppercase first:mt-0">{children}</div>;
}

function InvestigationPanel({ d }: { d: D }) {
  const c = d.case;
  const inv = c.investigation;
  const iv = d.computed.investigation;
  const id = c.id;
  const can = d.permissions.edit;
  const done = inv.status === 'complete';
  const name = (pid?: string | null) => d.people.find((p) => p.id === pid)?.name ?? null;
  const act = useAccWrite((a: { action: 'start' | 'submit' | 'approve' | 'send-back' | 'reopen'; note?: string; reason?: string }) => accApi.investigation(id, a.action, { version: d.version, note: a.note, reason: a.reason }), (_r, a) => ({ start: 'Investigation started', submit: 'Submitted for approval', approve: 'Investigation approved', 'send-back': 'Sent back for more work', reopen: 'Investigation reopened' })[a.action]);
  const add = useAccWrite((a: { path: string; body: Record<string, unknown> }) => accApi.post(id, a.path, { version: d.version, ...a.body }), 'Saved · recorded in the timeline');
  const resolve = useAccWrite((a: { qid: string; answer: string }) => accApi.resolveQuestion(id, a.qid, { version: d.version, answer: a.answer }), 'Question resolved');
  const level = useAccWrite((a: { fid: string; level: 'possible' | 'confirmed' | 'ruled_out' }) => accApi.factorLevel(id, a.fid, { version: d.version, level: a.level }));
  const conclude = useAccWrite((text: string) => accApi.patchInvestigation(id, { version: d.version, conclusion: text }), 'Conclusion saved');
  const [fact, setFact] = useState({ text: '', source: '', provenance: 'verified' as 'verified' | 'driver' | 'preliminary' });
  const [q, setQ] = useState({ text: '', owner: '' });
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [st, setSt] = useState({ party: '', kind: 'Witness' as (typeof A.STATEMENT_KINDS)[number], summary: '' });
  const [factor, setFactor] = useState({ category: 'Driver' as (typeof A.FACTOR_CATEGORIES)[number], label: '' });
  const [concl, setConcl] = useState(inv.conclusion ?? '');
  const [dlg, setDlg] = useState<null | 'reopen' | 'send-back'>(null);
  const [why, setWhy] = useState('');
  const missing = iv.submitMissing;
  const s = STATUS[inv.status];
  const owner = name(inv.ownerId);
  return (
    <Panel
      title="Investigation"
      id="inv-head"
      sub={<>Owner: {owner ?? 'Unassigned'}{inv.completedAt ? ` · approved by ${inv.approvedBy ?? '—'} ${R.fmtShort(inv.completedAt, undefined, nowMs())}` : ''}</>}
      actions={
        <>
          <ToneBadge tone={s.tone}>{s.label}</ToneBadge>
          {can && inv.status === 'not_started' ? <Button size="sm" variant="primary" id="inv-start" loading={act.isPending} onClick={() => act.mutate({ action: 'start' })}>Start</Button> : null}
          {can && inv.status === 'in_progress' ? (
            <Button size="sm" variant="primary" id="inv-submit" disabled={missing.length > 0} title={missing.join(', ')} loading={act.isPending} onClick={() => act.mutate({ action: 'submit' })}>Submit for approval</Button>
          ) : null}
          {inv.status === 'in_review' ? (
            d.permissions.approve ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => { setWhy(''); setDlg('send-back'); }}>Send back</Button>
                <Button size="sm" variant="primary" id="inv-approve" loading={act.isPending} onClick={() => act.mutate({ action: 'approve' })}>Approve</Button>
              </>
            ) : (
              <span className="text-xs text-nw-text-3">Approval: Safety Manager or owner</span>
            )
          ) : null}
          {can && done ? <Button size="sm" variant="secondary" onClick={() => { setWhy(''); setDlg('reopen'); }}>Reopen</Button> : null}
        </>
      }
    >
      {inv.status === 'in_progress' && missing.length > 0 ? (
        <div className="mb-3 flex items-start gap-2 rounded-md bg-nw-moving-bg px-3 py-2 text-xs text-nw-moving-text">
          <CircleHelp className="mt-0.5 size-3.5 shrink-0" aria-hidden />To submit: {missing.join(' · ')}.
        </div>
      ) : null}

      <SubHead>Facts established <span className="font-normal text-nw-text-3 normal-case">· {inv.facts.length}</span></SubHead>
      {inv.facts.length === 0 ? <p className="text-xs text-nw-text-3">No facts recorded yet.</p> : (
        <ul className="flex flex-col divide-y divide-nw-border">
          {inv.facts.map((f) => (
            <li key={f.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm text-nw-text">
              <span className="min-w-0 flex-1">{f.text}</span>
              <span className="text-xs text-nw-text-3"><ProvTag p={f.provenance} /> {f.source} · {f.by} · {R.fmtShort(f.at, undefined, nowMs())}</span>
            </li>
          ))}
        </ul>
      )}
      {can && !done ? (
        <div className="mt-2 flex flex-wrap gap-2" id="add-fact">
          <NInput className="min-w-0 flex-[2_1_14rem]" aria-label="Fact" placeholder="Add a fact (what we know)…" value={fact.text} onChange={(e) => setFact({ ...fact, text: e.target.value })} />
          <NInput className="min-w-0 flex-[1_1_9rem]" aria-label="Source" placeholder="Source (video, ECM, police…)" value={fact.source} onChange={(e) => setFact({ ...fact, source: e.target.value })} />
          <NSelect ariaLabel="How sure" value={fact.provenance} onChange={(v) => setFact({ ...fact, provenance: v as typeof fact.provenance })}>
            <option value="verified">Verified</option>
            <option value="driver">Driver-reported</option>
            <option value="preliminary">Preliminary</option>
          </NSelect>
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={fact.text.trim().length < 2} onClick={() => { add.mutate({ path: 'facts', body: { text: fact.text.trim(), source: fact.source.trim() || null, provenance: fact.provenance } }); setFact({ text: '', source: '', provenance: 'verified' }); }}>Add</Button>
        </div>
      ) : null}

      <SubHead>Open questions <span className="font-normal text-nw-text-3 normal-case">· {iv.questions.filter((x) => !x.resolvedAt).length} open</span></SubHead>
      {iv.questions.length === 0 ? <p className="text-xs text-nw-text-3">No questions.</p> : (
        <ul className="flex flex-col divide-y divide-nw-border">
          {iv.questions.map((qq) => (
            <li key={qq.id} className="flex items-start gap-2 py-1.5 text-sm">
              <span className={cn('mt-0.5 text-xs font-bold', qq.resolvedAt ? 'text-nw-done-text' : 'text-nw-warning-text')}>{qq.resolvedAt ? '✓' : '?'}</span>
              <div className="min-w-0 flex-1">
                <div className={cn(qq.resolvedAt ? 'text-nw-text-2' : 'text-nw-text')}>{qq.text}</div>
                {qq.resolvedAt ? (
                  <div className="text-xs text-nw-text-3">Answer: {qq.answer} · {qq.resolvedBy} {R.fmtShort(qq.resolvedAt, undefined, nowMs())}</div>
                ) : can && !done ? (
                  <div className="mt-1 flex flex-wrap gap-2">
                    <NInput className="min-w-0 flex-1" aria-label={`Answer to ${qq.text}`} placeholder="Answer…" value={answer[qq.id] ?? ''} onChange={(e) => setAnswer({ ...answer, [qq.id]: e.target.value })} />
                    <Button size="sm" variant="secondary" disabled={!(answer[qq.id] ?? '').trim()} onClick={() => resolve.mutate({ qid: qq.id, answer: (answer[qq.id] ?? '').trim() })}>Resolve</Button>
                  </div>
                ) : null}
              </div>
              {qq.owner && !qq.resolvedAt ? <Person name={qq.owner.name} /> : null}
            </li>
          ))}
        </ul>
      )}
      {can && !done ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <NInput className="min-w-0 flex-[2_1_14rem]" aria-label="Question" placeholder="Add an open question…" value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} />
          <NSelect ariaLabel="Question owner" value={q.owner} onChange={(v) => setQ({ ...q, owner: v })}>
            <option value="">No owner</option>
            {d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NSelect>
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={q.text.trim().length < 3} onClick={() => { add.mutate({ path: 'questions', body: { text: q.text.trim(), ownerId: q.owner || null } }); setQ({ ...q, text: '' }); }}>Add</Button>
        </div>
      ) : null}

      <SubHead>Statements</SubHead>
      {inv.statements.length === 0 ? <p className="text-xs text-nw-text-3">No statements yet.</p> : (
        <ul className="flex flex-col divide-y divide-nw-border">
          {inv.statements.map((x) => (
            <li key={x.id} className="py-1.5 text-sm text-nw-text">
              <b>{x.party}</b> ({x.kind}): {x.summary}
              <div className="text-xs text-nw-text-3">Taken {R.fmtShortDateTime(x.takenAt, c.tz, nowMs())} by {x.takenBy}</div>
            </li>
          ))}
        </ul>
      )}
      {can && !done ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <NInput className="min-w-0 flex-[1_1_9rem]" aria-label="Who gave it" placeholder="Who gave it" value={st.party} onChange={(e) => setSt({ ...st, party: e.target.value })} />
          <NSelect ariaLabel="Statement kind" value={st.kind} onChange={(v) => setSt({ ...st, kind: v as typeof st.kind })}>
            {A.STATEMENT_KINDS.map((k) => <option key={k}>{k}</option>)}
          </NSelect>
          <NInput className="min-w-0 flex-[2_1_14rem]" aria-label="Statement summary" placeholder="Summary" value={st.summary} onChange={(e) => setSt({ ...st, summary: e.target.value })} />
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={!st.party.trim() || st.summary.trim().length < 2} onClick={() => { add.mutate({ path: 'statements', body: { party: st.party.trim(), kind: st.kind, summary: st.summary.trim() } }); setSt({ party: '', kind: 'Witness', summary: '' }); }}>Add</Button>
        </div>
      ) : null}

      <SubHead>Contributing factors {can && !done ? <span className="font-normal text-nw-text-3 normal-case">· click to change confidence</span> : null}</SubHead>
      <div className="flex flex-wrap gap-1.5">
        {inv.factors.length === 0 ? <span className="text-xs text-nw-text-3">None recorded.</span> : null}
        {inv.factors.map((f) => (
          <button
            key={f.id}
            type="button"
            disabled={!can || done}
            onClick={() => level.mutate({ fid: f.id, level: NEXT_LEVEL[f.level] })}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
              f.level === 'confirmed' ? 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text' : f.level === 'ruled_out' ? 'border-nw-border bg-nw-subtle text-nw-text-3 line-through' : 'border-nw-border bg-nw-panel text-nw-text',
            )}
          >
            <span className="font-semibold text-nw-text-3 no-underline">{f.category}</span>
            {f.label}
            <span className="font-bold">{LEVEL_LABEL[f.level]}</span>
          </button>
        ))}
      </div>
      {can && !done ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <NSelect ariaLabel="Factor category" value={factor.category} onChange={(v) => setFactor({ ...factor, category: v as typeof factor.category })}>
            {A.FACTOR_CATEGORIES.map((k) => <option key={k}>{k}</option>)}
          </NSelect>
          <NInput className="min-w-0 flex-[2_1_14rem]" aria-label="Factor" placeholder="e.g. Following distance, worn brakes, work zone…" value={factor.label} onChange={(e) => setFactor({ ...factor, label: e.target.value })} />
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={factor.label.trim().length < 2} onClick={() => { add.mutate({ path: 'factors', body: { category: factor.category, label: factor.label.trim() } }); setFactor({ ...factor, label: '' }); }}>Add</Button>
        </div>
      ) : null}

      <SubHead>Conclusion</SubHead>
      {done || !can ? (
        <p className="text-sm text-nw-text">{inv.conclusion || <span className="text-nw-text-3">Not written yet.</span>}</p>
      ) : (
        <>
          <NTextarea id="conclusion" rows={3} value={concl} onChange={(e) => setConcl(e.target.value)} placeholder="What happened and why, based on the facts above." />
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="secondary" disabled={concl === (inv.conclusion ?? '')} loading={conclude.isPending} onClick={() => conclude.mutate(concl)}>Save conclusion</Button>
          </div>
        </>
      )}

      <Modal
        open={dlg !== null}
        onOpenChange={(o) => (o ? undefined : setDlg(null))}
        size="sm"
        title={dlg === 'reopen' ? 'Reopen the investigation' : 'Send back for more work'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
            <Button variant="primary" disabled={dlg === 'reopen' && why.trim().length < 3} onClick={() => { act.mutate(dlg === 'reopen' ? { action: 'reopen', reason: why.trim() } : { action: 'send-back', note: why.trim() || undefined }); setDlg(null); }}>
              {dlg === 'reopen' ? 'Reopen' : 'Send back'}
            </Button>
          </>
        }
      >
        <Field label={dlg === 'reopen' ? 'Why (required)' : 'What still needs work'} htmlFor="inv-why">
          <NTextarea id="inv-why" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
        </Field>
      </Modal>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------------------------- determinations */

const DET_HELP = 'Five separate decisions. Driver fault, company preventability, the FMCSA crash review (CPDP), legal liability and insurance liability can differ, and NeWay never fills one from another or from the accident type.';

type DetKind = 'fault' | 'preventability' | 'cpdp' | 'legal';

function Determinations({ d }: { d: D }) {
  const c = d.case;
  const det = c.determinations;
  const dot = d.computed.dotRecordable.value;
  const save = useAccWrite((a: { kind: DetKind; value: string; basis?: string | null; rdr?: string | null }) => accApi.determination(c.id, a.kind, { version: d.version, value: a.value, basis: a.basis, rdr: a.rdr }), (_r, a) => `${{ fault: 'Driver fault', preventability: 'Preventability', cpdp: 'FMCSA CPDP', legal: 'Legal liability' }[a.kind]} recorded`);
  const [basis, setBasis] = useState<Partial<Record<DetKind, string>>>({});
  const [rdr, setRdr] = useState('');
  const [showTypes, setShowTypes] = useState(false);
  const row = (k: DetKind, label: string, opts: readonly string[], labels: Record<string, string>, allowed: boolean, restricted = false) => {
    const cur = det[k] as R.Determination<string>;
    if (restricted && d.redacted.includes('determinations.legal'))
      return (
        <div className="border-b border-nw-border py-2.5 last:border-0" id={`det-${k}`}>
          <div className="mb-1 text-xs font-bold text-nw-text-2">{label}</div>
          <Restricted />
        </div>
      );
    return (
      <div className="border-b border-nw-border py-2.5 last:border-0" id={`det-${k}`}>
        <div className="mb-1 text-xs font-bold text-nw-text-2">{label}</div>
        {allowed ? (
          <div className="flex flex-col gap-1.5">
            <NSelect ariaLabel={label} value={cur.value} onChange={(v) => save.mutate({ kind: k, value: v, basis: basis[k] ?? cur.basis ?? null })}>
              {opts.map((o) => <option key={o} value={o}>{labels[o] ?? o}</option>)}
            </NSelect>
            <NInput
              aria-label={`${label} basis`}
              placeholder="Basis (evidence relied on)"
              value={basis[k] ?? cur.basis ?? ''}
              onChange={(e) => setBasis({ ...basis, [k]: e.target.value })}
              onBlur={() => { const b = basis[k]; if (b !== undefined && b !== (cur.basis ?? '')) save.mutate({ kind: k, value: cur.value, basis: b }); }}
            />
          </div>
        ) : (
          <div className="text-sm text-nw-text">{labels[cur.value] ?? cur.value}{cur.basis ? <span className="block text-xs text-nw-text-3">{cur.basis}</span> : null}</div>
        )}
        {cur.by ? <div className="mt-1 text-xs text-nw-text-3">{cur.by}{cur.at ? ` · ${R.fmtShort(cur.at, undefined, nowMs())}` : ''}</div> : null}
      </div>
    );
  };
  return (
    <Panel title="Determinations" id="determinations-edit" sub={DET_HELP}>
      {row('fault', 'Driver fault (internal)', A.FAULT_VALUES, R.FAULT_LABEL, d.permissions.determine)}
      {row('preventability', 'Preventability (company standard)', A.PREVENT_VALUES, R.PREVENT_LABEL, d.permissions.determine)}
      <div className="border-b border-nw-border py-2.5" id="det-cpdp">
        <div className="mb-1 text-xs font-bold text-nw-text-2">FMCSA Crash Preventability (CPDP)</div>
        {dot !== 'yes' ? (
          <p className="text-xs text-nw-text-3">Only crashes that are DOT-reportable can be reviewed. Current: {dot === 'no' ? 'not recordable' : 'recordability not determined'}.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {d.permissions.determine ? (
              <NSelect ariaLabel="CPDP status" value={det.cpdp.value === 'not_applicable' ? 'not_eligible' : det.cpdp.value} onChange={(v) => (v === 'submitted' && !det.cpdp.rdr ? setRdr(' ') : save.mutate({ kind: 'cpdp', value: v }))}>
                {A.CPDP_VALUES.map((o) => <option key={o} value={o}>{R.CPDP_LABEL[o]}</option>)}
              </NSelect>
            ) : (
              <div className="text-sm text-nw-text">{R.CPDP_LABEL[det.cpdp.value]}</div>
            )}
            {d.permissions.determine && (det.cpdp.value === 'eligible_not_submitted' || rdr) && det.cpdp.value !== 'submitted' ? (
              <div className="flex flex-wrap gap-2">
                <NInput className="min-w-0 flex-1" aria-label="DataQs RDR number" placeholder="DataQs RDR number" value={rdr.trim() ? rdr : ''} onChange={(e) => setRdr(e.target.value)} />
                <Button size="sm" variant="secondary" disabled={!rdr.trim()} onClick={() => { save.mutate({ kind: 'cpdp', value: 'submitted', rdr: rdr.trim() }); setRdr(''); }}>Mark submitted</Button>
              </div>
            ) : null}
            {det.cpdp.rdr ? <div className="text-xs text-nw-text-2">{det.cpdp.rdr}</div> : null}
            {det.cpdp.basis ? <div className="text-xs text-nw-text-3">{det.cpdp.basis}</div> : null}
            <Button size="sm" variant="link" className="self-start" onClick={() => setShowTypes((x) => !x)}>{showTypes ? 'Hide' : 'Show'} the {A.CPDP_ELIGIBLE_TYPES.length} eligible crash types</Button>
            {showTypes ? (
              <ol className="list-decimal pl-5 text-xs text-nw-text-2" id="cpdp-types">
                {A.CPDP_ELIGIBLE_TYPES.map((x) => <li key={x}>{x}</li>)}
              </ol>
            ) : null}
            <p className="text-xs text-nw-text-3">Submit through DataQs with the police report. FMCSA gives 14 days to answer information requests; crashes older than 5 years are not reviewed.</p>
          </div>
        )}
      </div>
      {row('legal', 'Legal liability (counsel / insurer view)', A.LEGAL_VALUES, R.LEGAL_LABEL, d.permissions.legal, true)}
      <div className="py-2.5">
        <div className="mb-1 text-xs font-bold text-nw-text-2">Insurance liability</div>
        <div className="text-xs text-nw-text-2">Decided by the insurer on each claim — see Claims &amp; costs.</div>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------------------------- checklist */

const REVIEW_LABEL = { pending: 'Pending', requested: 'Requested', reviewed: 'Reviewed', not_available: 'Not available' } as const;
const REVIEW_TONE = { pending: 'warning', requested: 'moving', reviewed: 'done', not_available: 'neutral' } as const;
const REVIEW_NEXT = { pending: 'requested', requested: 'reviewed', reviewed: 'not_available', not_available: 'pending' } as const;

function Checklist({ d }: { d: D }) {
  const id = d.case.id;
  const can = d.permissions.edit;
  const set = useAccWrite((a: { key: string; body: Omit<A.ReviewItemInput, 'version'> }) => accApi.reviewItem(id, a.key, { version: d.version, ...a.body }));
  const [label, setLabel] = useState('');
  return (
    <Panel title="Evidence reviewed" id="checklist" sub={can ? 'Click a status to move it along' : undefined} pad={false}>
      {d.computed.investigation.reviewItems.length === 0 ? <Empty title="Nothing to review yet" /> : (
        <ul className="divide-y divide-nw-border">
          {d.computed.investigation.reviewItems.map((i) => (
            <li key={i.key} className="flex items-center justify-between gap-2 px-4 py-2 text-sm text-nw-text">
              <span className="min-w-0">
                {i.label}
                {i.restricted ? <Lock className="ml-1 inline size-3 text-nw-text-3" aria-label="Restricted" /> : null}
                {i.note ? <small className="block text-xs text-nw-text-3">{i.note}</small> : null}
              </span>
              <button type="button" disabled={!can} onClick={() => set.mutate({ key: i.key, body: { state: REVIEW_NEXT[i.state] } })} aria-label={`${i.label}: ${REVIEW_LABEL[i.state]}`}>
                <ToneBadge tone={REVIEW_TONE[i.state]}>{REVIEW_LABEL[i.state]}</ToneBadge>
              </button>
            </li>
          ))}
        </ul>
      )}
      {can ? (
        <div className="flex gap-2 border-t border-nw-border px-4 py-2">
          <NInput className="min-w-0 flex-1" aria-label="Review item" placeholder="Add an item to review…" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={label.trim().length < 2} onClick={() => { set.mutate({ key: `k${nowMs().toString(36)}`, body: { label: label.trim(), state: 'pending' } }); setLabel(''); }}>Add</Button>
        </div>
      ) : null}
    </Panel>
  );
}

/* ---------------------------------------------------------------------------------------------- corrective actions */

function CorrectiveActions({ d }: { d: D }) {
  const c = d.case;
  const list = d.computed.investigation.correctiveActions;
  const canDisc = d.permissions.discipline;
  const [open, setOpen] = useState(false);
  const due0 = () => R.isoToLocalInput(R.addDays(new Date(nowMs()).toISOString(), 7), R.EASTERN).slice(0, 10);
  const [f, setF] = useState({ kind: 'Coaching' as (typeof A.CORRECTIVE_KINDS)[number], title: '', assignee: '', due: '' });
  const create = useAccWrite((body: Omit<A.CreateCorrectiveActionInput, 'version'>) => accApi.post(c.id, 'corrective-actions', { version: d.version, ...body }), 'Corrective action added — visible on the driver’s profile');
  const patch = useAccWrite((a: { id: string; body: A.PatchCorrectiveActionInput }) => accApi.patchCorrectiveAction(a.id, a.body), 'Saved');
  const dueIso = (() => {
    if (!f.due) return null;
    const r = R.localToUtc(`${f.due}T17:00`, R.EASTERN);
    return r.ok ? r.iso : null;
  })();
  return (
    <Panel
      title="Driver follow-up & corrective actions"
      id="corrective"
      sub={<>Linked to {d.display.driver ? `${d.display.driver.name}’s profile` : 'the driver'} and Safety review</>}
      pad={false}
      actions={d.permissions.edit ? <Button size="sm" variant="secondary" icon={<Plus />} id="add-ca" onClick={() => { setF({ kind: 'Coaching', title: '', assignee: d.people[0]?.id ?? '', due: due0() }); setOpen(true); }}>Add action</Button> : null}
    >
      {list.length === 0 ? (
        <Empty title="No corrective actions">Decide follow-up after the determination. Discipline is decided by an authorized person, never automatically.</Empty>
      ) : (
        <ul className="divide-y divide-nw-border">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <DeptChip dept={a.kind} />
                  <b className="text-sm text-nw-text">{a.title}</b>
                  <span className="text-xs text-nw-text-3">{a.number}</span>
                </div>
                {a.locked ? null : (
                  <div className="text-xs text-nw-text-3">
                    {a.assignee?.name ?? 'Unassigned'} · due {R.fmtShort(a.dueAt, undefined, nowMs())}
                    {a.completedAt ? ` · completed ${R.fmtShort(a.completedAt, undefined, nowMs())}` : ''}
                    {a.evidence ? ` · ${a.evidence}` : ''}
                  </div>
                )}
              </div>
              {a.locked ? (
                <ToneBadge tone="neutral">Restricted</ToneBadge>
              ) : d.permissions.edit ? (
                <NSelect ariaLabel={`Status of ${a.title}`} value={a.status} onChange={(v) => patch.mutate({ id: a.id, body: { version: a.version, status: v as (typeof A.CORRECTIVE_STATUSES)[number] } })}>
                  {A.CORRECTIVE_STATUSES.map((x) => <option key={x}>{x}</option>)}
                </NSelect>
              ) : (
                <ToneBadge tone={a.status === 'Completed' ? 'done' : a.status === 'Waived' ? 'neutral' : 'moving'}>{a.status}</ToneBadge>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={open}
        onOpenChange={(o) => (o ? undefined : setOpen(false))}
        size="md"
        title="Add corrective action"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={f.title.trim().length < 3 || !dueIso || !f.assignee || (f.kind === 'Disciplinary review' && !canDisc)}
              loading={create.isPending}
              onClick={() => { create.mutate({ kind: f.kind, title: f.title.trim(), assigneeId: f.assignee, dueAt: dueIso! }); setOpen(false); }}
            >
              Add
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Type" htmlFor="ca-kind">
            <NSelect id="ca-kind" value={f.kind} onChange={(v) => setF({ ...f, kind: v as typeof f.kind })}>
              {A.CORRECTIVE_KINDS.map((k) => <option key={k}>{k}</option>)}
            </NSelect>
          </Field>
          {f.kind === 'Disciplinary review' ? (
            canDisc ? (
              <p className="rounded-md bg-nw-moving-bg px-3 py-2 text-xs text-nw-moving-text">A disciplinary review is a decision for an authorized manager. NeWay records the decision and who made it; it never decides it.</p>
            ) : (
              <p className="rounded-md bg-nw-subtle px-3 py-2 text-xs text-nw-text-2"><Restricted text="Disciplinary reviews are recorded by the Safety Manager and the owner" /></p>
            )
          ) : null}
          <Field label="What exactly" htmlFor="ca-title">
            <NInput id="ca-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Following-distance coaching with video review" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Assigned to" htmlFor="ca-assignee">
              <NSelect id="ca-assignee" value={f.assignee} onChange={(v) => setF({ ...f, assignee: v })}>
                {d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NSelect>
            </Field>
            <Field label="Due" htmlFor="ca-due" hint="Eastern time">
              <NInput id="ca-due" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
            </Field>
          </div>
        </div>
      </Modal>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------------------------- parties (Incident tab) */

/** Other vehicles and witnesses (prototype CaseTabs1 Parties). Witness contacts are restricted. */
export function PartiesPanel({ d }: { d: D }) {
  const c = d.case;
  const iv = d.computed.investigation;
  const can = d.permissions.edit;
  const [dlg, setDlg] = useState<null | 'vehicle' | 'witness'>(null);
  const [v, setV] = useState({ description: '', ownerName: '', driverName: '', insurer: '', damage: '', towed: '' });
  const [w, setW] = useState({ name: '', contact: '', note: '' });
  const add = useAccWrite((a: { path: 'vehicles' | 'witnesses'; body: Record<string, unknown> }) => accApi.post(c.id, a.path, { version: d.version, ...a.body }), (_r, a) => (a.path === 'vehicles' ? 'Vehicle added' : 'Witness added'));
  const opt = (s: string) => s.trim() || null;
  return (
    <Panel title="Other parties" id="parties" pad={false}>
      <div className="flex items-center justify-between px-4 pt-3 text-xs font-bold tracking-wide text-nw-text-2 uppercase">
        Other vehicles
        {can ? <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => { setV({ description: '', ownerName: '', driverName: '', insurer: '', damage: '', towed: '' }); setDlg('vehicle'); }}>Add</Button> : null}
      </div>
      {iv.vehicles.length === 0 ? <p className="px-4 pb-2 text-xs text-nw-text-3">No other vehicles recorded.</p> : (
        <ul className="divide-y divide-nw-border">
          {iv.vehicles.map((x) => (
            <li key={x.id} className="px-4 py-2 text-sm text-nw-text">
              <b>{x.description}</b>{x.ownerName ? ` · ${x.ownerName}` : ''}{x.driverName ? ` · driver ${x.driverName}` : ''}
              <div className="text-xs text-nw-text-3">{[x.damage, x.towed === 'yes' ? 'towed' : null, x.insurer ? `insurer: ${x.insurer}` : null, x.plate].filter(Boolean).join(' · ') || 'No details'}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between border-t border-nw-border px-4 pt-3 text-xs font-bold tracking-wide text-nw-text-2 uppercase">
        Witnesses
        {can ? <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => { setW({ name: '', contact: '', note: '' }); setDlg('witness'); }}>Add</Button> : null}
      </div>
      {iv.witnesses.length === 0 ? <p className="px-4 pb-3 text-xs text-nw-text-3">No witnesses recorded.</p> : (
        <ul className="divide-y divide-nw-border">
          {iv.witnesses.map((x) => (
            <li key={x.id} className="px-4 py-2 text-sm text-nw-text">
              <b>{x.name}</b>{x.note ? ` — ${x.note}` : ''}
              <div className="text-xs text-nw-text-3">Contact: {x.contact === null ? <Restricted text="restricted" /> : x.contact || 'not recorded'}</div>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={dlg === 'vehicle'}
        onOpenChange={(o) => (o ? undefined : setDlg(null))}
        size="md"
        title="Add another vehicle"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
            <Button variant="primary" disabled={v.description.trim().length < 2} onClick={() => { add.mutate({ path: 'vehicles', body: { description: v.description.trim(), ownerName: opt(v.ownerName), driverName: opt(v.driverName), insurer: opt(v.insurer), damage: opt(v.damage), towed: v.towed || null } }); setDlg(null); }}>Add vehicle</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Vehicle" htmlFor="v-desc"><NInput id="v-desc" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="Year, type, color" /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Owner" htmlFor="v-owner"><NInput id="v-owner" value={v.ownerName} onChange={(e) => setV({ ...v, ownerName: e.target.value })} /></Field>
            <Field label="Driver" htmlFor="v-driver"><NInput id="v-driver" value={v.driverName} onChange={(e) => setV({ ...v, driverName: e.target.value })} /></Field>
            <Field label="Insurer" htmlFor="v-ins"><NInput id="v-ins" value={v.insurer} onChange={(e) => setV({ ...v, insurer: e.target.value })} /></Field>
            <Field label="Towed from scene?" htmlFor="v-towed">
              <NSelect id="v-towed" value={v.towed} onChange={(x) => setV({ ...v, towed: x })}>
                <option value="">Not reported</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
                <option value="unknown">Unknown</option>
              </NSelect>
            </Field>
          </div>
          <Field label="Damage" htmlFor="v-damage"><NInput id="v-damage" value={v.damage} onChange={(e) => setV({ ...v, damage: e.target.value })} /></Field>
        </div>
      </Modal>
      <Modal
        open={dlg === 'witness'}
        onOpenChange={(o) => (o ? undefined : setDlg(null))}
        size="sm"
        title="Add a witness"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
            <Button variant="primary" disabled={!w.name.trim()} onClick={() => { add.mutate({ path: 'witnesses', body: { name: w.name.trim(), contact: opt(w.contact), note: opt(w.note) } }); setDlg(null); }}>Add witness</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor="w-name"><NInput id="w-name" value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} /></Field>
          <Field label="Contact (restricted)" htmlFor="w-contact"><NInput id="w-contact" value={w.contact} onChange={(e) => setW({ ...w, contact: e.target.value })} /></Field>
          <Field label="What they saw" htmlFor="w-note"><NInput id="w-note" value={w.note} onChange={(e) => setW({ ...w, note: e.target.value })} /></Field>
        </div>
      </Modal>
    </Panel>
  );
}
