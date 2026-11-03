import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RecruitCandidate, RecruitList, RenameCandidateResult } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { hiringCases, hiringLeads } from '../src/database/schema/hiring';
import { applicants } from '../src/database/schema/hr';
import { auditLogs } from '../src/database/schema/people';
import { companies, drivers } from '../src/database/schema/roster';
import { HiringService } from '../src/modules/hiring/hiring.service';

const R = '/api/v1/hiring/recruiting';

/**
 * Renaming a candidate (owner, 2026-10-21): PATCH /hiring/recruiting/candidates/:key/name changes
 * the name on the lead, the hiring case and the candidate record together, with a version check
 * (stale = 409), validation (empty = 422), company scope (another company's = 404) and an audit
 * entry that the activity feed shows. A hired driver's driver record is never touched from here.
 */
describe('Recruiting: rename a candidate (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const phone = () => `+1312${String(200 + Math.floor(Math.random() * 700))}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      payload: payload as object | undefined,
    });
  const read = async (key: string) => {
    const res = await call('GET', `${R}/candidates/${key}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as RecruitCandidate;
  };
  const applicantKey = async (first: string, last: string) => {
    const [a] = await db
      .select({ id: applicants.id })
      .from(applicants)
      .where(and(eq(applicants.firstName, first), eq(applicants.lastName, last)))
      .limit(1);
    if (!a) throw new Error(`No applicant ${first} ${last}`);
    return a.id;
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.get(HiringSeedService).seedPipeline([
      { first: 'Case', last: `Rename${stamp}`, state: 'TX', daysAgo: 20, stop: 'offer_sent', driverType: 'company' },
      { first: 'Hired', last: `Rename${stamp}`, state: 'TX', daysAgo: 40, stop: 'hired', driverType: 'company' },
    ]);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
  }, 240_000);

  afterAll(async () => {
    await app.close();
  });

  let leadKey = '';

  it('renames a lead: the new name is stored, listed and audited', async () => {
    const added = await call('POST', `${R}/leads`, { fullName: `Rita Rename${stamp}`, phone: phone(), source: 'instagram', assignment: 'auto' });
    expect(added.statusCode, added.body).toBe(201);
    leadKey = (added.json() as { key: string }).key;
    const before = await read(leadKey);
    expect(before.firstName).toBe('Rita');
    expect(before.lastName).toBe(`Rename${stamp}`);
    expect(before.version).toBeTruthy();

    const res = await call('PATCH', `${R}/candidates/${leadKey}/name`, { firstName: '  Rhea ', lastName: `Renamed${stamp}`, version: before.version });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as RenameCandidateResult;
    expect(out.candidate.name).toBe(`Rhea Renamed${stamp}`);
    expect(out.candidate.firstName).toBe('Rhea');
    expect(out.candidate.version).not.toBe(before.version);
    expect(out.driverNotice).toBeNull();

    const [row] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, leadKey));
    expect(row?.firstName).toBe('Rhea');
    expect(row?.lastName).toBe(`Renamed${stamp}`);

    const list = (await call('GET', `${R}/candidates?scope=all&q=Renamed${stamp}`)).json() as RecruitList;
    expect(list.rows.map((r) => r.name)).toContain(`Rhea Renamed${stamp}`);

    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, leadKey), eq(auditLogs.action, 'rename')));
    expect(audit?.summary).toBe(`Name changed from Rita Rename${stamp} to Rhea Renamed${stamp}`);
    expect(audit?.changes).toEqual(
      expect.arrayContaining([{ field: 'name', old: `Rita Rename${stamp}`, new: `Rhea Renamed${stamp}` }]),
    );
  });

  it('refuses a stale version with 409 and leaves the name as it is', async () => {
    const now = await read(leadKey);
    const stale = await call('PATCH', `${R}/candidates/${leadKey}/name`, { firstName: 'Old', lastName: 'Tab', version: '1.-' });
    expect(stale.statusCode, stale.body).toBe(409);
    expect((await read(leadKey)).name).toBe(now.name);
  });

  it('refuses an empty name with 422', async () => {
    const now = await read(leadKey);
    expect((await call('PATCH', `${R}/candidates/${leadKey}/name`, { firstName: '   ', lastName: 'X', version: now.version })).statusCode).toBe(422);
    expect((await call('PATCH', `${R}/candidates/${leadKey}/name`, { name: '  ', version: now.version })).statusCode).toBe(422);
    expect((await call('PATCH', `${R}/candidates/${leadKey}/name`, { firstName: 'A'.repeat(41), version: now.version })).statusCode).toBe(422);
    expect((await call('PATCH', `${R}/candidates/${leadKey}/name`, { firstName: 'Ok' })).statusCode).toBe(422);
    expect((await read(leadKey)).name).toBe(now.name);
  });

  it("another company's candidate is 404", async () => {
    const co = `co_rename_${stamp}`;
    await db.insert(companies).values({ id: co, name: `Elsewhere ${stamp}` });
    const id = `lead_${crypto.randomUUID()}`;
    await db.insert(hiringLeads).values({ id, companyId: co, leadNumber: 'LEAD-1', firstName: 'Out', lastName: 'Side', phone: '+13125550000', source: 'website' });
    const res = await call('PATCH', `${R}/candidates/${id}/name`, { firstName: 'In', lastName: 'Side', version: '-.-' });
    expect(res.statusCode, res.body).toBe(404);
    const [row] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, id));
    expect(row?.firstName).toBe('Out');
  });

  it('renames a candidate on the lead, the case and the candidate record together, and the activity shows it', async () => {
    const key = await applicantKey('Case', `Rename${stamp}`);
    const before = await read(key);
    expect(before.caseId).toBeTruthy();
    const res = await call('PATCH', `${R}/candidates/${key}/name`, { name: `Casey  Renamed${stamp}`, version: before.version });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as RenameCandidateResult).candidate.name).toBe(`Casey Renamed${stamp}`);

    const [c] = await db.select().from(hiringCases).where(eq(hiringCases.id, before.caseId as string));
    expect(c?.candidateName).toBe(`Casey Renamed${stamp}`);
    const [a] = await db.select().from(applicants).where(eq(applicants.id, key));
    expect([a?.firstName, a?.lastName]).toEqual(['Casey', `Renamed${stamp}`]);
    const [l] = await db.select().from(hiringLeads).where(eq(hiringLeads.hiringCaseId, before.caseId as string));
    expect([l?.firstName, l?.lastName]).toEqual(['Casey', `Renamed${stamp}`]);

    const activity = await call('GET', `/api/v1/hiring/cases/${before.caseId}/activity`);
    expect(activity.statusCode, activity.body).toBe(200);
    expect((activity.json() as { title: string }[]).map((e) => e.title)).toContain(`Name changed from Case Rename${stamp} to Casey Renamed${stamp}`);
  });

  it('a hired candidate is renamed in Recruiting only; the driver record is untouched and the response says so', async () => {
    const key = await applicantKey('Hired', `Rename${stamp}`);
    const before = await read(key);
    expect(before.driverId).toBeTruthy();
    const [driverBefore] = await db.select().from(drivers).where(eq(drivers.id, before.driverId as string));
    const res = await call('PATCH', `${R}/candidates/${key}/name`, { firstName: 'Harriet', lastName: `Rename${stamp}`, version: before.version });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as RenameCandidateResult;
    expect(out.candidate.name).toBe(`Harriet Rename${stamp}`);
    expect(out.driverNotice).toMatch(/renamed in Drivers/);
    const [driverAfter] = await db.select().from(drivers).where(eq(drivers.id, before.driverId as string));
    expect(driverAfter).toEqual(driverBefore);
  });
});
