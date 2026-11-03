import type Anthropic from '@anthropic-ai/sdk';
import {
  CANDIDATE_SAFETY_LABELS,
  RECRUIT_BOARD_COLUMN_LABELS,
  RecruitBoardQuerySchema,
  RosterQuerySchema,
  canReadWorkspaceKey,
  trackingFreshness,
  type AiCard,
  type AiTableCard,
  type DriverComplianceRow,
  type RecruitBoardCard,
  type StoredLoad,
  type TrailerRecord,
  type TruckRecord,
  type UnitComplianceRow,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { isFeatureEnabled } from '../../../common/flags/flags';
import { InvoicesService } from '../../accounting/invoices.service';
import { CLOCK, systemClock, type Clock } from '../../dashboard/clock';
import { PtiService } from '../../fleet/pti.service';
import { WorkOrdersService } from '../../fleet/work-orders.service';
import { RecruitService } from '../../hiring/recruit.service';
import { LoadsService } from '../../loads/loads.service';
import { UNIT_PICKER_PERMISSIONS } from '../../roster/roster-access';
import { TrailersService } from '../../roster/trailers.service';
import { TrucksService } from '../../roster/trucks.service';
import { ComplianceViewService } from '../../safety/compliance-view.service';
import { StateService } from '../../state/state.service';
import type { ActionContext } from '../ai-actions/types';
import type { ToolOutcome } from '../ai-tools';
import {
  DEVIATION_DEFAULT_MILES,
  FUEL_DEFAULTS,
  ROLLING_STATUSES,
  assessDeviation,
  assessLateRisk,
  detectFuelAnomalies,
  eastern,
  easternDay,
  inZone,
  minutesText,
  rankIssues,
  type BriefIssue,
  type FuelRow,
  type Position,
  type StopFacts,
} from './detect';
import { geoAvailable, placeOfStop } from './geo';

/**
 * NeWay AI's read-only insight tools (hackathon A2, 2026-11-03): "which documents is truck 0033
 * missing", "who is running late", "any odd fuel", and the Morning brief that runs them all.
 *
 * Every tool reads through the service the matching screen uses, as the signed-in person: their
 * company (the services filter by `principal.companyId`), their permissions (checked here with
 * the codes the screen's route needs), the server's clock (CLOCK, US Eastern). Nothing here
 * writes. The answer is compact JSON for the model plus a table card for the person.
 */

const FUEL_KEY = 'ws2-fueltransactions';
const COMPLIANCE_UNIT_READERS = ['compliance.view', 'safety.view', 'trucks.view', 'trailers.view'];
const BAD_DOC = new Set(['missing', 'expired', 'verification_failed', 'expiring', 'pending_verification']);
const DRIVER_COLUMN_NAME: Record<string, string> = {
  cdl: 'CDL',
  medical_card: 'Medical card',
  mvr_review: 'MVR review',
  clearinghouse_query: 'Clearinghouse query',
  testing_program: 'Pre-employment drug test',
};
const DOC_WORD: Record<string, string> = {
  missing: 'missing',
  expired: 'expired',
  verification_failed: 'rejected',
  expiring: 'expiring',
  pending_verification: 'not verified yet',
  valid: 'valid',
  verified: 'verified',
  waived: 'waived',
  not_applicable: 'not applicable',
};

export const INSIGHT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'truck_status',
    description:
      'One truck or trailer by unit number (e.g. "0033", "truck 2702", "trailer 5310"): current driver, whether it is down (in the shop), last ELD position and how old it is, open work orders and PTI defects, its current load, and its MISSING / EXPIRED / EXPIRING papers (registration, insurance, annual inspection, IFTA ... from the compliance store) plus the assigned driver\'s (CDL, medical card ...). Use for "what is wrong with truck X", "which documents is truck X missing", "where is truck X".',
    input_schema: {
      type: 'object',
      properties: { unit: { type: 'string', description: 'Unit number as said, e.g. 0033' }, kind: { type: 'string', enum: ['truck', 'trailer'], description: 'Only when the person said which.' } },
      required: ['unit'],
    },
  },
  {
    name: 'expiring_compliance',
    description:
      'Drivers (CDL, medical card, MVR review, Clearinghouse query, pre-employment drug test) and trucks / trailers (registration, inspection, insurance ...) whose papers have EXPIRED or EXPIRE within `days` (default 30), worst first. include_missing adds papers with nothing on file. Use for "whose CDL / medical card expires this month", "what papers are expired".',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 0, maximum: 365 },
        who: { type: 'string', enum: ['all', 'drivers', 'units'] },
        include_missing: { type: 'boolean' },
      },
    },
  },
  {
    name: 'fuel_anomalies',
    description:
      'Odd fuel purchases in the Fleet › Fuel ledger over the last `days` (default 14): the same truck fueling twice in a row within a few hours without driving far, a fill bigger than the tanks hold (300 gal), an odometer going backwards, and what the ledger itself flagged (duplicate, location mismatch). unit narrows to one truck.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 90 }, unit: { type: 'string' }, window_hours: { type: 'number', minimum: 0.5, maximum: 24 } },
    },
  },
  {
    name: 'late_risk',
    description:
      'Loads on the road right now and whether each will make its next stop appointment: distance from the truck\'s last ELD position to the stop, ETA at the TMS average speed, and the verdict late / at risk / on time / no update, with minutes. Same rule as the Operations screen. Use for "who is running late", "will L-100005 make it".',
    input_schema: { type: 'object', properties: { load_number: { type: 'string', description: 'Only this load.' } } },
  },
  {
    name: 'route_deviation',
    description:
      'Trucks on a load whose last ELD position is far (default more than 75 miles; interstates bend, so less flags trucks on the obvious road) off the straight line between the stop they left and the stop they are running to. A straight line is not a road: treat it as a hint to call the driver, never as proof.',
    input_schema: { type: 'object', properties: { threshold_miles: { type: 'integer', minimum: 10, maximum: 500 } } },
  },
  {
    name: 'hos_status',
    description: 'Hours of service (drive / duty clock) for a driver or unit. Only answers whether the TMS has HOS data.',
    input_schema: { type: 'object', properties: { driver: { type: 'string' }, unit: { type: 'string' } } },
  },
  {
    name: 'billing_missing_docs',
    description:
      'Delivered loads that cannot be invoiced yet because a document is missing or rejected (POD, rate confirmation, TONU confirmation ...): which document, and how many days since delivery. Use for "what is stopping billing", "which loads miss POD".',
    input_schema: { type: 'object', properties: { min_days: { type: 'integer', minimum: 0, maximum: 365 } } },
  },
  {
    name: 'hiring_pipeline',
    description:
      'The driver hiring pipeline: candidates per board column, who is stuck (in the same step longer than stuck_days, default 3), and who is waiting on consent or on Safety (MVR / PSP / drug test review).',
    input_schema: { type: 'object', properties: { stuck_days: { type: 'integer', minimum: 1, maximum: 60 } } },
  },
  {
    name: 'morning_brief',
    description:
      'The Morning brief: runs expiring_compliance, fuel_anomalies, late_risk, route_deviation, billing_missing_docs and hiring_pipeline and returns the top issues ranked urgent → warning → info. Use for "what needs my attention today", "morning brief", "what should I worry about".',
    input_schema: { type: 'object', properties: {} },
  },
];

