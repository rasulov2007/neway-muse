import { ArrowDownLeft, ArrowUpRight, ExternalLink, Link2, Lock, Package, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Drawer, Modal, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { accApi, useAccWrite, useBoard, usePickers } from './api';
import { centsToDollars, claimsApi, dollarsToCents, useClaim } from './claims-api';
import { claimStatusTone } from './labels';
import { DeptChip, DueText, Empty, Field, KV, LoadError, Loading, NInput, NSelect, Panel, Person, Restricted, ToneBadge } from './ui';

/**
 * Claim drawer (SPEC §1.5, prototype screens/Claims.tsx ClaimDrawer): status, linked accident, parties, money (from
 * payments), checklist, next follow-up, correspondence and tasks. Restricted claims show a lock instead of the
 * fields the server withheld. The driver charge / notice / Accounting flows stay on the claim file page.
 */
export function ClaimDrawer({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const q = useClaim(claimId);
  const d = q.data;
  const k = d?.claim;
  return (
    <Drawer
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="lg"
      title={k ? <span>{k.number} <span className="font-semibold text-nw-text-3">· {R.CLAIM_TYPE_LABEL[k.type]}</span></span> : 'Claim'}
      description={k?.title}
      headerExtra={d && k ? <StatusSelect d={d} /> : null}
    >
      {q.isLoading ? <Loading /> : q.error || !d || !k ? <LoadError error={q.error ?? new Error('Not found')} /> : (
        <div className="flex flex-col gap-3" id="claim-drawer">
          {d.accident ? (
            <div className="flex flex-wrap items-start gap-2 rounded-[10px] bg-nw-subtle px-3 py-2 text-sm" id="linked-accident">
              <Link2 className="mt-0.5 size-4 text-nw-text-3" aria-hidden />
              <span className="min-w-0 flex-1">
                <b>Linked to {d.accident.number}</b> · {R.fmtShort(d.accident.occurredAt, d.accident.tz, nowMs())}
                {d.accident.truckUnit ? ` · Truck ${d.accident.truckUnit}` : ''}
                {d.accident.driverName ? ` · ${d.accident.driverName}` : ''} · {R.STAGE_LABEL[d.accident.stage]}
                <span className="block text-xs text-nw-text-3">
                  {d.accident.claims.length > 1 ? `${d.accident.claims.length} claims on this accident: ${d.accident.claims.map((x) => x.number).join(', ')}` : 'Only claim on this accident'}
                </span>
              </span>
              <Button size="sm" variant="secondary" id="open-linked" onClick={() => { onClose(); void navigate({ to: '/safety/accidents/$accidentId', params: { accidentId: d.accident!.id }, search: { tab: 'claims' } } as never); }}>
                Open accident
              </Button>
            </div>
          ) : (
            <StandaloneBanner d={d} />
          )}
          {/* Keyed on the claim version: a saved change (here or on another screen) resets the local form state. */}
          <Parties key={`p-${d.version}`} d={d} />
          <Money key={`m-${d.version}`} d={d} />
          <Panel title="Documents" sub={`${d.documents.filter((x) => x.received).length} of ${d.documents.length} received`} id="claim-docs">
            <DocList d={d} />
          </Panel>
          <FollowUp d={d} />
          <Correspondence d={d} />
          <ClaimTasks d={d} />
          <Panel title="Driver charge & Accounting" sub="The existing claim file keeps the driver-charge, driver-notice and Accounting-approval flows">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-nw-text-2">
              <span>
                {d.legacy.driverCharge ? `${d.legacy.driverCharge.number} · ${d.legacy.driverCharge.state.replace(/_/g, ' ')} · ${R.money(d.legacy.driverCharge.amountCents)}` : 'No driver charge on this claim'}
                {d.legacy.liabilityParty ? ` · liability: ${d.legacy.liabilityParty.replace(/_/g, ' ')}` : ''}
              </span>
              <Button size="sm" variant="secondary" icon={<ExternalLink />} onClick={() => void navigate({ to: '/safety/claims/$claimId', params: { claimId: k.id } })}>
                Open claim file
              </Button>
            </div>
          </Panel>
        </div>
      )}
    </Drawer>
  );
}

function StatusSelect({ d }: { d: A.ClaimDetailResponse }) {
  const k = d.claim;
  const write = useAccWrite((status: R.ClaimStatus) => claimsApi.patch(k.id, { version: d.version, status }), (_r, s) => `${k.number}: ${s}${d.accident ? ` · ${d.accident.number} updated` : ''}`);
  return (
    <span className="inline-flex items-center gap-2">
      <ToneBadge tone={claimStatusTone(k.status)}>{k.status}</ToneBadge>
      {d.permissions.edit ? (
        <NSelect id="claim-status" ariaLabel="Claim status" className="h-8 w-auto" value={k.status} disabled={write.isPending} onChange={(v) => write.mutate(v as R.ClaimStatus)}>
          {R.CLAIM_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </NSelect>
      ) : null}
      {k.restricted ? <Lock className="size-4 text-nw-text-3" aria-label="Restricted claim" /> : null}
    </span>
  );
}

function StandaloneBanner({ d }: { d: A.ClaimDetailResponse }) {
  const k = d.claim;
  const [to, setTo] = useState('');
  const cases = useBoard({ chip: 'all', range: '12m', pageSize: 200 });
  const link = useAccWrite((accidentId: string) => claimsApi.link(k.id, { version: d.version, accidentId }), 'Claim linked to the accident');
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-[10px] bg-nw-subtle px-3 py-2 text-sm">
      <Package className="mt-0.5 size-4 text-nw-text-3" aria-hidden />
      <span className="min-w-0 flex-1">
        <b>Standalone claim</b>
        {k.standaloneKind ? ` · ${k.standaloneKind}` : ''}
        {k.unitLabel ? ` · ${k.unitLabel}` : ''}
        {k.load ? ` · load ${k.load.number}` : ''}
        <span className="block text-xs text-nw-text-3">No accident involved. Link it if one is found later.</span>
      </span>
      {d.permissions.edit ? (
        <span className="flex items-center gap-1.5">
          <NSelect ariaLabel="Link to accident" className="h-8 w-[200px]" value={to} onChange={setTo}>
            <option value="">Link to accident…</option>
            {(cases.data?.items ?? []).filter((r) => !r.isDraft).map((r) => <option key={r.id} value={r.id}>{r.number}{r.truck ? ` · Truck ${r.truck.unit}` : ''}</option>)}
          </NSelect>
          {to ? <Button size="sm" variant="primary" loading={link.isPending} onClick={() => link.mutate(to, { onSuccess: () => setTo('') })}>Link</Button> : null}
        </span>
      ) : null}
    </div>
  );
}

function Parties({ d }: { d: A.ClaimDetailResponse }) {
  const k = d.claim;
  const hidden = d.redacted.length > 0;
  const [no, setNo] = useState(k.insurerClaimNo ?? '');
  const [adj, setAdj] = useState({ name: k.adjuster?.name ?? '', phone: k.adjuster?.phone ?? '', email: k.adjuster?.email ?? '' });
  const save = useAccWrite((body: Omit<A.PatchClaimInput, 'version'>) => claimsApi.patch(k.id, { version: d.version, ...body }), 'Claim saved');
  const dirtyAdj = adj.name !== (k.adjuster?.name ?? '') || adj.phone !== (k.adjuster?.phone ?? '') || adj.email !== (k.adjuster?.email ?? '');
  return (
    <Panel title="Parties" id="claim-parties">
      <dl>
        <KV k="Insurer">{k.insurer || <span className="text-nw-text-3">Not set</span>}</KV>
        <KV k="Insurer claim #">
          {d.permissions.edit ? (
            <span className="flex items-center gap-1.5">
              <NInput id="insurer-no" className="h-8" value={no} placeholder="Add when assigned" onChange={(e) => setNo(e.target.value)} />
              {no !== (k.insurerClaimNo ?? '') ? <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ insurerClaimNo: no.trim() || null })}>Save</Button> : null}
            </span>
          ) : (
            k.insurerClaimNo ?? <span className="text-nw-text-3">Not assigned yet</span>
          )}
        </KV>
        <KV k="Adjuster">
          {hidden ? (
            <Restricted text="Restricted claim — adjuster contact withheld" />
          ) : d.permissions.edit ? (
            <span className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              <NInput className="h-8" aria-label="Adjuster name" placeholder="Name" value={adj.name} onChange={(e) => setAdj({ ...adj, name: e.target.value })} />
              <NInput className="h-8 select-all" aria-label="Adjuster phone" placeholder="Phone" value={adj.phone} onChange={(e) => setAdj({ ...adj, phone: e.target.value })} />
              <NInput className="h-8 select-all" aria-label="Adjuster email" placeholder="Email" value={adj.email} onChange={(e) => setAdj({ ...adj, email: e.target.value })} />
              {dirtyAdj ? <Button size="sm" variant="primary" className="sm:col-span-3 sm:justify-self-end" loading={save.isPending} onClick={() => save.mutate({ adjusterName: adj.name.trim() || null, adjusterPhone: adj.phone.trim() || null, adjusterEmail: adj.email.trim() || null })}>Save adjuster</Button> : null}
            </span>
          ) : k.adjuster ? (
            <span className="select-all">{[k.adjuster.name, k.adjuster.phone, k.adjuster.email].filter(Boolean).join(' · ')}</span>
          ) : (
            <span className="text-nw-text-3">Not assigned yet</span>
          )}
        </KV>
        <KV k={k.type === 'recovery' ? 'Responsible party' : 'Claimant'}>{hidden ? <Restricted /> : (k.type === 'recovery' ? k.responsibleParty : k.claimant) ?? <span className="text-nw-text-3">Not recorded</span>}</KV>
        <KV k="Claim owner"><Person name={k.owner?.name} /></KV>
        <KV k="Opened">
          {R.fmtShortDateTime(k.openedAt, R.EASTERN, nowMs())}
          {k.reportedToInsurerAt ? ` · reported to insurer ${R.fmtShort(k.reportedToInsurerAt, R.EASTERN, nowMs())}` : ''}
        </KV>
        {k.restricted && !hidden && k.restrictedReason ? <KV k="Restricted because">{k.restrictedReason}</KV> : null}
      </dl>
    </Panel>
  );
}

