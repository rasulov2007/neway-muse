import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverApplicationLinkIssued, DriverApplicationView, RecruitCandidate, SendToSafetyReadiness } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { DocumentStorageService } from '../src/common/storage/document-storage.service';
import { env } from '../src/config/env';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { notifications, memberships, users } from '../src/database/schema/admin';
import { complianceDocuments } from '../src/database/schema/compliance';
import {
  hiringApplicationSessions,
  hiringCases,
  hiringDriverApplicationFiles,
  hiringDriverApplications,
  hiringDriverAuthorizations,
  hiringLeads,
} from '../src/database/schema/hiring';
import { auditLogs, employees } from '../src/database/schema/people';
import { companies } from '../src/database/schema/roster';
import { DriverApplicationService } from '../src/modules/hiring/driver-application.service';
import { DRIVER_DISCLOSURES, DRIVER_DISCLOSURE_VERSION } from '../src/modules/hiring/driver-disclosures';
import { HiringService } from '../src/modules/hiring/hiring.service';
import { isSignedDocumentUrl, signedGet } from './authz/signed-get';

const R = '/api/v1/hiring/recruiting';
const PUBLIC = '/api/v1/public/driver-application';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** A real PNG (signature, IHDR, IDAT, IEND, valid CRCs) — what a canvas toDataURL produces. */
function png(width: number, height: number, seed = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7 + seed) % 256 === 0 ? 0 : i % (width * 4 + 1) === 0 ? 0 : (i + seed) % 3 === 0 ? 255 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2048), Buffer.from([0xff, 0xd9])]);
const PDF = Buffer.from('%PDF-1.4\n% medical card\n1 0 obj << >> endobj\n%%EOF\n');
const GIF = Buffer.from('GIF89a........');

type Part = { name: string; value: string } | { name: string; fileName: string; type: string; bytes: Buffer };

function multipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = `----NewayTest${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('value' in p) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      chunks.push(Buffer.from(p.value, 'utf8'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.fileName}"\r\nContent-Type: ${p.type}\r\n\r\n`));
      chunks.push(p.bytes);
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * The personal driver application (owner brief, 2026-10-08), end to end through the same-origin
 * route the approved page posts to: Send application issues a link (copy ≠ send), the driver's
 * multipart lands in the SAME candidate with the recruiter kept, documents filed pending Safety's
 * review, MVR and PSP stored separately with the drawn image; retries, races, a new key, a dead
 * link, a storage failure and another company all behave.
 */
