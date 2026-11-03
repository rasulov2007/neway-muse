import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { claimCard } from './claims-views';
import { investigationBlock } from './investigation-views';
import { moneyBlock, moneyOfRow } from './money-views';
import type { CompanyState } from './state.service';

/**
 * Read models built from a company's state with the shared rules. Pure: the service loads, these compute.
 * Every number comes from `safetyRules`; nothing is re-derived here.
 */

export interface ViewerContext {
  now: number;
  canSeeRestricted: boolean;
  settings: Partial<R.SafetyRuleSettings>;
  /** false for the shop-floor role (maintenance without maintenance_costs.view): repair costs are never sent. */
  seeMoney?: boolean;
  /** accidents.legal / accidents.discipline (P4); default = canSeeRestricted. */
  canLegal?: boolean;
  canDiscipline?: boolean;
}

const NEW_MS = 30 * 60_000;

export function personRef(s: R.SafetyRulesState, id: string | undefined | null): A.PersonRef | null {
  if (!id) return null;
  const p = R.byId(s.people, id);
  return { id, name: p?.name ?? id };
}

export function rangeOf(q: A.RangeQuery, now: number): { key: A.RangeKeyV2; from: string; to: string } {
  if (q.range === 'custom' || (!q.range && (q.from || q.to))) {
    const to = q.to ?? new Date(now).toISOString();
    const from = q.from ?? new Date(Date.parse(to) - 90 * R.DAY).toISOString();
    return { key: 'custom', from, to };
  }
  const key = (q.range ?? '90d') as R.RangeKey;
  // YTD and every range end at the server clock; YTD starts at Eastern midnight Jan 1 (CLAUDE.md).
  const r = R.makeRange(key, now, R.EASTERN);
  return { key, from: r.from, to: r.to };
}

const inRange = (iso: string, r: { from: string; to: string }) => iso >= r.from && iso <= r.to;

/** Needs attention with display names, for the panel and the case page. */
export function attentionItems(s: R.SafetyRulesState, ctx: ViewerContext): A.AttentionItem[] {
  return R.needsAttention(s, { now: ctx.now, settings: ctx.settings }).map((a) => {
    const c = a.caseId ? R.byId(s.cases, a.caseId) : undefined;
    const truck = c ? R.truckOf(s, c) : undefined;
    const k = a.claimId ? R.byId(s.claims, a.claimId) : undefined;
    // A restricted claim's follow-up text is redacted (API.md §4); its number, date and assignee stay.
    const title = k?.restricted && !ctx.canSeeRestricted && a.reason === 'Follow-up overdue' ? `${k.number}: follow-up (restricted)` : a.title;
    return {
      ...a,
      title,
      ...(c ? { caseNumber: c.number } : {}),
      ...(truck ? { truckUnit: truck.unit } : {}),
      ...(a.assigneeId ? { assigneeName: R.personName(s, a.assigneeId) } : {}),
    };
  });
}

function boardRow(st: CompanyState, c: R.AccidentCase, urgent: Set<string>, ctx: ViewerContext): A.BoardRow {
  const s = st.all;
  const truck = R.truckOf(s, c);
  const trailer = R.trailerOf(s, c);
  const driver = R.driverOf(s, c);
  const dt = R.downtimeFor(s, c, { now: ctx.now });
  const na = R.nextAction(s, c);
  const ks = R.caseClaims(s, c);
  const next: A.BoardRow['next'] =
    c.stage === 'closed'
      ? { closedNote: c.closure ? `Closed ${R.fmtShort(c.closure.at, R.EASTERN, ctx.now)}` : 'Closed' }
      : na
        ? { title: na.title, dept: na.dept, assignee: personRef(s, na.assigneeId), dueAt: na.due, overdue: R.isOverdue(na, ctx.now) }
        : null;
  return {
    id: c.id,
    number: c.number,
    stage: c.stage,
    isNew: ctx.now - Date.parse(c.createdAt) < NEW_MS,
    isDraft: c.stage === 'draft',
    isTest: c.isTest,
    occurredAt: c.occurredAt,
    occurredTz: c.tz,
    truck: truck ? { id: truck.id, unit: truck.unit } : null,
    trailer: trailer ? { id: trailer.id, unit: trailer.unit } : null,
    driver: driver ? { id: driver.id, name: driver.name } : null,
    location: { city: c.location.city, state: c.location.state, road: c.location.road ?? null },
    severity: c.severity,
    accidentType: c.type,
    investigationStatus: c.investigation.status,
    equipment: {
      truckDownNow: dt.ongoing,
      truckDownMs: dt.ongoing ? dt.truckMs : 0,
      wasDownMs: dt.ongoing ? 0 : dt.truckMs,
    },
    claims: {
      open: ks.filter((k) => R.OPEN_CLAIM(k.status)).length,
      total: ks.length,
      allSettled: ks.length > 0 && ks.every((k) => !R.OPEN_CLAIM(k.status)),
    },
    money: ctx.seeMoney === false ? null : moneyOfRow(s, c, ctx),
    next,
    urgent: urgent.has(c.id),
  };
}

