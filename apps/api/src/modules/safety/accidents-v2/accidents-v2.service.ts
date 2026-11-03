import { Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import type { Database } from '../../../database/client';
import { DatabaseService } from '../../../database/database.service';
import { accidentRestricted, accidentUnits, downtimePeriods, restrictedAccessLog, safetyTasks, safetyTimelineEvents, type AccidentUnitRow } from '../../../database/schema/accidents-v2';
import { acctBills } from '../../../database/schema/accounting';
import { storedFiles } from '../../../database/schema/files';
import { trailers, workOrders } from '../../../database/schema/fleet';
import { loads } from '../../../database/schema/loads';
import { drivers, trucks } from '../../../database/schema/roster';
import { drugAlcoholTests, safetyAccidents, safetyCaseDocuments, safetyClaims, type SafetyAccidentRow } from '../../../database/schema/safety';
import { AuditService, type AuditChange, type AuditEvent } from '../../people/audit.service';
import { SafetyCoreService } from '../safety-core.service';
import { AccidentsV2StateService, loadInfoOf, type CompanyState } from './state.service';
import * as V from './views';

/** A timeline event written with a case change. */
export interface CaseEvent {
  text: string;
  source: R.EventSource;
  kind: 'milestone' | 'change' | 'note' | 'task';
  at?: Date;
  logged: Date;
  restricted?: boolean;
  before?: unknown;
  after?: unknown;
  actorName?: string;
}

/** Postgres transaction or the database itself. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Exec = Database | Tx;

/** Audit entity of an accident (the same one Safety v2 uses, so one trail per case). */
const ENTITY = 'safety_accident';

const STAGE_ORDER: R.Stage[] = ['draft', 'initial_response', 'investigation', 'resolution', 'closed'];
const IN_SERVICE = new Set(['operational', 'returned', 'not_involved']);
const CARGO_FIELDS = new Set(['cargo', 'cargoPlan', 'cargoNotes', 'cargoDeliveryImpact', 'brokerNotified']);

/** Problem with field errors (RFC 7807 `/problems/validation`). */
function invalid(errors: { path: string; message: string }[], extra?: Record<string, unknown>): AppError {
  return new AppError({
    status: 422,
    title: 'Unprocessable Entity',
    type: '/problems/validation',
    detail: errors.map((e) => e.message).join('; '),
    extensions: { errors, ...(extra ?? {}) },
  });
}
function forbidden(permission: string, detail: string): AppError {
  return new AppError({ status: 403, title: 'Forbidden', type: '/problems/forbidden', detail, extensions: { permission } });
}
function conflict(current: { version: number; updatedAt: Date }, label: string): AppError {
  return new AppError({
    status: 409,
    title: 'Conflict',
    type: '/problems/version-conflict',
    detail: `${label} was changed by someone else at ${current.updatedAt.toISOString()}. Reload it and make your change again.`,
    extensions: { currentVersion: current.version },
  });
}

/**
 * Repair costs on a case are hidden from the shop-floor role only (maintenance.view without maintenance_costs.view —
 * "sees what is due and what is in; never what it cost"); everyone else with accidents.view sees the ledger (SPEC §8.3).
 */
export function seesMoney(p: Principal): boolean {
  if (['accidents.edit', 'accidents.claim_money', 'accidents.bills', 'maintenance_costs.view', 'accounting.view'].some((c) => hasPermission(p, c))) return true;
  return !hasPermission(p, 'maintenance.view');
}

/** Composed legacy `location` label (NOT NULL on the table; the old pages read it). */
function locationLabel(road?: string | null, detail?: string | null, city?: string | null, state?: string | null): string {
  const where = [road, detail].filter(Boolean).join(' ');
  const town = [city, state].filter(Boolean).join(', ');
  return [where, town].filter(Boolean).join(', ') || 'Not recorded yet';
}

interface Lookups {
  truck: { id: string; number: string } | null;
  driver: { id: string; name: string } | null;
  trailer: { id: string; number: string } | null;
  load: { id: string; number: string } | null;
}

@Injectable()
export class AccidentsV2Service {
  constructor(
    private readonly database: DatabaseService,
    private readonly core: SafetyCoreService,
    private readonly audit: AuditService,
    private readonly state: AccidentsV2StateService,
  ) {}

  private get db() {
    return this.database.db;
  }
  private now(): Date {
    return this.core.now();
  }
  private actor(p: Principal): string {
    return this.core.actor(p);
  }
  newId(prefix: string): string {
    return this.core.newId(prefix);
  }

  viewer(p: Principal): V.ViewerContext & { perms: A.CaseDetailResponse['permissions'] } {
    return {
      now: this.now().getTime(),
      canSeeRestricted: hasPermission(p, 'accidents.restricted'),
      settings: {},
      seeMoney: seesMoney(p),
      canLegal: hasPermission(p, 'accidents.legal'),
      canDiscipline: hasPermission(p, 'accidents.discipline'),
      perms: {
        edit: hasPermission(p, 'accidents.edit'),
        editCargo: hasPermission(p, 'accidents.edit') || hasPermission(p, 'accidents.edit_cargo'),
        restricted: hasPermission(p, 'accidents.restricted'),
        override: hasPermission(p, 'accidents.override'),
        confirm: hasPermission(p, 'accidents.confirm'),
        claimMoney: hasPermission(p, 'accidents.claim_money'),
        fleet: hasPermission(p, 'accidents.fleet'),
        editUnits: hasPermission(p, 'accidents.edit') || hasPermission(p, 'accidents.edit_units'),
        bills: hasPermission(p, 'accidents.edit') || hasPermission(p, 'accidents.bills'),
        seeMoney: seesMoney(p),
        determine: hasPermission(p, 'accidents.determine'),
        legal: hasPermission(p, 'accidents.legal'),
        approve: hasPermission(p, 'accidents.approve'),
        discipline: hasPermission(p, 'accidents.discipline'),
      },
    };
  }

  async loadState(p: Principal, opts: { events?: boolean; accidentId?: string } = {}): Promise<{ st: CompanyState; ctx: ReturnType<AccidentsV2Service['viewer']> }> {
    const st = await this.state.load(p.companyId, opts);
    const ctx = this.viewer(p);
    ctx.settings = st.settings;
    return { st, ctx };
  }

  // ======================================================================================= reads

  async board(p: Principal, q: A.BoardQuery): Promise<A.BoardResponse> {
    const { st, ctx } = await this.loadState(p);
    return V.board(st, q, ctx);
  }

  async summary(p: Principal, q: A.RangeQuery): Promise<A.BoardSummaryResponse> {
    const { st, ctx } = await this.loadState(p);
    return V.summary(st, q, ctx);
  }

  async register(p: Principal, q: A.RangeQuery): Promise<A.RegisterRow[]> {
    const { st, ctx } = await this.loadState(p);
    return V.register(st, q, ctx);
  }

  // ===================================================================================== P5 analytics & profiles

  /** Analytics for a range (SPEC §1.6, §7.14; API.md §6) — the shared rule, with Fleet's mileage and coverage. */
  async analytics(p: Principal, q: A.RangeQuery): Promise<A.AnalyticsResponse> {
    const { st, ctx } = await this.loadState(p);
    const range = V.rangeOf(q, ctx.now);
    const months = R.monthsOf(range.from, range.to, R.EASTERN);
    const mileage = await this.state.mileage(p.companyId, months);
    const s: R.SafetyRulesState = { ...st.live, mileage };
    const out = R.analytics(s, { key: range.key === 'custom' ? 'custom' : range.key, from: range.from, to: range.to }, { now: ctx.now, settings: ctx.settings, canSeeRestricted: ctx.canSeeRestricted, seeMoney: ctx.seeMoney, zone: R.EASTERN });
    const ids = new Set([...out.kpis.caseIds, ...out.repeatInvolvement.flatMap((r) => r.caseIds)]);
    const cases: A.AnalyticsResponse['cases'] = {};
    for (const id of ids) {
      const c = R.byId(s.cases, id);
      if (!c) continue;
      cases[id] = {
        id,
        number: c.number,
        occurredAt: c.occurredAt,
        tz: c.tz,
        truckUnit: R.truckOf(s, c)?.unit ?? null,
        driverName: R.driverOf(s, c)?.name ?? null,
        type: c.type,
        severity: c.severity,
        preventability: c.determinations.preventability.value,
        netCostCents: ctx.seeMoney ? R.financials(s, c, { now: ctx.now, settings: ctx.settings, canSeeRestricted: ctx.canSeeRestricted }).projectedNetCents : null,
      };
    }
    return { ...out, cases };
  }

  /** Sidebar badge (prototype Shell: urgent items on Accidents). */
  async counts(p: Principal): Promise<A.AccidentCounts> {
    const { st, ctx } = await this.loadState(p);
    const b = R.boardSummary(st.live, R.makeRange('30d', ctx.now, R.EASTERN), { now: ctx.now, settings: ctx.settings, canSeeRestricted: ctx.canSeeRestricted });
    return { urgent: b.urgent, needsAttention: b.needsAttention, openCases: b.openCases };
  }

  /**
   * A truck's, trailer's or driver's accident section (SPEC §6.2–6.3; API.md §5). Reads safety_accidents through the
   * same state as the board, so a unit with one accident and no other history still shows it (ACCEPTANCE L3).
   */
  async profile(p: Principal, kind: 'truck' | 'trailer' | 'driver', unitId: string): Promise<A.ProfileAccidentsResponse> {
    const { st, ctx } = await this.loadState(p);
    const s = st.live;
    const o = { now: ctx.now, settings: ctx.settings, canSeeRestricted: ctx.canSeeRestricted };
    const mine = s.cases
      .filter((c) => c.stage !== 'draft' && (kind === 'truck' ? c.truckId === unitId : kind === 'trailer' ? c.trailerId === unitId : c.driverId === unitId))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const yearAgo = ctx.now - 365 * R.DAY;
    const recent = mine.filter((c) => Date.parse(c.occurredAt) > yearAgo);
    const days = (c: R.AccidentCase) => {
      const d = R.downtimeFor(s, c, o);
      return kind === 'trailer' ? d.trailerDays : d.truckDays;
    };
    const fin = new Map(mine.map((c) => [c.id, R.financials(s, c, o)] as const));
    const cas = kind === 'driver' ? mine.flatMap((c) => c.correctiveActions.map((a) => ({ a, c }))) : [];
    const nonPrev = recent.filter((c) => c.determinations.preventability.value === 'non_preventable').length;
    return {
      kind,
      id: unitId,
      cases: mine.map((c) => ({
        id: c.id,
        number: c.number,
        occurredAt: c.occurredAt,
        tz: c.tz,
        type: c.type,
        severity: c.severity,
        stage: c.stage,
        dotRecordable: R.dotRecordable(c).value,
        preventability: c.determinations.preventability.value,
        outcome: c.closure?.outcome ?? null,
        downtimeDays: days(c),
        netCostCents: ctx.seeMoney ? (fin.get(c.id)?.projectedNetCents ?? 0) : null,
        workOrders: s.workOrders.filter((w) => w.caseId === c.id && (kind === 'driver' || (w.unitKind === kind && w.unitId === unitId) || kind === 'truck')).map((w) => ({ id: w.id, number: w.number, status: w.status, title: w.title })),
      })),
      kpis: {
        total: mine.length,
        last12m: recent.length,
        preventable12m: recent.filter((c) => c.determinations.preventability.value === 'preventable').length,
        nonPreventable12m: nonPrev,
        dotRecordable12m: recent.filter((c) => R.dotRecordable(c).value === 'yes').length,
        reviewSuggested: recent.length >= 2,
        spendCents: ctx.seeMoney ? mine.reduce((a, c) => a + (fin.get(c.id)?.actualCents ?? 0), 0) : null,
        downtimeDays: mine.reduce((a, c) => a + days(c), 0),
        openCorrectiveActions: cas.filter(({ a }) => a.status === 'Open' || a.status === 'In progress').length,
      },
      note:
        recent.length >= 2
          ? kind === 'driver'
            ? `${recent.length} cases in 12 months. Review the circumstances with the driver before drawing conclusions — ${nonPrev} of them were non-preventable.`
            : `${recent.length} cases in 12 months — review suggested. A pattern to check, not a finding of fault.`
          : null,
      correctiveActions: cas.map(({ a, c }) => {
        const locked = a.kind === 'Disciplinary review' && !ctx.canDiscipline;
        return { id: a.id, caseId: c.id, caseNumber: c.number, kind: a.kind, title: locked ? 'Restricted personnel action' : a.title, locked, status: a.status, dueAt: a.due, completedAt: locked ? null : (a.completedAt ?? null) };
      }),
    };
  }

  async detail(p: Principal, id: string): Promise<A.CaseDetailResponse> {
    const { st, ctx } = await this.loadState(p);
    const out = V.detail(st, id, ctx, ctx.perms);
    if (!out) throw this.core.notFound('That accident');
    // Every successful read of restricted data by a permitted user is logged (SPEC §8.3, ACCEPTANCE K7).
    if (ctx.canSeeRestricted) {
      const c = out.case;
      const resources = [
        c.injuries.detailsRestricted ? 'medical' : null,
        c.determinations.legal.value !== 'unknown' ? 'legal' : null,
        c.testing.alcohol.resultRestricted || c.testing.drug.resultRestricted ? 'test_results' : null,
        c.correctiveActions.some((a) => a.restricted) ? 'disciplinary' : null,
        c.witnesses.some((w) => w.contact) ? 'witness_contacts' : null,
        out.computed.claims.some((k) => k.restricted) ? 'restricted_claims' : null,
      ].filter(Boolean);
      if (resources.length) await this.logAccess(p, `accident.detail:${resources.join(',')}`, id);
    }
    return out;
  }

  async events(p: Principal, id: string): Promise<A.TimelineEntry[]> {
    await this.row(p.companyId, id, { allowVoided: true });
    const rows = await this.db
      .select()
      .from(safetyTimelineEvents)
      .where(and(eq(safetyTimelineEvents.companyId, p.companyId), eq(safetyTimelineEvents.accidentId, id)))
      .orderBy(safetyTimelineEvents.occurredAt);
    const can = hasPermission(p, 'accidents.restricted');
    if (can && rows.some((e) => e.restricted)) await this.logAccess(p, 'accident.timeline', id);
    return rows.map((e) => ({
      id: e.id,
      occurredAt: e.occurredAt.toISOString(),
      loggedAt: e.loggedAt.toISOString(),
      actorName: e.restricted && !can ? '' : e.actorName,
      source: e.source as R.EventSource,
      kind: e.kind as A.TimelineEntry['kind'],
      text: e.restricted && !can ? 'Restricted entry' : e.text,
      restricted: e.restricted,
    }));
  }

  /** What the report form picks from (SPEC §1.3 section 1). */
  async pickers(p: Principal): Promise<A.ReportPickers> {
    const c = p.companyId;
    const [truckRows, driverRows, trailerRows, loadRows] = await Promise.all([
      this.db
        .select({ id: trucks.id, unit: trucks.unitNumber, status: trucks.status, driverId: trucks.currentDriverId, trailerId: trucks.currentTrailerId, loadId: trucks.currentLoadId })
        .from(trucks)
        .where(and(eq(trucks.companyId, c), ne(trucks.status, 'archived')))
        .orderBy(trucks.unitNumber),
      this.db
        .select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName, truckId: drivers.currentTruckId })
        .from(drivers)
        .where(and(eq(drivers.companyId, c), isNull(drivers.archivedAt)))
        .orderBy(drivers.firstName, drivers.lastName),
      this.db.select({ id: trailers.id, unit: trailers.unitNumber }).from(trailers).where(eq(trailers.companyId, c)).orderBy(trailers.unitNumber),
      this.db
        .select({ id: loads.id, number: loads.loadNumber, truckId: loads.truckId, record: loads.record })
        .from(loads)
        .where(eq(loads.companyId, c))
        .orderBy(sql`${loads.createdAt} desc`)
        .limit(300),
    ]);
    const { st } = await this.loadState(p);
    const names = new Map(driverRows.map((d) => [d.id, `${d.first} ${d.last}`.trim()]));
    return {
      trucks: truckRows.map((t) => ({ id: t.id, unit: t.unit, driverId: t.driverId, driverName: t.driverId ? (names.get(t.driverId) ?? null) : null, status: t.status, trailerId: t.trailerId, loadId: t.loadId })),
      drivers: driverRows.map((d) => ({ id: d.id, name: names.get(d.id) ?? '', truckId: d.truckId ?? truckRows.find((t) => t.driverId === d.id)?.id ?? null })),
      trailers: trailerRows,
      loads: loadRows.map((l) => {
        const i = loadInfoOf(l);
        return { id: i.id, number: i.number, truckId: i.truckId, customer: i.customer, broker: i.broker, commodity: i.commodity, origin: i.origin, destination: i.destination, hazmat: i.hazmat };
      }),
      people: st.all.people
        .filter((x) => st.peopleDept.has(x.id))
        .map((x) => ({ id: x.id, name: x.name, dept: st.peopleDept.get(x.id) ?? null })),
    };
  }

  /**
   * Autofill (SPEC §6.1): the truck's (or driver's) assignment. NeWay keeps the CURRENT truck ↔ driver/trailer/load
   * assignment on the truck record, not a history by time, so the answer is labelled "current assignment"
   * (IMPLEMENTATION-PLAN §8 deviation 4). The client never overwrites a field the user already set.
   */
  async assignment(p: Principal, q: { truckId?: string; driverId?: string }): Promise<A.AssignmentLookup> {
    const empty: A.AssignmentLookup = { truckId: null, driverId: null, trailerId: null, loadId: null, source: null, note: null };
    let truckId = q.truckId ?? null;
    if (!truckId && q.driverId) {
      const [d] = await this.db.select({ truckId: drivers.currentTruckId }).from(drivers).where(and(eq(drivers.companyId, p.companyId), eq(drivers.id, q.driverId))).limit(1);
      truckId = d?.truckId ?? null;
      if (!truckId) {
        const [t] = await this.db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.companyId, p.companyId), eq(trucks.currentDriverId, q.driverId))).limit(1);
        truckId = t?.id ?? null;
      }
      if (!truckId) return { ...empty, driverId: q.driverId };
    }
    if (!truckId) return empty;
    const [t] = await this.db
      .select({ id: trucks.id, unit: trucks.unitNumber, driverId: trucks.currentDriverId, trailerId: trucks.currentTrailerId, loadId: trucks.currentLoadId })
      .from(trucks)
      .where(and(eq(trucks.companyId, p.companyId), eq(trucks.id, truckId)))
      .limit(1);
    if (!t) throw this.core.invalid('That truck is not in this company');
    const [driver, trailer, load] = await Promise.all([
      t.driverId ? this.core.driver(p.companyId, t.driverId).catch(() => null) : null,
      t.trailerId ? this.core.trailer(p.companyId, t.trailerId).catch(() => null) : null,
      t.loadId ? this.state.loadInfo(p.companyId, [t.loadId]).then((m) => m.get(t.loadId as string) ?? null) : null,
    ]);
    const bits = [
      driver?.name,
      trailer ? `trailer ${trailer.number}` : null,
      load ? `load ${load.number}${load.origin && load.destination ? ` (${load.origin} → ${load.destination})` : ''}` : null,
    ].filter(Boolean);
    return {
      truckId: t.id,
      driverId: t.driverId,
      trailerId: t.trailerId,
      loadId: t.loadId,
      source: 'current assignment',
      note: bits.length
        ? `Filled from Truck ${t.unit}’s current assignment: ${bits.join(', ')}. Change anything that was different at the time of the accident.`
        : null,
    };
  }

  /** One restricted-access log row (append-only table, 0072). */
  private async logAccess(p: Principal, resource: string, accidentId: string): Promise<void> {
    await this.db.insert(restrictedAccessLog).values({ id: this.newId('ral'), companyId: p.companyId, at: this.now(), actorId: p.userId, actorName: this.actor(p), accidentId, resource });
  }

  // ===================================================================================== report

  /** The facts in rules terms, plus the instant the local time converts to. */
  private async facts(p: Principal, input: Partial<A.ReportInput>): Promise<{ facts: R.ReportFacts; occurred: ReturnType<typeof R.localToUtc> | null; load: Awaited<ReturnType<AccidentsV2StateService['loadInfo']>> }> {
    const tz = input.occurredTz || (input.state ? R.STATE_TZ[input.state] : undefined) || R.EASTERN;
    const occurred = input.occurredAtLocal ? R.localToUtc(input.occurredAtLocal, tz, input.occurredChoice) : null;
    const load = input.loadId ? await this.state.loadInfo(p.companyId, [input.loadId]) : new Map();
    const li = input.loadId ? load.get(input.loadId) : undefined;
    return {
      occurred,
      load,
      facts: {
        occurredAt: occurred && occurred.ok ? occurred.iso : null,
        tz,
        publicRoad: input.publicRoad ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        injuries: input.injuries ?? null,
        treatedAway: input.treatedAway ?? null,
        fatalities: input.fatalities ?? null,
        ourDriverInjured: input.ourDriverInjured ?? null,
        towAway: input.towAway ?? null,
        truckCondition: input.truckCondition ?? 'unknown',
        cargo: input.cargo ?? 'unknown',
        hazmat: input.hazmat ?? null,
        police: input.police ?? null,
        citation: input.citation ?? null,
        loadId: input.loadId ?? null,
        loadParty: li?.broker || li?.customer || null,
      },
    };
  }

  async preview(p: Principal, input: A.ReportPreviewInput): Promise<A.ReportPreviewResponse> {
    const now = this.now().getTime();
    const settings = (await this.state.settings(p.companyId)).rules;
    const { facts, occurred, load } = await this.facts(p, input);
    const live = R.reportLiveCheck(facts, { now, settings });
    const li = input.loadId ? load.get(input.loadId) : undefined;
    return {
      ...live,
      prompts: R.reportPrompts(facts, { now, settings }).map((x) => ({ ...x, defaultCreate: true })),
      zone: input.state ? R.zoneForState(input.state) : { tz: null, confirmHint: null },
      occurredAt: occurred ? (occurred.ok ? occurred : { ok: false, error: occurred.error, message: occurred.message, ...('options' in occurred ? { options: occurred.options } : {}) }) : null,
      // Prefilled only when the load record explicitly says non-hazmat (SPEC §11 shortcut 9); a suggestion with its source.
      hazmatPrefill: li ? R.hazmatPrefill({ id: li.id, number: li.number, hazmat: li.hazmat } as R.Load, input.hazmat ?? null) : null,
    };
  }

  /** SPEC §1.3 validation. Draft: truck, driver or description. Submit: the full list. */
  private validateReport(input: Partial<A.ReportInput>, submit: boolean, occurred: ReturnType<typeof R.localToUtc> | null, now: number): void {
    const e: { path: string; message: string }[] = [];
    let extra: Record<string, unknown> | undefined;
    if (occurred && !occurred.ok) {
      e.push({ path: 'occurredAtLocal', message: occurred.message });
      if (occurred.error === 'ambiguous') extra = { options: occurred.options };
    }
    if (submit) {
      if (!input.truckId && !input.driverId) e.push({ path: 'truckId', message: 'Pick the truck or the driver' });
      if (!input.occurredAtLocal) e.push({ path: 'occurredAtLocal', message: 'Enter the date and time it happened' });
      else if (occurred?.ok && Date.parse(occurred.iso) > now + 5 * 60_000) e.push({ path: 'occurredAtLocal', message: 'This time is in the future — check the time zone' });
      if (!input.city && !input.road) e.push({ path: 'road', message: 'Enter a road or a city' });
      if (!input.state) e.push({ path: 'state', message: 'Pick the state' });
      if ((input.description ?? '').trim().length < 10) e.push({ path: 'description', message: 'Describe what happened in a sentence or two' });
    } else {
      if (!input.truckId && !input.driverId && !(input.description ?? '').trim()) e.push({ path: 'truckId', message: 'Add at least the truck, driver or a line about what happened' });
      if (occurred?.ok && Date.parse(occurred.iso) > now + 5 * 60_000) e.push({ path: 'occurredAtLocal', message: 'This time is in the future — check the time zone' });
    }
    if (e.length) throw invalid(e, extra);
  }

  private async lookups(p: Principal, input: { truckId?: string | null; driverId?: string | null; trailerId?: string | null; loadId?: string | null }): Promise<Lookups> {
    const [truck, driver, trailer, load] = await Promise.all([
      this.core.truck(p.companyId, input.truckId),
      this.core.driver(p.companyId, input.driverId),
      this.core.trailer(p.companyId, input.trailerId),
      this.core.load(p.companyId, input.loadId),
    ]);
    return { truck, driver, trailer, load };
  }

  /** Columns written from report/intake input (v2 columns + the legacy mirrors the old pages read). */
  private intakeColumns(input: Partial<A.ReportInput>, lk: Lookups, occurredIso: string | null, tz: string): Partial<typeof safetyAccidents.$inferInsert> {
    const v: Partial<typeof safetyAccidents.$inferInsert> = {};
    const has = (k: keyof A.ReportInput) => Object.prototype.hasOwnProperty.call(input, k);
    if (has('truckId')) Object.assign(v, { truckId: lk.truck?.id ?? null, truckNumber: lk.truck?.number ?? null });
    if (has('driverId')) Object.assign(v, { driverId: lk.driver?.id ?? null, driverName: lk.driver?.name ?? null });
    if (has('trailerId')) Object.assign(v, { trailerId: lk.trailer?.id ?? null, trailerNumber: lk.trailer?.number ?? null });
    if (has('loadId')) Object.assign(v, { loadId: lk.load?.id ?? null, loadNumber: lk.load?.number ?? null });
    if (has('assignmentSource')) v.assignmentSource = input.assignmentSource ?? null;
    if (occurredIso) v.occurredAt = new Date(occurredIso);
    if (has('occurredTz') || occurredIso) v.occurredTz = tz;
    if (has('publicRoad')) v.publicRoad = input.publicRoad ?? null;
    if (has('road')) v.locationRoad = input.road ?? null;
    if (has('locationDetail')) v.locationDetail = input.locationDetail ?? null;
    if (has('city')) v.city = input.city ?? null;
    if (has('state')) v.state = input.state ?? null;
    if (has('accidentType')) v.accidentType = input.accidentType || null;
    if (has('description')) v.description = input.description ?? '';
    if (has('injuries')) v.injuriesStatus = input.injuries ?? null;
    // Counts: null = not known yet, never coerced to 0 (the rules read 0 when injuries = no).
    if (has('treatedAway')) v.treatedAwayCount = input.treatedAway ?? null;
    if (has('fatalities')) v.fatalitiesCount = input.fatalities ?? null;
    if (has('ourDriverInjured')) v.ourDriverInjured = input.ourDriverInjured ?? null;
    if (has('towAway')) {
      v.towAway = input.towAway ?? null;
      v.disablingTow = input.towAway === 'yes';
    }
    if (has('cargo')) v.cargoStatus = input.cargo ?? 'unknown';
    if (has('hazmat')) v.hazmatReleased = input.hazmat ?? null;
    if (has('police')) v.policeResponded = input.police ?? null;
    if (has('citation')) {
      v.citationStatus = input.citation ?? null;
      v.citationIssued = input.citation === 'yes';
    }
    // Legacy mirrors of positive knowledge only (the old columns are NOT NULL; their 0 default is untouched otherwise).
    if (has('fatalities') && typeof input.fatalities === 'number') v.fatalities = input.fatalities;
    if (has('treatedAway') && typeof input.treatedAway === 'number') v.injuriesTreatedAway = input.treatedAway;
    return v;
  }

  /** Units on a case: one row per tractor/trailer, created when the unit is named. */
  private async ensureUnits(tx: Exec, companyId: string, accidentId: string, lk: Lookups, truckCondition: R.EquipmentState['condition'] | undefined, at: Date): Promise<void> {
    if (lk.truck) {
      const status = truckCondition === 'drivable' ? 'operational' : truckCondition === 'not_drivable' ? 'at_scene' : 'unknown';
      await tx
        .insert(accidentUnits)
        .values({ id: this.newId('acu'), companyId, accidentId, unitKind: 'truck', unitId: lk.truck.id, unitNumber: lk.truck.number, conditionAtScene: truckCondition ?? 'unknown', status, createdAt: at, updatedAt: at })
        .onConflictDoNothing();
    }
    if (lk.trailer) {
      await tx
        .insert(accidentUnits)
        .values({ id: this.newId('acu'), companyId, accidentId, unitKind: 'trailer', unitId: lk.trailer.id, unitNumber: lk.trailer.number, createdAt: at, updatedAt: at })
        .onConflictDoNothing();
    }
  }

  private async event(
    tx: Exec,
    p: Principal,
    accidentId: string,
    e: { text: string; source: R.EventSource; kind: 'milestone' | 'change' | 'note' | 'task'; at?: Date; logged: Date; restricted?: boolean; before?: unknown; after?: unknown; actorName?: string },
  ): Promise<void> {
    await tx.insert(safetyTimelineEvents).values({
      id: this.newId('evt'),
      companyId: p.companyId,
      accidentId,
      occurredAt: e.at ?? e.logged,
      loggedAt: e.logged,
      actorId: p.userId,
      actorName: e.actorName ?? this.actor(p),
      source: e.source,
      kind: e.kind,
      text: e.text,
      restricted: e.restricted ?? false,
      before: e.before ?? null,
      after: e.after ?? null,
    });
  }

  private async auditIn(tx: Exec, p: Principal, row: { id: string; number: string }, action: string, summary: string, at: Date, changes: AuditChange[] = [], reason?: string | null): Promise<AuditEvent> {
    return this.audit.writeIn(tx, p, { action, entityType: ENTITY, entityId: row.id, entityLabel: row.number, summary, changes, reason: reason ?? null, at });
  }

  /** Default assignee per department (safety_settings `dept_default_assignee`); Safety falls back to the reporter. */
  private assigneeFor(dept: R.Dept, p: Principal, st: { deptAssignees: CompanyState['deptAssignees'] }): { id: string; name: string } | null {
    const set = st.deptAssignees[dept];
    if (set) return set;
    if (dept === 'Safety') return { id: p.userId, name: this.actor(p) };
    return null;
  }

  /**
   * Submit side effects (SPEC §1.3 "On submit", ACCEPTANCE A5), inside the caller's transaction: stage initial_response,
   * prompt tasks + standard tasks, downtime + a Dispatch "unit unavailable" request when the truck is not drivable,
   * the two timeline milestones. The Daily board is never changed here (SPEC §6.4).
   */
  private async submitEffects(
    tx: Tx,
    p: Principal,
    row: SafetyAccidentRow,
    input: Partial<A.ReportInput>,
    at: Date,
    isNew: boolean,
  ): Promise<{ tasksCreated: number; requestsCreated: number; severity: R.Severity }> {
    const settingsAll = await this.state.settings(p.companyId);
    const settings = settingsAll.rules;
    const now = at.getTime();
    const tz = row.occurredTz ?? R.EASTERN;
    const loadInfo = row.loadId ? (await this.state.loadInfo(p.companyId, [row.loadId])).get(row.loadId) : undefined;
    const unitRows = await tx.select().from(accidentUnits).where(and(eq(accidentUnits.companyId, p.companyId), eq(accidentUnits.accidentId, row.id)));
    const truckUnit = unitRows.find((u) => u.unitKind === 'truck');
    const truckCondition = (truckUnit?.conditionAtScene as R.EquipmentState['condition'] | undefined) ?? input.truckCondition ?? 'unknown';
    const facts: R.ReportFacts = {
      occurredAt: row.occurredAt.toISOString(),
      tz,
      publicRoad: row.publicRoad as R.Tri,
      city: row.city,
      state: row.state,
      injuries: row.injuriesStatus as R.Tri,
      treatedAway: row.treatedAwayCount,
      fatalities: row.fatalitiesCount,
      ourDriverInjured: row.ourDriverInjured as R.Tri,
      towAway: row.towAway as R.Tri,
      truckCondition,
      cargo: (row.cargoStatus as R.CargoState['status']) ?? 'unknown',
      hazmat: row.hazmatReleased as R.Tri,
      police: row.policeResponded as R.Tri,
      citation: row.citationStatus as R.Tri,
      loadId: row.loadId,
      loadParty: loadInfo?.broker || loadInfo?.customer || null,
    };
    const severity = row.severityManualReason ? (row.severity as R.Severity) : R.reportLiveCheck(facts, { now, settings }).suggestedSeverity.value;
    const prompts = R.reportPrompts(facts, { now, settings });
    const choices = new Map((input.prompts ?? []).map((x) => [x.key, x]));
    const deptState = { deptAssignees: settingsAll.deptAssignees };
    let tasksCreated = 0;
    const immediate: R.AccidentCase['immediate'] = [];
    const taskRow = (t: { title: string; dept: R.Dept; dueInHours: number; priority: 'normal' | 'high'; autoRule: string; promptKey?: string; done?: boolean; requestKind?: A.RequestKind; requestPayload?: unknown }) => {
      const who = t.requestKind ? null : this.assigneeFor(t.dept, p, deptState);
      return {
        id: this.newId('tsk'),
        companyId: p.companyId,
        accidentId: row.id,
        title: t.title,
        dept: t.dept,
        assigneeId: who?.id ?? null,
        assigneeName: who?.name ?? null,
        dueAt: new Date(now + Math.round(t.dueInHours * R.HOUR)),
        status: t.done ? 'done' : 'open',
        priority: t.priority,
        autoRule: t.autoRule,
        promptKey: t.promptKey ?? null,
        requestKind: t.requestKind ?? null,
        requestPayload: t.requestPayload ?? null,
        isTest: row.isTest,
        createdBy: this.actor(p),
        createdAt: at,
        updatedAt: at,
        ...(t.done ? { completedAt: at, completedBy: this.actor(p) } : {}),
      } satisfies typeof safetyTasks.$inferInsert;
    };
    const rows: (typeof safetyTasks.$inferInsert)[] = [];
    for (const pr of prompts) {
      const choice = choices.get(pr.key);
      const create = choice ? choice.create : true;
      if (choice?.done !== undefined) immediate.push({ key: pr.key, label: pr.label, done: Boolean(choice.done) });
      if (!create) continue;
      rows.push(taskRow({ title: pr.label, dept: pr.dept, dueInHours: pr.dueInHours, priority: R.promptPriority(pr.dueInHours), autoRule: 'Quick report', promptKey: pr.key, done: Boolean(choice?.done) }));
      if (!choice?.done) tasksCreated += 1;
    }
    const existing = await tx.select({ title: safetyTasks.title }).from(safetyTasks).where(and(eq(safetyTasks.companyId, p.companyId), eq(safetyTasks.accidentId, row.id)));
    for (const t of R.standardTasks(severity, { settings })) {
      if (t.title === R.CONFIRM_FACTS_TASK && existing.some((x) => /investigat/i.test(x.title))) continue;
      rows.push(taskRow(t));
      tasksCreated += 1;
    }
    let requestsCreated = 0;
    const truck = row.truckId ? { id: row.truckId, unit: row.truckNumber ?? '?' } : null;
    if (truckCondition === 'not_drivable' && truck) {
      // Downtime opens (entered by Safety, Fleet to verify) and Dispatch is ASKED; the Daily board does not change.
      await tx
        .insert(downtimePeriods)
        .values({
          id: this.newId('dtp'),
          companyId: p.companyId,
          accidentId: row.id,
          unitKind: 'truck',
          unitId: truck.id,
          startedAt: row.occurredAt,
          source: 'entered',
          note: 'Started from the quick report — Fleet to verify',
          createdBy: this.actor(p),
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing();
      rows.push(
        taskRow({
          title: `Mark Truck ${truck.unit} unavailable on the Daily board (${row.number}) — confirm when done`,
          dept: 'Dispatch',
          dueInHours: 3,
          priority: 'high',
          autoRule: 'Quick report: truck not drivable',
          requestKind: 'unit_unavailable',
          requestPayload: { unitKind: 'truck', unitId: truck.id, unit: truck.unit, suggestedStatus: 'ACCIDENT' },
        }),
      );
      requestsCreated += 1;
    }
    if (rows.length) await tx.insert(safetyTasks).values(rows);
    await tx
      .update(safetyAccidents)
      .set({ stage: 'initial_response', submittedAt: at, severity, immediateActions: immediate.length ? immediate : row.immediateActions })
      .where(eq(safetyAccidents.id, row.id));
    await this.event(tx, p, row.id, { text: isNew ? 'Accident reported in NeWay' : 'Draft submitted — accident reported', source: 'Safety', kind: 'milestone', logged: at });
    await this.event(tx, p, row.id, { text: 'Accident occurred', source: 'Driver', kind: 'milestone', at: row.occurredAt, logged: at, actorName: row.driverName ?? this.actor(p) });
    if (requestsCreated && truck)
      await this.event(tx, p, row.id, {
        text: `Dispatch asked to mark Truck ${truck.unit} unavailable — the Daily board changes only when Dispatch confirms`,
        source: 'Safety',
        kind: 'task',
        logged: at,
      });
    return { tasksCreated, requestsCreated, severity };
  }

  /**
   * "Post-accident alcohol and drug test required?" on the quick report (owner, 2026-10-24). Results are restricted
   * (accidents.restricted); on submit a required test with nothing submitted needs a reason why it was not done.
   */
  private checkPostAccidentTest(p: Principal, input: A.PostAccidentTestInput | undefined, submit: boolean): void {
    if (!input) return;
    if ((input.alcoholResult || input.drugResult) && !hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'Test results are restricted');
    const issues = R.postAccidentIntakeIssues({ required: input.required, submitted: Boolean(input.fileId), notDoneReason: input.notDoneReason ?? null }, { submit });
    if (issues.length) throw invalid(issues);
  }

  /**
   * Stores the answer on the case's two post-accident test records (drug_alcohol_tests, one per substance — the same
   * rows the Testing panel writes): Yes = Safety marks them required (the rule can never be switched off by No), the
   * results, and the reason when nothing was submitted; No = the rule decides, with who answered and when. The file is
   * restricted evidence ("Test record (restricted)"). One restricted timeline event and one audit entry.
   */
  private async recordPostAccidentTest(tx: Tx, p: Principal, row: SafetyAccidentRow, input: A.PostAccidentTestInput | undefined, at: Date): Promise<AuditEvent | null> {
    if (!input) return null;
    const settings = (await this.state.settings(p.companyId)).rules;
    if (input.fileId) await this.attachUploads(tx, p, row.id, [{ fileId: input.fileId, category: 'Test record (restricted)' }], at);
    const yes = input.required === 'yes';
    const reason = yes && !input.fileId ? input.notDoneReason?.trim() || null : null;
    const probe = R.reportProbe(
      {
        occurredAt: row.occurredAt.toISOString(),
        tz: row.occurredTz ?? R.EASTERN,
        publicRoad: row.publicRoad as R.Tri,
        injuries: row.injuriesStatus as R.Tri,
        treatedAway: row.treatedAwayCount,
        fatalities: row.fatalitiesCount,
        towAway: row.towAway as R.Tri,
        citation: row.citationStatus as R.Tri,
        citationAt: row.citationAt ? row.citationAt.toISOString() : null,
        testing: { alcohol: { substance: 'alcohol', decision: yes ? 'required' : 'auto' }, drug: { substance: 'drug', decision: yes ? 'required' : 'auto' } },
      },
      at.getTime(),
    );
    const det = R.testing(probe, { now: at.getTime(), settings });
    for (const substance of ['alcohol', 'drug'] as const) {
      const result = substance === 'alcohol' ? input.alcoholResult : input.drugResult;
      const values: Partial<typeof drugAlcoholTests.$inferInsert> = {
        postAccidentDecision: yes ? 'required' : 'auto',
        decisionBy: this.actor(p),
        decisionAt: at,
        required: det[substance].required === 'yes',
        requiredReason: det[substance].reason,
        ...(reason ? { notCompletedReason: reason } : {}),
        ...(yes && result ? { result, resultAt: at } : {}),
      };
      const [existing] = await tx
        .select()
        .from(drugAlcoholTests)
        .where(and(eq(drugAlcoholTests.companyId, p.companyId), eq(drugAlcoholTests.accidentId, row.id), eq(drugAlcoholTests.substance, substance), isNull(drugAlcoholTests.voidedAt)))
        .limit(1);
      if (existing) {
        await tx.update(drugAlcoholTests).set({ ...values, version: existing.version + 1, updatedAt: at }).where(eq(drugAlcoholTests.id, existing.id));
      } else {
        const number = await this.core.nextNumber(p.companyId, 'drug_test');
        await tx.insert(drugAlcoholTests).values({
          id: this.newId('dat'),
          companyId: p.companyId,
          number,
          ownerId: row.ownerId,
          ownerName: row.ownerName,
          isTest: row.isTest,
          createdBy: this.actor(p),
          createdAt: at,
          updatedAt: at,
          testType: 'post_accident',
          substance,
          driverId: row.driverId,
          driverName: row.driverName,
          accidentId: row.id,
          accidentNumber: row.number,
          occurredAt: row.occurredAt,
          ...values,
        });
      }
    }
    const what = !yes
      ? 'No — the 382.303 rule decides'
      : input.fileId
        ? `Yes — test record submitted${input.alcoholResult || input.drugResult ? ', results recorded' : ''}`
        : `Yes — not submitted: ${reason}`;
    const text = `${R.POST_ACCIDENT_TEST_QUESTION} ${what}`;
    // A testing subject: the event is restricted like every test write (API.md case writes).
    await this.event(tx, p, row.id, { text, source: 'Safety', kind: 'change', logged: at, restricted: true });
    return this.auditIn(tx, p, row, 'accident_test_recorded', `Post-accident testing at intake: ${what}`, at, [
      { field: 'postAccidentTestRequired', old: null, new: input.required },
      ...(input.fileId ? [{ field: 'postAccidentTestFile', old: null, new: input.fileId }] : []),
      ...(reason ? [{ field: 'notCompletedReason', old: null, new: reason }] : []),
    ]);
  }

  private async attachUploads(tx: Exec, p: Principal, accidentId: string, uploads: A.ReportInput['uploads'], at: Date): Promise<number> {
    let n = 0;
    for (const u of uploads ?? []) {
      const [file] = await tx.select().from(storedFiles).where(and(eq(storedFiles.companyId, p.companyId), eq(storedFiles.id, u.fileId))).limit(1);
      if (!file) throw invalid([{ path: 'uploads', message: 'That file is not in this company; upload it again' }]);
      const category: R.EvidenceCategory = u.category ?? (file.contentType.startsWith('video/') ? 'Dashcam / video' : file.contentType.startsWith('image/') ? 'Damage photo' : 'Other');
      await tx.insert(safetyCaseDocuments).values({
        id: this.newId('sdoc'),
        companyId: p.companyId,
        caseType: 'accident',
        caseId: accidentId,
        fileId: file.id,
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        title: file.fileName,
        kind: category === 'Police report' ? 'police_report' : category.endsWith('photo') ? 'photos' : 'other',
        category,
        description: 'Attached with the quick report',
        restricted: category.endsWith('(restricted)'),
        uploadedBy: this.actor(p),
        uploadedAt: at,
      });
      n += 1;
    }
    return n;
  }

  /** POST /accidents — quick report, draft or submit (API.md §2). Idempotent on `Idempotency-Key`. */
  async report(p: Principal, input: A.ReportInput, idempotencyKey?: string): Promise<A.ReportResponse> {
    if (idempotencyKey) {
      const again = await this.byIdempotencyKey(p.companyId, idempotencyKey);
      if (again) return again;
    }
    const at = this.now();
    const tz = input.occurredTz || (input.state ? R.STATE_TZ[input.state] : undefined) || R.EASTERN;
    const occurred = input.occurredAtLocal ? R.localToUtc(input.occurredAtLocal, tz, input.occurredChoice) : null;
    this.validateReport(input, input.submit, occurred, at.getTime());
    this.checkPostAccidentTest(p, input.postAccidentTest, input.submit);
    if ((input.treatedAway ?? 0) < 0) throw invalid([{ path: 'treatedAway', message: 'Cannot be negative' }]);
    const lk = await this.lookups(p, input);
    const occurredIso = occurred && occurred.ok ? occurred.iso : at.toISOString();
    const number = await this.core.nextNumber(p.companyId, 'accident');
    const id = this.newId('acc');
    const settings = (await this.state.settings(p.companyId)).rules;
    const { facts } = await this.facts(p, input);
    const severity = R.reportLiveCheck({ ...facts, occurredAt: occurredIso }, { now: at.getTime(), settings }).suggestedSeverity.value;
    const values: typeof safetyAccidents.$inferInsert = {
      id,
      companyId: p.companyId,
      number,
      ownerId: p.userId,
      ownerName: this.actor(p),
      isTest: input.isTest ?? false,
      createdBy: this.actor(p),
      createdAt: at,
      updatedAt: at,
      occurredAt: new Date(occurredIso),
      location: locationLabel(input.road, input.locationDetail, input.city, input.state),
      stage: 'draft',
      fault: 'not_determined',
      preventability: 'not_determined',
      timeProvenance: 'driver',
      locationProvenance: 'driver',
      descriptionProvenance: 'driver',
      injuriesProvenance: 'driver',
      towProvenance: 'driver',
      severity,
      cargoStatus: input.cargo ?? 'unknown',
      idempotencyKey: idempotencyKey ?? null,
      ...this.intakeColumns(input, lk, occurredIso, tz),
    };
    const events: AuditEvent[] = [];
    let result: A.ReportResponse;
    try {
      result = await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(safetyAccidents).values(values).returning();
        if (!row) throw new Error('insert failed');
        await this.ensureUnits(tx, p.companyId, id, lk, input.truckCondition, at);
        const files = await this.attachUploads(tx, p, id, input.uploads, at);
        const testAudit = await this.recordPostAccidentTest(tx, p, row, input.postAccidentTest, at);
        if (testAudit) events.push(testAudit);
        let tasksCreated = 0;
        let requestsCreated = 0;
        if (input.submit) {
          const fx = await this.submitEffects(tx, p, row, input, at, true);
          tasksCreated = fx.tasksCreated;
          requestsCreated = fx.requestsCreated;
        } else {
          await this.event(tx, p, id, { text: 'Draft report started', source: 'Safety', kind: 'milestone', logged: at });
        }
        events.push(
          await this.auditIn(
            tx,
            p,
            { id, number },
            input.submit ? 'accident_reported' : 'accident_draft_saved',
            input.submit
              ? `Accident reported: ${tasksCreated} tasks, ${requestsCreated} Dispatch request${requestsCreated === 1 ? '' : 's'}${files ? `, ${files} file${files === 1 ? '' : 's'}` : ''}`
              : 'Draft report started',
            at,
          ),
        );
        return { id, number, stage: input.submit ? 'initial_response' : 'draft', version: 1, tasksCreated, requestsCreated } satisfies A.ReportResponse;
      });
    } catch (error) {
      // A retry that raced the first insert lands on the unique idempotency index: answer with the first result.
      if (idempotencyKey && /safety_accidents_idempotency_key/.test(String((error as { message?: string })?.message ?? '') + String((error as { constraint_name?: string })?.constraint_name ?? ''))) {
        const again = await this.byIdempotencyKey(p.companyId, idempotencyKey);
        if (again) return again;
      }
      throw error;
    }
    await this.audit.publish(...events);
    return result;
  }

  private async byIdempotencyKey(companyId: string, key: string): Promise<A.ReportResponse | null> {
    const [row] = await this.db
      .select()
      .from(safetyAccidents)
      .where(and(eq(safetyAccidents.companyId, companyId), eq(safetyAccidents.idempotencyKey, key)))
      .limit(1);
    if (!row) return null;
    const tasks = await this.db
      .select({ status: safetyTasks.status, requestKind: safetyTasks.requestKind })
      .from(safetyTasks)
      .where(and(eq(safetyTasks.companyId, companyId), eq(safetyTasks.accidentId, row.id)));
    return {
      id: row.id,
      number: row.number,
      stage: row.stage as R.Stage,
      version: row.version,
      tasksCreated: tasks.filter((t) => t.status !== 'done' && !t.requestKind).length,
      requestsCreated: tasks.filter((t) => t.requestKind).length,
    };
  }

  // ===================================================================================== case writes

  async row(companyId: string, id: string, opts: { allowVoided?: boolean } = {}): Promise<SafetyAccidentRow> {
    const [row] = await this.db
      .select()
      .from(safetyAccidents)
      .where(and(eq(safetyAccidents.companyId, companyId), eq(safetyAccidents.id, id)))
      .limit(1);
    if (!row || (row.voidedAt && !opts.allowVoided)) throw this.core.notFound('That accident');
    return row;
  }

  private checkVersion(row: SafetyAccidentRow, version: number): void {
    if (row.version !== version) throw conflict(row, row.number);
  }

  /**
   * Writes one change to a case: version-checked update (stale → 409), one audit entry, timeline events — in one
   * transaction. `mutate` returns the column patch plus the events to log.
   */
  /** One version-checked, audited change to a case (shared by the P2–P4 services). */
  async write(
    p: Principal,
    id: string,
    version: number,
    action: string,
    mutate: (row: SafetyAccidentRow, tx: Tx, at: Date) => Promise<{ patch: Partial<typeof safetyAccidents.$inferInsert>; summary: string; reason?: string | null; events?: CaseEvent[] }>,
  ): Promise<{ id: string; version: number }> {
    const at = this.now();
    const audits: AuditEvent[] = [];
    const out = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(safetyAccidents)
        .where(and(eq(safetyAccidents.companyId, p.companyId), eq(safetyAccidents.id, id)))
        .for('update')
        .limit(1);
      if (!row || row.voidedAt) throw this.core.notFound('That accident');
      this.checkVersion(row, version);
      const m = await mutate(row, tx, at);
      const next = row.version + 1;
      const updated = await tx
        .update(safetyAccidents)
        .set({ ...m.patch, version: next, updatedAt: at })
        .where(and(eq(safetyAccidents.id, id), eq(safetyAccidents.version, row.version)))
        .returning({ id: safetyAccidents.id });
      if (updated.length === 0) throw conflict(row, row.number);
      for (const e of m.events ?? []) await this.event(tx, p, id, e);
      const changes: AuditChange[] = [];
      for (const [field, value] of Object.entries(m.patch)) {
        const before = (row as Record<string, unknown>)[field];
        const a = before instanceof Date ? before.toISOString() : before === null || before === undefined ? null : typeof before === 'object' ? JSON.stringify(before) : String(before);
        const b = value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (a !== b) changes.push({ field, old: a, new: b });
      }
      audits.push(await this.auditIn(tx, p, row, action, m.summary, at, changes, m.reason));
      return { id, version: next };
    });
    await this.audit.publish(...audits);
    return out;
  }

  /** The case as the rules see it, inside a transaction (for gates and severity after a change). */
  async ruleCase(p: Principal, id: string): Promise<{ st: CompanyState; c: R.AccidentCase }> {
    const st = await this.state.load(p.companyId);
    const c = R.byId(st.all.cases, id);
    if (!c) throw this.core.notFound('That accident');
    return { st, c };
  }

  /** PATCH /accidents/:id — intake facts (Edit facts, Incident tab). Severity follows unless manual; DOT change is logged. */
  async patch(p: Principal, id: string, input: A.PatchAccidentInput): Promise<{ id: string; version: number }> {
    const fields = Object.keys(input).filter((k) => k !== 'version' && (input as Record<string, unknown>)[k] !== undefined);
    if (!hasPermission(p, 'accidents.edit')) {
      const outside = fields.filter((f) => !CARGO_FIELDS.has(f));
      if (!hasPermission(p, 'accidents.edit_cargo') || outside.length) throw forbidden('accidents.edit', `Only cargo and load fields can be changed with your access (not: ${outside.join(', ')})`);
    }
    if (input.medicalDetails !== undefined && !hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'Medical details are restricted');
    const before = await this.ruleCase(p, id);
    const lk = await this.lookups(p, {
      truckId: input.truckId !== undefined ? input.truckId : null,
      driverId: input.driverId !== undefined ? input.driverId : null,
      trailerId: input.trailerId !== undefined ? input.trailerId : null,
      loadId: input.loadId !== undefined ? input.loadId : null,
    });
    const row0 = before.st.rows.get(id) as SafetyAccidentRow;
    const tz = input.occurredTz || row0.occurredTz || R.EASTERN;
    let occurredIso: string | null = null;
    if (input.occurredAtLocal) {
      const r = R.localToUtc(input.occurredAtLocal, tz, input.occurredChoice);
      if (!r.ok) throw invalid([{ path: 'occurredAtLocal', message: r.message }], r.error === 'ambiguous' ? { options: r.options } : undefined);
      if (Date.parse(r.iso) > this.now().getTime() + 5 * 60_000) throw invalid([{ path: 'occurredAtLocal', message: 'This time is in the future — check the time zone' }]);
      occurredIso = r.iso;
    }
    return this.write(p, id, input.version, 'accident_facts_updated', async (row, tx, at) => {
      const patch: Partial<typeof safetyAccidents.$inferInsert> = this.intakeColumns(input, lk, occurredIso, tz);
      const set = <K extends keyof typeof safetyAccidents.$inferInsert>(k: K, v: (typeof safetyAccidents.$inferInsert)[K]) => {
        patch[k] = v;
      };
      if (input.timeProvenance) set('timeProvenance', input.timeProvenance);
      if (input.locationProvenance) set('locationProvenance', input.locationProvenance);
      if (input.descriptionProvenance) set('descriptionProvenance', input.descriptionProvenance);
      if (input.injuriesProvenance) set('injuriesProvenance', input.injuriesProvenance);
      if (input.towProvenance) set('towProvenance', input.towProvenance);
      if (input.citationAt !== undefined) set('citationAt', input.citationAt ? new Date(input.citationAt) : null);
      if (input.citationNote !== undefined) set('citationNote', input.citationNote);
      if (input.policeDepartment !== undefined) set('policeDepartment', input.policeDepartment);
      if (input.policeReportNumber !== undefined) set('policeReportNumber', input.policeReportNumber);
      if (input.excludedOccurrence !== undefined) set('excludedOccurrence', input.excludedOccurrence);
      if (input.weather !== undefined) set('weather', input.weather);
      if (input.roadSurface !== undefined) set('roadSurface', input.roadSurface);
      if (input.lightCondition !== undefined) set('lightCondition', input.lightCondition);
      if (input.cargoPlan !== undefined) set('cargoPlan', input.cargoPlan);
      if (input.cargoNotes !== undefined) set('cargoNotes', input.cargoNotes);
      if (input.cargoDeliveryImpact !== undefined) set('cargoDeliveryImpact', input.cargoDeliveryImpact);
      if (input.brokerNotified !== undefined) set('brokerNotified', input.brokerNotified);
      if (input.initialEstimateCents !== undefined) set('initialEstimateCents', input.initialEstimateCents);
      if (input.road !== undefined || input.locationDetail !== undefined || input.city !== undefined || input.state !== undefined)
        set('location', locationLabel(patch.locationRoad ?? row.locationRoad, patch.locationDetail ?? row.locationDetail, patch.city ?? row.city, patch.state ?? row.state));
      // Units: a newly named unit gets its row; Safety's condition at the scene lives on the truck unit.
      await this.ensureUnits(tx, p.companyId, id, { ...lk, truck: input.truckId !== undefined ? lk.truck : null, trailer: input.trailerId !== undefined ? lk.trailer : null }, input.truckCondition, at);
      if (input.truckCondition) {
        const truckId = patch.truckId ?? row.truckId;
        if (truckId)
          await tx
            .update(accidentUnits)
            .set({ conditionAtScene: input.truckCondition, updatedAt: at, version: sql`${accidentUnits.version} + 1` })
            .where(and(eq(accidentUnits.companyId, p.companyId), eq(accidentUnits.accidentId, id), eq(accidentUnits.unitKind, 'truck'), eq(accidentUnits.unitId, truckId)));
      }
      const events: CaseEvent[] = [];
      if (input.medicalDetails !== undefined) {
        await tx
          .insert(accidentRestricted)
          .values({ accidentId: id, companyId: p.companyId, medicalDetails: input.medicalDetails, updatedAt: at })
          .onConflictDoUpdate({ target: accidentRestricted.accidentId, set: { medicalDetails: input.medicalDetails, updatedAt: at, version: sql`${accidentRestricted.version} + 1` } });
        events.push({ text: 'Medical details updated', source: 'Safety', kind: 'change', logged: at, restricted: true });
      }
      // Re-evaluate on the changed case (severity unless manual; DOT logged when it changes — ACCEPTANCE B-extra).
      const after = caseAfter(before.c, patch, input.truckCondition);
      const dotBefore = R.dotRecordable(before.c).value;
      const dotAfter = R.dotRecordable(after).value;
      if (!row.severityManualReason) set('severity', R.suggestedSeverity(after, { now: at.getTime(), settings: before.st.settings }).value);
      const visible = fields.filter((f) => f !== 'medicalDetails');
      if (visible.length)
        events.push({ text: `Facts updated: ${visible.join(', ')}`, source: hasPermission(p, 'accidents.edit') ? 'Safety' : 'Dispatch', kind: 'change', logged: at, before: pick(row, Object.keys(patch)), after: patch });
      if (dotBefore !== dotAfter)
        events.push({ text: `DOT recordable re-evaluated: ${dotAfter === 'yes' ? 'Yes' : dotAfter === 'no' ? 'No' : 'To be determined'}`, source: 'System', kind: 'change', logged: at });
      return { patch, summary: `Facts updated: ${fields.join(', ')}`, events };
    });
  }

  /** POST /:id/submit — draft → initial_response with the same side effects as a submitted report (A10). */
  async submit(p: Principal, id: string, input: A.SubmitDraftInput): Promise<A.ReportResponse> {
    const row0 = await this.row(p.companyId, id);
    if (row0.stage !== 'draft') throw this.core.refused(`${row0.number} is not a draft`);
    this.checkVersion(row0, input.version);
    const merged: Partial<A.ReportInput> = { ...(input.report ?? {}) };
    const tz = merged.occurredTz || row0.occurredTz || (merged.state ? R.STATE_TZ[merged.state] : undefined) || R.EASTERN;
    const occurred = merged.occurredAtLocal ? R.localToUtc(merged.occurredAtLocal, tz, merged.occurredChoice) : null;
    const check: Partial<A.ReportInput> = {
      truckId: merged.truckId !== undefined ? merged.truckId : row0.truckId,
      driverId: merged.driverId !== undefined ? merged.driverId : row0.driverId,
      occurredAtLocal: merged.occurredAtLocal ?? R.isoToLocalInput(row0.occurredAt.toISOString(), tz),
      road: merged.road !== undefined ? merged.road : row0.locationRoad,
      city: merged.city !== undefined ? merged.city : row0.city,
      state: merged.state !== undefined ? merged.state : row0.state,
      description: merged.description !== undefined ? (merged.description ?? '') : row0.description,
    };
    this.validateReport(check, true, occurred ?? { ok: true, iso: row0.occurredAt.toISOString(), abbr: '' }, this.now().getTime());
    this.checkPostAccidentTest(p, merged.postAccidentTest, true);
    const lk = await this.lookups(p, merged);
    const at = this.now();
    const audits: AuditEvent[] = [];
    const res = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(safetyAccidents).where(and(eq(safetyAccidents.companyId, p.companyId), eq(safetyAccidents.id, id))).for('update').limit(1);
      if (!row || row.voidedAt) throw this.core.notFound('That accident');
      this.checkVersion(row, input.version);
      const patch = this.intakeColumns(merged, lk, occurred && occurred.ok ? occurred.iso : null, tz);
      if (Object.keys(patch).length) {
        if (merged.road !== undefined || merged.city !== undefined || merged.state !== undefined)
          patch.location = locationLabel(patch.locationRoad ?? row.locationRoad, patch.locationDetail ?? row.locationDetail, patch.city ?? row.city, patch.state ?? row.state);
        await tx.update(safetyAccidents).set(patch).where(eq(safetyAccidents.id, id));
      }
      await this.ensureUnits(tx, p.companyId, id, { ...lk, truck: lk.truck ?? (row.truckId ? { id: row.truckId, number: row.truckNumber ?? '?' } : null), trailer: lk.trailer }, merged.truckCondition, at);
      if (merged.truckCondition && (patch.truckId ?? row.truckId))
        await tx
          .update(accidentUnits)
          .set({ conditionAtScene: merged.truckCondition, status: merged.truckCondition === 'drivable' ? 'operational' : merged.truckCondition === 'not_drivable' ? 'at_scene' : 'unknown', updatedAt: at })
          .where(and(eq(accidentUnits.companyId, p.companyId), eq(accidentUnits.accidentId, id), eq(accidentUnits.unitKind, 'truck')));
      await this.attachUploads(tx, p, id, merged.uploads, at);
      const [fresh] = await tx.select().from(safetyAccidents).where(eq(safetyAccidents.id, id)).limit(1);
      const testAudit = await this.recordPostAccidentTest(tx, p, fresh as SafetyAccidentRow, merged.postAccidentTest, at);
      if (testAudit) audits.push(testAudit);
      const fx = await this.submitEffects(tx, p, fresh as SafetyAccidentRow, merged, at, false);
      await tx.update(safetyAccidents).set({ version: row.version + 1, updatedAt: at }).where(eq(safetyAccidents.id, id));
      audits.push(await this.auditIn(tx, p, row, 'accident_reported', `Draft submitted: ${fx.tasksCreated} tasks, ${fx.requestsCreated} Dispatch requests`, at, [{ field: 'stage', old: 'draft', new: 'initial_response' }]));
      return { id, number: row.number, stage: 'initial_response' as const, version: row.version + 1, tasksCreated: fx.tasksCreated, requestsCreated: fx.requestsCreated };
    });
    await this.audit.publish(...audits);
    return res;
  }

  /** Discard draft (A11): voided "Draft discarded" — rows and files are kept, nothing hard-deleted. */
  async discard(p: Principal, id: string, input: A.VersionInput): Promise<{ id: string; version: number }> {
    return this.write(p, id, input.version, 'accident_draft_discarded', async (row, _tx, at) => {
      if (row.stage !== 'draft') throw this.core.refused(`${row.number} is not a draft; void it instead`);
      return {
        patch: { voidedAt: at, voidedBy: this.actor(p), voidReason: 'Draft discarded' },
        summary: 'Draft discarded',
        reason: 'Draft discarded',
        events: [{ text: 'Draft discarded', source: 'Safety', kind: 'milestone', logged: at }],
      };
    });
  }

  /** Stage move with gates (SPEC §7.5–7.6, ACCEPTANCE E). Blocked → 422 stage-blocked; override needs accidents.override. */
  async stage(p: Principal, id: string, input: A.StageInput): Promise<{ id: string; version: number }> {
    const { st, c } = await this.ruleCase(p, id);
    const from = c.stage;
    if (from === 'draft') throw this.core.refused('Submit the draft first');
    if (from === 'closed') throw this.core.refused('The case is closed; reopen it first');
    const next = STAGE_ORDER[STAGE_ORDER.indexOf(from) + 1];
    if (input.to !== next) throw invalid([{ path: 'to', message: `The next stage after ${R.STAGE_LABEL[from]} is ${next ? R.STAGE_LABEL[next] : 'none'}` }]);
    const now = this.now().getTime();
    const o = { now, settings: st.settings };
    const blockers = input.to === 'closed' ? R.closeBlockers(st.all, c, o) : R.advanceBlockers(st.all, c, o);
    const canOverride = hasPermission(p, 'accidents.override');
    const override = input.overrideReason?.trim() || null;
    if (blockers.length && !override) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        type: '/problems/stage-blocked',
        detail: `${blockers.length} item${blockers.length === 1 ? '' : 's'} before ${R.STAGE_LABEL[input.to]}: ${blockers.map((b) => b.text).join('; ')}`,
        extensions: { blockers: blockers.map((b) => ({ code: b.text, text: b.text, tab: b.tab ?? null })), canOverride },
      });
    }
    if (override && !canOverride) throw forbidden('accidents.override', 'Overriding stage conditions is restricted');
    if (input.to === 'closed' && !input.outcome?.trim()) throw invalid([{ path: 'outcome', message: 'Write the final outcome' }]);
    const actor = this.actor(p);
    return this.write(p, id, input.version, input.to === 'closed' ? 'accident_closed' : 'accident_stage_changed', async (_row, _tx, at) => {
      const patch: Partial<typeof safetyAccidents.$inferInsert> = { stage: input.to };
      if (input.to === 'closed') {
        Object.assign(patch, {
          closedAt: at,
          closedBy: actor,
          closeKind: 'normal',
          closeOutcome: input.outcome?.trim() ?? null,
          closePrevention: input.prevention?.trim() ?? null,
          closeOverrideReason: override && blockers.length ? override : null,
          closeOverrideBy: override && blockers.length ? actor : null,
          closeSkippedBlockers: override && blockers.length ? blockers.map((b) => b.text) : null,
        });
      }
      const text = `Stage: ${R.STAGE_LABEL[from]} → ${R.STAGE_LABEL[input.to]}${override && blockers.length ? ` (override: ${override})` : ''}`;
      return {
        patch,
        summary: text + (override && blockers.length ? ` — skipped: ${blockers.map((b) => b.text).join('; ')}` : ''),
        reason: override,
        events: [{ text, source: 'Safety', kind: 'milestone', logged: at }],
      };
    });
  }

  /** Reopen (E10): closed → resolution, reason required; the closure is cleared (kept in the audit). */
  async reopen(p: Principal, id: string, input: A.ReasonInput): Promise<{ id: string; version: number }> {
    return this.write(p, id, input.version, 'accident_reopened', async (row, _tx, at) => {
      if (row.stage !== 'closed') throw this.core.refused(`${row.number} is not closed`);
      return {
        patch: {
          stage: 'resolution',
          closedAt: null,
          closedBy: null,
          closeKind: null,
          closeReason: null,
          closeOutcome: null,
          closePrevention: null,
          closeOverrideReason: null,
          closeOverrideBy: null,
          closeSkippedBlockers: null,
        },
        summary: `Reopened: ${input.reason}`,
        reason: input.reason,
        events: [{ text: `Case reopened — ${input.reason}`, source: 'Safety', kind: 'milestone', logged: at }],
      };
    });
  }

  /** Close administratively (E11): override permission, reason, the skipped blockers stored. */
  async closeAdministratively(p: Principal, id: string, input: A.ReasonInput): Promise<{ id: string; version: number }> {
    if (!hasPermission(p, 'accidents.override')) throw forbidden('accidents.override', 'Closing administratively is restricted to Safety Managers and the owner');
    const { st, c } = await this.ruleCase(p, id);
    if (c.stage === 'draft' || c.stage === 'closed') throw this.core.refused(`${c.number} cannot be closed administratively from ${R.STAGE_LABEL[c.stage]}`);
    const skipped = R.closeBlockers(st.all, c, { now: this.now().getTime(), settings: st.settings }).map((b) => b.text);
    const actor = this.actor(p);
    return this.write(p, id, input.version, 'accident_closed_administratively', async (_row, _tx, at) => ({
      patch: {
        stage: 'closed',
        closedAt: at,
        closedBy: actor,
        closeKind: 'administrative',
        closeReason: input.reason,
        closeOutcome: `Closed administratively: ${input.reason}`,
        closeSkippedBlockers: skipped,
        closeOverrideReason: input.reason,
        closeOverrideBy: actor,
      },
      summary: `Closed administratively — skipped: ${skipped.join('; ') || 'nothing'}`,
      reason: input.reason,
      events: [{ text: `Stage: ${R.STAGE_LABEL[c.stage]} → Closed (closed administratively: ${input.reason})`, source: 'Safety', kind: 'milestone', logged: at }],
    }));
  }

  /** Void — entered in error (E12): refused while claims, work orders or AP bills are linked. */
  async void(p: Principal, id: string, input: A.ReasonInput): Promise<{ id: string; version: number }> {
    const row = await this.row(p.companyId, id);
    const [claims, orders] = await Promise.all([
      this.db
        .select({ id: safetyClaims.id, number: safetyClaims.number })
        .from(safetyClaims)
        .where(and(eq(safetyClaims.companyId, p.companyId), eq(safetyClaims.accidentId, id), isNull(safetyClaims.voidedAt))),
      this.db
        .select({ id: workOrders.id, number: workOrders.number })
        .from(workOrders)
        .where(and(eq(workOrders.companyId, p.companyId), isNull(workOrders.voidedAt), row.workOrderId ? or(eq(workOrders.id, row.workOrderId), eq(workOrders.accidentId, id)) : eq(workOrders.accidentId, id))),
    ]);
    const bills = await this.db.select({ id: acctBills.id, number: acctBills.billNumber }).from(acctBills).where(and(eq(acctBills.companyId, p.companyId), eq(acctBills.accidentId, id)));
    if (claims.length || orders.length || bills.length) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        type: '/problems/linked-records',
        detail: `${row.number} has linked records: ${[...claims.map((k) => k.number), ...orders.map((w) => w.number), ...bills.map((b) => b.number)].join(', ')}. Unlink or void them first.`,
        extensions: { claims, workOrders: orders, apBills: bills },
      });
    }
    return this.write(p, id, input.version, 'accident_voided', async (_row, _tx, at) => ({
      patch: { voidedAt: at, voidedBy: this.actor(p), voidReason: input.reason },
      summary: `Voided — entered in error: ${input.reason}`,
      reason: input.reason,
      events: [{ text: `Voided — entered in error: ${input.reason}`, source: 'Safety', kind: 'milestone', logged: at }],
    }));
  }

  /** Manual severity (with a reason) stops auto-updates; `auto` resumes them (D-extra). */
  async severity(p: Principal, id: string, input: A.SeverityInput): Promise<{ id: string; version: number }> {
    const { st, c } = await this.ruleCase(p, id);
    return this.write(p, id, input.version, 'accident_severity_changed', async (_row, _tx, at) => {
      if ('auto' in input) {
        const s = R.suggestedSeverity(c, { now: at.getTime(), settings: st.settings });
        return {
          patch: { severity: s.value, severityManualReason: null, severityManualBy: null, severityManualAt: null },
          summary: `Severity back to automatic: ${R.SEVERITY_LABEL[s.value]}`,
          events: [{ text: `Severity set to automatic — ${R.SEVERITY_LABEL[s.value]} (${s.why})`, source: 'Safety', kind: 'change', logged: at }],
        };
      }
      return {
        patch: { severity: input.severity, severityManualReason: input.reason, severityManualBy: this.actor(p), severityManualAt: at },
        summary: `Severity set to ${R.SEVERITY_LABEL[input.severity]}`,
        reason: input.reason,
        events: [{ text: `Severity changed to ${R.SEVERITY_LABEL[input.severity]} — ${input.reason}`, source: 'Safety', kind: 'change', logged: at }],
      };
    });
  }

  async owner(p: Principal, id: string, input: A.OwnerInput): Promise<{ id: string; version: number }> {
    const person = await this.core.person(p.companyId, input.ownerId);
    return this.write(p, id, input.version, 'accident_owner_changed', async (_row, _tx, at) => ({
      patch: { ownerId: person?.id ?? null, ownerName: person?.name ?? null },
      summary: `Case owner: ${person?.name}`,
      events: [{ text: `Case owner changed to ${person?.name}`, source: 'Safety', kind: 'change', logged: at }],
    }));
  }

  async legalHold(p: Principal, id: string, input: A.LegalHoldInput): Promise<{ id: string; version: number }> {
    if (!hasPermission(p, 'accidents.override')) throw forbidden('accidents.override', 'Legal hold is placed by a Safety Manager or the owner');
    return this.write(p, id, input.version, input.on ? 'accident_legal_hold_placed' : 'accident_legal_hold_released', async (row, _tx, at) => {
      if (input.on && row.legalHoldSince) throw this.core.refused('A legal hold is already in place');
      if (!input.on && !row.legalHoldSince) throw this.core.refused('There is no legal hold to release');
      return {
        patch: input.on ? { legalHoldSince: at, legalHoldBy: this.actor(p), legalHoldReason: input.reason } : { legalHoldSince: null, legalHoldBy: null, legalHoldReason: null },
        summary: input.on ? `Legal hold placed: ${input.reason}` : `Legal hold released: ${input.reason}`,
        reason: input.reason,
        events: [{ text: input.on ? `Legal hold placed — ${input.reason}` : `Legal hold released — ${input.reason}`, source: 'Safety', kind: 'milestone', logged: at }],
      };
    });
  }

  /** “Record no claim” (Claims & costs): why no insurance claim is filed, with who and when. null clears it. */
  async claimDecision(p: Principal, id: string, input: A.ClaimDecisionInput): Promise<{ id: string; version: number }> {
    return this.write(p, id, input.version, 'accident_claim_decision', async (_row, _tx, at) => ({
      patch: input.text ? { claimDecisionText: input.text, claimDecisionBy: this.actor(p), claimDecisionAt: at } : { claimDecisionText: null, claimDecisionBy: null, claimDecisionAt: null },
      summary: input.text ? `No claim: ${input.text}` : '“No claim” decision cleared',
      events: [{ text: input.text ? `No claim filed — ${input.text}` : '“No claim” decision cleared', source: 'Claims', kind: 'change', logged: at }],
    }));
  }

  /** Summary override (SPEC §7.11): stored with author, time and the facts hash the server computes. null = use generated. */
  async summaryOverride(p: Principal, id: string, input: A.SummaryOverrideInput): Promise<{ id: string; version: number }> {
    const { c } = await this.ruleCase(p, id);
    const hash = R.factsHash(c);
    return this.write(p, id, input.version, 'accident_summary_override', async (_row, _tx, at) => ({
      patch: input.text
        ? { summaryOverrideText: input.text, summaryOverrideBy: this.actor(p), summaryOverrideAt: at, summaryFactsHash: hash }
        : { summaryOverrideText: null, summaryOverrideBy: null, summaryOverrideAt: null, summaryFactsHash: null },
      summary: input.text ? 'Summary edited' : 'Summary switched back to the generated draft',
      events: [{ text: input.text ? 'Summary edited' : 'Summary switched back to the generated draft', source: 'Safety', kind: 'change', logged: at }],
    }));
  }

  /**
   * Post-accident test record (Incident tab, SPEC §7.3). Safety may only escalate to "required"; a test time after the
   * 8 h / 32 h limit is refused (record why it was not given instead); a late alcohol test needs the delay reason.
   */
  async test(p: Principal, id: string, substance: 'alcohol' | 'drug', input: A.TestRecordInput): Promise<{ id: string; version: number }> {
    if (input.result !== undefined && !hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'Test results are restricted');
    const { st, c } = await this.ruleCase(p, id);
    const set = R.resolveSettings(st.settings);
    const limitH = substance === 'alcohol' ? set.alcoholWindowHours : set.drugWindowHours;
    const occ = Date.parse(c.occurredAt);
    const prev = c.testing[substance];
    if (input.administeredAt) {
      const ms = Date.parse(input.administeredAt) - occ;
      if (ms < 0) throw invalid([{ path: 'administeredAt', message: 'The test time is before the accident' }]);
      if (ms > limitH * R.HOUR) throw invalid([{ path: 'administeredAt', message: `Recorded test time is after the ${limitH}-hour limit — record why the test was not given instead` }]);
      if (Date.parse(input.administeredAt) > this.now().getTime() + 5 * 60_000) throw invalid([{ path: 'administeredAt', message: 'This time is in the future' }]);
      const delay = input.delayReason !== undefined ? input.delayReason : prev.delayReason;
      if (substance === 'alcohol' && ms > set.alcoholPromptHours * R.HOUR && !delay?.trim())
        throw invalid([{ path: 'delayReason', message: 'Given more than 2 hours after the accident — record why it was not given sooner (382.303(d)(1))' }]);
    }
    const row0 = st.rows.get(id) as SafetyAccidentRow;
    return this.write(p, id, input.version, 'accident_test_recorded', async (_row, tx, at) => {
      const [existing] = await tx
        .select()
        .from(drugAlcoholTests)
        .where(and(eq(drugAlcoholTests.companyId, p.companyId), eq(drugAlcoholTests.accidentId, id), eq(drugAlcoholTests.substance, substance), isNull(drugAlcoholTests.voidedAt)))
        .limit(1);
      const values: Partial<typeof drugAlcoholTests.$inferInsert> = {};
      if (input.decision) Object.assign(values, { postAccidentDecision: input.decision, decisionBy: this.actor(p), decisionAt: at });
      if (input.administeredAt !== undefined) values.collectedAt = input.administeredAt ? new Date(input.administeredAt) : null;
      if (input.delayReason !== undefined) values.lateReason = input.delayReason;
      if (input.notAdministeredReason !== undefined) values.notCompletedReason = input.notAdministeredReason;
      if (input.result !== undefined) Object.assign(values, { result: input.result, resultAt: at });
      const afterCase: R.AccidentCase = { ...c, testing: { ...c.testing, [substance]: { ...prev, ...(input.decision ? { decision: input.decision } : {}), ...(input.administeredAt !== undefined ? { administeredAt: input.administeredAt ?? undefined } : {}) } } };
      const det = R.testing(afterCase, { now: at.getTime(), settings: st.settings })[substance];
      values.required = det.required === 'yes';
      values.requiredReason = det.reason;
      if (existing) {
        await tx.update(drugAlcoholTests).set({ ...values, version: existing.version + 1, updatedAt: at }).where(eq(drugAlcoholTests.id, existing.id));
      } else {
        const number = await this.core.nextNumber(p.companyId, 'drug_test');
        await tx.insert(drugAlcoholTests).values({
          id: this.newId('dat'),
          companyId: p.companyId,
          number,
          ownerId: row0.ownerId,
          ownerName: row0.ownerName,
          isTest: row0.isTest,
          createdBy: this.actor(p),
          createdAt: at,
          updatedAt: at,
          testType: 'post_accident',
          substance,
          driverId: row0.driverId,
          driverName: row0.driverName,
          accidentId: id,
          accidentNumber: row0.number,
          occurredAt: row0.occurredAt,
          ...values,
        });
      }
      const Sub = substance === 'alcohol' ? 'Alcohol' : 'Drug';
      const what = [
        input.decision === 'required' ? 'marked required by Safety (company policy)' : input.decision === 'auto' ? 'back to the rule' : null,
        input.administeredAt ? `given ${R.fmtDateTime(input.administeredAt, c.tz)}` : null,
        input.notAdministeredReason ? `not given — ${input.notAdministeredReason}` : null,
        input.delayReason ? `delay reason recorded` : null,
        input.result ? 'result recorded' : null,
      ].filter(Boolean);
      // Events from a restricted subject (tests) are restricted automatically (API.md case writes).
      return {
        patch: {},
        summary: `${Sub} test: ${what.join('; ') || 'updated'}`,
        events: [{ text: `${Sub} test ${what.join('; ') || 'updated'}`, source: 'Safety', kind: 'change', logged: at, restricted: true }],
      };
    });
  }

  /** Unit status / damage / tow (Equipment). Out of service opens downtime if none is open; back in service closes it. */
  async unit(p: Principal, id: string, unitId: string, input: A.UnitPatchInput): Promise<{ id: string; version: number }> {
    // Fleet (accidents.edit_units) updates where the unit is, damage, tow and storage; the condition at the scene is Safety's.
    if (input.conditionAtScene && !hasPermission(p, 'accidents.edit')) throw forbidden('accidents.edit', 'The condition at the scene is recorded by Safety');
    const row = await this.row(p.companyId, id);
    const at = this.now();
    const audits: AuditEvent[] = [];
    const out = await this.db.transaction(async (tx) => {
      const [u] = await tx
        .select()
        .from(accidentUnits)
        .where(and(eq(accidentUnits.companyId, p.companyId), eq(accidentUnits.accidentId, id), eq(accidentUnits.id, unitId)))
        .for('update')
        .limit(1);
      if (!u) throw this.core.notFound('That unit on the case');
      if (u.version !== input.version) throw conflict(u, `Unit ${u.unitNumber ?? ''}`);
      const patch: Partial<AccidentUnitRow> = {};
      if (input.status) patch.status = input.status;
      if (input.conditionAtScene) patch.conditionAtScene = input.conditionAtScene;
      if (input.damage !== undefined) patch.damage = input.damage;
      if (input.towCompany !== undefined) patch.towCompany = input.towCompany;
      if (input.towedTo !== undefined) patch.towedTo = input.towedTo;
      if (input.storageRateCents !== undefined) patch.storageRateCents = input.storageRateCents;
      if (input.storageSince !== undefined) patch.storageSince = input.storageSince ? new Date(input.storageSince) : null;
      if (input.status === 'returned') patch.returnedToServiceAt = at;
      await tx.update(accidentUnits).set({ ...patch, version: u.version + 1, updatedAt: at }).where(eq(accidentUnits.id, u.id));
      const label = `${u.unitKind === 'truck' ? 'Truck' : 'Trailer'} ${u.unitNumber ?? ''}`.trim();
      if (input.status && !IN_SERVICE.has(input.status) && input.status !== 'unknown') {
        await tx
          .insert(downtimePeriods)
          .values({ id: this.newId('dtp'), companyId: p.companyId, accidentId: id, unitKind: u.unitKind, unitId: u.unitId, startedAt: row.occurredAt, source: 'entered', note: 'Started when the unit was marked out of service', createdBy: this.actor(p), createdAt: at, updatedAt: at })
          .onConflictDoNothing();
      }
      if (input.status === 'operational' || input.status === 'returned') {
        await tx
          .update(downtimePeriods)
          .set({ endedAt: at, updatedAt: at, version: sql`${downtimePeriods.version} + 1` })
          .where(and(eq(downtimePeriods.companyId, p.companyId), eq(downtimePeriods.accidentId, id), eq(downtimePeriods.unitId, u.unitId), isNull(downtimePeriods.endedAt)));
      }
      const text = `${label}: ${[input.status ? R.EQUIP_STATUS_LABEL[input.status] : null, input.damage ? `damage — ${input.damage}` : null, input.towCompany ? `towed by ${input.towCompany}` : null, input.towedTo ? `to ${input.towedTo}` : null].filter(Boolean).join(', ') || 'updated'}`;
      await this.event(tx, p, id, { text, source: hasPermission(p, 'accidents.edit') ? 'Safety' : 'Fleet', kind: 'change', logged: at, before: pick(u, Object.keys(patch)), after: patch });
      await tx.update(safetyAccidents).set({ updatedAt: at, version: sql`${safetyAccidents.version} + 1` }).where(eq(safetyAccidents.id, id));
      audits.push(await this.auditIn(tx, p, row, 'accident_unit_updated', text, at, Object.entries(patch).map(([field, v]) => ({ field: `unit.${field}`, old: null, new: v === null || v === undefined ? null : String(v instanceof Date ? v.toISOString() : v) }))));
      return { id: u.id, version: u.version + 1 };
    });
    await this.audit.publish(...audits);
    return out;
  }

  /** A request to Dispatch (SPEC §6.4): a high-priority Dispatch task due in 3 h; nothing changes until Dispatch confirms. */
  async request(p: Principal, id: string, input: A.RequestInput): Promise<A.TaskView> {
    const row = await this.row(p.companyId, id);
    if (row.stage === 'draft') throw this.core.refused('Submit the draft before asking other departments');
    const at = this.now();
    const unit = row.truckNumber ? `Truck ${row.truckNumber}` : 'the unit';
    const title =
      input.kind === 'repower_transload'
        ? `Repower / transload ${row.loadNumber ? `load ${row.loadNumber}` : 'the load'} (${row.number})`
        : input.kind === 'unit_unavailable'
          ? `Mark ${unit} unavailable on the Daily board (${row.number}) — confirm when done`
          : `Notify the broker about ${row.number}${row.loadNumber ? ` (load ${row.loadNumber})` : ''}`;
    const taskId = this.newId('tsk');
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await tx.insert(safetyTasks).values({
        id: taskId,
        companyId: p.companyId,
        accidentId: id,
        title,
        dept: 'Dispatch',
        dueAt: new Date(at.getTime() + 3 * R.HOUR),
        priority: 'high',
        instructions: input.note,
        autoRule: 'Safety request',
        requestKind: input.kind,
        requestPayload: { truckId: row.truckId, loadId: row.loadId },
        isTest: row.isTest,
        createdBy: this.actor(p),
        createdAt: at,
        updatedAt: at,
      });
      await this.event(tx, p, id, { text: `Dispatch asked: ${title} — ${input.note}`, source: 'Safety', kind: 'task', logged: at });
      audits.push(await this.auditIn(tx, p, row, 'accident_request_created', `Request to Dispatch: ${title}`, at));
    });
    await this.audit.publish(...audits);
    const { st } = await this.loadState(p);
    const t = R.byId(st.all.tasks, taskId);
    return V.taskView(st, t as R.Task, at.getTime());
  }

  /** Manual timeline entry (Log event): event time in incident-local time; restricted only with accidents.restricted. */
  async logEvent(p: Principal, id: string, input: A.LogEventInput): Promise<{ id: string }> {
    if (input.restricted && !hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'Restricted entries are written by Safety Managers');
    const row = await this.row(p.companyId, id);
    const at = this.now();
    let when = at;
    if (input.occurredAtLocal) {
      const r = R.localToUtc(input.occurredAtLocal, row.occurredTz ?? R.EASTERN);
      if (!r.ok) throw invalid([{ path: 'occurredAtLocal', message: r.message }]);
      if (Date.parse(r.iso) > at.getTime() + 5 * 60_000) throw invalid([{ path: 'occurredAtLocal', message: 'This time is in the future' }]);
      when = new Date(r.iso);
    }
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await this.event(tx, p, id, { text: input.text, source: input.source, kind: 'note', at: when, logged: at, restricted: input.restricted ?? false });
      audits.push(await this.auditIn(tx, p, row, 'accident_event_logged', input.restricted ? 'Restricted timeline entry logged' : `Logged: ${input.text}`, at));
    });
    await this.audit.publish(...audits);
    return { id };
  }
}

