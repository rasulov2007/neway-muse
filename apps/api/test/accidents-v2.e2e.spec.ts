import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, sql } from 'drizzle-orm';
import { SYSTEM_ROLES, accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, membershipRoles, users } from '../src/database/schema/admin';
import { downtimePeriods, safetyTasks, safetyTimelineEvents } from '../src/database/schema/accidents-v2';
import { trailers } from '../src/database/schema/fleet';
import { loads } from '../src/database/schema/loads';
import { companies, drivers, trucks } from '../src/database/schema/roster';
import { auditLogs } from '../src/database/schema/people';
import { drugAlcoholTests, safetyAccidents, safetyCaseDocuments, safetyClaims, safetyReviews } from '../src/database/schema/safety';
import { storedFiles } from '../src/database/schema/files';
import { AccidentsV2Service } from '../src/modules/safety/accidents-v2/accidents-v2.service';
import { TasksV2Service } from '../src/modules/safety/accidents-v2/tasks-v2.service';
import { registerCsv } from '../src/modules/safety/accidents-v2/views';
import { SafetyCoreService } from '../src/modules/safety/safety-core.service';
import { accountWithPermissions } from './fleet-reader-account';
import { FIXTURE_CLOCK, FIXTURE_COMPANY, fx, loadAccidentFixtures, p1Seed } from './fixtures/accidents-v2-fixtures';

/**
 * Accident & Claims v2 — phase P1 (docs/accidents/ACCEPTANCE.md A, E, F, N; IMPLEMENTATION-PLAN P1 report).
 *
 * The clock is frozen at the fixture instant 2026-10-19T17:00:00Z. Fixture-based checks run against the services with
 * principals of a dedicated, fictional TEST company (`co_acc2_fixtures`, loaded by test/fixtures — never production);
 * the quick-report flows run in a second test company; the HTTP checks (flag, permissions, idempotency) run as the
 * dev-header company with test-flagged records only. P1 has no claims (P2), work orders or AP bills (P3): where an
 * ACCEPTANCE value depends on them, the P1 part is asserted and the rest is left to those phases.
 */

const BASE = '/api/v1/safety/accidents-v2';
const REPORT_CO = 'co_acc2_report';
const HOUR = 3_600_000;
const NOW = FIXTURE_CLOCK.getTime();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EXPECTED: any = JSON.parse(readFileSync(join(__dirname, '../../../packages/shared/src/safety-rules/test-fixtures/fixtures-2026-10-19T17Z.json'), 'utf8'));

const permsOf = (role: string) => SYSTEM_ROLES.find((r) => r.code === role)?.permissions ?? [];
function principal(companyId: string, role: string, userId = `usr_acc2_${role}`, userName = `Test ${role}`): Principal {
  return { userId, userName, companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [role], permissions: new Set(permsOf(role)) };
}
/** Local wall time in a zone, `minutes` relative to the fixture clock. */
const localAt = (minutes: number, tz: string) => R.isoToLocalInput(new Date(NOW + minutes * 60_000).toISOString(), tz);
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; type?: string; detail?: string; extensions?: Record<string, unknown> };
  }
  throw new Error('expected an error');
};

