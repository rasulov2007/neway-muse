import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { ComplianceDocument, SafetyAccident, SafetyDrugTest } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { complianceDocuments } from '../src/database/schema/compliance';
import { drivers } from '../src/database/schema/roster';
import { drugAlcoholTests, safetyAccidents } from '../src/database/schema/safety';
import { accountWithPermissions } from './fleet-reader-account';

const BASE = '/api/v1/safety';
/** A one-pixel PNG: a real file the storage accepts. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * A random drug test submitted from the driver's Documents tab (owner, 2026-10-24): one call
 * records the test with its date and result and files the paper as a "Random drug test" document.
 */
describe('Random drug test submission (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let driverId = '';

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    setFeatureFlagForTests('safety_v2', true);
    setFeatureFlagForTests('accidents_v2', false);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    // The company the dev headers act as: whichever company owns a probe accident.
    const probe = await call('POST', `${BASE}/accidents`, { occurredAt: new Date(Date.now() - 3_600_000).toISOString(), location: 'Random test probe', isTest: true });
    expect(probe.statusCode, probe.body).toBe(201);
    const [row] = await db.select({ companyId: safetyAccidents.companyId }).from(safetyAccidents).where(eq(safetyAccidents.id, (probe.json() as SafetyAccident).id));
    const [d] = await db.select({ id: drivers.id }).from(drivers).where(and(eq(drivers.companyId, row!.companyId), isNull(drivers.archivedAt))).limit(1);
    if (!d) throw new Error('The dev company needs a driver');
    driverId = d.id;
  });

  afterAll(async () => {
    setFeatureFlagForTests('safety_v2', null);
    setFeatureFlagForTests('accidents_v2', null);
    await app.close();
  });

  const submit = (extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    call('POST', `${BASE}/tests/random`, { driverId, collectedOn: '2026-10-20', result: 'negative', fileName: 'random.png', contentType: 'image/png', content: PNG, ...extra }, headers);

  it('records the test with its date and result, and files the paper as a Random drug test', async () => {
    const res = await submit({ notes: 'Quarterly pool' });
    expect(res.statusCode, res.body).toBe(201);
    const { test, document } = res.json() as { test: SafetyDrugTest; document: ComplianceDocument };
    expect(test.testType).toBe('random');
    expect(test.substance).toBe('drug');
    expect(test.result).toBe('negative');
    expect(test.collectedAt?.slice(0, 10)).toBe('2026-10-20');
    expect(document.requirementCode).toBe('random_drug_test');
    expect(document.issuedOn).toBe('2026-10-20');
    expect(document.hasFile).toBe(true);
    // The document never carries the result.
    expect(document.title).not.toMatch(/negative/i);
    const [stored] = await db.select().from(complianceDocuments).where(eq(complianceDocuments.id, document.id));
    expect(stored?.ownerId).toBe(driverId);
    const [row] = await db.select().from(drugAlcoholTests).where(eq(drugAlcoholTests.id, test.id));
    expect(row?.result).toBe('negative');
    // It reads back on the driver's documents and tests.
    const docs = (await call('GET', `/api/v1/compliance/documents?ownerType=driver&ownerId=${driverId}&requirementCode=random_drug_test`)).json() as ComplianceDocument[];
    expect(docs.some((d) => d.id === document.id)).toBe(true);
    const tests = (await call('GET', `${BASE}/tests?driverId=${driverId}`)).json() as SafetyDrugTest[];
    expect(tests.some((t) => t.id === test.id && t.testType === 'random')).toBe(true);
  });

  it('refuses a future date and a caller without safety_testing.manage', async () => {
    const future = await submit({ collectedOn: '2099-01-01' });
    expect(future.statusCode).toBe(422);
    const viewer = { 'x-account': await accountWithPermissions(app, ['safety.view', 'safety.manage'], 'Random test writer') };
    expect((await submit({}, viewer)).statusCode).toBe(403);
  });
});
