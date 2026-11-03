import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, ListChecks, Receipt, ShieldCheck, Wallet } from 'lucide-react';
import { useState } from 'react';
import {
  ACCOUNTING_ENTRY_KIND_LABEL,
  CLAIM_DECISIONS,
  CLAIM_KIND_LABEL,
  CLAIM_STAGES,
  CLAIM_STAGE_LABEL,
  type ClaimDecision,
  type SafetyAccountingEntry,
  type SafetyClaim,
} from '@neway/shared';
import { Button, Card, DatePicker, DropdownMenu, FormField, Input, MenuItem, MenuSeparator, Modal, Select, StatusBadge, Tabs, TabsContent, Textarea } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { claimStageStatus } from './ClaimsPage';
import { safetyApi, useCan, useClaim, useSafetyWrite } from './api';
import { CaseStepper, DocumentsCard, FactList, LoadError, Loading, NextActionCard, Panel, TimelineCard, VoidDialog, WorkEditor, money, td, th } from './ui';

const DECISION_LABEL: Record<ClaimDecision, string> = { approved: 'Approved', partially_approved: 'Partially approved', denied: 'Denied' };

/** One claim, as the owner's mockup draws it: who and what, the stepper, the money, the next action. */
export function ClaimDetailV2Page({ claimId }: { claimId: string }) {
  const detail = useClaim(claimId);
  const navigate = useNavigate();
  const canWrite = useCan('safety.manage');
  const [editing, setEditing] = useState(false);
  const [work, setWork] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [closing, setClosing] = useState(false);
  const [tab, setTab] = useState('overview');
  const c = detail.data?.record;
  const patch = useSafetyWrite((body: Record<string, unknown>) => safetyApi.patch<SafetyClaim>(`/claims/${claimId}`, { version: c?.version, ...body }), 'Saved');
  const advance = useSafetyWrite(() => safetyApi.post<SafetyClaim>(`/claims/${claimId}/advance`, { version: c?.version }), (r) => `${r.number}: ${CLAIM_STAGE_LABEL[r.stage]}`);
  const voidIt = useSafetyWrite((reason: string) => safetyApi.post<SafetyClaim>(`/claims/${claimId}/void`, { version: c?.version, reason }), 'Voided');
  const close = useSafetyWrite((reason: string) => safetyApi.post<SafetyClaim>(`/claims/${claimId}/close`, { version: c?.version, reason }), 'Claim closed');

  if (detail.isLoading) return <Loading />;
  if (detail.error || !c || !detail.data) return <LoadError error={detail.error ?? new Error('Not found')} />;

  const stepDate: Partial<Record<(typeof CLAIM_STAGES)[number], string | null>> = {
    opened: c.openedOn ? formatIsoDate(c.openedOn) : null,
    submitted: c.submittedOn ? formatIsoDate(c.submittedOn) : null,
    decision: c.decisionOn ? formatIsoDate(c.decisionOn) : null,
    closed: c.closedAt ? formatDateTime(c.closedAt) : null,
  };
  const steps = CLAIM_STAGES.map((s) => ({ key: s, label: CLAIM_STAGE_LABEL[s], sub: s === c.stage && s !== 'closed' ? 'In progress' : (stepDate[s] ?? null) }));
  const closed = c.stage === 'closed';

  return (
    <div className="flex w-full flex-col gap-4">
      {editing ? <ClaimEditor open={editing} onOpenChange={setEditing} claim={c} onSave={(b) => patch.mutate(b, { onSuccess: () => setEditing(false) })} saving={patch.isPending} /> : null}
      {work ? <WorkEditor open={work} onOpenChange={setWork} initial={c} saving={patch.isPending} onSave={(v) => patch.mutate(v, { onSuccess: () => setWork(false) })} /> : null}
      <VoidDialog open={voiding} onOpenChange={setVoiding} what={c.number} saving={voidIt.isPending} onVoid={(r) => voidIt.mutate(r, { onSuccess: () => void navigate({ to: '/safety/claims' }) })} />
      <ReasonDialog open={closing} onOpenChange={setClosing} title={`Close ${c.number}`} label="Why is it closed? (withdrawn, settled, …)" saving={close.isPending} onConfirm={(r) => close.mutate(r, { onSuccess: () => setClosing(false) })} />

      <div className="text-xs text-nw-text-3">
        Safety &amp; Compliance / <Link to="/safety/claims" className="underline">Claims</Link> / {c.number}
      </div>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-extrabold tracking-[-.022em] text-nw-text">Claim {c.number}</h1>
            {c.voidedAt ? <StatusBadge status="void" /> : <StatusBadge status={claimStageStatus(c)} label={c.stage === 'insurer_review' ? 'Under review' : CLAIM_STAGE_LABEL[c.stage]} />}
          </div>
          <div className="text-sm text-nw-text-2">
            {CLAIM_KIND_LABEL[c.kind]} claim{c.truckNumber ? ` for unit ${c.truckNumber}` : ''}{c.loadNumber ? ` · load ${c.loadNumber}` : ''}.
          </div>
        </div>
        {canWrite && !c.voidedAt ? (
          <DropdownMenu trigger={<Button variant="outline" iconRight={<ChevronDown />}>Actions</Button>}>
            {!closed ? <MenuItem onSelect={() => setEditing(true)}>Edit details and amounts</MenuItem> : null}
            {!closed ? <MenuItem onSelect={() => setWork(true)}>Owner and next action</MenuItem> : null}
            {!closed ? <MenuItem onSelect={() => setClosing(true)}>Close with a note…</MenuItem> : null}
            <MenuSeparator />
            <MenuItem onSelect={() => setVoiding(true)}>Void (entered in error)…</MenuItem>
          </DropdownMenu>
        ) : null}
      </header>

      <Card padding="md">
        <div className="grid gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <Info label="Linked incident">
            {c.accidentId ? (
              <Link to="/safety/accidents/$accidentId" params={{ accidentId: c.accidentId }} className="font-semibold text-nw-accent-ink underline">
                {c.accidentNumber}
              </Link>
            ) : c.loadNumber ? `Load ${c.loadNumber}` : 'None'}
          </Info>
          <Info label="Driver & truck">
            {c.driverName ?? 'Not named'}
            {c.truckNumber ? <span className="block">Unit {c.truckNumber}</span> : null}
          </Info>
          <Info label="Insurer">{c.insurer ?? 'Not named'}</Info>
          <Info label="Policy number">{c.policyNumber ?? 'Not recorded'}</Info>
          <Info label="Insurer reference">{c.insurerReference ?? 'Not recorded'}</Info>
          <Info label="Adjuster">
            {c.adjusterName ?? 'Not assigned'}
            {c.adjusterPhone ? <span className="block text-xs text-nw-text-3">{c.adjusterPhone}</span> : null}
            {c.adjusterPhone || c.adjusterEmail ? (
              <a className="mt-1 inline-block rounded-md border border-nw-border px-2 py-0.5 text-xs font-semibold" href={c.adjusterEmail ? `mailto:${c.adjusterEmail}` : `tel:${c.adjusterPhone}`}>
                Contact
              </a>
            ) : null}
          </Info>
        </div>
      </Card>

      <CaseStepper steps={steps} current={c.stage} finished={closed} />

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'documents', label: 'Documents', count: detail.data.documents.length },
          { value: 'payments', label: 'Payments', count: c.payments.filter((p) => !p.voidedAt).length },
          { value: 'timeline', label: 'Timeline' },
        ]}
      >
        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
            <Amount icon={<ShieldCheck />} label="Claimed amount" value={money(c.claimedCents)} />
            <Amount icon={<Receipt />} label="Approved amount" value={c.decision ? money(c.approvedCents) : 'Awaiting decision'} />
            <Amount icon={<Wallet />} label="Received to date" value={money(c.receivedCents)} />
            {!closed && !c.voidedAt ? (
              <NextActionCard
                action={c.nextAction}
                ownerName={c.ownerName}
                dueOn={c.nextActionDueOn}
                canWrite={canWrite}
                onComplete={() => advance.mutate(undefined)}
                completing={advance.isPending}
                blockers={c.advanceBlockers}
                onEdit={() => setWork(true)}
              />
            ) : (
              <Panel title="Next action">
                <p className="text-sm text-nw-text-3">{c.voidedAt ? 'Void.' : 'Closed.'}</p>
              </Panel>
            )}
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Panel title="Coverage split (insurer decision)">
              <FactList
                rows={[
                  ['Decision', c.decision ? DECISION_LABEL[c.decision] : 'Not yet'],
                  ['Insurer approved', c.decision ? money(c.approvedCents) : 'Not yet'],
                  ['Company deductible', money(c.deductibleCents)],
                  ['Recovery pending', c.remainingApprovedCents === null ? 'Not yet' : money(c.remainingApprovedCents)],
                  ['Driver deduction', c.driverDeductionProposedCents ? `${money(c.driverDeductionProposedCents)} proposed — not applied` : 'Not authorized'],
                ]}
              />
              {canWrite && !closed && (c.stage === 'decision' || c.stage === 'insurer_review') ? <DecisionForm claim={c} onSave={(b) => patch.mutate(b)} saving={patch.isPending} /> : null}
            </Panel>
            <PaymentsPanel claim={c} canWrite={canWrite && !closed && !c.voidedAt} />
          </div>
          <div className="mt-4">
            <AccountingPanel entries={c.accountingEntries} />
          </div>
        </TabsContent>
        <TabsContent value="documents" className="pt-4">
          <DocumentsCard caseType="claim" caseId={c.id} documents={detail.data.documents} kinds={['repair_estimate', 'invoice', 'insurer_correspondence', 'photos', 'police_report', 'other']} />
        </TabsContent>
        <TabsContent value="payments" className="pt-4">
          <PaymentsPanel claim={c} canWrite={canWrite && !closed && !c.voidedAt} withForm />
        </TabsContent>
        <TabsContent value="timeline" className="pt-4">
          <TimelineCard entries={detail.data.timeline} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-nw-text-3">{label}</div>
      <div className="font-semibold text-nw-text">{children}</div>
    </div>
  );
}

