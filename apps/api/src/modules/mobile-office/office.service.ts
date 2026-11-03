import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import {
  MESSAGE_DEPARTMENT_LABEL,
  OFFICE_APPROVAL_KINDS,
  OFFICE_ROLE_PERMISSIONS,
  OFFICE_ROLES,
  PtoQuerySchema,
  RosterQuerySchema,
  currentDocuments,
  deadlineOf,
  ptiWeekStartOf,
  queuesFor,
  type OfficeApprovalItem,
  type OfficeApprovalKind,
  type OfficeApprovals,
  type OfficeAttentionItem,
  type OfficeDispatch,
  type OfficeDispatchRow,
  type OfficeDispatchTab,
  type OfficeMe,
  type OfficeMyWork,
  type OfficeOwnerOverview,
  type OfficeRole,
  type OfficeSection,
  type OfficeTask,
  type OfficeToday,
  type OfficeWorkspace,
} from '@neway/shared';
import { isFeatureEnabled } from '../../common/flags/flags';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { memberships } from '../../database/schema/admin';
import { safetyTasks } from '../../database/schema/accidents-v2';
import { workOrders } from '../../database/schema/fleet';
import { attendanceEntries } from '../../database/schema/hr';
import { fleetBreakdowns } from '../../database/schema/mobile';
import { employees } from '../../database/schema/people';
import { driverVacations, drivers } from '../../database/schema/roster';
import { InvoicesService } from '../accounting/invoices.service';
import { ReimbursementsService } from '../accounting/reimbursements.service';
import { SettlementsService } from '../accounting/settlements.service';
import { AuthService } from '../auth/auth.service';
import { ComplianceService } from '../compliance/compliance.service';
import { PtiService } from '../fleet/pti.service';
import { WorkOrdersService } from '../fleet/work-orders.service';
import { MyLeadsService } from '../hiring/my-leads.service';
import { PtoService } from '../hr/pto.service';
import { LoadProblemsService } from '../loads/load-problems.service';
import { LoadsService } from '../loads/loads.service';
import { MessagesService } from '../messages/messages.service';
import { companyDay } from '../mobile/driver-context.service';
import { AnalyticsService } from '../reports/analytics.service';
import { DriversService } from '../roster/drivers.service';
import { maskDriverPage } from '../roster/driver-pii';
import { DRIVER_PICKER_PERMISSIONS, UNIT_PICKER_PERMISSIONS } from '../roster/roster-access';
import { TrucksService } from '../roster/trucks.service';
import { AccidentsService } from '../safety/accidents.service';
import { AccidentsV2Service } from '../safety/accidents-v2/accidents-v2.service';
import { StateService } from '../state/state.service';

const forbidden = (detail: string) => new AppError({ status: 403, title: 'Forbidden', detail });
const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

const IN_PROGRESS = new Set(['dispatched', 'at_pickup', 'loading', 'loaded', 'in_transit', 'at_delivery', 'unloading']);
const ACTIVE = new Set(['booked', 'assigned', ...IN_PROGRESS]);
const NOT_PICKED_UP = new Set(['assigned', 'dispatched', 'at_pickup']);
const DOWN_TRUCK = new Set(['in_shop', 'out_of_service', 'maintenance', 'accident']);
const MOVING_TRUCK = new Set(['active', 'driving']);
const POD_LOOKBACK_DAYS = 14;
const ITEM_CAP = 25;

type AnyLoad = Awaited<ReturnType<LoadsService['list']>>[number];

const any = (p: Principal, codes: readonly string[]) => codes.some((c) => hasPermission(p, c));

/**
 * The office app's aggregation endpoints (mobile M4, docs/mobile/API.md §9).
 *
 * Every block reads through the service that owns the records (loads, load problems, trucks,
 * PTI, work orders, compliance, accidents, billing, reimbursements, settlements, PTO, my leads,
 * analytics) and is present only when the caller holds the permission that service's own route
 * asks for. Feature-flagged areas are skipped while their flag is off, as their routes would 404.
 * No money is computed here: the owner's numbers are AnalyticsService.executive as it stands.
 */
