import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import type { CompanyState } from './state.service';
import type { ViewerContext } from './views';

/**
 * Equipment and money read models (P3). Pure: every number is the shared ledger (`financials`) over the rows the
 * state loaded — AP bills, work orders with estimates, claim payments — nothing is stored on the case.
 */

const opts = (ctx: ViewerContext) => ({ now: ctx.now, settings: ctx.settings, canSeeRestricted: ctx.canSeeRestricted });

/** The board row's money: projected net and what it rests on (SPEC §1.2 Net cost column). */
export function moneyOfRow(s: R.SafetyRulesState, c: R.AccidentCase, ctx: ViewerContext): A.BoardRow['money'] {
  const f = R.financials(s, c, opts(ctx));
  return { projectedNetCents: f.projectedNetCents, actualCents: f.actualCents, finalized: f.finalized, basis: f.finalized ? 'final' : f.actualCents > 0 ? 'spent' : 'estimate' };
}

export function woView(st: CompanyState, w: R.WorkOrder, ctx: ViewerContext): A.WorkOrderView {
  const s = st.all;
  const row = st.woRows.get(w.id);
  const money = ctx.seeMoney !== false;
  const bill = w.billId ? R.byId(s.bills, w.billId) : undefined;
  return {
    id: w.id,
    number: w.number,
    unitKind: w.unitKind,
    unit: (w.unitKind === 'truck' ? R.byId(s.trucks, w.unitId)?.unit : R.byId(s.trailers, w.unitId)?.unit) ?? row?.unitNumber ?? '?',
    shop: w.shop,
    status: w.status,
    title: w.title,
    estimates: w.estimates.map((e) => ({ id: e.id, vendor: e.vendor, amountCents: money ? e.amountCents : null, receivedAt: e.at, selected: Boolean(e.selected) })),
    estimatesRequired: w.estimatesRequired,
    approvedAmountCents: money ? (w.approvedAmountCents ?? null) : null,
    approvedBy: w.approvedBy ?? null,
    policyExceptionReason: row?.policyExceptionReason ?? null,
    eta: w.eta ?? null,
    invoiceNumber: w.invoiceNumber ?? null,
    invoiceTotalCents: money ? (w.invoiceTotalCents ?? null) : null,
    bill: bill ? { id: bill.id, number: bill.number } : null,
    shopInAt: w.shopInAt ?? w.openedAt,
    completedAt: w.completedAt ?? null,
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  };
}

export function financialsView(s: R.SafetyRulesState, c: R.AccidentCase, ctx: ViewerContext): A.FinancialsView {
  const f = R.financials(s, c, opts(ctx));
  const cats = new Map<string, A.FinancialsView['byCategory'][number]>();
  for (const l of f.lines) {
    if (l.group === 'exposure') continue;
    const row = cats.get(l.category) ?? { category: l.category, spentCents: 0, estimateCents: 0, recoveredCents: 0, expectedCents: 0 };
    if (l.group === 'actual') row.spentCents += l.amountCents;
    if (l.group === 'estimate') row.estimateCents += l.amountCents;
    if (l.group === 'recovered') row.recoveredCents += l.amountCents;
    if (l.group === 'expected') row.expectedCents += l.amountCents;
    cats.set(l.category, row);
  }
  const truck = R.truckOf(s, c);
  return {
    lines: f.lines,
    actualCents: f.actualCents,
    estimateCents: f.estimateCents,
    recoveredCents: f.recoveredCents,
    expectedCents: f.expectedCents,
    exposureCents: f.exposureCents,
    netToDateCents: f.netToDateCents,
    projectedNetCents: f.projectedNetCents,
    finalized: f.finalized,
    lostRevenue: { ...f.lostRevenue, fallback: truck?.dailyContributionCents === null || truck?.dailyContributionCents === undefined },
    restrictedClaimsExcluded: f.restrictedClaimsExcluded,
    byCategory: [...cats.values()],
  };
}

export function moneyBlock(st: CompanyState, c: R.AccidentCase, ctx: ViewerContext): A.CaseMoneyBlock {
  const s = st.all;
  const money = ctx.seeMoney !== false;
  const units = new Set([c.truckId, c.trailerId].filter(Boolean));
  return {
    financials: money ? financialsView(s, c, ctx) : null,
    workOrders: R.caseWOs(s, c).map((w) => woView(st, w, ctx)),
    unitStatus: st.unitStatus
      .filter((u) => units.has(u.unitId))
      .map((u) => ({ unitKind: u.unitKind as 'truck' | 'trailer', unitId: u.unitId, status: u.status, since: u.since.toISOString(), setBy: u.setBy, accidentId: u.accidentId })),
    apBills: s.bills
      .filter((b) => b.caseId === c.id)
      .map((b) => ({
        id: b.id,
        number: b.number,
        vendor: b.vendor,
        amountCents: money && !(b.claimId && R.byId(s.claims, b.claimId)?.restricted && !ctx.canSeeRestricted) ? b.amountCents : null,
        category: b.category,
        status: b.status,
        claimNumber: b.claimId ? (R.byId(s.claims, b.claimId)?.number ?? null) : null,
        workOrderNumber: b.woId ? (R.byId(s.workOrders, b.woId)?.number ?? null) : null,
      })),
  };
}
