import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, ne } from 'drizzle-orm';
import { SYSTEM_ROLES, safetyRules as R } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { odometerReadings } from '../src/database/schema/pm';
import { companies, trucks } from '../src/database/schema/roster';
import { AccidentsV2Service } from '../src/modules/safety/accidents-v2/accidents-v2.service';
import { SafetyCoreService } from '../src/modules/safety/safety-core.service';
import { FIXTURE_CLOCK, FIXTURE_COMPANY, fx, loadAccidentFixtures, p1Seed } from './fixtures/accidents-v2-fixtures';

/**
 * Accident & Claims v2 — phase P5, analytics and profile sections (docs/accidents/ACCEPTANCE.md L1–L3, L7, M1–M5 through
 * the API). The rule-level M tests are in packages/shared (analytics.test.ts). Clock frozen at 2026-10-19T17:00:00Z.
 */

const RUN = Date.now().toString(36);
const MUT = `co_acc2_p5_${RUN}`;
const mx = (id: string) => `p5${RUN}_${id}`;
const permsOf = (role: string) => SYSTEM_ROLES.find((r) => r.code === role)?.permissions ?? [];
function principal(companyId: string, role: string): Principal {
  return { userId: `usr_acc2_${role}`, userName: `Test ${role}`, companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [role], permissions: new Set(permsOf(role)) };
}

