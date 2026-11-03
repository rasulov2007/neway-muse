import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type {
  SafetyAccident,
  SafetyCaseDetail,
  SafetyClaim,
  SafetyDrugTest,
  SafetyOverview,
  SafetyReview,
  SafetyRoadsideInspection,
  SafetyViolation,
} from '@neway/shared';
import { PERMISSION_CODES } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { workOrders } from '../src/database/schema/fleet';
import { companies, drivers, trucks } from '../src/database/schema/roster';
import { safetyAccidents, safetyAccountingEntries, safetyClaims } from '../src/database/schema/safety';
import { AccidentsService } from '../src/modules/safety/accidents.service';
import { ClaimsService } from '../src/modules/safety/claims.service';
import { DrugTestsService } from '../src/modules/safety/tests.service';
import { accountWithPermissions } from './fleet-reader-account';

const BASE = '/api/v1/safety';
const HOUR = 3_600_000;

/**
 * Safety v2, end to end against the real API and the local database.
 *
 * The flows the owner named (2026-10-02): accident → post-accident tests (alcohol and drug apart,
 * on their own clocks) → claim → work order → driver review → close; roadside → violation →
 * correction and review; claim money as suggestions Accounting confirms; restricted test results;
 * two companies that cannot see each other; and every stale write refused.
 *
 * Everything it creates is marked `isTest`, so no live total counts it.
 */
