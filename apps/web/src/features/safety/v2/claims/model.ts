import { CLAIM_KIND_LABEL, DRIVER_CHARGE_STATE_LABEL, type DriverCharge, type SafetyClaim } from '@neway/shared';

/**
 * The Claims page's figures (Claims v2, owner mockup 2026-10-13), from the claims and their driver
 * charges as the server returns them. Pure, so the page and its tests read the same numbers.
 */

export const DAY = 86_400_000;
export const isOpen = (c: SafetyClaim) => c.stage !== 'closed' && !c.voidedAt;
const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY));

/** What the insurer still owes: approved less received, once decided. */
export const insuranceExpected = (c: SafetyClaim) => (c.decision && c.decision !== 'denied' ? Math.max(0, (c.approvedCents ?? 0) - c.receivedCents) : 0);

/** The money a claim stands for, as the claim card reads it. */
export function finOf(c: SafetyClaim, charge: Pick<DriverCharge, 'amountCents' | 'recoveredCents' | 'state'> | null) {
  const gross = c.claimedCents ?? 0;
  const insurancePaid = c.receivedCents;
  const expected = insuranceExpected(c);
  const live = charge && !['waived', 'rejected', 'cancelled'].includes(charge.state) ? charge : null;
  const toRecover = live ? Math.max(0, live.amountCents - live.recoveredCents) : 0;
  const recovered = live ? live.recoveredCents : 0;
  const companyPaid = Math.max(0, gross - insurancePaid - expected);
  const net = Math.max(0, gross - insurancePaid - expected - toRecover - recovered);
  return { gross, companyPaid, insurancePaid, insuranceExpected: expected, toRecover, recovered, net, outstanding: expected + toRecover };
}

export interface ClaimKpis {
  open: number;
  openSub: string;
  gross: number;
  net: number;
  awaitingInsurance: number;
  awaitingExpected: number;
  onHold: number;
  onHoldCents: number;
  pendingAccounting: number;
  pendingAccountingCents: number;
  outstanding: number;
  disputed: number;
  stale: number;
  recoveredYtd: number;
}

export function kpisOf(claims: SafetyClaim[], charges: DriverCharge[], now = Date.now()): ClaimKpis {
  const open = claims.filter(isOpen);
  const year = new Date(now).getFullYear();
  const live = charges.filter((c) => !c.isTest || open.some((o) => o.id === c.claimId));
  const chargeOf = (id: string) => live.find((c) => c.claimId === id && !['waived', 'rejected', 'cancelled'].includes(c.state)) ?? null;
  const accidents = open.filter((c) => c.kind === 'liability' || c.kind === 'physical_damage').length;
  const cargo = open.filter((c) => c.kind === 'cargo').length;
  const fins = open.map((c) => finOf(c, chargeOf(c.id)));
  const onHold = live.filter((c) => c.state === 'on_hold');
  const pending = live.filter((c) => c.state === 'pending_accounting');
  const awaiting = open.filter((c) => ['submitted', 'insurer_review', 'decision', 'payment'].includes(c.stage));
  return {
    open: open.length,
    openSub: `${accidents} accident${accidents === 1 ? '' : 's'} · ${cargo} cargo`,
    gross: fins.reduce((s, f) => s + f.gross, 0),
    net: fins.reduce((s, f) => s + f.net, 0),
    awaitingInsurance: awaiting.length,
    awaitingExpected: awaiting.reduce((s, c) => s + insuranceExpected(c), 0),
    onHold: onHold.length,
    onHoldCents: onHold.reduce((s, c) => s + c.amountCents, 0),
    pendingAccounting: pending.length,
    pendingAccountingCents: pending.reduce((s, c) => s + c.amountCents, 0),
    outstanding: fins.reduce((s, f) => s + f.outstanding, 0),
    disputed: live.filter((c) => c.state === 'disputed').length,
    stale: open.filter((c) => daysSince(c.lastActivityAt, now) >= 7).length,
    recoveredYtd:
      claims.flatMap((c) => c.payments.filter((p) => !p.voidedAt && p.receivedOn.startsWith(String(year)))).reduce((s, p) => s + p.amountCents, 0) +
      live.flatMap((c) => c.recoveryLog.filter((l) => !l.reversed && l.at.startsWith(String(year)))).reduce((s, l) => s + l.cents, 0),
  };
}