describe('Accident & Claims v2 — P1 (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let svc: AccidentsV2Service;
  let tasks: TasksV2Service;
  let core: SafetyCoreService;
  let originalClock: () => Date;

  // Fixture company principals (roles from the shipped SYSTEM_ROLES: the owner's mapping 2026-10-21).
  const SM = principal(FIXTURE_COMPANY, 'safety_manager', 'usr_acc2_rm', 'Rachel Moore');
  const DISPATCH = principal(FIXTURE_COMPANY, 'dispatch_lead');
  // Report company principals.
  const RSM = principal(REPORT_CO, 'safety_manager', 'usr_acc2r_sm', 'Sam Safety');
  const ROPS = principal(REPORT_CO, 'operations_manager', 'usr_acc2r_ops', 'Olga Ops');
  const RDISP = principal(REPORT_CO, 'dispatch_lead', 'usr_acc2r_disp', 'Dina Dispatch');
  const RFLEET = principal(REPORT_CO, 'fleet_manager', 'usr_acc2r_fleet', 'Fred Fleet');

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    setFeatureFlagForTests('accidents_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    svc = app.get(AccidentsV2Service);
    tasks = app.get(TasksV2Service);
    core = app.get(SafetyCoreService);
    originalClock = core.clock;
    core.clock = () => new Date(FIXTURE_CLOCK);
    await loadAccidentFixtures(db);
    await setupReportCompany(db);
  });

  afterAll(async () => {
    core.clock = originalClock;
    setFeatureFlagForTests('accidents_v2', null);
    await app.close();
  });

  // ================================================================================== flag + permissions

  describe('flag and permissions', () => {
    it('is unreachable with accidents_v2 off (404), while the Safety v2 accident pages keep answering', async () => {
      setFeatureFlagForTests('accidents_v2', false);
      for (const url of [BASE, `${BASE}/summary`, `${BASE}/tasks`, `${BASE}/acc_x`]) {
        const res = await call('GET', url);
        expect(res.statusCode, url).toBe(404);
        expect(res.body).toContain('accidents_v2');
      }
      expect((await call('POST', BASE, { submit: false, description: 'nothing' })).statusCode).toBe(404);
      expect((await call('GET', '/api/v1/safety/accidents')).statusCode).toBe(200);
      setFeatureFlagForTests('accidents_v2', true);
      expect((await call('GET', BASE)).statusCode).toBe(200);
    });

    it('refuses a role without accidents.view (403) and writes without accidents.edit', async () => {
      const reader = { 'x-account': await accountWithPermissions(app, ['trucks.view'], 'Acc2 nobody') };
      expect((await call('GET', BASE, undefined, reader)).statusCode).toBe(403);
      const viewer = { 'x-account': await accountWithPermissions(app, ['accidents.view'], 'Acc2 viewer') };
      expect((await call('GET', `${BASE}/summary`, undefined, viewer)).statusCode).toBe(200);
      const write = await call('POST', BASE, { submit: false, description: 'A viewer cannot report' }, viewer);
      expect(write.statusCode).toBe(403);
    });

    it('role mapping (owner 2026-10-21): restricted and override only Safety Manager + Administrator; Dispatch confirms', () => {
      const holders = (code: string) => SYSTEM_ROLES.filter((r) => r.permissions.includes(code)).map((r) => r.code).sort();
      expect(holders('accidents.restricted')).toEqual(['administrator', 'safety_manager']);
      expect(holders('accidents.override')).toEqual(['administrator', 'safety_manager']);
      expect(holders('accidents.confirm')).toEqual(['administrator', 'dispatch_lead']);
      expect(holders('accidents.edit')).toEqual(['administrator', 'operations_manager', 'safety_manager']);
      expect(holders('accidents.edit_cargo')).toEqual(['administrator', 'dispatch_lead', 'dispatcher']);
      for (const r of ['fleet_manager', 'maintenance', 'dispatcher', 'dispatch_lead', 'accounting', 'operations_manager', 'safety_manager']) {
        expect(permsOf(r), r).toContain('accidents.view');
      }
    });
  });

  // ================================================================================== F — board (fixture company)

  describe('F — board at the fixture clock (P1 tiles)', () => {
    const expected = () => EXPECTED;

    it('F1 90-day tiles: open 3 (2 serious, 0 awaiting), reported 7 (prior 4), trucks down 1 (34.42 truck-days); claims and money tiles are P2/P3', async () => {
      const s = await svc.summary(SM, { range: '90d' });
      expect(s.kpis.openCases).toEqual({ value: 3, serious: 2, awaitingInvestigation: 0 });
      expect(s.kpis.reported).toEqual({ value: 7, prior: 4, delta: 3 });
      expect(s.kpis.trucksDownNow.value).toBe(1);
      expect(s.kpis.trucksDownNow.truckDaysInRange.toFixed(2)).toBe('34.42');
      // P2: the Open claims tile (8 · $194K insurer reserves). Our cost to come needs the work-order estimates (P3).
      expect(s.kpis.openClaims.value).toBe(8);
      expect(s.kpis.openClaims.insurerReservesCents).toBe(193_540_00);
    });

    it('F2 other ranges: reported / prior / truck-days match the fixture (YTD from Eastern midnight)', async () => {
      const e = expected();
      for (const key of ['30d', '12m', 'ytd'] as const) {
        const s = await svc.summary(SM, { range: key });
        expect([s.kpis.reported.value, s.kpis.reported.prior, +s.kpis.trucksDownNow.truckDaysInRange.toFixed(2)], key).toEqual([
          e.board[key].reported,
          e.board[key].priorPeriod,
          e.board[key].truckDaysInRange,
        ]);
      }
      expect((await svc.summary(SM, { range: 'ytd' })).range.from).toBe('2026-01-01T05:00:00.000Z');
    });

    it('F3 Needs attention — exactly 8, in order: overdue tasks (claim and cases), work-order items, claims without an update', async () => {
      const s = await svc.summary(SM, { range: '90d' });
      const ref = R.needsAttention(p1Seed(), { now: NOW });
      expect(s.attention.map((a) => [a.tone, a.reason, a.title, a.caseNumber, a.due])).toEqual(
        ref.map((a) => [a.tone, a.reason, a.title, R.byId(p1Seed().cases, a.caseId)?.number, a.due]),
      );
      expect(s.attention.map((a) => [a.tone, a.reason, a.title, a.caseNumber])).toEqual([
        ['urgent', 'Overdue task', 'CLM-2026-0038: Driver statement on parking location (theft claim)', undefined],
        ['urgent', 'Overdue task', 'Request ECM / engine data download from Prairie State', 'ACC-2026-016'],
        ['urgent', 'Overdue task', 'Canvass businesses at US-30 & Broadway for camera footage', 'ACC-2026-018'],
        ['warning', 'Repair approval blocked', 'RO-2026-9131: 2 of 3 required estimates received', 'ACC-2026-016'],
        ['warning', 'Accident repair with no case', 'RO-2026-9158: Truck 148 repaired at Midwest Truck & Trailer — no accident reported to Safety', undefined],
        ['warning', 'No update ≥ 7 days', 'CLM-2026-0037 (Auto liability) — last update Oct 5', 'ACC-2026-015'],
        ['warning', 'No update ≥ 7 days', 'CLM-2026-0026 (Recovery (subrogation)) — last update Oct 2', 'ACC-2026-011'],
        ['warning', 'No update ≥ 7 days', 'CLM-2026-0038 (Cargo) — last update Oct 8', undefined],
      ]);
      // ACCEPTANCE F3: exactly 8, in this order (P3 adds the two work-order items).
      expect(s.kpis.needsAttention).toEqual({ value: 8, overdueTasks: 3, urgent: 3 });
    });

    it('F4 trucks down panel: Truck 118, 17 days, ACC-2026-016, towed to Prairie State', async () => {
      const s = await svc.summary(SM, { range: '90d' });
      expect(s.trucksDown).toHaveLength(1);
      const t = s.trucksDown[0]!;
      expect([t.unit, t.number, R.downtimeLabel(t.downMs), t.location]).toEqual(['118', 'ACC-2026-016', '17 days', 'Prairie State Truck & Body, Joliet']);
    });

    it('F5 chips and filters', async () => {
      const nums = async (q: A.BoardQuery) => (await svc.board(SM, q)).items.map((r) => r.number);
      expect(await nums({ chip: 'open' })).toEqual(['ACC-2026-018', 'ACC-2026-017', 'ACC-2026-016']);
      expect((await nums({ chip: 'serious' })).sort()).toEqual(['ACC-2026-016', 'ACC-2026-018']);
      expect((await svc.board(SM, {})).draftsCount).toBe(0);
      expect(await nums({ chip: 'open', q: '118' })).toEqual(['ACC-2026-016']);
      expect(await nums({ chip: 'open', truckDown: 'true' })).toEqual(['ACC-2026-016']);
      expect(await nums({ chip: 'all', range: '90d' })).toHaveLength(7);
    });

    it('F6 DOT register: 90 days (with hazmat) and 12 months; CSV has the same rows', async () => {
      const r90 = await svc.register(SM, { range: '90d' });
      expect(r90.map((r) => r.caseNumber)).toEqual(['ACC-2026-018', 'ACC-2026-016', 'ACC-2026-015', 'ACC-2026-013']);
      expect(r90[0]).toMatchObject({ cityOrNearest: 'Merrillville', state: 'IN', driverName: 'Daniel Okafor', injuriesTreatedAway: 2, fatalities: 0, hazmatReleased: 'No' });
      expect((await svc.register(SM, { range: '12m' })).map((r) => r.caseNumber)).toEqual(expected().board['12m'].dotRegister);
      const csv = registerCsv(r90).trim().split('\n');
      expect(csv).toHaveLength(5);
      expect(csv[1]).toContain('ACC-2026-018');
    });

    it('F7 urgent stripe on cases with an urgent attention item (016, 018)', async () => {
      const rows = (await svc.board(SM, { chip: 'open' })).items;
      expect(rows.filter((r) => r.urgent).map((r) => r.number).sort()).toEqual(['ACC-2026-016', 'ACC-2026-018']);
    });
  });

  // ================================================================================== N, E (fixture cases)

  describe('N — narrative summary and E — gates on the showcase cases', () => {
    const caseId = (n: string) => fx(p1Seed().cases.find((c) => c.number === n)!.id);
    const notClaims = (t: string) => !/claims? (is|are) linked|No insurance claim/.test(t);

    it('N every summary sentence except the claims one (P2) matches the fixture, with provenance', async () => {
      const e = EXPECTED;
      for (const n of ['ACC-2026-008', 'ACC-2026-015', 'ACC-2026-016', 'ACC-2026-017', 'ACC-2026-018']) {
        const d = await svc.detail(SM, caseId(n));
        const got = d.computed.summaryParts.filter((p) => notClaims(p.text)).map((p) => ({ prov: p.prov, restricted: Boolean(p.restricted), text: p.text }));
        const want = (e.cases[n].summaryForAuthorized as { prov: string; restricted: boolean; text: string }[]).filter((p) => notClaims(p.text));
        expect(got, n).toEqual(want);
      }
    });

    it('N spot checks: 016 first and next-action sentences; 015 closed by Rachel Moore', async () => {
      const d = await svc.detail(SM, caseId('ACC-2026-016'));
      expect(d.computed.summaryParts[0]!.text).toBe(
        'On Oct 2, 2026 at 3:45 PM CDT, Truck 118 (driver Andre Lewis, trailer T-5310, load L-47982) struck the rear of the vehicle ahead on I-80 EB near MM 127 (Houbolt Rd) near Channahon, IL.',
      );
      expect(d.computed.summaryParts.at(-1)!.text).toBe('Next: Request ECM / engine data download from Prairie State — Fleet, Dmitri Volkov, due Oct 16.');
      const c15 = await svc.detail(SM, caseId('ACC-2026-015'));
      expect(c15.computed.summaryParts.at(-1)!.text).toBe('Case closed Oct 12 by Rachel Moore.');
    });

    it('N / K6 (P1 part) ACC-2026-018 as Dispatch: medical sentence restricted, no restricted value anywhere in the JSON', async () => {
      const d = await svc.detail(DISPATCH, caseId('ACC-2026-018'));
      const restricted = d.computed.summaryParts.filter((p) => p.restricted).map((p) => p.text);
      expect(restricted).toEqual(['Medical details are restricted.']);
      expect(d.redacted).toContain('injuries.medicalDetails');
      const json = JSON.stringify(d) + JSON.stringify(await svc.events(DISPATCH, caseId('ACC-2026-018')));
      for (const secret of ['neck pain', 'Attorney letter', 'transported by EMS']) expect(json).not.toContain(secret);
      expect((await svc.events(DISPATCH, caseId('ACC-2026-018'))).some((e) => e.text === 'Restricted entry')).toBe(true);
      const sm = JSON.stringify(await svc.detail(SM, caseId('ACC-2026-018')));
      expect(sm).toContain('neck pain');
    });

    it('case detail values match the fixture: DOT, testing, suggested severity, downtime, next action, repeat signals', async () => {
      const e = EXPECTED;
      for (const n of ['ACC-2026-008', 'ACC-2026-015', 'ACC-2026-016', 'ACC-2026-017', 'ACC-2026-018']) {
        const d = await svc.detail(SM, caseId(n));
        const x = e.cases[n];
        expect(d.case.stage, n).toBe(x.stage);
        expect(d.computed.dotRecordable, n).toEqual(x.dot);
        for (const k of ['alcohol', 'drug'] as const) {
          const t = d.computed.testing[k];
          expect({ required: t.required, reason: t.reason, documented: t.documented, deadline: t.deadline }, `${n} ${k}`).toEqual(x.testing[k]);
        }
        expect(d.computed.suggestedSeverity, n).toEqual(x.suggested);
        expect(+(d.computed.downtime.truckMs / R.DAY).toFixed(2), n).toBe(x.downtime.truckDays);
        expect(d.computed.nextAction ? { title: d.computed.nextAction.title, dept: d.computed.nextAction.dept, assignee: d.computed.nextAction.assignee?.name, due: d.computed.nextAction.dueAt } : null, n).toEqual(x.nextAction);
        expect(d.computed.repeatSignals.sameDriver.map((r) => r.number), n).toEqual(x.repeatSignals.sameDriver);
      }
    });

    it('E3 ACC-2026-016 (Investigation): blocker "Investigation is not complete and approved"', async () => {
      const d = await svc.detail(SM, caseId('ACC-2026-016'));
      expect(d.computed.advanceBlockers.map((b) => b.text)).toEqual(['Investigation is not complete and approved']);
    });

    it('E5 / E6 close blockers of 016 and 018 equal the fixture (incl. the work-order blocker, P3)', async () => {
      const e = EXPECTED;
      for (const n of ['ACC-2026-016', 'ACC-2026-018']) {
        const d = await svc.detail(SM, caseId(n));
        expect(d.computed.closeBlockers.map((b) => b.text), n).toEqual(e.cases[n].closeBlockers.map((b: string | { text: string }) => (typeof b === 'string' ? b : b.text)));
      }
    });

    it('E4 ACC-2026-017: close blocked exactly by 1 corrective action + 1 task; complete both → close needs the outcome → closed', async () => {
      const id = caseId('ACC-2026-017');
      let d = await svc.detail(SM, id);
      expect(d.computed.closeBlockers.map((b) => b.text)).toEqual(['1 corrective action still open', '1 task still open']);
      const blocked = await err(svc.stage(SM, id, { version: d.version, to: 'closed', outcome: 'x' }));
      expect([blocked.status, blocked.type]).toEqual([422, '/problems/stage-blocked']);
      const open = (await tasks.list(SM, { accidentId: id, status: 'open' }))[0]!;
      await tasks.patch(SM, open.id, { version: open.version, status: 'done' });
      // Corrective actions get their endpoints in P4; here the open one is completed as P4 would record it.
      await db.update(safetyReviews).set({ status: 'completed', completedAt: FIXTURE_CLOCK }).where(and(eq(safetyReviews.companyId, FIXTURE_COMPANY), eq(safetyReviews.accidentId, id)));
      d = await svc.detail(SM, id);
      expect(d.computed.closeBlockers).toEqual([]);
      const noOutcome = await err(svc.stage(SM, id, { version: d.version, to: 'closed' }));
      expect([noOutcome.status, noOutcome.detail]).toEqual([422, 'Write the final outcome']);
      await svc.stage(SM, id, { version: d.version, to: 'closed', outcome: 'Coaching completed; fairing repaired.', prevention: 'Backing module for the terminal.' });
      d = await svc.detail(SM, id);
      expect(d.case.stage).toBe('closed');
      expect(d.case.closure).toMatchObject({ outcome: 'Coaching completed; fairing repaired.', prevention: 'Backing module for the terminal.' });
      expect(d.computed.summaryParts.at(-1)!.text).toBe('Case closed Oct 19 by Rachel Moore.');
    });
  });

  // ================================================================================== A, E — quick report (report company)

  describe('A — quick report and E — gates on a new case', () => {
    const TZ = 'America/Indiana/Indianapolis';
    const a4 = (extra: Partial<A.ReportInput> = {}): A.ReportInput => ({
      submit: true,
      truckId: 'acc2r_t125',
      driverId: 'acc2r_d1',
      trailerId: 'acc2r_tl5318',
      loadId: 'acc2r_l48213',
      occurredAtLocal: localAt(-23, TZ),
      occurredTz: TZ,
      publicRoad: 'yes',
      road: 'I-65 S',
      city: 'Lafayette',
      state: 'IN',
      description: 'Traffic stopped near the work zone; truck hit the back of a box truck.',
      injuries: 'no',
      towAway: 'yes',
      truckCondition: 'not_drivable',
      cargo: 'unknown',
      police: 'yes',
      citation: null,
      hazmat: 'no',
      ...extra,
    });
    let a5: A.ReportResponse;

    it('A1 Truck 125 fills driver, trailer and load from its current assignment', async () => {
      const r = await svc.assignment(RSM, { truckId: 'acc2r_t125' });
      expect(r).toMatchObject({ driverId: 'acc2r_d1', trailerId: 'acc2r_tl5318', loadId: 'acc2r_l48213', source: 'current assignment' });
      expect(r.note).toBe(
        'Filled from Truck 125’s current assignment: John Smith, trailer T-5318, load L-48213 (Chicago, IL → Columbus, OH). Change anything that was different at the time of the accident.',
      );
    });

    it('A2 driver Marcus Bell first → Truck 131', async () => {
      expect((await svc.assignment(RSM, { driverId: 'acc2r_d7' })).truckId).toBe('acc2r_t131');
      const pick = await svc.pickers(RSM);
      const t = pick.trucks.find((x) => x.id === 'acc2r_t131')!;
      expect([t.unit, t.driverName, t.status]).toEqual(['131', 'Marcus Bell', 'dispatched']);
    });

    it('A3 is N/A: NeWay has no telematics collision events (IMPLEMENTATION-PLAN §8 deviation 3)', () => {
      expect(true).toBe(true);
    });

    it('A4 live check and seven prompts; hazmat prefilled No from the load record', async () => {
      const p = await svc.preview(RSM, a4({ hazmat: null }));
      expect(p.dotRecordable).toMatchObject({ value: 'yes', reasons: ['A vehicle was towed away with disabling damage'] });
      expect([p.testing.alcohol.required, p.testing.alcohol.reason]).toEqual(['pending', 'Required only if our driver is cited within 8 hours — confirm citation status']);
      expect([p.testing.drug.required, p.testing.drug.reason]).toEqual(['pending', 'Required only if our driver is cited within 32 hours — confirm citation status']);
      expect(p.suggestedSeverity).toEqual({ value: 'serious', why: 'Disabling damage — tow-away' });
      expect(p.prompts.map((x) => [x.key, x.dept])).toEqual([
        ['test', 'Safety'],
        ['tow', 'Fleet'],
        ['load', 'Dispatch'],
        ['video', 'Safety'],
        ['statement', 'Safety'],
        ['police', 'Safety'],
        ['insurer', 'Claims'],
      ]);
      expect(p.prompts[2]!.label).toBe('Notify Lakeshore Freight Brokerage and plan the load (repower / transload)');
      expect(p.hazmatPrefill).toEqual({ value: 'no', hint: 'Load L-48213 is not a hazmat load (load record)' });
    });

    it('A5 submit: Initial response, 9 open tasks, a Dispatch request (board unchanged), downtime opened, two milestones', async () => {
      a5 = await svc.report(RSM, a4({ prompts: ['test', 'tow', 'load', 'video', 'statement', 'police', 'insurer'].map((key) => ({ key, create: true })) }));
      expect([a5.stage, a5.tasksCreated, a5.requestsCreated]).toEqual(['initial_response', 9, 1]);
      // On top of the board (newest occurred first; the report company keeps earlier runs' cases — more than a page of
      // them with the same fixture time — so "top" = nothing newer than it on the first page).
      const mine = await svc.board(RSM, { chip: 'open', q: a5.number });
      expect(mine.items[0]).toMatchObject({ id: a5.id, isNew: true });
      const board = await svc.board(RSM, { chip: 'open' });
      expect(board.items.every((r, i) => i === 0 || board.items[i - 1]!.occurredAt >= r.occurredAt)).toBe(true);
      const ts = await tasks.list(RSM, { accidentId: a5.id, status: 'all' });
      const ordinary = ts.filter((t) => !t.requestKind);
      expect(ordinary.filter((t) => t.status === 'open')).toHaveLength(9);
      expect(ordinary.map((t) => t.title)).toEqual(expect.arrayContaining(['Confirm the facts and assign an investigator', 'Management review of serious incident']));
      for (const t of ordinary.filter((x) => x.autoRule === 'Quick report')) {
        const hours = (Date.parse(t.dueAt) - NOW) / HOUR;
        expect(t.priority, t.title).toBe(hours <= 8 ? 'high' : 'normal');
      }
      const req = ts.find((t) => t.requestKind === 'unit_unavailable')!;
      expect([req.dept, req.priority, req.status, req.assignee]).toEqual(['Dispatch', 'high', 'open', null]);
      const dt = await db.select().from(downtimePeriods).where(eq(downtimePeriods.accidentId, a5.id));
      expect(dt.map((d) => [d.unitId, d.source, d.endedAt, d.verifiedBy])).toEqual([['acc2r_t125', 'entered', null, null]]);
      const ev = await svc.events(RSM, a5.id);
      const occurred = ev.find((e) => e.text === 'Accident occurred')!;
      const reported = ev.find((e) => e.text === 'Accident reported in NeWay')!;
      expect(occurred.occurredAt).toBe(new Date(NOW - 23 * 60_000).toISOString());
      expect(reported.occurredAt).toBe(FIXTURE_CLOCK.toISOString());
      expect(reported.loggedAt).toBe(FIXTURE_CLOCK.toISOString());
      // The Daily board is not touched: the truck's status in the roster is unchanged.
      const [t125] = await db.select({ status: trucks.status }).from(trucks).where(eq(trucks.id, 'acc2r_t125'));
      expect(t125!.status).toBe('dispatched');
    });

    it('A6 a prompt marked done is created done and not counted', async () => {
      const r = await svc.report(RSM, a4({ prompts: [{ key: 'statement', create: true, done: true }] }));
      expect(r.tasksCreated).toBe(8);
      const st = (await tasks.list(RSM, { accidentId: r.id, status: 'all' })).find((t) => t.title === 'Collect the driver’s written statement')!;
      expect([st.status, st.completedBy]).toEqual(['done', 'Sam Safety']);
    });

    it('A7 empty submit: field errors, nothing saved', async () => {
      const before = (await db.select({ n: sql<number>`count(*)::int` }).from(safetyAccidents).where(eq(safetyAccidents.companyId, REPORT_CO)))[0]!.n;
      const e = await err(svc.report(RSM, { submit: true }));
      expect(e.status).toBe(422);
      expect((e.extensions!.errors as { path: string }[]).map((x) => x.path)).toEqual(['truckId', 'occurredAtLocal', 'road', 'state', 'description']);
      const after = (await db.select({ n: sql<number>`count(*)::int` }).from(safetyAccidents).where(eq(safetyAccidents.companyId, REPORT_CO)))[0]!.n;
      expect(after).toBe(before);
    });

    it('A8 ten minutes in the future is refused; five is allowed', async () => {
      const e = await err(svc.report(RSM, a4({ occurredAtLocal: localAt(10, TZ) })));
      expect(e.detail).toBe('This time is in the future — check the time zone');
      expect((await svc.report(RSM, a4({ occurredAtLocal: localAt(4, TZ), isTest: true }))).stage).toBe('initial_response');
    });

    let draft: A.ReportResponse;
    it('A9 a draft (truck only) is only under Drafts: no tasks, downtime or requests, not in the KPIs; 2 h later it needs attention', async () => {
      const kpiBefore = (await svc.summary(RSM, { range: '90d' })).kpis.reported.value;
      draft = await svc.report(RSM, { submit: false, truckId: 'acc2r_t131', occurredTz: 'America/Chicago', occurredAtLocal: localAt(-30, 'America/Chicago') });
      expect([draft.stage, draft.tasksCreated, draft.requestsCreated]).toEqual(['draft', 0, 0]);
      expect((await svc.board(RSM, { chip: 'open' })).items.some((r) => r.id === draft.id)).toBe(false);
      expect((await svc.board(RSM, { chip: 'drafts' })).items.map((r) => r.id)).toContain(draft.id);
      expect(await db.select().from(safetyTasks).where(eq(safetyTasks.accidentId, draft.id))).toHaveLength(0);
      expect(await db.select().from(downtimePeriods).where(eq(downtimePeriods.accidentId, draft.id))).toHaveLength(0);
      expect((await svc.summary(RSM, { range: '90d' })).kpis.reported.value).toBe(kpiBefore);
      core.clock = () => new Date(NOW + 2 * HOUR + 60_000);
      const later = await svc.summary(RSM, { range: '90d' });
      core.clock = () => new Date(FIXTURE_CLOCK);
      expect(later.attention.some((a) => a.reason === 'Draft not submitted' && a.caseId === draft.id)).toBe(true);
    });

    it('A10 finishing the draft from its page submits with the same side effects', async () => {
      const r = await svc.submit(RSM, draft.id, {
        version: draft.version,
        report: { driverId: 'acc2r_d7', road: 'I-71 N', city: 'Columbus', state: 'OH', description: 'Clipped a parked trailer while turning into the dock.', injuries: 'no', towAway: 'no', truckCondition: 'drivable', cargo: 'no_damage', citation: 'no', police: 'no', publicRoad: 'no', occurredTz: 'America/New_York', occurredAtLocal: localAt(-30, 'America/New_York') },
      });
      expect(r.stage).toBe('initial_response');
      expect(r.tasksCreated).toBeGreaterThanOrEqual(2);
      const ev = await svc.events(RSM, draft.id);
      expect(ev.map((e) => e.text)).toEqual(expect.arrayContaining(['Draft report started', 'Draft submitted — accident reported', 'Accident occurred']));
    });

    it('A11 discarding a draft voids it ("Draft discarded"); the row stays, nothing is deleted', async () => {
      const d = await svc.report(RSM, { submit: false, description: 'Started by mistake', occurredTz: 'America/Chicago', occurredAtLocal: localAt(-10, 'America/Chicago') });
      const draftsBefore = (await svc.board(RSM, { chip: 'drafts' })).total;
      await svc.discard(RSM, d.id, { version: d.version });
      expect((await svc.board(RSM, { chip: 'drafts' })).total).toBe(draftsBefore - 1);
      const [row] = await db.select().from(safetyAccidents).where(eq(safetyAccidents.id, d.id));
      expect([row!.voidReason, Boolean(row!.voidedAt)]).toEqual(['Draft discarded', true]);
      expect((await err(svc.detail(RSM, d.id))).status).toBe(404);
    });

    it('A12 split-zone state: TN defaults to Central with the confirm hint', async () => {
      const p = await svc.preview(RSM, { state: 'TN' });
      expect(p.zone).toEqual({ tz: 'America/Chicago', confirmHint: 'TN has more than one time zone — confirm' });
    });

    it('A13 a time in the spring-forward gap is an error; a fall-back time needs CDT or CST', async () => {
      const gap = await err(svc.report(RSM, a4({ occurredTz: 'America/Chicago', occurredAtLocal: '2026-03-08T02:30', state: 'IL' })));
      expect(gap.detail).toBe('This time does not exist in Central time on Mar 8 — clocks moved forward');
      const twice = await err(svc.report(RSM, a4({ occurredTz: 'America/Chicago', occurredAtLocal: '2025-11-02T01:30', state: 'IL' })));
      expect((twice.extensions!.options as { abbr: string }[]).map((o) => o.abbr)).toEqual(['CDT', 'CST']);
      const ok = await svc.report(RSM, a4({ occurredTz: 'America/Chicago', occurredAtLocal: '2025-11-02T01:30', occurredChoice: 'CST', state: 'IL', isTest: true }));
      const [row] = await db.select({ at: safetyAccidents.occurredAt }).from(safetyAccidents).where(eq(safetyAccidents.id, ok.id));
      expect(row!.at.toISOString()).toBe('2025-11-02T07:30:00.000Z');
    });

    let a15: A.ReportResponse;
    it('A15 fatalities blank stays unknown (null, never 0): testing pending, DOT yes, register says Not known', async () => {
      a15 = await svc.report(RSM, a4({ injuries: 'yes', treatedAway: 2, fatalities: null, towAway: 'no', citation: 'no', truckCondition: 'drivable', cargo: 'no_damage' }));
      const [row] = await db.select().from(safetyAccidents).where(eq(safetyAccidents.id, a15.id));
      expect([row!.fatalitiesCount, row!.treatedAwayCount]).toEqual([null, 2]);
      const d = await svc.detail(RSM, a15.id);
      expect([d.computed.testing.alcohol.required, d.computed.testing.alcohol.reason]).toEqual(['pending', 'Waiting on fatalities — required if anyone died']);
      expect(d.computed.dotRecordable.value).toBe('yes');
      const reg = (await svc.register(RSM, { range: '30d' })).find((r) => r.accidentId === a15.id)!;
      expect(reg.fatalities).toBeNull();
      expect(registerCsv([reg])).toContain('Not known');
    });

    it('A16 fatalities 0 → not required; 1 → required and Critical (severity follows the facts)', async () => {
      let d = await svc.detail(RSM, a15.id);
      await svc.patch(RSM, a15.id, { version: d.version, fatalities: 0 });
      d = await svc.detail(RSM, a15.id);
      expect([d.computed.testing.alcohol.required, d.computed.testing.alcohol.reason]).toEqual(['no', 'Injury treated away, but our driver was not cited']);
      await svc.patch(RSM, a15.id, { version: d.version, fatalities: 1 });
      d = await svc.detail(RSM, a15.id);
      expect([d.computed.testing.alcohol.required, d.computed.testing.alcohol.reason]).toEqual(['yes', 'Fatality — test required whether or not a citation is issued']);
      expect(d.case.severity).toBe('critical');
    });

    it('A17 not on a road open to public travel → DOT No and testing not required; the change is logged', async () => {
      let d = await svc.detail(RSM, a15.id);
      await svc.patch(RSM, a15.id, { version: d.version, publicRoad: 'no' });
      d = await svc.detail(RSM, a15.id);
      expect(d.computed.dotRecordable).toMatchObject({ value: 'no', reasons: ['Not on a road open to public travel'] });
      expect(d.computed.testing.alcohol.reason).toBe('Not on a road open to public travel — 382.303 does not apply (company policy may still call for a test)');
      expect((await svc.events(RSM, a15.id)).map((e) => e.text)).toContain('DOT recordable re-evaluated: No');
    });

    it('E1 the A5 case: blockers to Investigation are cargo and the two pending test decisions', async () => {
      const d = await svc.detail(RSM, a5.id);
      expect(d.computed.advanceBlockers.map((b) => [b.text, b.tab])).toEqual([
        ['Cargo status is unknown', 'equipment'],
        ['Post-accident alcohol test decision is pending', 'incident'],
        ['Post-accident drug test decision is pending', 'incident'],
      ]);
    });

    it('E2 citation No + cargo No damage → ready; the move is logged', async () => {
      let d = await svc.detail(RSM, a5.id);
      await svc.patch(RSM, a5.id, { version: d.version, citation: 'no', cargo: 'no_damage' });
      d = await svc.detail(RSM, a5.id);
      expect(d.computed.advanceBlockers).toEqual([]);
      await svc.stage(RSM, a5.id, { version: d.version, to: 'investigation' });
      expect((await svc.events(RSM, a5.id)).map((e) => e.text)).toContain('Stage: Initial response → Investigation');
    });

    it('E7 Ops Manager cannot override (403); without a reason the gate answers 422 stage-blocked', async () => {
      const d = await svc.detail(ROPS, a5.id);
      const blocked = await err(svc.stage(ROPS, a5.id, { version: d.version, to: 'resolution' }));
      expect([blocked.status, blocked.type, blocked.extensions!.canOverride]).toEqual([422, '/problems/stage-blocked', false]);
      const over = await err(svc.stage(ROPS, a5.id, { version: d.version, to: 'resolution', overrideReason: 'Ops wants it moved' }));
      expect([over.status, over.detail]).toEqual([403, 'Overriding stage conditions is restricted']);
    });

    it('E8 Safety Manager overrides with a reason; the event and the audit keep it', async () => {
      const d = await svc.detail(RSM, a5.id);
      await svc.stage(RSM, a5.id, { version: d.version, to: 'resolution', overrideReason: 'Investigation handled by the insurer' });
      expect((await svc.events(RSM, a5.id)).map((e) => e.text)).toContain('Stage: Investigation → Resolution (override: Investigation handled by the insurer)');
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, a5.id), eq(auditLogs.action, 'accident_stage_changed')));
      const override = audits.find((x) => x.reason === 'Investigation handled by the insurer');
      expect(override?.summary).toContain('skipped: Investigation is not complete and approved');
    });

    it('E10 close (override, outcome) then reopen with a reason → Resolution, closure cleared', async () => {
      let d = await svc.detail(RSM, a5.id);
      await svc.stage(RSM, a5.id, { version: d.version, to: 'closed', overrideReason: 'Closing for the test', outcome: 'Closed for the test' });
      d = await svc.detail(RSM, a5.id);
      const [row] = await db.select().from(safetyAccidents).where(eq(safetyAccidents.id, a5.id));
      expect((row!.closeSkippedBlockers as string[]).length).toBeGreaterThan(0);
      // A reason is required (HTTP validation: ReasonSchema).
      expect(A.ReasonSchema.safeParse({ version: d.version, reason: '' }).success).toBe(false);
      await svc.reopen(RSM, a5.id, { version: d.version, reason: 'Repair invoice still to come' });
      d = await svc.detail(RSM, a5.id);
      expect([d.case.stage, d.case.closure]).toEqual(['resolution', undefined]);
    });

    it('E11 close administratively: Safety Manager only, reason and skipped blockers stored', async () => {
      const d = await svc.detail(RSM, a15.id);
      expect((await err(svc.closeAdministratively(ROPS, a15.id, { version: d.version, reason: 'Duplicate' }))).status).toBe(403);
      await svc.closeAdministratively(RSM, a15.id, { version: d.version, reason: 'Duplicate of another report' });
      const [row] = await db.select().from(safetyAccidents).where(eq(safetyAccidents.id, a15.id));
      expect([row!.closeKind, row!.closeReason, row!.stage]).toEqual(['administrative', 'Duplicate of another report', 'closed']);
      expect((row!.closeSkippedBlockers as string[]).length).toBeGreaterThan(0);
    });

    it('E12 void refuses linked claims (409 linked-records); without links the case leaves board and register', async () => {
      const r = await svc.report(RSM, a4({ prompts: [] }));
      await db.insert(safetyClaims).values({ id: `clm_acc2_${r.id}`, companyId: REPORT_CO, number: `CLM-X-${r.number}`, kind: 'physical_damage', accidentId: r.id, accidentNumber: r.number, openedOn: '2026-10-19', isTest: true });
      let d = await svc.detail(RSM, r.id);
      const linked = await err(svc.void(RSM, r.id, { version: d.version, reason: 'Entered in error' }));
      expect([linked.status, linked.type]).toEqual([409, '/problems/linked-records']);
      const free = await svc.report(RSM, a4({ prompts: [] }));
      d = await svc.detail(RSM, free.id);
      await svc.void(RSM, free.id, { version: d.version, reason: 'Entered in error' });
      expect((await svc.board(RSM, { chip: 'all', range: '30d' })).items.some((x) => x.id === free.id)).toBe(false);
      expect((await svc.register(RSM, { range: '30d' })).some((x) => x.accidentId === free.id)).toBe(false);
    });
  });

  // ================================================================================== tasks, requests, versions, audit

  describe('tasks, requests, testing records, versions and audit', () => {
    let caseId = '';
    beforeAll(async () => {
      const r = await svc.report(RSM, {
        submit: true,
        truckId: 'acc2r_t131',
        driverId: 'acc2r_d7',
        occurredTz: 'America/Chicago',
        occurredAtLocal: localAt(-600, 'America/Chicago'),
        publicRoad: 'yes',
        city: 'Joliet',
        state: 'IL',
        description: 'Rear-ended at a light; the other car was towed.',
        injuries: 'no',
        towAway: 'yes',
        citation: 'yes',
        truckCondition: 'drivable',
        cargo: 'no_damage',
        police: 'yes',
      });
      caseId = r.id;
    });

    it('reassigning an ordinary task moves it to the assignee’s department; a request stays in Dispatch', async () => {
      const t = await tasks.create(RSM, { accidentId: caseId, title: 'Photograph the bumper', dept: 'Safety', dueAt: new Date(NOW + 5 * HOUR).toISOString() });
      expect(t.assignee?.name).toBe('Sam Safety');
      const moved = await tasks.patch(RSM, t.id, { version: t.version, assigneeId: 'usr_acc2r_fleet' });
      expect([moved.dept, moved.assignee?.name]).toEqual(['Fleet', 'Fred Fleet']);
      const req = await svc.request(RSM, caseId, { kind: 'repower_transload', note: 'Load must deliver tonight' });
      expect([req.dept, req.priority, (Date.parse(req.dueAt) - NOW) / HOUR, req.requestKind]).toEqual(['Dispatch', 'high', 3, 'repower_transload']);
      const across = await err(tasks.patch(RSM, req.id, { version: req.version, assigneeId: 'usr_acc2r_fleet' }));
      expect(across.status).toBe(422);
      const within = await tasks.patch(RSM, req.id, { version: req.version, assigneeId: 'usr_acc2r_disp' });
      expect([within.dept, within.assignee?.name]).toEqual(['Dispatch', 'Dina Dispatch']);
      const done = await err(tasks.patch(RSM, req.id, { version: within.version, status: 'done' }));
      expect(done.status).toBe(422);
      expect((await err(tasks.confirm(RSM, req.id, { version: within.version }))).status).toBe(403);
      const confirmed = await tasks.confirm(RDISP, req.id, { version: within.version, note: 'Repowered with Truck 125' });
      expect([confirmed.status, confirmed.confirmedBy]).toEqual(['done', 'Dina Dispatch']);
      expect((await svc.events(RSM, caseId)).map((e) => e.text)).toContain('Dispatch confirmed: Repower / transload the load (' + (await svc.detail(RSM, caseId)).case.number + ') — Repowered with Truck 125');
    });

    it('an assignee with view access may complete their own task, nothing else', async () => {
      const t = await tasks.create(RSM, { accidentId: caseId, title: 'Send tow invoice', dept: 'Fleet', assigneeId: 'usr_acc2r_fleet', dueAt: new Date(NOW + HOUR).toISOString() });
      expect((await err(tasks.patch(RFLEET, t.id, { version: t.version, dueAt: new Date(NOW + 9 * HOUR).toISOString() }))).status).toBe(403);
      const done = await tasks.patch(RFLEET, t.id, { version: t.version, status: 'done' });
      expect([done.status, done.completedBy]).toEqual(['done', 'Fred Fleet']);
    });

    it('O5 a stale version is refused with 409 version-conflict and the current version', async () => {
      const d = await svc.detail(RSM, caseId);
      await svc.patch(RSM, caseId, { version: d.version, weather: 'Rain' });
      const stale = await err(svc.patch(RSM, caseId, { version: d.version, weather: 'Snow' }));
      expect([stale.status, stale.type, stale.extensions!.currentVersion]).toEqual([409, '/problems/version-conflict', d.version + 1]);
    });

    it('O6 each case write leaves exactly one audit entry', async () => {
      const count = async () =>
        (await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(and(eq(auditLogs.companyId, REPORT_CO), eq(auditLogs.entityId, caseId))))[0]!.n;
      let d = await svc.detail(RSM, caseId);
      let n = await count();
      await svc.patch(RSM, caseId, { version: d.version, roadSurface: 'Wet' });
      expect(await count()).toBe(n + 1);
      d = await svc.detail(RSM, caseId);
      n = await count();
      await svc.severity(RSM, caseId, { version: d.version, severity: 'critical', reason: 'Bus involved' });
      expect(await count()).toBe(n + 1);
      n = await count();
      await svc.logEvent(RSM, caseId, { text: 'Called the other driver’s insurer', source: 'Safety' });
      expect(await count()).toBe(n + 1);
    });

    it('D-extra manual severity stops auto-updates; auto resumes them', async () => {
      let d = await svc.detail(RSM, caseId);
      expect([d.case.severity, d.case.severityManual?.reason]).toEqual(['critical', 'Bus involved']);
      await svc.patch(RSM, caseId, { version: d.version, towAway: 'no' });
      d = await svc.detail(RSM, caseId);
      expect(d.case.severity).toBe('critical');
      await svc.severity(RSM, caseId, { version: d.version, auto: true });
      d = await svc.detail(RSM, caseId);
      expect([d.case.severity, d.case.severityManual]).toEqual(['serious', undefined]);
    });

    it('C (record) alcohol given 5 h after needs the delay reason; after 8 h is refused; results need accidents.restricted', async () => {
      let d = await svc.detail(RSM, caseId);
      const occ = Date.parse(d.case.occurredAt);
      const late = await err(svc.test(RSM, caseId, 'alcohol', { version: d.version, administeredAt: new Date(occ + 5 * HOUR).toISOString() }));
      expect(late.detail).toBe('Given more than 2 hours after the accident — record why it was not given sooner (382.303(d)(1))');
      expect(late.status).toBe(422);
      const past = await err(svc.test(RSM, caseId, 'alcohol', { version: d.version, administeredAt: new Date(occ + 9 * HOUR).toISOString() }));
      expect(past.detail).toBe('Recorded test time is after the 8-hour limit — record why the test was not given instead');
      expect((await err(svc.test(ROPS, caseId, 'alcohol', { version: d.version, result: 'negative' }))).status).toBe(403);
      await svc.test(RSM, caseId, 'alcohol', { version: d.version, administeredAt: new Date(occ + 50 * 60_000).toISOString(), result: 'negative' });
      d = await svc.detail(ROPS, caseId);
      expect(d.case.testing.alcohol.resultRestricted).toBeUndefined();
      expect(d.redacted).toContain('testing.alcohol.result');
      expect((await svc.events(ROPS, caseId)).some((e) => e.text === 'Restricted entry')).toBe(true);
      expect((await svc.detail(RSM, caseId)).case.testing.alcohol.resultRestricted).toBe('negative');
    });

    it('Dispatch may change only cargo and load fields', async () => {
      const d = await svc.detail(RDISP, caseId);
      await svc.patch(RDISP, caseId, { version: d.version, cargoPlan: 'repower', cargoDeliveryImpact: 'delivered 3 h late' });
      const d2 = await svc.detail(RDISP, caseId);
      expect((await err(svc.patch(RDISP, caseId, { version: d2.version, injuries: 'yes' }))).status).toBe(403);
    });

    it('summary override stores the facts hash; a later fact change marks it stale', async () => {
      let d = await svc.detail(RSM, caseId);
      await svc.summaryOverride(RSM, caseId, { version: d.version, text: 'Edited summary.' });
      d = await svc.detail(RSM, caseId);
      expect([d.case.summaryOverride?.text, d.computed.summaryStale]).toEqual(['Edited summary.', false]);
      await svc.patch(RSM, caseId, { version: d.version, injuries: 'yes', treatedAway: 1, fatalities: 0 });
      expect((await svc.detail(RSM, caseId)).computed.summaryStale).toBe(true);
    });

    it('HTTP: report with an Idempotency-Key twice creates one case; the board reads it back', async () => {
      // The company the dev headers act as: whichever company owns a test draft created over HTTP.
      const probe = await call('POST', BASE, { submit: false, isTest: true, description: 'Company probe (test data)' });
      expect(probe.statusCode, probe.body).toBe(201);
      const [own] = await db.select({ companyId: safetyAccidents.companyId }).from(safetyAccidents).where(eq(safetyAccidents.id, (probe.json() as A.ReportResponse).id));
      const [t] = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.companyId, own!.companyId)).limit(1);
      if (!t) throw new Error('The dev company needs a truck to test with');
      const key = `acc2-e2e-${Date.now()}`;
      const body = { submit: true, isTest: true, truckId: t!.id, occurredTz: 'America/Chicago', occurredAtLocal: localAt(-15, 'America/Chicago'), city: 'Joliet', state: 'IL', description: 'Idempotency probe — mirror clipped in the yard.', publicRoad: 'no', injuries: 'no', towAway: 'no', citation: 'no', cargo: 'na', truckCondition: 'drivable' };
      const first = await call('POST', BASE, body, { 'idempotency-key': key });
      expect(first.statusCode, first.body).toBe(201);
      const second = await call('POST', BASE, body, { 'idempotency-key': key });
      expect(second.statusCode).toBe(201);
      expect((second.json() as A.ReportResponse).id).toBe((first.json() as A.ReportResponse).id);
      const rows = await db.select({ id: safetyAccidents.id }).from(safetyAccidents).where(eq(safetyAccidents.idempotencyKey, key));
      expect(rows).toHaveLength(1);
      const board = await call('GET', `${BASE}?chip=open`);
      expect(board.statusCode).toBe(200);
      expect((board.json() as A.BoardResponse).items.find((r) => r.id === (first.json() as A.ReportResponse).id)?.isTest).toBe(true);
      const detail = await call('GET', `${BASE}/${(first.json() as A.ReportResponse).id}`);
      expect(detail.statusCode).toBe(200);
      const tl = await db.select().from(safetyTimelineEvents).where(eq(safetyTimelineEvents.accidentId, (first.json() as A.ReportResponse).id));
      expect(tl.length).toBeGreaterThanOrEqual(2);
      // The timeline is append-only in the database.
      await expect(db.delete(safetyTimelineEvents).where(eq(safetyTimelineEvents.id, tl[0]!.id))).rejects.toThrow();
    });
  });

  // ================================================================================== post-accident testing at intake (owner 2026-10-24)

  describe('intake question: Post-accident alcohol and drug test required?', () => {
    const FILE_ID = 'file_acc2r_pt_lab';
    const body = (pt: A.ReportInput['postAccidentTest']): A.ReportInput => ({
      submit: true,
      isTest: true,
      truckId: 'acc2r_t131',
      driverId: 'acc2r_d7',
      occurredTz: 'America/Chicago',
      occurredAtLocal: localAt(-60, 'America/Chicago'),
      publicRoad: 'yes',
      city: 'Joliet',
      state: 'IL',
      description: 'Box truck pulled out; our truck could not stop in time.',
      injuries: 'no',
      towAway: 'no',
      citation: 'no',
      truckCondition: 'drivable',
      cargo: 'no_damage',
      police: 'no',
      prompts: [],
      postAccidentTest: pt,
    });
    const testsOf = (id: string) => db.select().from(drugAlcoholTests).where(and(eq(drugAlcoholTests.companyId, REPORT_CO), eq(drugAlcoholTests.accidentId, id)));

    beforeAll(async () => {
      await db
        .insert(storedFiles)
        .values({ id: FILE_ID, companyId: REPORT_CO, fileName: 'lab-result.pdf', contentType: 'application/pdf', sizeBytes: 4, storageKey: 'test/acc2r/lab-result.pdf', uploadedBy: 'Sam Safety' })
        .onConflictDoNothing();
    });

    it('Yes with nothing submitted and no reason → 422; nothing is created', async () => {
      const e = await err(svc.report(RSM, body({ required: 'yes', fileId: null, notDoneReason: '  ' })));
      expect(e.status).toBe(422);
      expect((e.extensions?.errors as { path: string }[]).map((x) => x.path)).toEqual(['postAccidentTest.notDoneReason']);
    });

    it('Yes, not submitted, with a reason: both test records marked required and carry the reason; restricted timeline + audit', async () => {
      const r = await svc.report(RSM, body({ required: 'yes', notDoneReason: 'Driver was taken to hospital; no collector within 32 hours' }));
      const rows = await testsOf(r.id);
      expect(rows.map((t) => [t.substance, t.postAccidentDecision, t.required, t.notCompletedReason]).sort()).toEqual([
        ['alcohol', 'required', true, 'Driver was taken to hospital; no collector within 32 hours'],
        ['drug', 'required', true, 'Driver was taken to hospital; no collector within 32 hours'],
      ]);
      const d = await svc.detail(RSM, r.id);
      expect([d.case.testing.alcohol.decision, d.case.testing.alcohol.notAdministeredReason]).toEqual(['required', 'Driver was taken to hospital; no collector within 32 hours']);
      const tl = await db.select().from(safetyTimelineEvents).where(eq(safetyTimelineEvents.accidentId, r.id));
      const ev = tl.find((x) => x.text.startsWith(R.POST_ACCIDENT_TEST_QUESTION));
      expect([ev?.text, ev?.restricted]).toEqual([`${R.POST_ACCIDENT_TEST_QUESTION} Yes — not submitted: Driver was taken to hospital; no collector within 32 hours`, true]);
      const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, r.id), eq(auditLogs.action, 'accident_test_recorded')));
      expect(audit).toHaveLength(1);
    });

    it('Yes with the submission: the file is restricted test-record evidence, results stored; no reason needed', async () => {
      const r = await svc.report(RSM, body({ required: 'yes', fileId: FILE_ID, alcoholResult: 'negative', drugResult: 'pending' }));
      const rows = await testsOf(r.id);
      expect(rows.map((t) => [t.substance, t.result, t.notCompletedReason]).sort()).toEqual([
        ['alcohol', 'negative', null],
        ['drug', 'pending', null],
      ]);
      const docs = await db.select().from(safetyCaseDocuments).where(and(eq(safetyCaseDocuments.caseId, r.id), eq(safetyCaseDocuments.fileId, FILE_ID)));
      expect(docs.map((x) => [x.category, x.restricted])).toEqual([['Test record (restricted)', true]]);
    });

    it('results without accidents.restricted → 403; No is stored as "the rule decides"', async () => {
      expect((await err(svc.report(ROPS, body({ required: 'yes', fileId: FILE_ID, alcoholResult: 'negative' })))).status).toBe(403);
      const r = await svc.report(RSM, body({ required: 'no' }));
      const rows = await testsOf(r.id);
      expect(rows.map((t) => [t.substance, t.postAccidentDecision, t.required, t.decisionBy]).sort()).toEqual([
        ['alcohol', 'auto', false, 'Sam Safety'],
        ['drug', 'auto', false, 'Sam Safety'],
      ]);
    });

    it('a draft submitted later is held to the same rule', async () => {
      const draft = await svc.report(RSM, { ...body(undefined), submit: false });
      const e = await err(svc.submit(RSM, draft.id, { version: draft.version, report: { postAccidentTest: { required: 'yes' } } }));
      expect(e.status).toBe(422);
      const ok = await svc.submit(RSM, draft.id, { version: draft.version, report: { postAccidentTest: { required: 'yes', notDoneReason: 'Collector site closed for the holiday' } } });
      expect(ok.stage).toBe('initial_response');
      expect((await testsOf(draft.id)).map((t) => t.notCompletedReason)).toEqual(['Collector site closed for the holiday', 'Collector site closed for the holiday']);
    });
  });
});

