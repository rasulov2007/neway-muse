import { Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Modal, cn } from '@/design-system';
import { accApi, useAccWrite, useVendors } from './api';
import { dollarsToCents } from './claims-api';
import { Field, NInput, NSelect, Panel, Restricted } from './ui';

const GROUP_LABEL: Record<string, string> = { actual: 'Spent', estimate: 'Estimate', recovered: 'Recovered', expected: 'Expected', exposure: 'Exposure' };

/**
 * Financial impact (SPEC §1.4 Claims & costs, §7.13): one ledger built by the server from AP bills, Fleet work orders and
 * claim payments — Spent − Recovered = Net so far, Still to spend − Still to recover = Projected net. Insurer reserves
 * and lost revenue are shown beside it, never added. Every line names its source record.
 */
export function FinancialImpact({ d }: { d: A.CaseDetailResponse }) {
  const navigate = useNavigate();
  const f = d.computed.money.financials;
  const [how, setHow] = useState(false);
  const [bill, setBill] = useState(false);
  if (!f) {
    return (
      <Panel title="Financial impact" sub="Cash only — lost revenue shown separately">
        <Restricted text="Repair costs are not shown to your role" />
      </Panel>
    );
  }
  const lr = f.lostRevenue;
  return (
    <Panel
      title="Financial impact"
      sub="Cash only — lost revenue shown separately"
      id="financial-impact"
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => setHow((x) => !x)} aria-expanded={how}>How it’s calculated</Button>
          {d.permissions.bills ? <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => setBill(true)}>Add invoice to AP</Button> : null}
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-nw-subtle p-3 text-sm" id="money-strip">
          <Fig label="Spent" v={f.actualCents} />
          <Op>−</Op>
          <Fig label="Recovered" v={f.recoveredCents} />
          <Op>=</Op>
          <Fig label="Net so far" v={f.netToDateCents} strong />
          <span className="mx-1 h-8 w-px bg-nw-border" aria-hidden />
          <Fig label="Still to spend" v={f.estimateCents} />
          <Op>−</Op>
          <Fig label="Still to recover" v={f.expectedCents} />
          <Op>=</Op>
          <Fig label={f.finalized ? 'Final net cost' : 'Projected net cost'} v={f.projectedNetCents} strong />
        </div>
        <div className="flex flex-col gap-1 text-xs text-nw-text-2">
          <span>
            <b className="text-nw-text">Insurer reserves {R.money(f.exposureCents)}</b> — the insurer’s exposure above our share; not our cost.
          </span>
          <span>
            <b className="text-nw-text">Lost contribution {R.money(lr.amountCents)}</b> (not cash) — {lr.days.toFixed(2)} truck-days × {R.money(lr.perDayCents)}/day{lr.fallback ? ' (company fallback rate)' : ''}.
          </span>
          {f.restrictedClaimsExcluded ? (
            <span className="inline-flex items-center gap-1 text-nw-text-3">
              <Lock className="size-3" aria-hidden />
              Excludes {R.plural(f.restrictedClaimsExcluded, 'restricted claim')}
            </span>
          ) : null}
        </div>
      </div>
      {how ? (
        <ol className="mt-3 list-decimal space-y-1 rounded-md bg-nw-subtle py-2 pr-3 pl-7 text-xs text-nw-text-2" id="ledger-rules">
          <li><b>Spent</b> = AP bills on the case (not those on a claim) + claim payments we made.</li>
          <li><b>Estimate</b> = work orders not invoiced yet (approved → selected → lowest estimate), storage accruing, our share of open third-party claims, a physical-damage claim as the cost basis while no work order exists.</li>
          <li><b>Recovered</b> = claim payments received by us.</li>
          <li><b>Expected</b> = own-damage claims (claimed − deductible − received) and recoveries still open. A deductible is never added as a cost.</li>
          <li><b>Exposure</b> = insurer reserve above our share — not our cost. Lost revenue (truck-days × daily contribution) is never added to the net cost.</li>
        </ol>
      ) : null}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm" id="cost-by-category">
          <thead className="text-xs text-nw-text-3">
            <tr>{['Category', 'Spent', 'Estimate', 'Recovered', 'Expected', 'Total'].map((h, i) => <th key={h} className={cn('px-2 py-1.5 font-semibold', i ? 'text-right' : '')}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {f.byCategory.map((r) => (
              <tr key={r.category} className="border-t border-nw-border">
                <td className="px-2 py-1.5 text-nw-text">{r.category}</td>
                <Num v={r.spentCents} />
                <Num v={r.estimateCents} />
                <Num v={r.recoveredCents} neg />
                <Num v={r.expectedCents} neg />
                <Num v={r.spentCents + r.estimateCents - r.recoveredCents - r.expectedCents} strong />
              </tr>
            ))}
            <tr className="border-t border-nw-border-strong font-bold">
              <td className="px-2 py-1.5 text-nw-text">Total</td>
              <Num v={f.actualCents} strong />
              <Num v={f.estimateCents} strong />
              <Num v={f.recoveredCents} neg strong />
              <Num v={f.expectedCents} neg strong />
              <Num v={f.projectedNetCents} strong />
            </tr>
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-xs font-bold tracking-wide text-nw-text-2 uppercase">Every line and its source</div>
      <ul className="mt-1 divide-y divide-nw-border" id="ledger">
        {f.lines.length === 0 ? <li className="py-2 text-sm text-nw-text-3">No costs or recoveries yet.</li> : null}
        {f.lines.map((l) => (
          <li key={l.id} className="flex flex-wrap items-start gap-2 py-1.5 text-sm">
            <span className={cn('inline-flex h-5 shrink-0 items-center rounded-[5px] px-1.5 text-[11px] font-semibold', l.group === 'recovered' || l.group === 'expected' ? 'bg-nw-done-bg text-nw-done-text' : l.group === 'exposure' ? 'bg-nw-neutral-bg text-nw-neutral-text' : l.group === 'estimate' ? 'bg-nw-warning-bg text-nw-warning-text' : 'bg-nw-subtle text-nw-text-2')}>
              {GROUP_LABEL[l.group]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-nw-text">{l.label}</span>
              {l.note ? <span className="block text-xs text-nw-text-3">{l.note}</span> : null}
              <button
                type="button"
                className="block text-xs font-semibold text-nw-accent-ink hover:underline"
                onClick={() => {
                  if (l.nav?.name === 'claim' && l.nav.id) void navigate({ to: '/safety/claims', search: { claim: l.nav.id } } as never);
                  else if (l.nav?.name === 'workorder' && l.nav.id) void navigate({ to: '/fleet/shop/$orderId', params: { orderId: l.nav.id } });
                  else if (l.nav?.name === 'payables') void navigate({ to: '/accounting/payables' } as never);
                }}
              >
                {l.source}
              </button>
            </span>
            <b className={cn('tabular-nums', l.group === 'recovered' || l.group === 'expected' ? 'text-nw-done-text' : 'text-nw-text')}>{l.group === 'recovered' || l.group === 'expected' ? `−${R.money(l.amountCents)}` : R.money(l.amountCents)}</b>
          </li>
        ))}
      </ul>
      {bill ? <AddBill d={d} onClose={() => setBill(false)} /> : null}
    </Panel>
  );
}

function Fig({ label, v, strong }: { label: string; v: number; strong?: boolean }) {
  return (
    <span className="flex flex-col">
      <span className="text-xs text-nw-text-3">{label}</span>
      <b className={cn('tabular-nums', strong ? 'text-[18px] text-nw-text' : 'text-nw-text')}>{R.money(v)}</b>
    </span>
  );
}
const Op = ({ children }: { children: string }) => <span className="text-lg font-bold text-nw-text-3" aria-hidden>{children}</span>;
function Num({ v, neg, strong }: { v: number; neg?: boolean; strong?: boolean }) {
  return <td className={cn('px-2 py-1.5 text-right tabular-nums', strong ? 'font-bold text-nw-text' : 'text-nw-text-2')}>{v === 0 ? '—' : neg ? `−${R.money(v)}` : R.money(v)}</td>;
}

function AddBill({ d, onClose }: { d: A.CaseDetailResponse; onClose: () => void }) {
  const vendors = useVendors(true);
  const [f, setF] = useState<{ vendorId: string; category: A.CaseBillCategory; amount: string; memo: string; invoice: string; claimId: string }>({ vendorId: '', category: 'Towing', amount: '', memo: '', invoice: '', claimId: '' });
  const add = useAccWrite(
    () => accApi.addBill(d.case.id, { version: d.version, vendorId: f.vendorId, category: f.category, amountCents: dollarsToCents(f.amount) ?? 0, memo: f.memo.trim(), ...(f.invoice.trim() ? { invoiceNumber: f.invoice.trim() } : {}), ...(f.claimId ? { claimId: f.claimId } : {}) }),
    (r) => `${r.number} added to Accounts Payable and linked to ${d.case.number}`,
  );
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title="Add invoice to Accounts Payable"
      description="Towing, storage, transload, rental and other invoices. Repair invoices reach AP only from the work order."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.vendorId || !dollarsToCents(f.amount) || f.memo.trim().length < 2} loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: onClose })}>Add to AP</Button></>}
    >
      <div className="flex flex-col gap-3">
        <Field label="Vendor" htmlFor="bill-vendor" required>
          <NSelect id="bill-vendor" value={f.vendorId} onChange={(v) => setF({ ...f, vendorId: v })}>
            <option value="">{vendors.isLoading ? 'Loading…' : 'Pick the vendor…'}</option>
            {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </NSelect>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Category" htmlFor="bill-cat">
            <NSelect id="bill-cat" value={f.category} onChange={(v) => setF({ ...f, category: v as A.CaseBillCategory })}>
              {(['Towing', 'Storage', 'Transload / recovery', 'Rental equipment', 'Other'] as const).map((x) => <option key={x}>{x}</option>)}
            </NSelect>
          </Field>
          <Field label="Amount ($)" htmlFor="bill-amount" required><NInput id="bill-amount" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        </div>
        <Field label="Memo" htmlFor="bill-memo" required><NInput id="bill-memo" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} placeholder="e.g. Heavy tow from I-80 MM 127 to Joliet" /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Vendor invoice #" htmlFor="bill-inv"><NInput id="bill-inv" value={f.invoice} onChange={(e) => setF({ ...f, invoice: e.target.value })} /></Field>
          <Field label="Belongs to a claim" htmlFor="bill-claim" hint="Counted through the claim, never twice">
            <NSelect id="bill-claim" value={f.claimId} onChange={(v) => setF({ ...f, claimId: v })}>
              <option value="">No — a cost of the case</option>
              {d.computed.claims.map((k) => <option key={k.id} value={k.id}>{k.number} · {R.CLAIM_TYPE_LABEL[k.type]}</option>)}
            </NSelect>
          </Field>
        </div>
      </div>
    </Modal>
  );
}
