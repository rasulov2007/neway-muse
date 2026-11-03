import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { SafetyAccident, SafetyViolation, SafetyViolationCase } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { auditLogs } from '../src/database/schema/people';
import { drivers, trucks } from '../src/database/schema/roster';
import { safetyAccidents, safetyReviews, safetyViolations } from '../src/database/schema/safety';
import { mergeViolationCase } from '../src/modules/safety/violation-case-merge';

const BASE = '/api/v1/safety';
const HOUR = 3_600_000;

/**
 * One inspection paper, one case (owner, 2026-10-21), end to end against the real API and the
 * local database: a paper with three violations is one case with one driver review, and the
 * one-off merge puts violations entered one by one back into one case. Everything is `isTest`.
 */
describe('Violation cases (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let companyId = '';
  let driverId = '';
  let truckId = '';
  const run = Date.now().toString(36).toUpperCase();

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });

  const paper = (report: string) => ({
    occurredAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    reportNumber: report,
    violationType: 'inspection',
    issuedTo: 'driver',
    state: 'TN',
    inspectionLevel: 1,
    driverId,
    truckId,
    isTest: true,
  });

  beforeAll(async () => {
    setFeatureFlagForTests('safety_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const probe = await call('POST', `${BASE}/accidents`, { occurredAt: new Date(Date.now() - HOUR).toISOString(), location: 'Probe', isTest: true });
    expect(probe.statusCode, probe.body).toBe(201);
    const [row] = await db.select({ companyId: safetyAccidents.companyId }).from(safetyAccidents).where(eq(safetyAccidents.id, (probe.json() as SafetyAccident).id));
    companyId = row!.companyId;
    const [d] = await db.select({ id: drivers.id }).from(drivers).where(and(eq(drivers.companyId, companyId), isNull(drivers.archivedAt))).limit(1);
    const [t] = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.companyId, companyId)).limit(1);
    if (!d || !t) throw new Error('The dev company needs a driver and a truck to test with');
    driverId = d.id;
    truckId = t.id;
  });

  afterAll(async () => {
    setFeatureFlagForTests('safety_v2', null);
    await app.close();
  });

  it('records one paper with three violations as one case with one driver review', async () => {
    const report = `TNI-E2E-${run}`;
    const res = await call('POST', `${BASE}/violation-cases`, {
      ...paper(report),
      lines: [
        { code: '392.9A2-C', description: 'Failing to secure load', category: 'vehicle_maintenance', oos: true },
        { code: '393.47E', description: 'Clamp or roto-chamber type brake(s) out of adjustment', category: 'vehicle_maintenance' },
        { code: '393.53B-B', description: 'Automatic brake adjuster CMV manufactured on or after 10/20/1993', category: 'vehicle_maintenance' },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json() as SafetyViolationCase;
    expect(created.violations).toHaveLength(3);
    expect(created.caseId).toMatch(/^vcs_/);
    expect(created.summary).toBe('3 violations: 392.9A2-C (OOS), 393.47E, 393.53B-B');
    expect(created.state).toBe('TN');
    expect(created.inspectionLevel).toBe(1);
    expect(created.reviewNumber).toMatch(/^REV-/);
    // Three rows, one review.
    const rows = await db.select().from(safetyViolations).where(and(eq(safetyViolations.companyId, companyId), eq(safetyViolations.reportNumber, report)));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.caseId)).size).toBe(1);
    expect(new Set(rows.map((r) => r.reviewId)).size).toBe(1);
    expect(rows.every((r) => r.state === 'TN' && r.inspectionLevel === 1 && r.agency === '')).toBe(true);
    expect(rows.filter((r) => r.oos).map((r) => r.code)).toEqual(['392.9A2-C']);
    const reviews = await db
      .select()
      .from(safetyReviews)
      .where(and(eq(safetyReviews.companyId, companyId), eq(safetyReviews.linkedType, 'violation'), inArray(safetyReviews.linkedId, rows.map((r) => r.id)), isNull(safetyReviews.voidedAt)));
    expect(reviews).toHaveLength(1);
    // The list returns one case for the paper; each violation keeps its own fields.
    const list = await call('GET', `${BASE}/violation-cases`);
    expect(list.statusCode, list.body).toBe(200);
    const mine = (list.json() as SafetyViolationCase[]).filter((c) => c.reportNumber === report);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.violations.map((v) => v.code)).toEqual(['392.9A2-C', '393.47E', '393.53B-B']);
    expect(mine[0]!.status).toBe('undecided');
    // A case opens by its key, or by any of its violations.
    const byKey = await call('GET', `${BASE}/violation-cases/${created.id}`);
    expect((byKey.json() as SafetyViolationCase).violations).toHaveLength(3);
    const byRow = await call('GET', `${BASE}/violation-cases/${created.violations[2]!.id}`);
    expect((byRow.json() as SafetyViolationCase).id).toBe(created.id);
  });

  it('keeps a paper with one violation a case of its own, and refuses a state that is not a US state', async () => {
    const res = await call('POST', `${BASE}/violation-cases`, { ...paper(`ONE-${run}`), lines: [{ code: '395.8', description: 'Log not current' }] });
    expect(res.statusCode, res.body).toBe(201);
    const one = res.json() as SafetyViolationCase;
    expect(one.caseId).toBeNull();
    expect(one.id).toBe(one.leadId);
    const bad = await call('POST', `${BASE}/violation-cases`, { ...paper(`BAD-${run}`), state: 'XX', lines: [{ description: 'Nope' }] });
    expect(bad.statusCode).toBe(422);
  });

  describe('delete = void (owner, 2026-10-21)', () => {
    const lines = [
      { code: '392.9A2-C', description: 'Failing to secure load', oos: true },
      { code: '393.47E', description: 'Brake out of adjustment' },
      { code: '393.53B-B', description: 'Automatic brake adjuster' },
    ];
    const newCase = async (report: string) => {
      const res = await call('POST', `${BASE}/violation-cases`, { ...paper(report), lines });
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as SafetyViolationCase;
    };
    const versions = (c: SafetyViolationCase) => Object.fromEntries(c.violations.map((v) => [v.id, v.version]));
    const listed = async (report: string) => ((await call('GET', `${BASE}/violation-cases`)).json() as SafetyViolationCase[]).filter((c) => c.reportNumber === report);

    it('voids one violation in a case: the case keeps two, the review stays', async () => {
      const report = `DEL1-${run}`;
      const c = await newCase(report);
      const second = c.violations[1]!;
      const res = await call('POST', `${BASE}/violations/${second.id}/void`, { version: second.version, reason: 'Entered twice' });
      expect(res.statusCode, res.body).toBe(201);
      expect((res.json() as SafetyViolation).voidedAt).toBeTruthy();
      const [after] = await listed(report);
      expect(after!.violations.map((v) => v.code)).toEqual(['392.9A2-C', '393.53B-B']);
      expect(after!.summary).toBe('2 violations: 392.9A2-C (OOS), 393.53B-B');
      const [review] = await db.select().from(safetyReviews).where(eq(safetyReviews.id, c.reviewId!));
      expect(review!.voidedAt).toBeNull();
      // Stale and short reasons are refused.
      const stale = await call('POST', `${BASE}/violations/${c.violations[0]!.id}/void`, { version: 99, reason: 'Nope' });
      expect(stale.statusCode).toBe(409);
      const short = await call('POST', `${BASE}/violations/${c.violations[0]!.id}/void`, { version: 1, reason: 'no' });
      expect(short.statusCode).toBe(422);
      // The audit says who, when and why.
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, second.id), eq(auditLogs.action, 'violation_voided')));
      expect(audits[0]?.reason).toBe('Entered twice');
    });

    it('voids the whole case and its driver review; the list drops it', async () => {
      const report = `DELC-${run}`;
      const c = await newCase(report);
      const stale = await call('POST', `${BASE}/violation-cases/${c.id}/void`, { versions: { ...versions(c), [c.leadId]: 7 }, reason: 'Test paper' });
      expect(stale.statusCode).toBe(409);
      const res = await call('POST', `${BASE}/violation-cases/${c.id}/void`, { versions: versions(c), reason: 'Test paper' });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toEqual({ voided: c.violations.map((v) => v.number), reviewsVoided: [c.reviewNumber] });
      expect(await listed(report)).toHaveLength(0);
      expect((await call('GET', `${BASE}/violation-cases/${c.id}`)).statusCode).toBe(404);
      const [review] = await db.select().from(safetyReviews).where(eq(safetyReviews.id, c.reviewId!));
      expect(review!.voidedAt).toBeTruthy();
      expect(review!.voidReason).toBe('Test paper');
      // Kept on record.
      const rows = await db.select().from(safetyViolations).where(eq(safetyViolations.reportNumber, report));
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.voidedAt && r.voidReason === 'Test paper')).toBe(true);
    });

    it('refuses, writing nothing, when the review has progressed or money went to Accounting', async () => {
      const report = `DELR-${run}`;
      const c = await newCase(report);
      await db.update(safetyReviews).set({ status: 'in_progress' }).where(eq(safetyReviews.id, c.reviewId!));
      const res = await call('POST', `${BASE}/violation-cases/${c.id}/void`, { versions: versions(c), reason: 'Test paper' });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain(`driver review ${c.reviewNumber}`);
      expect(res.body).toContain('in progress');
      expect(await listed(report)).toHaveLength(1);
      // Voiding one of three leaves the review in use, so that one goes through.
      const one = c.violations[2]!;
      expect((await call('POST', `${BASE}/violations/${one.id}/void`, { version: one.version, reason: 'Duplicate' })).statusCode).toBe(201);
      // Money with Accounting blocks it.
      await db.update(safetyViolations).set({ moneySentAt: new Date(), moneyKind: 'charge' }).where(eq(safetyViolations.id, c.violations[1]!.id));
      const money = await call('POST', `${BASE}/violations/${c.violations[1]!.id}/void`, { version: c.violations[1]!.version, reason: 'Duplicate' });
      expect(money.statusCode).toBe(409);
      expect(money.body).toContain('sent to Accounting');
      expect((await listed(report))[0]!.violations).toHaveLength(2);
    });
  });

  describe('merge-violation-case', () => {
    const actor = { userId: 'system:merge-violation-case', userName: 'Merge violation case (test)' };

    /** The production shape: three violations entered one by one, three reviews. */
    async function enteredOneByOne(report: string): Promise<SafetyViolation[]> {
      const out: SafetyViolation[] = [];
      for (const code of ['392.9A2-C', '393.47E', '393.53B-B']) {
        const res = await call('POST', `${BASE}/violations`, { ...paper(report), state: null, inspectionLevel: null, code, description: `Violation ${code}`, oos: code === '392.9A2-C' });
        expect(res.statusCode, res.body).toBe(201);
        out.push(res.json() as SafetyViolation);
      }
      expect(new Set(out.map((v) => v.reviewId)).size).toBe(3);
      return out;
    }

    const snapshot = async (report: string) => {
      const rows = await db.select().from(safetyViolations).where(and(eq(safetyViolations.companyId, companyId), eq(safetyViolations.reportNumber, report)));
      const reviews = await db.select().from(safetyReviews).where(and(eq(safetyReviews.companyId, companyId), inArray(safetyReviews.linkedId, rows.map((r) => r.id))));
      return JSON.stringify({ rows: rows.sort((a, b) => a.id.localeCompare(b.id)), reviews: reviews.sort((a, b) => a.id.localeCompare(b.id)) });
    };

    it('dry run changes nothing; confirm merges into the earliest review; a second run is a no-op', async () => {
      const report = `MRG-${run}`;
      const vs = await enteredOneByOne(report);
      const before = await snapshot(report);

      const dry = await mergeViolationCase(db, { companyId, reportNumber: report, confirm: false, now: new Date(), actor, state: 'TN', inspectionLevel: 1 });
      expect(dry.outcome).toBe('planned');
      expect(dry.keeper?.number).toBe(vs[0]!.reviewNumber);
      expect(dry.toVoid.map((r) => r.number)).toEqual([vs[1]!.reviewNumber, vs[2]!.reviewNumber]);
      expect(await snapshot(report)).toBe(before);

      const applied = await mergeViolationCase(db, { companyId, reportNumber: report, confirm: true, now: new Date(), actor, state: 'TN', inspectionLevel: 1 });
      expect(applied.outcome, applied.lines.join('\n')).toBe('applied');
      const rows = await db.select().from(safetyViolations).where(and(eq(safetyViolations.companyId, companyId), eq(safetyViolations.reportNumber, report)));
      expect(new Set(rows.map((r) => r.caseId)).size).toBe(1);
      expect(rows[0]!.caseId).toMatch(/^vcs_/);
      expect(rows.every((r) => r.reviewId === vs[0]!.reviewId && r.reviewNumber === vs[0]!.reviewNumber)).toBe(true);
      expect(rows.every((r) => r.state === 'TN' && r.inspectionLevel === 1)).toBe(true);
      const voided = await db.select().from(safetyReviews).where(inArray(safetyReviews.id, [vs[1]!.reviewId!, vs[2]!.reviewId!]));
      expect(voided.every((r) => r.voidedAt && r.voidReason === `Merged into ${vs[0]!.reviewNumber}: one inspection paper, one case (owner, 2026-10-21)`)).toBe(true);
      const [kept] = await db.select().from(safetyReviews).where(eq(safetyReviews.id, vs[0]!.reviewId!));
      expect(kept!.voidedAt).toBeNull();
      // One audit line per changed violation and per voided review.
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, companyId), inArray(auditLogs.entityId, [...rows.map((r) => r.id), vs[1]!.reviewId!, vs[2]!.reviewId!]), eq(auditLogs.actorId, actor.userId)));
      expect(audits).toHaveLength(5);
      // The list now shows one case.
      const list = (await call('GET', `${BASE}/violation-cases`)).json() as SafetyViolationCase[];
      expect(list.filter((c) => c.reportNumber === report)).toHaveLength(1);

      const after = await snapshot(report);
      const again = await mergeViolationCase(db, { companyId, reportNumber: report, confirm: true, now: new Date(), actor, state: 'TN', inspectionLevel: 1 });
      expect(again.outcome).toBe('nothing_to_do');
      expect(await snapshot(report)).toBe(after);
    });

    it('refuses, writing nothing, when a review to void has progressed', async () => {
      const report = `REF-${run}`;
      const vs = await enteredOneByOne(report);
      await db.update(safetyReviews).set({ status: 'in_progress', notes: 'Talked to the driver' }).where(eq(safetyReviews.id, vs[2]!.reviewId!));
      const before = await snapshot(report);
      const res = await mergeViolationCase(db, { companyId, reportNumber: report, confirm: true, now: new Date(), actor, state: 'TN', inspectionLevel: 1 });
      expect(res.outcome).toBe('refused');
      expect(res.refusals.join(' ')).toContain(`${vs[2]!.reviewNumber} cannot be voided`);
      expect(res.refusals.join(' ')).toContain('in progress');
      expect(res.refusals.join(' ')).toContain('has notes');
      expect(await snapshot(report)).toBe(before);
    });

    it('says when nothing carries the report', async () => {
      const res = await mergeViolationCase(db, { companyId, reportNumber: `NONE-${run}`, confirm: false, now: new Date(), actor });
      expect(res.outcome).toBe('not_found');
    });
  });
});