const MONEY_SUB: Record<R.ClaimType, string> = {
  physical_damage: 'Our own damage — the insurer repays the claimed amount less the deductible',
  recovery: 'Money we are recovering from the other party',
  auto_liability: 'The insurer pays the claimant; our share is the deductible',
  cargo: 'The insurer pays the claimant; our share is the deductible',
  workers_comp: 'Injury claim — the insurer pays; our share is the deductible',
};

function Money({ d }: { d: A.ClaimDetailResponse }) {
  const k = d.claim;
  const m = d.money;
  const base = { claimed: centsToDollars(k.claimedCents), reserve: centsToDollars(k.reserveCents), deductible: centsToDollars(k.deductibleCents), settlement: centsToDollars(k.settlementCents) };
  const [amt, setAmt] = useState(base);
  const [pay, setPay] = useState<{ direction: A.PaymentDirection; amount: string; party: string; note: string } | null>(null);
  const [voidFor, setVoidFor] = useState<A.ClaimPaymentView | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const save = useAccWrite(
    () => claimsApi.patch(k.id, { version: d.version, claimedCents: dollarsToCents(amt.claimed), reserveCents: dollarsToCents(amt.reserve), deductibleCents: dollarsToCents(amt.deductible), settlementCents: dollarsToCents(amt.settlement) }),
    'Claim amounts saved — accident costs updated',
  );
  const record = useAccWrite(
    (p: NonNullable<typeof pay>) => claimsApi.payment(k.id, { version: d.version, direction: p.direction, amountCents: dollarsToCents(p.amount) ?? 0, party: p.party.trim(), ...(p.note.trim() ? { note: p.note.trim() } : {}) }),
    'Payment recorded — accident costs updated',
  );
  const voidPay = useAccWrite((p: { id: string; reason: string }) => claimsApi.voidPayment(k.id, p.id, { version: d.version, reason: p.reason }), 'Payment voided — the row is kept');
  const dirty = (Object.keys(base) as (keyof typeof base)[]).some((x) => amt[x] !== base[x]);
  if (!m || !d.payments) {
    return (
      <Panel title="Money" id="claim-money" sub={MONEY_SUB[k.type]}>
        <Restricted text="Restricted claim — reserves, amounts and payments are visible to Safety Managers and the owner" />
      </Panel>
    );
  }
  const own = k.type === 'physical_damage' || k.type === 'recovery';
  return (
    <Panel title="Money" id="claim-money" sub={MONEY_SUB[k.type]}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ['claimed', k.type === 'recovery' ? 'To recover ($)' : 'Claimed ($)', 'amt-claimed'],
            ['reserve', 'Reserve ($)', 'amt-reserve'],
            ['deductible', 'Deductible ($)', 'amt-deductible'],
            ['settlement', 'Settlement ($)', 'amt-settlement'],
          ] as const
        ).map(([key, label, id]) => (
          <Field key={key} label={label} htmlFor={id} hint={key === 'reserve' ? 'Insurer’s estimate' : undefined}>
            <NInput id={id} inputMode="decimal" disabled={!d.permissions.money} value={amt[key]} placeholder="Not known" onChange={(e) => setAmt({ ...amt, [key]: e.target.value })} />
          </Field>
        ))}
      </div>
      {dirty && d.permissions.money ? (
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setAmt(base)}>Undo</Button>
          <Button size="sm" variant="primary" id="save-amounts" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save amounts</Button>
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-nw-subtle p-2 sm:grid-cols-3" id="claim-calc">
        {own ? <Calc label="Still expected to us" v={m.expectedRecoveryCents} /> : null}
        {m.toUsCents > 0 ? <Calc label="Received" v={m.toUsCents} /> : null}
        {!own ? <Calc label="Our share still to pay" v={m.companyEstimateCents} /> : null}
        {!own ? <Calc label="Insurer reserve above deductible" v={m.insurerReserveCents} /> : null}
        {m.insurerPaidCents > 0 ? <Calc label="Insurer paid claimant" v={m.insurerPaidCents} /> : null}
        {m.byUsCents > 0 ? <Calc label="We paid" v={m.byUsCents} /> : null}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs font-bold tracking-wide text-nw-text-2 uppercase">Payments</span>
        {d.permissions.money ? (
          <Button size="sm" variant="ghost" icon={<Plus />} id="record-payment" onClick={() => setPay({ direction: own ? 'to_us' : 'by_insurer_to_claimant', amount: '', party: k.insurer, note: '' })}>
            Record payment
          </Button>
        ) : null}
      </div>
      {d.payments.length === 0 ? (
        <p className="text-xs text-nw-text-3">No payments yet.</p>
      ) : (
        <ul className="mt-1 divide-y divide-nw-border">
          {d.payments.map((p) => (
            <li key={p.id} className={cn('flex items-start gap-2 py-1.5 text-sm', p.voided ? 'text-nw-text-3 line-through' : 'text-nw-text')}>
              {p.direction === 'to_us' ? <ArrowDownLeft className="mt-0.5 size-4 text-nw-done-icon" aria-label="Received" /> : <ArrowUpRight className="mt-0.5 size-4 text-nw-text-3" aria-label="Paid out" />}
              <span className="min-w-0 flex-1">
                <b>{R.money(p.amountCents, { cents: p.amountCents % 100 !== 0 })}</b> ·{' '}
                {p.direction === 'to_us' ? `received from ${p.party}` : p.direction === 'by_us' ? `paid by us${p.note ? ` (${p.note})` : ''}` : `${p.party} paid the claimant`}
                <span className="text-xs text-nw-text-3"> · {R.fmtShort(p.paidAt, R.EASTERN, nowMs())}</span>
                {p.voided ? <span className="block text-xs no-underline">Voided: {p.voided.reason}</span> : null}
              </span>
              {p.accounting && !p.voided ? <ToneBadge tone={p.accounting === 'confirmed' ? 'done' : p.accounting === 'rejected' ? 'urgent' : 'warning'}>{p.accounting === 'pending_review' ? 'Pending Accounting approval' : p.accounting === 'confirmed' ? 'Accounting confirmed' : p.accounting}</ToneBadge> : null}
              {d.permissions.money && !p.voided ? <Button size="sm" variant="ghost" onClick={() => { setVoidFor(p); setVoidReason(''); }}>Void</Button> : null}
            </li>
          ))}
        </ul>
      )}
      {pay ? (
        <Modal
          open
          onOpenChange={(o) => (o ? undefined : setPay(null))}
          size="sm"
          title="Record payment"
          description="Accounting confirms each payment before it posts (existing approval flow)."
          footer={
            <>
              <Button variant="secondary" onClick={() => setPay(null)}>Cancel</Button>
              <Button variant="primary" id="save-payment" disabled={!dollarsToCents(pay.amount) || !pay.party.trim()} loading={record.isPending} onClick={() => record.mutate(pay, { onSuccess: () => setPay(null) })}>Save</Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Field label="Direction" htmlFor="pay-direction">
              <NSelect id="pay-direction" value={pay.direction} onChange={(v) => setPay({ ...pay, direction: v as A.PaymentDirection })}>
                <option value="to_us">Received by us (from insurer or other party)</option>
                <option value="by_insurer_to_claimant">Insurer paid the claimant</option>
                <option value="by_us">Paid by us (deductible or direct settlement)</option>
              </NSelect>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Amount ($)" htmlFor="pay-amount"><NInput id="pay-amount" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
              <Field label="Party" htmlFor="pay-party"><NInput id="pay-party" value={pay.party} onChange={(e) => setPay({ ...pay, party: e.target.value })} /></Field>
            </div>
            <Field label="Note" htmlFor="pay-note"><NInput id="pay-note" value={pay.note} placeholder="e.g. Deductible reimbursement" onChange={(e) => setPay({ ...pay, note: e.target.value })} /></Field>
          </div>
        </Modal>
      ) : null}
      {voidFor ? (
        <Modal
          open
          onOpenChange={(o) => (o ? undefined : setVoidFor(null))}
          size="sm"
          title={`Void the ${R.money(voidFor.amountCents)} payment`}
          description="Payments are never deleted: the row stays, marked void, with your reason."
          footer={
            <>
              <Button variant="secondary" onClick={() => setVoidFor(null)}>Cancel</Button>
              <Button variant="danger" disabled={voidReason.trim().length < 3} loading={voidPay.isPending} onClick={() => voidPay.mutate({ id: voidFor.id, reason: voidReason.trim() }, { onSuccess: () => setVoidFor(null) })}>Void payment</Button>
            </>
          }
        >
          <Field label="Reason" htmlFor="void-reason" required><NInput id="void-reason" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /></Field>
        </Modal>
      ) : null}
    </Panel>
  );
}

