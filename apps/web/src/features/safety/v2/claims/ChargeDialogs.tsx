import { Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  CLAIM_CHARGE_POLICY,
  DRIVER_CHARGE_BASES,
  DRIVER_CHARGE_BASIS_LABEL,
  DRIVER_RESPONSES,
  DRIVER_RESPONSE_LABEL,
  LIABILITY_PARTIES,
  LIABILITY_PARTY_LABEL,
  NOTIFY_METHODS,
  NOTIFY_METHOD_LABEL,
  REJECT_REASONS,
  REJECT_REASON_LABEL,
  installmentCapFor,
  installmentsFor,
  type DriverCharge,
  type DriverChargeBasis,
  type LiabilityParty,
  type SafetyClaim,
} from '@neway/shared';
import { Button, Checkbox, DatePicker, FormField, Input, Modal, Select, Textarea } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { uploadFile } from '@/lib/files';
import { safetyApi, useSafetyPeople, useSafetyWrite } from '../api';
import { money } from '../ui';

const toCents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const asDollars = (cents: number) => (cents / 100).toFixed(2);

function Shell({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title} size="md" footer={<div className="flex justify-end gap-2">{footer}</div>}>
      <div className="flex flex-col gap-3">{children}</div>
    </Modal>
  );
}

function Context({ children }: { children: ReactNode }) {
  return <div className="rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2 text-[13px] text-nw-text-2">{children}</div>;
}

/** Evidence: the file goes up first, the form keeps its id. */
function EvidenceUpload({ label, hint, fileId, onFile }: { label: string; hint: string; fileId: string | null; onFile: (id: string | null, name: string | null) => void }) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <FormField label={label} required description={hint}>
      <label className="flex cursor-pointer items-center gap-2 rounded-[10px] border border-dashed border-nw-border-strong bg-nw-subtle px-3 py-2 text-sm hover:border-nw-accent hover:bg-nw-accent-tint">
        <Upload className="size-4 text-nw-accent-ink" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-nw-text">{busy ? 'Uploading…' : fileId ? (name ?? 'File attached') : 'Attach the file (PDF or photo)'}</span>
        <input
          type="file"
          className="sr-only"
          accept="application/pdf,image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            try {
              const stored = await uploadFile(file);
              setName(file.name);
              onFile(stored.id, file.name);
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
    </FormField>
  );
}