export const INSIGHT_TOOL_NAMES: ReadonlySet<string> = new Set(INSIGHT_TOOLS.map((t) => t.name));

/** One line for the system prompt: when to reach for these. */
export const INSIGHT_PROMPT =
  'For questions about the state of the operation - a unit and its papers (truck_status), expiring papers (expiring_compliance), odd fuel (fuel_anomalies), late loads (late_risk), trucks off route (route_deviation), hours of service (hos_status), loads that cannot be billed (billing_missing_docs), hiring (hiring_pipeline) or "what needs attention today" (morning_brief) - call the matching read-only tool and answer from it. Say a status with its word: Urgent, Warning or Info. Times are US Eastern.';

// ------------------------------------------------------------------------------------ plumbing

/** What one analysis found: data for the model, cards for the person, issues for the brief. */
export interface Insight {
  data: Record<string, unknown>;
  cards: AiCard[];
  issues: BriefIssue[];
}
interface Refused {
  refused: string;
}
type Result = Insight | Refused;

const refused = (text: string): Refused => ({ refused: text });
const isRefused = (r: Result): r is Refused => 'refused' in r;
const holdsAny = (p: Principal, codes: readonly string[]) => codes.some((c) => hasPermission(p, c));
const holdsAll = (p: Principal, codes: readonly string[]) => codes.every((c) => hasPermission(p, c));
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const int = (v: unknown, def: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def);
const normUnit = (s: string) => s.trim().toUpperCase().replace(/^(UNIT|TRUCK|TRAILER|TRK|TRL)\s*#?\s*/, '').replace(/^0+(?=\d)/, '');
const dayDiff = (from: string, to: string) => Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000);
const fmtDate = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');

function clockOf(ctx: ActionContext): Clock {
  try {
    return (ctx.get as unknown as (token: symbol) => Clock)(CLOCK) ?? systemClock;
  } catch {
    return systemClock;
  }
}

async function trucksOf(ctx: ActionContext, p: Principal): Promise<TruckRecord[]> {
  return (await ctx.get(TrucksService).list(p, RosterQuerySchema.parse({ pageSize: 1000 }))).data;
}
async function trailersOf(ctx: ActionContext, p: Principal): Promise<TrailerRecord[]> {
  return (await ctx.get(TrailersService).list(p, RosterQuerySchema.parse({ pageSize: 1000 }))).data;
}

/** A truck's last ELD fix, in the shape the checks read. */
const positionOf = (t: TruckRecord | undefined): Position | null =>
  t?.location ? { lat: t.location.lat, lng: t.location.lng, updatedAt: t.location.updatedAt, city: t.location.city, state: t.location.state } : null;

const stopsOf = (load: StoredLoad): StopFacts[] => (load.stops ?? []).map((s) => ({ ...s, appointmentStartAt: s.appointmentStartAt || null, appointmentEndAt: s.appointmentEndAt || null }));
const loadRec = (load: StoredLoad) => load as StoredLoad & { truckUnit?: string | null; driverName?: string | null; manualEta?: { at: string; recordedAt: string; stopId?: string | null } | null };

function table(title: string, columns: string[], rows: string[][], max = 25): AiTableCard {
  return { kind: 'table', title, columns, rows: rows.slice(0, max), note: rows.length > max ? `Showing ${max} of ${rows.length}.` : undefined };
}

// ------------------------------------------------------------------------------------ truck_status