function Calc({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-nw-text-3">{label}</span>
      <b className="text-sm text-nw-text">{R.money(v)}</b>
    </div>
  );
}

function DocList({ d }: { d: A.ClaimDetailResponse }) {
  const k = d.claim;
  const toggle = useAccWrite((doc: { id: string; received: boolean; label: string }) => claimsApi.document(k.id, doc.id, { version: d.version, received: doc.received }), (_r, doc) => `${doc.label}: ${doc.received ? 'received' : 'marked missing'}`);
  if (!d.documents.length) return <Empty title="No documents on the checklist" />;
  return (
    <ul className="flex flex-col gap-1.5">
      {d.documents.map((x) => (
        <li key={x.id} className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm text-nw-text">
            <input type="checkbox" className="size-4 accent-[var(--color-nw-accent)]" disabled={!d.permissions.edit || toggle.isPending} checked={x.received} onChange={() => toggle.mutate({ id: x.id, received: !x.received, label: x.label })} />
            {x.label}
          </label>
          {!x.received ? <ToneBadge tone="warning">Outstanding</ToneBadge> : <span className="text-xs text-nw-text-3">{x.receivedAt ? `Received ${R.fmtShort(x.receivedAt, R.EASTERN, nowMs())}` : 'Received'}</span>}
        </li>
      ))}
    </ul>
  );
}

