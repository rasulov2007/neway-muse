import { Check, ChevronDown, ChevronRight, Lock, Plus } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Modal, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { accApi, useAccWrite, useCaseEvents, useCaseTasks } from './api';
import { CheckLine } from './AccidentsBoardPage';
import { PartiesPanel } from './InvestigationTab';
import { triText } from './labels';
import { DeptChip, DueText, Empty, Field, KV, Loading, NInput, NSelect, NTextarea, Panel, Person, ProvTag, Restricted, Seg, ToneBadge, TriField } from './ui';

type D = A.CaseDetailResponse;

function usePatch(d: D) {
  return useAccWrite((body: Omit<A.PatchAccidentInput, 'version'>) => accApi.patch(d.case.id, { version: d.version, ...body }), 'Saved · change recorded in the timeline');
}

/** View ↔ inline edit block (prototype Section). */
function Section({ title, sub, view, edit, canEdit }: { title: string; sub?: string; view: ReactNode; edit: (close: () => void) => ReactNode; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <Panel title={title} sub={sub} actions={canEdit && !editing ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button> : null}>
      {editing ? <div className="flex flex-col gap-3">{edit(() => setEditing(false))}</div> : view}
    </Panel>
  );
}

function SaveRow({ onCancel, onSave, disabled, busy }: { onCancel: () => void; onSave: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
      <Button size="sm" variant="primary" disabled={disabled} loading={busy} onClick={onSave}>Save</Button>
    </div>
  );
}

const PROV_OPTS = [
  { v: 'verified' as const, label: 'Verified' },
  { v: 'driver' as const, label: 'Driver' },
  { v: 'preliminary' as const, label: 'Preliminary' },
];

