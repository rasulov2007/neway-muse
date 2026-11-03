import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  CandidateJourney,
  ConsentFormContext,
  ConsentLinkIssued,
  DriverApplicationLinkIssued,
  RecruitCandidate,
  RecruitDashboard,
  RecruitList,
} from '@neway/shared';
import { SAFETY_SCREENING_QUESTIONS } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { notifications, memberships, users } from '../src/database/schema/admin';
import { complianceDocuments } from '../src/database/schema/compliance';
import { hiringCases, hiringConsentSessions, hiringConsents, hiringCostEntries } from '../src/database/schema/hiring';
import { applicants } from '../src/database/schema/hr';
import { employees } from '../src/database/schema/people';
import { drivers } from '../src/database/schema/roster';
import { acctExpenses } from '../src/database/schema/accounting';
import { isSignedDocumentUrl, signedGet } from './authz/signed-get';

const R = '/api/v1/hiring/recruiting';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

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
  for (let i = 0; i < raw.length; i += 1) raw[i] = i % (width * 4 + 1) === 0 ? 0 : (i + seed) % 3 === 0 ? 255 : 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2048), Buffer.from([0xff, 0xd9])]);
const PDF = Buffer.from('%PDF-1.4\n% report\n1 0 obj << >> endobj\n%%EOF\n');

type Part = { name: string; value: string } | { name: string; fileName: string; type: string; bytes: Buffer };
function multipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = `----NewayJourney${randomBytes(8).toString('hex')}`;
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
 * The recruiting journey (owner brief, 2026-10-11), end to end on isolated test data:
 * Lead → Consent → Safety approval → Application → Onboarding → Costs → Hire → Driver documents,
 * with the gates that must hold between them, retries that must not duplicate anything, the
 * restricted IP, and a dashboard whose numbers reconcile with the list they open.
 */