async function truckStatus(ctx: ActionContext, p: Principal, input: Record<string, unknown>, now: Date): Promise<Result> {
  if (!holdsAny(p, UNIT_PICKER_PERMISSIONS)) return refused('You do not have access to trucks and trailers (trucks.view).');
  const raw = str(input.unit);
  const wanted = normUnit(raw);
  if (!wanted) return refused('Say which unit, e.g. truck 0033 or trailer 5310.');
  const kind = input.kind === 'truck' || input.kind === 'trailer' ? input.kind : null;
  const [trucks, trailers] = await Promise.all([kind === 'trailer' ? [] : trucksOf(ctx, p), kind === 'truck' ? [] : trailersOf(ctx, p)]);
  const hits = [
    ...trucks.filter((t) => normUnit(t.unitNumber) === wanted).map((t) => ({ kind: 'truck' as const, truck: t, trailer: null, id: t.id, unitNumber: t.unitNumber })),
    ...trailers.filter((t) => normUnit(t.unitNumber) === wanted).map((t) => ({ kind: 'trailer' as const, truck: null, trailer: t, id: t.id, unitNumber: t.unitNumber })),
  ];
  if (hits.length === 0) {
    const near = [...trucks.map((t) => `truck ${t.unitNumber}`), ...trailers.map((t) => `trailer ${t.unitNumber}`)].filter((l) => normUnit(l.split(' ')[1]!).includes(wanted)).slice(0, 5);
    return refused(`There is no ${kind ?? 'truck or trailer'} ${raw} in this company${near.length ? `. Did you mean: ${near.join(', ')}?` : '.'}`);
  }
  if (hits.length > 1) return refused(`${raw} is both a truck and a trailer. Say which one.`);
  const unit = hits[0]!;
  const nowIso = now.toISOString();
  const today = easternDay(now);
  const data: Record<string, unknown> = { unit: unit.unitNumber, kind: unit.kind };
  const issues: BriefIssue[] = [];
  const notes: string[] = [];
  const link = unit.kind === 'truck' ? `/fleet/trucks/${encodeURIComponent(unit.id)}` : `/fleet/trailers/${encodeURIComponent(unit.id)}`;

  if (unit.truck) {
    const t = unit.truck;
    const fresh = trackingFreshness(t.location?.updatedAt ?? null, nowIso);
    data.status = t.status;
    data.driver = t.currentDriverName ?? null;
    data.odometer = t.odometer;
    data.trailer = trailers.find((x) => x.id === t.currentTrailerId)?.unitNumber ?? t.currentTrailerId ?? null;
    data.lastPosition = t.location
      ? { place: `${t.location.city}, ${t.location.state}`, at: eastern(t.location.updatedAt), age: fresh.ageMinutes === null ? null : minutesText(fresh.ageMinutes), tracking: fresh.state, speedMph: t.location.speedMph, engine: t.location.engineState }
      : { place: null, tracking: 'none', note: 'No ELD position on file for this truck' };
    data.eld = t.telematicsProvider;
  } else if (unit.trailer) {
    data.status = unit.trailer.status;
    data.pulledBy = unit.trailer.currentTruckUnit ?? null;
  }

  // Down = an unvoided work order "In the shop" (fleet spec: availability comes from down periods).
  if (isFeatureEnabled('fleet_v2') && holdsAny(p, ['maintenance.view', 'trucks.view', 'trailers.view'])) {
    const inShop = await ctx.get(WorkOrdersService).inShopUnits(p);
    data.down = inShop.some((u) => u.unitId === unit.id);
    if (hasPermission(p, 'maintenance.view')) {
      const orders = (await ctx.get(WorkOrdersService).list(p, { unitId: unit.id })).filter((o) => o.status !== 'completed');
      data.openWorkOrders = orders.map((o) => ({ number: o.number, status: o.status, what: o.workDone ?? o.label, shop: o.vendorName, since: eastern(o.shopInAt) }));
    } else notes.push('Work orders need maintenance.view');
    if (hasPermission(p, 'trucks.view')) {
      const issuesByUnit = await ctx.get(PtiService).unitIssues(p).catch(() => ({}) as Record<string, never>);
      const mine = (issuesByUnit as Record<string, { defects: Array<{ defectNumber: string; componentName: string; description: string; severity: string; state: string }> }>)[unit.id];
      data.openDefects = (mine?.defects ?? []).map((d) => ({ defect: d.defectNumber, part: d.componentName, what: d.description, severity: d.severity, state: d.state }));
    }
  } else data.down = null;

  // Papers: the unit's own, through the compliance engine (same cells as Safety › Compliance).
  let unitDocs: Array<{ document: string; status: string; date: string | null; daysLeft: number | null }> = [];
  if (holdsAny(p, COMPLIANCE_UNIT_READERS)) {
    const rows = await ctx.get(ComplianceViewService).vehicles(p);
    const row = rows.find((r) => r.unitId === unit.id);
    unitDocs = (row?.cells ?? [])
      .map((c) => ({ document: c.name, status: c.status, date: c.date, daysLeft: c.date ? dayDiff(today, c.date) : null }))
      .filter((c) => BAD_DOC.has(c.status) || (c.daysLeft !== null && c.daysLeft >= 0 && c.daysLeft <= 30 && ['valid', 'verified'].includes(c.status)));
    data.documentsNeedingAttention = unitDocs.map((d) => ({ ...d, status: DOC_WORD[d.status] ?? d.status, date: d.date ? fmtDate(d.date) : null }));
    data.documentsOk = (row?.cells.length ?? 0) - unitDocs.length;
  } else notes.push('Unit papers need compliance.view or trucks.view');

  if (unit.truck?.currentDriverId) {
    if (holdsAll(p, ['safety.view', 'compliance.view'])) {
      const view = await ctx.get(ComplianceViewService).drivers(p);
      const row = view.rows.find((r) => r.driverId === unit.truck!.currentDriverId);
      if (row) data.driverDocumentsNeedingAttention = driverBadCells(row, today, 30);
    } else notes.push("The driver's papers need safety.view and compliance.view");
  }

  if (unit.truck && hasPermission(p, 'loads.view')) {
    const loads = await ctx.get(LoadsService).list(p, { includeDemo: false });
    const mine = loads.filter((l) => l.truckId === unit.id && !l.cancellation);
    const load = mine.find((l) => (ROLLING_STATUSES as readonly string[]).includes(l.status)) ?? mine.find((l) => ['booked', 'assigned'].includes(l.status));
    if (load) {
      const next = stopsOf(load).find((s) => s.status !== 'completed' && s.status !== 'cancelled');
      data.currentLoad = { load: load.loadNumber, status: load.status, nextStop: next ? `${next.kind} ${next.city}, ${next.state} · ${eastern(next.appointmentStartAt)}` : null };
    } else data.currentLoad = null;
  }
  if (notes.length) data.notShown = notes;

  const docLine = unitDocs.map((d) => `${d.document} ${DOC_WORD[d.status] ?? d.status}${d.date ? ` (${fmtDate(d.date)})` : ''}`).join('; ');
  const driverDocs = (data.driverDocumentsNeedingAttention as Array<{ document: string; status: string; date: string | null }> | undefined) ?? [];
  const pos = data.lastPosition as { place?: string | null; at?: string | null; age?: string | null } | undefined;
  const cards: AiCard[] = [
    table(`${unit.kind === 'truck' ? 'Truck' : 'Trailer'} ${unit.unitNumber}${data.down ? ' · down (in the shop)' : ''}`, ['Driver', 'Last position', 'Open work', 'Papers needing attention'], [
      [
        String(data.driver ?? (unit.kind === 'trailer' ? `Pulled by ${data.pulledBy ?? '—'}` : 'No driver')),
        pos?.place ? `${pos.place} · ${pos.at} (${pos.age} ago)` : '—',
        [...((data.openWorkOrders as unknown[]) ?? []).map((o) => (o as { number: string }).number), ...((data.openDefects as unknown[]) ?? []).map((d) => (d as { defect: string }).defect)].join(', ') || 'none',
        [docLine, ...driverDocs.map((d) => `Driver ${d.document} ${d.status}`)].filter(Boolean).join('; ') || 'none',
      ],
    ]),
    { kind: 'link', label: `Open ${unit.kind} ${unit.unitNumber}`, to: link },
  ];
  return { data, cards, issues };
}