@Injectable()
export class OfficeService {
  private readonly logger = new Logger(OfficeService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly loads: LoadsService,
    private readonly problems: LoadProblemsService,
    private readonly trucks: TrucksService,
    private readonly drivers: DriversService,
    private readonly pti: PtiService,
    private readonly workOrders: WorkOrdersService,
    private readonly compliance: ComplianceService,
    private readonly accidents: AccidentsService,
    private readonly accidentsV2: AccidentsV2Service,
    private readonly invoices: InvoicesService,
    private readonly reimbursements: ReimbursementsService,
    private readonly settlements: SettlementsService,
    private readonly pto: PtoService,
    private readonly myLeads: MyLeadsService,
    private readonly analytics: AnalyticsService,
    private readonly state: StateService,
    private readonly messages: MessagesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private now(): Date {
    return this.loads.clock();
  }

  private today(principal: Principal): string {
    return companyDay(principal.companyTimezone || 'America/New_York', this.now());
  }

  /** Office endpoints are for office accounts; a driver login has its own app. */
  assertOffice(principal: Principal): void {
    if (principal.driverId) throw forbidden('Drivers use the driver app.');
  }

  rolesOf(principal: Principal): OfficeRole[] {
    return OFFICE_ROLES.filter((r) => any(principal, OFFICE_ROLE_PERMISSIONS[r]));
  }

  // ----------------------------------------------------------------------------------- me

  async me(principal: Principal): Promise<OfficeMe> {
    this.assertOffice(principal);
    if (!principal.membershipId) throw forbidden('Sign in first.');
    const account = await this.auth.account(principal.membershipId);
    const todayRoles = this.rolesOf(principal);
    const departments = this.messages.departmentsOf(principal).map((d) => ({ key: d, label: MESSAGE_DEPARTMENT_LABEL[d] }));
    const workspaces: OfficeWorkspace[] = ['today', 'my_work'];
    if (any(principal, ['loads.view', ...UNIT_PICKER_PERMISSIONS, ...DRIVER_PICKER_PERMISSIONS])) workspaces.push('dispatch');
    if (departments.length > 0) workspaces.push('inbox');
    if (any(principal, ['accounting.edit', 'pto.approve', 'accidents.fleet', 'drivers.edit', 'dispatch.manage'])) workspaces.push('approvals');
    if (todayRoles.includes('safety')) workspaces.push('safety');
    if (todayRoles.includes('fleet')) workspaces.push('fleet');
    if (todayRoles.includes('accounting')) workspaces.push('accounting');
    if (todayRoles.includes('recruiting')) workspaces.push('recruiting');
    if (todayRoles.includes('owner')) workspaces.push('owner');
    return {
      user: { id: account.userId, name: account.name, email: account.email },
      company: { id: account.companyId, name: account.companyName ?? null },
      companies: account.companies ?? [],
      roles: account.roles,
      isOwner: account.isOwner,
      todayRoles,
      departments,
      workspaces,
      serverNow: this.now().toISOString(),
      today: this.today(principal),
    };
  }

  // -------------------------------------------------------------------------------- today

  async todayView(principal: Principal, requested: string | undefined, period: { preset?: string; from?: string; to?: string }): Promise<OfficeToday> {
    this.assertOffice(principal);
    const available = this.rolesOf(principal);
    let role: OfficeRole;
    if (requested) {
      if (!(OFFICE_ROLES as readonly string[]).includes(requested)) throw unprocessable(`role must be one of ${OFFICE_ROLES.join(', ')}`);
      role = requested as OfficeRole;
      if (!available.includes(role)) throw forbidden(`The ${role} view needs ${OFFICE_ROLE_PERMISSIONS[role].join(' or ')}.`);
    } else {
      if (available.length === 0) throw forbidden('Your roles open no Today view.');
      role = available[0]!;
    }
    const omitted: Array<{ key: string; reason: string }> = [];
    const sections: OfficeSection[] = [];
    let owner: OfficeOwnerOverview | null = null;
    const add = (s: OfficeSection | null) => {
      if (s) sections.push(s);
    };
    if (role === 'dispatcher') add(await this.dispatchSection(principal, omitted));
    if (role === 'safety') add(await this.safetySection(principal, omitted));
    if (role === 'fleet') add(await this.fleetSection(principal, omitted));
    if (role === 'accounting') add(await this.accountingSection(principal, omitted));
    if (role === 'recruiting') add(await this.recruitingSection(principal, omitted));
    if (role === 'owner') {
      owner = await this.ownerOverview(principal, period, omitted);
      // Critical tasks: the critical lines of every area this caller may see.
      const others: OfficeSection[] = [];
      if (hasPermission(principal, 'loads.view')) others.push(await this.dispatchSection(principal, []));
      if (any(principal, OFFICE_ROLE_PERMISSIONS.safety)) {
        const s = await this.safetySection(principal, []);
        if (s) others.push(s);
      }
      if (hasPermission(principal, 'maintenance.view')) {
        const s = await this.fleetSection(principal, []);
        if (s) others.push(s);
      }
      const critical = others.flatMap((s) => s.items).filter((i) => i.severity === 'critical');
      sections.push({ key: 'critical', title: 'Critical tasks', counters: [{ key: 'critical', label: 'Critical tasks', value: critical.length }], items: critical.slice(0, ITEM_CAP) });
    }
    const attention = sections.flatMap((s) => s.items).filter((i) => i.severity !== 'info');
    return { role, availableRoles: available, serverNow: this.now().toISOString(), today: this.today(principal), attention, sections, owner, omitted };
  }

  private async liveLoads(principal: Principal): Promise<AnyLoad[]> {
    return this.loads.list(principal, { includeDemo: false });
  }

  async dispatchSection(principal: Principal, omitted: Array<{ key: string; reason: string }>): Promise<OfficeSection> {
    const now = this.now();
    const today = this.today(principal);
    const tz = principal.companyTimezone || 'America/New_York';
    const all = await this.liveLoads(principal);
    const items: OfficeAttentionItem[] = [];
    const lane = (l: AnyLoad) => {
      const stops = [...(l.stops ?? [])].sort((a, b) => a.sequence - b.sequence);
      const first = stops.find((s) => s.kind === 'pickup') ?? stops[0];
      const last = [...stops].reverse().find((s) => s.kind === 'delivery') ?? stops[stops.length - 1];
      return first && last ? `${first.city}, ${first.state} → ${last.city}, ${last.state}` : null;
    };

    for (const load of all) {
      if (!NOT_PICKED_UP.has(load.status)) continue;
      const pickup = [...(load.stops ?? [])].sort((a, b) => a.sequence - b.sequence).find((s) => s.kind === 'pickup');
      if (!pickup || pickup.arrivedAt) continue;
      const deadline = deadlineOf(pickup);
      if (deadline !== null && deadline < now.getTime()) {
        items.push({
          kind: 'late_pickup',
          label: 'Late pickup',
          severity: 'critical',
          title: `Load ${load.loadNumber}`,
          subtitle: lane(load),
          since: new Date(deadline).toISOString(),
          target: { type: 'load', id: load.id },
        });
      }
    }
    const lookback = now.getTime() - POD_LOOKBACK_DAYS * 86400000;
    for (const load of all) {
      if (load.status !== 'delivered' && load.status !== 'closed') continue;
      const deliveredAt = typeof load.deliveredAt === 'string' ? Date.parse(load.deliveredAt) : NaN;
      if (Number.isFinite(deliveredAt) && deliveredAt < lookback) continue;
      const hasPod = currentDocuments(load.documents ?? []).some((d) => d.type === 'pod' && (d as { review?: string }).review !== 'rejected');
      if (!hasPod) {
        items.push({
          kind: 'pod_missing',
          label: 'POD missing',
          severity: 'warning',
          title: `Load ${load.loadNumber}`,
          subtitle: lane(load),
          since: Number.isFinite(deliveredAt) ? new Date(deliveredAt).toISOString() : null,
          target: { type: 'load', id: load.id },
        });
      }
    }
    for (const problem of await this.problems.list(principal, { open: true })) {
      items.push({
        kind: `problem_${problem.kind}`,
        label: problem.kind === 'breakdown' ? 'Breakdown' : 'Load problem',
        severity: problem.kind === 'breakdown' || problem.kind === 'late' ? 'critical' : 'warning',
        title: `Load ${problem.loadNumber}`,
        subtitle: problem.note || null,
        since: problem.openedAt,
        target: { type: 'load', id: problem.loadId },
      });
    }
    for (const b of await this.openBreakdowns(principal)) {
      items.push({
        kind: 'breakdown',
        label: 'Breakdown',
        severity: 'critical',
        title: b.unit ? `Unit ${b.unit}` : `Breakdown ${b.number}`,
        subtitle: b.location,
        since: b.createdAt,
        target: { type: 'breakdown', id: b.id },
      });
    }

    const inProgress = all.filter((l) => IN_PROGRESS.has(l.status)).length;
    const deliveringToday = all.filter((l) => {
      if (!ACTIVE.has(l.status)) return false;
      const last = [...(l.stops ?? [])].sort((a, b) => b.sequence - a.sequence).find((s) => s.kind === 'delivery');
      return Boolean(last?.appointmentStartAt) && companyDay(tz, new Date(last!.appointmentStartAt!)) === today;
    }).length;
    const counters = [
      { key: 'loads_in_progress', label: 'Loads in progress', value: inProgress },
      { key: 'delivering_today', label: 'Delivering today', value: deliveringToday },
    ];
    if (any(principal, UNIT_PICKER_PERMISSIONS)) {
      const trucks = await this.allTrucks(principal);
      counters.push({ key: 'available_trucks', label: 'Available trucks', value: trucks.filter((t) => t.status === 'available').length });
    } else omitted.push({ key: 'available_trucks', reason: 'Needs trucks.view (or another unit picker permission).' });
    items.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || (a.since ?? '').localeCompare(b.since ?? ''));
    return { key: 'dispatch', title: 'Dispatch', counters, items: items.slice(0, ITEM_CAP) };
  }