/**
 * The text a PDF draws, as far as a test needs it: every content stream inflated, and the hex
 * strings pdf-lib writes (<3230332E…>) turned back into characters. The raw bytes are compressed,
 * so searching them proves nothing either way.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      out += raw.slice(start, end);
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) => Buffer.from(hex, 'hex').toString('latin1'));
}

describe('Recruiting journey (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  let ipSeq = 1;
  const nextIp = () => `10.50.${Math.floor(ipSeq / 250)}.${(ipSeq += 1) % 250}`;
  const recruiterEmail = `jr.recruiter.${stamp}@test.local`;
  const as = (email: string) => ({ 'x-account': email });
  let recruiterEmp = '';
  let dispatcherEmp = '';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}, remoteAddress = nextIp()) =>
    method === 'GET' && isSignedDocumentUrl(url) ? signedGet(app, url, headers) : app.inject({ method, url, remoteAddress, headers: payload === undefined ? headers : { 'content-type': 'application/json', ...headers }, payload: payload as object | undefined });
  const postForm = (url: string, parts: Part[], remoteAddress = nextIp()) => {
    const { body, contentType } = multipart(parts);
    return app.inject({ method: 'POST', url, remoteAddress, headers: { 'content-type': contentType }, payload: body });
  };

  async function employee(first: string, position: string): Promise<string> {
    const res = await call('POST', '/api/v1/employees', {
      firstName: first,
      lastName: `Journey${stamp}`,
      workEmail: `${first.toLowerCase()}.journey.${stamp}@test.local`,
      phone: '3125550198',
      department: position === 'Dispatcher' ? 'dispatch' : 'hr',
      position,
      hireDate: '2026-10-01',
      employmentType: 'full_time',
      shiftTime: 'Day',
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.get(ComplianceSeedService).seed();
    await app.get(HiringSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    recruiterEmp = await employee('Rita', 'Recruiter');
    dispatcherEmp = await employee('Dino', 'Dispatcher');
    // A recruiter who manages recruiting but is not Safety and not Accounting.
    const role = await call('POST', '/api/v1/admin/roles', { name: `Journey recruiter ${stamp}`, permissions: ['recruiting.view', 'recruiting.manage'] });
    expect(role.statusCode, role.body).toBe(201);
    const created = await call('POST', '/api/v1/admin/users', {
      firstName: 'Rita',
      lastName: `Journey${stamp}`,
      email: recruiterEmail,
      phone: null,
      employeeId: null,
      roleIds: [(role.json() as { id: string }).id],
      invite: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
    expect((await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'active', reason: 'journey e2e' })).statusCode).toBe(200);
    await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
    expect((await call('PATCH', `/api/v1/admin/users/${membershipId}/employee`, { employeeId: recruiterEmp })).statusCode).toBe(200);
  }, 180_000);

  afterAll(async () => {
    // Test data: the people this suite made are marked so they leave every list and count.
    const [c] = await db.select().from(hiringCases).where(eq(hiringCases.candidateName, `Jordan Journey${stamp}`));
    if (c) await db.update(hiringCases).set({ isTest: true, testMarkedAt: new Date(), testMarkedBy: 'journey e2e', testReason: 'e2e' }).where(eq(hiringCases.id, c.id));
    for (const id of [recruiterEmp, dispatcherEmp]) if (id) await db.update(employees).set({ status: 'terminated' }).where(eq(employees.id, id));
    await app.close();
  });

  let key = '';
  let consentToken = '';
  const first = 'Jordan';
  const last = `Journey${stamp}`;
  const journey = async () => (await call('GET', `${R}/candidates/${key}/journey`)).json() as CandidateJourney;
  const candidate = async () => (await call('GET', `${R}/candidates/${key}`)).json() as RecruitCandidate;

  it('1-2: a lead is added, then a consent link is made once (digest kept, copy is not send)', async () => {
    const res = await call('POST', `${R}/leads`, { fullName: `${first} ${last}`, phone: `+1469${String(Date.now()).slice(-7)}`, source: 'instagram', assignment: 'recruiter', recruiterEmployeeId: recruiterEmp });
    expect(res.statusCode, res.body).toBe(201);
    key = (res.json() as { key: string }).key;
    expect((await candidate()).nextStep).toBe('Contact driver');
    expect((await call('POST', `/api/v1/hiring/leads/${key}/contacted`, {})).statusCode).toBeLessThan(300);
    expect((await candidate()).nextStep).toBe('Send consent');

    const issued = await call('POST', `${R}/candidates/${key}/journey/consent/link`, {}, as(recruiterEmail));
    expect(issued.statusCode, issued.body).toBe(201);
    const link = issued.json() as ConsentLinkIssued;
    expect(link.url).toMatch(/\/consent\/#token=[A-Za-z0-9_-]{43}$/);
    consentToken = link.url.split('#token=')[1] ?? '';
    const [row] = await db.select().from(hiringConsentSessions).where(eq(hiringConsentSessions.id, link.session.id));
    expect(row?.tokenHash).toBe(sha(consentToken));
    expect(JSON.stringify(row)).not.toContain(consentToken);

    expect((await call('POST', `${R}/candidates/${key}/journey/consent/copied`, {}, as(recruiterEmail))).statusCode).toBe(200);
    let j = await journey();
    expect(j.consent.session?.linkCopiedAt).not.toBeNull();
    expect(j.consent.session?.markedSentAt).toBeNull();
    expect(j.consent.session?.emailedAt).toBeNull();
    // No SMTP in tests: email refuses rather than pretending.
    const email = await call('POST', `${R}/candidates/${key}/journey/consent/email`, { to: 'x@example.com' }, as(recruiterEmail));
    expect(email.statusCode).toBe(409);
    expect((await call('POST', `${R}/candidates/${key}/journey/consent/mark-sent`, { channel: 'SMS' }, as(recruiterEmail))).statusCode).toBe(200);
    j = await journey();
    expect(j.consent.session?.markedSentChannel).toBe('SMS');
    expect((await candidate()).progress).toBe('consent_sent');
  });

  let context: ConsentFormContext;
  it('3: the consent page reads its form from the token; opening is recorded but is not reading', async () => {
    const res = await call('POST', '/api/v1/public/consent/form', { token: consentToken });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    context = res.json() as ConsentFormContext;
    expect(context.firstName).toBe(first);
    expect(context.disclosures.map((d) => d.type)).toEqual(['mvr', 'psp', 'clearinghouse']);
    // The company's Clearinghouse wording is not on file yet: listed as pending, never signable.
    // The FMCSA sample limited consent, with the employer filled in and the driver's name left for the page.
    expect(context.pending).toEqual([]);
    expect(context.disclosures.find((d) => d.type === 'clearinghouse')?.driverNamePlaceholder).toBe('(Driver Name)');
    expect(context.disclosures.find((d) => d.type === 'psp')?.text).toContain('PSP');
    const j = await journey();
    expect(j.consent.session?.openCount).toBe(1);
    expect(j.consent.clearinghouseAvailable).toBe(true);
    expect((await call('POST', '/api/v1/public/consent/form', { token: 'nope' })).statusCode).toBe(401);
  });

  const consentParts = (over: Record<string, string> = {}, withFile = true): Part[] => {
    const v: Record<string, string> = {
      token: consentToken,
      submissionKey: randomUUID(),
      firstName: first,
      lastName: last,
      phone: '(469) 555-0177',
      email: `jordan.${stamp}@example.com`,
      confirmed: 'true',
      signatureMethod: 'typed',
      signatureText: `${first} ${last}`,
      clientSignedAt: new Date().toISOString(),
      documents: JSON.stringify(context.disclosures.map((d) => ({ type: d.type, version: d.version, sha256: d.sha256 }))),
      safetyAnswers: JSON.stringify(Object.fromEntries(SAFETY_SCREENING_QUESTIONS.map((q) => [q.key, false]))),
      ...over,
    };
    const parts: Part[] = Object.entries(v).map(([name, value]) => ({ name, value }));
    if (withFile) parts.push({ name: 'cdlFront', fileName: 'cdl-front.jpg', type: 'image/jpeg', bytes: JPEG }, { name: 'cdlBack', fileName: 'cdl-back.png', type: 'image/png', bytes: png(20, 10, 3) });
    return parts;
  };

  let consentRef = '';
  it('3: the consent is validated on the server and saved once; a retry gets the same reference', async () => {
    const cases: [Part[], number, RegExp][] = [
      [consentParts({}, false), 422, /front of your CDL/],
      [consentParts({ safetyAnswers: JSON.stringify({ dui: false }) }), 422, /safety question/],
      [consentParts({ confirmed: 'false' }), 422, /confirmation/i],
      [consentParts({ documents: JSON.stringify([{ type: 'mvr', version: context.disclosures[0]?.version, sha256: 'x' }]) }), 422, /out of date/],
      [consentParts({ documents: JSON.stringify([...context.disclosures.map((d) => ({ type: d.type, version: d.version, sha256: d.sha256 })), { type: 'drug_test', version: 'v', sha256: 's' }]) }), 422, /not available/],
      [consentParts({ signatureMethod: 'drawn', signatureText: '', signatureDrawing: 'data:image/png;base64,bm90' }), 422, /signature/i],
    ];
    for (const [parts, status, message] of cases) {
      const res = await postForm('/api/v1/public/consent/submit', parts);
      expect(res.statusCode, res.body).toBe(status);
      expect((res.json() as { error: string }).error).toMatch(message);
    }
    const submissionKey = randomUUID();
    const ip = '203.0.113.24';
    const ok = await postForm('/api/v1/public/consent/submit', consentParts({ submissionKey }), ip);
    expect(ok.statusCode, ok.body).toBe(201);
    consentRef = (ok.json() as { reference: string }).reference;
    expect(consentRef).toMatch(/^CNS-/);
    // Recruiting hears it at once (owner, 2026-10-12): the lead's recruiter gets a notification.
    const heard = await db.select().from(notifications).where(eq(notifications.title, `Consent received — ${first} ${last}`));
    expect(heard.length).toBeGreaterThan(0);
    const again = await postForm('/api/v1/public/consent/submit', consentParts({ submissionKey }));
    expect(again.statusCode).toBe(200);
    expect((again.json() as { reference: string }).reference).toBe(consentRef);
    const other = await postForm('/api/v1/public/consent/submit', consentParts());
    expect(other.statusCode).toBe(409);
    const rows = await db.select().from(hiringConsents).where(eq(hiringConsents.reference, consentRef));
    expect(rows).toHaveLength(1);
    // The IP is sealed, never stored in the clear.
    expect(JSON.stringify(rows[0])).not.toContain(ip);

    const j = await journey();
    expect(j.consent.submission?.documents.map((d) => d.type)).toEqual(['mvr', 'psp', 'clearinghouse']);
    expect(j.consent.submission?.files.map((f) => f.label)).toEqual(expect.arrayContaining(['CDL (front)', 'CDL (back)']));
    // The owner account holds the restricted-records permission and sees the IP; a recruiter does not.
    expect(j.consent.submission?.audit.ipAddress).toBe(ip);
    const r = (await call('GET', `${R}/candidates/${key}/journey`, undefined, as(recruiterEmail))).json() as CandidateJourney;
    expect(r.consent.submission?.audit.ipAddress).toBeNull();
    expect((await candidate()).progress).toBe('consent_received');
    expect((await candidate()).nextStep).toBe('Send to Safety');

    const pdf = await call('GET', `${R}/candidates/${key}/journey/consent/documents/${j.consent.submission?.documents[1]?.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // The owner holds the restricted-records permission: the signer's IP is on the PDF; a recruiter's copy has none.
    expect(pdfText(pdf.rawPayload)).toContain(ip);
    const recruiterPdf = await call('GET', `${R}/candidates/${key}/journey/consent/documents/${j.consent.submission?.documents[1]?.id}/pdf`, undefined, as(recruiterEmail));
    expect(recruiterPdf.statusCode).toBe(200);
    expect(pdfText(recruiterPdf.rawPayload)).not.toContain(ip);
    const front = await call('GET', `${R}/candidates/${key}/journey/consent/files/${j.consent.submission?.files.find((f) => f.label === 'CDL (front)')?.id}`);
    expect(front.statusCode).toBe(200);
    expect(front.rawPayload.equals(JPEG)).toBe(true);
  });

  it('4: the application waits for Safety; only Safety approves, and only with every report and a result', async () => {
    const blocked = await call('POST', `${R}/candidates/${key}/driver-application/session`, {}, as(recruiterEmail));
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { detail: string }).detail).toMatch(/Safety/);
    // Reports first, then Send to Safety (owner, 2026-10-13): nothing on file, nothing to send.
    const empty = await call('POST', `${R}/candidates/${key}/journey/safety`, { note: 'Please decide' }, as(recruiterEmail));
    expect(empty.statusCode).toBe(409);
    expect((empty.json() as { detail: string }).detail).toMatch(/Upload the MVR and PSP reports first/);

    for (const kind of ['mvr', 'psp', 'clearinghouse_full'] as const) {
      const up = await call('POST', `${R}/candidates/${key}/journey/safety/reports`, {
        kind,
        result: kind === 'psp' ? 'pending' : 'clear',
        fileName: `${kind}.pdf`,
        contentType: 'application/pdf',
        content: PDF.toString('base64'),
      });
      expect(up.statusCode, up.body).toBe(201);
    }
    let j = await journey();
    // Filed but not sent: still Recruiting's, and Safety cannot decide it yet.
    expect(j.safety.review?.status).toBe('preparing');
    expect((await candidate()).progress).toBe('consent_received');
    expect((await call('POST', `${R}/candidates/${key}/journey/safety/decision`, { status: 'approved', version: j.safety.review?.version })).statusCode).toBe(409);
    expect((await call('POST', `${R}/candidates/${key}/journey/safety`, { note: 'Please decide' }, as(recruiterEmail))).statusCode).toBe(200);
    expect((await call('POST', `${R}/candidates/${key}/journey/safety`, {}, as(recruiterEmail))).statusCode).toBe(409);
    j = await journey();
    expect(j.safety.review?.status).toBe('in_review');
    expect(j.safety.authorizations.filter((a) => a.signedAt).map((a) => a.type)).toEqual(['mvr', 'psp', 'clearinghouse']);
    expect((await candidate()).progress).toBe('safety_review');
    // A recruiter cannot decide.
    expect((await call('POST', `${R}/candidates/${key}/journey/safety/decision`, { status: 'approved', version: j.safety.review?.version }, as(recruiterEmail))).statusCode).toBe(403);
    const pending = await call('POST', `${R}/candidates/${key}/journey/safety/decision`, { status: 'approved', version: j.safety.review?.version });
    expect((pending.json() as { detail: string }).detail).toMatch(/PSP report: no result recorded/);
    const psp = j.safety.reports.find((r) => r.kind === 'psp');
    expect((await call('PATCH', `${R}/candidates/${key}/journey/safety/reports/${psp?.id}`, { result: 'clear', note: 'Reviewed', version: psp?.version })).statusCode).toBe(200);
    // A stale version is a conflict, never an overwrite.
    expect((await call('POST', `${R}/candidates/${key}/journey/safety/decision`, { status: 'approved', version: 1 })).statusCode).toBe(409);
    j = await journey();
    // Pre-employment full query: the driver's own consent in the Clearinghouse, needed at hire.
    expect((await call('POST', `${R}/candidates/${key}/journey/safety/full-query`, { status: 'received', version: j.safety.review?.version })).statusCode).toBe(200);
    j = await journey();
    // Insurance check (owner, 2026-10-12): Safety only; Qualified waits for the insurer; Recruiting is told.
    const caseId = (await candidate()).caseId as string;
    expect((await call('POST', `/api/v1/hiring/safety-desk/${caseId}/insurance`, { note: 'Sent to the insurer', version: j.safety.review?.version }, as(recruiterEmail))).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/hiring/safety-desk/${caseId}/insurance`, { note: 'Sent to the insurer', version: j.safety.review?.version })).statusCode).toBe(200);
    j = await journey();
    expect(j.safety.review?.insurance).toMatchObject({ status: 'pending', note: 'Sent to the insurer' });
    expect((await call('POST', `${R}/candidates/${key}/journey/safety/decision`, { status: 'approved', note: 'Clear', version: j.safety.review?.version })).statusCode).toBe(409);
    expect((await db.select().from(notifications).where(eq(notifications.title, `Insurance check — ${first} ${last}`))).length).toBeGreaterThan(0);
    expect((await call('POST', `/api/v1/hiring/safety-desk/${caseId}/insurance/response`, { result: 'approved', note: null, version: j.safety.review?.version })).statusCode).toBe(200);
    j = await journey();
    expect(j.safety.review?.insurance?.status).toBe('approved');
    const approved = await call('POST', `${R}/candidates/${key}/journey/safety/decision`, { status: 'approved', note: 'Clear', version: j.safety.review?.version });
    expect(approved.statusCode, approved.body).toBe(200);
    j = await journey();
    expect(j.safety.review?.status).toBe('approved');
    expect(j.application.canSend).toBe(true);
    expect((await candidate()).progress).toBe('application_sent');
    expect((await candidate()).nextStep).toBe('Send application');
    // Recruiting files the reports now (owner, 2026-10-12), so a recruiter opens them too.
    expect((await call('GET', `${R}/candidates/${key}/journey/safety/reports/${psp?.id}/file`, undefined, as(recruiterEmail))).statusCode).toBe(200);
  });

  let appRef = '';
  it('5-6: the application inherits name, contact and CDL front from the consent and asks for the rest', async () => {
    const res = await call('POST', `${R}/candidates/${key}/driver-application/session`, {}, as(recruiterEmail));
    expect(res.statusCode, res.body).toBe(201);
    const token = (res.json() as DriverApplicationLinkIssued).url.split('#token=')[1] ?? '';
    const ctx = await call('POST', '/api/v1/public/driver-application/context', { token });
    expect(ctx.statusCode, ctx.body).toBe(200);
    expect(ctx.json()).toMatchObject({ inherited: true, firstName: first, lastName: last, email: `jordan.${stamp}@example.com` });

    const fields = (over: Record<string, string> = {}) =>
      Object.entries({
        // The page sends what it shows; the server keeps the consent's values regardless.
        firstName: 'Someone',
        lastName: 'Else',
        phone: '(469) 555-0100',
        email: `else.${stamp}@example.com`,
        address: '1 Main St',
        city: 'Dallas',
        stateZip: 'TX 75001',
        cdlClass: 'Class A',
        cdlState: 'TX',
        cdlExpiration: '2029-05-01',
        ssn: '123-45-6789',
        medicalExpiration: '2027-01-31',
        experience: '2–5 years',
        endorsements: '',
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
        authorizations: '{}',
        ...over,
      }).map(([name, value]) => ({ name, value }) as Part);
    // Both CDL sides came with the consent (owner, 2026-10-12): only the medical card is asked for.
    const context = await app.inject({ method: 'POST', url: '/api/v1/public/driver-application/context', headers: { 'content-type': 'application/json' }, payload: { token } });
    expect((context.json() as { cdlBackReceived: boolean }).cdlBackReceived).toBe(true);
    const missing = await postForm('/api/v1/public/driver-application', [...fields()]);
    expect(missing.statusCode).toBe(422);
    expect((missing.json() as { error: string }).error).toMatch(/medical card/);
    const ok = await postForm('/api/v1/public/driver-application', [
      ...fields(),
      { name: 'medicalCard', fileName: 'medical.pdf', type: 'application/pdf', bytes: PDF },
    ]);
    expect(ok.statusCode, ok.body).toBe(201);
    appRef = (ok.json() as { reference: string }).reference;
    const c = await candidate();
    expect(c.progress).toBe('application_received');
    expect(c.nextStep).toBe('Review application');
    const answers = c.driverApplication.submission?.answers ?? [];
    expect(answers.find((a) => a.key === 'firstName')?.value).toBe(first);
    expect(answers.find((a) => a.key === 'email')?.value).toBe(`jordan.${stamp}@example.com`);
    // The application is filed; the consent's CDL front followed it now the expiry is known.
    const docs = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, 'driver'), eq(complianceDocuments.ownerId, c.driverId ?? '-')));
    expect(docs.map((d) => d.requirementCode).sort()).toEqual(expect.arrayContaining(['cdl', 'cdl_back', 'medical_card', 'mvr_review', 'psp_review', 'clearinghouse_query']));
    expect(appRef).toMatch(/^APP-/);
  });

  it('7: onboarding starts after review; tasks need evidence; travel and costs follow their own rules', async () => {
    expect((await call('POST', `${R}/candidates/${key}/journey/onboarding/start`, {}, as(recruiterEmail))).statusCode).toBe(409);
    expect((await call('POST', `${R}/candidates/${key}/journey/application/reviewed`, {}, as(recruiterEmail))).statusCode).toBe(200);
    expect((await candidate()).nextStep).toBe('Start onboarding');
    expect((await call('POST', `${R}/candidates/${key}/journey/onboarding/start`, {}, as(recruiterEmail))).statusCode).toBe(200);
    // Starting twice changes nothing.
    expect((await call('POST', `${R}/candidates/${key}/journey/onboarding/start`, {}, as(recruiterEmail))).statusCode).toBe(200);
    let j = await journey();
    expect(j.onboarding.tasks.map((t) => t.code)).toEqual(['documents_verified', 'drug_test', 'employer_checks', 'orientation', 'arrival']);
    expect((await candidate()).progress).toBe('onboarding');
    expect(j.hire.ready).toBe(false);

    const drug = j.onboarding.tasks.find((t) => t.code === 'drug_test');
    expect((await call('PATCH', `${R}/candidates/${key}/journey/onboarding/tasks/${drug?.id}`, { status: 'done', version: drug?.version }, as(recruiterEmail))).statusCode).toBe(422);

    // Travel: booked, then cancelled; the cancelled booking keeps its cost and records the refund.
    // The actual MVR price replaces the automatic estimate: counted once, the estimate kept as void.
    const before = await journey();
    const estimate = before.costs.entries.find((e) => e.type === 'mvr' && e.source !== 'manual' && !e.voided);
    expect(estimate).toBeTruthy();
    const actual = await call('POST', `${R}/candidates/${key}/journey/costs`, { type: 'mvr', amount: 25, incurredOn: '2026-10-12', vendor: 'State DMV', paidBy: 'company', costOwner: 'company', approvalStatus: 'approved' }, as(recruiterEmail));
    expect(actual.statusCode, actual.body).toBe(201);
    const after = await journey();
    expect(after.costs.entries.find((e) => e.id === estimate!.id)?.voided).toBe(true);
    expect(after.costs.entries.filter((e) => e.type === 'mvr' && !e.voided).map((e) => e.amount)).toEqual([25]);
    // A booking with its price: recorded at once as spent on that booking (owner, 2026-10-12).
    const priced = await call('POST', `${R}/candidates/${key}/journey/travel`, { kind: 'hotel', vendor: 'Hampton Inn', checkInOn: '2026-10-20', checkOutOn: '2026-10-22', price: 180, paidBy: 'company' }, as(recruiterEmail));
    expect(priced.statusCode, priced.body).toBe(201);
    const pricedId = (priced.json() as { id: string; cost: number }).id;
    expect((priced.json() as { cost: number }).cost).toBe(180);
    const afterHotel = await journey();
    expect(afterHotel.costs.entries.find((e) => e.travelItemId === pricedId)).toMatchObject({ amount: 180, approvalStatus: 'approved', type: 'lodging' });
    expect(afterHotel.costs.summary.spent).toBeGreaterThanOrEqual(180);
    expect(afterHotel.travel.find((x) => x.id === pricedId)?.cost).toBe(180);
    const flight = await call('POST', `${R}/candidates/${key}/journey/travel`, { kind: 'flight', vendor: 'Delta', routeFrom: 'ORD', routeTo: 'DFW', bookingReference: 'DL123', departAt: '2026-10-20T13:00:00Z', arriveAt: '2026-10-20T16:00:00Z' }, as(recruiterEmail));
    expect(flight.statusCode, flight.body).toBe(201);
    const flightId = (flight.json() as { id: string }).id;
    const costKey = `jr-cost-${stamp}`;
    const flightCost = { type: 'travel', amount: 320, incurredOn: '2026-10-15', vendor: 'Delta', paidBy: 'company', costOwner: 'company', approvalStatus: 'planned', travelItemId: flightId, clientKey: costKey };
    const c1 = await call('POST', `${R}/candidates/${key}/journey/costs`, flightCost, as(recruiterEmail));
    expect(c1.statusCode, c1.body).toBe(201);
    // The same save twice is one cost.
    const c1b = await call('POST', `${R}/candidates/${key}/journey/costs`, flightCost, as(recruiterEmail));
    expect((c1b.json() as { id: string }).id).toBe((c1.json() as { id: string }).id);
    const flightCostId = (c1.json() as { id: string }).id;
    // Planned is not booked in Accounting.
    let [fc] = await db.select().from(hiringCostEntries).where(eq(hiringCostEntries.id, flightCostId));
    expect(fc?.accountingExpenseId).toBeNull();
    // The owner (with accounting) approves: one recruiting expense, and only one.
    expect((await call('POST', `${R}/candidates/${key}/journey/costs/${flightCostId}/decision`, { decision: 'approved', version: fc?.version })).statusCode).toBe(200);
    [fc] = await db.select().from(hiringCostEntries).where(eq(hiringCostEntries.id, flightCostId));
    expect(fc?.accountingExpenseId).toBeTruthy();
    const expenses = await db.select().from(acctExpenses).where(eq(acctExpenses.sourceKey, `recruiting:${flightCostId}`));
    expect(expenses).toHaveLength(1);
    expect((await call('POST', `${R}/candidates/${key}/journey/costs/${flightCostId}/payment`, { paidOn: '2026-10-15', version: fc?.version })).statusCode).toBe(200);
    j = await journey();
    const t = j.travel.find((x) => x.id === flightId);
    expect((await call('POST', `${R}/candidates/${key}/journey/travel/${flightId}/cancel`, { reason: 'Driver rescheduled', version: t?.version }, as(recruiterEmail))).statusCode).toBe(200);
    j = await journey();
    const fcView = j.costs.entries.find((e) => e.id === flightCostId);
    expect(fcView?.amount).toBe(320);
    expect((await call('POST', `${R}/candidates/${key}/journey/costs/${flightCostId}/refund`, { refundAmount: 200, nonrefundableFee: 120, version: fcView?.version }, as(recruiterEmail))).statusCode).toBe(200);

    // Driver paid, company's cost: a reimbursement, paid only when its payment is recorded.
    const hotel = await call('POST', `${R}/candidates/${key}/journey/costs`, { type: 'lodging', amount: 180, incurredOn: '2026-10-20', vendor: 'Motel 6', paidBy: 'driver', costOwner: 'company', approvalStatus: 'planned' }, as(recruiterEmail));
    const hotelId = (hotel.json() as { id: string }).id;
    let [hc] = await db.select().from(hiringCostEntries).where(eq(hiringCostEntries.id, hotelId));
    expect((await call('POST', `${R}/candidates/${key}/journey/costs/${hotelId}/decision`, { decision: 'approved', version: hc?.version })).statusCode).toBe(200);
    j = await journey();
    const hView = j.costs.entries.find((e) => e.id === hotelId);
    expect(hView?.treatment).toBe('reimbursement');
    expect(hView?.paymentStatus).toBe('unpaid');

    // Company paid, driver's cost: needs the agreement first, charged once the driver is on the roster.
    const bus = await call('POST', `${R}/candidates/${key}/journey/costs`, { type: 'travel', amount: 50, incurredOn: '2026-10-21', vendor: 'Greyhound', paidBy: 'company', costOwner: 'driver', approvalStatus: 'planned' }, as(recruiterEmail));
    const busId = (bus.json() as { id: string }).id;
    let [bc] = await db.select().from(hiringCostEntries).where(eq(hiringCostEntries.id, busId));
    expect((await call('POST', `${R}/candidates/${key}/journey/costs/${busId}/decision`, { decision: 'approved', version: bc?.version })).statusCode).toBe(409);
    expect((await call('POST', `${R}/candidates/${key}/journey/costs/${busId}/agreement`, { note: 'Driver agreed by text to repay the bus ticket', version: bc?.version }, as(recruiterEmail))).statusCode).toBe(200);
    [bc] = await db.select().from(hiringCostEntries).where(eq(hiringCostEntries.id, busId));
    expect((await call('POST', `${R}/candidates/${key}/journey/costs/${busId}/decision`, { decision: 'approved', version: bc?.version })).statusCode).toBe(200);
    [bc] = await db.select().from(hiringCostEntries).where(eq(hiringCostEntries.id, busId));
    expect(bc?.accountingExpenseId).toBeNull();
    expect(bc?.driverTransactionId).toBeNull();

    // The driver's own cost: recorded, nothing posted.
    const own = await call('POST', `${R}/candidates/${key}/journey/costs`, { type: 'other', amount: 30, incurredOn: '2026-10-21', paidBy: 'driver', costOwner: 'driver', approvalStatus: 'approved' }, as(recruiterEmail));
    expect(own.statusCode, own.body).toBe(201);
    j = await journey();
    expect(j.costs.entries.find((e) => e.id === (own.json() as { id: string }).id)?.accounting.state).toBe('none_needed');
    expect(j.costs.summary.driverCost).toBe(80);
    hc = (await db.select().from(hiringCostEntries).where(eq(hiringCostEntries.id, hotelId)))[0];
    expect(hc?.paymentStatus).toBe('unpaid');
  });

  it('8-9: Ready to hire is read from the records; hire is refused until it holds, then made once', async () => {
    let j = await journey();
    const notReady = await call('POST', `${R}/candidates/${key}/journey/hire`, { hireDate: '2026-10-22', payPlanRate: 0.6, dispatcherId: dispatcherEmp }, as(recruiterEmail));
    expect(notReady.statusCode).toBe(409);
    expect((notReady.json() as { detail: string }).detail).toMatch(/Required documents verified/);

    // Safety verifies the driver documents in the qualification file.
    const c = await candidate();
    const docs = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, 'driver'), eq(complianceDocuments.ownerId, c.driverId ?? '-')));
    for (const d of docs.filter((x) => ['cdl', 'cdl_back', 'medical_card'].includes(x.requirementCode))) {
      const v = await call('POST', `/api/v1/compliance/documents/${d.id}/verify`, {});
      expect(v.statusCode, v.body).toBeLessThan(300);
    }
    for (const task of j.onboarding.tasks) {
      const res = await call('PATCH', `${R}/candidates/${key}/journey/onboarding/tasks/${task.id}`, { status: 'done', result: task.code === 'drug_test' ? 'Negative' : null, version: task.version }, as(recruiterEmail));
      expect(res.statusCode, res.body).toBe(200);
    }
    j = await journey();
    expect(j.hire.items.filter((i) => !i.ok).map((i) => i.code)).toEqual([]);
    expect((await candidate()).progress).toBe('ready_to_hire');

    // On hold blocks the hire.
    expect((await call('POST', `${R}/candidates/${key}/journey/hold`, { hold: true, reason: 'Waiting on a reference' }, as(recruiterEmail))).statusCode).toBe(200);
    expect((await call('POST', `${R}/candidates/${key}/journey/hire`, { hireDate: '2026-10-22', payPlanRate: 0.6, dispatcherId: dispatcherEmp }, as(recruiterEmail))).statusCode).toBe(409);
    expect((await call('POST', `${R}/candidates/${key}/journey/hold`, { hold: false }, as(recruiterEmail))).statusCode).toBe(200);

    const hired = await call('POST', `${R}/candidates/${key}/journey/hire`, { hireDate: '2026-10-22', payPlanRate: 0.6, dispatcherId: dispatcherEmp }, as(recruiterEmail));
    expect(hired.statusCode, hired.body).toBe(200);
    const result = hired.json() as { driverId: string; employeeId: string };
    expect(result.driverId).toBe(c.driverId);
    // A retry is the same hire, never a second driver.
    const again = await call('POST', `${R}/candidates/${key}/journey/hire`, { hireDate: '2026-10-22', payPlanRate: 0.6, dispatcherId: dispatcherEmp }, as(recruiterEmail));
    expect(again.json()).toMatchObject({ driverId: result.driverId, employeeId: result.employeeId });
    expect(await db.select().from(drivers).where(eq(drivers.id, result.driverId))).toHaveLength(1);
    expect((await candidate()).progress).toBe('hired');

    // The driver keeps every document under the same id; nothing is uploaded again.
    const after = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, 'driver'), eq(complianceDocuments.ownerId, result.driverId)));
    expect(after.length).toBe(docs.length);
    // Drivers are not on the Employees page.
    const list = (await call('GET', `/api/v1/employees?search=${encodeURIComponent(last)}&pageSize=50`)).json() as { data: { id: string }[] };
    expect(list.data.map((e) => e.id)).not.toContain(result.employeeId);
    // Costs survive the hire with the person.
    j = await journey();
    expect(j.costs.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('dashboard: the cohort reconciles — stages add up to the total and each opens its own list', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const res = await call('GET', `${R}/dashboard?from=${today}&to=${today}&scope=all`);
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json() as RecruitDashboard;
    expect(d.stages.reduce((s, x) => s + x.count, 0)).toBe(d.total);
    expect(d.sources.reduce((s, x) => s + x.leads, 0)).toBe(d.total);
    expect(d.conversion === null ? 0 : d.conversion).toBeCloseTo(d.total ? d.hired / d.total : 0, 6);
    expect(d.trend.reduce((s, x) => s + x.leads, 0)).toBe(d.total);
    for (const stage of d.stages) {
      const l = (await call('GET', `${R}/candidates?scope=all&from=${today}&to=${today}&stage=${stage.stage}&pageSize=5`)).json() as RecruitList;
      expect(l.total, stage.stage).toBe(stage.count);
    }
    // The KPI cards open the lists they count.
    const all = (await call('GET', `${R}/candidates?scope=all&from=${today}&to=${today}&pageSize=5`)).json() as RecruitList;
    expect(all.total).toBe(d.total);
    const active = (await call('GET', `${R}/candidates?scope=all&from=${today}&to=${today}&filter=active&pageSize=5`)).json() as RecruitList;
    expect(active.total).toBe(d.inProgress);
    for (const source of d.sources) {
      const l = (await call('GET', `${R}/candidates?scope=all&from=${today}&to=${today}&source=${source.key}&pageSize=5`)).json() as RecruitList;
      expect(l.total, source.key).toBe(source.leads);
    }
    expect((await call('GET', `${R}/dashboard?from=${today}&to=2000-01-01`)).statusCode).toBe(422);
  });

  it('a consent link opens on its first device only (owner, 2026-10-12)', async () => {
    const lead = await call('POST', `${R}/leads`, { fullName: `Device Test${stamp}`, phone: `+1972${String(Date.now()).slice(-7)}`, source: 'instagram', assignment: 'recruiter', recruiterEmployeeId: recruiterEmp });
    expect(lead.statusCode, lead.body).toBe(201);
    const k = (lead.json() as { key: string }).key;
    await call('POST', `/api/v1/hiring/leads/${k}/contacted`, {});
    const issued = await call('POST', `${R}/candidates/${k}/journey/consent/link`, {}, as(recruiterEmail));
    const token = (issued.json() as ConsentLinkIssued).url.split('#token=')[1] ?? '';
    const open = (device?: string) => call('POST', '/api/v1/public/consent/form', { token }, device ? { 'x-neway-device': device } : {});
    expect((await open('device-aaaaaaaaaaaaaaaa')).statusCode).toBe(200);
    const other = await open('device-bbbbbbbbbbbbbbbb');
    expect(other.statusCode).toBe(403);
    expect(other.body).toMatch(/another phone or computer/);
    expect((await open()).statusCode).toBe(403);
    expect((await open('device-aaaaaaaaaaaaaaaa')).statusCode).toBe(200);
  });

  it('a signed consent is never refused because its email already belongs to another candidate (owner, 2026-10-13)', async () => {
    // The email the first candidate signed with, on a new lead with a different phone.
    const email = `jordan.${stamp}@example.com`;
    const lead = await call('POST', `${R}/leads`, { fullName: `Clash Test${stamp}`, phone: `+1214${String(Date.now()).slice(-7)}`, email, source: 'instagram', assignment: 'recruiter', recruiterEmployeeId: recruiterEmp });
    expect(lead.statusCode, lead.body).toBe(201);
    const k = (lead.json() as { key: string }).key;
    await call('POST', `/api/v1/hiring/leads/${k}/contacted`, {});
    const issued = await call('POST', `${R}/candidates/${k}/journey/consent/link`, {}, as(recruiterEmail));
    const token = (issued.json() as ConsentLinkIssued).url.split('#token=')[1] ?? '';
    expect((await call('POST', '/api/v1/public/consent/form', { token })).statusCode).toBe(200);
    const res = await postForm('/api/v1/public/consent/submit', consentParts({ token, phone: '(214) 555-0199', email, firstName: 'Clash', lastName: `Test${stamp}` }));
    expect(res.statusCode, res.body).toBeLessThan(300);
    const [row] = await db.select({ email: applicants.email, notes: applicants.notes }).from(applicants).where(eq(applicants.lastName, `Test${stamp}`));
    expect(row?.email).toMatch(/@no-email\.lead$/);
    expect(row?.notes).toMatch(/already belongs to candidate/);
  });

  it('only the CDL front is needed, and any Yes on the safety questions disqualifies the candidate (owner, 2026-10-13)', async () => {
    const lead = await call('POST', `${R}/leads`, { fullName: `Screen Yes${stamp}`, phone: `+1972${String(Date.now()).slice(-7)}`, email: `screen.${stamp}@example.com`, source: 'instagram', assignment: 'recruiter', recruiterEmployeeId: recruiterEmp });
    expect(lead.statusCode, lead.body).toBe(201);
    const k = (lead.json() as { key: string }).key;
    await call('POST', `/api/v1/hiring/leads/${k}/contacted`, {});
    const issued = await call('POST', `${R}/candidates/${k}/journey/consent/link`, {}, as(recruiterEmail));
    const token = (issued.json() as ConsentLinkIssued).url.split('#token=')[1] ?? '';
    expect((await call('POST', '/api/v1/public/consent/form', { token })).statusCode).toBe(200);
    const answers = Object.fromEntries(SAFETY_SCREENING_QUESTIONS.map((q) => [q.key, q.key === 'reckless']));
    const parts = consentParts({ token, phone: '(972) 555-0142', email: `screen.${stamp}@example.com`, firstName: 'Screen', lastName: `Yes${stamp}`, signatureText: `Screen Yes${stamp}`, safetyAnswers: JSON.stringify(answers) }, false);
    parts.push({ name: 'cdlFront', fileName: 'cdl-front.jpg', type: 'image/jpeg', bytes: JPEG });
    const res = await postForm('/api/v1/public/consent/submit', parts);
    expect(res.statusCode, res.body).toBe(201);
    const [consent] = await db.select().from(hiringConsents).where(eq(hiringConsents.reference, (res.json() as { reference: string }).reference));
    expect(consent?.safetyDisqualified).toBe(true);
    const [kase] = await db.select().from(hiringCases).where(eq(hiringCases.id, consent?.hiringCaseId ?? ''));
    expect(kase?.state).toBe('disqualified');
    expect(kase?.endReason).toBe('failed_safety_screening');
    const told = await db.select().from(notifications).where(eq(notifications.title, `Disqualified — Screen Yes${stamp}`));
    expect(told.length).toBeGreaterThan(0);
  });
});