export interface AttentionItem {
  key: string;
  claim: SafetyClaim;
  severity: 0 | 1 | 2;
  title: string;
  detail: string;
}

/** What needs someone today, most urgent first. */
export function attentionOf(claims: SafetyClaim[], charges: DriverCharge[], today: string, now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  for (const claim of claims.filter(isOpen)) {
    const kind = CLAIM_KIND_LABEL[claim.kind];
    const who = claim.ownerName ?? 'Unassigned';
    for (const ch of charges.filter((c) => c.claimId === claim.id)) {
      if (ch.state === 'on_hold')
        out.push({ key: `${ch.id}:hold`, claim, severity: 2, title: `Driver not informed of ${money(ch.amountCents)} charge`, detail: `${claim.number} · ${kind} · On hold ${ch.ageDays} day${ch.ageDays === 1 ? '' : 's'} · ${ch.driverName}` });
      if (ch.state === 'disputed')
        out.push({ key: `${ch.id}:dispute`, claim, severity: 2, title: `Driver disputes ${money(ch.amountCents)} charge`, detail: `${claim.number} · ${kind} · Waiting on Management · ${ch.ageDays} days` });
      if (ch.state === 'pending_management')
        out.push({ key: `${ch.id}:mgmt`, claim, severity: 1, title: `Management decision: ${ch.pendingChange?.kind === 'waive' ? 'waiver' : 'amount'} on ${money(ch.amountCents)} charge`, detail: `${claim.number} · ${kind} · asked by ${ch.pendingChange?.requestedBy ?? '—'}` });
      if (ch.state === 'pending_accounting')
        out.push({ key: `${ch.id}:acct`, claim, severity: 1, title: `Accounting approval needed · ${money(ch.amountCents)}`, detail: `${claim.number} · ${kind} · Sent ${ch.ageDays} day${ch.ageDays === 1 ? '' : 's'} ago` });
    }
    if (claim.nextAction && claim.nextActionDueOn && claim.nextActionDueOn < today)
      out.push({ key: `${claim.id}:overdue`, claim, severity: 2, title: `Overdue: ${claim.nextAction}`, detail: `${claim.number} · ${kind} · Due ${claim.nextActionDueOn} · ${who}` });
    if (claim.claimedCents === null)
      out.push({ key: `${claim.id}:reserve`, claim, severity: 1, title: 'Reserve not set', detail: `${claim.number} · ${kind} · exposure reads as unknown` });
    const idle = daysSince(claim.lastActivityAt, now);
    if (idle >= 7) out.push({ key: `${claim.id}:stale`, claim, severity: 0, title: `No update in ${idle} days`, detail: `${claim.number} · ${kind} · ${who}` });
  }
  return out.sort((a, b) => b.severity - a.severity || a.claim.number.localeCompare(b.claim.number));
}

/** Open exposure grouped by claim type, largest first. */
export function exposureByKind(claims: SafetyClaim[], charges: DriverCharge[]): { label: string; cents: number }[] {
  const by = new Map<string, number>();
  for (const c of claims.filter(isOpen)) {
    const charge = charges.find((x) => x.claimId === c.id) ?? null;
    by.set(CLAIM_KIND_LABEL[c.kind], (by.get(CLAIM_KIND_LABEL[c.kind]) ?? 0) + finOf(c, charge).gross);
  }
  for (const label of Object.values(CLAIM_KIND_LABEL)) if (!by.has(label)) by.set(label, 0);
  return [...by.entries()].map(([label, cents]) => ({ label, cents })).sort((a, b) => b.cents - a.cents);
}

export function ageBuckets(claims: SafetyClaim[], now = Date.now()): { label: string; count: number }[] {
  const b = [
    { label: '0–30 days', count: 0 },
    { label: '31–60 days', count: 0 },
    { label: '61–90 days', count: 0 },
    { label: '90+ days', count: 0 },
  ];
  for (const c of claims.filter(isOpen)) {
    const d = daysSince(`${c.openedOn}T12:00:00Z`, now);
    b[d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3]!.count += 1;
  }
  return b;
}

export const chargeStateLabel = (s: DriverCharge['state']) => DRIVER_CHARGE_STATE_LABEL[s];
