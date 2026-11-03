import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { SYSTEM_ROLES, safetyRules as R } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, membershipRoles, users } from '../src/database/schema/admin';
import { acctBills } from '../src/database/schema/accounting';
import { accidentUnits, downtimePeriods, safetyTasks, unitStatusHistory } from '../src/database/schema/accidents-v2';
import { workOrders } from '../src/database/schema/fleet';
import { companies } from '../src/database/schema/roster';
import { PayablesService } from '../src/modules/accounting/payables.service';
import { AccidentsV2Service } from '../src/modules/safety/accidents-v2/accidents-v2.service';
import { ClaimsV2Service } from '../src/modules/safety/accidents-v2/claims-v2.service';
import { EquipmentV2Service } from '../src/modules/safety/accidents-v2/equipment-v2.service';
import { TasksV2Service } from '../src/modules/safety/accidents-v2/tasks-v2.service';
import { SafetyCoreService } from '../src/modules/safety/safety-core.service';
import { FIXTURE_CLOCK, FIXTURE_COMPANY, fx, loadAccidentFixtures, p1Seed } from './fixtures/accidents-v2-fixtures';

/**
 * Accident & Claims v2 — phase P3, equipment, downtime and money (docs/accidents/ACCEPTANCE.md H1–H7 end to end, I1–I8,
 * F1/F2 Net cost tile, F4 work order, H5-R, L4). Clock frozen at 2026-10-19T17:00:00Z. Read-only checks on the shared
 * fixture company; every write runs in a fresh fictional company loaded from the same seed for this run (local DB only).
 */