describe('Safety v2 (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let companyId = '';
  let driverId = '';
  let truckId = '';
  const OTHER = 'co_safety_probe';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload ? { payload } : {}) });

  const principal = (company: string, permissions: string[]): Principal => ({
    userId: 'usr_safety_probe',
    userName: 'Safety probe',
    companyId: company,
    companyTimezone: 'America/New_York',
    weekStart: 1,
    roles: [],
    permissions: new Set(permissions),
  });

  beforeAll(async () => {
    setFeatureFlagForTests('safety_v2', true);
    // This suite drives the Safety v2 writers; with accidents_v2 on they are read-only (legacy-rows spec covers that).
    setFeatureFlagForTests('accidents_v2', false);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;

    // The company the dev headers act as: whichever company owns a probe accident.
    const probe = await call('POST', `${BASE}/accidents`, { occurredAt: new Date(Date.now() - HOUR).toISOString(), location: 'Probe', isTest: true });
    expect(probe.statusCode, probe.body).toBe(201);
    const [row] = await db.select({ companyId: safetyAccidents.companyId }).from(safetyAccidents).where(eq(safetyAccidents.id, (probe.json() as SafetyAccident).id));
    companyId = row!.companyId;
    const [d] = await db.select({ id: drivers.id }).from(drivers).where(and(eq(drivers.companyId, companyId), isNull(drivers.archivedAt))).limit(1);
    const [t] = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.companyId, companyId)).limit(1);
    if (!d || !t) throw new Error('The dev company needs a driver and a truck to test with');
    driverId = d.id;
    truckId = t.id;
    await db.insert(companies).values({ id: OTHER, name: 'Safety probe (second company)', timezone: 'America/New_York', weekStart: 'monday' }).onConflictDoNothing();
  });

  afterAll(async () => {
    setFeatureFlagForTests('safety_v2', null);
    setFeatureFlagForTests('accidents_v2', null);
    await app.close();
  });

  it('is unreachable with the flag off', async () => {
    setFeatureFlagForTests('safety_v2', false);
    const res = await call('GET', `${BASE}/accidents`);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('safety_v2');
    setFeatureFlagForTests('safety_v2', true);
  });

  it('refuses a role without safety.view, and writes without safety.manage', async () => {
    const read = await call('GET', `${BASE}/accidents`, undefined, { 'x-demo-role': 'operations' });
    expect(read.statusCode).toBe(403);
    const write = await call('POST', `${BASE}/accidents`, { occurredAt: new Date().toISOString(), location: 'Nope' }, { 'x-demo-role': 'operations' });
    expect(write.statusCode).toBe(403);
  });

  it('lets everybody who works the fleet read the inspections, and only Safety write them (owner, 2026-10-10)', async () => {
    const fleet = { 'x-account': await accountWithPermissions(app, ['trucks.view', 'trailers.view'], 'Fleet reader') };
    for (const url of [`${BASE}/roadside`, `${BASE}/compliance/vehicles`, `${BASE}/pickers`]) {
      const res = await call('GET', url, undefined, fleet);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
      expect((await call('GET', url, undefined, { 'x-demo-role': 'operations' })).statusCode, url).toBe(403);
    }
    const write = await call('POST', `${BASE}/roadside`, { inspectedAt: new Date().toISOString() }, fleet);
    expect(write.statusCode).toBe(403);
    // The rest of Safety stays with Safety.
    expect((await call('GET', `${BASE}/accidents`, undefined, fleet)).statusCode).toBe(403);
  });

  describe('accident → testing → claim → repair → review → close', () => {
    let accident: SafetyAccident;
    const occurred = new Date(Date.now() - HOUR);

    it('assesses alcohol and drug separately and opens one test record each', async () => {
      const res = await call('POST', `${BASE}/accidents`, {
        occurredAt: occurred.toISOString(),
        location: 'I-80 mile 112, Joliet, IL',
        city: 'Joliet',
        state: 'IL',
        driverId,
        truckId,
        description: 'Rear-ended at low speed',
        injuries: 1,
        injuriesTreatedAway: 1,
        disablingTow: true,
        citationIssued: true,
        citationAt: new Date(occurred.getTime() + 30 * 60_000).toISOString(),
        isTest: true,
      });
      expect(res.statusCode, res.body).toBe(201);
      accident = res.json() as SafetyAccident;
      expect(accident.number).toMatch(/^ACC-\d{3,}$/);
      expect(accident.dotRecordable).toBe(true);
      expect(accident.testing.alcohol.required).toBe('yes');
      expect(accident.testing.drug.required).toBe('yes');
      expect(accident.tests.map((t) => t.substance).sort()).toEqual(['alcohol', 'drug']);
      expect(accident.stage).toBe('reported');
      expect(accident.nextAction).toBeTruthy();
      expect(accident.nextActionDueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('says the citation time is needed instead of guessing', async () => {
      const res = await call('POST', `${BASE}/accidents`, {
        occurredAt: occurred.toISOString(),
        location: 'Probe — citation without time',
        injuriesTreatedAway: 1,
        citationIssued: true,
        isTest: true,
      });
      const a = res.json() as SafetyAccident;
      expect(a.testing.alcohol.required).toBe('undetermined');
      expect(a.tests).toHaveLength(0);
      expect(a.closeBlockers.join(' ')).toMatch(/citation/i);
    });

    it('keeps one test per substance when the facts are saved again', async () => {
      const res = await call('PATCH', `${BASE}/accidents/${accident.id}`, { version: accident.version, description: 'Rear-ended at low speed; airbag deployed' });
      expect(res.statusCode, res.body).toBe(200);
      accident = res.json() as SafetyAccident;
      expect(accident.tests).toHaveLength(2);
    });

    it('refuses a stale write with 409 and leaves the record as it was', async () => {
      const res = await call('PATCH', `${BASE}/accidents/${accident.id}`, { version: accident.version - 1, location: 'Overwritten' });
      expect(res.statusCode).toBe(409);
      const again = (await call('GET', `${BASE}/accidents/${accident.id}`)).json() as SafetyCaseDetail<SafetyAccident>;
      expect(again.record.location).toBe('I-80 mile 112, Joliet, IL');
    });

    it('cannot pass Testing assessed until each required test is collected or excused', async () => {
      for (let i = 0; i < 2; i += 1) {
        const r = await call('POST', `${BASE}/accidents/${accident.id}/advance`, { version: accident.version });
        expect(r.statusCode, r.body).toBe(201);
        accident = r.json() as SafetyAccident;
      }
      expect(accident.stage).toBe('testing');
      const blocked = await call('POST', `${BASE}/accidents/${accident.id}/advance`, { version: accident.version });
      expect(blocked.statusCode).toBe(409);
      expect((blocked.json() as { missing: string[] }).missing.length).toBe(2);
    });

    it('refuses an alcohol collection after 8 hours and records the ones in time', async () => {
      const alcohol = accident.tests.find((t) => t.substance === 'alcohol')!;
      const drug = accident.tests.find((t) => t.substance === 'drug')!;
      const detail = (await call('GET', `${BASE}/tests/${alcohol.id}`)).json() as SafetyCaseDetail<SafetyDrugTest>;
      const late = await call('PATCH', `${BASE}/tests/${alcohol.id}`, { version: detail.record.version, collectedAt: new Date(occurred.getTime() + 9 * HOUR).toISOString() });
      expect(late.statusCode).toBe(422);

      const ok = await call('PATCH', `${BASE}/tests/${alcohol.id}`, { version: detail.record.version, collectedAt: new Date(occurred.getTime() + 40 * 60_000).toISOString(), result: 'negative' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((ok.json() as SafetyDrugTest).status.resolved).toBe(true);

      const drugDetail = (await call('GET', `${BASE}/tests/${drug.id}`)).json() as SafetyCaseDetail<SafetyDrugTest>;
      const collected = await call('PATCH', `${BASE}/tests/${drug.id}`, { version: drugDetail.record.version, collectedAt: new Date(occurred.getTime() + 50 * 60_000).toISOString() });
      expect(collected.statusCode, collected.body).toBe(200);
      expect((collected.json() as SafetyDrugTest).status.progress).toBe('result_pending');

      accident = ((await call('GET', `${BASE}/accidents/${accident.id}`)).json() as SafetyCaseDetail<SafetyAccident>).record;
      const moved = await call('POST', `${BASE}/accidents/${accident.id}/advance`, { version: accident.version });
      expect(moved.statusCode, moved.body).toBe(201);
      accident = moved.json() as SafetyAccident;
      expect(accident.stage).toBe('repairs_claim');
    });

    it('hides results from a caller without safety_testing.view, on the server', async () => {
      const tests = app.get(DrugTestsService);
      const viewer = principal(companyId, ['safety.view']);
      const list = await tests.list(viewer);
      const mine = list.filter((t) => t.accidentId === accident.id);
      expect(mine.length).toBe(2);
      for (const t of mine) {
        expect(t.result).toBeNull();
        expect(t.resultRestricted).toBe(true);
      }
      const full = await tests.list(principal(companyId, ['safety.view', 'safety_testing.view']));
      expect(full.find((t) => t.accidentId === accident.id && t.substance === 'alcohol')?.result).toBe('negative');
    });

    it('opens one claim per accident, however many times it is asked', async () => {
      const first = await call('POST', `${BASE}/accidents/${accident.id}/claim`, { kind: 'physical_damage' });
      expect(first.statusCode, first.body).toBe(201);
      const a = first.json() as { claim: SafetyClaim; created: boolean };
      expect(a.created).toBe(true);
      expect(a.claim.accidentNumber).toBe(accident.number);
      expect(a.claim.driverId).toBe(driverId);
      const second = await call('POST', `${BASE}/accidents/${accident.id}/claim`, { kind: 'physical_damage' });
      const b = second.json() as { claim: SafetyClaim; created: boolean };
      expect(b.created).toBe(false);
      expect(b.claim.id).toBe(a.claim.id);
      const count = await db.select({ id: safetyClaims.id }).from(safetyClaims).where(and(eq(safetyClaims.accidentId, accident.id), isNull(safetyClaims.voidedAt)));
      expect(count).toHaveLength(1);
      accident = ((await call('GET', `${BASE}/accidents/${accident.id}`)).json() as SafetyCaseDetail<SafetyAccident>).record;
      expect(accident.claimNumber).toBe(a.claim.number);
    });

    it('links an existing work order by reference', async () => {
      const [wo] = await db.select({ id: workOrders.id, number: workOrders.number }).from(workOrders).where(and(eq(workOrders.companyId, companyId), isNull(workOrders.voidedAt))).limit(1);
      if (!wo) return; // A development database without a single work order: nothing to link.
      const res = await call('POST', `${BASE}/accidents/${accident.id}/work-order`, { version: accident.version, workOrderId: wo.id });
      expect(res.statusCode, res.body).toBe(201);
      accident = res.json() as SafetyAccident;
      expect(accident.workOrderNumber).toBe(wo.number);
    });

    it('opens the driver review on reaching Review, and closing waits for it and the drug result', async () => {
      const toReview = await call('POST', `${BASE}/accidents/${accident.id}/advance`, { version: accident.version });
      expect(toReview.statusCode, toReview.body).toBe(201);
      accident = toReview.json() as SafetyAccident;
      expect(accident.stage).toBe('review');
      expect(accident.reviewNumber).toMatch(/^REV-/);

      const close = await call('POST', `${BASE}/accidents/${accident.id}/close`, { version: accident.version, kind: 'normal' });
      expect(close.statusCode).toBe(409);
      const missing = (close.json() as { missing: string[] }).missing.join(' | ');
      expect(missing).toMatch(/drug/i);
      expect(missing).toMatch(/preventability/i);
      expect(missing).toMatch(/review/i);

      // The review cannot complete without preventability and an outcome.
      let review = ((await call('GET', `${BASE}/reviews/${accident.reviewId}`)).json() as SafetyCaseDetail<SafetyReview>).record;
      const early = await call('POST', `${BASE}/reviews/${review.id}/complete`, { version: review.version });
      expect(early.statusCode).toBe(409);
      const decided = await call('PATCH', `${BASE}/reviews/${review.id}`, { version: review.version, preventability: 'not_preventable', outcome: 'Other driver ran the light; dash cam confirms.' });
      expect(decided.statusCode, decided.body).toBe(200);
      review = decided.json() as SafetyReview;
      const done = await call('POST', `${BASE}/reviews/${review.id}/complete`, { version: review.version });
      expect(done.statusCode, done.body).toBe(201);

      // The drug result arrives.
      const drug = ((await call('GET', `${BASE}/accidents/${accident.id}`)).json() as SafetyCaseDetail<SafetyAccident>).record.tests.find((t) => t.substance === 'drug')!;
      const drugRow = ((await call('GET', `${BASE}/tests/${drug.id}`)).json() as SafetyCaseDetail<SafetyDrugTest>).record;
      const result = await call('PATCH', `${BASE}/tests/${drug.id}`, { version: drugRow.version, result: 'negative' });
      expect(result.statusCode, result.body).toBe(200);

      accident = ((await call('GET', `${BASE}/accidents/${accident.id}`)).json() as SafetyCaseDetail<SafetyAccident>).record;
      expect(accident.preventability).toBe('not_preventable');
      expect(accident.closeBlockers).toEqual([]);
      const closed = await call('POST', `${BASE}/accidents/${accident.id}/advance`, { version: accident.version });
      expect(closed.statusCode, closed.body).toBe(201);
      expect((closed.json() as SafetyAccident).stage).toBe('closed');
    });

    it('keeps a timeline from the audit trail, and survives a fresh read', async () => {
      const detail = (await call('GET', `${BASE}/accidents/${accident.id}`)).json() as SafetyCaseDetail<SafetyAccident>;
      expect(detail.record.stage).toBe('closed');
      const actions = detail.timeline.map((t) => t.action);
      expect(actions).toContain('accident_reported');
      expect(actions).toContain('accident_stage_changed');
      expect(actions).toContain('accident_claim_linked');
      expect(actions).toContain('accident_closed');
    });
  });

  describe('post-accident testing exceptions', () => {
    it('needs a documented reason and an authorised Safety review once the window has passed', async () => {
      const res = await call('POST', `${BASE}/accidents`, {
        occurredAt: new Date(Date.now() - 10 * HOUR).toISOString(),
        location: 'Probe — fatality, alcohol window passed',
        driverId,
        fatalities: 1,
        isTest: true,
      });
      const a = res.json() as SafetyAccident;
      const alcohol = a.tests.find((t) => t.substance === 'alcohol')!;
      expect(alcohol.status.progress).toBe('not_completed');
      expect(alcohol.status.resolved).toBe(false);

      let test = ((await call('GET', `${BASE}/tests/${alcohol.id}`)).json() as SafetyCaseDetail<SafetyDrugTest>).record;
      const noReason = await call('POST', `${BASE}/tests/${alcohol.id}/exception-review`, { version: test.version, note: 'Reviewed' });
      expect(noReason.statusCode).toBe(409);

      const reason = await call('PATCH', `${BASE}/tests/${alcohol.id}`, { version: test.version, notCompletedReason: 'Driver hospitalised; collection site could not reach him within 8 hours' });
      expect(reason.statusCode, reason.body).toBe(200);
      test = reason.json() as SafetyDrugTest;
      expect(test.status.resolved).toBe(false);

      // A Safety user without the testing code cannot sign it off.
      const tests = app.get(DrugTestsService);
      await expect(tests.reviewException(principal(companyId, ['safety.view', 'safety.manage']), alcohol.id, { version: test.version, note: 'ok' })).rejects.toMatchObject({ status: 403 });

      const reviewed = await call('POST', `${BASE}/tests/${alcohol.id}/exception-review`, { version: test.version, note: 'Hospital record attached; exception accepted' });
      expect(reviewed.statusCode, reviewed.body).toBe(201);
      expect((reviewed.json() as SafetyDrugTest).status.resolved).toBe(true);
      expect((reviewed.json() as SafetyDrugTest).status.progress).toBe('exception_reviewed');
    });

    it('an administrative closure is explicit and carries what is left as a corrective action', async () => {
      const res = await call('POST', `${BASE}/accidents`, {
        occurredAt: new Date(Date.now() - HOUR).toISOString(),
        location: 'Probe — administrative close',
        driverId,
        fatalities: 1,
        isTest: true,
      });
      const a = res.json() as SafetyAccident;
      const normal = await call('POST', `${BASE}/accidents/${a.id}/close`, { version: a.version, kind: 'normal' });
      expect(normal.statusCode).toBe(409);
      const noReason = await call('POST', `${BASE}/accidents/${a.id}/close`, { version: a.version, kind: 'administrative', reason: 'short' });
      expect(noReason.statusCode).toBe(422);
      const admin = await call('POST', `${BASE}/accidents/${a.id}/close`, { version: a.version, kind: 'administrative', reason: 'Entered against the wrong carrier; investigation continues under the right one' });
      expect(admin.statusCode, admin.body).toBe(201);
      const closed = admin.json() as SafetyAccident;
      expect(closed.closeKind).toBe('administrative');
      // The tests are still there and still unresolved.
      expect(closed.tests.every((t) => !t.status.resolved)).toBe(true);
      const reviews = (await call('GET', `${BASE}/reviews?kind=corrective_action`)).json() as SafetyReview[];
      expect(reviews.some((r) => r.linkedId === a.id)).toBe(true);
    });
  });

  describe('claims and the money Accounting confirms', () => {
    let claim: SafetyClaim;

    it('keeps claimed, approved and received apart and suggests each once', async () => {
      const created = await call('POST', `${BASE}/claims`, { kind: 'cargo', description: 'Shortage on delivery', claimedCents: 250000, accidentId: null, loadId: null, isTest: true });
      expect(created.statusCode).toBe(422); // a cargo claim names its load or accident

      const res = await call('POST', `${BASE}/claims`, { kind: 'liability', description: 'Mirror strike in a yard', claimedCents: 800000, insurer: 'Insurer A', isTest: true });
      expect(res.statusCode, res.body).toBe(201);
      claim = (res.json() as { claim: SafetyClaim }).claim;
      expect(claim.number).toMatch(/^CLM-/);

      for (let i = 0; i < 3; i += 1) {
        const r = await call('POST', `${BASE}/claims/${claim.id}/advance`, { version: claim.version });
        expect(r.statusCode, r.body).toBe(201);
        claim = r.json() as SafetyClaim;
      }
      expect(claim.stage).toBe('decision');
      const blocked = await call('POST', `${BASE}/claims/${claim.id}/advance`, { version: claim.version });
      expect(blocked.statusCode).toBe(409);

      const decided = await call('PATCH', `${BASE}/claims/${claim.id}`, { version: claim.version, decision: 'partially_approved', approvedCents: 500000, deductibleCents: 100000 });
      expect(decided.statusCode, decided.body).toBe(200);
      claim = decided.json() as SafetyClaim;
      expect(claim.claimedCents).toBe(800000);
      expect(claim.approvedCents).toBe(500000);
      expect(claim.receivedCents).toBe(0);
      expect(claim.accountingEntries.filter((e) => e.state === 'pending_review').map((e) => e.kind).sort()).toEqual(['company_deductible', 'insurer_recovery_approved']);

      // Saving the same decision again is the same suggestion, not a second one.
      const again = await call('PATCH', `${BASE}/claims/${claim.id}`, { version: claim.version, decision: 'partially_approved', approvedCents: 500000 });
      claim = again.json() as SafetyClaim;
      const entries = await db.select().from(safetyAccountingEntries).where(eq(safetyAccountingEntries.claimId, claim.id));
      expect(entries).toHaveLength(2);
    });

    it('records a payment once, refuses the double click, and suggests it to Accounting', async () => {
      const pay = await call('POST', `${BASE}/claims/${claim.id}/payments`, { version: claim.version, receivedOn: '2026-10-01', amountCents: 300000, reference: 'CHK-1001' });
      expect(pay.statusCode, pay.body).toBe(201);
      const twice = await call('POST', `${BASE}/claims/${claim.id}/payments`, { version: claim.version, receivedOn: '2026-10-01', amountCents: 300000, reference: 'CHK-1001' });
      expect(twice.statusCode).toBe(409);
      claim = pay.json() as SafetyClaim;
      expect(claim.receivedCents).toBe(300000);
      expect(claim.remainingApprovedCents).toBe(200000);
      expect(claim.payments).toHaveLength(1);
      expect(claim.accountingEntries.some((e) => e.kind === 'insurer_payment_received' && e.amountCents === 300000)).toBe(true);
    });

    it('lets only accounting.edit confirm, and never posts by itself', async () => {
      const entry = claim.accountingEntries.find((e) => e.kind === 'insurer_payment_received')!;
      const claims = app.get(ClaimsService);
      await expect(claims.reviewEntry(principal(companyId, ['safety.view', 'safety.manage']), entry.id, 'confirmed', { version: entry.version })).rejects.toMatchObject({ status: 403 });
      const res = await call('POST', `${BASE}/accounting-entries/${entry.id}/confirm`, { version: entry.version, note: 'Matched to deposit' });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ state: 'confirmed' });
      const stale = await call('POST', `${BASE}/accounting-entries/${entry.id}/confirm`, { version: entry.version });
      expect(stale.statusCode).toBe(409);
    });
  });

  describe('roadside → violation → correction and review', () => {
    let inspection: SafetyRoadsideInspection;
    let violation: SafetyViolation;

    it('records an out-of-service inspection and a violation on it that opens a driver review', async () => {
      const res = await call('POST', `${BASE}/roadside`, {
        inspectedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        level: 2,
        reportNumber: 'IL-2026-0042',
        agency: 'Illinois State Police',
        driverId,
        truckId,
        oos: true,
        correctionDueOn: '2026-10-16',
        isTest: true,
      });
      expect(res.statusCode, res.body).toBe(201);
      inspection = res.json() as SafetyRoadsideInspection;
      expect(inspection.number).toMatch(/^INS-/);
      expect(inspection.status).toBe('open');

      const v = await call('POST', `${BASE}/roadside/${inspection.id}/violations`, { version: inspection.version, code: '393.47', description: 'Brake defect', issuedTo: 'carrier', oos: true });
      expect(v.statusCode, v.body).toBe(201);
      violation = v.json() as SafetyViolation;
      expect(violation.inspectionNumber).toBe(inspection.number);
      expect(violation.agency).toBe('Illinois State Police');
      expect(violation.issuedTo).toBe('carrier');
      expect(violation.driverId).toBe(driverId);
      expect(violation.correctionStatus).toBe('open');
      expect(violation.reviewNumber).toMatch(/^REV-/);
      expect(violation.openTracks).toEqual(['Correction']);

      const stale = await call('POST', `${BASE}/roadside/${inspection.id}/violations`, { version: inspection.version, description: 'Again', issuedTo: 'driver' });
      expect(stale.statusCode).toBe(409);
    });

    it('cannot certify the inspection or close the violation while the correction is open', async () => {
      inspection = ((await call('GET', `${BASE}/roadside/${inspection.id}`)).json() as SafetyCaseDetail<SafetyRoadsideInspection>).record;
      for (const stage of ['reviewed', 'defects_corrected']) {
        const r = await call('POST', `${BASE}/roadside/${inspection.id}/stage`, { version: inspection.version, stage });
        expect(r.statusCode, r.body).toBe(201);
        inspection = r.json() as SafetyRoadsideInspection;
      }
      const certify = await call('POST', `${BASE}/roadside/${inspection.id}/stage`, { version: inspection.version, stage: 'certified' });
      expect(certify.statusCode).toBe(409);
      const close = await call('POST', `${BASE}/violations/${violation.id}/close`, { version: violation.version });
      expect(close.statusCode).toBe(409);

      const corrected = await call('PATCH', `${BASE}/violations/${violation.id}`, { version: violation.version, correctionStatus: 'certified', citationDisposition: 'none' });
      expect(corrected.statusCode, corrected.body).toBe(200);
      violation = corrected.json() as SafetyViolation;
      expect(violation.openTracks).toEqual([]);
      const certified = await call('POST', `${BASE}/roadside/${inspection.id}/stage`, { version: inspection.version, stage: 'certified' });
      expect(certified.statusCode, certified.body).toBe(201);
      expect((certified.json() as SafetyRoadsideInspection).status).toBe('closed');

      // DataQs is its own track: filing it reopens nothing else but holds the close.
      const filed = await call('PATCH', `${BASE}/violations/${violation.id}`, { version: violation.version, dataqsStatus: 'filed' });
      violation = filed.json() as SafetyViolation;
      expect(violation.openTracks).toEqual(['DataQs']);
      expect(violation.dataqsFiledOn).toMatch(/^\d{4}-/);
      const denied = await call('PATCH', `${BASE}/violations/${violation.id}`, { version: violation.version, dataqsStatus: 'denied' });
      violation = denied.json() as SafetyViolation;
      const closed = await call('POST', `${BASE}/violations/${violation.id}/close`, { version: violation.version });
      expect(closed.statusCode, closed.body).toBe(201);
    });
  });

  describe('two companies', () => {
    it('cannot read or write each other\'s cases', async () => {
      const accidents = app.get(AccidentsService);
      const own = (await call('GET', `${BASE}/accidents`)).json() as SafetyAccident[];
      expect(own.length).toBeGreaterThan(0);
      const victim = own[0]!;

      const outsider = principal(OTHER, [...PERMISSION_CODES]);
      const seen = await accidents.list(outsider);
      expect(seen.some((a) => own.some((o) => o.id === a.id))).toBe(false);
      await expect(accidents.get(outsider, victim.id)).rejects.toMatchObject({ status: 404 });
      await expect(accidents.update(outsider, victim.id, { version: victim.version, location: 'Hijacked' })).rejects.toMatchObject({ status: 404 });
      await expect(app.get(ClaimsService).create(outsider, { kind: 'physical_damage', accidentId: victim.id, description: '' })).rejects.toMatchObject({ status: 422 });

      // The outsider's own accident is invisible the other way, and numbered on its own sequence.
      const theirs = await accidents.create(outsider, { occurredAt: new Date(Date.now() - HOUR).toISOString(), location: 'Probe — other company', description: '', fatalities: 0, injuries: 0, injuriesTreatedAway: 0, disablingTow: false, citationIssued: false, isTest: true });
      expect(theirs.number).toMatch(/^ACC-/);
      const mineAfter = (await call('GET', `${BASE}/accidents`)).json() as SafetyAccident[];
      expect(mineAfter.some((a) => a.id === theirs.id)).toBe(false);
      const direct = await call('GET', `${BASE}/accidents/${theirs.id}`);
      expect(direct.statusCode).toBe(404);
      // A driver from the other company cannot be attached.
      await expect(accidents.create(outsider, { occurredAt: new Date().toISOString(), location: 'x1', driverId, description: '', fatalities: 0, injuries: 0, injuriesTreatedAway: 0, disablingTow: false, citationIssued: false })).rejects.toMatchObject({ status: 422 });
    });
  });

  it('reads the pre-trip walk-around for Safety without opening a week', async () => {
    const res = await call('GET', `${BASE}/inspections/pretrip`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { weekStart: string; counts: Record<string, number>; recent: unknown[] };
    expect(body.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(body.counts).sort()).toEqual(['awaitingReview', 'issueFound', 'missing', 'monitoring']);
    expect(body.recent.length).toBeLessThanOrEqual(10);
    const refused = await call('GET', `${BASE}/inspections/pretrip`, undefined, { 'x-demo-role': 'operations' });
    expect(refused.statusCode).toBe(403);
  });

  it('answers the overview with counts that leave test records out', async () => {
    const res = await call('GET', `${BASE}/overview`);
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json() as SafetyOverview;
    expect(o.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(o.needsAttention.every((i) => i.caseNumber && i.task)).toBe(true);
    // Every case this suite made is isTest: none of them is in a total or the list.
    const testIds = (await db.select({ id: safetyAccidents.id }).from(safetyAccidents).where(eq(safetyAccidents.isTest, true))).map((r) => r.id);
    expect(o.openCases.some((c) => testIds.includes(c.caseId))).toBe(false);
  });
});