function Amount({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-nw-border bg-nw-panel p-4">
      <span className="grid size-10 place-items-center rounded-[9px] bg-nw-accent-tint text-nw-accent-ink [&_svg]:size-5" aria-hidden>
        {icon}
      </span>
      <span>
        <span className="block text-xs text-nw-text-2">{label}</span>
        <span className="block text-[20px] font-extrabold text-nw-text">{value}</span>
      </span>
    </div>
  );
}

export function DecisionForm({ claim: c, onSave, saving }: { claim: SafetyClaim; onSave: (b: Record<string, unknown>) => void; saving: boolean }) {
  const [decision, setDecision] = useState<string>(c.decision ?? '');
  const [approved, setApproved] = useState(c.approvedCents === null ? '' : String(c.approvedCents / 100));
  const [deductible, setDeductible] = useState(c.deductibleCents === null ? '' : String(c.deductibleCents / 100));
  const [on, setOn] = useState(c.decisionOn ?? companyToday());
  return (
    <div className="mt-4 grid gap-2 border-t border-nw-border pt-3 md:grid-cols-2">
      <FormField label="Insurer decision">
        <Select value={decision} onValueChange={setDecision} placeholder="Choose" options={CLAIM_DECISIONS.map((d) => ({ value: d, label: DECISION_LABEL[d] }))} />
      </FormField>
      <FormField label="Decision date">
        <DatePicker value={on} onIsoChange={setOn} />
      </FormField>
      <FormField label="Approved amount ($)">
        <Input type="number" min={0} step="0.01" value={approved} disabled={decision === 'denied'} onChange={(e) => setApproved(e.target.value)} />
      </FormField>
      <FormField label="Company deductible ($)">
        <Input prefix="$" type="number" min={0} step="0.01" value={deductible} onChange={(e) => setDeductible(e.target.value)} />
      </FormField>
      <div className="md:col-span-2">
        <Button
          variant="primary"
          disabled={!decision}
          loading={saving}
          onClick={() =>
            onSave({
              decision,
              decisionOn: on,
              approvedCents: decision === 'denied' ? 0 : approved.trim() ? Math.round(Number(approved) * 100) : null,
              deductibleCents: deductible.trim() ? Math.round(Number(deductible) * 100) : null,
            })
          }
        >
          Save decision
        </Button>
      </div>
    </div>
  );
}

