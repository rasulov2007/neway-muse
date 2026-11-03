import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SYSTEM_ROLES, accidentsV2 as A } from '@neway/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { drivers, trucks } from '../src/database/schema/roster';
import { safetyAccidents, safetyClaims } from '../src/database/schema/safety';
import { AccidentsV2Controller } from '../src/modules/safety/accidents-v2/accidents-v2.controller';
import { ClaimsV2Controller } from '../src/modules/safety/accidents-v2/claims-v2.controller';
import { AccidentsService } from '../src/modules/safety/accidents.service';
import { ClaimsService } from '../src/modules/safety/claims.service';

/**
 * Go-live without the cutover (owner, 2026-10-22: "switch Accidents to the new design now"). The v2 pages must read every
 * record written by the pages before them — legacy stage / fault / preventability words, claims with coverage lines, no
 * accident_units, 0/false facts — without failing and without saying something the record does not say.
 * The rows here are written through the OLD services (exactly how production's rows were written), marked test.
 */
const permsOf = (role: string) => SYSTEM_ROLES.find((r) => r.code === role)?.permissions ?? [];
const as = (companyId: string, role: string): Principal => ({
  userId: `usr_legacy_${role}`,
  userName: `Legacy ${role}`,
  companyId,
  companyTimezone: 'America/New_York',
  weekStart: 1,
  roles: [role],
  permissions: new Set(permsOf(role)),
});

