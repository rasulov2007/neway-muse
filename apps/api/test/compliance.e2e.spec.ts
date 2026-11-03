import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  SYSTEM_REQUIREMENTS,
  evaluateEntity,
  type EvaluatedItem,
  type QualificationItem,
  type VerificationCase,
} from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { HiringService } from '../src/modules/hiring/hiring.service';
import { accountWithPermissions } from './fleet-reader-account';
import { isSignedDocumentUrl, signedGet } from './authz/signed-get';

const BASE = '/api/v1/compliance';
const TODAY = '2026-09-06';

/**
 * The qualification file, end to end.
 *
 * These were the browser-layer upload tests; the assertions are the same, the store is PostgreSQL.
 * They write against a synthetic driver id so no real driver's file is touched, and the hiring
 * checks read the cases the seed opened without changing them.
 */
describe('Compliance API (e2e)', () => {
  let app: NestFastifyApplication;
  const owner = `drv_e2e_${Date.now()}`;

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: payload as object });
  const get = (url: string, headers?: Record<string, string>) =>
    isSignedDocumentUrl(url) ? signedGet(app, url, headers ?? {}) : app.inject({ method: 'GET', url, headers });

  async function statusOf(code: string): Promise<EvaluatedItem | undefined> {
    const items = (await get(`${BASE}/items?scope=driver&entityId=${owner}`)).json() as QualificationItem[];
    const entity = evaluateEntity(
      { scope: 'driver', id: owner, label: 'E2E driver' },
      SYSTEM_REQUIREMENTS,
      items,
      { today: TODAY },
    );
    return entity.items.find((i) => i.requirementCode === code);
  }

  const upload = (requirementCode: string, extra: Record<string, unknown> = {}) =>
    post(`${BASE}/documents`, {
      ownerType: 'driver',
      ownerId: owner,
      ownerLabel: 'E2E driver',
      requirementCode,
      title: requirementCode.replace(/_/g, ' '),
      fileName: `${requirementCode}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 2048,
      issuedOn: '2026-09-01',
      expiresOn: '2027-09-01',
      ...extra,
    });

  it('seeded the file the browser used to generate: items for every live unit, cases for recent hires', async () => {
    const items = (await get(`${BASE}/items`)).json() as QualificationItem[];
    expect(items.length).toBeGreaterThan(900);
    const cases = (await get(`${BASE}/verification`)).json() as VerificationCase[];
    expect(cases.length).toBeGreaterThan(0);
    // 17 rungs less the background-check consent and check, retired 2026-10-24.
    for (const c of cases) expect(c.steps.length).toBe(15);
  });

  it('writes the qualification item as well as the document', async () => {
    expect((await statusOf('mvr_review'))?.status).toBe('missing');
    const response = await upload('mvr_review');
    expect(response.statusCode).toBe(201);
    const { document, item } = response.json() as { document: { id: string }; item: QualificationItem };
    expect(item.documentId).toBe(document.id);
    expect(item.expiresOn).toBe('2027-09-01');
    expect((await statusOf('mvr_review'))?.status).not.toBe('missing');
  });

  it('moves the requirement to pending verification, not to satisfied', async () => {
    await upload('clearinghouse_query');
    const pending = await statusOf('clearinghouse_query');
    expect(pending?.status).toBe('pending_verification');
    expect(pending?.blocksDispatch).toBe(false);
    expect(pending?.severity).toBe('warning');
  });

  it('reaches verified once a person checks it, and records who', async () => {
    const { document } = (await upload('employment_verification')).json() as {
      document: { id: string };
    };
    expect((await statusOf('employment_verification'))?.status).toBe('pending_verification');
    const verified = await post(`${BASE}/documents/${document.id}/verify`, {});
    expect(verified.statusCode).toBe(201);
    expect((await statusOf('employment_verification'))?.status).toBe('verified');

    const audit = (await get(`${BASE}/audit?entityId=${owner}&limit=5`)).json() as {
      action: string;
      actorName: string;
      after: string | null;
    }[];
    expect(audit[0]?.action).toBe('document_verified');
    expect(audit[0]?.actorName).not.toMatch(/system/i);
  });

  it('refuses an expiring requirement with no expiry date', async () => {
    const response = await upload('work_authorization', { expiresOn: null });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { detail: string }).detail).toMatch(/expiry date is required/i);
  });

  it('dates an MVR or PSP 6 months from its report date, else from the day it arrived (owner, 2026-10-24)', async () => {
    const driverId = `drv_e2e_6m_${Date.now()}`;
    const file = (requirementCode: string, extra: Record<string, unknown>) =>
      post(`${BASE}/documents`, {
        ownerType: 'driver',
        ownerId: driverId,
        ownerLabel: 'E2E six-month driver',
        requirementCode,
        title: requirementCode,
        fileName: `${requirementCode}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 1024,
        ...extra,
      });
    // A PSP with no dates at all is accepted and falls due 6 months after today (Eastern).
    const psp = await file('psp_review', { issuedOn: null, expiresOn: null });
    expect(psp.statusCode).toBe(201);
    const easternToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const [y, m, d] = easternToday.split('-').map(Number) as [number, number, number];
    const total = y * 12 + (m - 1) + 6;
    const last = new Date(Date.UTC(Math.floor(total / 12), (total % 12) + 1, 0)).getUTCDate();
    const due = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    expect((psp.json() as { item: QualificationItem }).item.expiresOn).toBe(due);
    // An MVR filed under the old 12-month term still falls due 6 months after its date.
    expect((await file('mvr_review', { issuedOn: '2026-03-01', expiresOn: '2027-03-01' })).statusCode).toBe(201);
    const items = (await get(`${BASE}/items?scope=driver&entityId=${driverId}`)).json() as QualificationItem[];
    // The reader carries the day the document arrived, for reports without a date.
    expect(items.find((i) => i.requirementCode === 'psp_review')?.receivedOn).toBe(easternToday);
    const entity = evaluateEntity({ scope: 'driver', id: driverId, label: 'E2E' }, SYSTEM_REQUIREMENTS, items, { today: '2026-10-24' });
    const mvr = entity.items.find((i) => i.requirementCode === 'mvr_review');
    expect(mvr?.expiresOn).toBe('2026-09-01');
    expect(mvr?.daysRemaining).toBe(-53);
    // Not yet verified, so it reads pending verification first; verified, it reads expired.
    const verified = evaluateEntity({ scope: 'driver', id: driverId, label: 'E2E' }, SYSTEM_REQUIREMENTS, items.map((i) => ({ ...i, verifiedAt: '2026-03-02T12:00:00.000Z' })), { today: '2026-10-24' });
    expect(verified.items.find((i) => i.requirementCode === 'mvr_review')?.status).toBe('expired');
  });

  it('supersedes the previous document rather than erasing it', async () => {
    const first = (await upload('psp_review', { fileName: 'psp-1.pdf' })).json() as {
      document: { id: string; version: number };
    };
    const second = (await upload('psp_review', { fileName: 'psp-2.pdf' })).json() as {
      document: { id: string; version: number; supersedesDocumentId: string | null };
    };
    expect(second.document.version).toBe(first.document.version + 1);
    expect(second.document.supersedesDocumentId).toBe(first.document.id);
    const docs = (await get(`${BASE}/documents?ownerId=${owner}&requirementCode=psp_review`)).json() as {
      id: string;
    }[];
    expect(docs.some((d) => d.id === first.document.id)).toBe(true);
  });

  it('deletes a unit document with its file and points the requirement back at nothing', async () => {
    const unit = `trk_e2e_${Date.now()}`;
    const created = (
      await post(`${BASE}/documents`, {
        ownerType: 'truck',
        ownerId: unit,
        ownerLabel: 'Unit E2E',
        requirementCode: 'registration',
        title: 'Registration',
        fileName: 'registration.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4,
        issuedOn: '2026-01-01',
        expiresOn: '2027-01-01',
        content: Buffer.from('%PDF').toString('base64'),
      })
    ).json() as { document: { id: string; hasFile: boolean }; item: { documentId: string | null } };
    expect(created.document.hasFile).toBe(true);
    expect(created.item.documentId).toBe(created.document.id);

    const removed = await app.inject({ method: 'DELETE', url: `${BASE}/documents/${created.document.id}` });
    expect(removed.statusCode).toBe(200);
    expect((await get(`${BASE}/documents/${created.document.id}/file`)).statusCode).toBe(404);
    const docs = (await get(`${BASE}/documents?ownerId=${unit}`)).json() as { id: string }[];
    expect(docs).toHaveLength(0);
    const items = (await get(`${BASE}/items?scope=truck&entityId=${unit}`)).json() as QualificationItem[];
    expect(items.find((i) => i.requirementCode === 'registration')?.documentId).toBeNull();
    const audit = (await get(`${BASE}/audit?entityId=${unit}`)).json() as { action: string }[];
    expect(audit.some((a) => a.action === 'document_deleted')).toBe(true);

    const forbidden = await app.inject({
      method: 'DELETE',
      url: `${BASE}/documents/${created.document.id}`,
      headers: { 'x-demo-role': 'operations' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('opens a unit document for anybody who may see the unit, and nothing more (owner, 2026-10-10)', async () => {
    const unit = `trk_e2e_open_${Date.now()}`;
    const truckDoc = (
      await post(`${BASE}/documents`, {
        ownerType: 'truck',
        ownerId: unit,
        ownerLabel: 'Unit E2E',
        requirementCode: 'registration',
        title: 'Registration',
        fileName: 'registration.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4,
        issuedOn: '2026-01-01',
        expiresOn: '2027-01-01',
        content: Buffer.from('%PDF').toString('base64'),
      })
    ).json() as { document: { id: string } };
    const driverDoc = (
      await upload('road_test', { content: Buffer.from('%PDF').toString('base64'), sizeBytes: 4 })
    ).json() as { document: { id: string } };

    const fleet = await accountWithPermissions(app, ['trucks.view', 'trailers.view'], 'Fleet reader');
    const open = (headers: Record<string, string>, id: string) => get(`${BASE}/documents/${id}/file`, headers);
    expect((await open({ 'x-account': fleet }, truckDoc.document.id)).statusCode).toBe(200);
    expect((await open({ 'x-account': fleet }, driverDoc.document.id)).statusCode).toBe(403);
    expect((await open({ 'x-demo-role': 'operations' }, truckDoc.document.id)).statusCode).toBe(403);
  });

  it('a dispatcher reads one driver\'s CDL and nothing else of the file (owner, 2026-10-26)', async () => {
    const pdf = { content: Buffer.from('%PDF').toString('base64'), sizeBytes: 4 };
    const cdl = (await upload('cdl', pdf)).json() as { document: { id: string } };
    const road = (await upload('road_test', pdf)).json() as { document: { id: string } };
    const dispatcher = await accountWithPermissions(
      app,
      ['dispatch.view', 'dispatch.edit', 'drivers.view', 'drivers.edit', 'drivers.view_contact'],
      'Dispatcher reader',
    );
    const headers = { 'x-account': dispatcher };
    const listed = (await get(`${BASE}/documents?ownerType=driver&ownerId=${owner}`, headers)).json() as { id: string; requirementCode: string }[];
    expect(listed.map((d) => d.id)).toContain(cdl.document.id);
    expect(listed.map((d) => d.id)).not.toContain(road.document.id);
    expect(listed.every((d) => d.requirementCode === 'cdl' || d.requirementCode === 'cdl_back')).toBe(true);
    // Not without naming the driver, and not a unit's or a whole-company list.
    expect((await get(`${BASE}/documents?ownerType=driver`, headers)).statusCode).toBe(403);
    expect((await get(`${BASE}/documents`, headers)).statusCode).toBe(403);
    const open = (id: string) => get(`${BASE}/documents/${id}/file`, headers);
    expect((await open(cdl.document.id)).statusCode).toBe(200);
    expect((await open(road.document.id)).statusCode).toBe(403);
    // Any other driver viewer (maintenance here) reads the CDL too; without drivers.view, nothing.
    const fleet = await accountWithPermissions(app, ['maintenance.view', 'trucks.view', 'drivers.view'], 'Maintenance reader');
    const fleetList = (await get(`${BASE}/documents?ownerType=driver&ownerId=${owner}`, { 'x-account': fleet })).json() as { requirementCode: string }[];
    expect(fleetList.length).toBeGreaterThan(0);
    expect(fleetList.every((d) => d.requirementCode === 'cdl' || d.requirementCode === 'cdl_back')).toBe(true);
    const board = await accountWithPermissions(app, ['dispatch.view'], 'Board only');
    expect((await get(`${BASE}/documents?ownerType=driver&ownerId=${owner}`, { 'x-account': board })).statusCode).toBe(403);
  });

  it('refuses every compliance write to a principal without compliance.manage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/consents`,
      headers: { 'x-demo-role': 'operations', 'content-type': 'application/json' },
      payload: { driverId: owner, purpose: 'mvr' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('a consent moves draft → sent → signed, and the signature files a document', async () => {
    const created = (await post(`${BASE}/consents`, { driverId: owner, purpose: 'mvr' })).json() as {
      id: string;
      status: string;
    };
    expect(created.status).toBe('draft');
    const sent = (await post(`${BASE}/consents/${created.id}/send`, {})).json() as { status: string };
    expect(sent.status).toBe('sent');
    const signed = (
      await post(`${BASE}/consents/${created.id}/respond`, { outcome: 'signed' })
    ).json() as { status: string; signedDocumentId: string | null; history: unknown[] };
    expect(signed.status).toBe('signed');
    expect(signed.signedDocumentId).not.toBeNull();
    expect(signed.history.length).toBe(3);
  });

  it('derives verification steps from the file rather than storing them', async () => {
    // A seeded case stuck at consent: the blocker names the consent, and the step count is the ladder.
    const cases = (await get(`${BASE}/verification?stage=consent`)).json() as VerificationCase[];
    expect(cases.length).toBeGreaterThan(0);
    const blocked = cases[0]!.steps.filter((s) => s.status === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]?.blocker).toBeTruthy();
  });

  it('opened a hiring case for every verification case, at the stage the file implies', async () => {
    const summary = (await get('/api/v1/hiring/cases/summary')).json() as Record<string, number>;
    const cases = (await get(`${BASE}/verification`)).json() as VerificationCase[];
    const total = Object.values(summary).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(cases.length);
    const inFunnel = ['checks', 'safety_review', 'active_driver', 'offer'].reduce(
      (sum, state) => sum + (summary[state] ?? 0),
      0,
    );
    expect(inFunnel).toBeGreaterThan(0);
    const hiring = (await get('/api/v1/hiring/cases')).json() as { events: unknown[]; state: string }[];
    for (const c of hiring) expect(c.events.length).toBeGreaterThan(0);
  });
});