  /** Open driver-reported breakdowns (0081 table, written by the M3 breakdown flow); none when absent. */
  private async openBreakdowns(principal: Principal): Promise<Array<{ id: string; number: string; unit: string | null; location: string | null; createdAt: string; status: string }>> {
    try {
      const rows = await this.db
        .select()
        .from(fleetBreakdowns)
        .where(and(eq(fleetBreakdowns.companyId, principal.companyId), ne(fleetBreakdowns.status, 'closed'), isNull(fleetBreakdowns.voidedAt)))
        .limit(50);
      const truckIds = rows.map((r) => r.truckId).filter((t): t is string => Boolean(t));
      const units = truckIds.length ? (await this.allTrucks(principal, true)).filter((t) => truckIds.includes(t.id)) : [];
      return rows.map((r) => {
        const loc = r.location as { text?: string } | null;
        return {
          id: r.id,
          number: r.number,
          unit: units.find((t) => t.id === r.truckId)?.unitNumber ?? null,
          location: loc?.text ?? null,
          createdAt: r.createdAt.toISOString(),
          status: r.status,
        };
      });
    } catch (error) {
      this.logger.warn(`Breakdowns unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async allTrucks(principal: Principal, skipCheck = false) {
    if (!skipCheck && !any(principal, UNIT_PICKER_PERMISSIONS)) return [];
    const page = await this.trucks.list(principal, RosterQuerySchema.parse({ page: 1, pageSize: 1000 }));
    return page.data;
  }

  async safetySection(principal: Principal, omitted: Array<{ key: string; reason: string }>): Promise<OfficeSection | null> {
    const counters: OfficeSection['counters'] = [];
    const items: OfficeAttentionItem[] = [];
    // PTIs awaiting review: the PTI board's own "Awaiting review" queue.
    if (!isFeatureEnabled('fleet_v2')) omitted.push({ key: 'pti_review', reason: 'The PTI board (fleet_v2) is off.' });
    else if (!any(principal, ['maintenance.view', 'safety.view'])) omitted.push({ key: 'pti_review', reason: 'Needs maintenance.view or safety.view.' });
    else {
      const today = this.today(principal);
      const board = await this.pti.board(principal, ptiWeekStartOf(today), today);
      counters.push({ key: 'pti_awaiting_review', label: 'Awaiting PTI review', value: board.queues.review });
      for (const row of board.rows.filter((r) => queuesFor(r).includes('review')).slice(0, ITEM_CAP)) {
        items.push({
          kind: 'pti_review',
          label: 'Awaiting review',
          severity: 'warning',
          title: `${row.inspection.driverName ?? 'Driver'} · Unit ${row.inspection.unitNumber}`,
          subtitle: row.inspection.receivedAt ? `Submitted ${row.inspection.receivedAt}` : null,
          since: row.inspection.receivedAt ?? null,
          target: { type: 'pti', id: row.inspection.id },
        });
      }
    }
    // Driver documents expiring within 30 days (the compliance overview's own rule).
    if (!hasPermission(principal, 'compliance.view')) omitted.push({ key: 'expiring_documents', reason: 'Needs compliance.view.' });
    else {
      const today = this.today(principal);
      const horizon = addDays(today, 30);
      const expiring = (await this.compliance.listItems(principal, { scope: 'driver' })).filter(
        (i) => !i.notApplicable && !(i.waivedUntil && i.waivedUntil >= today) && i.expiresOn !== null && i.expiresOn !== undefined && i.expiresOn <= horizon,
      );
      counters.push({ key: 'expiring_documents', label: 'Expiring documents', value: expiring.length });
      for (const i of expiring.sort((a, b) => String(a.expiresOn).localeCompare(String(b.expiresOn))).slice(0, ITEM_CAP)) {
        items.push({
          kind: 'document_expiring',
          label: i.expiresOn! < today ? 'Expired' : 'Expires soon',
          severity: i.expiresOn! < today ? 'critical' : 'warning',
          title: `${i.requirementCode} · ${i.entityLabel ?? i.entityId}`,
          subtitle: `Expires ${i.expiresOn}`,
          since: i.expiresOn ?? null,
          target: { type: 'driver', id: i.entityId },
        });
      }
    }
    // Open accidents / incidents: accidents v2 when it is live, else the legacy list.
    if (isFeatureEnabled('accidents_v2') && hasPermission(principal, 'accidents.view')) {
      const counts = await this.accidentsV2.counts(principal);
      counters.push({ key: 'open_incidents', label: 'Open incidents', value: counts.openCases });
      if (counts.urgent > 0) items.push({ kind: 'accident_urgent', label: 'Urgent', severity: 'critical', title: `${counts.urgent} urgent accident case(s)`, subtitle: null, since: null, target: { type: 'accidents', id: 'urgent' } });
    } else if (isFeatureEnabled('safety_v2') && hasPermission(principal, 'safety.view')) {
      const open = (await this.accidents.list(principal)).filter((a) => !a.closedAt);
      counters.push({ key: 'open_incidents', label: 'Open incidents', value: open.length });
    } else omitted.push({ key: 'open_incidents', reason: 'Needs accidents.view (accidents_v2) or safety.view (safety_v2).' });
    if (counters.length === 0) return null;
    items.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
    return { key: 'safety', title: 'Safety', counters, items: items.slice(0, ITEM_CAP) };
  }

  async fleetSection(principal: Principal, omitted: Array<{ key: string; reason: string }>): Promise<OfficeSection | null> {
    if (!hasPermission(principal, 'maintenance.view')) {
      omitted.push({ key: 'fleet', reason: 'Needs maintenance.view.' });
      return null;
    }
    const counters: OfficeSection['counters'] = [];
    const items: OfficeAttentionItem[] = [];
    if (!isFeatureEnabled('fleet_v2')) omitted.push({ key: 'work_orders', reason: 'Work orders and PTI defects (fleet_v2) are off.' });
    else {
      const inShop = await this.workOrders.list(principal, { status: 'in_shop' });
      counters.push({ key: 'in_shop', label: 'In shop', value: inShop.length });
      for (const wo of inShop.slice(0, ITEM_CAP)) {
        const w = wo as { id: string; number?: string; unitNumber?: string; title?: string; shopInAt?: string | null };
        items.push({ kind: 'work_order_in_shop', label: 'In shop', severity: 'info', title: `Unit ${w.unitNumber ?? ''}`.trim(), subtitle: w.title ?? w.number ?? null, since: w.shopInAt ?? null, target: { type: 'work_order', id: w.id } });
      }
      const defects = await this.pti.listDefects(principal, { open: true });
      counters.push({ key: 'open_defects', label: 'Open PTI defects', value: defects.length });
      for (const d of defects.filter((x) => x.severity === 'oos_risk' || x.severity === 'replace_now').slice(0, ITEM_CAP)) {
        items.push({ kind: 'defect_oos', label: 'Defect: act now', severity: 'critical', title: `Unit ${d.unitNumber}`, subtitle: d.componentName ?? d.description, since: d.createdAt, target: { type: 'pti_defect', id: d.id } });
      }
    }
    const trucks = await this.allTrucks(principal, true);
    const down = trucks.filter((t) => DOWN_TRUCK.has(t.status));
    counters.push({ key: 'down_units', label: 'Down units', value: down.length });
    const breakdowns = await this.openBreakdowns(principal);
    counters.push({ key: 'open_breakdowns', label: 'Open breakdowns', value: breakdowns.length });
    for (const b of breakdowns.slice(0, ITEM_CAP)) {
      items.push({ kind: 'breakdown', label: 'Breakdown', severity: 'critical', title: b.unit ? `Unit ${b.unit}` : `Breakdown ${b.number}`, subtitle: b.location, since: b.createdAt, target: { type: 'breakdown', id: b.id } });
    }
    items.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
    return { key: 'fleet', title: 'Fleet', counters, items: items.slice(0, ITEM_CAP) };
  }

  async accountingSection(principal: Principal, omitted: Array<{ key: string; reason: string }>): Promise<OfficeSection | null> {
    if (!hasPermission(principal, 'accounting.view')) {
      omitted.push({ key: 'accounting', reason: 'Needs accounting.view.' });
      return null;
    }
    const [queue, pending, statements] = await Promise.all([
      this.invoices.queue(principal),
      this.reimbursements.list(principal, { status: 'pending' }),
      this.settlements.statements(principal),
    ]);
    const ready = statements.filter((s) => s.status === 'review');
    const items: OfficeAttentionItem[] = [];
    for (const row of queue.rows.filter((r) => r.verdict.queue === 'needs_review').slice(0, ITEM_CAP)) {
      items.push({ kind: 'billing_needs_review', label: 'Documents need review', severity: 'warning', title: `Load ${row.load.loadNumber}`, subtitle: row.load.driverName ?? null, since: null, target: { type: 'load', id: row.load.id } });
    }
    for (const e of pending.slice(0, ITEM_CAP)) {
      items.push({ kind: 'reimbursement_pending', label: 'Reimbursement', severity: 'info', title: e.description || e.categoryCode, subtitle: e.reimbursement?.payerDriverName ?? e.driverName ?? null, since: e.reimbursement?.submittedAt ?? null, target: { type: 'reimbursement', id: e.id } });
    }
    return {
      key: 'accounting',
      title: 'Accounting',
      counters: [
        { key: 'billing_needs_review', label: 'Documents in review queue', value: queue.counts.needs_review ?? 0 },
        { key: 'billing_needs_documents', label: 'Loads missing documents', value: queue.counts.needs_documents ?? 0 },
        { key: 'reimbursements_pending', label: 'Reimbursements', value: pending.length },
        { key: 'settlements_ready', label: 'Settlements ready', value: ready.length },
      ],
      items,
    };
  }

  async recruitingSection(principal: Principal, omitted: Array<{ key: string; reason: string }>): Promise<OfficeSection | null> {
    if (!hasPermission(principal, 'recruiting.view')) {
      omitted.push({ key: 'recruiting', reason: 'Needs recruiting.view.' });
      return null;
    }
    const mine = await this.myLeads.list(principal, {});
    if (!mine.recruiter) omitted.push({ key: 'my_leads', reason: 'This account is not linked to an employee, so it has no leads of its own.' });
    const fresh = mine.leads.filter((l) => l.status === 'new');
    return {
      key: 'recruiting',
      title: 'Recruiting',
      counters: [
        { key: 'my_leads', label: 'My leads', value: mine.leads.filter((l) => l.status !== 'dead' && l.status !== 'converted').length },
        { key: 'new_leads', label: 'New, not contacted', value: fresh.length },
      ],
      items: fresh.slice(0, ITEM_CAP).map((l) => ({ kind: 'lead_new', label: 'New lead', severity: 'warning' as const, title: l.name, subtitle: l.leadNumber, since: l.createdAt, target: { type: 'lead', id: l.id } })),
    };
  }

  /** Revenue / expenses / net exactly as AnalyticsService.executive answers for the period. */
  async ownerOverview(principal: Principal, period: { preset?: string; from?: string; to?: string }, omitted: Array<{ key: string; reason: string }>): Promise<OfficeOwnerOverview | null> {
    if (!hasPermission(principal, 'analytics.view')) {
      omitted.push({ key: 'owner', reason: 'Needs analytics.view.' });
      return null;
    }
    const preset = period.preset || 'this_week';
    const exec = await this.analytics.executive(principal, preset, period.from, period.to);
    const metric = (key: string) => exec.metrics.find((m) => m.key === key)?.current ?? null;
    const estimated = exec.notes.some((n) => /estimate/i.test(n));
    const basis = estimated ? ('includes_estimates' as const) : ('posted' as const);
    let fleet: OfficeOwnerOverview['fleet'] = null;
    if (any(principal, UNIT_PICKER_PERMISSIONS)) {
      const trucks = await this.allTrucks(principal);
      fleet = {
        active: trucks.filter((t) => MOVING_TRUCK.has(t.status) || Boolean(t.currentDriverId) && !DOWN_TRUCK.has(t.status)).length,
        inShop: trucks.filter((t) => t.status === 'in_shop' || t.status === 'maintenance').length,
        outOfService: trucks.filter((t) => t.status === 'out_of_service' || t.status === 'accident').length,
        total: trucks.length,
      };
    } else omitted.push({ key: 'fleet_status', reason: 'Needs trucks.view (or another unit picker permission).' });
    const range = exec.range as { from: string; to: string; label?: string };
    return {
      period: { preset, from: range.from, to: range.to, label: range.label ?? `${range.from} – ${range.to}` },
      revenue: { amount: metric('gross'), basis: 'posted' },
      expenses: { amount: metric('cost'), basis },
      net: { amount: exec.profitHidden ? null : metric('profit'), basis, hiddenReason: exec.profitHidden?.reason ?? null },
      notes: exec.notes,
      source: exec.source,
      fleet,
    };
  }

  // ----------------------------------------------------------------------------- dispatch

  async dispatch(principal: Principal, tabRaw: string | undefined, qRaw: string | undefined): Promise<OfficeDispatch> {
    this.assertOffice(principal);
    const tab = (tabRaw || 'trucks') as OfficeDispatchTab;
    const q = (qRaw ?? '').trim().toLowerCase();
    const loads = hasPermission(principal, 'loads.view') ? await this.liveLoads(principal) : [];
    const currentLoad = (pred: (l: AnyLoad) => boolean) => loads.find((l) => ACTIVE.has(l.status) && pred(l)) ?? null;
    const laneOf = (l: AnyLoad | null) => {
      if (!l) return null;
      const stops = [...(l.stops ?? [])].sort((a, b) => a.sequence - b.sequence);
      const a = stops[0];
      const b = stops[stops.length - 1];
      return a && b ? `${a.city}, ${a.state} → ${b.city}, ${b.state}` : null;
    };
    const active: OfficeDispatchRow[] = [];
    const unassigned: OfficeDispatchRow[] = [];
    if (tab === 'trucks') {
      if (!any(principal, UNIT_PICKER_PERMISSIONS)) throw forbidden('The trucks list needs trucks.view (or another unit picker permission).');
      const page = await this.trucks.list(principal, RosterQuerySchema.parse({ page: 1, pageSize: 1000, ...(q ? { search: q } : {}) }));
      for (const t of page.data) {
        const load = currentLoad((l) => l.truckId === t.id);
        const row: OfficeDispatchRow = { id: t.id, title: `Unit ${t.unitNumber}`, subtitle: t.currentDriverName ?? null, status: t.status, lane: laneOf(load), loadId: load?.id ?? null, loadNumber: load?.loadNumber ?? null };
        (t.currentDriverId ? active : unassigned).push(row);
      }
    } else if (tab === 'drivers') {
      if (!any(principal, DRIVER_PICKER_PERMISSIONS)) throw forbidden('The drivers list needs drivers.view (or another driver picker permission).');
      const page = maskDriverPage(principal, await this.drivers.list(principal, RosterQuerySchema.parse({ page: 1, pageSize: 1000, ...(q ? { search: q } : {}) })));
      for (const d of page.data) {
        const load = currentLoad((l) => l.driverId === d.id);
        const row: OfficeDispatchRow = {
          id: d.id,
          title: `${d.firstName} ${d.lastName}`.trim(),
          subtitle: d.currentTruckUnit ? `Unit ${d.currentTruckUnit}` : null,
          status: d.status,
          lane: laneOf(load),
          loadId: load?.id ?? null,
          loadNumber: load?.loadNumber ?? null,
        };
        (d.currentTruckId ? active : unassigned).push(row);
      }
    } else if (tab === 'loads') {
      if (!hasPermission(principal, 'loads.view')) throw forbidden('The loads list needs loads.view.');
      const match = (l: AnyLoad) =>
        !q || [l.loadNumber, l.brokerReference, l.driverName, l.truckUnit, l.customerName].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
      for (const l of loads.filter((x) => ACTIVE.has(x.status) && match(x)).slice(0, 500)) {
        const row: OfficeDispatchRow = {
          id: l.id,
          title: `Load ${l.loadNumber}`,
          subtitle: [l.driverName, l.truckUnit ? `Unit ${l.truckUnit}` : null].filter(Boolean).join(' · ') || null,
          status: l.status,
          lane: laneOf(l),
          loadId: l.id,
          loadNumber: l.loadNumber,
        };
        (l.driverId ? active : unassigned).push(row);
      }
    } else throw unprocessable('tab must be one of trucks, drivers, loads');
    return { tab, q, active, unassigned, counts: { active: active.length, unassigned: unassigned.length } };
  }

  // ---------------------------------------------------------------------------- approvals

  private approvalKinds(principal: Principal): Array<{ kind: OfficeApprovalKind; ok: boolean; reason: string }> {
    return [
      { kind: 'expenses', ok: hasPermission(principal, 'accounting.edit') && hasPermission(principal, 'accounting.view'), reason: 'Needs accounting.edit.' },
      { kind: 'pto', ok: hasPermission(principal, 'pto.approve') && hasPermission(principal, 'pto.view'), reason: 'Needs pto.approve.' },
      { kind: 'repairs', ok: isFeatureEnabled('accidents_v2') && hasPermission(principal, 'accidents.fleet'), reason: 'Accident repair estimates need accidents.fleet (accidents_v2). Ordinary repairs have no approval step (Fleet rule: entered after the job).' },
      { kind: 'vacations', ok: hasPermission(principal, 'drivers.edit') || hasPermission(principal, 'dispatch.manage'), reason: 'Needs drivers.edit or dispatch.manage.' },
    ];
  }

  async approvals(principal: Principal, kindRaw: string | undefined): Promise<OfficeApprovals> {
    this.assertOffice(principal);
    if (kindRaw && !(OFFICE_APPROVAL_KINDS as readonly string[]).includes(kindRaw)) throw unprocessable(`kind must be one of ${OFFICE_APPROVAL_KINDS.join(', ')}`);
    const kinds = this.approvalKinds(principal);
    const omitted = kinds.filter((k) => !k.ok).map((k) => ({ key: k.kind, reason: k.reason }));
    const allowed = kinds.filter((k) => k.ok).map((k) => k.kind);
    if (kindRaw && !allowed.includes(kindRaw as OfficeApprovalKind)) throw forbidden(kinds.find((k) => k.kind === kindRaw)!.reason);
    if (allowed.length === 0) throw forbidden('You approve nothing here.');
    const lists = new Map<OfficeApprovalKind, OfficeApprovalItem[]>();
    for (const k of allowed) lists.set(k, await this.approvalItems(principal, k));
    const labels: Record<OfficeApprovalKind, string> = { expenses: 'Expenses', pto: 'PTO', repairs: 'Repairs', vacations: 'Vacations' };
    const kind = (kindRaw as OfficeApprovalKind | undefined) ?? allowed[0]!;
    return {
      kind,
      tabs: allowed.map((k) => ({ kind: k, label: labels[k], count: lists.get(k)!.length })),
      items: lists.get(kind) ?? [],
      omitted,
    };
  }

  private async approvalItems(principal: Principal, kind: OfficeApprovalKind): Promise<OfficeApprovalItem[]> {
    if (kind === 'expenses') {
      const rows = await this.reimbursements.list(principal, { status: 'pending' });
      return rows.map((e) => ({
        id: e.id,
        kind,
        title: e.description || e.categoryCode,
        subtitle: [e.reimbursement?.payerDriverName ?? e.driverName, e.loadNumber ? `Load ${e.loadNumber}` : null, e.unitNumber ? `Unit ${e.unitNumber}` : null].filter(Boolean).join(' · ') || null,
        amount: e.reimbursement ? e.reimbursement.driverFundedCents / 100 : e.amount,
        currency: e.reimbursement?.currency ?? e.currency,
        submittedAt: e.reimbursement?.submittedAt ?? null,
        status: 'pending',
        approve: { method: 'POST', path: `/accounting/reimbursements/${e.id}/review`, body: "{ decision: 'approve', reason: null }", permission: 'accounting.edit' },
        reject: { method: 'POST', path: `/accounting/reimbursements/${e.id}/review`, body: "{ decision: 'reject', reason }", permission: 'accounting.edit' },
        note: null,
      }));
    }
    if (kind === 'pto') {
      // The PTO service's own reach: the whole company with pto.manage, else the caller's direct reports.
      const page = await this.pto.list(principal, PtoQuerySchema.parse({ status: 'submitted', pageSize: 200, sort: 'startsOn', sortDir: 'asc' }));
      return page.data.map((r) => ({
        id: r.id,
        kind,
        title: `${r.policyName} · ${r.employeeName}`,
        subtitle: `${r.startsOn} – ${r.endsOn} · ${r.hours} h`,
        amount: null,
        currency: null,
        submittedAt: r.createdAt,
        status: r.status,
        approve: { method: 'POST', path: `/hr/pto/requests/${r.id}/decide`, body: "{ status: 'approved', note? }", permission: 'pto.approve' },
        reject: { method: 'POST', path: `/hr/pto/requests/${r.id}/decide`, body: "{ status: 'rejected', note }", permission: 'pto.approve' },
        note: null,
      }));
    }
    if (kind === 'repairs') {
      const rows = await this.db
        .select()
        .from(workOrders)
        .where(and(eq(workOrders.companyId, principal.companyId), isNotNull(workOrders.accidentId), isNull(workOrders.approvedAt), isNull(workOrders.voidedAt), ne(workOrders.status, 'completed')))
        .orderBy(asc(workOrders.createdAt))
        .limit(200);
      return rows.map((w) => ({
        id: w.id,
        kind,
        title: `Repair estimate · Unit ${w.unitNumber}`,
        subtitle: w.title || w.number,
        amount: null,
        currency: 'USD',
        submittedAt: w.createdAt.toISOString(),
        status: 'awaiting_approval',
        approve: { method: 'POST', path: `/safety/accidents-v2/work-orders/${w.id}/approve`, body: '{ updatedAt, estimateId, exceptionReason?, eta? }', permission: 'accidents.fleet' },
        reject: null,
        note: 'Accident repairs only; there is no reject route — add another estimate instead.',
      }));
    }
    // vacations: the 0081 request columns, read defensively (the request flow is phase M3).
    try {
      const rows = await this.db
        .select({ v: driverVacations, firstName: drivers.firstName, lastName: drivers.lastName })
        .from(driverVacations)
        .innerJoin(drivers, and(eq(drivers.id, driverVacations.driverId), eq(drivers.companyId, driverVacations.companyId)))
        .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.requestStatus, 'requested'), isNull(driverVacations.cancelledAt)))
        .limit(200);
      return rows.map(({ v, firstName, lastName }) => ({
        id: v.id,
        kind,
        title: `Vacation request · ${`${firstName} ${lastName}`.trim()}`,
        subtitle: `${v.startedOn}${(v.requestedEndOn ?? v.expectedReturnOn) ? ` – ${v.requestedEndOn ?? v.expectedReturnOn}` : ''}`,
        amount: null,
        currency: null,
        submittedAt: v.requestedAt?.toISOString() ?? null,
        status: 'requested',
        // The M3 decision route (Dispatch → Vacations uses the same one); version-checked.
        approve: { method: 'POST', path: `/drivers/vacation-requests/${v.id}/decision`, body: "{ version, decision: 'approve' }", permission: 'drivers.edit' },
        reject: { method: 'POST', path: `/drivers/vacation-requests/${v.id}/decision`, body: "{ version, decision: 'reject', reason }", permission: 'drivers.edit' },
        version: v.version,
        note: null,
      }));
    } catch (error) {
      this.logger.warn(`Vacation requests unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ------------------------------------------------------------------------------ my work

  private async ownEmployeeId(principal: Principal): Promise<string | null> {
    if (principal.membershipId) {
      const [m] = await this.db.select({ employeeId: memberships.employeeId }).from(memberships).where(eq(memberships.id, principal.membershipId)).limit(1);
      if (m?.employeeId) return m.employeeId;
    }
    const [e] = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.userId, principal.userId)))
      .limit(1);
    return e?.id ?? null;
  }