describe('Accident & Claims v2 — legacy rows read by the v2 pages (e2e, no cutover)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let acc: AccidentsV2Controller;
  let clm: ClaimsV2Controller;
  let companyId = '';
  let truckId = '';
  let driverId = '';
  const created: { fatal: string; review: string; repairs: string; claimWithLines: string } = { fatal: '', review: '', repairs: '', claimWithLines: '' };

  beforeAll(async () => {
    setFeatureFlagForTests('safety_v2', true);
    setFeatureFlagForTests('accidents_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    db = app.get(DatabaseService).db;
    acc = app.get(AccidentsV2Controller);
    clm = app.get(ClaimsV2Controller);
    const [d] = await db.select({ id: drivers.id, companyId: drivers.companyId }).from(drivers).where(isNull(drivers.archivedAt)).limit(1);
    if (!d) throw new Error('A driver is needed');
    companyId = d.companyId;
    driverId = d.id;
    const [t] = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.companyId, companyId)).limit(1);
    truckId = t?.id ?? '';

    // Legacy rows, written by the pages production has today.
    const old = app.get(AccidentsService);
    const admin = as(companyId, 'administrator');
    const base = { occurredAt: '2026-09-30T14:10:00.000Z', location: 'I-80 MM 112', city: 'Joliet', state: 'IL', driverId, truckId: truckId || null, isTest: true } as const;
    const fatal = await old.create(admin, { ...base, description: 'Legacy go-live: fatal crash', fatalities: 1, injuries: 2, disablingTow: true, citationIssued: true } as never);
    created.fatal = fatal.id;
    const review = await old.create(admin, { ...base, description: 'Legacy go-live: review stage, our driver at fault' } as never);
    await old.update(admin, review.id, { version: review.version, fault: 'our_driver', preventability: 'not_preventable' } as never);
    await db.update(safetyAccidents).set({ stage: 'review' }).where(eq(safetyAccidents.id, review.id));
    created.review = review.id;
    const repairs = await old.create(admin, { ...base, description: 'Legacy go-live: repairs & claim' } as never);
    await db.update(safetyAccidents).set({ stage: 'repairs_claim', fault: 'other_party' }).where(eq(safetyAccidents.id, repairs.id));
    created.repairs = repairs.id;
    const claims = app.get(ClaimsService);
    const { claim } = await claims.create(admin, { kind: 'liability', lines: ['third_party_liability', 'own_physical_damage'], accidentId: fatal.id, description: 'Legacy go-live claim with two lines', claimedCents: 1_840_000, insurer: 'Prairie Mutual', isTest: true } as never);
    // The first line (created_at, id) decides the coverage, as in cutover C2: make the liability line the first.
    await db.execute(sql`UPDATE safety_claim_lines SET created_at = created_at - interval '1 second' WHERE claim_id = ${claim.id} AND kind = 'third_party_liability'`);
    await claims.recordPayment(admin, claim.id, { version: claim.version, receivedOn: '2026-10-05', amountCents: 50_000 } as never);
    created.claimWithLines = claim.id;
  }, 120_000);

  afterAll(async () => {
    setFeatureFlagForTests('accidents_v2', null);
    setFeatureFlagForTests('safety_v2', null);
    await app.close();
  });

  /** Every company holding a record the v2 pages have never written. */
  async function legacyCompanies(): Promise<string[]> {
    const rows = await db.execute<{ company_id: string }>(sql`
      SELECT DISTINCT company_id FROM safety_accidents
       WHERE voided_at IS NULL AND stage NOT IN ('draft','initial_response','investigation','resolution','closed')
      UNION
      SELECT DISTINCT company_id FROM safety_claims WHERE voided_at IS NULL AND claim_type IS NULL
      UNION
      -- … and every company the cutover has moved (legacy values kept), so a run against a cut-over copy reads those too.
      SELECT DISTINCT company_id FROM safety_accidents WHERE voided_at IS NULL AND (legacy_stage IS NOT NULL OR occurred_tz IS NOT NULL AND severity IS NULL)
      UNION
      SELECT DISTINCT company_id FROM safety_claims WHERE voided_at IS NULL AND legacy_ref IS NOT NULL`);
    return [...rows].map((r) => r.company_id);
  }

  it('every v2 read answers for every company with legacy rows, for owner, Safety Manager, Dispatch and Fleet', async () => {
    const companies = await legacyCompanies();
    expect(companies).toContain(companyId);
    for (const co of companies) {
      for (const role of ['administrator', 'safety_manager', 'dispatch_lead', 'fleet_manager']) {
        const p = as(co, role);
        const where = `${co} as ${role}`;
        for (const chip of A.BOARD_CHIPS) await expect(acc.board(p, { chip, range: '12m' }), `${where} board ${chip}`).resolves.toBeTruthy();
        for (const range of ['30d', '90d', '12m', 'ytd'] as const) {
          await expect(acc.summary(p, { range }), `${where} summary ${range}`).resolves.toBeTruthy();
          await expect(acc.analytics(p, { range }), `${where} analytics ${range}`).resolves.toBeTruthy();
        }
        await expect(acc.counts(p), `${where} counts`).resolves.toBeTruthy();
        await expect(acc.listTasks(p, {}), `${where} tasks`).resolves.toBeTruthy();
        await expect(clm.list(p, {}), `${where} claims`).resolves.toBeTruthy();
        await expect(clm.summary(p), `${where} claims summary`).resolves.toBeTruthy();
      }
      const p = as(co, 'administrator');
      const ids = await db.select({ id: safetyAccidents.id, truckId: safetyAccidents.truckId, driverId: safetyAccidents.driverId }).from(safetyAccidents).where(and(eq(safetyAccidents.companyId, co), isNull(safetyAccidents.voidedAt)));
      for (const a of ids) {
        await expect(acc.detail(p, a.id), `${co} case ${a.id}`).resolves.toBeTruthy();
        await expect(acc.events(p, a.id), `${co} events ${a.id}`).resolves.toBeTruthy();
        await expect(acc.caseTasks(p, a.id, 'all'), `${co} case tasks ${a.id}`).resolves.toBeTruthy();
        await expect(acc.evidenceList(p, a.id, 'true'), `${co} evidence ${a.id}`).resolves.toBeTruthy();
      }
      for (const t of new Set(ids.map((a) => a.truckId).filter(Boolean))) await expect(acc.profile(p, 'truck', t as string), `${co} truck ${t}`).resolves.toBeTruthy();
      for (const d of new Set(ids.map((a) => a.driverId).filter(Boolean))) await expect(acc.profile(p, 'driver', d as string), `${co} driver ${d}`).resolves.toBeTruthy();
      const claimIds = await db.select({ id: safetyClaims.id }).from(safetyClaims).where(and(eq(safetyClaims.companyId, co), isNull(safetyClaims.voidedAt)));
      for (const c of claimIds) await expect(clm.detail(p, c.id), `${co} claim ${c.id}`).resolves.toBeTruthy();
    }
  }, 600_000);

  it('a legacy fatal crash reads as what it says: injuries yes, fatality, tow-away, citation — DOT recordable; never "no"', async () => {
    const d = (await acc.detail(as(companyId, 'safety_manager'), created.fatal)) as unknown as { case: Record<string, any>; computed: Record<string, any> };
    expect(d.case.stage).toBe('initial_response');
    expect(d.case.injuries.status).toBe('yes');
    expect(d.case.injuries.fatalities).toBe(1);
    expect(d.case.towAway).toBe('yes');
    expect(d.case.citation.status).toBe('yes');
    expect(d.case.tz).toBe('America/Chicago');
    // Facts the legacy record never captured stay unknown (null), never "no".
    expect(d.case.hazmat).toBeNull();
    expect(d.case.police.responded).toBeNull();
  });

  it('legacy stage and fault words show in the v2 vocabulary (review → investigation, our driver → at fault, other party → not at fault)', async () => {
    const p = as(companyId, 'safety_manager');
    const r = (await acc.detail(p, created.review)) as unknown as { case: Record<string, any> };
    expect(r.case.stage).toBe('investigation');
    expect(r.case.determinations.fault.value).toBe('at_fault');
    expect(r.case.determinations.preventability.value).toBe('non_preventable');
    const k = (await acc.detail(p, created.repairs)) as unknown as { case: Record<string, any> };
    expect(k.case.stage).toBe('resolution');
    expect(k.case.determinations.fault.value).toBe('not_at_fault');
  });

  it('a legacy claim with two coverage lines reads as its first line, restricted when the crash injured someone, money hidden from Dispatch', async () => {
    const sm = (await clm.detail(as(companyId, 'safety_manager'), created.claimWithLines)) as unknown as { claim: Record<string, any> };
    expect(sm.claim.type).toBe('auto_liability');
    expect(sm.claim.restricted).toBe(true);
    expect(sm.claim.claimedCents).toBe(1_840_000);
    expect(sm.claim.status).toBe('Open');
    const list = (await clm.list(as(companyId, 'dispatch_lead'), {})) as unknown as A.ClaimListResponse;
    const row = list.items.find((r) => r.id === created.claimWithLines);
    expect(row).toMatchObject({ restricted: true, claimedCents: null, type: 'auto_liability' });
  });

  it('one writer per fact: with the flag on the old accident / claim writers answer 409; liability, driver charges and Accounting stay open', async () => {
    const json = { 'content-type': 'application/json' };
    const writes: Array<['POST' | 'PATCH', string]> = [
      ['POST', '/api/v1/safety/accidents'],
      ['PATCH', '/api/v1/safety/accidents/acc_x'],
      ['POST', '/api/v1/safety/accidents/acc_x/advance'],
      ['POST', '/api/v1/safety/accidents/acc_x/close'],
      ['POST', '/api/v1/safety/accidents/acc_x/void'],
      ['POST', '/api/v1/safety/accidents/acc_x/claim'],
      ['POST', '/api/v1/safety/accidents/acc_x/work-order'],
      ['POST', '/api/v1/safety/claims'],
      ['PATCH', '/api/v1/safety/claims/clm_x'],
      ['POST', '/api/v1/safety/claims/clm_x/advance'],
      ['POST', '/api/v1/safety/claims/clm_x/close'],
      ['POST', '/api/v1/safety/claims/clm_x/payments'],
      ['POST', '/api/v1/safety/claims/clm_x/payments/pay_x/void'],
      ['POST', '/api/v1/safety/claims/clm_x/void'],
      ['POST', '/api/v1/safety/claims/clm_x/updates'],
    ];
    for (const [method, url] of writes) {
      const res = await app.inject({ method, url, headers: json, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json()).toMatchObject({ type: '/problems/read-only-legacy-writer' });
    }
    // Reads stay.
    expect((await app.inject({ method: 'GET', url: '/api/v1/safety/claims' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/safety/accidents' })).statusCode).toBe(200);
    // Not guarded: they reach their handler (404 for an unknown id, 422 for an empty body), never 409.
    for (const url of ['/api/v1/safety/claims/clm_x/liability', '/api/v1/safety/claims/clm_x/driver-charges', '/api/v1/safety/accounting-entries/ent_x/confirm']) {
      const res = await app.inject({ method: 'POST', url, headers: json, payload: {} });
      expect(res.statusCode, url).not.toBe(409);
    }
    // Flag off: the old writer is a writer again (validation answers, not the read-only refusal).
    setFeatureFlagForTests('accidents_v2', false);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/safety/claims', headers: json, payload: {} });
      expect(res.statusCode).toBe(422);
    } finally {
      setFeatureFlagForTests('accidents_v2', true);
    }
  });

  it('the first v2 write stores the legacy claim in the v2 vocabulary (audited), so the restricted guard holds for Accounting', async () => {
    const sm = as(companyId, 'safety_manager');
    const d = (await clm.detail(sm, created.claimWithLines)) as unknown as A.ClaimDetailResponse;
    await clm.log(sm, created.claimWithLines, { version: d.version, channel: 'Note', text: 'Go-live: first v2 note on a legacy claim' } as never);
    const [row] = await db.select().from(safetyClaims).where(eq(safetyClaims.id, created.claimWithLines));
    expect(row).toMatchObject({ claimType: 'auto_liability', restricted: true, status: 'Open' });
    const acct = as(companyId, 'accounting');
    await expect(clm.payment(acct, created.claimWithLines, { version: row!.version, direction: 'to_us', amountCents: 100, party: 'Prairie Mutual' } as never)).rejects.toMatchObject({ status: 403 });
  });
});