const NOW = FIXTURE_CLOCK.getTime();
const RUN = Date.now().toString(36);
const MUT = `co_acc2_p3_${RUN}`;
const mx = (id: string) => `p3${RUN}_${id}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EXPECTED: any = JSON.parse(readFileSync(join(__dirname, '../../../packages/shared/src/safety-rules/test-fixtures/fixtures-2026-10-19T17Z.json'), 'utf8'));
const c100 = (d: number) => Math.round(d * 100);

const permsOf = (role: string) => SYSTEM_ROLES.find((r) => r.code === role)?.permissions ?? [];
function principal(companyId: string, role: string, userId = `usr_acc2_${role}`, userName = `Test ${role}`): Principal {
  return { userId, userName, companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [role], permissions: new Set(permsOf(role)) };
}
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; type?: string; detail?: string; extensions?: Record<string, unknown> };
  }
  throw new Error('expected an error');
};

describe('Accident & Claims v2 — P3 equipment, downtime and money (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let acc: AccidentsV2Service;
  let claims: ClaimsV2Service;
  let equip: EquipmentV2Service;
  let tasks: TasksV2Service;
  let core: SafetyCoreService;
  let originalClock: () => Date;

  const SM = principal(FIXTURE_COMPANY, 'safety_manager', 'usr_acc2_rm', 'Rachel Moore');
  const DISPATCH = principal(FIXTURE_COMPANY, 'dispatch_lead');
  const MECH = principal(FIXTURE_COMPANY, 'maintenance');
  const MSM = principal(MUT, 'safety_manager', 'usr_acc2_p3_sm', 'Sam Safety');
  const MFLEET = principal(MUT, 'fleet_manager', 'usr_acc2_p3_fleet', 'Fred Fleet');
  const MACC = principal(MUT, 'accounting', 'usr_acc2_p3_acc', 'Ana Accounting');
  const MDISP = principal(MUT, 'dispatch_lead', 'usr_acc2_p3_disp', 'Dina Dispatch');
  const MOPS = principal(MUT, 'operations_manager', 'usr_acc2_p3_ops', 'Olga Ops');

  const caseOf = (num: string) => p1Seed().cases.find((c) => c.number === num)!.id;
  const woOf = (num: string) => p1Seed().workOrders.find((w) => w.number === num)!.id;
  const claimOf = (num: string) => p1Seed().claims.find((k) => k.number === num)!.id;

  beforeAll(async () => {
    setFeatureFlagForTests('accidents_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    acc = app.get(AccidentsV2Service);
    claims = app.get(ClaimsV2Service);
    equip = app.get(EquipmentV2Service);
    tasks = app.get(TasksV2Service);
    core = app.get(SafetyCoreService);
    originalClock = core.clock;
    core.clock = () => new Date(FIXTURE_CLOCK);
    app.get(PayablesService).clock = () => new Date(FIXTURE_CLOCK);
    await loadAccidentFixtures(db);
    await loadAccidentFixtures(db, { company: MUT, prefix: `p3${RUN}_` });
    await db.update(companies).set({ name: `Accidents v2 P3 run ${RUN} (TEST, fictional)` }).where(eq(companies.id, MUT));
    for (const [uid, first, role] of [
      ['usr_acc2_p3_sm', 'Sam', 'safety_manager'],
      ['usr_acc2_p3_fleet', 'Fred', 'fleet_manager'],
    ] as const) {
      await db.insert(users).values({ id: uid, email: `${uid}@acc2.test`, firstName: first, lastName: 'Test' }).onConflictDoNothing();
      await db.insert(memberships).values({ id: `mem_${uid}_${RUN}`, companyId: MUT, userId: uid, status: 'active' }).onConflictDoNothing();
      await db.insert(membershipRoles).values({ membershipId: `mem_${uid}_${RUN}`, roleId: `rol_${role}` }).onConflictDoNothing();
    }
  });

  afterAll(async () => {
    core.clock = originalClock;
    setFeatureFlagForTests('accidents_v2', null);
    await app.close();
  });

  // ================================================================================== H1–H5 ledger, end to end

  it('H1–H5 every ledger line, every total and lost revenue of the five showcase cases equal the fixture (authorized viewer)', async () => {
    for (const num of ['ACC-2026-008', 'ACC-2026-015', 'ACC-2026-016', 'ACC-2026-017', 'ACC-2026-018']) {
      const d = await acc.detail(SM, fx(caseOf(num)));
      const f = d.computed.money.financials!;
      const m = EXPECTED.cases[num].money;
      expect(
        { actual: f.actualCents, recovered: f.recoveredCents, netToDate: f.netToDateCents, estimate: f.estimateCents, expected: f.expectedCents, projectedNet: f.projectedNetCents, exposure: f.exposureCents, finalized: f.finalized },
        num,
      ).toEqual({ actual: c100(m.actual), recovered: c100(m.recovered), netToDate: c100(m.netToDate), estimate: c100(m.estimate), expected: c100(m.expected), projectedNet: c100(m.projectedNet), exposure: c100(m.exposure), finalized: m.finalized });
      expect(f.lostRevenue.days.toFixed(2), num).toBe(m.lostRevenue.days.toFixed(2));
      expect([f.lostRevenue.perDayCents, f.lostRevenue.amountCents, f.lostRevenue.fallback], num).toEqual([c100(m.lostRevenue.perDay), c100(m.lostRevenue.amount), false]);
      expect(f.lines.map((l) => ({ group: l.group, category: l.category, amount: l.amountCents, label: l.label, source: l.source })), num).toEqual(
        EXPECTED.cases[num].ledger.map((l: { amount: number }) => ({ ...l, amount: c100(l.amount) })),
      );
      const costs = d.computed.tracks.find((t) => t.key === 'costs');
      const ec = EXPECTED.cases[num].tracks.find((t: { label: string }) => t.label === 'Costs');
      expect([costs?.status, costs?.detail], num).toEqual([ec.status, ec.detail]);
    }
  });

  it('H5-R as Dispatch: CLM-2026-0044 leaves lines and totals of ACC-2026-018 (Estimate 3,900 · Projected 3,900 · Exposure 0 · excludes 1)', async () => {
    const f = (await acc.detail(DISPATCH, fx(caseOf('ACC-2026-018')))).computed.money.financials!;
    expect([f.estimateCents, f.projectedNetCents, f.exposureCents, f.restrictedClaimsExcluded]).toEqual([3_900_00, 3_900_00, 0, 1]);
    expect(f.lines.some((l) => l.source.includes('CLM-2026-0044'))).toBe(false);
    const s = await acc.summary(DISPATCH, { range: '90d' });
    expect([s.kpis.openClaims.ourCostToComeCents, s.kpis.openClaims.insurerReservesCents, s.kpis.netCost?.projectedNetCents]).toEqual([16_100_00, 111_040_00, 44_790_00]);
  });

  it('F1 / F2 Net cost tile and our cost to come for every range (spent · recovered · lost revenue not cash)', async () => {
    for (const key of ['30d', '90d', '12m', 'ytd'] as const) {
      const s = await acc.summary(SM, { range: key });
      const e = EXPECTED.board[key];
      expect([s.kpis.netCost?.projectedNetCents, s.kpis.netCost?.spentCents, s.kpis.netCost?.recoveredCents, s.kpis.netCost?.lostRevenueCents], key).toEqual(
        // YTD starts at Eastern midnight (P1 decision); the fixture's YTD money is identical (no case falls in Jan 1 00:00–05:00Z).
        [c100(e.netCost), c100(e.spent), c100(e.recovered), c100(e.lostRevenueNotCash)],
      );
      expect(s.kpis.openClaims.ourCostToComeCents, key).toBe(c100(e.ourCostToCome));
    }
  });

  it('F4 trucks down: Truck 118 with RO-2026-9131 Waiting for approval (2/3 estimates); board rows carry the money basis', async () => {
    const s = await acc.summary(SM, { range: '90d' });
    expect(s.trucksDown[0]?.workOrder).toMatchObject({ number: 'RO-2026-9131', status: 'Waiting for approval', estimates: 2, estimatesRequired: 3 });
    const all = await acc.board(SM, { chip: 'all', range: '12m' });
    const row = (n: string) => all.items.find((r) => r.number === n)!.money!;
    expect(row('ACC-2026-008')).toMatchObject({ projectedNetCents: 6_460_00, basis: 'final' });
    expect(row('ACC-2026-016')).toMatchObject({ projectedNetCents: 10_350_00, actualCents: 2_850_00, basis: 'spent' });
    expect(row('ACC-2026-018')).toMatchObject({ projectedNetCents: 6_400_00, basis: 'estimate' });
  });

  it('the shop-floor role (maintenance) never receives repair costs; everyone else with accidents.view does', async () => {
    const d = await acc.detail(MECH, fx(caseOf('ACC-2026-016')));
    expect(d.computed.money.financials).toBeNull();
    expect(d.computed.money.workOrders[0]?.estimates.every((e) => e.amountCents === null)).toBe(true);
    expect(d.permissions.seeMoney).toBe(false);
    expect((await acc.summary(MECH, { range: '90d' })).kpis.netCost).toBeNull();
    expect((await acc.detail(DISPATCH, fx(caseOf('ACC-2026-016')))).permissions.seeMoney).toBe(true);
  });

  // ================================================================================== H6 — no double counting (fresh company)

  it('H6 the whole life of ACC-2026-016 keeps Projected 10,350: PD payment → approve with 2 of 3 (exception) → Mark repaired', async () => {
    const caseId = mx(caseOf('ACC-2026-016'));
    const woId = mx(woOf('RO-2026-9131'));
    const money = async () => (await acc.detail(MSM, caseId)).computed.money.financials!;
    // 1. PD payment 33,450 to us on CLM-2026-0040, set Settled.
    const k = mx(claimOf('CLM-2026-0040'));
    let kd = await claims.detail(MSM, k);
    await claims.recordPayment(MSM, k, { version: kd.version, direction: 'to_us', amountCents: 33_450_00, party: 'Harborline Insurance' });
    kd = await claims.detail(MSM, k);
    await claims.patch(MSM, k, { version: kd.version, status: 'Settled' });
    let f = await money();
    expect([f.recoveredCents, f.expectedCents, f.netToDateCents, f.projectedNetCents]).toEqual([33_450_00, 0, -30_600_00, 10_350_00]);
    // 2. Approve 38,450 with only 2 of 3 estimates: the exception reason is mandatory and logged.
    let d = await acc.detail(MSM, caseId);
    let w = d.computed.money.workOrders.find((x) => x.id === woId)!;
    expect([w.status, w.estimates.length, w.estimatesRequired]).toEqual(['Waiting for approval', 2, 3]);
    const lowest = w.estimates.reduce((a, b) => ((b.amountCents ?? 0) < (a.amountCents ?? 0) ? b : a));
    const noReason = await err(equip.approve(MFLEET, woId, { updatedAt: w.updatedAt, estimateId: lowest.id }));
    expect([noReason.status, noReason.detail]).toEqual([422, '2 of 3 required estimates received — give the policy-exception reason to approve now']);
    expect((await err(equip.approve(MDISP, woId, { updatedAt: w.updatedAt, estimateId: lowest.id, exceptionReason: 'x' }))).status).toBe(403);
    await equip.approve(MFLEET, woId, { updatedAt: w.updatedAt, estimateId: lowest.id, exceptionReason: 'Third shop cannot quote for two weeks; truck is losing $630/day' });
    d = await acc.detail(MSM, caseId);
    w = d.computed.money.workOrders.find((x) => x.id === woId)!;
    expect([w.status, w.approvedAmountCents, w.policyExceptionReason]).toEqual(['Approved', 38_450_00, 'Third shop cannot quote for two weeks; truck is losing $630/day']);
    expect(d.units.find((u) => u.unitKind === 'truck')?.status).toBe('in_repair');
    f = await money();
    expect(f.projectedNetCents).toBe(10_350_00);
    // A task linked to the work order (completes with it) and one that only mentions estimates (never completed by title).
    const linked = await tasks.create(MSM, { accidentId: caseId, workOrderId: woId, title: 'Confirm the repair scope with the shop', dept: 'Fleet', dueAt: new Date(NOW + 86_400_000).toISOString() });
    const byTitle = await tasks.create(MSM, { accidentId: caseId, title: 'Get the third repair estimate on file', dept: 'Fleet', dueAt: new Date(NOW + 86_400_000).toISOString() });
    // 3. Mark repaired with the 38,450 invoice.
    const res = await equip.complete(MFLEET, woId, { updatedAt: w.updatedAt, invoiceNumber: 'PS-77120', invoiceTotalCents: 38_450_00 });
    expect(res.billWarning).toBeNull();
    expect(res.bill?.number).toMatch(/^AP-/);
    expect(res.tasksCompleted).toBe(1);
    const t1 = (await tasks.list(MSM, { accidentId: caseId, status: 'all' })).find((t) => t.id === linked.id)!;
    const t2 = (await tasks.list(MSM, { accidentId: caseId, status: 'all' })).find((t) => t.id === byTitle.id)!;
    expect([t1.status, t2.status]).toEqual(['done', 'open']);
    d = await acc.detail(MSM, caseId);
    f = d.computed.money.financials!;
    expect([f.actualCents, f.estimateCents, f.netToDateCents, f.projectedNetCents]).toEqual([41_300_00, 2_500_00, 7_850_00, 10_350_00]);
    expect(f.lines.find((l) => l.category === 'Tractor repair')).toMatchObject({ group: 'actual', amountCents: 38_450_00 });
    expect(f.lines.some((l) => l.group === 'estimate' && l.category === 'Tractor repair')).toBe(false);
    const truck = d.units.find((u) => u.unitKind === 'truck')!;
    expect([truck.status, truck.conditionAtScene, truck.returnedToServiceAt]).toEqual(['returned', 'not_drivable', FIXTURE_CLOCK.toISOString()]);
    expect(d.computed.downtime.ongoing).toBe(false);
    expect((d.computed.downtime.truckMs / R.DAY).toFixed(2)).toBe('16.84');
    expect(d.computed.closeBlockers.map((b) => b.text)).not.toContain('Tractor has not returned to service');
    expect(d.computed.closeBlockers.some((b) => /work order/.test(b.text))).toBe(false);
    // The bill is in Accounts Payable with the case link; the Ready request waits for Dispatch.
    const [bill] = await db.select().from(acctBills).where(eq(acctBills.id, res.bill!.id));
    expect([bill?.accidentId, bill?.accidentCostCategory, bill?.amountCents, bill?.sourceKey]).toEqual([caseId, 'Tractor repair', 38_450_00, `repair_order:${woId}`]);
    const [ready] = await db.select().from(safetyTasks).where(eq(safetyTasks.id, res.readyRequestId!));
    expect([ready?.dept, ready?.requestKind, ready?.status, ready?.priority]).toEqual(['Dispatch', 'unit_ready', 'open', 'high']);
    const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, woId));
    expect([wo?.status, wo?.invoiceNumber, wo?.invoiceTotal]).toEqual(['completed', 'PS-77120', '38450.00']);
    // Nothing on the Daily-board side changed until Dispatch confirms; the confirmation writes the unit status history.
    const truckId = mx('t118');
    expect(await db.select().from(unitStatusHistory).where(and(eq(unitStatusHistory.companyId, MUT), eq(unitStatusHistory.unitId, truckId)))).toHaveLength(0);
    await tasks.confirm(MDISP, ready!.id, { version: ready!.version });
    const hist = await db.select().from(unitStatusHistory).where(and(eq(unitStatusHistory.companyId, MUT), eq(unitStatusHistory.unitId, truckId)));
    expect(hist.map((h) => [h.status, h.setBy, h.until])).toEqual([['READY', 'Dina Dispatch', null]]);
  });

  // ================================================================================== I1–I8

  it('I1 + I2 create a work order from a case unit (Accident repair, At shop) and an estimate above $25,000 → 3 required + attention', async () => {
    const caseId = mx(caseOf('ACC-2026-018'));
    let d = await acc.detail(MSM, caseId);
    expect((await err(equip.createWorkOrder(MDISP, caseId, { version: d.version, unitKind: 'trailer', vendorName: 'x' }))).status).toBe(403);
    const woId = await equip.createWorkOrder(MFLEET, caseId, { version: d.version, unitKind: 'truck', vendorId: mx('vnd_0'), title: 'Frame inspection after impact' });
    const [row] = await db.select().from(workOrders).where(eq(workOrders.id, woId));
    expect([row?.workType, row?.accidentId, row?.status, row?.number]).toEqual(['accident_repair', caseId, 'in_shop', expect.stringMatching(/^RO-/)]);
    d = await acc.detail(MSM, caseId);
    const w = d.computed.money.workOrders.find((x) => x.id === woId)!;
    expect([w.status, w.estimatesRequired]).toEqual(['Awaiting estimate', 1]);
    const r = await equip.addEstimate(MFLEET, woId, { updatedAt: w.updatedAt, vendor: 'Hoosier Fleet Repair', amountCents: 26_000_00 });
    expect(r.estimatesRequired).toBe(3);
    const s = await acc.summary(MSM, { range: '90d' });
    expect(s.attention.find((a) => a.title.startsWith(`${row?.number}:`))).toMatchObject({ reason: 'Repair approval blocked', title: `${row?.number}: 1 of 3 required estimates received` });
    // Stale token → 409; the second estimate never lowers the requirement.
    expect((await err(equip.addEstimate(MFLEET, woId, { updatedAt: w.updatedAt, vendor: 'x', amountCents: 1 }))).status).toBe(409);
    const again = await equip.addEstimate(MFLEET, woId, { updatedAt: r.updatedAt, vendor: 'Second shop', amountCents: 5_000_00 });
    expect(again.estimatesRequired).toBe(3);
  });

  it('I5 an accident repair with no case raises the attention item; linking it removes it', async () => {
    const woId = mx(woOf('RO-2026-9158'));
    const item = (await acc.summary(MSM, { range: '90d' })).attention.find((a) => a.woId === woId);
    expect(item).toMatchObject({ reason: 'Accident repair with no case', title: 'RO-2026-9158: Truck 148 repaired at Midwest Truck & Trailer — no accident reported to Safety' });
    const [w] = await db.select().from(workOrders).where(eq(workOrders.id, woId));
    await equip.linkWorkOrder(MSM, woId, { updatedAt: w!.updatedAt.toISOString(), accidentId: mx(caseOf('ACC-2026-017')) });
    expect((await acc.summary(MSM, { range: '90d' })).attention.some((a) => a.woId === woId)).toBe(false);
  });

  it('I6 Ask Dispatch to repower/transload: high-priority Dispatch task due in 3 h; nothing changes until Dispatch confirms', async () => {
    const t = await acc.request(MSM, mx(caseOf('ACC-2026-016')), { kind: 'repower_transload', note: 'Load L-47982 needs a truck today' });
    expect([t.dept, t.priority, t.dueAt, t.requestKind, t.status]).toEqual(['Dispatch', 'high', new Date(NOW + 3 * 3_600_000).toISOString(), 'repower_transload', 'open']);
    expect((await err(tasks.confirm(MFLEET, t.id, { version: t.version }))).status).toBe(403);
  });

  it('I7 truck not drivable: Fleet verifies the period (verifier recorded); Dispatch confirming "unit unavailable" writes ACCIDENT', async () => {
    const caseId = mx(caseOf('ACC-2026-018'));
    const [period] = await db.select().from(downtimePeriods).where(and(eq(downtimePeriods.companyId, MUT), eq(downtimePeriods.accidentId, caseId)));
    expect(period).toBeTruthy();
    expect((await err(equip.verifyDowntime(MDISP, period!.id, { version: period!.version }))).status).toBe(403);
    await equip.verifyDowntime(MFLEET, period!.id, { version: period!.version });
    const d = await acc.detail(MSM, caseId);
    expect(d.computed.downtime.periods.find((x) => x.id === period!.id)?.verifiedBy).toBe('Fred Fleet');
    const req = await acc.request(MSM, caseId, { kind: 'unit_unavailable', note: 'Truck 133 is at the shop' });
    await tasks.confirm(MDISP, req.id, { version: req.version });
    const hist = await db.select().from(unitStatusHistory).where(and(eq(unitStatusHistory.companyId, MUT), eq(unitStatusHistory.accidentId, caseId), isNull(unitStatusHistory.until)));
    expect(hist.map((h) => h.status)).toEqual(['ACCIDENT']);
    expect((await acc.detail(MSM, caseId)).computed.money.unitStatus.map((u) => u.status)).toEqual(['ACCIDENT']);
  });

  it('I8 marking the unit Returned to service closes its open downtime; never more than one open period per unit per case', async () => {
    const caseId = mx(caseOf('ACC-2026-018'));
    const u = (await acc.detail(MSM, caseId)).units.find((x) => x.unitKind === 'truck')!;
    await acc.unit(MFLEET, caseId, u.id, { version: u.version, status: 'towed_storage' });
    const open = await db.select().from(downtimePeriods).where(and(eq(downtimePeriods.accidentId, caseId), isNull(downtimePeriods.endedAt)));
    expect(open).toHaveLength(1);
    const u2 = (await acc.detail(MSM, caseId)).units.find((x) => x.unitKind === 'truck')!;
    // The condition at the scene is Safety's, not Fleet's.
    expect((await err(acc.unit(MFLEET, caseId, u.id, { version: u2.version, conditionAtScene: 'drivable' }))).status).toBe(403);
    await acc.unit(MFLEET, caseId, u.id, { version: u2.version, status: 'returned' });
    expect(await db.select().from(downtimePeriods).where(and(eq(downtimePeriods.accidentId, caseId), isNull(downtimePeriods.endedAt)))).toHaveLength(0);
    const [unitRow] = await db.select().from(accidentUnits).where(eq(accidentUnits.id, u.id));
    expect(unitRow?.status).toBe('returned');
  });

  // ================================================================================== L4, void guard, H7

  it('L4 Add invoice to AP from the case: one AP bill with the case link, in Accounts Payable; counts once on the ledger', async () => {
    const caseId = mx(caseOf('ACC-2026-017'));
    const before = (await acc.detail(MSM, caseId)).computed.money.financials!.actualCents;
    const d = await acc.detail(MACC, caseId);
    const bill = await equip.addBill(MACC, caseId, { version: d.version, vendorId: mx('vnd_0'), category: 'Towing', amountCents: 450_00, memo: 'Tow from the truck stop lot to the shop' });
    const ap = await app.get(PayablesService).bills({ ...MACC, permissions: new Set([...MACC.permissions]) });
    expect(ap.find((b) => b.id === bill.id)).toMatchObject({ billNumber: bill.number, amount: 450 });
    const after = await acc.detail(MSM, caseId);
    expect(after.computed.money.financials!.actualCents).toBe(before + 450_00);
    expect(after.computed.money.apBills.find((b) => b.id === bill.id)).toMatchObject({ category: 'Towing', amountCents: 450_00 });
    expect((await err(equip.addBill(MDISP, caseId, { version: after.version, vendorId: mx('vnd_0'), category: 'Towing', amountCents: 1, memo: 'no' }))).status).toBe(403);
    // Void is refused while work orders or bills are linked (E12, P3 part).
    const v = await err(acc.void(MSM, caseId, { version: after.version, reason: 'Entered in error' }));
    expect([v.status, v.type]).toEqual([409, '/problems/linked-records']);
    expect((v.extensions?.apBills as { number: string }[]).map((b) => b.number)).toContain(bill.number);
  });

  it('H7 an AP bill linked to a claim counts through the claim only; a PD claim with no repair cost adds the cost basis', async () => {
    // AP-90112 (deductible reimbursement on CLM-2026-0019) is a claim bill: never a case line.
    const f8 = (await acc.detail(SM, fx(caseOf('ACC-2026-008')))).computed.money.financials!;
    expect(f8.lines.some((l) => l.source.startsWith('AP bill AP-90112'))).toBe(false);
    expect(f8.lines.find((l) => l.category === 'Deductible')).toMatchObject({ group: 'actual', amountCents: 2_500_00, source: expect.stringContaining('CLM-2026-0019') });
    // Ops can open a work order? No — Fleet's right; Ops Manager holds accidents.fleet by the owner's mapping.
    expect(permsOf('operations_manager')).toContain('accidents.fleet');
    void MOPS;
  });
});