describe('Accident & Claims v2 — P5 analytics and profiles (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let acc: AccidentsV2Service;
  let core: SafetyCoreService;
  let originalClock: () => Date;
  const SM = principal(FIXTURE_COMPANY, 'safety_manager');
  const caseId = (num: string) => p1Seed().cases.find((c) => c.number === num)!.id;

  beforeAll(async () => {
    setFeatureFlagForTests('accidents_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    acc = app.get(AccidentsV2Service);
    core = app.get(SafetyCoreService);
    originalClock = core.clock;
    core.clock = () => new Date(FIXTURE_CLOCK);
    await loadAccidentFixtures(db);
    await loadAccidentFixtures(db, { company: MUT, prefix: `p5${RUN}_` });
    await db.update(companies).set({ name: `Accidents v2 P5 run ${RUN} (TEST, fictional)` }).where(eq(companies.id, MUT));
  });

  afterAll(async () => {
    core.clock = originalClock;
    setFeatureFlagForTests('accidents_v2', null);
    await app.close();
  });

  it('L1 Truck 118: ACC-2026-005 and ACC-2026-016 with their work orders; KPIs; review suggested at ≥ 2 in 12 months', async () => {
    const r = await acc.profile(SM, 'truck', fx('t118'));
    expect(r.cases.map((c) => c.number)).toEqual(['ACC-2026-016', 'ACC-2026-005']);
    expect(r.cases[0]!.workOrders.map((w) => w.number)).toContain('RO-2026-9131');
    expect(r.kpis).toMatchObject({ total: 2, last12m: 2, reviewSuggested: true });
    expect(r.kpis.downtimeDays).toBeGreaterThan(19);
    expect(r.note).toBe('2 cases in 12 months — review suggested. A pattern to check, not a finding of fault.');
  });

  it('L2 Andre Lewis: both cases and the SPEC §6.3 note; test results are not part of the response', async () => {
    const r = await acc.profile(SM, 'driver', fx('d2'));
    expect(r.cases.map((c) => c.number)).toEqual(['ACC-2026-016', 'ACC-2026-005']);
    expect(r.note).toBe('2 cases in 12 months. Review the circumstances with the driver before drawing conclusions — 0 of them were non-preventable.');
    expect(r.correctiveActions.map((a) => a.kind)).toContain('Retraining');
    expect(JSON.stringify(r)).not.toMatch(/resultRestricted|Negative|Positive/);
  });

  it('L3 a unit with one accident case and no other history shows that case (the observed History bug)', async () => {
    const s = p1Seed();
    const counts = new Map<string, number>();
    for (const c of s.cases) if (c.truckId && c.stage !== 'draft') counts.set(c.truckId, (counts.get(c.truckId) ?? 0) + 1);
    const lonely = [...counts.entries()].find(([t, n]) => n === 1 && !s.workOrders.some((w) => w.unitId === t))!;
    const only = s.cases.find((c) => c.truckId === lonely[0])!;
    const r = await acc.profile(principal(MUT, 'fleet_manager'), 'truck', mx(lonely[0]));
    expect(r.cases.map((c) => c.id)).toEqual([mx(only.id)]);
    expect(r.kpis.reviewSuggested).toBe(false);
    expect(r.note).toBeNull();
  });

  it('maintenance sees the cases on a truck without money', async () => {
    const r = await acc.profile(principal(FIXTURE_COMPANY, 'maintenance'), 'truck', fx('t118'));
    expect(r.cases).toHaveLength(2);
    expect([r.kpis.spendCents, ...r.cases.map((c) => c.netCostCents)]).toEqual([null, null, null]);
  });

  it('L7 analytics and the board KPIs agree for the same range (one service)', async () => {
    for (const range of ['30d', '90d', '12m', 'ytd'] as const) {
      const a = await acc.analytics(SM, { range });
      const b = await acc.summary(SM, { range });
      expect([a.kpis.accidents, a.kpis.netCostCents, a.kpis.spentCents, a.kpis.recoveredCents, a.kpis.downtime.lostRevenueCents], range).toEqual([b.kpis.reported.value, b.kpis.netCost?.projectedNetCents, b.kpis.netCost?.spentCents, b.kpis.netCost?.recoveredCents, b.kpis.netCost?.lostRevenueCents]);
    }
  });

  it('M4 / M5 through the API: sample banner, every bucket names its cases, and the drill-down has a display row for each', async () => {
    const a = await acc.analytics(SM, { range: '90d' });
    expect(a.sample).toEqual({ cases: a.kpis.accidents, smallSample: a.kpis.accidents < 12 });
    const all = new Set(a.kpis.caseIds);
    expect(new Set(a.byMonth.flatMap((m) => m.caseIds))).toEqual(all);
    for (const id of [...all, ...a.insights.flatMap((i) => i.caseIds), ...a.repeatInvolvement.flatMap((r) => r.caseIds)]) expect(a.cases[id], id).toBeDefined();
    const twelve = await acc.analytics(SM, { range: '12m' });
    expect(twelve.repeatInvolvement.find((r) => r.kind === 'driver' && r.id === fx('d2'))).toMatchObject({ label: 'Andre Lewis', cases: 2 });
  });

  it('M1 through the API: rate per 1M miles from Fleet odometer readings, months under 70% coverage shaded', async () => {
    const fleet = await db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.companyId, MUT), ne(trucks.status, 'archived')));
    const rows = fleet.flatMap((t, i) => [
      { id: `odo_${RUN}_${i}_a`, companyId: MUT, unitId: t.id, readingAt: new Date('2026-09-01T14:00:00Z'), readingDate: '2026-09-01', odometerMiles: 400_000 + i, source: 'manual', createdBy: 'usr_acc2_test' },
      { id: `odo_${RUN}_${i}_b`, companyId: MUT, unitId: t.id, readingAt: new Date('2026-09-30T14:00:00Z'), readingDate: '2026-09-30', odometerMiles: 410_000 + i, source: 'manual', createdBy: 'usr_acc2_test' },
    ]);
    await db.insert(odometerReadings).values(rows);
    const a = await acc.analytics(principal(MUT, 'safety_manager'), { range: '90d' });
    const sep = a.ratePerMonth.find((m) => m.month === '2026-09')!;
    const aug = a.ratePerMonth.find((m) => m.month === '2026-08')!;
    expect([sep.coverage, sep.miles, sep.value]).toEqual([1, fleet.length * 10_000, sep.cases / ((fleet.length * 10_000) / 1e6)]);
    expect([aug.value, aug.coverage, aug.note]).toEqual([null, 0, 'Odometer coverage 0% — below 70%']);
    expect(a.kpis.ratePerMillionMiles).toMatchObject({ qualifyingMonths: 1, totalMonths: a.months.length });
    const fixture = await acc.analytics(SM, { range: '90d' });
    expect(fixture.kpis.ratePerMillionMiles).toMatchObject({ value: null, reason: 'No mileage data' });
  });

  it('a role without money gets the same counts and no money', async () => {
    const m = await acc.analytics(principal(FIXTURE_COMPANY, 'maintenance'), { range: '12m' });
    const s = await acc.analytics(SM, { range: '12m' });
    expect(m.kpis.accidents).toBe(s.kpis.accidents);
    expect([m.kpis.netCostCents, m.cashByMonth, m.followThrough.ownDamageReceivedCents]).toEqual([null, null, null]);
    expect(Object.values(m.cases).every((c) => c.netCostCents === null)).toBe(true);
  });

  it('sidebar count = urgent attention items; the same number as the board', async () => {
    const c = await acc.counts(SM);
    const b = await acc.summary(SM, { range: '30d' });
    expect(c).toEqual({ urgent: b.kpis.needsAttention.urgent, needsAttention: b.kpis.needsAttention.value, openCases: b.kpis.openCases.value });
    expect(c.urgent).toBeGreaterThan(0);
  });

  it('go-live §17 item 7: the sidebar badge counts urgent and overdue items only — never every Needs-attention item', async () => {
    const c = await acc.counts(SM);
    const b = await acc.summary(SM, { range: '30d' });
    const urgentOrOverdue = b.attention.filter((a) => a.tone === 'urgent' || /overdue/i.test(a.reason));
    // Every overdue item is urgent-toned, so the badge (urgent) already holds them.
    expect(b.attention.filter((a) => /overdue/i.test(a.reason)).every((a) => a.tone === 'urgent')).toBe(true);
    expect(c.urgent).toBe(urgentOrOverdue.length);
    expect(b.attention.some((a) => a.tone === 'warning')).toBe(true);
    expect(c.urgent).toBeLessThan(c.needsAttention);
  });

  it('analytics for the fixture: ACC-2026-018 counted, restricted strings never in the response for Dispatch', async () => {
    const a = await acc.analytics(principal(FIXTURE_COMPANY, 'dispatch_lead'), { range: '90d' });
    expect(a.kpis.caseIds).toContain(fx(caseId('ACC-2026-018')));
    expect(JSON.stringify(a)).not.toMatch(/neck pain|Attorney letter/);
    expect(R.monthsOf(a.from, a.to)).toEqual(a.months);
  });
});