/** The rules' view of a case after a facts patch (for severity and the DOT re-evaluation event). */
function caseAfter(c: R.AccidentCase, patch: Partial<typeof safetyAccidents.$inferInsert>, truckCondition?: R.EquipmentState['condition']): R.AccidentCase {
  const out: R.AccidentCase = JSON.parse(JSON.stringify(c));
  const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);
  if (patch.occurredAt) out.occurredAt = (patch.occurredAt as Date).toISOString();
  if (has('publicRoad')) out.location.publicRoad = (patch.publicRoad ?? null) as R.Tri;
  if (has('injuriesStatus')) out.injuries.status = (patch.injuriesStatus ?? null) as R.Tri;
  if (has('treatedAwayCount')) out.injuries.treatedAway = patch.treatedAwayCount ?? null;
  if (has('fatalitiesCount')) out.injuries.fatalities = patch.fatalitiesCount ?? null;
  if (out.injuries.status === 'no') {
    out.injuries.treatedAway = 0;
    out.injuries.fatalities = 0;
  }
  if (has('towAway')) out.towAway = (patch.towAway ?? null) as R.Tri;
  if (has('citationStatus')) out.citation.status = (patch.citationStatus ?? null) as R.Tri;
  if (has('citationAt')) out.citation.issuedAt = patch.citationAt ? (patch.citationAt as Date).toISOString() : undefined;
  if (has('hazmatReleased')) out.hazmat = (patch.hazmatReleased ?? null) as R.Tri;
  if (has('excludedOccurrence')) out.excludedOccurrence = (patch.excludedOccurrence ?? undefined) as R.AccidentCase['excludedOccurrence'];
  if (has('cargoStatus')) out.cargo.status = (patch.cargoStatus ?? 'unknown') as R.CargoState['status'];
  if (has('initialEstimateCents')) out.initialEstimateCents = patch.initialEstimateCents ?? undefined;
  if (truckCondition) out.equipment.truck.condition = truckCondition;
  return out;
}

function pick(row: object, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (row as Record<string, unknown>)[k] ?? null;
  return out;
}