  async myWork(principal: Principal): Promise<OfficeMyWork> {
    this.assertOffice(principal);
    const today = this.today(principal);
    const tasks: OfficeTask[] = [];

    // Safety tasks assigned to me (accidents v2), open ones, soonest first.
    try {
      const rows = await this.db
        .select()
        .from(safetyTasks)
        .where(and(eq(safetyTasks.companyId, principal.companyId), eq(safetyTasks.assigneeId, principal.userId), inArray(safetyTasks.status, ['open', 'in_progress', 'blocked']), eq(safetyTasks.isTest, false)))
        .orderBy(asc(safetyTasks.dueAt))
        .limit(50);
      for (const t of rows) {
        tasks.push({
          id: t.id,
          source: 'safety_task',
          title: t.title,
          priority: t.priority,
          dueAt: t.dueAt.toISOString(),
          status: t.status,
          target: t.accidentId ? { type: 'accident', id: t.accidentId } : t.claimId ? { type: 'claim', id: t.claimId } : null,
        });
      }
    } catch (error) {
      this.logger.warn(`Safety tasks unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Workspace tasks assigned to this user (the shared Tasks collection), not done.
    try {
      const stored = await this.state.getFor(principal.companyId, 'ws2-tasks');
      const parsed = stored ? (JSON.parse(stored.value) as unknown) : [];
      const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { items?: unknown[] })?.items) ? (parsed as { items: unknown[] }).items : [];
      for (const raw of list as Array<Record<string, unknown>>) {
        if (raw.assigneeId !== principal.userId) continue;
        if (raw.status === 'done' || raw.status === 'completed' || raw.completedAt) continue;
        tasks.push({
          id: String(raw.id),
          source: 'workspace_task',
          title: String(raw.title ?? 'Task'),
          priority: typeof raw.priority === 'string' ? raw.priority : null,
          dueAt: typeof raw.dueAt === 'string' ? raw.dueAt : null,
          status: String(raw.status ?? 'open'),
          target: null,
        });
      }
    } catch (error) {
      this.logger.warn(`Workspace tasks unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Recruiting follow-ups: my leads nobody has contacted yet.
    if (hasPermission(principal, 'recruiting.view')) {
      const mine = await this.myLeads.list(principal, {});
      for (const l of mine.leads.filter((x) => x.status === 'new').slice(0, 20)) {
        tasks.push({ id: l.id, source: 'recruiting_lead', title: `Call new lead ${l.name}`, priority: 'normal', dueAt: null, status: 'new', target: { type: 'lead', id: l.id } });
      }
    }

    const employeeId = await this.ownEmployeeId(principal);
    let attendance: OfficeMyWork['attendance'] = { status: 'no_employee', since: null, entryStatus: null };
    if (employeeId) {
      const [entry] = await this.db
        .select()
        .from(attendanceEntries)
        .where(and(eq(attendanceEntries.companyId, principal.companyId), eq(attendanceEntries.employeeId, employeeId), eq(attendanceEntries.entryDate, today)))
        .limit(1);
      attendance = !entry?.checkInAt
        ? { status: 'not_checked_in', since: null, entryStatus: entry?.status ?? null }
        : entry.checkOutAt
          ? { status: 'checked_out', since: entry.checkOutAt.toISOString(), entryStatus: entry.status }
          : { status: 'checked_in', since: entry.checkInAt.toISOString(), entryStatus: entry.status };
    }
    const balances = employeeId ? await this.pto.myBalances(principal) : [];
    return {
      today,
      tasks,
      attendance,
      pto: { employeeLinked: Boolean(employeeId), balances: balances.map((b) => ({ policyName: b.policyName, balanceHours: b.balance, pendingHours: (b as { pending?: number }).pending ?? null })) },
      salaryReport: hasPermission(principal, 'dispatch_pay.view') ? { visibility: 'private', link: '/dispatch/salary' } : null,
    };
  }
}

function sevRank(s: string): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