describe('Personal driver application (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  let seq = 0;
  const base = String(Math.floor(200 + Math.random() * 700));
  const phone = () => `+1469${base}${String((seq += 1) % 10000).padStart(4, '0')}`;
  let ip = 1;
  const nextIp = () => `10.49.${Math.floor(ip / 250)}.${(ip += 1) % 250}`;
  const managerEmail = `da.manage.${stamp}@test.local`;
  const viewerEmail = `da.view.${stamp}@test.local`;
  const as = (email: string) => ({ 'x-account': email });
  let recruiterEmp = '';
  let otherEmp = '';
  let managerUserId = '';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    method === 'GET' && isSignedDocumentUrl(url) ? signedGet(app, url, headers) : app.inject({
      method,
      url,
      remoteAddress: nextIp(),
      headers: payload === undefined ? headers : { 'content-type': 'application/json', ...headers },
      payload: payload as object | undefined,
    });

  const post = (parts: Part[], headers: Record<string, string> = {}, url = PUBLIC) => {
    const { body, contentType } = multipart(parts);
    return app.inject({ method: 'POST', url, remoteAddress: nextIp(), headers: { 'content-type': contentType, ...headers }, payload: body });
  };

  async function employee(first: string): Promise<string> {
    const res = await call('POST', '/api/v1/employees', {
      firstName: first,
      lastName: `Apply${stamp}`,
      workEmail: `${first.toLowerCase()}.${stamp}@test.local`,
      phone: '3125550199',
      department: 'hr',
      position: 'Recruiter',
      hireDate: '2026-10-01',
      employmentType: 'full_time',
      shiftTime: 'Day',
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function account(email: string, permissions: string[], employeeId: string): Promise<string> {
    const role = await call('POST', '/api/v1/admin/roles', { name: `Apply ${email}`, permissions });
    expect(role.statusCode, role.body).toBe(201);
    const created = await call('POST', '/api/v1/admin/users', {
      firstName: 'Rec',
      lastName: `Apply${stamp}`,
      email,
      phone: null,
      employeeId: null,
      roleIds: [(role.json() as { id: string }).id],
      invite: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
    expect((await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'active', reason: 'driver application e2e' })).statusCode).toBe(200);
    await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
    expect((await call('PATCH', `/api/v1/admin/users/${membershipId}/employee`, { employeeId })).statusCode).toBe(200);
    return userId;
  }

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // These specs cover the earlier order (application first); the journey's consent-first order is
    // a company setting, switched off here and restored after (recruiting-journey covers it).
    await app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: { 'content-type': 'application/json' }, payload: { values: { 'hiring.consent_first': false } } });
    db = app.get(DatabaseService).db;
    recruiterEmp = await employee('Greta');
    otherEmp = await employee('Other');
    managerUserId = await account(managerEmail, ['recruiting.view', 'recruiting.manage'], recruiterEmp);
    await account(viewerEmail, ['recruiting.view'], otherEmp);
  }, 180_000);

  afterAll(async () => {
    for (const id of [recruiterEmp, otherEmp]) if (id) await db.update(employees).set({ status: 'terminated' }).where(eq(employees.id, id));
    await app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: { 'content-type': 'application/json' }, payload: { values: { 'hiring.consent_first': true } } });
    await app.close();
  });

  async function newLead(name: string, recruiter = recruiterEmp): Promise<string> {
    const res = await call('POST', `${R}/leads`, { fullName: name, phone: phone(), source: 'instagram', assignment: 'recruiter', recruiterEmployeeId: recruiter });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { key: string }).key;
  }

  async function issue(key: string): Promise<{ token: string; issued: DriverApplicationLinkIssued }> {
    const res = await call('POST', `${R}/candidates/${key}/driver-application/session`, {});
    expect(res.statusCode, res.body).toBe(201);
    const issued = res.json() as DriverApplicationLinkIssued;
    return { issued, token: issued.url.split('#token=')[1] ?? '' };
  }

  const signed = (type: 'mvr' | 'psp', name: string, drawing = png(64, 16, type === 'mvr' ? 1 : 2)) => ({
    authorized: true,
    name,
    signature: name,
    signatureMethod: 'drawn',
    disclosureOpened: false,
    electronicSignature: true,
    drawing: `data:image/png;base64,${drawing.toString('base64')}`,
    signedAt: new Date().toISOString(),
    documentType: type,
    disclosureText: DRIVER_DISCLOSURES[type],
    disclosureSha256: sha(DRIVER_DISCLOSURES[type]),
    disclosureVersion: DRIVER_DISCLOSURE_VERSION,
  });

  // MVR and PSP are both required, so every submission carries both signed unless a test
  // replaces one of them on purpose.
  const fields = (token: string, over: Record<string, string> = {}, auth: Record<string, unknown> = {}) => {
    const signer = `${over.firstName ?? 'Dana'} ${over.lastName ?? `Driver${stamp}`}`;
    const v: Record<string, string> = {
      firstName: 'Dana',
      lastName: `Driver${stamp}`,
      phone: '(469) 555-0101',
      email: `dana.${stamp}@example.com`,
      address: '1 Main St',
      city: 'Dallas',
      stateZip: 'TX 75001',
      cdlClass: 'Class A',
      cdlState: 'TX',
      cdlExpiration: '2029-05-01',
      ssn: '123-45-6789',
      medicalExpiration: '2027-01-31',
      experience: '2–5 years',
      endorsements: 'Hazmat',
      position: 'Company driver',
      preference: 'Solo',
      startDate: '',
      routes: 'OTR',
      employer: 'Acme Freight',
      employmentStart: '2022-01',
      employmentEnd: '2026-09',
      leavingReason: 'Home time',
      accidents: '0',
      violations: '0',
      suspended: 'No',
      source: 'Instagram',
      details: '',
      consent: 'on',
      submissionKey: randomUUID(),
      applicationToken: token,
      schemaVersion: 'nwf-application-v1',
      authorizations: JSON.stringify({ mvr: signed('mvr', signer), psp: signed('psp', signer), ...auth }),
      ...over,
    };
    return Object.entries(v).map(([name, value]) => ({ name, value }) as Part);
  };
  const files = (): Part[] => [
    { name: 'cdlFront', fileName: 'cdl-front.jpg', type: 'image/jpeg', bytes: JPEG },
    { name: 'cdlBack', fileName: 'cdl back.png', type: 'image/png', bytes: png(20, 10, 3) },
    { name: 'medicalCard', fileName: 'medical.pdf', type: 'application/pdf', bytes: PDF },
  ];
  const fullName = `Dana Driver${stamp}`;

  let leadKey = '';
  let token = '';
  let submissionKey = '';
  let reference = '';
  const mvrPng = png(64, 16, 11);
  const pspPng = png(64, 16, 12);

  it('Send application issues a personal link once: only its digest is kept, copying is not sending', async () => {
    leadKey = await newLead(`Dana Driver${stamp}`);
    const viewer = await call('POST', `${R}/candidates/${leadKey}/driver-application/session`, {}, as(viewerEmail));
    expect(viewer.statusCode).toBe(403);
    const before = (await call('GET', `${R}/candidates/${leadKey}`)).json() as RecruitCandidate;
    expect(before.driverApplication.session).toBeNull();

    const made = await issue(leadKey);
    token = made.token;
    expect(made.issued.url).toMatch(/\/application\/#token=[A-Za-z0-9_-]{43}$/);
    expect(made.issued.session.state).toBe('live');
    const [row] = await db.select().from(hiringApplicationSessions).where(eq(hiringApplicationSessions.id, made.issued.session.id));
    expect(row?.tokenHash).toBe(sha(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row?.leadId).toBe(leadKey);

    // Copy is recorded as a copy; "sent" stays empty until the recruiter says so.
    const copied = await call('POST', `${R}/candidates/${leadKey}/driver-application/session/copied`, {});
    expect(copied.statusCode, copied.body).toBe(200);
    let view = (await call('GET', `${R}/candidates/${leadKey}/driver-application`)).json() as DriverApplicationView;
    expect(view.session?.linkCopiedAt).not.toBeNull();
    expect(view.session?.markedSentAt).toBeNull();
    const sent = await call('POST', `${R}/candidates/${leadKey}/driver-application/session/mark-sent`, { channel: 'SMS' });
    expect(sent.statusCode, sent.body).toBe(200);
    view = (await call('GET', `${R}/candidates/${leadKey}/driver-application`)).json() as DriverApplicationView;
    expect(view.session?.markedSentChannel).toBe('SMS');
    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, leadKey))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['driver_application_link_created', 'driver_application_link_copied', 'driver_application_link_marked_sent']));
    // The lead is still a lead: issuing a link converts nothing and takes no rotation turn.
    const [lead] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, leadKey));
    expect(lead?.hiringCaseId).toBeNull();
    expect(lead?.recruiterEmployeeId).toBe(recruiterEmp);
    // The link is out: the lead waits for the driver's application.
    expect(((await call('GET', `${R}/candidates/${leadKey}`)).json() as RecruitCandidate).nextStep).toBe('Waiting for application');
    expect((await call('POST', `/api/v1/hiring/leads/${leadKey}/contacted`, {})).statusCode).toBeLessThan(300);
    const after = (await call('GET', `${R}/candidates/${leadKey}`)).json() as RecruitCandidate;
    // A live application link (the earlier order) reads as sent and waits for the driver.
    expect(after.progress).toBe('application_sent');
    expect(after.nextStep).toBe('Waiting for application');
  });

  it('refuses an empty, unknown or malformed token with 401 and a message the page can show', async () => {
    for (const t of ['', 'nope', randomBytes(32).toString('base64url')]) {
      const res = await post(fields(t));
      expect(res.statusCode).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/not valid/);
      expect(res.body).not.toContain('123-45-6789');
    }
  });

  it('validates on the server: fields, file types and sizes, signatures, the name and the disclosure', async () => {
    const cases: [Part[], number, RegExp][] = [
      [fields(token, { email: 'not-an-email' }), 422, /Email/],
      [fields(token, { cdlClass: 'Class Z' }), 422, /CDL class/],
      [fields(token, { ssn: '12-34' }), 422, /Social Security/],
      [fields(token, { consent: '' }), 422, /Confirm|consent/i],
      [fields(token, { schemaVersion: 'v0' }), 422, /out of date/],
      [[...fields(token), { name: 'cdlFront', fileName: 'a.gif', type: 'image/jpeg', bytes: GIF }], 422, /JPG, PNG or PDF/],
      [[...fields(token), { name: 'cdlFront', fileName: 'big.pdf', type: 'application/pdf', bytes: Buffer.concat([PDF, Buffer.alloc(8 * 1024 * 1024)]) }], 413, /8 MB/],
      [[...fields(token), { name: 'passport', fileName: 'p.pdf', type: 'application/pdf', bytes: PDF }], 422, /unexpected file/],
      [fields(token, { surprise: 'x' }), 422, /unexpected field/],
      [fields(token, {}, { mvr: signed('mvr', 'Someone Else') }), 422, /Your name changed\. Please sign the MVR/],
      [fields(token, {}, { psp: { ...signed('psp', fullName), disclosureText: `${DRIVER_DISCLOSURES.psp} (edited)` } }), 422, /PSP authorization text is out of date/],
      [fields(token, {}, { psp: { ...signed('psp', fullName), disclosureSha256: sha('x') } }), 422, /out of date/],
      [fields(token, {}, { mvr: { ...signed('mvr', fullName), drawing: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}` } }), 422, /signature could not be read/],
      [fields(token, {}, { mvr: { ...signed('mvr', fullName), drawing: undefined } }), 422, /incomplete/],
      [fields(token, {}, { clearinghouse: { authorized: false } }), 422, /incomplete/],
    ];
    for (const [parts, status, message] of cases) {
      const res = await post(parts);
      expect(res.statusCode, res.body).toBe(status);
      expect((res.json() as { error: string }).error).toMatch(message);
      expect(res.body).not.toMatch(/123-45-6789|storage|driver-application\//);
    }
    // Nothing was stored by any of them.
    const [row] = await db.select().from(hiringApplicationSessions).where(eq(hiringApplicationSessions.tokenHash, sha(token)));
    expect(row?.submittedAt).toBeNull();
    expect((await db.select().from(hiringDriverApplications).where(eq(hiringDriverApplications.sessionId, row?.id ?? '-'))).length).toBe(0);
    // multipart is accepted on this route only.
    const elsewhere = await post(fields(token), {}, '/api/v1/hiring/recruiting/leads');
    expect(elsewhere.statusCode).toBe(415);
    // Past the aggregate limit (three 8 MB files and more), refused before the route: 413, JSON.
    const huge = await post([
      ...fields(token),
      ...(['cdlFront', 'cdlBack', 'medicalCard'] as const).map((name) => ({ name, fileName: 'x.pdf', type: 'application/pdf', bytes: Buffer.concat([PDF, Buffer.alloc(8 * 1024 * 1024 - 200)]) })),
      { name: 'extra', fileName: 'y.pdf', type: 'application/pdf', bytes: Buffer.alloc(4 * 1024 * 1024) },
    ]);
    expect(huge.statusCode).toBe(413);
    expect((huge.json() as { error: string }).error).toMatch(/too large/);
  });

  it('accepts a valid application into the SAME candidate: recruiter kept, documents filed pending review, both drawn signatures stored', async () => {
    const parts = [...fields(token, {}, { mvr: signed('mvr', fullName, mvrPng), psp: signed('psp', fullName, pspPng) }), ...files()];
    submissionKey = (parts.find((p) => p.name === 'submissionKey') as { value: string }).value;
    const res = await post(parts, { origin: 'https://neway.example.com' });
    expect(res.statusCode, res.body).toBe(201);
    const ack = res.json() as { tmsSaved: boolean; reference: string };
    expect(ack.tmsSaved).toBe(true);
    expect(ack.reference).toMatch(/^APP-[A-Z0-9]{8}$/);
    reference = ack.reference;

    const [lead] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, leadKey));
    expect(lead?.status).toBe('converted');
    const [c] = await db.select().from(hiringCases).where(eq(hiringCases.id, lead?.hiringCaseId ?? '-'));
    expect(c?.recruiterId).toBe(recruiterEmp);
    expect(c?.driverId).toMatch(/^drv_\d+$/);
    const [app1] = await db.select().from(hiringDriverApplications).where(eq(hiringDriverApplications.reference, reference));
    expect(app1?.hiringCaseId).toBe(c?.id);
    expect(app1?.driverId).toBe(c?.driverId);
    expect(app1?.ssnLast4).toBe('6789');
    expect(JSON.stringify(app1?.answers)).not.toContain('6789');
    expect(JSON.stringify(app1?.ssnSealed)).not.toContain('123456789');

    const fileRows = await db.select().from(hiringDriverApplicationFiles).where(eq(hiringDriverApplicationFiles.applicationId, app1?.id ?? '-'));
    expect(fileRows.map((f) => f.code).sort()).toEqual(['cdl', 'cdl_back', 'medical_card']);
    expect(fileRows.find((f) => f.code === 'cdl')?.sha256).toBe(sha(JPEG));
    const docs = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.companyId, 'co_northwind'), eq(complianceDocuments.ownerId, c?.driverId ?? '-')));
    expect(docs.map((d) => d.requirementCode).sort()).toEqual(['cdl', 'cdl_back', 'medical_card']);
    expect(docs.every((d) => d.status === 'pending_review' && d.source === 'public_link')).toBe(true);
    expect(docs.find((d) => d.requirementCode === 'cdl')?.expiresOn).toBe('2029-05-01');

    const auths = await db.select().from(hiringDriverAuthorizations).where(eq(hiringDriverAuthorizations.applicationId, app1?.id ?? '-'));
    expect(auths.map((a) => `${a.documentType}:${a.decision}`).sort()).toEqual(['mvr:signed', 'psp:signed']);
    const storage = app.get(DriverApplicationService)['storage'] as DocumentStorageService;
    const mvr = auths.find((a) => a.documentType === 'mvr');
    expect(mvr?.signerName).toBe(fullName);
    expect(mvr?.disclosureSha256).toBe(sha(DRIVER_DISCLOSURES.mvr));
    expect(mvr?.disclosureText).toBe(DRIVER_DISCLOSURES.mvr);
    expect(mvr?.signatureWidth).toBe(64);
    expect((await storage.get(mvr?.signatureStorageKey ?? '-')).equals(mvrPng)).toBe(true);
    const psp = auths.find((a) => a.documentType === 'psp');
    expect((await storage.get(psp?.signatureStorageKey ?? '-')).equals(pspPng)).toBe(true);

    // The recruiter is told, only now, and the notification opens the same candidate.
    const told = await db.select().from(notifications).where(and(eq(notifications.recipientUserId, managerUserId), eq(notifications.entityId, c?.applicantId ?? '-')));
    expect(told.map((n) => n.title)).toContain(`Application submitted — ${fullName}`);
    const received = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, c?.applicantId ?? '-'), eq(auditLogs.action, 'driver_application_received')));
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).not.toContain('123-45-6789');
  });

  it('the TMS candidate shows the application (SSN masked), documents and consents, after a refresh', async () => {
    const c = (await call('GET', `${R}/candidates/${leadKey}`)).json() as RecruitCandidate;
    expect(c.progress).toBe('application_received');
    expect(c.recruiter?.employeeId).toBe(recruiterEmp);
    const s = c.driverApplication.submission;
    expect(s?.reference).toBe(reference);
    expect(s?.ssnMasked).toBe('•••-••-6789');
    expect(JSON.stringify(c)).not.toContain('123-45-6789');
    expect(s?.answers.find((a) => a.key === 'email')?.value).toBe(`dana.${stamp}@example.com`);
    expect(s?.files.map((f) => `${f.code}:${f.documentStatus}`)).toEqual(['cdl:pending_review', 'cdl_back:pending_review', 'medical_card:pending_review']);
    expect(s?.authorizations.map((a) => `${a.type}:${a.decision}:${a.signerName}`)).toEqual([`mvr:signed:${fullName}`, `psp:signed:${fullName}`]);
    expect(c.driverApplication.session?.state).toBe('submitted');
    // The candidate key moved to the applicant; the lead key still opens the same person.
    const byApplicant = (await call('GET', `${R}/candidates/${c.applicantId}`)).json() as RecruitCandidate;
    expect(byApplicant.driverApplication.submission?.reference).toBe(reference);

    // Previews only through the authorized handlers: the exact bytes, never cached.
    const cdl = s?.files.find((f) => f.code === 'cdl');
    const file = await call('GET', `${R}/candidates/${leadKey}/driver-application/files/${cdl?.id}`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(JPEG)).toBe(true);
    expect(file.headers['cache-control']).toBe('private, no-store');
    const mvr = s?.authorizations.find((a) => a.type === 'mvr');
    const sig = await call('GET', `${R}/candidates/${leadKey}/driver-application/authorizations/${mvr?.id}/signature`);
    expect(sig.headers['content-type']).toBe('image/png');
    expect(sig.rawPayload.equals(mvrPng)).toBe(true);
    const pdf = await call('GET', `${R}/candidates/${leadKey}/driver-application/authorizations/${mvr?.id}/pdf`);
    expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const whole = await call('GET', `${R}/candidates/${leadKey}/driver-application/pdf`);
    expect(whole.statusCode, whole.body.slice(0, 200)).toBe(200);
    expect(whole.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(whole.rawPayload.toString('latin1')).not.toContain('123-45-6789');
    // A recruiter who does not own this candidate (and cannot manage) gets nothing.
    expect((await call('GET', `${R}/candidates/${leadKey}/driver-application/files/${cdl?.id}`, undefined, as(viewerEmail))).statusCode).toBe(403);
    // The full SSN needs the restricted-records permission, and its reveal is audited.
    expect((await call('POST', `${R}/candidates/${leadKey}/driver-application/ssn`, {}, as(managerEmail))).statusCode).toBe(403);
    const reveal = await call('POST', `${R}/candidates/${leadKey}/driver-application/ssn`, {});
    if (reveal.statusCode === 200) {
      expect((reveal.json() as { ssn: string }).ssn).toBe('123-45-6789');
      expect((await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, leadKey), eq(auditLogs.action, 'ssn_revealed')))).length).toBe(1);
    }
  });

  it('a retry gets the same reference; a reload (new key) and a second issue are refused; nothing is duplicated', async () => {
    const parts = [...fields(token, { submissionKey }, { mvr: signed('mvr', fullName, mvrPng), psp: signed('psp', fullName, pspPng) }), ...files()];
    const again = await post(parts);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ tmsSaved: true, reference });
    const reload = await post([...fields(token, {}, {}), ...files()]);
    expect(reload.statusCode).toBe(409);
    expect((reload.json() as { error: string }).error).toContain(reference);
    const [lead] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, leadKey));
    expect((await db.select().from(hiringDriverApplications).where(eq(hiringDriverApplications.hiringCaseId, lead?.hiringCaseId ?? '-'))).length).toBe(1);
    expect((await db.select().from(hiringDriverApplicationFiles).where(eq(hiringDriverApplicationFiles.hiringCaseId, lead?.hiringCaseId ?? '-'))).length).toBe(3);
    const reissue = await call('POST', `${R}/candidates/${leadKey}/driver-application/session`, {});
    expect(reissue.statusCode).toBe(409);
  });

  it('simultaneous deliveries of one submission make one application with one set of rows', async () => {
    const key = await newLead(`Sam Same${stamp}`);
    const { token: t } = await issue(key);
    const name = `Sam Same${stamp}`;
    const parts = [...fields(t, { firstName: 'Sam', lastName: `Same${stamp}` }, { mvr: signed('mvr', name) }), ...files()];
    const results = await Promise.all([post(parts), post(parts), post(parts)]);
    const refs = new Set(results.map((r) => (r.json() as { reference: string }).reference));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    expect(refs.size).toBe(1);
    const [lead] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, key));
    expect((await db.select().from(hiringDriverApplications).where(eq(hiringDriverApplications.hiringCaseId, lead?.hiringCaseId ?? '-'))).length).toBe(1);
    expect((await db.select().from(hiringCases).where(eq(hiringCases.applicantId, lead?.applicantId ?? '-'))).length).toBe(1);
    expect((await db.select().from(hiringDriverAuthorizations).where(eq(hiringDriverAuthorizations.hiringCaseId, lead?.hiringCaseId ?? '-'))).length).toBe(2);
  });

  it('MVR and PSP are not asked on the application (they are on the consent form): one sent without them is saved', async () => {
    const key = await newLead(`Nora None${stamp}`);
    const { token: t } = await issue(key);
    const who = { firstName: 'Nora', lastName: `None${stamp}` };
    const res = await post(fields(t, who, { mvr: undefined, psp: undefined }));
    expect(res.statusCode, res.body).toBe(201);
    const c = (await call('GET', `${R}/candidates/${key}`)).json() as RecruitCandidate;
    expect(c.driverApplication.submission?.authorizations.every((a) => a.decision !== 'signed')).toBe(true);
  });

  it('an expired or turned-off link answers 410', async () => {
    const key = await newLead(`Ed Expired${stamp}`);
    const first = await issue(key);
    const second = await issue(key);
    const old = await post(fields(first.token, { firstName: 'Ed', lastName: `Expired${stamp}` }));
    expect(old.statusCode).toBe(410);
    expect((old.json() as { error: string }).error).toMatch(/expired/);
    await db.update(hiringApplicationSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(hiringApplicationSessions.id, second.issued.session.id));
    expect((await post(fields(second.token, { firstName: 'Ed', lastName: `Expired${stamp}` }))).statusCode).toBe(410);
  });

  it('a storage failure acknowledges nothing and leaves no partial state; the retry then succeeds', async () => {
    const key = await newLead(`Fay Fail${stamp}`);
    const { token: t, issued } = await issue(key);
    const name = `Fay Fail${stamp}`;
    const parts = [...fields(t, { firstName: 'Fay', lastName: `Fail${stamp}` }, { psp: signed('psp', name) }), ...files()];
    const storage = app.get(DriverApplicationService)['storage'] as DocumentStorageService;
    const real = storage.put.bind(storage);
    const written: string[] = [];
    let n = 0;
    const spy = vi.spyOn(storage, 'put').mockImplementation(async (k, bytes) => {
      n += 1;
      if (n === 3) throw new Error('disk full');
      written.push(k);
      return real(k, bytes);
    });
    const failed = await post(parts);
    spy.mockRestore();
    expect(failed.statusCode).toBe(503);
    expect((failed.json() as { error: string }).error).toMatch(/could not save/);
    expect(failed.body).not.toMatch(/disk full|driver-application\//);
    const [s] = await db.select().from(hiringApplicationSessions).where(eq(hiringApplicationSessions.id, issued.session.id));
    expect(s?.submittedAt).toBeNull();
    expect(s?.stagingKeys).toEqual([]);
    expect((await db.select().from(hiringDriverApplications).where(eq(hiringDriverApplications.sessionId, issued.session.id))).length).toBe(0);
    for (const k of written) expect(await storage.exists(k)).toBe(false);
    const c = (await call('GET', `${R}/candidates/${key}`)).json() as RecruitCandidate;
    expect(c.progress).not.toBe('application_received');
    expect(c.driverApplication.submission).toBeNull();

    // A crash between staging and commit (a restart) leaves journalled keys; the next attempt
    // removes them before it stages its own, and then commits.
    const orphan = `driver-application/co_northwind/${issued.session.id}/crashed/cdl.jpg`;
    await storage.put(orphan, JPEG);
    await db.update(hiringApplicationSessions).set({ stagingKeys: [orphan] }).where(eq(hiringApplicationSessions.id, issued.session.id));
    const retry = await post(parts);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(await storage.exists(orphan)).toBe(false);
    const [done] = await db.select().from(hiringApplicationSessions).where(eq(hiringApplicationSessions.id, issued.session.id));
    expect(done?.stagingKeys).toEqual([]);
    expect(done?.submittedAt).not.toBeNull();
  });

  it("another company's link lands in that company only; its records are unreachable from here", async () => {
    const co = `co_da_${stamp}`;
    await db.insert(companies).values({ id: co, name: `Elsewhere ${stamp}` });
    const leadId = `lead_${randomUUID()}`;
    await db.insert(hiringLeads).values({ id: leadId, companyId: co, leadNumber: 'LEAD-1', firstName: 'Out', lastName: `Side${stamp}`, phone: '+13125550000', source: 'website' });
    const t = randomBytes(32).toString('base64url');
    await db.insert(hiringApplicationSessions).values({
      id: `aps_${randomUUID()}`,
      companyId: co,
      leadId,
      subjectKey: leadId,
      tokenHash: sha(t),
      schemaVersion: 'nwf-application-v1',
      createdByUserId: 'x',
      createdByName: 'x',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const res = await post([...fields(t, { firstName: 'Out', lastName: `Side${stamp}` }), ...files()]);
    expect(res.statusCode, res.body).toBe(201);
    const [app2] = await db.select().from(hiringDriverApplications).where(eq(hiringDriverApplications.leadId, leadId));
    expect(app2?.companyId).toBe(co);
    const [c2] = await db.select().from(hiringCases).where(eq(hiringCases.id, app2?.hiringCaseId ?? '-'));
    expect(c2?.companyId).toBe(co);
    const [f2] = await db.select().from(hiringDriverApplicationFiles).where(eq(hiringDriverApplicationFiles.applicationId, app2?.id ?? '-'));
    // From this company: the lead is not on file, and its file id does not open on our candidate.
    expect((await call('GET', `${R}/candidates/${leadId}`)).statusCode).toBe(404);
    expect((await call('GET', `${R}/candidates/${leadKey}/driver-application/files/${f2?.id}`)).statusCode).toBe(404);
  });

  it('Safety and Hire reuse the reserved driver and the filed documents — nothing to upload again', async () => {
    const c = (await call('GET', `${R}/candidates/${leadKey}`)).json() as RecruitCandidate;
    const readiness: SendToSafetyReadiness = c.sendToSafety;
    expect(readiness.checks.find((x) => x.code === 'cdl')?.ok).toBe(true);
    expect(readiness.checks.find((x) => x.code === 'medical_card')?.ok).toBe(true);
    expect(c.driverId).toBe(c.hire.driverId);
    const docs = (await call('GET', `/api/v1/hiring/cases/${c.caseId}/documents`)).json() as { driverId: string; documents: { requirementCode: string }[] };
    expect(docs.driverId).toBe(c.driverId);
    expect(docs.documents.map((d) => d.requirementCode)).toEqual(expect.arrayContaining(['cdl', 'cdl_back', 'medical_card']));
  });

  it('HTTPS only when required; a foreign browser origin is refused', async () => {
    const mutable = env as { PUBLIC_LINKS_REQUIRE_HTTPS?: string };
    const before = mutable.PUBLIC_LINKS_REQUIRE_HTTPS;
    mutable.PUBLIC_LINKS_REQUIRE_HTTPS = 'true';
    try {
      expect((await post(fields(token))).statusCode).toBe(403);
    } finally {
      mutable.PUBLIC_LINKS_REQUIRE_HTTPS = before;
    }
    const foreign = await post(fields(token), { origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
  });

  it('the server-to-server forwarder: signed, fresh and once — otherwise refused', async () => {
    const mutable = env as { EXTERNAL_APPLICATION_SECRET?: string; EXTERNAL_APPLICATION_COMPANIES?: string };
    const saved = { ...mutable };
    const secret = 'forwarder-secret-0123456789';
    const key = await newLead(`Fred Forward${stamp}`);
    const { token: t } = await issue(key);
    const { body, contentType } = multipart(fields(t, { firstName: 'Fred', lastName: `Forward${stamp}` }));
    const sign = (ts: number, b = body) => `v1=${createHmac('sha256', secret).update(`${ts}.${sha(b)}`).digest('hex')}`;
    const send = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `${PUBLIC}/forwarded`, remoteAddress: nextIp(), headers: { 'content-type': contentType, ...headers }, payload: body });
    try {
      expect((await send({})).statusCode).toBe(404);
      mutable.EXTERNAL_APPLICATION_SECRET = secret;
      mutable.EXTERNAL_APPLICATION_COMPANIES = 'co_northwind';
      const now = Math.floor(Date.now() / 1000);
      expect((await send({ 'x-neway-timestamp': String(now), 'x-neway-signature': 'v1=00' })).statusCode).toBe(401);
      expect((await send({ 'x-neway-timestamp': String(now - 3600), 'x-neway-signature': sign(now - 3600) })).statusCode).toBe(401);
      const ok = await send({ 'x-neway-timestamp': String(now), 'x-neway-signature': sign(now), 'x-neway-client-ip': '203.0.113.9' });
      expect(ok.statusCode, ok.body).toBe(201);
      expect((ok.json() as { tmsSaved: boolean }).tmsSaved).toBe(true);
      expect((await send({ 'x-neway-timestamp': String(now), 'x-neway-signature': sign(now) })).statusCode).toBe(409);
      const [row] = await db.select().from(hiringDriverApplications).where(eq(hiringDriverApplications.reference, (ok.json() as { reference: string }).reference));
      expect(row?.via).toBe('forwarder');
    } finally {
      mutable.EXTERNAL_APPLICATION_SECRET = saved.EXTERNAL_APPLICATION_SECRET;
      mutable.EXTERNAL_APPLICATION_COMPANIES = saved.EXTERNAL_APPLICATION_COMPANIES;
    }
  });
});
