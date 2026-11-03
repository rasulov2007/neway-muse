import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import type { CompanyState } from './state.service';
import type { ViewerContext } from './views';

/**
 * Claims read models (P2). Pure: the service loads, these compute with the shared rules (claimMoney, OPEN_CLAIM).
 * Redaction (API.md §4): on a restricted claim a viewer without accidents.restricted keeps number, type, status,
 * insurer, insurer claim #, owner, dates and the accident link — never the money, payments, claimant/responsible
 * party, adjuster, correspondence, attachments or follow-up text. Search never matches a redacted field.
 */

const personRef = (s: R.SafetyRulesState, id?: string | null): A.PersonRef | null => (id ? { id, name: R.personName(s, id) } : null);

export const hidden = (k: R.Claim, ctx: Pick<ViewerContext, 'canSeeRestricted'>): boolean => Boolean(k.restricted) && !ctx.canSeeRestricted;

function paidOrReceived(k: R.Claim): number {
  const m = R.claimMoney(k);
  return k.type === 'physical_damage' || k.type === 'recovery' ? m.toUsCents : m.insurerPaidCents + m.byUsCents;
}

export function claimRow(st: CompanyState, k: R.Claim, ctx: ViewerContext): A.ClaimRow {
  const s = st.all;
  const set = R.resolveSettings(ctx.settings);
  const hide = hidden(k, ctx);
  const open = R.OPEN_CLAIM(k.status);
  const c = k.caseId ? R.byId(s.cases, k.caseId) : undefined;
  const ageMs = ctx.now - Date.parse(k.lastUpdateAt);
  const staleDays = open && k.status !== 'Draft' && ageMs >= set.claimNoUpdateDays * R.DAY ? Math.floor(ageMs / R.DAY) : null;
  const fuOverdue = Boolean(open && k.nextFollowUp && Date.parse(k.nextFollowUp.at) < ctx.now);
  return {
    id: k.id,
    number: k.number,
    type: k.type,
    status: k.status,
    open,
    title: k.title,
    openedAt: k.openedAt,
    accident: c ? { id: c.id, number: c.number, stage: c.stage } : null,
    standaloneKind: k.standaloneKind ?? null,
    insurer: k.insurer,
    insurerClaimNo: k.insurerClaimNo ?? null,
    owner: personRef(s, k.ownerId),
    restricted: Boolean(k.restricted),
    isTest: k.isTest,
    claimant: hide ? null : (k.claimant ?? null),
    claimedCents: hide ? null : (k.claimedCents ?? null),
    reserveCents: hide ? null : (k.reserveCents ?? null),
    paidOrReceivedCents: hide ? null : paidOrReceived(k),
    nextFollowUp:
      k.nextFollowUp && open
        ? { at: k.nextFollowUp.at, assignee: personRef(s, k.nextFollowUp.assigneeId), what: hide ? null : k.nextFollowUp.what, overdue: fuOverdue }
        : null,
    lastUpdateAt: k.lastUpdateAt,
    staleDays,
    needsFollowUp: staleDays !== null || fuOverdue,
    redacted: hide ? [...A.CLAIM_REDACTED_FIELDS] : [],
  };
}

