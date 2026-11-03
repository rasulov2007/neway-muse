import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ComplianceDocument, QualificationItem, VerificationCase } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { redactDocuments, redactItems } from '../src/modules/compliance/sensitive';
import { VerificationService } from '../src/modules/compliance/verification.service';

const COMPLIANCE = '/api/v1/compliance';

/**
 * Recruiting → hire, the owner's fixes (2026-10-02): a decision is refused, with the list of what
 * is missing, while the file is incomplete (a rejection never waits); the safety review is started
 * on purpose and audited; "not applicable" needs a reason and only where the catalog allows it;
 * sensitive qualification records are redacted by the server.
 */
describe('Recruiting safety gate (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const driverId = `drv_gate_${stamp}`;
  let vcase: VerificationCase;

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const me = (await call('GET', '/api/v1/auth/me')).json() as { company?: { id: string }; companyId?: string; membership?: { companyId: string } };
    companyId = me.company?.id ?? me.companyId ?? me.membership?.companyId ?? 'co_northwind';
    const owner: Principal = {
      userId: 'usr_gate_probe',
      userName: 'Gate probe',
      companyId,
      companyTimezone: 'America/New_York',
      weekStart: 1,
      roles: [],
      permissions: new Set(['compliance.manage']),
    };
    vcase = await app.get(VerificationService).open(owner, { driverId, driverName: `Gate Probe ${stamp}` });
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses an approval on an incomplete file and lists what is missing', async () => {
    const res = await call('POST', `${COMPLIANCE}/verification/${vcase.id}/decision`, { decision: 'approved', conditions: [], note: null });
    expect(res.statusCode).toBe(409);
    const missing = (res.json() as { missing: string[] }).missing;
    expect(missing.length).toBeGreaterThan(5);
    expect(missing.join(' | ')).toMatch(/CDL on file/);
    expect(missing.join(' | ')).toMatch(/Safety review has not been started/);
    const conditional = await call('POST', `${COMPLIANCE}/verification/${vcase.id}/decision`, { decision: 'conditional', conditions: ['MVR to follow'], note: null });
    expect(conditional.statusCode).toBe(409);
  });

  it('starts the safety review once, audited', async () => {
    const started = await call('POST', `${COMPLIANCE}/verification/${vcase.id}/start-review`, {});
    expect(started.statusCode, started.body).toBe(201);
    expect((started.json() as VerificationCase).safetyReviewStatus).toBe('in_progress');
    const again = await call('POST', `${COMPLIANCE}/verification/${vcase.id}/start-review`, {});
    expect(again.statusCode).toBe(409);
    const audit = (await call('GET', `${COMPLIANCE}/audit?entityId=${driverId}&limit=20`)).json() as { reason: string | null }[];
    expect(audit.some((a) => a.reason === 'Safety review started')).toBe(true);
  });

  it('marks not applicable only where allowed, and only with a reason', async () => {
    const refused = await call('POST', `${COMPLIANCE}/items/not-applicable`, { driverId, requirementCode: 'cdl', reason: 'Not needed for this driver' });
    expect(refused.statusCode).toBe(422);
    const noReason = await call('POST', `${COMPLIANCE}/items/not-applicable`, { driverId, requirementCode: 'employment_verification', reason: 'no' });
    expect(noReason.statusCode).toBe(422);
    const ok = await call('POST', `${COMPLIANCE}/items/not-applicable`, { driverId, requirementCode: 'employment_verification', reason: 'First CDL job: no previous DOT-regulated employer' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((ok.json() as QualificationItem).notApplicable).toBe(true);
    const audit = (await call('GET', `${COMPLIANCE}/audit?entityId=${driverId}&limit=20`)).json() as { reason: string | null }[];
    expect(audit.some((a) => a.reason === 'First CDL job: no previous DOT-regulated employer')).toBe(true);
  });

  it('still lets Safety reject an incomplete file', async () => {
    const res = await call('POST', `${COMPLIANCE}/verification/${vcase.id}/decision`, { decision: 'rejected', conditions: [], note: 'Withdrew' });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as VerificationCase).decision).toBe('rejected');
  });

  it('redacts sensitive qualification details for a caller without compliance_sensitive.view', async () => {
    const upload = await call('POST', `${COMPLIANCE}/documents`, {
      ownerType: 'driver',
      ownerId: driverId,
      ownerLabel: `Gate Probe ${stamp}`,
      requirementCode: 'mvr_review',
      title: 'Motor vehicle record',
      fileName: `mvr-${stamp}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 4,
      issuedOn: null,
      expiresOn: '2027-10-01',
      source: 'staff',
      content: Buffer.from('%PDF').toString('base64'),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const docs = (await call('GET', `${COMPLIANCE}/documents?ownerType=driver&ownerId=${driverId}`)).json() as ComplianceDocument[];
    const mvr = docs.find((d) => d.requirementCode === 'mvr_review');
    expect(mvr?.fileName).toBe(`mvr-${stamp}.pdf`); // the owner holds the code

    const viewer: Principal = { userId: 'u', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(['compliance.view']) };
    const redacted = redactDocuments(viewer, docs).find((d) => d.requirementCode === 'mvr_review');
    expect(redacted?.fileName).toBe('Restricted');
    expect(redacted?.status).toBe(mvr?.status);
    const items = (await call('GET', `${COMPLIANCE}/items?scope=driver&entityId=${driverId}`)).json() as QualificationItem[];
    const withNotes = items.map((i) => ({ ...i, notes: 'Reviewer note' }));
    expect(redactItems(viewer, withNotes).find((i) => i.requirementCode === 'mvr_review')?.notes).toBe('Restricted');
    expect(redactItems(viewer, withNotes).find((i) => i.requirementCode === 'employment_verification')?.notes).toBe('Reviewer note');
  });
});