export function PaymentsPanel({ claim: c, canWrite, withForm = false }: { claim: SafetyClaim; canWrite: boolean; withForm?: boolean }) {
  const [on, setOn] = useState(companyToday());
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [voidId, setVoidId] = useState<string | null>(null);
  const record = useSafetyWrite(
    () => safetyApi.post<SafetyClaim>(`/claims/${c.id}/payments`, { version: c.version, receivedOn: on, amountCents: Math.round(Number(amount) * 100), reference: reference.trim() || null }),
    'Payment recorded',
  );
  const voidPayment = useSafetyWrite((reason: string) => safetyApi.post<SafetyClaim>(`/claims/${c.id}/payments/${voidId}/void`, { version: c.version, reason }), 'Payment voided');
  const live = c.payments.filter((p) => !p.voidedAt);
  return (
    <Panel title="Payments">
      <VoidDialog open={Boolean(voidId)} onOpenChange={(o) => !o && setVoidId(null)} what="payment" saving={voidPayment.isPending} onVoid={(r) => voidPayment.mutate(r, { onSuccess: () => setVoidId(null) })} />
      <table className="w-full border-collapse">
        <thead className="border-b border-nw-border bg-nw-subtle">
          <tr>
            <th className={th}>Type</th>
            <th className={th}>Date</th>
            <th className={th}>Amount</th>
            <th className={th}>Status</th>
            {withForm && canWrite ? <th className={th} /> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-nw-border">
          {c.payments.map((p) => (
            <tr key={p.id} className={p.voidedAt ? 'opacity-60' : undefined}>
              <td className={td}>
                Received
                {p.reference ? <span className="block text-xs text-nw-text-3">Ref {p.reference}</span> : null}
              </td>
              <td className={td}>{formatIsoDate(p.receivedOn)}</td>
              <td className={td}>{money(p.amountCents)}</td>
              <td className={td}>{p.voidedAt ? <StatusBadge status="void" /> : <StatusBadge status="received" />}</td>
              {withForm && canWrite ? (
                <td className={td}>
                  {!p.voidedAt ? (
                    <Button variant="ghost" size="sm" onClick={() => setVoidId(p.id)}>
                      Void
                    </Button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
          {c.remainingApprovedCents !== null && c.remainingApprovedCents > 0 ? (
            <tr>
              <td className={td}>Remaining approved</td>
              <td className={td}>
                <span className="text-nw-text-3">Not yet</span>
              </td>
              <td className={td}>{money(c.remainingApprovedCents)}</td>
              <td className={td}>
                <StatusBadge status="pending" />
              </td>
              {withForm && canWrite ? <td className={td} /> : null}
            </tr>
          ) : null}
          {live.length === 0 && (c.remainingApprovedCents ?? 0) === 0 ? (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-sm text-nw-text-3">
                No payments received.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {withForm && canWrite && c.decision !== 'denied' ? (
        <div className="mt-3 grid items-end gap-2 border-t border-nw-border pt-3 md:grid-cols-4">
          <FormField label="Received on">
            <DatePicker value={on} onIsoChange={setOn} />
          </FormField>
          <FormField label="Amount ($)">
            <Input prefix="$" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
          <FormField label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check or wire #" />
          </FormField>
          <Button variant="primary" disabled={!(Number(amount) > 0)} loading={record.isPending} onClick={() => record.mutate(undefined, { onSuccess: () => setAmount('') })}>
            Record payment
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

/** Money Safety suggests to Accounting. Accounting (accounting.edit) confirms or rejects; nothing posts by itself. */
export function AccountingPanel({ entries }: { entries: SafetyAccountingEntry[] }) {
  const canDecide = useCan('accounting.edit');
  const [rejecting, setRejecting] = useState<SafetyAccountingEntry | null>(null);
  const confirm = useSafetyWrite((e: SafetyAccountingEntry) => safetyApi.post(`/accounting-entries/${e.id}/confirm`, { version: e.version }), 'Confirmed for accounting');
  const reject = useSafetyWrite((input: { e: SafetyAccountingEntry; note: string }) => safetyApi.post(`/accounting-entries/${input.e.id}/reject`, { version: input.e.version, note: input.note }), 'Rejected');
  return (
    <Panel title="Suggested for accounting" note="Accounting confirms; nothing is posted or deducted automatically">
      <ReasonDialog open={Boolean(rejecting)} onOpenChange={(o) => !o && setRejecting(null)} title="Reject suggestion" label="Why?" saving={reject.isPending} onConfirm={(note) => rejecting && reject.mutate({ e: rejecting, note }, { onSuccess: () => setRejecting(null) })} />
      {entries.length === 0 ? (
        <p className="text-sm text-nw-text-3">Nothing suggested yet. The insurer decision, the deductible and each payment appear here for Accounting.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead className="border-b border-nw-border bg-nw-subtle">
            <tr>
              <th className={th}>
                <ListChecks className="inline size-3.5" aria-hidden /> Entry
              </th>
              <th className={th}>Amount</th>
              <th className={th}>Status</th>
              <th className={th}>Reviewed</th>
              {canDecide ? <th className={th} /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-nw-border">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className={td}>
                  {ACCOUNTING_ENTRY_KIND_LABEL[e.kind]}
                  <span className="block text-xs text-nw-text-3">{e.memo}</span>
                </td>
                <td className={td}>{money(e.amountCents)}</td>
                <td className={td}>
                  <StatusBadge status={e.state === 'superseded' ? 'superseded' : e.state} />
                </td>
                <td className={td}>{e.reviewedAt ? `${e.reviewedBy ?? ''} · ${formatDateTime(e.reviewedAt)}` : <span className="text-nw-text-3">Not yet</span>}</td>
                {canDecide ? (
                  <td className={td}>
                    {e.state === 'pending_review' && e.kind === 'driver_charge' ? (
                      <span className="text-xs text-nw-text-3">On the driver charge card</span>
                    ) : e.state === 'pending_review' ? (
                      <span className="flex gap-1">
                        <Button variant="primary" size="sm" onClick={() => confirm.mutate(e)}>
                          Confirm
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRejecting(e)}>
                          Reject
                        </Button>
                      </span>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function ClaimEditor({ open, onOpenChange, claim: c, onSave, saving }: { open: boolean; onOpenChange: (o: boolean) => void; claim: SafetyClaim; onSave: (b: Record<string, unknown>) => void; saving: boolean }) {
  const [f, setF] = useState({
    insurer: c.insurer ?? '',
    policyNumber: c.policyNumber ?? '',
    insurerReference: c.insurerReference ?? '',
    adjusterName: c.adjusterName ?? '',
    adjusterPhone: c.adjusterPhone ?? '',
    adjusterEmail: c.adjusterEmail ?? '',
    claimed: c.claimedCents === null ? '' : String(c.claimedCents / 100),
    driverDeduction: c.driverDeductionProposedCents === null ? '' : String(c.driverDeductionProposedCents / 100),
    description: c.description,
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const cents = (v: string) => (v.trim() ? Math.round(Number(v) * 100) : null);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Edit ${c.number}`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={() =>
              onSave({
                insurer: f.insurer.trim() || null,
                policyNumber: f.policyNumber.trim() || null,
                insurerReference: f.insurerReference.trim() || null,
                adjusterName: f.adjusterName.trim() || null,
                adjusterPhone: f.adjusterPhone.trim() || null,
                adjusterEmail: f.adjusterEmail.trim() || null,
                claimedCents: cents(f.claimed),
                driverDeductionProposedCents: cents(f.driverDeduction),
                description: f.description.trim(),
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Insurer">
          <Input value={f.insurer} onChange={(e) => set('insurer', e.target.value)} />
        </FormField>
        <FormField label="Policy number">
          <Input value={f.policyNumber} onChange={(e) => set('policyNumber', e.target.value)} />
        </FormField>
        <FormField label="Insurer reference">
          <Input value={f.insurerReference} onChange={(e) => set('insurerReference', e.target.value)} />
        </FormField>
        <FormField label="Claimed amount ($)">
          <Input type="number" min={0} step="0.01" value={f.claimed} onChange={(e) => set('claimed', e.target.value)} />
        </FormField>
        <FormField label="Adjuster">
          <Input value={f.adjusterName} onChange={(e) => set('adjusterName', e.target.value)} />
        </FormField>
        <FormField label="Adjuster phone">
          <Input value={f.adjusterPhone} onChange={(e) => set('adjusterPhone', e.target.value)} />
        </FormField>
        <FormField label="Adjuster email">
          <Input type="email" value={f.adjusterEmail} onChange={(e) => set('adjusterEmail', e.target.value)} />
        </FormField>
        <FormField label="Proposed driver deduction ($)" description="A proposal for Accounting to decide. Nothing is deducted automatically.">
          <Input prefix="$" type="number" min={0} step="0.01" value={f.driverDeduction} onChange={(e) => set('driverDeduction', e.target.value)} />
        </FormField>
        <FormField label="Description" className="md:col-span-2">
          <Textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}

export function ReasonDialog({ open, onOpenChange, title, label, onConfirm, saving }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; label: string; onConfirm: (reason: string) => void; saving?: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={reason.trim().length < 3} loading={saving} onClick={() => onConfirm(reason.trim())}>
            Confirm
          </Button>
        </>
      }
    >
      <FormField label={label}>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </Modal>
  );
}