function FollowUp({ d }: { d: A.ClaimDetailResponse }) {
  const k = d.claim;
  const people = usePickers(d.permissions.edit);
  const [edit, setEdit] = useState<{ what: string; at: string; who: string } | null>(null);
  const save = useAccWrite(
    (f: NonNullable<typeof edit>) => {
      const at = R.localToUtc(f.at, R.EASTERN);
      return claimsApi.patch(k.id, { version: d.version, nextFollowUp: { what: f.what.trim(), at: at.ok ? at.iso : new Date(nowMs()).toISOString(), assigneeId: f.who } });
    },
    'Next follow-up saved',
  );
  const fu = k.nextFollowUp;
  return (
    <Panel
      title="Next follow-up"
      id="claim-followup"
      actions={d.permissions.edit ? <Button size="sm" variant="ghost" id="edit-followup" onClick={() => setEdit({ what: fu?.what ?? '', at: R.isoToLocalInput(fu?.at ?? new Date(nowMs() + 72 * R.HOUR).toISOString(), R.EASTERN), who: fu?.assignee?.id ?? k.owner?.id ?? '' })}>Change</Button> : null}
    >
      {fu ? (
        <div className="flex flex-col gap-1">
          <b className="text-sm text-nw-text">{fu.what ?? <Restricted text="Follow-up (restricted)" />}</b>
          <span className="flex flex-wrap items-center gap-2">
            <Person name={fu.assignee?.name} />
            <DueText iso={fu.at} />
          </span>
        </div>
      ) : (
        <span className="text-sm text-nw-text-3">None set</span>
      )}
      {edit ? (
        <div className="mt-3 flex flex-col gap-2 rounded-md bg-nw-subtle p-2">
          <Field label="What" htmlFor="fu-what"><NInput id="fu-what" value={edit.what} onChange={(e) => setEdit({ ...edit, what: e.target.value })} /></Field>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="When (US Eastern)" htmlFor="fu-at"><NInput id="fu-at" type="datetime-local" value={edit.at} onChange={(e) => setEdit({ ...edit, at: e.target.value })} /></Field>
            <Field label="Who" htmlFor="fu-who"><NSelect id="fu-who" value={edit.who} onChange={(v) => setEdit({ ...edit, who: v })}><option value="">Pick a person…</option>{(people.data?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.dept ? ` · ${p.dept}` : ''}</option>)}</NSelect></Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEdit(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={edit.what.trim().length < 2 || !edit.at || !edit.who} loading={save.isPending} onClick={() => save.mutate(edit, { onSuccess: () => setEdit(null) })}>Save</Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function Correspondence({ d }: { d: A.ClaimDetailResponse }) {
  const k = d.claim;
  const [channel, setChannel] = useState<(typeof A.CLAIM_LOG_CHANNELS)[number]>('Email');
  const [text, setText] = useState('');
  const add = useAccWrite(() => claimsApi.log(k.id, { version: d.version, channel, text: text.trim() }), 'Added to the correspondence');
  return (
    <Panel title="Correspondence & notes" id="claim-log">
      {d.log === null ? (
        <Restricted text="Restricted claim — correspondence withheld" />
      ) : (
        <>
          {d.permissions.edit || d.permissions.money ? (
            <div className="flex flex-wrap gap-1.5">
              <NSelect ariaLabel="Channel" className="h-8 w-auto" value={channel} onChange={(v) => setChannel(v as typeof channel)}>
                {(['Email', 'Phone', 'Portal', 'Letter', 'Note'] as const).map((x) => <option key={x}>{x}</option>)}
              </NSelect>
              <NInput id="claim-log-input" className="h-8 min-w-[200px] flex-1" placeholder="What was said or sent…" value={text} onChange={(e) => setText(e.target.value)} />
              <Button size="sm" variant="secondary" disabled={!text.trim()} loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: () => setText('') })}>Add</Button>
            </div>
          ) : null}
          <ul className="mt-2 divide-y divide-nw-border">
            {d.log.map((l) => (
              <li key={l.id} className="flex flex-col gap-0.5 py-1.5">
                <span className="flex items-center gap-2 text-sm text-nw-text"><DeptChip dept={l.channel} />{l.text}</span>
                <span className="text-xs text-nw-text-3">{l.by} · {R.fmtShortDateTime(l.at, R.EASTERN, nowMs())}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function ClaimTasks({ d }: { d: A.ClaimDetailResponse }) {
  const k = d.claim;
  const [form, setForm] = useState<{ title: string; dept: (typeof A.DEPTS)[number]; due: string } | null>(null);
  const create = useAccWrite(
    (f: NonNullable<typeof form>) => {
      const due = R.localToUtc(f.due, R.EASTERN);
      return accApi.createTask({ claimId: k.id, title: f.title.trim(), dept: f.dept, dueAt: due.ok ? due.iso : new Date(nowMs() + 24 * R.HOUR).toISOString() });
    },
    'Task added to the claim',
  );
  const done = useAccWrite((t: A.TaskView) => accApi.patchTask(t.id, { version: t.version, status: t.status === 'done' ? 'open' : 'done' }), (_r, t) => (t.status === 'done' ? 'Task reopened' : 'Task completed'));
  return (
    <Panel
      title="Tasks"
      sub={`${d.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length} open`}
      id="claim-tasks"
      actions={d.permissions.edit ? <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setForm({ title: '', dept: 'Claims', due: R.isoToLocalInput(new Date(nowMs() + 24 * R.HOUR).toISOString(), R.EASTERN) })}>New task</Button> : null}
    >
      {form ? (
        <div className="mb-2 flex flex-col gap-2 rounded-md bg-nw-subtle p-2">
          <Field label="Task" htmlFor="claim-task-title"><NInput id="claim-task-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Department"><NSelect value={form.dept} onChange={(v) => setForm({ ...form, dept: v as typeof form.dept })}>{(['Claims', 'Safety', 'Accounting', 'Fleet', 'Dispatch', 'Management'] as const).map((x) => <option key={x}>{x}</option>)}</NSelect></Field>
            <Field label="Due (US Eastern)"><NInput type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={form.title.trim().length < 3} loading={create.isPending} onClick={() => create.mutate(form, { onSuccess: () => setForm(null) })}>Add task</Button>
          </div>
        </div>
      ) : null}
      {d.tasks.length === 0 ? (
        <Empty title="No tasks on this claim" />
      ) : (
        <ul className="divide-y divide-nw-border">
          {d.tasks.map((t) => (
            <li key={t.id} className={cn('flex items-start gap-2 py-1.5', t.overdue ? 'bg-nw-urgent-bg' : '')}>
              <input type="checkbox" aria-label={`Done: ${t.title}`} className="mt-1 size-4 accent-[var(--color-nw-accent)]" checked={t.status === 'done'} disabled={!d.permissions.edit || done.isPending} onChange={() => done.mutate(t)} />
              <span className="min-w-0 flex-1">
                <span className={cn('text-sm', t.status === 'done' ? 'text-nw-text-3 line-through' : 'text-nw-text')}>{t.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <DeptChip dept={t.dept} />
                  <Person name={t.assignee?.name} />
                  {t.status === 'done' ? <span className="text-xs text-nw-text-3">Done {t.completedAt ? R.fmtShort(t.completedAt, R.EASTERN, nowMs()) : ''}</span> : <DueText iso={t.dueAt} />}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