function matches(st: CompanyState, c: R.AccidentCase, q: string): boolean {
  const s = st.all;
  const hay = [
    c.number,
    R.truckOf(s, c)?.unit,
    R.truckOf(s, c) ? `truck ${R.truckOf(s, c)?.unit}` : '',
    R.trailerOf(s, c)?.unit,
    R.driverOf(s, c)?.name,
    c.location.city,
    c.location.state,
    c.location.road,
    c.type,
    c.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function board(st: CompanyState, query: A.BoardQuery, ctx: ViewerContext): A.BoardResponse {
  const s = st.all;
  const range = rangeOf(query, ctx.now);
  const chip = query.chip ?? 'open';
  const attention = R.needsAttention(s, { now: ctx.now, settings: ctx.settings });
  const urgent = new Set(attention.filter((a) => a.tone === 'urgent' && a.caseId).map((a) => a.caseId as string));
  const withAttention = new Set(attention.filter((a) => a.caseId).map((a) => a.caseId as string));
  let rows = s.cases.filter((c) => {
    switch (chip) {
      case 'open':
        return R.isOpenCase(c);
      case 'serious':
        return R.isOpenCase(c) && (c.severity === 'serious' || c.severity === 'critical');
      case 'attention':
        return withAttention.has(c.id) && c.stage !== 'draft';
      case 'drafts':
        return c.stage === 'draft';
      case 'closed':
        return c.stage === 'closed' && inRange(c.occurredAt, range);
      case 'all':
        return c.stage !== 'draft' && inRange(c.occurredAt, range);
      case 'register':
        return c.stage !== 'draft' && inRange(c.occurredAt, range) && R.dotRecordable(c).value === 'yes';
    }
    return false;
  });
  if (query.q) rows = rows.filter((c) => matches(st, c, query.q as string));
  if (query.driverId) rows = rows.filter((c) => c.driverId === query.driverId);
  if (query.truckId) rows = rows.filter((c) => c.truckId === query.truckId);
  if (query.severity) rows = rows.filter((c) => c.severity === query.severity);
  if (query.stage) rows = rows.filter((c) => c.stage === query.stage);
  if (query.type) rows = rows.filter((c) => c.type === query.type);
  if (query.ownerId) rows = rows.filter((c) => c.ownerId === query.ownerId);
  if (query.investigation) rows = rows.filter((c) => c.investigation.status === query.investigation);
  if (query.nextDept) rows = rows.filter((c) => R.nextAction(s, c)?.dept === query.nextDept);
  if (query.truckDown) {
    const want = query.truckDown === 'true';
    rows = rows.filter((c) => R.downtimeFor(s, c, { now: ctx.now }).ongoing === want);
  }
  rows.sort((a, b) => (a.stage === 'draft' ? 0 : 1) - (b.stage === 'draft' ? 0 : 1) || Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const pageSize = query.pageSize ?? 50;
  const page = query.page ?? 1;
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);
  return {
    items: slice.map((c) => boardRow(st, c, urgent, ctx)),
    total: rows.length,
    page,
    pageSize,
    draftsCount: s.cases.filter((c) => c.stage === 'draft').length,
    range,
  };
}

export function summary(st: CompanyState, q: A.RangeQuery, ctx: ViewerContext): A.BoardSummaryResponse {
  const s = st.live;
  const range = rangeOf(q, ctx.now);
  const b = R.boardSummary(s, { key: range.key === 'custom' ? 'custom' : range.key, from: range.from, to: range.to }, {
    now: ctx.now,
    settings: ctx.settings,
    canSeeRestricted: ctx.canSeeRestricted,
  });
  const trucksDown: A.BoardSummaryResponse['trucksDown'] = [];
  for (const d of s.downtime) {
    if (d.end || d.unitKind !== 'truck') continue;
    const c = R.byId(s.cases, d.caseId);
    if (!c || c.stage === 'draft') continue;
    const eq = c.equipment.truck;
    trucksDown.push({
      truckId: d.unitId,
      unit: R.byId(s.trucks, d.unitId)?.unit ?? '?',
      accidentId: c.id,
      number: c.number,
      downMs: ctx.now - Date.parse(d.start),
      location: eq.towedTo || R.EQUIP_STATUS_LABEL[eq.status],
      downSince: d.start,
      workOrder: (() => {
        const w = R.caseWOs(s, c).find((x) => x.unitId === d.unitId && x.status !== 'Completed');
        return w ? { id: w.id, number: w.number, status: w.status, estimates: w.estimates.length, estimatesRequired: w.estimatesRequired } : null;
      })(),
    });
  }
  trucksDown.sort((a, b2) => b2.downMs - a.downMs);
  return {
    range,
    kpis: {
      openCases: { value: b.openCases, serious: b.serious, awaitingInvestigation: b.awaitingInvestigation },
      reported: { value: b.reported, prior: b.priorPeriod, delta: b.reported - b.priorPeriod },
      trucksDownNow: { value: b.trucksDownNow, truckDaysInRange: b.truckDaysInRange },
      needsAttention: { value: b.needsAttention, overdueTasks: b.overdueTasks, urgent: b.urgent },
      openClaims: { value: b.openClaims, ourCostToComeCents: ctx.seeMoney === false ? 0 : b.ourCostToComeCents, insurerReservesCents: ctx.seeMoney === false ? 0 : b.insurerReservesCents },
      netCost: ctx.seeMoney === false ? null : { projectedNetCents: b.netCostCents, spentCents: b.spentCents, recoveredCents: b.recoveredCents, lostRevenueCents: b.lostRevenueNotCashCents },
      restrictedClaimsExcluded: b.restrictedClaimsExcluded,
    },
    attention: attentionItems(s, ctx),
    trucksDown,
    attentionSources: ['tasks', 'testing windows', 'drafts', 'investigation', 'police report', 'units at the scene', 'storage', 'management review', 'claims', 'work orders'],
  };
}

export function register(st: CompanyState, q: A.RangeQuery, ctx: ViewerContext): A.RegisterRow[] {
  const s = st.live;
  const range = rangeOf(q, ctx.now);
  return s.cases
    .filter((c) => c.stage !== 'draft' && inRange(c.occurredAt, range) && R.dotRecordable(c).value === 'yes')
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .map((c) => ({
      accidentId: c.id,
      caseNumber: c.number,
      date: R.fmtDate(c.occurredAt, c.tz),
      cityOrNearest: c.location.city,
      state: c.location.state,
      driverName: R.driverOf(s, c)?.name ?? '',
      injuriesTreatedAway: c.injuries.status === 'no' ? 0 : c.injuries.treatedAway,
      fatalities: c.injuries.status === 'no' ? 0 : c.injuries.fatalities,
      hazmatReleased: c.hazmat === 'yes' ? 'Yes' : c.hazmat === 'no' ? 'No' : 'Not answered',
    }));
}

const csvCell = (v: unknown) => {
  const t = v === null || v === undefined ? 'Not known' : String(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export function registerCsv(rows: A.RegisterRow[]): string {
  const head = ['Date', 'City or nearest town', 'State', 'Driver', 'Injuries (treated away)', 'Fatalities', 'Hazmat released', 'Case'];
  const lines = rows.map((r) => [r.date, r.cityOrNearest, r.state, r.driverName, r.injuriesTreatedAway, r.fatalities, r.hazmatReleased, r.caseNumber].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}

/** The case for the viewer: restricted values removed (API.md §0 redaction), with the list of what was removed. */
export function redactCase(c: R.AccidentCase, who: boolean | Pick<ViewerContext, 'canSeeRestricted' | 'canLegal' | 'canDiscipline'>): { case: R.AccidentCase; redacted: string[] } {
  const v = typeof who === 'boolean' ? { canSeeRestricted: who } : who;
  const canLegal = v.canLegal ?? v.canSeeRestricted;
  const canDiscipline = v.canDiscipline ?? v.canSeeRestricted;
  if (v.canSeeRestricted && canLegal && canDiscipline) return { case: c, redacted: [] };
  const redacted: string[] = [];
  const out: R.AccidentCase = JSON.parse(JSON.stringify(c));
  if (!v.canSeeRestricted) {
    // Witness contacts and restricted evidence-review notes are restricted (SPEC §8.3; ACCEPTANCE K6).
    out.witnesses = out.witnesses.map((w) => (w.contact ? (redacted.push(`witnesses.${w.id}.contact`), { ...w, contact: '' }) : w));
    out.investigation.checklist = out.investigation.checklist.map((i) => (i.restricted && i.note ? (redacted.push(`checklist.${i.key}.note`), { ...i, note: undefined }) : i));
  }
  if (!v.canSeeRestricted && out.injuries.detailsRestricted) {
    delete out.injuries.detailsRestricted;
    redacted.push('injuries.medicalDetails');
  }
  for (const k of ['alcohol', 'drug'] as const) {
    if (!v.canSeeRestricted && out.testing[k].resultRestricted) {
      delete out.testing[k].resultRestricted;
      redacted.push(`testing.${k}.result`);
    }
  }
  if (!canLegal && (out.determinations.legal.value !== 'unknown' || out.determinations.legal.basis)) {
    out.determinations.legal = { value: 'unknown' };
    redacted.push('determinations.legal');
  }
  out.correctiveActions = out.correctiveActions.map((a) => {
    if (!a.restricted || canDiscipline) return a;
    redacted.push(`correctiveActions.${a.id}`);
    return { ...a, title: 'Restricted personnel action', evidence: undefined };
  });
  return { case: out, redacted };
}

export function detail(st: CompanyState, id: string, ctx: ViewerContext, perms: A.CaseDetailResponse['permissions']): A.CaseDetailResponse | null {
  const s = st.all;
  const c = R.byId(s.cases, id);
  const row = st.rows.get(id);
  if (!c || !row) return null;
  const o = { now: ctx.now, settings: ctx.settings };
  const ov = { ...o, canSeeRestricted: ctx.canSeeRestricted };
  const tasks = s.tasks.filter((t) => t.caseId === id && R.openTask(t));
  const na = R.nextAction(s, c);
  const dt = R.downtimeFor(s, c, o);
  const unitLabel = (kind: string, unitId: string) =>
    (kind === 'truck' ? R.byId(s.trucks, unitId)?.unit : R.byId(s.trailers, unitId)?.unit) ?? '?';
  const truck = R.truckOf(s, c);
  const trailer = R.trailerOf(s, c);
  const driver = R.driverOf(s, c);
  const load = c.loadId ? st.loadInfo.get(c.loadId) : undefined;
  const rep = R.repeatSignals(s, c);
  const hash = R.factsHash(c);
  const { case: shown, redacted } = redactCase(c, ctx);
  return {
    case: shown,
    version: row.version,
    redacted,
    display: {
      truck: truck ? { id: truck.id, unit: truck.unit } : null,
      trailer: trailer ? { id: trailer.id, unit: trailer.unit } : null,
      driver: driver ? { id: driver.id, name: driver.name } : null,
      load: load ? { id: load.id, number: load.number, customer: load.customer, broker: load.broker, origin: load.origin, destination: load.destination } : null,
      owner: personRef(s, c.ownerId),
      reportedBy: row.createdBy,
      closedBy: c.closure ? R.personName(s, c.closure.by) : null,
      voided: Boolean(row.voidedAt),
    },
    units: (st.units.get(id) ?? []).map((u) => ({
      id: u.id,
      unitKind: u.unitKind as 'truck' | 'trailer',
      unitId: u.unitId,
      unit: u.unitNumber ?? unitLabel(u.unitKind, u.unitId),
      conditionAtScene: u.conditionAtScene as A.UnitView['conditionAtScene'],
      status: u.status as A.UnitView['status'],
      damage: u.damage,
      towCompany: u.towCompany,
      towedTo: u.towedTo,
      storageRateCents: u.storageRateCents,
      storageSince: u.storageSince?.toISOString() ?? null,
      returnedToServiceAt: u.returnedToServiceAt?.toISOString() ?? null,
      version: u.version,
    })),
    people: s.people.map((p) => ({ id: p.id, name: p.name })),
    computed: {
      dotRecordable: R.dotRecordable(c),
      testing: R.testing(c, o),
      suggestedSeverity: R.suggestedSeverity(c, o),
      tracks: R.tracks(s, c, ov),
      advanceBlockers: c.stage === 'closed' || c.stage === 'draft' ? [] : R.advanceBlockers(s, c, o),
      closeBlockers: c.stage === 'closed' || c.stage === 'draft' ? [] : R.closeBlockers(s, c, o),
      nextAction: na
        ? { taskId: na.id, title: na.title, dept: na.dept, assignee: personRef(s, na.assigneeId), dueAt: na.due, overdue: R.isOverdue(na, ctx.now), moreOpen: tasks.length - 1 }
        : null,
      downtime: {
        periods: dt.periods.map((p) => {
          const dRow = st.downtimeRows.find((x) => x.id === p.id);
          return {
            id: p.id,
            unitKind: p.unitKind,
            unitId: p.unitId,
            unit: unitLabel(p.unitKind, p.unitId),
            startedAt: p.start,
            endedAt: p.end ?? null,
            ms: p.ms,
            ongoing: p.ongoing,
            source: (dRow?.source ?? 'entered') as A.DowntimeView['source'],
            verifiedBy: p.verifiedBy ?? null,
            note: p.note ?? null,
            version: dRow?.version ?? 1,
          };
        }),
        truckMs: dt.truckMs,
        trailerMs: dt.trailerMs,
        ongoing: dt.ongoing,
      },
      expectedEvidence: R.expectedEvidence(s, c),
      repeatSignals: { sameDriver: rep.sameDriver.map((x) => ({ id: x.id, number: x.number })), sameTruck: rep.sameTruck.map((x) => ({ id: x.id, number: x.number })) },
      summaryParts: R.summary(s, c, ctx.canSeeRestricted, o),
      factsHash: hash,
      summaryStale: Boolean(c.summaryOverride && c.summaryOverride.factsHash !== hash),
      attention: attentionItems(s, ctx).filter((a) => a.caseId === id),
      openTasks: tasks.length,
      overdueTasks: tasks.filter((t) => R.isOverdue(t, ctx.now)).length,
      evidenceCount: s.evidence.filter((e) => e.caseId === id && !e.removed).length,
      claims: R.caseClaims(s, c).map((k) => claimCard(st, k, ctx)),
      restrictedClaims: ctx.canSeeRestricted ? 0 : R.caseClaims(s, c).filter((k) => k.restricted).length,
      money: moneyBlock(st, c, ctx),
      investigation: investigationBlock(st, c, ctx),
    },
    permissions: perms,
  };
}

export function taskView(st: CompanyState, t: R.Task, now: number): A.TaskView {
  const row = st.taskRows.get(t.id);
  const c = t.caseId ? R.byId(st.all.cases, t.caseId) : undefined;
  return {
    id: t.id,
    accidentId: t.caseId ?? null,
    caseNumber: c?.number ?? null,
    claimId: t.claimId ?? null,
    workOrderId: row?.workOrderId ?? null,
    title: t.title,
    dept: t.dept,
    assignee: personRef(st.all, t.assigneeId),
    dueAt: t.due,
    status: t.status,
    priority: t.priority,
    instructions: t.instructions ?? null,
    blockedReason: t.blockedReason ?? null,
    autoRule: t.auto ?? null,
    requestKind: (row?.requestKind as A.TaskView['requestKind']) ?? null,
    confirmedBy: row?.confirmedBy ?? null,
    confirmedAt: row?.confirmedAt?.toISOString() ?? null,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    completedBy: t.completedBy ?? null,
    completedAt: t.completedAt ?? null,
    overdue: R.isOverdue(t, now),
    version: row?.version ?? 1,
    updates: t.updates,
  };
}
