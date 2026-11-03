import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { CLAIM_KIND_LABEL, CLAIM_LINE_SHORT, LIABILITY_PARTY_LABEL, type SafetyClaim } from '@neway/shared';
import { Button, DropdownMenu, MenuItem, MenuSeparator, Tabs, TabsContent, cn } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { isEnabled } from '@/lib/feature-flags';
import { formatIsoDate } from '@/lib/format';
import { AccountingPanel, ClaimEditor, DecisionForm, PaymentsPanel, ReasonDialog } from '../ClaimDetailPage';
import { safetyApi, useCan, useClaim, useDriverCharges, useSafetyWrite } from '../api';
import { DocumentsCard, FactList, LoadError, Loading, TimelineCard, VoidDialog, money, td, th } from '../ui';
import { ChargeCard } from './ChargeCard';
import { LiabilityDialog, LogUpdateDialog } from './ChargeDialogs';
import { finOf } from './model';
import { Pill, claimStatusOf } from './parts';

/** Documents a claim of this kind needs before it can close (Claims v2 §6.3, seed checklist). */
const REQUIRED: Record<SafetyClaim['kind'], { kind: string; label: string }[]> = {
  liability: [
    { kind: 'police_report', label: 'Police report' },
    { kind: 'photos', label: 'Photos' },
    { kind: 'repair_estimate', label: 'Repair estimate' },
    { kind: 'invoice', label: 'Final repair invoice' },
    { kind: 'insurer_correspondence', label: 'Insurer acknowledgment' },
  ],
  physical_damage: [
    { kind: 'photos', label: 'Photos' },
    { kind: 'repair_estimate', label: 'Repair estimate' },
    { kind: 'invoice', label: 'Final repair invoice' },
  ],
  cargo: [
    { kind: 'photos', label: 'Photos' },
    { kind: 'invoice', label: 'Commercial invoice' },
    { kind: 'insurer_correspondence', label: 'Claim notice' },
  ],
  workers_comp: [{ kind: 'other', label: 'First report of injury' }],
};

const STEPS = ['Reported', 'Investigation', 'Liability decided', 'Insurance / recovery', 'Settled', 'Financially closed'] as const;

function stepOf(c: SafetyClaim): number {
  if (c.stage === 'closed') return 6;
  if (c.stage === 'payment') return 4;
  if (['submitted', 'insurer_review', 'decision'].includes(c.stage)) return c.liabilityParty ? 3 : 2;
  return c.liabilityParty ? 2 : 1;
}