function matches(st: CompanyState, k: R.Claim, q: string, ctx: ViewerContext): boolean {
  const c = k.caseId ? R.byId(st.all.cases, k.caseId) : undefined;
  const hide = hidden(k, ctx);
  const hay = [k.number, k.title, k.insurer, k.insurerClaimNo, hide ? null : k.claimant, k.standaloneKind, c?.number, k.unitLabel, R.CLAIM_TYPE_LABEL[k.type]]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function listClaims(st: CompanyState, q: A.ClaimListQuery, ctx: ViewerContext): A.ClaimListResponse {
  const all = st.all.claims;
  const rows = all.map((k) => ({ k, row: claimRow(st, k, ctx) }));
  const chipOf: Record<A.ClaimChip, (x: (typeof rows)[number]) => boolean> = {
    needs_follow_up: (x) => x.row.needsFollowUp,
    open: (x) => x.row.open,
    money_to_us: (x) => x.k.type === 'recovery' || x.k.type === 'physical_damage',
    settled: (x) => !x.row.open,
    all: () => true,
  };
  const chip = q.chip ?? 'open';
  const filtered = rows
    .filter(chipOf[chip])
    .filter((x) => !q.origin || q.origin === 'all' || (q.origin === 'accident' ? Boolean(x.k.caseId) : !x.k.caseId))
    .filter((x) => !q.type || x.k.type === q.type)
    .filter((x) => !q.status || x.k.status === q.status)
    .filter((x) => !q.insurer || x.k.insurer === q.insurer)
    .filter((x) => !q.accidentId || x.k.caseId === q.accidentId)
    .filter((x) => !q.q || matches(st, x.k, q.q, ctx))
    .sort((a, b) => Date.parse(b.k.openedAt) - Date.parse(a.k.openedAt));
  const counts = Object.fromEntries(A.CLAIM_CHIPS.map((c) => [c, rows.filter(chipOf[c]).length])) as Record<A.ClaimChip, number>;
  return { items: filtered.map((x) => x.row), total: filtered.length, counts, insurers: [...new Set(all.map((k) => k.insurer).filter(Boolean))].sort() };
}

/** Claims page KPIs (SPEC §1.5). Test claims never count; restricted money is left out for a viewer without the right. */
export function claimsSummary(st: CompanyState, ctx: ViewerContext): A.ClaimsSummaryResponse {
  const s = st.live;
  const set = R.resolveSettings(ctx.settings);
  const open = s.claims.filter((k) => R.OPEN_CLAIM(k.status));
  const visible = R.visibleClaims(open, ctx.canSeeRestricted);
  const m = visible.map((k) => R.claimMoney(k));
  const stale = open.filter((k) => k.status !== 'Draft' && ctx.now - Date.parse(k.lastUpdateAt) >= set.claimNoUpdateDays * R.DAY);
  const fuOver = open.filter((k) => k.nextFollowUp && Date.parse(k.nextFollowUp.at) < ctx.now);
  // "Recovered {year}": the US Eastern calendar year of the server clock (every business date is Eastern).
  const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: R.EASTERN, year: 'numeric' }).format(new Date(ctx.now)));
  const inYear = (iso: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: R.EASTERN, year: 'numeric' }).format(new Date(iso))) === year;
  const recovered = R.visibleClaims(s.claims, ctx.canSeeRestricted)
    .flatMap((k) => k.payments)
    .filter((p) => p.direction === 'to_us' && inYear(p.at))
    .reduce((a, p) => a + p.amountCents, 0);
  return {
    open: { value: open.length, fromAccidents: open.filter((k) => k.caseId).length, standalone: open.filter((k) => !k.caseId).length },
    stillToRecoverCents: m.reduce((a, x) => a + x.expectedRecoveryCents, 0),
    ourShareCents: m.reduce((a, x) => a + x.companyEstimateCents, 0),
    insurerReservesCents: m.reduce((a, x) => a + x.insurerReserveCents, 0),
    recoveredYear: { year, cents: recovered },
    needsFollowUp: { value: new Set([...stale, ...fuOver].map((k) => k.id)).size, noUpdate: stale.length, followUpsOverdue: fuOver.length },
    noUpdateDays: set.claimNoUpdateDays,
    restrictedExcluded: open.length - visible.length,
  };
}

/** A claim card on the case page (Claims & costs, Overview). */
export function claimCard(st: CompanyState, k: R.Claim, ctx: ViewerContext): A.CaseClaimCard {
  const s = st.all;
  const hide = hidden(k, ctx);
  const row = st.claimRows.get(k.id);
  return {
    id: k.id,
    number: k.number,
    type: k.type,
    status: k.status,
    title: k.title,
    insurer: k.insurer,
    insurerClaimNo: k.insurerClaimNo ?? null,
    restricted: Boolean(k.restricted),
    version: row?.version ?? 1,
    adjuster: hide ? null : (k.adjuster?.name ?? null),
    claimedCents: hide ? null : (k.claimedCents ?? null),
    reserveCents: hide ? null : (k.reserveCents ?? null),
    deductibleCents: hide ? null : (k.deductibleCents ?? null),
    receivedOrPaidCents: hide ? null : paidOrReceived(k),
    nextFollowUp: k.nextFollowUp && R.OPEN_CLAIM(k.status) ? { at: k.nextFollowUp.at, what: hide ? null : k.nextFollowUp.what, assignee: personRef(s, k.nextFollowUp.assigneeId) } : null,
  };
}