function driverBadCells(row: DriverComplianceRow, today: string, days: number) {
  return Object.entries(row.cells)
    .map(([col, c]) => ({ document: DRIVER_COLUMN_NAME[col] ?? col, status: c.status, date: c.date, daysLeft: c.date ? dayDiff(today, c.date) : null }))
    .filter((c) => BAD_DOC.has(c.status) || (c.daysLeft !== null && c.daysLeft >= 0 && c.daysLeft <= days && ['valid', 'verified'].includes(c.status)))
    .map((c) => ({ ...c, status: DOC_WORD[c.status] ?? c.status, date: c.date ? fmtDate(c.date) : null }));
}

// ------------------------------------------------------------------------------------ expiring_compliance

interface PaperRow {
  who: string;
  kind: 'driver' | 'truck' | 'trailer';
  id: string;
  document: string;
  status: 'expired' | 'expiring' | 'missing' | 'rejected';
  date: string | null;
  daysLeft: number | null;
}

/** A cell as the question sees it: expired / rejected, expiring within `days`, missing - or fine. */
function judge(cell: { status: string; date: string | null }, today: string, days: number): Pick<PaperRow, 'status' | 'daysLeft'> | null {
  const daysLeft = cell.date ? dayDiff(today, cell.date) : null;
  if (cell.status === 'expired') return { status: 'expired', daysLeft };
  if (cell.status === 'verification_failed') return { status: 'rejected', daysLeft };
  if (cell.status === 'missing') return { status: 'missing', daysLeft: null };
  if (['expiring', 'valid', 'verified', 'pending_verification'].includes(cell.status) && daysLeft !== null && daysLeft >= 0 && daysLeft <= days) return { status: 'expiring', daysLeft };
  return null;
}

async function expiringCompliance(ctx: ActionContext, p: Principal, input: Record<string, unknown>, now: Date): Promise<Result> {
  const days = int(input.days, 30, 0, 365);
  const who = input.who === 'drivers' || input.who === 'units' ? input.who : 'all';
  const withMissing = input.include_missing === true;
  const today = easternDay(now);
  const rows: PaperRow[] = [];
  const skipped: string[] = [];
  const view = ctx.get(ComplianceViewService);

  if (who !== 'units') {
    if (holdsAll(p, ['safety.view', 'compliance.view'])) {
      const d = await view.drivers(p);
      for (const r of d.rows.filter((x) => x.group === 'roster')) {
        for (const [col, c] of Object.entries(r.cells)) {
          const j = judge(c, today, days);
          if (j) rows.push({ who: r.driverName, kind: 'driver', id: r.driverId, document: DRIVER_COLUMN_NAME[col] ?? col, date: c.date, ...j });
        }
      }
    } else skipped.push('drivers (needs safety.view and compliance.view)');
  }
  if (who !== 'drivers') {
    if (holdsAny(p, COMPLIANCE_UNIT_READERS)) {
      const units: UnitComplianceRow[] = await view.vehicles(p);
      for (const u of units) {
        for (const c of u.cells) {
          const j = judge(c, today, days);
          if (j) rows.push({ who: `${u.scope === 'truck' ? 'Truck' : 'Trailer'} ${u.unitNumber}`, kind: u.scope, id: u.unitId, document: c.name, date: c.date, ...j });
        }
      }
    } else skipped.push('trucks and trailers (needs compliance.view or trucks.view)');
  }
  if (skipped.length && rows.length === 0 && skipped.length === (who === 'all' ? 2 : 1)) return refused(`You do not have access to ${skipped.join(' or ')}.`);

  const order = { expired: 0, rejected: 1, expiring: 2, missing: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999) || a.who.localeCompare(b.who));
  const shown = rows.filter((r) => withMissing || r.status !== 'missing');
  const counts = {
    expired: rows.filter((r) => r.status === 'expired' || r.status === 'rejected').length,
    expiringWithinDays: rows.filter((r) => r.status === 'expiring').length,
    missing: rows.filter((r) => r.status === 'missing').length,
  };

  // The brief: one line per person or unit, its worst paper first.
  const issues: BriefIssue[] = [];
  const byWho = new Map<string, PaperRow[]>();
  for (const r of rows.filter((x) => x.status !== 'missing')) byWho.set(`${r.kind}:${r.id}`, [...(byWho.get(`${r.kind}:${r.id}`) ?? []), r]);
  for (const list of byWho.values()) {
    const worst = list[0]!;
    const level = worst.status === 'expired' || worst.status === 'rejected' ? 'urgent' : (worst.daysLeft ?? 99) <= 7 ? 'warning' : 'info';
    issues.push({
      level,
      area: 'compliance',
      title: `${worst.who}: ${worst.document} ${worst.status === 'expiring' ? `expires in ${worst.daysLeft} day${worst.daysLeft === 1 ? '' : 's'}` : worst.status}`,
      detail: list.map((r) => `${r.document} ${r.status}${r.date ? ` ${fmtDate(r.date)}` : ''}`).join('; '),
      link: worst.kind === 'driver' ? `/drivers/${encodeURIComponent(worst.id)}` : `/fleet/${worst.kind}s/${encodeURIComponent(worst.id)}`,
    });
  }
  if (counts.missing > 0) issues.push({ level: 'info', area: 'compliance', title: `${counts.missing} paper${counts.missing === 1 ? '' : 's'} with nothing on file`, detail: 'Missing documents in the compliance store (Safety › Compliance).', link: '/safety/compliance' });

  return {
    data: {
      today,
      withinDays: days,
      counts,
      ...(skipped.length ? { notShown: skipped } : {}),
      papers: shown.slice(0, 40).map((r) => ({ who: r.who, document: r.document, status: r.status, date: r.date ? fmtDate(r.date) : null, daysLeft: r.daysLeft })),
    },
    cards: [
      table(
        `${counts.expired} expired · ${counts.expiringWithinDays} expiring within ${days} days${withMissing ? ` · ${counts.missing} missing` : ''}`,
        ['Who', 'Paper', 'Status', 'Date', 'Days left'],
        shown.map((r) => [r.who, r.document, r.status, fmtDate(r.date), r.daysLeft === null ? '—' : String(r.daysLeft)]),
      ),
      { kind: 'link', label: 'Open Safety › Compliance', to: '/safety/compliance' },
    ],
    issues,
  };
}

