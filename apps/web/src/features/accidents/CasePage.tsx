import { ArrowLeft, Check, ClipboardList, Lock, MoreHorizontal, Package, Pencil, Shield, Truck, User } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, DropdownMenu, MenuItem, Modal, Tabs, TabsContent, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { accApi, useAccWrite, useCase, useCaseTasks } from './api';
import { ClaimsCostsTab } from './CaseClaimsTab';
import { IncidentTab, OverviewTab, TasksTimelineTab } from './CaseTabs';
import { EvidenceTab } from './EvidenceTab';
import { InvestigationTab } from './InvestigationTab';
import { EquipmentTab } from './EquipmentTab';
import { FinancialImpact } from './FinancialImpact';
import { ReportModal } from './ReportModal';
import { Field, LoadError, Loading, NSelect, NTextarea, Panel, Person, SevBadge, ToneBadge } from './ui';

/**
 * Accident case page (SPEC §1.4, prototype screens/Case.tsx) — behind `accidents_v2`. Header, stage bar with the
 * server's gates (override only with accidents.override), next action, and the seven tabs. P1 fills Overview,
 * Incident and Tasks & timeline; Equipment shows units, downtime and Dispatch requests; P2 adds Claims & costs (claims),
 * Investigation and Evidence (P4) say what arrives with their phase.
 */
