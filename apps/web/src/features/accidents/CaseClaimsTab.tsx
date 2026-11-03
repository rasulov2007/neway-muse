import { Lock, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Modal } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { useAccWrite } from './api';
import { ClaimDrawer } from './ClaimDrawer';
import { claimStatusTone } from './labels';
import { claimsApi } from './claims-api';
import { NewClaimDialog } from './NewClaimDialog';
import { DueText, Empty, Field, NSelect, NTextarea, Panel, Person, Restricted, ToneBadge } from './ui';

/**
 * Claims & costs tab (SPEC §1.4): the claims linked to the case — each with its own lifecycle on the Claims board,
 * updated there and here at once — "Add claims" and "Record no claim". The financial impact (one ledger from AP
 * bills, work orders and claim payments) is rendered by `financial` (P3).
 */
export function ClaimsCostsTab({ d, financial }: { d: A.CaseDetailResponse; financial?: ReactNode }) {
  const c = d.case;
  const claims = d.computed.claims;
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [noClaim, setNoClaim] = useState<string | null>(null);
  const decide = useAccWrite((text: string | null) => claimsApi.claimDecision(c.id, { version: d.version, text }), (_r, t) => (t ? '“No claim” recorded' : '“No claim” decision cleared'));
  return (
    <div className="mt-3 flex flex-col gap-3">
      <Panel
        title="Claims linked to this accident"
        sub="Each claim has its own lifecycle on the Claims board. Updates there show here instantly."
        id="case-claims"
        actions={
          d.permissions.edit ? (
            <>
              {!claims.length ? <Button size="sm" variant="secondary" onClick={() => setNoClaim(c.claimDecision?.text ?? '')}>Record “no claim”</Button> : null}
              <Button size="sm" variant="primary" icon={<Plus />} id="add-claims" onClick={() => setAdding(true)}>Add claims</Button>
            </>
          ) : null
        }
      >
        {d.computed.restrictedClaims > 0 ? (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-nw-text-3">
            <Lock className="size-3" aria-hidden />
            {R.plural(d.computed.restrictedClaims, 'restricted claim')}: details and money are visible to Safety Managers and the owner.
          </div>
        ) : null}
        {claims.length === 0 ? (
          c.claimDecision ? (
            <div className="rounded-md bg-nw-subtle px-3 py-2 text-sm text-nw-text" id="no-claim">
              <b>No claim filed.</b> {c.claimDecision.text}
              <span className="block text-xs text-nw-text-3">Recorded by {c.claimDecision.by} · {R.fmtShort(c.claimDecision.at, R.EASTERN, nowMs())}</span>
              {d.permissions.edit ? <Button size="sm" variant="ghost" onClick={() => decide.mutate(null)}>Clear</Button> : null}
            </div>
          ) : (
            <Empty title="No claims yet">Add one claim per coverage (physical damage, auto liability, cargo, recovery, workers’ comp), or record why no claim is filed.</Empty>
          )
        ) : (
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {claims.map((k) => <ClaimCard key={k.id} k={k} canEdit={d.permissions.edit} onOpen={() => setOpen(k.id)} />)}
          </div>
        )}
      </Panel>
      {financial ?? (
        <Panel title="Financial impact" sub="Cash only — lost revenue shown separately">
          <p className="text-sm text-nw-text-2">The ledger joins work orders, AP bills and these claim payments in the next phase.</p>
        </Panel>
      )}
      {adding ? <NewClaimDialog accidentId={c.id} onClose={() => setAdding(false)} /> : null}
      {open ? <ClaimDrawer claimId={open} onClose={() => setOpen(null)} /> : null}
      {noClaim !== null ? (
        <Modal
          open
          onOpenChange={(o) => (o ? undefined : setNoClaim(null))}
          size="sm"
          title="Record “no claim”"
          description="Why no insurance claim is filed for this accident. Shown on the case and in its summary."
          footer={
            <>
              <Button variant="secondary" onClick={() => setNoClaim(null)}>Cancel</Button>
              <Button variant="primary" disabled={noClaim.trim().length < 3} loading={decide.isPending} onClick={() => decide.mutate(noClaim.trim(), { onSuccess: () => setNoClaim(null) })}>Save</Button>
            </>
          }
        >
          <Field label="Reason" htmlFor="no-claim-reason" required hint="e.g. Repair below the $5,000 deductible — company paid">
            <NTextarea id="no-claim-reason" rows={3} value={noClaim} onChange={(e) => setNoClaim(e.target.value)} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}

function ClaimCard({ k, canEdit, onOpen }: { k: A.CaseClaimCard; canEdit: boolean; onOpen: () => void }) {
  const status = useAccWrite((s: R.ClaimStatus) => claimsApi.patch(k.id, { version: k.version, status: s }), (_r, s) => `${k.number}: ${s}`);
  const hidden = k.restricted && k.claimedCents === null && k.reserveCents === null && k.receivedOrPaidCents === null && k.adjuster === null;
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-nw-border bg-nw-panel p-3" data-claim={k.number}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="font-bold text-nw-accent-ink hover:underline" onClick={onOpen}>{k.number}</button>
        <span className="text-xs font-semibold text-nw-text-2">{R.CLAIM_TYPE_LABEL[k.type]}</span>
        {k.restricted ? <Lock className="size-3.5 text-nw-text-3" aria-label="Restricted claim" /> : null}
        <span className="flex-1" />
        {canEdit ? (
          <NSelect ariaLabel={`Status of ${k.number}`} className="h-8 w-auto" value={k.status} disabled={status.isPending} onChange={(v) => status.mutate(v as R.ClaimStatus)}>
            {R.CLAIM_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </NSelect>
        ) : (
          <ToneBadge tone={claimStatusTone(k.status)}>{k.status}</ToneBadge>
        )}
      </div>
      <div className="text-sm text-nw-text">{k.title}</div>
      <div className="text-xs text-nw-text-3">
        {k.insurer || 'Insurer not set'}
        {k.insurerClaimNo ? ` · #${k.insurerClaimNo}` : ' · no insurer # yet'}
        {k.adjuster ? ` · adjuster ${k.adjuster}` : ''}
      </div>
      {hidden ? (
        <Restricted text="Restricted claim — amounts withheld" />
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
          <Fig k="Claimed" v={k.claimedCents} />
          <Fig k="Reserve" v={k.reserveCents} />
          <Fig k="Deductible" v={k.deductibleCents} />
          <Fig k={k.type === 'physical_damage' || k.type === 'recovery' ? 'Received' : 'Paid out'} v={k.receivedOrPaidCents} />
        </dl>
      )}
      {k.nextFollowUp ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-nw-text-2">
          Next: {k.nextFollowUp.what ?? 'follow-up (restricted)'} · {k.nextFollowUp.assignee ? <Person name={k.nextFollowUp.assignee.name} /> : null}
          <DueText iso={k.nextFollowUp.at} />
        </div>
      ) : null}
    </div>
  );
}

function Fig({ k, v }: { k: string; v: number | null }) {
  return (
    <div className="flex flex-col">
      <dt className="text-nw-text-3">{k}</dt>
      <dd className="font-semibold text-nw-text tabular-nums">{v === null ? <span className="font-normal text-nw-text-3">Not known</span> : R.money(v)}</dd>
    </div>
  );
}