export function LiabilityDialog({ claim, onClose }: { claim: SafetyClaim; onClose: () => void }) {
  const [party, setParty] = useState<LiabilityParty>(claim.liabilityParty ?? 'undetermined');
  const [pct, setPct] = useState(String(claim.liabilityPct ?? ''));
  const [note, setNote] = useState('');
  const save = useSafetyWrite(() => safetyApi.post(`/claims/${claim.id}/liability`, { version: claim.version, party, pct: party === 'shared' ? Number(pct) || null : null, note: note.trim() || null }), 'Liability recorded');
  return (
    <Shell title={`Who is responsible · ${claim.number}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>Save</Button></>}>
      <FormField label="Liability">
        <Select value={party} onValueChange={(v) => setParty(v as LiabilityParty)} options={LIABILITY_PARTIES.map((p) => ({ value: p, label: LIABILITY_PARTY_LABEL[p] }))} />
      </FormField>
      {party === 'shared' ? (
        <FormField label="Our share (%)">
          <Input inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="50" />
        </FormField>
      ) : null}
      <FormField label="Note">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Preventable per the accident review; police report cites following too closely" />
      </FormField>
    </Shell>
  );
}

export function ApplyChargeDialog({ claim, onClose }: { claim: SafetyClaim; onClose: () => void }) {
  const [amount, setAmount] = useState(asDollars(CLAIM_CHARGE_POLICY.companyDriverCents));
  const [basis, setBasis] = useState<DriverChargeBasis>(claim.kind === 'cargo' ? 'deductible_cargo' : 'deductible_accident');
  const [reason, setReason] = useState('');
  const [told, setTold] = useState(false);
  const [notifiedOn, setNotifiedOn] = useState(companyToday());
  const [method, setMethod] = useState<(typeof NOTIFY_METHODS)[number]>('in_person');
  const [response, setResponse] = useState<(typeof DRIVER_RESPONSES)[number]>('signed');
  const [fileId, setFileId] = useState<string | null>(null);
  const cents = toCents(amount);
  const save = useSafetyWrite(
    () =>
      safetyApi.post(`/claims/${claim.id}/driver-charges`, {
        amountCents: cents,
        basis,
        reason: reason.trim() || null,
        notice: told ? { notifiedOn, method, response, fileId } : null,
      }),
    'Driver charge applied',
  );
  return (
    <Shell
      title={`Apply driver deductible · ${claim.number}`}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!cents || (told && !fileId)} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })} data-testid="apply-charge-save">Apply charge</Button></>}
    >
      <Context>
        {claim.driverName ?? 'Driver'} · liability {claim.liabilityParty ? LIABILITY_PARTY_LABEL[claim.liabilityParty].toLowerCase() : 'not set'}. Policy: company driver {money(CLAIM_CHARGE_POLICY.companyDriverCents)}, owner-operator {money(CLAIM_CHARGE_POLICY.ownerOperatorCents)} (only where the lease has a chargeback clause). The server checks the driver’s kind.
      </Context>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Amount ($)" required>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label="Basis" required>
          <Select value={basis} onValueChange={(v) => setBasis(v as DriverChargeBasis)} options={DRIVER_CHARGE_BASES.map((b) => ({ value: b, label: DRIVER_CHARGE_BASIS_LABEL[b] }))} />
        </FormField>
      </div>
      <FormField label="Reason (required when the amount is not the policy amount)">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <p className="text-xs text-nw-text-3">Above the policy, or more than {money(CLAIM_CHARGE_POLICY.mgmtThresholdCents)} below it, the charge waits for Management first.</p>
      <Checkbox checked={told} onCheckedChange={(v) => setTold(v === true)} label="The driver has already been informed" />
      {told ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Date informed">
              <DatePicker aria-label="Date informed" value={notifiedOn} onIsoChange={setNotifiedOn} />
            </FormField>
            <FormField label="Method">
              <Select value={method} onValueChange={(v) => setMethod(v as typeof method)} options={NOTIFY_METHODS.map((m) => ({ value: m, label: NOTIFY_METHOD_LABEL[m] }))} />
            </FormField>
          </div>
          <FormField label="Driver response">
            <Select value={response} onValueChange={(v) => setResponse(v as typeof response)} options={DRIVER_RESPONSES.map((r) => ({ value: r, label: DRIVER_RESPONSE_LABEL[r] }))} />
          </FormField>
          <EvidenceUpload label="Evidence" hint="Signed notice, call log or screenshot." fileId={fileId} onFile={(id) => setFileId(id)} />
        </>
      ) : (
        <Context>Without a recorded notice the charge is on hold: frozen, and it cannot reach Accounting.</Context>
      )}
    </Shell>
  );
}

export function NotifyDialog({ charge, claimNumber, onClose }: { charge: DriverCharge; claimNumber: string; onClose: () => void }) {
  const [notifiedOn, setNotifiedOn] = useState(companyToday());
  const [method, setMethod] = useState<(typeof NOTIFY_METHODS)[number]>('in_person');
  const [response, setResponse] = useState<(typeof DRIVER_RESPONSES)[number]>('signed');
  const [fileId, setFileId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const save = useSafetyWrite(() => safetyApi.post(`/driver-charges/${charge.id}/notify`, { version: charge.version, notifiedOn, method, response, fileId, note: note.trim() || null }), 'Notice recorded');
  return (
    <Shell
      title={`Mark driver informed · ${claimNumber}`}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!fileId} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })} data-testid="notify-save">Save notification</Button></>}
    >
      <Context>
        {charge.driverName} · charge {money(charge.amountCents)} · on hold {charge.ageDays} day{charge.ageDays === 1 ? '' : 's'}
      </Context>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Date informed">
          <DatePicker aria-label="Date informed" value={notifiedOn} onIsoChange={setNotifiedOn} />
        </FormField>
        <FormField label="Method">
          <Select value={method} onValueChange={(v) => setMethod(v as typeof method)} options={NOTIFY_METHODS.map((m) => ({ value: m, label: NOTIFY_METHOD_LABEL[m] }))} />
        </FormField>
        <FormField label="Driver response">
          <Select value={response} onValueChange={(v) => setResponse(v as typeof response)} options={DRIVER_RESPONSES.map((r) => ({ value: r, label: DRIVER_RESPONSE_LABEL[r] }))} />
        </FormField>
        <EvidenceUpload label="Evidence" hint="Required: signed notice, call log or screenshot." fileId={fileId} onFile={(id) => setFileId(id)} />
      </div>
      {response === 'disputes' ? (
        <FormField label="What does the driver dispute?">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      ) : null}
      <Context>If the driver disputes, the charge moves to Disputed instead of Accounting.</Context>
    </Shell>
  );
}

export function ApproveDialog({ charge, onClose }: { charge: DriverCharge; onClose: () => void }) {
  const company = charge.driverKind === 'company';
  const cap = installmentCapFor(charge.driverKind);
  const [method, setMethod] = useState<'settlement_deduction' | 'escrow' | 'direct_payment'>(company ? 'settlement_deduction' : 'escrow');
  const [installment, setInstallment] = useState(asDollars(Math.min(cap, charge.amountCents)));
  const [authFile, setAuthFile] = useState<string | null>(charge.authorizationFileId);
  const [clause, setClause] = useState(charge.leaseClause ?? '');
  const [legal, setLegal] = useState(false);
  const [docs, setDocs] = useState(false);
  const [override, setOverride] = useState('');
  const per = toCents(installment);
  const n = per ? installmentsFor(charge.amountCents, per) : 0;
  const overCap = Boolean(per && per > cap);
  const ready = per && legal && docs && (company ? authFile : clause.trim()) && (!overCap || override.trim());
  const save = useSafetyWrite(
    () =>
      safetyApi.post(`/driver-charges/${charge.id}/approve`, {
        version: charge.version,
        method,
        installmentCents: per,
        authorizationFileId: company ? authFile : null,
        leaseClause: company ? null : clause.trim(),
        checklist: { authorizationOrLease: docs, compliesWithLaw: legal },
        overrideNote: override.trim() || null,
      }),
    'Charge approved',
  );
  return (
    <Shell
      title={`Approve charge · ${charge.number}`}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })} data-testid="approve-save">Approve</Button></>}
    >
      <Context>
        {charge.driverName} · {company ? 'Company driver' : 'Owner-operator'} · {money(charge.amountCents)} · {DRIVER_CHARGE_BASIS_LABEL[charge.basis]}
      </Context>
      <ul className="flex flex-col gap-1.5 rounded-[10px] border border-nw-border px-3 py-2 text-[13px]">
        <li className={charge.noticeFileId ? 'text-nw-done-text' : 'text-nw-urgent-text'}>
          {charge.noticeFileId ? '✓' : '✕'} Notification recorded with evidence {charge.notifiedOn ? `(${charge.notifiedOn})` : ''}
        </li>
        <li className="text-nw-done-text">✓ No other active charge for this claim, driver and basis (the database holds it)</li>
      </ul>
      {company ? (
        <EvidenceUpload label="Signed per-charge authorization" hint="Company drivers: the driver’s signed authorization for this charge (a hire-date blanket clause is not accepted)." fileId={authFile} onFile={(id) => setAuthFile(id)} />
      ) : (
        <FormField label="Lease chargeback clause" required description="Owner-operators: the lease clause that covers this charge (49 CFR 376.12).">
          <Input value={clause} onChange={(e) => setClause(e.target.value)} placeholder="Lease LSE-0412 Appendix B §7" />
        </FormField>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Recovery method">
          <Select
            value={method}
            onValueChange={(v) => setMethod(v as typeof method)}
            options={[
              { value: 'settlement_deduction', label: 'Weekly settlement deduction' },
              { value: 'escrow', label: 'Escrow' },
              { value: 'direct_payment', label: 'Direct payment (not from settlements)' },
            ]}
          />
        </FormField>
        <FormField label="Per settlement ($)" description={`Cap ${money(cap)}`}>
          <Input inputMode="decimal" value={installment} onChange={(e) => setInstallment(e.target.value)} />
        </FormField>
      </div>
      {per ? (
        <Context>
          {n} deduction{n === 1 ? '' : 's'} of {money(per)} starting with the next weekly settlement. No deduction takes pay below the minimum: what cannot be taken carries forward.
        </Context>
      ) : null}
      {overCap ? (
        <FormField label="Override note (above the cap)" required>
          <Textarea rows={2} value={override} onChange={(e) => setOverride(e.target.value)} />
        </FormField>
      ) : null}
      <Checkbox checked={docs} onCheckedChange={(v) => setDocs(v === true)} label={company ? 'I checked the signed authorization covers this charge' : 'The lease has this chargeback and the documentation copies were sent'} />
      <Checkbox checked={legal} onCheckedChange={(v) => setLegal(v === true)} label="Complies with the driver agreement, applicable law and payroll rules" />
    </Shell>
  );
}

export function RejectDialog({ charge, onClose }: { charge: DriverCharge; onClose: () => void }) {
  const [reason, setReason] = useState<(typeof REJECT_REASONS)[number]>('no_authorization');
  const [note, setNote] = useState('');
  const save = useSafetyWrite(() => safetyApi.post(`/driver-charges/${charge.id}/reject`, { version: charge.version, reason, note: note.trim() }), 'Charge rejected');
  return (
    <Shell title={`Reject · ${charge.number}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={note.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>Reject</Button></>}>
      <FormField label="Reason">
        <Select value={reason} onValueChange={(v) => setReason(v as typeof reason)} options={REJECT_REASONS.map((r) => ({ value: r, label: REJECT_REASON_LABEL[r] }))} />
      </FormField>
      <FormField label="Note" required>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </FormField>
      <Context>The next action returns to the claim owner.</Context>
    </Shell>
  );
}

export function PaymentDialog({ charge, onClose }: { charge: DriverCharge; onClose: () => void }) {
  const [amount, setAmount] = useState(asDollars(charge.remainingCents));
  const [source, setSource] = useState<'direct' | 'escrow'>('direct');
  const [receivedOn, setReceivedOn] = useState(companyToday());
  const [reference, setReference] = useState('');
  const cents = toCents(amount);
  const save = useSafetyWrite(() => safetyApi.post(`/driver-charges/${charge.id}/payments`, { version: charge.version, amountCents: cents, source, receivedOn, reference: reference.trim() || null }), 'Payment recorded');
  return (
    <Shell title={`Record payment · ${charge.number}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!cents || cents > charge.remainingCents} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>Record payment</Button></>}>
      <Context>Settlement deductions post by themselves; this is only for money outside a settlement. {money(charge.remainingCents)} still owed.</Context>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Amount ($)" required>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label="Source">
          <Select value={source} onValueChange={(v) => setSource(v as typeof source)} options={[{ value: 'direct', label: 'Direct from the driver' }, { value: 'escrow', label: 'Escrow' }]} />
        </FormField>
        <FormField label="Received on">
          <DatePicker aria-label="Received on" value={receivedOn} onIsoChange={setReceivedOn} />
        </FormField>
        <FormField label="Reference">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check #, Zelle ref…" />
        </FormField>
      </div>
    </Shell>
  );
}

export function ReasonActionDialog({ charge, action, title, button, onClose }: { charge: DriverCharge; action: 'pause' | 'resume' | 'send-to-accounting'; title: string; button: string; onClose: () => void }) {
  const [reason, setReason] = useState(action === 'send-to-accounting' ? '' : '');
  const needs = action !== 'send-to-accounting';
  const save = useSafetyWrite(() => safetyApi.post(`/driver-charges/${charge.id}/${action}`, needs ? { version: charge.version, reason: reason.trim() } : { version: charge.version, note: reason.trim() || null }), title);
  return (
    <Shell title={`${title} · ${charge.number}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={needs && reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })} data-testid={`charge-${action}-save`}>{button}</Button></>}>
      {action === 'send-to-accounting' ? <Context>Accounting reviews it in “Suggested for accounting” and approves or rejects it on this card. Nothing is posted or deducted automatically.</Context> : null}
      {action === 'pause' ? <Context>A paused charge is skipped by settlement generation until it is resumed.</Context> : null}
      <FormField label={needs ? 'Reason' : 'Note for Accounting'} required={needs}>
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </Shell>
  );
}