/* ================================================================== OVERVIEW */
export function OverviewTab({ d, onTab }: { d: D; onTab: (t: string) => void }) {
  const c = d.case;
  const cp = d.computed;
  const events = useCaseEvents(c.id);
  const tasks = useCaseTasks(c.id);
  const [showSrc, setShowSrc] = useState(false);
  const [edit, setEdit] = useState(false);
  const [txt, setTxt] = useState('');
  const saveSummary = useAccWrite((text: string | null) => accApi.put(c.id, 'summary-override', { version: d.version, text }), 'Summary saved');
  const generated = cp.summaryParts.filter((p) => !p.restricted).map((p) => p.text).join(' ');
  const open = (tasks.data ?? []).filter((t) => t.status !== 'done' && t.status !== 'cancelled').sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const latest = [...(events.data ?? [])].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 6);
  const dot = cp.dotRecordable;
  const tt = cp.testing;
  const det = c.determinations;
  const missing = cp.expectedEvidence.filter((x) => !x.ok);
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.75fr_1fr]">
        <Panel
          title="What happened"
          id="summary"
          sub={c.summaryOverride ? `Edited by ${c.summaryOverride.by} · ${R.fmtShort(c.summaryOverride.at, R.EASTERN, nowMs())}` : 'Draft written from the case records · updates as facts change'}
          actions={
            !edit ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setShowSrc((x) => !x)}>{showSrc ? 'Hide sources' : 'Show sources'}</Button>
                {d.permissions.edit ? <Button size="sm" variant="secondary" onClick={() => { setTxt(c.summaryOverride?.text ?? generated); setEdit(true); }}>Edit</Button> : null}
              </>
            ) : null
          }
        >
          {edit ? (
            <div className="flex flex-col gap-2">
              <NTextarea rows={6} aria-label="Summary" value={txt} onChange={(e) => setTxt(e.target.value)} />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEdit(false)}>Cancel</Button>
                {c.summaryOverride ? <Button size="sm" variant="secondary" onClick={() => saveSummary.mutate(null, { onSuccess: () => setEdit(false) })}>Use generated draft</Button> : null}
                <Button size="sm" variant="primary" disabled={!txt.trim()} loading={saveSummary.isPending} onClick={() => saveSummary.mutate(txt.trim(), { onSuccess: () => setEdit(false) })}>Save summary</Button>
              </div>
            </div>
          ) : c.summaryOverride ? (
            <>
              {cp.summaryStale ? (
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-nw-warning-bg px-3 py-2 text-xs text-nw-warning-text">
                  Facts changed after this summary was edited. Review it or switch back to the generated draft.
                  {d.permissions.edit ? <Button size="sm" variant="secondary" onClick={() => saveSummary.mutate(null)}>Use generated draft</Button> : null}
                </div>
              ) : null}
              <p className="text-sm leading-relaxed text-nw-text">{c.summaryOverride.text}</p>
            </>
          ) : (
            <p className="text-sm leading-relaxed text-nw-text">
              {cp.summaryParts.map((p, i) => (
                <span key={i} className={cn(p.prov === 'unresolved' ? 'text-nw-warning-text' : '', p.restricted ? 'text-nw-text-2' : '')}>
                  {p.restricted ? <Lock className="mr-0.5 inline size-3" aria-hidden /> : null}
                  {p.text}
                  {showSrc ? <ProvTag p={p.prov} /> : null}{' '}
                </span>
              ))}
            </p>
          )}
          {!edit && missing.length ? (
            <div className="mt-3 rounded-md bg-nw-subtle px-3 py-2" id="unresolved">
              <div className="mb-1 text-xs font-bold text-nw-text-2">Still unresolved</div>
              <ul className="flex flex-col gap-0.5 text-xs text-nw-text-2">
                {missing.map((m) => <li key={m.label}>Missing: {m.label} <span className="text-nw-text-3">· {m.why}</span></li>)}
              </ul>
            </div>
          ) : null}
        </Panel>
        <Panel title="Status by track" sub="Each track moves on its own" pad={false} id="tracks">
          <ul className="divide-y divide-nw-border">
            {cp.tracks.map((t) => (
              <li key={t.key}>
                <button type="button" onClick={() => onTab(t.tab)} className="flex w-full items-start justify-between gap-2 px-4 py-2 text-left hover:bg-nw-hover">
                  <span className="text-sm font-semibold text-nw-text">{t.label}</span>
                  <span className="flex flex-col items-end gap-0.5">
                    <ToneBadge tone={t.tone}>{t.status}</ToneBadge>
                    {t.detail ? <span className="text-xs text-nw-text-3">{t.detail}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Key facts" id="key-facts">
          <dl>
            <KV k="Injuries">
              {c.injuries.status === 'yes' ? (
                <>
                  <b>{c.injuries.treatedAway === null ? 'Treated away: not known yet' : `${R.plural(c.injuries.treatedAway, 'person', 'people')} treated away`}</b>
                  {c.injuries.fatalities === null ? <> · <ToneBadge tone="warning">Fatalities not known</ToneBadge></> : c.injuries.fatalities ? `, ${R.plural(c.injuries.fatalities, 'fatality', 'fatalities')}` : ''}
                  <ProvTag p={c.injuries.provenance} />
                </>
              ) : c.injuries.status === 'no' ? (
                <>None <ProvTag p={c.injuries.provenance} /></>
              ) : (
                <ToneBadge tone="warning">{c.injuries.status === 'unknown' ? 'Unknown' : 'Not reported yet'}</ToneBadge>
              )}
            </KV>
            {d.redacted.includes('injuries.medicalDetails') ? <KV k="Medical details"><Restricted /></KV> : c.injuries.detailsRestricted ? <KV k="Medical details">{c.injuries.detailsRestricted}</KV> : null}
            <KV k="DOT recordable" hint={dot.value === 'pending' ? `Needs: ${dot.missing.join('; ')}` : dot.reasons[0]}>
              {dot.value === 'yes' ? 'Yes' : dot.value === 'no' ? 'No' : <ToneBadge tone="warning">To be determined</ToneBadge>}
            </KV>
            <KV k="Post-accident tests" hint={tt.alcohol.reason}>
              {tt.alcohol.required === 'yes' || tt.drug.required === 'yes' ? (
                tt.alcohol.documented && tt.drug.documented ? 'Required · documented' : <ToneBadge tone="urgent">Required · not documented</ToneBadge>
              ) : tt.alcohol.required === 'pending' || tt.drug.required === 'pending' ? (
                <ToneBadge tone="warning">Decision pending</ToneBadge>
              ) : (
                'Not required'
              )}
            </KV>
            <KV k="Police / citation">
              {c.police.responded === 'yes' ? `${c.police.dept || 'Police'}${c.police.reportNumber ? ` · #${c.police.reportNumber}` : ' · report # pending'}` : c.police.responded === 'no' ? 'Police did not respond' : 'Not reported'}
              {c.citation.status === 'yes' ? ` · driver cited${c.citation.note ? ` (${c.citation.note})` : ''}` : c.citation.status === 'no' ? ' · no citation' : ''}
            </KV>
          </dl>
        </Panel>
        <Panel title="Fault and preventability" sub="Separate decisions — never derived from each other" id="determinations">
          <dl>
            <KV k="Driver fault (internal)">{det.fault.value === 'not_determined' ? <ToneBadge tone="warning">Not determined</ToneBadge> : R.FAULT_LABEL[det.fault.value]}</KV>
            <KV k="Preventability (company)">{det.preventability.value === 'not_determined' ? <ToneBadge tone="warning">Not determined</ToneBadge> : R.PREVENT_LABEL[det.preventability.value]}</KV>
            <KV k="FMCSA review (CPDP)">{R.CPDP_LABEL[det.cpdp.value]}</KV>
            <KV k="Legal liability">{d.redacted.includes('determinations.legal') ? <Restricted /> : R.LEGAL_LABEL[det.legal.value]}</KV>
            <KV k="Insurance liability" hint="Per claim status">{cp.claims.length ? cp.claims.map((k) => `${R.CLAIM_TYPE_LABEL[k.type].split(' ')[0]}: ${k.status}`).join(' · ') : 'No claims'}</KV>
          </dl>
        </Panel>
        <Panel title="Money" sub="Cash only — lost revenue shown separately" id="money">
          <MoneyCard d={d} />
        </Panel>
        <Panel title="Truck downtime" id="downtime-card">
          <div className="text-[22px] font-extrabold text-nw-text">{R.downtimeLabel(cp.downtime.truckMs)} <span className="text-sm font-semibold text-nw-text-3">{cp.downtime.ongoing ? 'and counting' : cp.downtime.truckMs > 0 ? 'total' : ''}</span></div>
          <div className="text-xs text-nw-text-2">
            Tractor {d.display.truck?.unit ?? ''}: {c.equipment.truck.status === 'returned' ? `back in service ${R.fmtShort(c.equipment.truck.rtsAt, c.tz, nowMs())}` : R.EQUIP_STATUS_LABEL[c.equipment.truck.status]}
            {c.equipment.truck.towedTo ? ` · ${c.equipment.truck.towedTo}` : ''}
          </div>
          {cp.downtime.trailerMs > 0 ? <div className="text-xs text-nw-text-2">Trailer: {R.downtimeLabel(cp.downtime.trailerMs)} out of service</div> : null}
          {cp.repeatSignals.sameDriver.length || cp.repeatSignals.sameTruck.length ? (
            <div className="mt-2 rounded-md bg-nw-subtle px-2 py-1.5 text-xs text-nw-text-2" id="repeat-signal">
              {cp.repeatSignals.sameDriver.length ? `${d.display.driver?.name} has ${R.plural(cp.repeatSignals.sameDriver.length, 'other case')} within 12 months` : ''}
              {cp.repeatSignals.sameDriver.length && cp.repeatSignals.sameTruck.length ? '; ' : ''}
              {cp.repeatSignals.sameTruck.length ? `Truck ${d.display.truck?.unit} has ${R.plural(cp.repeatSignals.sameTruck.length, 'other case')}` : ''}. Review suggested — not a finding of fault.
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Panel title="Waiting on" sub={`${R.plural(open.length, 'open task')}`} pad={false} id="waiting-on" actions={<Button size="sm" variant="ghost" onClick={() => onTab('tasks')}>All tasks</Button>}>
          {tasks.isLoading ? <Loading /> : open.length === 0 ? <Empty title="Nobody is waiting on anything" /> : (
            <ul className="divide-y divide-nw-border">
              {open.map((t) => (
                <li key={t.id} className={cn('flex flex-col gap-1 px-4 py-2', t.overdue ? 'bg-nw-urgent-bg' : '')}>
                  <span className="text-sm text-nw-text">{t.title}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <DeptChip dept={t.dept} />
                    <Person name={t.assignee?.name} />
                    <DueText iso={t.dueAt} tz={c.tz} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Claims" id="ov-claims" pad={false} actions={<Button size="sm" variant="ghost" onClick={() => onTab('claims')}>Claims & costs</Button>}>
          {cp.claims.length === 0 ? (
            <Empty title={c.claimDecision ? 'No claim filed' : 'No claims yet'}>{c.claimDecision?.text ?? 'Open claims from the Claims & costs tab.'}</Empty>
          ) : (
            <ul className="divide-y divide-nw-border">
              {cp.claims.map((k) => (
                <li key={k.id}>
                  <button type="button" onClick={() => onTab('claims')} className="flex w-full items-start justify-between gap-2 px-4 py-2 text-left hover:bg-nw-hover">
                    <span className="min-w-0">
                      <span className="text-sm font-semibold text-nw-text">{k.number}</span> <span className="text-xs text-nw-text-3">{R.CLAIM_TYPE_LABEL[k.type]}</span>
                      {k.restricted ? <Lock className="ml-1 inline size-3 text-nw-text-3" aria-label="Restricted" /> : null}
                      <span className="block truncate text-xs text-nw-text-3">{k.insurer}{k.insurerClaimNo ? ` · #${k.insurerClaimNo}` : ''}</span>
                    </span>
                    <ToneBadge tone={k.status === 'Settled' || k.status === 'Closed' ? 'done' : k.status === 'Denied' ? 'neutral' : k.status === 'Awaiting documents' || k.status === 'Draft' ? 'warning' : 'moving'}>{k.status}</ToneBadge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Latest activity" pad={false} id="ov-timeline" actions={<Button size="sm" variant="ghost" onClick={() => onTab('tasks')}>Full timeline</Button>}>
          {events.isLoading ? <Loading /> : (
            <ul className="divide-y divide-nw-border">
              {latest.map((e) => (
                <li key={e.id} className="flex gap-3 px-4 py-2">
                  <span className="w-20 shrink-0 text-xs text-nw-text-3">{R.fmtShort(e.occurredAt, c.tz, nowMs())}<br />{R.fmtTime(e.occurredAt, c.tz)}</span>
                  <span className="min-w-0 text-sm text-nw-text">
                    {e.restricted && e.text === 'Restricted entry' ? <Restricted text="Restricted entry" /> : e.text}
                    <span className="block text-xs text-nw-text-3">{e.source}{e.actorName ? ` · ${e.actorName}` : ''}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ================================================================== INCIDENT */
export function IncidentTab({ d }: { d: D }) {
  const c = d.case;
  const cp = d.computed;
  const patch = usePatch(d);
  const can = d.permissions.edit;
  const dot = cp.dotRecordable;
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <Section
          title="When & where"
          canEdit={can}
          view={
            <dl>
              <KV k="Occurred" hint={`${R.fmtTime(c.occurredAt, R.EASTERN)} · ${R.fmtTime(c.occurredAt, R.TASHKENT, false)} Tashkent`}>
                {R.fmtDate(c.occurredAt, c.tz)}, {R.fmtTime(c.occurredAt, c.tz)} <ProvTag p={c.timeProvenance} />
              </KV>
              <KV k="Location">
                {[c.location.road, c.location.detail].filter(Boolean).join(' ') || 'Road not recorded'}
                <div>{c.location.city}, {c.location.state} <ProvTag p={c.locationProvenance} /></div>
              </KV>
              <KV k="Open to public travel">{triText(c.location.publicRoad)}</KV>
              <KV k="Reported in NeWay" hint={c.submittedAt ? `${R.durationLabel(Date.parse(c.submittedAt) - Date.parse(c.occurredAt))} after it happened` : undefined}>
                {R.fmtShortDateTime(c.submittedAt, R.EASTERN, nowMs())} by {d.display.reportedBy}
              </KV>
            </dl>
          }
          edit={(close) => <WhereEdit d={d} close={close} />}
        />
        <Section
          title="What happened"
          canEdit={can}
          view={
            <>
              <dl>
                <KV k="Type">{c.type}</KV>
                <KV k="Conditions">{[c.conditions.weather, c.conditions.road, c.conditions.light].filter(Boolean).join(' · ') || <span className="text-nw-text-3">Not recorded</span>}</KV>
              </dl>
              <blockquote className="mt-2 border-l-2 border-nw-border-strong pl-3 text-sm text-nw-text">
                {c.description || <span className="text-nw-text-3">No description yet</span>}
                <ProvTag p={c.descriptionProvenance} />
              </blockquote>
            </>
          }
          edit={(close) => <WhatEdit d={d} close={close} />}
        />
        <Section
          title="Injuries"
          sub="Details restricted to authorized roles"
          canEdit={can}
          view={
            <dl>
              <KV k="Anyone injured">{triText(c.injuries.status)} {c.injuries.status !== null ? <ProvTag p={c.injuries.provenance} /> : null}</KV>
              {c.injuries.status === 'yes' ? <KV k="Treated away from scene">{c.injuries.treatedAway ?? <span className="text-nw-text-3">Not known yet</span>}</KV> : null}
              <KV k="Fatalities">{c.injuries.fatalities ?? <span className="text-nw-text-3">Not known yet</span>}</KV>
              <KV k="Our driver injured">{triText(c.injuries.ourDriver)}</KV>
              {d.redacted.includes('injuries.medicalDetails') ? <KV k="Medical details"><Restricted /></KV> : c.injuries.detailsRestricted ? <KV k="Medical details">{c.injuries.detailsRestricted}</KV> : null}
            </dl>
          }
          edit={(close) => <InjEdit d={d} close={close} />}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Panel title="DOT recordability" sub="49 CFR 390.5T · accident register 390.15" id="dot-panel">
          <div className={cn('mb-2 rounded-md px-3 py-2', dot.value === 'yes' ? 'bg-nw-urgent-bg' : dot.value === 'no' ? 'bg-nw-done-bg' : 'bg-nw-warning-bg')}>
            <div className="text-sm font-bold text-nw-text">{dot.value === 'yes' ? 'DOT-recordable accident' : dot.value === 'no' ? 'Not DOT-recordable' : 'Not determined yet'}</div>
            <div className="text-xs text-nw-text-2">{dot.value === 'pending' ? `Needs: ${dot.missing.join('; ')}` : dot.reasons.join('; ')}</div>
          </div>
          <p className="mb-2 text-xs text-nw-text-3">A DOT-recordable accident involves a fatality, an injury treated away from the scene, or a vehicle towed away with disabling damage, on a road open to public travel. Loading/unloading-only and boarding/alighting-only events are excluded.</p>
          <dl>
            <KV k="Register fields">
              <span className="flex flex-wrap gap-2">
                {(
                  [
                    ['Date', true],
                    ['City/state', Boolean(c.location.city && c.location.state)],
                    ['Driver', Boolean(d.display.driver)],
                    ['Injuries', c.injuries.status !== null && c.injuries.status !== 'unknown'],
                    ['Fatalities', c.injuries.fatalities !== null],
                    ['Hazmat released', c.hazmat === 'yes' || c.hazmat === 'no'],
                  ] as [string, boolean][]
                ).map(([label, ok]) => <CheckLine key={label} ok={ok}>{label}</CheckLine>)}
              </span>
            </KV>
            <KV k="Hazmat released">{can ? <TriField ariaLabel="Hazmat released" value={c.hazmat} onChange={(v) => patch.mutate({ hazmat: v })} /> : triText(c.hazmat)}</KV>
            <KV k="Tow-away (any vehicle)">{can ? <TriField ariaLabel="Tow-away" value={c.towAway} onChange={(v) => patch.mutate({ towAway: v })} /> : triText(c.towAway)}</KV>
            <KV k="Excluded event">
              <NSelect ariaLabel="Excluded event" disabled={!can} value={c.excludedOccurrence ?? ''} onChange={(v) => patch.mutate({ excludedOccurrence: (v || null) as A.PatchAccidentInput['excludedOccurrence'] })}>
                <option value="">Not excluded</option>
                <option value="loading_unloading">Only loading / unloading cargo</option>
                <option value="boarding_alighting">Only boarding / alighting a stationary vehicle</option>
              </NSelect>
            </KV>
          </dl>
        </Panel>
        <Section
          title="Police & citation"
          canEdit={can}
          view={
            <dl>
              <KV k="Police at scene">{triText(c.police.responded)}{c.police.dept ? ` · ${c.police.dept}` : ''}</KV>
              <KV k="Report number">{c.police.reportNumber || <span className="text-nw-text-3">Pending</span>}</KV>
              <KV k="Our driver cited">
                {triText(c.citation.status)}
                {c.citation.status === 'yes' ? ` · ${c.citation.note ?? ''}${c.citation.issuedAt ? ` · ${R.fmtShortDateTime(c.citation.issuedAt, c.tz, nowMs())}` : ''}` : ''}
              </KV>
            </dl>
          }
          edit={(close) => <PoliceEdit d={d} close={close} />}
        />
        <TestingPanel d={d} />
        <PartiesPanel d={d} />
      </div>
    </div>
  );
}

function WhereEdit({ d, close }: { d: D; close: () => void }) {
  const c = d.case;
  const patch = usePatch(d);
  const [v, setV] = useState({ local: R.isoToLocalInput(c.occurredAt, c.tz), tz: c.tz, choice: '', road: c.location.road ?? '', detail: c.location.detail ?? '', city: c.location.city, state: c.location.state, pub: c.location.publicRoad, prov: c.timeProvenance });
  const conv = R.localToUtc(v.local, v.tz, v.choice || undefined);
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Date & time (local)" htmlFor="e-time" error={conv.ok ? undefined : conv.message} hint={conv.ok ? R.fmtTime(conv.iso, R.EASTERN) : undefined}>
          <NInput id="e-time" type="datetime-local" value={v.local} onChange={(e) => setV({ ...v, local: e.target.value, choice: '' })} />
        </Field>
        <Field label="Time zone" htmlFor="e-tz">
          <NSelect id="e-tz" value={v.tz} onChange={(tz) => setV({ ...v, tz, choice: '' })}>{R.TZ_CHOICES.map((z) => <option key={z.tz} value={z.tz}>{z.label}</option>)}</NSelect>
        </Field>
      </div>
      {!conv.ok && conv.error === 'ambiguous' ? (
        <div className="flex gap-2">{conv.options.map((o) => <Button key={o.abbr} size="sm" variant="secondary" onClick={() => setV({ ...v, choice: o.abbr })}>{o.abbr}</Button>)}</div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Road" htmlFor="e-road"><NInput id="e-road" value={v.road} onChange={(e) => setV({ ...v, road: e.target.value })} /></Field>
        <Field label="Detail (mile marker, exit, cross street)" htmlFor="e-detail"><NInput id="e-detail" value={v.detail} onChange={(e) => setV({ ...v, detail: e.target.value })} /></Field>
        <Field label="City" htmlFor="e-city"><NInput id="e-city" value={v.city} onChange={(e) => setV({ ...v, city: e.target.value })} /></Field>
        <Field label="State" htmlFor="e-state"><NSelect id="e-state" value={v.state} onChange={(st) => setV({ ...v, state: st })}><option value="">Pick…</option>{R.US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}</NSelect></Field>
        <Field label="Road open to public travel?"><TriField ariaLabel="Road open to public travel" value={v.pub} onChange={(pub) => setV({ ...v, pub })} /></Field>
        <Field label="Source of time & place"><Seg ariaLabel="Source" value={v.prov} onChange={(p) => p && setV({ ...v, prov: p })} options={PROV_OPTS} /></Field>
      </div>
      <SaveRow
        onCancel={close}
        disabled={!conv.ok}
        busy={patch.isPending}
        onSave={() =>
          patch.mutate(
            { occurredAtLocal: v.local, occurredTz: v.tz, ...(v.choice ? { occurredChoice: v.choice } : {}), road: v.road || null, locationDetail: v.detail || null, city: v.city || null, state: v.state || null, publicRoad: v.pub, timeProvenance: v.prov, locationProvenance: v.prov },
            { onSuccess: close },
          )
        }
      />
    </>
  );
}

function WhatEdit({ d, close }: { d: D; close: () => void }) {
  const c = d.case;
  const patch = usePatch(d);
  const [v, setV] = useState({ type: c.type, desc: c.description, w: c.conditions.weather ?? '', r: c.conditions.road ?? '', l: c.conditions.light ?? '' });
  const opts = (xs: string[]) => [<option key="" value="">Not recorded</option>, ...xs.map((x) => <option key={x} value={x}>{x}</option>)];
  return (
    <>
      <Field label="Accident type" htmlFor="e-type"><NSelect id="e-type" value={v.type} onChange={(type) => setV({ ...v, type })}>{R.ACCIDENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</NSelect></Field>
      <Field label="Description (driver’s account)" htmlFor="e-desc"><NTextarea id="e-desc" rows={4} value={v.desc} onChange={(e) => setV({ ...v, desc: e.target.value })} /></Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Weather"><NSelect ariaLabel="Weather" value={v.w} onChange={(w) => setV({ ...v, w })}>{opts(['Clear', 'Cloudy', 'Light rain', 'Heavy rain', 'Snow', 'Ice / sleet', 'Fog', 'High wind'])}</NSelect></Field>
        <Field label="Road surface"><NSelect ariaLabel="Road surface" value={v.r} onChange={(r) => setV({ ...v, r })}>{opts(['Dry', 'Wet', 'Snow / ice', 'Gravel', 'Construction zone'])}</NSelect></Field>
        <Field label="Light"><NSelect ariaLabel="Light" value={v.l} onChange={(l) => setV({ ...v, l })}>{opts(['Daylight', 'Dawn', 'Dusk', 'Dark — lighted', 'Dark — unlighted'])}</NSelect></Field>
      </div>
      <SaveRow onCancel={close} busy={patch.isPending} onSave={() => patch.mutate({ accidentType: v.type, description: v.desc, weather: v.w || null, roadSurface: v.r || null, lightCondition: v.l || null }, { onSuccess: close })} />
    </>
  );
}

function InjEdit({ d, close }: { d: D; close: () => void }) {
  const c = d.case;
  const patch = usePatch(d);
  const ok = d.permissions.restricted;
  const [v, setV] = useState({ st: c.injuries.status, away: c.injuries.treatedAway === null ? '' : String(c.injuries.treatedAway), fat: c.injuries.fatalities === null ? '' : String(c.injuries.fatalities), our: c.injuries.ourDriver, det: c.injuries.detailsRestricted ?? '', prov: c.injuries.provenance });
  const n = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.floor(Number(s))));
  return (
    <>
      <Field label="Anyone injured or killed?"><TriField ariaLabel="Anyone injured" value={v.st} onChange={(st) => setV({ ...v, st })} /></Field>
      {v.st === 'yes' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Treated away from the scene" hint="Blank = not known yet" htmlFor="e-away"><NInput id="e-away" type="number" min={0} value={v.away} onChange={(e) => setV({ ...v, away: e.target.value })} /></Field>
          <Field label="Fatalities" hint="Blank = not known yet" htmlFor="e-fat"><NInput id="e-fat" type="number" min={0} value={v.fat} onChange={(e) => setV({ ...v, fat: e.target.value })} /></Field>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Our driver injured?"><TriField ariaLabel="Our driver injured" value={v.our} onChange={(our) => setV({ ...v, our })} /></Field>
        <Field label="Source"><Seg ariaLabel="Source" value={v.prov} onChange={(p) => p && setV({ ...v, prov: p })} options={PROV_OPTS} /></Field>
      </div>
      {ok ? (
        <Field label="Medical details (restricted)" hint="Visible only to the Safety Manager and the Owner" htmlFor="e-med"><NTextarea id="e-med" rows={2} value={v.det} onChange={(e) => setV({ ...v, det: e.target.value })} /></Field>
      ) : (
        <Restricted text="Medical details are restricted" />
      )}
      <SaveRow
        onCancel={close}
        busy={patch.isPending}
        onSave={() =>
          patch.mutate(
            {
              injuries: v.st,
              treatedAway: v.st === 'yes' ? n(v.away) : null,
              fatalities: v.st === 'yes' ? n(v.fat) : null,
              ourDriverInjured: v.our,
              injuriesProvenance: v.prov,
              ...(ok ? { medicalDetails: v.det.trim() || null } : {}),
            },
            { onSuccess: close },
          )
        }
      />
    </>
  );
}

function PoliceEdit({ d, close }: { d: D; close: () => void }) {
  const c = d.case;
  const patch = usePatch(d);
  const [v, setV] = useState({ resp: c.police.responded, dept: c.police.dept ?? '', num: c.police.reportNumber ?? '', cit: c.citation.status, at: c.citation.issuedAt ? R.isoToLocalInput(c.citation.issuedAt, c.tz) : '', note: c.citation.note ?? '' });
  const conv = v.at ? R.localToUtc(v.at, c.tz) : null;
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Police at the scene?"><TriField ariaLabel="Police at the scene" value={v.resp} onChange={(resp) => setV({ ...v, resp })} /></Field>
        <Field label="Department" htmlFor="e-pd"><NInput id="e-pd" value={v.dept} onChange={(e) => setV({ ...v, dept: e.target.value })} /></Field>
      </div>
      <Field label="Report number" htmlFor="e-prn"><NInput id="e-prn" value={v.num} onChange={(e) => setV({ ...v, num: e.target.value })} /></Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Our driver cited?"><TriField ariaLabel="Our driver cited" value={v.cit} onChange={(cit) => setV({ ...v, cit })} /></Field>
        {v.cit === 'yes' ? (
          <Field label="Citation time (incident local)" htmlFor="e-cat" error={conv && !conv.ok ? conv.message : undefined}>
            <NInput id="e-cat" type="datetime-local" value={v.at} onChange={(e) => setV({ ...v, at: e.target.value })} />
          </Field>
        ) : null}
      </div>
      <Field label="Citation / note" htmlFor="e-cnote"><NInput id="e-cnote" value={v.note} placeholder="e.g. Following too closely" onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      <SaveRow
        onCancel={close}
        busy={patch.isPending}
        disabled={Boolean(conv && !conv.ok)}
        onSave={() =>
          patch.mutate(
            { police: v.resp, policeDepartment: v.dept || null, policeReportNumber: v.num || null, citation: v.cit, citationAt: v.cit === 'yes' && conv?.ok ? conv.iso : null, citationNote: v.note || null },
            { onSuccess: close },
          )
        }
      />
    </>
  );
}

function TestingPanel({ d }: { d: D }) {
  const c = d.case;
  const tt = d.computed.testing;
  const ok = d.permissions.restricted;
  const can = d.permissions.edit;
  const [rec, setRec] = useState<null | 'alcohol' | 'drug'>(null);
  const [v, setV] = useState({ mode: 'given' as 'given' | 'not', at: '', result: '', reason: '', delay: '' });
  const conv = rec && v.mode === 'given' && v.at ? R.localToUtc(v.at, c.tz) : null;
  const givenMs = conv && conv.ok ? Date.parse(conv.iso) - Date.parse(c.occurredAt) : null;
  const limitMs = (rec === 'alcohol' ? 8 : 32) * R.HOUR;
  const tooLate = givenMs !== null && givenMs > limitMs;
  const before = givenMs !== null && givenMs < 0;
  const needDelay = rec === 'alcohol' && givenMs !== null && givenMs > 2 * R.HOUR && !tooLate;
  const w = useAccWrite((p: { sub: 'alcohol' | 'drug'; body: Record<string, unknown> }) => accApi.put(c.id, `tests/${p.sub}`, { version: d.version, ...p.body }), 'Test record saved (restricted)');
  return (
    <Panel title="Post-accident testing" sub="49 CFR 382.303 · results restricted" id="testing">
      <div className="flex flex-col gap-3">
        {(['alcohol', 'drug'] as const).map((k) => {
          const x = tt[k];
          const r = c.testing[k];
          return (
            <div key={k} className="border-b border-nw-border pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-sm text-nw-text">{k === 'alcohol' ? 'Alcohol' : 'Controlled substances'}</b>
                <ToneBadge tone={x.required === 'yes' ? (x.documented ? 'done' : 'urgent') : x.required === 'pending' ? 'warning' : 'neutral'}>
                  {x.required === 'yes' ? (x.documented ? 'Required · documented' : 'Required') : x.required === 'pending' ? 'Decision pending' : 'Not required'}
                </ToneBadge>
              </div>
              <div className="text-xs text-nw-text-3">{x.reason}{x.overrideNote ? ` · ${x.overrideNote}` : ''}</div>
              <div className="text-xs text-nw-text-2">
                Window {x.windowOpen ? 'closes' : 'closed'} {R.fmtShortDateTime(x.deadline, c.tz, nowMs())}
                {x.windowOpen ? ` (${R.durationLabel(Date.parse(x.deadline) - nowMs())} left)` : ''}
                {k === 'alcohol' && x.promptBy ? ` · if not given by ${R.fmtTime(x.promptBy, c.tz)}, record why` : ''}
              </div>
              {r.administeredAt ? (
                <div className="text-xs text-nw-text-2">
                  Given {R.fmtShortDateTime(r.administeredAt, c.tz, nowMs())} ({R.durationLabel(Date.parse(r.administeredAt) - Date.parse(c.occurredAt))} after) · Result: {ok ? r.resultRestricted ?? 'pending' : <Restricted text="restricted" />}
                </div>
              ) : null}
              {r.delayReason ? <div className="text-xs text-nw-text-2">Why not within 2 hours: {r.delayReason}</div> : null}
              {x.docNote ? <div className="text-xs font-semibold text-nw-warning-text">{x.docNote}</div> : null}
              {r.notAdministeredReason ? <div className="text-xs text-nw-text-2">Not given: {r.notAdministeredReason}</div> : null}
              {can ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => { setRec(k); setV({ mode: 'given', at: R.isoToLocalInput(new Date(nowMs()).toISOString(), c.tz), result: '', reason: '', delay: '' }); }}>Record</Button>
                  {x.required !== 'yes' ? <Button size="sm" variant="ghost" onClick={() => w.mutate({ sub: k, body: { decision: 'required' } })}>Mark required</Button> : null}
                  {r.decision !== 'auto' ? <Button size="sm" variant="ghost" onClick={() => w.mutate({ sub: k, body: { decision: 'auto' } })}>Use rule</Button> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        <p className="text-xs text-nw-text-3">Test results are restricted. Receipt of test materials is not a clearance for return to duty.</p>
      </div>
      <Modal
        open={Boolean(rec)}
        onOpenChange={(o) => (o ? undefined : setRec(null))}
        size="sm"
        title={`Record ${rec === 'alcohol' ? 'alcohol' : 'drug'} test`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRec(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={w.isPending}
              disabled={v.mode === 'given' ? !conv?.ok || tooLate || before || (needDelay && !v.delay.trim()) : !v.reason.trim()}
              onClick={() =>
                w.mutate(
                  {
                    sub: rec!,
                    body:
                      v.mode === 'given'
                        ? { administeredAt: conv && conv.ok ? conv.iso : null, notAdministeredReason: null, ...(needDelay ? { delayReason: v.delay.trim() } : {}), ...(ok && v.result ? { result: v.result } : {}) }
                        : { notAdministeredReason: v.reason.trim() },
                  },
                  { onSuccess: () => setRec(null) },
                )
              }
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Seg ariaLabel="Test given" value={v.mode} onChange={(m) => m && setV({ ...v, mode: m })} options={[{ v: 'given', label: 'Test given' }, { v: 'not', label: 'Not given — record why' }]} />
          {v.mode === 'given' ? (
            <>
              <Field
                label="Time given (incident local)"
                htmlFor="t-at"
                error={tooLate ? `That is more than ${rec === 'alcohol' ? 8 : 32} hours after the accident — a post-accident test can no longer be given. Record why it was not given instead.` : before ? 'This is before the accident time' : conv && !conv.ok ? conv.message : undefined}
              >
                <NInput id="t-at" type="datetime-local" value={v.at} onChange={(e) => setV({ ...v, at: e.target.value })} />
              </Field>
              {needDelay ? (
                <Field label="Why was it not given within 2 hours? (required record, 382.303(d)(1))" htmlFor="t-delay"><NTextarea id="t-delay" rows={2} value={v.delay} onChange={(e) => setV({ ...v, delay: e.target.value })} /></Field>
              ) : null}
              {ok ? (
                <Field label="Result (restricted)" htmlFor="t-res">
                  <NSelect id="t-res" value={v.result} onChange={(result) => setV({ ...v, result })}>
                    <option value="">Not received yet</option>
                    <option value="negative">Negative</option>
                    <option value="positive">Positive</option>
                    <option value="refused">Refused</option>
                    <option value="cancelled">Cancelled</option>
                  </NSelect>
                </Field>
              ) : (
                <Restricted text="Test results are restricted" />
              )}
            </>
          ) : (
            <Field label="Reason" htmlFor="t-reason"><NTextarea id="t-reason" rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
          )}
        </div>
      </Modal>
    </Panel>
  );
}

/* INVESTIGATION lives in InvestigationTab.tsx and EVIDENCE in EvidenceTab.tsx (P4); EQUIPMENT & CARGO in EquipmentTab.tsx (P3). */

export function LaterTab({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="mt-3">
      <Panel title={title}>
        <p className="text-sm text-nw-text-2">{phase}</p>
      </Panel>
    </div>
  );
}

/* ================================================================== TASKS & TIMELINE */
export function TasksTimelineTab({ d }: { d: D }) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[1.1fr_1fr]">
      <TaskPanel d={d} />
      <TimelinePanel d={d} />
    </div>
  );
}

const DEPTS = ['Safety', 'Fleet', 'Dispatch', 'Claims', 'Accounting', 'Management', 'Driver Relations'] as const;

function TaskPanel({ d }: { d: D }) {
  const c = d.case;
  const tasks = useCaseTasks(c.id);
  const [filter, setFilter] = useState<'open' | 'overdue' | 'done' | 'all'>('open');
  const [add, setAdd] = useState(false);
  const [exp, setExp] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [form, setForm] = useState({ title: '', dept: 'Fleet' as (typeof DEPTS)[number], assignee: '', due: '', instructions: '', high: false });
  const create = useAccWrite((b: A.CreateTaskInput) => accApi.createTask(b), (t) => `Task assigned to ${t.dept}`);
  const patchTask = useAccWrite((p: { id: string; body: A.PatchTaskInput }) => accApi.patchTask(p.id, p.body), (t) => (t.status === 'done' ? `Done: ${t.title}` : 'Task updated'));
  const post = useAccWrite((p: { id: string; text: string }) => accApi.taskUpdate(p.id, { text: p.text }), 'Update posted');
  const confirm = useAccWrite((p: { id: string; version: number }) => accApi.confirm(p.id, { version: p.version }), 'Confirmed by Dispatch');
  const all = tasks.data ?? [];
  const isOpen = (t: A.TaskView) => t.status !== 'done' && t.status !== 'cancelled';
  const list = all
    .filter((t) => (filter === 'all' ? true : filter === 'open' ? isOpen(t) : filter === 'overdue' ? t.overdue : t.status === 'done'))
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1) || Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const dueConv = form.due ? R.localToUtc(form.due, R.EASTERN) : null;
  return (
    <Panel
      title="Tasks"
      sub="Who owes what, by when"
      pad={false}
      id="tasks"
      actions={d.permissions.edit ? <Button size="sm" variant="primary" icon={<Plus />} onClick={() => { setForm({ title: '', dept: 'Fleet', assignee: '', due: R.isoToLocalInput(new Date(nowMs() + 24 * R.HOUR).toISOString(), R.EASTERN), instructions: '', high: false }); setAdd(true); }}>New task</Button> : null}
    >
      <div className="px-4 py-2">
        <Seg size="sm" ariaLabel="Task filter" value={filter} onChange={(v) => v && setFilter(v)} options={[
          { v: 'open', label: `Open ${all.filter(isOpen).length}` },
          { v: 'overdue', label: `Overdue ${all.filter((t) => t.overdue).length}` },
          { v: 'done', label: `Done ${all.filter((t) => t.status === 'done').length}` },
          { v: 'all', label: 'All' },
        ]} />
      </div>
      {add ? (
        <div className="flex flex-col gap-3 border-y border-nw-border bg-nw-subtle px-4 py-3" id="task-form">
          <Field label="Task" htmlFor="t-title"><NInput id="t-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Get a second repair estimate" /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Department" htmlFor="t-dept"><NSelect id="t-dept" value={form.dept} onChange={(v) => setForm({ ...form, dept: v as (typeof DEPTS)[number], assignee: '' })}>{DEPTS.map((x) => <option key={x} value={x}>{x}</option>)}</NSelect></Field>
            <Field label="Assignee" htmlFor="t-assignee">
              <NSelect id="t-assignee" value={form.assignee} onChange={(v) => setForm({ ...form, assignee: v })}>
                <option value="">Department default</option>
                {d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NSelect>
            </Field>
            <Field label="Due (Eastern)" htmlFor="t-due" error={dueConv && !dueConv.ok ? dueConv.message : undefined}><NInput id="t-due" type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} /></Field>
          </div>
          <Field label="Instructions" htmlFor="t-ins"><NInput id="t-ins" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Optional — what done looks like" /></Field>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="mr-auto inline-flex items-center gap-1.5 text-xs text-nw-text-2"><input type="checkbox" checked={form.high} onChange={(e) => setForm({ ...form, high: e.target.checked })} />High priority</label>
            <Button size="sm" variant="secondary" onClick={() => setAdd(false)}>Cancel</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={form.title.trim().length < 3 || !dueConv?.ok}
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  { accidentId: c.id, title: form.title.trim(), dept: form.dept, ...(form.assignee ? { assigneeId: form.assignee } : {}), dueAt: dueConv && dueConv.ok ? dueConv.iso : '', instructions: form.instructions || null, priority: form.high ? 'high' : 'normal' },
                  { onSuccess: () => setAdd(false) },
                )
              }
            >
              Assign
            </Button>
          </div>
        </div>
      ) : null}
      {tasks.isLoading ? <Loading /> : list.length === 0 ? <Empty title={filter === 'overdue' ? 'Nothing overdue' : filter === 'done' ? 'No completed tasks yet' : 'No open tasks'} /> : (
        <ul className="divide-y divide-nw-border">
          {list.map((t) => {
            const open = isOpen(t);
            return (
              <li key={t.id} className={cn('flex gap-2 px-4 py-2', t.overdue && open ? 'bg-nw-urgent-bg' : '')} data-task={t.title}>
                <button
                  type="button"
                  aria-label={open ? 'Mark complete' : 'Reopen'}
                  disabled={!d.permissions.edit || Boolean(t.requestKind)}
                  title={t.requestKind ? 'Dispatch confirms a request' : undefined}
                  onClick={() => patchTask.mutate({ id: t.id, body: { version: t.version, status: open ? 'done' : 'open' } })}
                  className={cn('mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] ring-1 ring-nw-border-strong', open ? 'bg-nw-panel' : 'bg-nw-done-bg text-nw-done-icon')}
                >
                  {!open ? <Check className="size-3" aria-hidden /> : null}
                </button>
                <div className="min-w-0 flex-1">
                  <button type="button" className="flex items-center gap-1 text-left text-sm font-semibold text-nw-text" onClick={() => setExp(exp === t.id ? null : t.id)}>
                    {exp === t.id ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                    {t.priority === 'high' && open ? <ToneBadge tone="warning">High</ToneBadge> : null}
                    {t.title}
                  </button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-nw-text-3">
                    <DeptChip dept={t.dept} />
                    <Person name={t.assignee?.name} />
                    {open ? <DueText iso={t.dueAt} tz={c.tz} /> : <span>Done {R.fmtShort(t.completedAt ?? undefined, R.EASTERN, nowMs())} by {t.completedBy}</span>}
                    {t.autoRule ? <span className="rounded-[5px] bg-nw-subtle px-1.5">Auto: {t.autoRule}</span> : null}
                    {t.requestKind ? <ToneBadge tone="moving">{t.confirmedAt ? 'Confirmed' : 'Request to Dispatch'}</ToneBadge> : null}
                  </div>
                  {exp === t.id ? (
                    <div className="mt-2 flex flex-col gap-2 text-sm">
                      {t.instructions ? <p className="text-nw-text-2">{t.instructions}</p> : null}
                      {t.updates.map((u) => (
                        <div key={u.id} className="text-xs text-nw-text-2"><b>{u.by}</b> · {u.text} <span className="text-nw-text-3">{R.fmtShortDateTime(u.at, R.EASTERN, nowMs())}</span></div>
                      ))}
                      <div className="flex gap-2">
                        <NInput placeholder="Add an update…" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Update" />
                        <Button size="sm" variant="secondary" disabled={!note.trim()} onClick={() => post.mutate({ id: t.id, text: note.trim() }, { onSuccess: () => setNote('') })}>Post</Button>
                      </div>
                      {d.permissions.edit && !t.requestKind ? (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-nw-text-2">
                          Status
                          <NSelect ariaLabel="Task status" className="w-auto" value={t.status} onChange={(s) => patchTask.mutate({ id: t.id, body: { version: t.version, status: s as A.PatchTaskInput['status'], ...(s === 'blocked' ? { blockedReason: note.trim() || 'Waiting' } : {}) } })}>
                            {['open', 'in_progress', 'blocked', 'done', 'cancelled'].map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
                          </NSelect>
                          Reassign
                          <NSelect ariaLabel="Assignee" className="w-auto" value={t.assignee?.id ?? ''} onChange={(a) => a && patchTask.mutate({ id: t.id, body: { version: t.version, assigneeId: a } })}>
                            <option value="">Pick…</option>
                            {d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </NSelect>
                        </div>
                      ) : null}
                      {t.requestKind && open && d.permissions.confirm ? (
                        <Button size="sm" variant="primary" icon={<Check />} onClick={() => confirm.mutate({ id: t.id, version: t.version })}>Confirm done (Dispatch)</Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function TimelinePanel({ d }: { d: D }) {
  const c = d.case;
  const events = useCaseEvents(c.id);
  const [src, setSrc] = useState('all');
  const [changes, setChanges] = useState(true);
  const [log, setLog] = useState(false);
  const [v, setV] = useState({ text: '', at: '', source: 'Safety' as A.LogEventInput['source'], restricted: false });
  const write = useAccWrite((b: A.LogEventInput) => accApi.post(c.id, 'events', b), 'Event added to the timeline');
  const all = events.data ?? [];
  const sources = [...new Set(all.map((e) => e.source))];
  const list = all.filter((e) => (src === 'all' || e.source === src) && (changes || e.kind !== 'change')).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const dayOf = (iso: string) => R.fmtDate(iso, c.tz);
  return (
    <Panel
      title="Timeline"
      sub={`Event times in incident local time (${R.tzAbbr(c.occurredAt, c.tz)})`}
      pad={false}
      id="timeline"
      actions={d.permissions.edit ? <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => { setV({ text: '', at: R.isoToLocalInput(new Date(nowMs()).toISOString(), c.tz), source: 'Safety', restricted: false }); setLog(true); }}>Log event</Button> : null}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2">
        {['all', ...sources].map((s) => (
          <button key={s} type="button" onClick={() => setSrc(s)} className={cn('h-6 rounded-full px-2.5 text-xs font-semibold', src === s ? 'bg-nw-accent text-nw-on-accent' : 'bg-nw-subtle text-nw-text-2')}>
            {s === 'all' ? 'All sources' : s}
          </button>
        ))}
        <label className="ml-auto inline-flex items-center gap-1 text-xs text-nw-text-2"><input type="checkbox" checked={changes} onChange={(e) => setChanges(e.target.checked)} />Include field changes</label>
      </div>
      {events.isLoading ? <Loading /> : (
        <ol className="px-4 pb-3">
          {list.map((e, i) => {
            const day = dayOf(e.occurredAt);
            const showDay = i === 0 || day !== dayOf(list[i - 1]!.occurredAt);
            const late = Date.parse(e.loggedAt) - Date.parse(e.occurredAt);
            return (
              <Fragment key={e.id}>
                {showDay ? <li className="mt-2 mb-1 text-xs font-bold text-nw-text-3">{day}</li> : null}
                <li className="flex gap-3 border-l-2 border-nw-border py-1.5 pl-3">
                  <span className="w-16 shrink-0 text-xs text-nw-text-3">{R.fmtTime(e.occurredAt, c.tz, false)}</span>
                  <span className="min-w-0 text-sm text-nw-text">
                    {e.restricted && e.text === 'Restricted entry' ? <Restricted text="Restricted entry" /> : e.text}
                    <span className="block text-xs text-nw-text-3">
                      {e.source}{e.actorName ? ` · ${e.actorName}` : ''}
                      {late > 15 * 60_000 ? ` · logged ${R.durationLabel(late)} later (${R.fmtShortDateTime(e.loggedAt, R.EASTERN, nowMs())})` : ''}
                    </span>
                  </span>
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}
      <Modal
        open={log}
        onOpenChange={setLog}
        size="sm"
        title="Log an event"
        description="Use the time it happened; NeWay also records when you entered it."
        footer={<><Button variant="secondary" onClick={() => setLog(false)}>Cancel</Button><Button variant="primary" disabled={v.text.trim().length < 3 || !v.at} loading={write.isPending} onClick={() => write.mutate({ text: v.text.trim(), occurredAtLocal: v.at, source: v.source, ...(v.restricted ? { restricted: true } : {}) }, { onSuccess: () => setLog(false) })}>Add</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="What happened" htmlFor="ev-text"><NInput id="ev-text" value={v.text} onChange={(e) => setV({ ...v, text: e.target.value })} placeholder="e.g. Driver called Safety" /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="When (incident local time)" htmlFor="ev-at"><NInput id="ev-at" type="datetime-local" value={v.at} onChange={(e) => setV({ ...v, at: e.target.value })} /></Field>
            <Field label="Source" htmlFor="ev-src"><NSelect id="ev-src" value={v.source} onChange={(s) => setV({ ...v, source: s as A.LogEventInput['source'] })}>{['Safety', 'Fleet', 'Dispatch', 'Claims', 'Accounting', 'Driver', 'Management'].map((x) => <option key={x} value={x}>{x}</option>)}</NSelect></Field>
          </div>
          {d.permissions.restricted ? <label className="inline-flex items-center gap-1.5 text-xs text-nw-text-2"><input type="checkbox" checked={v.restricted} onChange={(e) => setV({ ...v, restricted: e.target.checked })} />Restricted entry (medical, legal, test results)</label> : null}
        </div>
      </Modal>
    </Panel>
  );
}

/** Overview Money card (SPEC §1.4 row 2): cash only, from the one ledger; lost revenue apart; restricted claims left out. */
function MoneyCard({ d }: { d: D }) {
  const f = d.computed.money.financials;
  if (!f) return <Restricted text="Repair costs are not shown to your role" />;
  return (
    <dl>
      <KV k="Spent so far">{R.money(f.actualCents)}</KV>
      <KV k="Recovered">{R.money(f.recoveredCents)}</KV>
      <KV k="Still expected" hint="+ costs to come · − recoveries to come">+{R.money(f.estimateCents)} · −{R.money(f.expectedCents)}</KV>
      <KV k="Projected net cost">
        <b className="text-nw-text">{R.money(f.projectedNetCents)}</b> {f.finalized ? <ToneBadge tone="done">Final</ToneBadge> : null}
      </KV>
      <KV k="Insurer reserves" hint="The insurer’s exposure, not our cost">{R.money(f.exposureCents)}</KV>
      <KV k="Lost revenue (not cash)" hint={`${f.lostRevenue.days.toFixed(2)} truck-days × ${R.money(f.lostRevenue.perDayCents)}/day${f.lostRevenue.fallback ? ' (fallback rate)' : ''}`}>{R.money(f.lostRevenue.amountCents)}</KV>
      {f.restrictedClaimsExcluded ? <KV k="Restricted">Excludes {R.plural(f.restrictedClaimsExcluded, 'restricted claim')}</KV> : null}
    </dl>
  );
}