// ------------------------------------------------------------------------------------ fuel_anomalies

async function fuelAnomalies(ctx: ActionContext, p: Principal, input: Record<string, unknown>, now: Date): Promise<Result> {
  if (!canReadWorkspaceKey(p.permissions, FUEL_KEY)) return refused('You do not have access to the Fleet › Fuel ledger.');
  const stored = await ctx.get(StateService).getFor(p.companyId, FUEL_KEY);
  let ledger: FuelRow[] = [];
  try {
    const parsed = stored ? (JSON.parse(stored.value) as unknown) : [];
    ledger = Array.isArray(parsed) ? (parsed as FuelRow[]) : [];
  } catch {
    ledger = [];
  }
  const days = int(input.days, FUEL_DEFAULTS.days, 1, 90);
  const windowHours = typeof input.window_hours === 'number' && input.window_hours > 0 ? Math.min(24, input.window_hours) : FUEL_DEFAULTS.windowHours;
  const unit = normUnit(str(input.unit));
  const rows = unit ? ledger.filter((r) => normUnit(r.unitNumber ?? '') === unit) : ledger;
  const found = detectFuelAnomalies(rows, { ...FUEL_DEFAULTS, now, days, windowHours });
  const inPeriod = rows.filter((r) => Date.parse(r.at) >= now.getTime() - days * 86_400_000 && Date.parse(r.at) <= now.getTime()).length;
  const word = { twice_in_a_row: 'Twice in a row', over_tank: 'More than the tanks hold', odometer_backwards: 'Odometer went back', ledger_flag: 'Ledger flag' } as const;
  return {
    data: {
      lookedAt: `${inPeriod} purchase${inPeriod === 1 ? '' : 's'} in the last ${days} days${unit ? ` for unit ${str(input.unit)}` : ''}`,
      rules: { twiceWithinHours: windowHours, unlessDrovenMiles: FUEL_DEFAULTS.minMilesBetween, tankGallons: FUEL_DEFAULTS.tankGallons },
      notChecked: 'Fueling far from the truck\'s GPS position: the ledger has the station city/state but no coordinates, and the TMS keeps only each truck\'s latest position, not its history at the time of the fill.',
      anomalies: found.slice(0, 30).map((a) => ({ unit: a.unitNumber, driver: a.driverName, rule: a.kind, level: a.level, at: eastern(a.at), gallons: a.gallons, place: a.place, detail: a.detail })),
      count: found.length,
    },
    cards: [
      table(`${found.length} fuel purchase${found.length === 1 ? '' : 's'} to check · last ${days} days`, ['Unit', 'When', 'Rule', 'Gallons', 'Where', 'Why'], found.map((a) => [a.unitNumber, eastern(a.at) ?? '—', word[a.kind], String(Math.round(a.gallons * 10) / 10), a.place, a.detail])),
      { kind: 'link', label: 'Open Fleet › Fuel', to: '/fleet/fuel' },
    ],
    issues: found.slice(0, 8).map((a) => ({ level: a.level, area: 'fuel', title: `Truck ${a.unitNumber}: ${word[a.kind].toLowerCase()}`, detail: `${eastern(a.at)} · ${a.detail}`, link: '/fleet/fuel' })),
  };
}

// ------------------------------------------------------------------------------------ late_risk / route_deviation

async function rolling(ctx: ActionContext, p: Principal): Promise<{ loads: StoredLoad[]; trucks: Map<string, TruckRecord> } | Refused> {
  if (!hasPermission(p, 'loads.view')) return refused('You do not have access to loads (loads.view).');
  const [loads, trucks] = await Promise.all([ctx.get(LoadsService).list(p, { includeDemo: false }), trucksOf(ctx, p)]);
  return {
    loads: loads.filter((l) => (ROLLING_STATUSES as readonly string[]).includes(l.status) && l.truckId && !l.cancellation),
    trucks: new Map(trucks.map((t) => [t.id, t])),
  };
}