export function CasePage({ accidentId }: { accidentId: string }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const q = useCase(accidentId);
  const [tab, setTab] = useState(search.tab ?? 'overview');
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <LoadError error={q.error ?? new Error('Not found')} />;
  const d = q.data;
  const c = d.case;
  if (c.stage === 'draft') return <DraftView d={d} />;
  const dot = d.computed.dotRecordable;
  const open = d.computed.openTasks;
  const missing = d.computed.expectedEvidence.filter((x) => !x.ok).length;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <button type="button" onClick={() => void navigate({ to: '/safety/accidents' })} className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-nw-text-2 hover:text-nw-text">
          <ArrowLeft className="size-3.5" aria-hidden />
          Accidents
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[22px] font-extrabold tracking-[-.022em] text-nw-text">{c.number}</h1>
          <SevBadge sev={c.severity} />
          {c.legalHold ? <ToneBadge tone="warning" title={c.legalHold.reason}>Legal hold</ToneBadge> : null}
          {dot.value === 'yes' ? <ToneBadge tone="neutral" title="Included in the DOT accident register">DOT recordable</ToneBadge> : null}
          {c.isTest ? <ToneBadge tone="neutral">Test data</ToneBadge> : null}
          <span className="flex-1" />
          <Button size="sm" variant="secondary" icon={<Pencil />} onClick={() => setTab('incident')}>
            Edit facts
          </Button>
          <CaseMenu d={d} />
        </div>
        <div className="text-sm text-nw-text-2">
          {c.type} · {[c.location.road, c.location.detail].filter(Boolean).join(' ')}
          {c.location.road ? ', ' : ''}
          {c.location.city}, {c.location.state} ·{' '}
          <b className="text-nw-text">
            {R.fmtDate(c.occurredAt, c.tz)}, {R.fmtTime(c.occurredAt, c.tz)}
          </b>
          {c.tz !== R.EASTERN ? <span className="text-nw-text-3"> ({R.fmtTime(c.occurredAt, R.EASTERN)})</span> : null}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {d.display.truck ? <Ent icon={<Truck className="size-3.5" />}>Truck {d.display.truck.unit}</Ent> : null}
          {d.display.trailer ? <Ent icon={<Truck className="size-3.5" />}>Trailer {d.display.trailer.unit}</Ent> : null}
          {d.display.driver ? <Ent icon={<User className="size-3.5" />}>{d.display.driver.name}</Ent> : null}
          {d.display.load ? (
            <Ent icon={<Package className="size-3.5" />}>
              Load {d.display.load.number}
              {d.display.load.customer ? <span className="text-nw-text-3"> · {d.display.load.customer}</span> : null}
            </Ent>
          ) : null}
          <Ent icon={<Shield className="size-3.5" />}>
            Case owner <Person name={d.display.owner?.name} />
          </Ent>
        </div>
      </div>
      <StageBar d={d} onTab={setTab} />
      <NextActionBar d={d} onTab={setTab} />
      <Tabs
        value={tab}
        onValueChange={setTab}
        aria-label="Case"
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'incident', label: 'Incident' },
          { value: 'investigation', label: 'Investigation' },
          { value: 'equipment', label: 'Equipment & cargo' },
          { value: 'claims', label: 'Claims & costs', count: d.computed.claims.length || undefined },
          { value: 'evidence', label: missing ? `Evidence · ${missing} missing` : 'Evidence', count: d.computed.evidenceCount },
          { value: 'tasks', label: d.computed.overdueTasks ? `Tasks & timeline · ${d.computed.overdueTasks} overdue` : 'Tasks & timeline', count: open || undefined },
        ]}
      >
        <TabsContent value="overview"><OverviewTab d={d} onTab={setTab} /></TabsContent>
        <TabsContent value="incident"><IncidentTab d={d} /></TabsContent>
        <TabsContent value="investigation"><InvestigationTab d={d} /></TabsContent>
        <TabsContent value="equipment"><EquipmentTab d={d} /></TabsContent>
        <TabsContent value="claims"><ClaimsCostsTab d={d} financial={<FinancialImpact d={d} />} /></TabsContent>
        <TabsContent value="evidence"><EvidenceTab d={d} /></TabsContent>
        <TabsContent value="tasks"><TasksTimelineTab d={d} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Ent({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-md border border-nw-border bg-nw-panel px-2 py-1 font-semibold text-nw-text">{icon}{children}</span>;
}

function DraftView({ d }: { d: A.CaseDetailResponse }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={() => void navigate({ to: '/safety/accidents' })} className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-nw-text-2">
        <ArrowLeft className="size-3.5" aria-hidden />
        Accidents
      </button>
      <Panel title={`${d.case.number} is a draft`}>
        <p className="mb-3 text-sm text-nw-text-2">
          Drafts are not sent to other departments and create no tasks until they are submitted. Started {R.ago(d.case.createdAt, nowMs())} by {d.display.reportedBy}.
        </p>
        <Button variant="primary" icon={<Pencil />} onClick={() => setOpen(true)} id="finish-draft">
          Finish and submit
        </Button>
      </Panel>
      {open ? <ReportModal draft={d} onClose={() => setOpen(false)} onCreated={() => setOpen(false)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ stage bar with the server's gates */
function StageBar({ d, onTab }: { d: A.CaseDetailResponse; onTab: (t: string) => void }) {
  const c = d.case;
  const [dlg, setDlg] = useState<null | 'advance' | 'close' | 'reopen'>(null);
  const [override, setOverride] = useState('');
  const [outcome, setOutcome] = useState('');
  const [prevention, setPrevention] = useState('');
  const idx = R.STAGES.indexOf(c.stage);
  const next = R.STAGES[idx + 1];
  const blockers = c.stage === 'resolution' ? d.computed.closeBlockers : d.computed.advanceBlockers;
  const canOverride = d.permissions.override;
  const move = useAccWrite(
    () =>
      accApi.post(c.id, 'stage', {
        version: d.version,
        to: next,
        ...(blockers.length ? { overrideReason: override.trim() } : {}),
        ...(next === 'closed' ? { outcome: outcome.trim(), prevention: prevention.trim() } : {}),
      }),
    () => (next === 'closed' ? `${c.number} closed` : `${c.number} moved to ${next ? R.STAGE_LABEL[next] : ''}`),
  );
  const reopen = useAccWrite(() => accApi.post(c.id, 'reopen', { version: d.version, reason: override.trim() }), `${c.number} reopened`);
  const done = () => {
    setDlg(null);
    setOverride('');
    setOutcome('');
    setPrevention('');
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-nw-border bg-nw-panel px-4 py-2.5" id="stagebar">
      <ol className="flex flex-wrap items-center gap-3 text-sm">
        {R.STAGES.map((st, i) => (
          <li key={st} className={cn('inline-flex items-center gap-1.5 font-semibold', i < idx ? 'text-nw-done-text' : i === idx ? 'text-nw-text' : 'text-nw-text-3')}>
            <span className={cn('inline-flex size-5 items-center justify-center rounded-full text-xs', i < idx ? 'bg-nw-done-bg' : i === idx ? 'bg-nw-accent text-nw-on-accent' : 'bg-nw-subtle')}>
              {i < idx ? <Check className="size-3" aria-hidden /> : i + 1}
            </span>
            {R.STAGE_LABEL[st]}
            {i === idx ? <span className="sr-only"> (current)</span> : null}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {c.stage !== 'closed' && next ? (
          <>
            {blockers.length ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-nw-warning-text"><Lock className="size-3.5" aria-hidden />{R.plural(blockers.length, 'item')} before {R.STAGE_LABEL[next].toLowerCase()}</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-nw-done-text"><Check className="size-3.5" aria-hidden />Ready for {R.STAGE_LABEL[next].toLowerCase()}</span>
            )}
            {d.permissions.edit ? (
              <Button size="sm" variant={blockers.length ? 'secondary' : 'primary'} onClick={() => setDlg(next === 'closed' ? 'close' : 'advance')} id="advance-stage">
                {next === 'closed' ? 'Close case' : `Move to ${R.STAGE_LABEL[next]}`}
              </Button>
            ) : null}
          </>
        ) : null}
        {c.stage === 'closed' ? (
          <>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-nw-done-text">
              <Check className="size-3.5" aria-hidden />
              Closed {R.fmtShort(c.closure?.at, R.EASTERN, nowMs())} by {d.display.closedBy}
            </span>
            {d.permissions.edit ? <Button size="sm" variant="secondary" onClick={() => setDlg('reopen')}>Reopen</Button> : null}
          </>
        ) : null}
      </div>
      <Modal
        open={dlg === 'advance' || dlg === 'close'}
        onOpenChange={(o) => (o ? undefined : setDlg(null))}
        title={dlg === 'close' ? `Close ${c.number}?` : `Move ${c.number} to ${next ? R.STAGE_LABEL[next] : ''}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={move.isPending}
              disabled={(blockers.length > 0 && (!canOverride || !override.trim())) || (dlg === 'close' && !outcome.trim())}
              onClick={() => move.mutate(undefined, { onSuccess: done })}
              id="confirm-stage"
            >
              {dlg === 'close' ? (blockers.length ? 'Close with override' : 'Close case') : blockers.length ? 'Move with override' : 'Move forward'}
            </Button>
          </>
        }
      >
        {blockers.length === 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-nw-done-text"><Check className="size-4" aria-hidden />All conditions are met.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-nw-text-2">These conditions are not met yet:</p>
            <ul className="flex flex-col gap-1.5">
              {blockers.map((b) => (
                <li key={b.text} className="flex items-center gap-2 text-sm text-nw-text">
                  <ToneBadge tone="warning">Open</ToneBadge>
                  <span className="flex-1">{b.text}</span>
                  {b.tab ? <Button size="sm" variant="link" onClick={() => { setDlg(null); onTab(b.tab!); }}>Go to it</Button> : null}
                </li>
              ))}
            </ul>
            {canOverride ? (
              <Field label="Override reason (required, saved to the audit history)" htmlFor="override">
                <NTextarea id="override" rows={2} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Why it is acceptable to proceed with these open items" />
              </Field>
            ) : (
              <p className="flex items-center gap-1 text-xs font-semibold text-nw-text-3"><Lock className="size-3.5" aria-hidden />Overriding stage conditions is restricted to the Safety Manager and the Owner.</p>
            )}
          </div>
        )}
        {dlg === 'close' ? (
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-xs text-nw-text-3">Claims have their own lifecycle on the Claims board and never block closing the accident.</p>
            <Field label="Final outcome (shown at the top of the case)" required htmlFor="outcome">
              <NTextarea id="outcome" rows={2} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="e.g. Investigation complete (non-preventable); tractor repaired; PD claim settled." />
            </Field>
            <Field label="What we did to prevent a repeat" htmlFor="prevention">
              <NTextarea id="prevention" rows={2} value={prevention} onChange={(e) => setPrevention(e.target.value)} placeholder="e.g. Coaching completed; route added to the hazard list." />
            </Field>
          </div>
        ) : null}
      </Modal>
      <Modal
        open={dlg === 'reopen'}
        onOpenChange={(o) => (o ? undefined : setDlg(null))}
        size="sm"
        title={`Reopen ${c.number}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
            <Button variant="primary" disabled={override.trim().length < 3} loading={reopen.isPending} onClick={() => reopen.mutate(undefined, { onSuccess: done })}>Reopen</Button>
          </>
        }
      >
        <Field label="Reason" required htmlFor="reopen-reason">
          <NTextarea id="reopen-reason" rows={2} value={override} onChange={(e) => setOverride(e.target.value)} />
        </Field>
      </Modal>
    </div>
  );
}

function NextActionBar({ d, onTab }: { d: A.CaseDetailResponse; onTab: (t: string) => void }) {
  const c = d.case;
  const na = d.computed.nextAction;
  const [reassign, setReassign] = useState(false);
  const [who, setWho] = useState('');
  const tasks = useCaseTasks(c.id);
  const version = tasks.data?.find((t) => t.id === na?.taskId)?.version;
  const complete = useAccWrite(() => accApi.patchTask(na!.taskId, { version: version ?? 1, status: 'done' }), `Done: ${na?.title ?? ''}`);
  const move = useAccWrite(() => accApi.patchTask(na!.taskId, { version: version ?? 1, assigneeId: who }), 'Reassigned');
  if (c.stage === 'closed') {
    return (
      <div className="flex items-start gap-3 rounded-[10px] border border-nw-done-border bg-nw-done-bg px-4 py-3" id="nextbar">
        <Check className="mt-0.5 size-4 text-nw-done-icon" aria-hidden />
        <div>
          <div className="text-xs font-bold tracking-wide text-nw-done-text uppercase">Final outcome</div>
          <div className="text-sm font-semibold text-nw-text">{c.closure?.outcome}</div>
          {c.closure?.prevention ? <div className="text-sm text-nw-text-2"><b>Prevention:</b> {c.closure.prevention}</div> : null}
        </div>
      </div>
    );
  }
  if (!na) {
    return (
      <div className="flex items-center gap-3 rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3" id="nextbar">
        <ClipboardList className="size-4 text-nw-text-3" aria-hidden />
        <div className="flex-1 text-sm text-nw-text-2">No open tasks. Add one, or move the case forward.</div>
        <Button size="sm" variant="secondary" onClick={() => onTab('tasks')}>Add task</Button>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-3 rounded-[10px] border px-4 py-3', na.overdue ? 'border-nw-urgent-border bg-nw-urgent-bg' : 'border-nw-border bg-nw-panel')} id="nextbar">
      <ClipboardList className="size-4 text-nw-text-3" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold tracking-wide text-nw-text-3 uppercase">Next action · waiting on {na.dept}</div>
        <div className="text-sm font-semibold text-nw-text">{na.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
          <Person name={na.assignee?.name} />
          <span className={cn('font-semibold', na.overdue ? 'text-nw-urgent-text' : 'text-nw-text-3')}>{R.dueLabel(na.dueAt, c.tz, nowMs()).text}</span>
          {na.moreOpen > 0 ? <Button size="sm" variant="link" onClick={() => onTab('tasks')}>+{na.moreOpen} more open</Button> : null}
        </div>
      </div>
      {d.permissions.edit ? (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setReassign(true)}>Reassign</Button>
          <Button size="sm" variant="primary" icon={<Check />} loading={complete.isPending} disabled={version === undefined} onClick={() => complete.mutate(undefined)} id="next-done">Mark complete</Button>
        </div>
      ) : null}
      <Modal
        open={reassign}
        onOpenChange={setReassign}
        size="sm"
        title="Reassign next action"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReassign(false)}>Cancel</Button>
            <Button variant="primary" disabled={!who || version === undefined} loading={move.isPending} onClick={() => move.mutate(undefined, { onSuccess: () => setReassign(false) })}>Reassign</Button>
          </>
        }
      >
        <Field label="Person" htmlFor="ra-person">
          <NSelect id="ra-person" value={who} onChange={setWho}>
            <option value="">Pick…</option>
            {d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NSelect>
        </Field>
      </Modal>
    </div>
  );
}

function CaseMenu({ d }: { d: A.CaseDetailResponse }) {
  const c = d.case;
  const [dlg, setDlg] = useState<null | 'owner' | 'severity' | 'hold' | 'admin' | 'void'>(null);
  const [reason, setReason] = useState('');
  const [sev, setSev] = useState<R.Severity>(c.severity);
  const [owner, setOwner] = useState(c.ownerId);
  const close = () => {
    setDlg(null);
    setReason('');
  };
  const w = useAccWrite((p: { action: string; body: Record<string, unknown> }) => accApi.post(c.id, p.action, { version: d.version, ...p.body }), (_r, a) => (a.action === 'void' ? `${c.number} voided` : 'Saved · change recorded in the timeline'));
  if (!d.permissions.edit) return null;
  const items = [
    { label: 'Change case owner', onSelect: () => setDlg('owner') },
    { label: c.severityManual ? 'Change severity… (set manually)' : 'Change severity…', onSelect: () => { setSev(c.severity); setDlg('severity'); } },
    ...(d.permissions.override
      ? [
          { label: c.legalHold ? 'Release legal hold…' : 'Place legal hold…', onSelect: () => setDlg('hold') },
          ...(c.stage !== 'closed' ? [{ label: 'Close administratively…', onSelect: () => setDlg('admin') }] : []),
        ]
      : []),
    { label: 'Void — entered in error', onSelect: () => setDlg('void') },
  ];
  const reasonBox = (
    <Field label="Reason" required htmlFor="menu-reason">
      <NTextarea id="menu-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Field>
  );
  const run = (action: string, body: Record<string, unknown>) => w.mutate({ action, body }, { onSuccess: close });
  return (
    <>
      <DropdownMenu align="end" trigger={<Button size="sm" variant="secondary" icon={<MoreHorizontal />}>More</Button>}>
        {items.map((i) => (
          <MenuItem key={i.label} onSelect={i.onSelect}>
            {i.label}
          </MenuItem>
        ))}
      </DropdownMenu>
      <Modal open={dlg === 'owner'} onOpenChange={(o) => (o ? undefined : close())} size="sm" title="Case owner" description="The owner is accountable for moving the case to closure."
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="primary" disabled={!owner} loading={w.isPending} onClick={() => run('owner', { ownerId: owner })}>Save</Button></>}>
        <NSelect ariaLabel="Case owner" value={owner} onChange={setOwner}>
          {d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NSelect>
      </Modal>
      <Modal open={dlg === 'severity'} onOpenChange={(o) => (o ? undefined : close())} size="sm" title="Change severity"
        footer={<>
          {c.severityManual ? <Button variant="ghost" loading={w.isPending} onClick={() => run('severity', { auto: true })}>Use the suggested severity</Button> : null}
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={reason.trim().length < 3} loading={w.isPending} onClick={() => run('severity', { severity: sev, reason: reason.trim() })}>Save</Button>
        </>}>
        <div className="flex flex-col gap-3">
          <NSelect ariaLabel="Severity" value={sev} onChange={(v) => setSev(v as R.Severity)}>
            {Object.entries(R.SEVERITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </NSelect>
          {reasonBox}
          <p className="text-xs text-nw-text-3">Suggested from the facts: {R.SEVERITY_LABEL[d.computed.suggestedSeverity.value]} — {d.computed.suggestedSeverity.why}. A manual value stops the automatic update.</p>
        </div>
      </Modal>
      <Modal open={dlg === 'hold'} onOpenChange={(o) => (o ? undefined : close())} size="sm" title={c.legalHold ? 'Release legal hold' : 'Place legal hold'}
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 3} loading={w.isPending} onClick={() => run('legal-hold', { on: !c.legalHold, reason: reason.trim() })}>{c.legalHold ? 'Release' : 'Place hold'}</Button></>}>
        <p className="mb-3 text-sm text-nw-text-2">While a hold is on, evidence on this case cannot be removed and retention timers stop.</p>
        {reasonBox}
      </Modal>
      <Modal open={dlg === 'admin'} onOpenChange={(o) => (o ? undefined : close())} size="sm" title="Close administratively"
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 3} loading={w.isPending} onClick={() => run('close-administratively', { reason: reason.trim() })}>Close administratively</Button></>}>
        <p className="mb-3 text-sm text-nw-text-2">The open conditions are stored with the closure and stay visible. Use this only when the normal close cannot apply.</p>
        {reasonBox}
      </Modal>
      <Modal open={dlg === 'void'} onOpenChange={(o) => (o ? undefined : close())} size="sm" title={`Void ${c.number}?`}
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={w.isPending} onClick={() => run('void', { reason: reason.trim() })}>Void</Button></>}>
        <p className="mb-3 text-sm text-nw-text-2">For a case entered in error. It leaves the board, the KPIs and the DOT register; the record is kept. Refused while claims or work orders are linked.</p>
        {reasonBox}
      </Modal>
    </>
  );
}