export function DisputeDialog({ charge, onClose }: { charge: DriverCharge; onClose: () => void }) {
  const [raisedBy, setRaisedBy] = useState(charge.driverName);
  const [text, setText] = useState('');
  const save = useSafetyWrite(() => safetyApi.post(`/driver-charges/${charge.id}/dispute`, { version: charge.version, raisedBy: raisedBy.trim(), text: text.trim() }), 'Dispute recorded');
  return (
    <Shell title={`Record dispute · ${charge.number}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={text.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>Record dispute</Button></>}>
      <Context>Unposted deductions freeze while Management reviews the dispute.</Context>
      <FormField label="Raised by">
        <Input value={raisedBy} onChange={(e) => setRaisedBy(e.target.value)} />
      </FormField>
      <FormField label="What is disputed" required>
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Dash cam shows the other vehicle cut in" />
      </FormField>
    </Shell>
  );
}

export function ResolveDialog({ charge, onClose }: { charge: DriverCharge; onClose: () => void }) {
  const [outcome, setOutcome] = useState<'uphold' | 'reduce' | 'waive'>('uphold');
  const [amount, setAmount] = useState(asDollars(charge.amountCents));
  const [note, setNote] = useState('');
  const save = useSafetyWrite(() => safetyApi.post(`/driver-charges/${charge.id}/resolve`, { version: charge.version, outcome, amountCents: outcome === 'reduce' ? toCents(amount) : null, note: note.trim() }), 'Dispute resolved');
  return (
    <Shell title={`Resolve dispute · ${charge.number}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={note.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>Resolve</Button></>}>
      <Context>
        {charge.disputeRaisedBy ?? 'Driver'}: “{charge.disputeText ?? '—'}”
      </Context>
      <FormField label="Decision">
        <Select value={outcome} onValueChange={(v) => setOutcome(v as typeof outcome)} options={[{ value: 'uphold', label: 'Uphold the charge' }, { value: 'reduce', label: 'Reduce the amount' }, { value: 'waive', label: 'Waive it' }]} />
      </FormField>
      {outcome === 'reduce' ? (
        <FormField label="New amount ($)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
      ) : null}
      <FormField label="Note" required>
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </FormField>
    </Shell>
  );
}

export function WaiveAdjustDialog({ charge, isMgmt, onClose }: { charge: DriverCharge; isMgmt: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<'waive' | 'adjust'>('adjust');
  const [amount, setAmount] = useState(asDollars(charge.amountCents));
  const [reason, setReason] = useState('');
  const save = useSafetyWrite(() => safetyApi.post(`/driver-charges/${charge.id}/change-request`, { version: charge.version, kind, amountCents: kind === 'adjust' ? toCents(amount) : null, reason: reason.trim() }), isMgmt ? 'Change applied' : 'Change sent');
  return (
    <Shell title={`Waive / adjust · ${charge.number}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>{isMgmt ? 'Apply' : 'Request'}</Button></>}>
      <FormField label="Change">
        <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)} options={[{ value: 'adjust', label: 'Adjust the amount' }, { value: 'waive', label: 'Waive the charge' }]} />
      </FormField>
      {kind === 'adjust' ? (
        <FormField label="New amount ($)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
      ) : null}
      <FormField label="Reason" required>
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <Context>
        {isMgmt
          ? 'You hold Management approval: the change applies at once.'
          : `A waiver always, and a cut of more than ${money(CLAIM_CHARGE_POLICY.mgmtThresholdCents)} or above policy, wait for Management.`}
      </Context>
    </Shell>
  );
}

export function LogUpdateDialog({ claim, onClose }: { claim: SafetyClaim; onClose: () => void }) {
  const people = useSafetyPeople();
  const [note, setNote] = useState('');
  const [next, setNext] = useState(claim.nextAction ?? '');
  const [due, setDue] = useState(claim.nextActionDueOn ?? '');
  const [owner, setOwner] = useState(claim.ownerId ?? '');
  const save = useSafetyWrite(
    () => safetyApi.post(`/claims/${claim.id}/updates`, { version: claim.version, note: note.trim(), nextAction: next.trim() || null, nextActionDueOn: due || null, ownerId: owner || null }),
    'Update logged',
  );
  return (
    <Shell title={`Log update / set next · ${claim.number}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={note.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })} data-testid="log-update-save">Save update</Button></>}>
      <FormField label="What happened" required>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Called the adjuster; estimate approved, payment expected next week" />
      </FormField>
      <FormField label="Next action">
        <Input value={next} onChange={(e) => setNext(e.target.value)} />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Due">
          <DatePicker aria-label="Due" value={due} onIsoChange={setDue} />
        </FormField>
        <FormField label="Owner">
          <Select value={owner} onValueChange={setOwner} placeholder="Keep owner" options={(people.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        </FormField>
      </div>
    </Shell>
  );
}