async function lateRisk(ctx: ActionContext, p: Principal, input: Record<string, unknown>, now: Date): Promise<Result> {
  const r = await rolling(ctx, p);
  if ('refused' in r) return r;
  const nowIso = now.toISOString();
  const only = str(input.load_number).toUpperCase();
  const loads = only ? r.loads.filter((l) => l.loadNumber.toUpperCase() === only) : r.loads;
  if (only && loads.length === 0) return refused(`${only} is not on the road right now (or is not a load of this company).`);
  const rows = loads.map((load) => {
    const truck = r.trucks.get(load.truckId!);
    const rec = loadRec(load);
    const a = assessLateRisk({ nowIso, stops: stopsOf(load), position: positionOf(truck), placeOf: placeOfStop, manualEta: rec.manualEta ?? null });
    return { load, rec, truck, a };
  });
  const order = { late: 0, at_risk: 1, no_update: 2, on_time: 3 };
  rows.sort((x, y) => order[x.a.verdict.state] - order[y.a.verdict.state] || (y.a.verdict.minutesLate ?? -9999) - (x.a.verdict.minutesLate ?? -9999));
  const word = { late: 'Late', at_risk: 'At risk', on_time: 'On time', no_update: 'No update' } as const;
  const counts = { late: 0, at_risk: 0, on_time: 0, no_update: 0 };
  for (const x of rows) counts[x.a.verdict.state] += 1;
  const stopLabel = (s: StopFacts | null) => (s ? `${s.kind === 'pickup' ? 'Pickup' : 'Delivery'} ${s.city}, ${s.state}` : '—');
  const appt = (s: StopFacts | null) => {
    if (!s) return null;
    const at = s.appointmentNoWindow ? s.appointmentStartAt : (s.appointmentEndAt ?? s.appointmentStartAt);
    const local = inZone(at, s.timezone);
    return `${eastern(at)}${local ? ` (${local} local)` : ''}`;
  };
  const issues: BriefIssue[] = rows
    .filter((x) => x.a.verdict.state === 'late' || x.a.verdict.state === 'at_risk')
    .map((x) => ({
      level: x.a.verdict.state === 'late' ? ('urgent' as const) : ('warning' as const),
      area: 'late_risk',
      title: `${x.load.loadNumber} · truck ${x.truck?.unitNumber ?? x.rec.truckUnit ?? '—'}: ${word[x.a.verdict.state].toLowerCase()}${x.a.verdict.minutesLate !== null && x.a.verdict.minutesLate > 0 ? ` by ${minutesText(x.a.verdict.minutesLate)}` : ''}`,
      detail: `${stopLabel(x.a.nextStop)} by ${appt(x.a.nextStop)} · ${x.a.verdict.reason}${x.a.remainingMiles !== null ? ` · ${x.a.remainingMiles} mi to go` : ''}`,
      link: `/loads/${encodeURIComponent(x.load.loadNumber)}`,
    }));
  if (counts.no_update > 0) issues.push({ level: 'info', area: 'late_risk', title: `${counts.no_update} rolling load${counts.no_update === 1 ? '' : 's'} with no fresh position`, detail: 'The ETA cannot be judged without an ELD position from the last 15 minutes; a check call fills the gap.', link: '/loads' });
  return {
    data: {
      now: eastern(nowIso),
      rule: 'remaining miles = straight line x 1.18 from the last ELD position; ETA = now + miles / 47 mph (TMS average speed); at risk = ETA inside the 30-minute buffer before the appointment; a position older than 15 minutes is "no update".',
      ...(geoAvailable() ? {} : { warning: 'Stop coordinates (us-places.json) are not available on this server: distances cannot be measured.' }),
      counts,
      loads: rows.slice(0, 30).map((x) => ({
        load: x.load.loadNumber,
        truck: x.truck?.unitNumber ?? x.rec.truckUnit ?? null,
        driver: x.rec.driverName ?? x.truck?.currentDriverName ?? null,
        nextStop: stopLabel(x.a.nextStop),
        appointment: appt(x.a.nextStop),
        lastPosition: x.truck?.location ? `${x.truck.location.city}, ${x.truck.location.state} · ${eastern(x.truck.location.updatedAt)}` : null,
        positionAgeMinutes: x.a.tracking.ageMinutes,
        milesToGo: x.a.remainingMiles,
        eta: eastern(x.a.etaAt),
        verdict: x.a.verdict.state,
        minutesLate: x.a.verdict.minutesLate,
        minutesToAppointment: x.a.minutesToDeadline,
        reason: x.a.verdict.reason,
      })),
    },
    cards: [
      table(
        `${counts.late} late · ${counts.at_risk} at risk · ${counts.on_time} on time · ${counts.no_update} no update`,
        ['Load', 'Truck', 'Next stop', 'Appointment', 'Miles to go', 'ETA', 'Verdict'],
        rows.map((x) => [x.load.loadNumber, x.truck?.unitNumber ?? x.rec.truckUnit ?? '—', stopLabel(x.a.nextStop), appt(x.a.nextStop) ?? '—', x.a.remainingMiles === null ? '—' : String(x.a.remainingMiles), eastern(x.a.etaAt) ?? '—', `${word[x.a.verdict.state]}${x.a.verdict.minutesLate !== null && x.a.verdict.minutesLate > 0 ? ` +${minutesText(x.a.verdict.minutesLate)}` : ''}`]),
      ),
    ],
    issues,
  };
}

async function routeDeviation(ctx: ActionContext, p: Principal, input: Record<string, unknown>, now: Date): Promise<Result> {
  const r = await rolling(ctx, p);
  if ('refused' in r) return r;
  const threshold = int(input.threshold_miles, DEVIATION_DEFAULT_MILES, 10, 500);
  const nowIso = now.toISOString();
  const judged = r.loads.map((load) => {
    const truck = r.trucks.get(load.truckId!);
    return { load, truck, d: assessDeviation({ nowIso, stops: stopsOf(load), position: positionOf(truck), placeOf: placeOfStop, thresholdMiles: threshold, maxPositionAgeMinutes: 60 }) };
  });
  const off = judged.filter((x) => x.d.state === 'off_route').sort((a, b) => (b.d.offMiles ?? 0) - (a.d.offMiles ?? 0));
  const unknown = judged.filter((x) => x.d.state === 'unknown');
  return {
    data: {
      thresholdMiles: threshold,
      checked: judged.length - unknown.length,
      offRoute: off.map((x) => ({ load: x.load.loadNumber, truck: x.truck?.unitNumber ?? null, offMiles: x.d.offMiles, position: x.truck?.location ? `${x.truck.location.city}, ${x.truck.location.state} · ${eastern(x.truck.location.updatedAt)}` : null, reason: x.d.reason })),
      notJudged: unknown.slice(0, 15).map((x) => ({ load: x.load.loadNumber, reason: x.d.reason })),
      caveat: 'Straight line between stops, not the road. A hint to call the driver, not proof.',
    },
    cards: [
      table(`${off.length} truck${off.length === 1 ? '' : 's'} more than ${threshold} mi off the line between stops`, ['Load', 'Truck', 'Off by', 'Last position', 'Line'], off.map((x) => [x.load.loadNumber, x.truck?.unitNumber ?? '—', `${x.d.offMiles} mi`, x.truck?.location ? `${x.truck.location.city}, ${x.truck.location.state}` : '—', x.d.reason])),
    ],
    issues: off.map((x) => ({ level: (x.d.offMiles ?? 0) > threshold * 2 ? ('urgent' as const) : ('warning' as const), area: 'route', title: `Truck ${x.truck?.unitNumber ?? '—'} (${x.load.loadNumber}) is ${x.d.offMiles} mi off route`, detail: `${x.d.reason}. A straight line, not the road: call the driver.`, link: `/loads/${encodeURIComponent(x.load.loadNumber)}` })),
  };
}