export function ClaimFilePage({ claimId }: { claimId: string }) {
  const detail = useClaim(claimId);
  const charges = useDriverCharges({ claimId });
  const navigate = useNavigate();
  const canWrite = useCan('safety.manage');
  // With Accident & Claims v2 on, the claim's own facts (status, amounts, payments, follow-ups) are written on the Claims
  // board — one writer per fact. This page keeps who is liable, the driver charge and Accounting's review.
  const v2Writes = isEnabled('accidents_v2');
  const canEditClaim = canWrite && !v2Writes;
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState<null | 'update' | 'liability' | 'edit' | 'close' | 'void'>(null);
  const c = detail.data?.record;
  const patch = useSafetyWrite((body: Record<string, unknown>) => safetyApi.patch<SafetyClaim>(`/claims/${claimId}`, { version: c?.version, ...body }), 'Saved');
  const close = useSafetyWrite((reason: string) => safetyApi.post<SafetyClaim>(`/claims/${claimId}/close`, { version: c?.version, reason }), 'Claim closed');
  const voidIt = useSafetyWrite((reason: string) => safetyApi.post<SafetyClaim>(`/claims/${claimId}/void`, { version: c?.version, reason }), 'Voided');

  if (detail.isLoading) return <Loading />;
  if (detail.error || !c || !detail.data) return <LoadError error={detail.error ?? new Error('Not found')} />;

  const list = charges.data ?? [];
  const live = list.find((x) => !['waived', 'rejected', 'cancelled'].includes(x.state)) ?? null;
  const f = finOf(c, live);
  const status = claimStatusOf(c);
  const step = stepOf(c);
  const closed = c.stage === 'closed' || Boolean(c.voidedAt);
  const today = companyToday();
  const overdue = Boolean(c.nextActionDueOn && c.nextActionDueOn < today);
  const docs = detail.data.documents;
  const missing = REQUIRED[c.kind].filter((r) => !docs.some((d) => d.kind === r.kind));
  const updatedDays = Math.max(0, Math.floor((Date.now() - Date.parse(c.lastActivityAt)) / 86_400_000));
  const lastEvent = detail.data.timeline[0];

  return (
    <div className="flex w-full flex-col gap-4" data-testid="claim-file">
      {modal === 'update' ? <LogUpdateDialog claim={c} onClose={() => setModal(null)} /> : null}
      {modal === 'liability' ? <LiabilityDialog claim={c} onClose={() => setModal(null)} /> : null}
      {modal === 'edit' ? <ClaimEditor open onOpenChange={(o) => !o && setModal(null)} claim={c} onSave={(b) => patch.mutate(b, { onSuccess: () => setModal(null) })} saving={patch.isPending} /> : null}
      <ReasonDialog open={modal === 'close'} onOpenChange={(o) => !o && setModal(null)} title={`Close ${c.number}`} label="Why is it closed? (settled, withdrawn, …)" saving={close.isPending} onConfirm={(r) => close.mutate(r, { onSuccess: () => setModal(null) })} />
      <VoidDialog open={modal === 'void'} onOpenChange={(o) => !o && setModal(null)} what={c.number} saving={voidIt.isPending} onVoid={(r) => voidIt.mutate(r, { onSuccess: () => void navigate({ to: '/safety/claims' }) })} />

      <div className="text-xs text-nw-text-3">
        <Link to="/safety/claims" className="underline">
          Claims
        </Link>{' '}
        / {c.number}
      </div>

      {v2Writes ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-info-border bg-info-soft px-4 py-3 text-[13px] text-info-text" data-testid="claim-file-v2-note">
          <span className="min-w-0 flex-1">Status, amounts, payments and follow-ups of this claim are kept on the Claims board. Liability, the driver charge and Accounting stay here.</span>
          <Link to="/safety/claims" search={{ claim: c.id } as never} className="font-semibold underline">
            Open on the Claims board
          </Link>
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] font-extrabold tracking-[-.02em] text-nw-text">{c.number}</h1>
              <Pill tone={status.tone}>{status.label}</Pill>
              <Pill tone="neutral">
                {CLAIM_KIND_LABEL[c.kind]}
                {c.liabilityParty ? ` · ${LIABILITY_PARTY_LABEL[c.liabilityParty].toLowerCase()}${c.liabilityParty === 'our_driver' ? ' at fault' : ''}` : ''}
              </Pill>
              {c.isTest ? <Pill tone="neutral">Test</Pill> : null}
            </div>
            <p className="mt-0.5 text-xs text-nw-text-3">
              {formatIsoDate(c.openedOn)}
              {c.accidentNumber ? ` · ${c.accidentNumber}` : ''} · owner {c.ownerName ?? 'unassigned'} · updated {updatedDays === 0 ? 'today' : `${updatedDays}d ago`}
            </p>
          </div>
          {canWrite && !c.voidedAt ? (
            <div className="flex flex-wrap gap-2">
              {canEditClaim ? (
                <Button size="sm" variant="outline" onClick={() => setModal('update')}>
                  Add update
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => setModal('liability')} data-testid="set-liability">
                Liability
              </Button>
              {canEditClaim ? (
              <DropdownMenu trigger={<Button size="sm" variant="outline">More</Button>}>
                {!closed ? <MenuItem onSelect={() => setModal('edit')}>Edit details and amounts</MenuItem> : null}
                {!closed ? <MenuItem onSelect={() => setModal('close')}>Close claim…</MenuItem> : null}
                <MenuSeparator />
                <MenuItem onSelect={() => setModal('void')}>Void (entered in error)…</MenuItem>
              </DropdownMenu>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* The six steps (Claims v2 §3.1). */}
        <ol className="mt-4 grid grid-cols-6 px-4" aria-label="Claim progress">
          {STEPS.map((s, i) => {
            const done = i < step;
            const current = i === step && !closed;
            return (
              <li key={s} className="relative flex flex-col items-start">
                <span className="flex w-full items-center">
                  <span className={cn('z-10 size-3.5 shrink-0 rounded-full border-2', done ? 'border-nw-accent bg-nw-accent' : current ? 'border-nw-accent bg-nw-panel' : 'border-nw-border-strong bg-nw-panel')} aria-hidden />
                  {i < STEPS.length - 1 ? <span className={cn('h-0.5 flex-1', done ? 'bg-nw-accent' : 'bg-nw-border')} aria-hidden /> : null}
                </span>
                <span className={cn('mt-1 text-[12px]', current ? 'font-bold text-nw-text' : done ? 'text-nw-text-2' : 'text-nw-text-3')}>{s}</span>
              </li>
            );
          })}
        </ol>

        {/* The four answers. */}
        <div className="mt-3 grid border-t border-nw-border sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-nw-border">
          <Answer label="What happened">{c.description || '—'}</Answer>
          <Answer label="Who is responsible" sub={c.driverName ? `${c.driverName}${c.liabilityPct !== null && c.liabilityParty === 'shared' ? ` · ${c.liabilityPct}%` : ''}` : undefined}>
            {c.liabilityParty ? LIABILITY_PARTY_LABEL[c.liabilityParty] : 'Not decided'}
          </Answer>
          <Answer label="Financial exposure" sub={`${money(f.outstanding)} still to come in`}>
            {money(f.gross)} gross · {money(f.net)} projected net
          </Answer>
          <Answer label="Done so far" sub={`${detail.data.timeline.length} logged actions`}>
            {lastEvent ? lastEvent.summary : '—'}
          </Answer>
        </div>

        {!closed ? (
          <div className={cn('flex flex-wrap items-center gap-3 border-t px-4 py-3', overdue ? 'border-nw-warning-border bg-nw-warning-bg' : 'border-nw-border bg-nw-subtle')}>
            <span className={cn('text-[11px] font-bold tracking-[.06em] uppercase', overdue ? 'text-nw-warning-text' : 'text-nw-text-3')}>{overdue ? 'Overdue next action' : 'Next action'}</span>
            <span className="min-w-0 flex-1 text-[14px] font-semibold text-nw-text">{c.nextAction ?? 'None set'}</span>
            <span className="text-xs text-nw-text-3">
              {c.ownerName ?? 'Unassigned'}
              {c.nextActionDueOn ? ` · due ${formatIsoDate(c.nextActionDueOn)}` : ''}
            </span>
            {canEditClaim ? (
              <Button size="sm" variant="outline" onClick={() => setModal('update')} data-testid="log-update">
                Log update / set next
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'money', label: 'Money' },
          { value: 'documents', label: `Documents (${REQUIRED[c.kind].length - missing.length}/${REQUIRED[c.kind].length})` },
          { value: 'timeline', label: `Timeline (${detail.data.timeline.length})` },
        ]}
      >
        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-4">
              <Card title="What happened">
                <p className="mb-3 text-sm text-nw-text">{c.description || 'No description yet.'}</p>
                <FactList
                  rows={[
                    ['Opened', formatIsoDate(c.openedOn)],
                    ['Incident', c.accidentId ? <Link to="/safety/accidents/$accidentId" params={{ accidentId: c.accidentId }} className="font-semibold text-nw-accent-ink underline">{c.accidentNumber}</Link> : '—'],
                    ['Driver', c.driverName ?? '—'],
                    ['Truck', c.truckNumber ? `Unit ${c.truckNumber}` : '—'],
                    ['Load', c.loadNumber ?? '—'],
                    ['Insurer / adjuster', [c.insurer, c.adjusterName, c.adjusterPhone, c.adjusterEmail].filter(Boolean).join(' · ') || '—'],
                    ['Fault / liability', c.liabilityParty ? `${LIABILITY_PARTY_LABEL[c.liabilityParty]}${c.liabilityPct !== null ? ` · ${c.liabilityPct}%` : ''}` : 'Not decided'],
                  ]}
                />
              </Card>
              <Card title="Claim lines" note="One incident, many claims">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse">
                    <thead className="bg-nw-subtle">
                      <tr>
                        <th className={th}>Line</th>
                        <th className={th}>Insurer / party</th>
                        <th className={th}>Reference</th>
                        <th className={th}>Status</th>
                        <th className={cn(th, 'text-right')}>Estimate</th>
                        <th className={cn(th, 'text-right')}>Deductible</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-nw-border">
                      {c.lines.length === 0 ? (
                        <tr>
                          <td className={cn(td, 'font-semibold')}>{CLAIM_KIND_LABEL[c.kind]}</td>
                          <td className={td}>{c.insurer ?? '—'}</td>
                          <td className={td}>{c.insurerReference ?? c.policyNumber ?? '—'}</td>
                          <td className={td}>
                            <Pill tone={status.tone}>{c.decision ? c.decision.replace(/_/g, ' ') : status.label}</Pill>
                          </td>
                          <td className={cn(td, 'tabular text-right')}>{money(c.claimedCents)}</td>
                          <td className={cn(td, 'tabular text-right')}>{money(c.deductibleCents)}</td>
                        </tr>
                      ) : (
                        c.lines.map((l, i) => (
                          <tr key={l.id}>
                            <td className={cn(td, 'font-semibold')}>{CLAIM_LINE_SHORT[l.kind]}</td>
                            <td className={td}>{l.insurer ?? c.insurer ?? '—'}</td>
                            <td className={td}>{c.insurerReference ?? c.policyNumber ?? '—'}</td>
                            <td className={td}>
                              <Pill tone={i === 0 ? status.tone : 'neutral'}>{i === 0 ? (c.decision ? c.decision.replace(/_/g, ' ') : status.label) : 'Not filed'}</Pill>
                            </td>
                            <td className={cn(td, 'tabular text-right')}>{l.reserveCents === null ? (i === 0 ? money(c.claimedCents) : 'Unreserved') : money(l.reserveCents)}</td>
                            <td className={cn(td, 'tabular text-right')}>{i === 0 ? money(c.deductibleCents) : '—'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {canEditClaim && !closed && (c.stage === 'decision' || c.stage === 'insurer_review') ? <DecisionForm claim={c} onSave={(b) => patch.mutate(b)} saving={patch.isPending} /> : null}
              </Card>
            </div>
            <div className="flex flex-col gap-4">
              <Card title="Financial position">
                <div className="grid grid-cols-3 overflow-hidden rounded-[10px] border border-nw-border">
                  <Figure label="Gross loss" value={money(f.gross)} />
                  <Figure label="Company paid" value={money(f.companyPaid)} />
                  <Figure label="Insurance paid" value={money(f.insurancePaid)} />
                  <Figure label="Insurance expected" value={money(f.insuranceExpected)} />
                  <Figure label="To recover" value={money(f.toRecover)} />
                  <Figure label="Projected net cost" value={money(f.net)} />
                </div>
              </Card>
              <ChargeCard claim={c} charges={list} />
              {missing.length > 0 ? (
                <div className="rounded-[12px] border border-nw-warning-border bg-nw-warning-bg px-4 py-3 text-[13px] text-nw-warning-text">
                  <b>Missing for this claim type:</b> {missing.map((m) => m.label).join(', ')}
                </div>
              ) : null}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="money" className="pt-4">
          <div className="flex flex-col gap-4">
            <Card title="Claim ledger" note="Read from the payments and the driver charge; nothing is copied">
              <Ledger claim={c} charges={list} />
            </Card>
            <PaymentsPanel claim={c} canWrite={canEditClaim && !closed} withForm />
            <AccountingPanel entries={c.accountingEntries} />
          </div>
        </TabsContent>
        <TabsContent value="documents" className="pt-4">
          {missing.length > 0 ? <p className="mb-3 text-sm text-nw-warning-text">Missing: {missing.map((m) => m.label).join(', ')}</p> : null}
          <DocumentsCard caseType="claim" caseId={c.id} documents={docs} kinds={['police_report', 'photos', 'repair_estimate', 'invoice', 'insurer_correspondence', 'other']} />
        </TabsContent>
        <TabsContent value="timeline" className="pt-4">
          <TimelineCard entries={detail.data.timeline} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Answer({ label, children, sub }: { label: string; children: React.ReactNode; sub?: string }) {
  return (
    <div className="border-b border-nw-border px-4 py-3 lg:border-b-0">
      <div className="text-[11px] font-bold tracking-[.06em] text-nw-text-3 uppercase">{label}</div>
      <div className="mt-1 text-[14px] font-semibold text-nw-text">{children}</div>
      {sub ? <div className="text-xs text-nw-text-3">{sub}</div> : null}
    </div>
  );
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[12px] border border-nw-border bg-nw-panel">
      <header className="flex items-center justify-between gap-2 border-b border-nw-border px-4 py-3">
        <h2 className="text-[15px] font-bold text-nw-text">{title}</h2>
        {note ? <span className="text-xs text-nw-text-3">{note}</span> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-b border-nw-border px-3 py-3 [&:nth-child(3n)]:border-r-0 [&:nth-child(n+4)]:border-b-0">
      <div className="text-[11.5px] text-nw-text-2">{label}</div>
      <div className="tabular mt-2 text-[18px] font-extrabold text-nw-text">{value}</div>
    </div>
  );
}

function Ledger({ claim: c, charges }: { claim: SafetyClaim; charges: import('@neway/shared').DriverCharge[] }) {
  const rows: { at: string; entry: string; source: string; out: number; in: number }[] = [];
  if (c.claimedCents) rows.push({ at: c.openedOn, entry: 'Gross loss (claimed)', source: CLAIM_KIND_LABEL[c.kind], out: c.claimedCents, in: 0 });
  for (const p of c.payments.filter((x) => !x.voidedAt)) rows.push({ at: p.receivedOn, entry: 'Insurer payment', source: [c.insurer, p.reference].filter(Boolean).join(' · ') || 'Insurer', out: 0, in: p.amountCents });
  for (const ch of charges)
    for (const l of ch.recoveryLog.filter((x) => !x.reversed)) rows.push({ at: l.at.slice(0, 10), entry: `Driver recovery · ${ch.number}`, source: l.label, out: 0, in: l.cents });
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const out = rows.reduce((s, r) => s + r.out, 0);
  const inn = rows.reduce((s, r) => s + r.in, 0);
  if (rows.length === 0) return <p className="text-sm text-nw-text-3">No money recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] border-collapse">
        <thead className="bg-nw-subtle">
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Entry</th>
            <th className={th}>Source</th>
            <th className={cn(th, 'text-right')}>Out</th>
            <th className={cn(th, 'text-right')}>In</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-nw-border">
          {rows.map((r, i) => (
            <tr key={i}>
              <td className={td}>{formatIsoDate(r.at)}</td>
              <td className={td}>{r.entry}</td>
              <td className={td}>{r.source}</td>
              <td className={cn(td, 'tabular text-right')}>{r.out ? money(r.out) : ''}</td>
              <td className={cn(td, 'tabular text-right')}>{r.in ? money(r.in) : ''}</td>
            </tr>
          ))}
          <tr className="bg-nw-subtle font-bold">
            <td className={td} colSpan={3}>
              Total · outstanding {money(Math.max(0, out - inn))}
            </td>
            <td className={cn(td, 'tabular text-right')}>{money(out)}</td>
            <td className={cn(td, 'tabular text-right')}>{money(inn)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-nw-text-3">AP bills, work orders and AR receipts tagged to the claim join this ledger in phase 2.</p>
    </div>
  );
}