/** The second TEST company for the quick-report flows: fictional units, a load and four people with roles. */
async function setupReportCompany(db: DatabaseService['db']) {
  await db.insert(companies).values({ id: REPORT_CO, name: 'Accidents v2 report flows (TEST, fictional)', timezone: 'America/New_York', weekStart: 'monday' }).onConflictDoNothing();
  const truck = (id: string, unit: string, driverId: string | null, trailerId: string | null, loadId: string | null) => ({
    id,
    companyId: REPORT_CO,
    unitNumber: unit,
    vin: `ACC2TEST${unit}VIN000`,
    year: 2022,
    make: 'Freightliner',
    model: 'Cascadia',
    status: 'dispatched',
    health: 'good',
    ownership: 'company',
    odometer: 100000,
    odometerAt: new Date('2026-10-01T00:00:00Z'),
    engineHours: '1000',
    nextServiceOdometer: 110000,
    nextServiceDate: '2026-12-01',
    nextServiceType: 'PM A',
    telematicsProvider: 'none',
    telematicsStatus: 'none',
    currentDriverId: driverId,
    currentTrailerId: trailerId,
    currentLoadId: loadId,
  });
  await db.insert(trucks).values([truck('acc2r_t125', '125', 'acc2r_d1', 'acc2r_tl5318', 'acc2r_l48213'), truck('acc2r_t131', '131', 'acc2r_d7', null, null)]).onConflictDoNothing();
  const driver = (id: string, n: string, first: string, last: string, truckId: string) => ({
    id,
    companyId: REPORT_CO,
    driverNumber: `ACC2-${n}`,
    firstName: first,
    lastName: last,
    phone: '(555) 010-0000',
    email: `${id}@acc2.test`,
    driverType: 'company',
    cdlState: 'IL',
    cdlClass: 'A',
    cdlExpiresOn: '2028-01-01',
    cdlStatus: 'valid',
    medicalCardStatus: 'valid',
    hireDate: '2024-01-01',
    status: 'active',
    dispatcherId: '',
    dispatcherName: '',
    homeCity: 'Chicago',
    homeState: 'IL',
    payPlanKind: 'per_mile',
    currentTruckId: truckId,
  });
  await db.insert(drivers).values([driver('acc2r_d1', '1', 'John', 'Smith', 'acc2r_t125'), driver('acc2r_d7', '7', 'Marcus', 'Bell', 'acc2r_t131')]).onConflictDoNothing();
  await db.insert(trailers).values({ id: 'acc2r_tl5318', companyId: REPORT_CO, unitNumber: 'T-5318' }).onConflictDoNothing();
  await db
    .insert(loads)
    .values({
      id: 'acc2r_l48213',
      companyId: REPORT_CO,
      loadNumber: 'L-48213',
      status: 'in_transit',
      truckId: 'acc2r_t125',
      driverId: 'acc2r_d1',
      record: {
        customerName: 'Great Plains Paper Co.',
        brokerName: 'Lakeshore Freight Brokerage',
        commodity: 'Paper towels & tissue',
        hazmat: false,
        stops: [
          { kind: 'pickup', city: 'Chicago', state: 'IL' },
          { kind: 'delivery', city: 'Columbus', state: 'OH' },
        ],
      },
    })
    .onConflictDoNothing();
  const person = async (userId: string, first: string, last: string, role: string) => {
    await db.insert(users).values({ id: userId, email: `${userId}@acc2.test`, firstName: first, lastName: last }).onConflictDoNothing();
    const membershipId = `mem_${userId}`;
    await db.insert(memberships).values({ id: membershipId, companyId: REPORT_CO, userId, status: 'active' }).onConflictDoNothing();
    await db.insert(membershipRoles).values({ membershipId, roleId: `rol_${role}` }).onConflictDoNothing();
  };
  await person('usr_acc2r_sm', 'Sam', 'Safety', 'safety_manager');
  await person('usr_acc2r_ops', 'Olga', 'Ops', 'operations_manager');
  await person('usr_acc2r_disp', 'Dina', 'Dispatch', 'dispatch_lead');
  await person('usr_acc2r_fleet', 'Fred', 'Fleet', 'fleet_manager');
}