// ------------------------------------------------------------------------------------ hos_status

function hosStatus(input: Record<string, unknown>): Result {
  const who = str(input.driver) || str(input.unit) || 'this driver';
  const text = `Hours of service are not synced into NeWay TMS: the Samsara, Motive and Five ELD connectors read vehicles, odometer and positions only. Check ${who}'s clock in the ELD itself.`;
  return { data: { synced: false, reason: text }, cards: [{ kind: 'notice', tone: 'info', text }], issues: [] };
}

// ------------------------------------------------------------------------------------ billing_missing_docs

async function billingMissingDocs(ctx: ActionContext, p: Principal, input: Record<string, unknown>, now: Date): Promise<Result> {
  if (!hasPermission(p, 'accounting.view')) return refused('You do not have access to billing (accounting.view).');
  const minDays = int(input.min_days, 0, 0, 365);
  const today = easternDay(now);
  const q = await ctx.get(InvoicesService).queue(p);
  const rows = q.rows
    .map((r) => {
      const docs = r.verdict.conditions.filter((c) => c.fix === 'documents');
      const delivered = r.load.deliveredAt ? easternDay(new Date(r.load.deliveredAt)) : null;
      return { r, docs, days: delivered ? dayDiff(delivered, today) : null };
    })
    .filter((x) => x.docs.length > 0 && (x.days ?? 0) >= minDays)
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
  const totalCents = rows.reduce((s, x) => s + Math.round(x.r.load.rate * 100), 0);
  const usd = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const old = rows.filter((x) => (x.days ?? 0) >= 7);
  const issues: BriefIssue[] = rows.slice(0, 6).map((x) => ({
    level: (x.days ?? 0) >= 7 ? ('urgent' as const) : ('warning' as const),
    area: 'billing',
    title: `${x.r.load.loadNumber} not invoiced${x.days !== null ? ` · ${x.days} day${x.days === 1 ? '' : 's'} since delivery` : ''}`,
    detail: x.docs.map((d) => d.message).join(' '),
    link: `/loads/${encodeURIComponent(x.r.load.loadNumber)}`,
  }));
  if (rows.length > 6) issues.push({ level: 'info', area: 'billing', title: `${rows.length} delivered loads wait on documents · ${usd(totalCents)}`, detail: `${old.length} of them for a week or more.`, link: '/accounting/invoices' });
  return {
    data: {
      count: rows.length,
      waitingRevenue: usd(totalCents),
      weekOrOlder: old.length,
      notChecked: 'Lumper receipts are not a billing condition in the TMS; only what the billing check requires is listed.',
      loads: rows.slice(0, 30).map((x) => ({ load: x.r.load.loadNumber, broker: x.r.load.brokerName ?? x.r.load.customerName, rate: usd(Math.round(x.r.load.rate * 100)), delivered: x.r.load.deliveredAt ? eastern(x.r.load.deliveredAt) : null, daysSinceDelivery: x.days, missing: x.docs.map((d) => d.message) })),
    },
    cards: [
      table(`${rows.length} delivered load${rows.length === 1 ? '' : 's'} waiting on documents · ${usd(totalCents)}`, ['Load', 'Broker', 'Rate', 'Days since delivery', 'What is missing'], rows.map((x) => [x.r.load.loadNumber, x.r.load.brokerName ?? x.r.load.customerName, usd(Math.round(x.r.load.rate * 100)), x.days === null ? '—' : String(x.days), x.docs.map((d) => d.message).join(' ')])),
      { kind: 'link', label: 'Open Invoices', to: '/accounting/invoices' },
    ],
    issues,
  };
}

// ------------------------------------------------------------------------------------ hiring_pipeline

async function hiringPipeline(ctx: ActionContext, p: Principal, input: Record<string, unknown>, now: Date): Promise<Result> {
  if (!hasPermission(p, 'recruiting.view')) return refused('You do not have access to Recruiting (recruiting.view).');
  const stuckDays = int(input.stuck_days, 3, 1, 60);
  const board = await ctx.get(RecruitService).board(p, RecruitBoardQuerySchema.parse({ scope: 'all' }));
  const cards: RecruitBoardCard[] = board.cards.filter((c) => c.column !== 'disqualified');
  const perColumn = Object.entries(RECRUIT_BOARD_COLUMN_LABELS)
    .filter(([key]) => key !== 'disqualified')
    .map(([key, l]) => ({ column: l.title, count: cards.filter((c) => c.column === key).length }));
  const ageDays = (c: RecruitBoardCard) => (c.stageSince ? Math.floor((now.getTime() - Date.parse(c.stageSince)) / 86_400_000) : null);
  const stuck = cards.filter((c) => (ageDays(c) ?? 0) >= stuckDays).sort((a, b) => (ageDays(b) ?? 0) - (ageDays(a) ?? 0));
  const waitingConsent = cards.filter((c) => c.consent === 'sent');
  const waitingSafety = cards.filter((c) => c.safety && ['pending', 'in_review', 'needs_follow_up', 'preparing'].includes(c.safety));
  const col = (c: RecruitBoardCard) => RECRUIT_BOARD_COLUMN_LABELS[c.column]?.title ?? c.column;
  const issues: BriefIssue[] = stuck.slice(0, 5).map((c) => ({
    level: (ageDays(c) ?? 0) >= stuckDays * 3 ? ('warning' as const) : ('info' as const),
    area: 'hiring',
    title: `${c.name}: ${ageDays(c)} days in ${col(c)}`,
    detail: `Next step: ${c.nextStep}${c.safety ? ` · Safety: ${CANDIDATE_SAFETY_LABELS[c.safety]}` : ''}`,
    link: '/hr/recruiting',
  }));
  if (stuck.length > 5) issues.push({ level: 'info', area: 'hiring', title: `${stuck.length} candidates stuck ${stuckDays}+ days`, detail: 'Open the Recruiting board, sorted by time in step.', link: '/hr/recruiting' });
  return {
    data: {
      scope: board.scope.label,
      active: cards.length,
      perColumn,
      stuckDays,
      stuck: stuck.slice(0, 20).map((c) => ({ candidate: c.name, column: col(c), daysInStep: ageDays(c), nextStep: c.nextStep, recruiter: c.recruiter?.name ?? null })),
      waitingOnConsent: waitingConsent.slice(0, 20).map((c) => c.name),
      waitingOnSafety: waitingSafety.slice(0, 20).map((c) => ({ candidate: c.name, safety: CANDIDATE_SAFETY_LABELS[c.safety!] })),
      note: 'MVR / PSP / drug test results are reviewed inside Safety; "waiting on Safety" is the candidate\'s Safety status.',
    },
    cards: [
      table(`Hiring pipeline · ${cards.length} active · ${stuck.length} stuck ${stuckDays}+ days`, ['Step', 'Candidates'], perColumn.map((c) => [c.column, String(c.count)])),
      ...(stuck.length ? [table('Stuck candidates', ['Candidate', 'Step', 'Days in step', 'Next step'], stuck.map((c) => [c.name, col(c), String(ageDays(c) ?? '—'), c.nextStep]), 15)] : []),
      { kind: 'link', label: 'Open Recruiting', to: '/hr/recruiting' },
    ],
    issues,
  };
}

// ------------------------------------------------------------------------------------ morning_brief

export interface BriefRun {
  generatedAt: string;
  today: string;
  issues: BriefIssue[];
  counts: { urgent: number; warning: number; info: number };
  /** Parts the person could not see (no permission) or that failed, with why. */
  skipped: Array<{ area: string; reason: string }>;
}

const BRIEF_PARTS: Array<{ area: string; run: (ctx: ActionContext, p: Principal, now: Date) => Promise<Result> }> = [
  { area: 'Late risk', run: (c, p, n) => lateRisk(c, p, {}, n) },
  { area: 'Compliance', run: (c, p, n) => expiringCompliance(c, p, { days: 30 }, n) },
  { area: 'Route deviation', run: (c, p, n) => routeDeviation(c, p, {}, n) },
  { area: 'Fuel', run: (c, p, n) => fuelAnomalies(c, p, { days: 7 }, n) },
  { area: 'Billing', run: (c, p, n) => billingMissingDocs(c, p, {}, n) },
  { area: 'Hiring', run: (c, p, n) => hiringPipeline(c, p, {}, n) },
];

/** Every check the person may run, their issues ranked. Shared by the tool and POST /ai/brief. */
export async function collectBrief(ctx: ActionContext, p: Principal, now: Date = clockOf(ctx)()): Promise<BriefRun> {
  const results = await Promise.all(
    BRIEF_PARTS.map(async (part) => {
      try {
        return { part, result: await part.run(ctx, p, now) };
      } catch (error) {
        return { part, result: refused(`Could not be read: ${error instanceof Error ? error.message : String(error)}`) };
      }
    }),
  );
  const all: BriefIssue[] = [];
  const skipped: BriefRun['skipped'] = [];
  for (const { part, result } of results) {
    if (isRefused(result)) skipped.push({ area: part.area, reason: result.refused });
    else all.push(...result.issues);
  }
  const issues = rankIssues(all, 25);
  return {
    generatedAt: now.toISOString(),
    today: easternDay(now),
    issues,
    counts: { urgent: all.filter((i) => i.level === 'urgent').length, warning: all.filter((i) => i.level === 'warning').length, info: all.filter((i) => i.level === 'info').length },
    skipped,
  };
}

// ------------------------------------------------------------------------------------ the runner

export async function runInsightTool(ctx: ActionContext, principal: Principal, name: string, raw: unknown): Promise<ToolOutcome> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const now = clockOf(ctx)();
  let result: Result;
  switch (name) {
    case 'truck_status':
      result = await truckStatus(ctx, principal, input, now);
      break;
    case 'expiring_compliance':
      result = await expiringCompliance(ctx, principal, input, now);
      break;
    case 'fuel_anomalies':
      result = await fuelAnomalies(ctx, principal, input, now);
      break;
    case 'late_risk':
      result = await lateRisk(ctx, principal, input, now);
      break;
    case 'route_deviation':
      result = await routeDeviation(ctx, principal, input, now);
      break;
    case 'hos_status':
      result = hosStatus(input);
      break;
    case 'billing_missing_docs':
      result = await billingMissingDocs(ctx, principal, input, now);
      break;
    case 'hiring_pipeline':
      result = await hiringPipeline(ctx, principal, input, now);
      break;
    case 'morning_brief': {
      const brief = await collectBrief(ctx, principal, now);
      const word = { urgent: 'Urgent', warning: 'Warning', info: 'Info' } as const;
      result = {
        data: { ...brief, generatedAt: eastern(brief.generatedAt), note: 'Write it as a short brief: urgent first, each with its word (Urgent / Warning / Info). Do not invent anything not listed.' },
        cards: [
          table(`Morning brief · ${brief.counts.urgent} urgent · ${brief.counts.warning} warning · ${brief.counts.info} info`, ['Level', 'Issue', 'Detail'], brief.issues.map((i) => [word[i.level], i.title, i.detail])),
          ...(brief.skipped.length ? [{ kind: 'notice' as const, tone: 'info' as const, text: `Not included: ${brief.skipped.map((s) => `${s.area} (${s.reason})`).join('; ')}` }] : []),
        ],
        issues: brief.issues,
      };
      break;
    }
    default:
      result = refused(`There is no tool called ${name}.`);
  }
  if (isRefused(result)) return { content: JSON.stringify({ error: result.refused }), cards: [{ kind: 'notice', tone: 'warning', text: result.refused }], isError: true };
  return { content: JSON.stringify(result.data), cards: result.cards };
}
