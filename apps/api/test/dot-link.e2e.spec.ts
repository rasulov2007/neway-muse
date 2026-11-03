import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  ComplianceDocument,
  DotApplication,
  DotLinkCreated,
  DotLinkStagedFile,
  DotLinkStatus,
  Lead,
  PublicDotApplication,
  SaveDotApplicationInput,
} from '@neway/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { auditLogs } from '../src/database/schema/people';
import { hiringCases, hiringDotApplications, hiringDotLinks } from '../src/database/schema/hiring';
import { notifications } from '../src/database/schema/admin';
import { companies } from '../src/database/schema/roster';
import { HiringService } from '../src/modules/hiring/hiring.service';
import { isSignedDocumentUrl, signedGet } from './authz/signed-get';

const HIRING = '/api/v1/hiring';
const PUBLIC = '/api/v1/public/dot-application';
const GONE = 'This link has expired or was turned off. Contact your recruiter for a new one.';

/**
 * The DOT application sent to the driver: a recruiter makes a link, the driver opens it, saves a
 * draft the recruiter can see, is refused with the gaps named, submits, and uploads the CDL into
 * the candidate's documents. Unknown, expired and turned-off tokens get one identical answer; a
 * new link turns the old one off; the SSN never comes back; another company's case is unreachable.
 */
describe('DOT application link (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const stamp = Date.now();
  const year = new Date().getUTCFullYear();
  const today = new Date().toISOString().slice(0, 10);
  const otherCompanyId = `co_e2e_dot_${stamp}`;
  let address = 10;
  const nextAddress = () => `10.7.${Math.floor(address / 250)}.${(address += 1) % 250}`;

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    method === 'GET' && isSignedDocumentUrl(url) ? signedGet(app, url) : app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const employer = (name: string, from: string, to: string | null) => ({
    kind: 'employer' as const,
    employer: name,
    address: null,
    phone: null,
    contactName: null,
    position: 'Driver',
    from,
    to,
    reasonForLeaving: null,
    droveCmv: true,
    dotRegulated: true,
    subjectToDrugTesting: true,
  });

  const complete = (last: string): SaveDotApplicationInput => ({
    legalFirstName: 'Link',
    legalMiddleName: null,
    legalLastName: last,
    dateOfBirth: '1990-02-02',
    ssn: '123-45-6789',
    addresses: [{ street: '1 Main St', city: 'Dallas', state: 'TX', zip: '75201', from: `${year - 5}-01-01`, to: null }],
    licenses: [{ state: 'TX', number: '12345678', licenseClass: 'A', endorsements: [], expiresOn: `${year + 2}-03-04` }],
    employment: [employer('Acme Freight', `${year - 2}-06-01`, null), employer('Blue Line Logistics', `${year - 11}-06-01`, `${year - 2}-06-01`)],
    accidents: [],
    convictions: [],
    licenseDeniedOrRevoked: false,
    licenseDeniedOrRevokedDetail: null,
    certifiedName: `Link ${last}`,
    certifiedOn: today,
  });

  async function newCase(last: string): Promise<string> {
    const lead = (
      await call('POST', `${HIRING}/leads`, {
        firstName: 'Link',
        lastName: last,
        phone: `+1469556${String(Math.floor(1000 + Math.random() * 8999))}`,
        email: `link.${last.toLowerCase()}@example.com`,
        source: 'referral',
      })
    ).json() as Lead;
    await call('POST', `${HIRING}/leads/${lead.id}/prequalify`, {
      age23Plus: true,
      cdlHeldYears: 6,
      otrExperienceYears: 5,
      accidents36mo: 0,
      movingViolations36mo: 0,
      duiEver: false,
      endorsements: [],
      payTypePreference: 'company',
      homeState: 'TX',
      earliestStartDate: null,
    });
    const converted = (await call('POST', `${HIRING}/leads/${lead.id}/convert`, {})).json() as Lead;
    return converted.hiringCaseId as string;
  }

  const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
  const pdfBytes = Buffer.from('%PDF-1.4\n% CDL back\n%%EOF\n');

  let caseId = '';
  let token = '';
  const last = `Driver${stamp}`;

  it('makes a link once: the address carries the token, the status never does', async () => {
    caseId = await newCase(last);
    expect(((await call('GET', `${HIRING}/cases/${caseId}/dot-application/link`)).json() as { link: null }).link).toBeNull();
    const res = await call('POST', `${HIRING}/cases/${caseId}/dot-application/link`, {});
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json() as DotLinkCreated;
    expect(created.url).toMatch(/^https?:\/\/[^/]+\/dot\/[A-Za-z0-9_-]{43}$/);
    token = tokenOf(created.url);
    expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(13 * 86_400_000);
    const status = await call('GET', `${HIRING}/cases/${caseId}/dot-application/link`);
    expect(status.body).not.toContain(token);
    expect((status.json() as { link: DotLinkStatus }).link.state).toBe('live');
    const [row] = await db.select().from(hiringDotLinks).where(eq(hiringDotLinks.hiringCaseId, caseId));
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the driver opens it: name, company, no draft yet, and the opening is recorded', async () => {
    const res = await call('GET', `${PUBLIC}/${token}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const page = res.json() as PublicDotApplication;
    expect(page.firstName).toBe('Link');
    expect(page.lastName).toBe(last);
    expect(page.companyName).toBeTruthy();
    expect(page.form).toBeNull();
    expect(page.status).toBe('draft');
    expect(page.sections).toHaveLength(6);
    const status = ((await call('GET', `${HIRING}/cases/${caseId}/dot-application/link`)).json() as { link: DotLinkStatus }).link;
    expect(status.firstOpenedAt).toBeTruthy();
    expect(status.lastOpenedAt).toBeTruthy();
  });

  it('unknown, malformed and company-scoped requests are refused alike', async () => {
    const unknown = await call('GET', `${PUBLIC}/${randomBytes(32).toString('base64url')}`);
    const malformed = await call('GET', `${PUBLIC}/abc`);
    for (const r of [unknown, malformed]) {
      expect(r.statusCode).toBe(404);
      expect((r.json() as { detail: string }).detail).toBe(GONE);
    }
    expect((await call('GET', `${PUBLIC}/${token}?companyId=${otherCompanyId}`)).statusCode).toBe(400);
  });

  it('a draft saved through the link reaches the recruiter, and the SSN never comes back', async () => {
    const res = await call('PUT', `${PUBLIC}/${token}`, {
      ...complete(last),
      employment: [employer('Acme Freight', `${year - 1}-01-01`, null)],
      certifiedName: null,
      certifiedOn: null,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('123-45');
    expect(res.body).not.toContain('123456789');
    const page = res.json() as PublicDotApplication;
    expect(page.hasSsn).toBe(true);
    expect(page.ssnLast4).toBe('6789');
    expect(page.cdlExpiresOn).toBe(`${year + 2}-03-04`);

    const staff = ((await call('GET', `${HIRING}/cases/${caseId}/dot-application`)).json() as { application: DotApplication }).application;
    expect(staff.status).toBe('draft');
    expect(staff.form.legalLastName).toBe(last);
    expect(staff.form.employment).toHaveLength(1);
    const status = ((await call('GET', `${HIRING}/cases/${caseId}/dot-application/link`)).json() as { link: DotLinkStatus }).link;
    expect(status.lastSavedAt).toBeTruthy();

    // A second open shows the saved draft, still without the number.
    const again = await call('GET', `${PUBLIC}/${token}`);
    expect(again.body).not.toContain('123-45');
    expect((again.json() as PublicDotApplication).form?.legalLastName).toBe(last);
  });

  it('the CDL waits for the submission', async () => {
    const res = await call('POST', `${PUBLIC}/${token}/documents`, { code: 'cdl', fileName: 'cdl.png', content: pngBytes.toString('base64') });
    expect(res.statusCode).toBe(409);
  });

  it('an incomplete application is refused with the issues per section', async () => {
    const res = await call('POST', `${PUBLIC}/${token}/submit`, {});
    expect(res.statusCode).toBe(422);
    const body = res.json() as { issues: { section: string; detail: string }[] };
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.map((i) => i.section)).toContain('employment');
    expect(body.issues.map((i) => i.section)).toContain('certification');
  });

  it('the driver certifies: frozen and waiting for review, nothing filed, recruiters told', async () => {
    expect((await call('PUT', `${PUBLIC}/${token}`, { ...complete(last), ssn: undefined })).statusCode).toBe(200);
    const res = await call('POST', `${PUBLIC}/${token}/submit`, {});
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as PublicDotApplication;
    expect(page.status).toBe('driver_submitted');
    expect(page.certifiedAt).toBeTruthy();
    expect(page.cdlUploaded).toBe(false);

    const staff = ((await call('GET', `${HIRING}/cases/${caseId}/dot-application`)).json() as { application: DotApplication }).application;
    expect(staff.status).toBe('driver_submitted');
    expect(staff.submittedVia).toBe('driver_link');
    expect(staff.certifiedName).toBe(`Link ${last}`);
    // Not filed: no driver id, no PDF, no verification case, no consents.
    expect(staff.driverId).toBeNull();
    expect(staff.documentId).toBeNull();
    expect(staff.verificationCaseId).toBeNull();
    expect(staff.consentIds).toEqual([]);
    const [row] = await db.select().from(hiringDotApplications).where(eq(hiringDotApplications.hiringCaseId, caseId));
    expect((row!.certifiedSnapshot as { legalLastName: string }).legalLastName).toBe(last);

    const status = ((await call('GET', `${HIRING}/cases/${caseId}/dot-application/link`)).json() as { link: DotLinkStatus }).link;
    expect(status.submittedAt).toBeTruthy();
    expect(status.applicationStatus).toBe('driver_submitted');
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, staff.applicantId), inArray(auditLogs.action, ['dot_application_submitted_by_driver', 'dot_application_certified'])));
    expect(audits).toHaveLength(2);
    const notes = await db.select().from(notifications).where(and(eq(notifications.entityId, staff.applicantId), eq(notifications.entityType, 'applicant')));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.title).toBe(`New DOT application from Link ${last} — needs review`);
    expect(((await call('GET', `${HIRING}/leads/summary`)).json() as { dotReviews: number }).dotReviews).toBeGreaterThan(0);

    // Frozen: neither side can change it, and the desk cannot file it without Accept.
    expect((await call('PUT', `${PUBLIC}/${token}`, complete(last))).statusCode).toBe(409);
    expect((await call('PUT', `${HIRING}/cases/${caseId}/dot-application`, complete(last))).statusCode).toBe(409);
    expect((await call('POST', `${HIRING}/cases/${caseId}/dot-application/submit`, {})).statusCode).toBe(409);
  });

  it('the CDL sent before acceptance is kept against the case, not in the qualification file', async () => {
    const bad = await call('POST', `${PUBLIC}/${token}/documents`, {
      code: 'cdl',
      fileName: 'cdl.png',
      content: Buffer.from('this is not an image').toString('base64'),
    });
    expect(bad.statusCode).toBe(422);

    const front = await call('POST', `${PUBLIC}/${token}/documents`, { code: 'cdl', fileName: 'cdl-front.png', content: pngBytes.toString('base64') });
    expect(front.statusCode, front.body).toBe(201);
    expect((front.json() as { file: { status: string } }).file.status).toBe('waiting_for_review');
    const back = await call('POST', `${PUBLIC}/${token}/documents`, {
      code: 'cdl_back',
      fileName: 'cdl-back.pdf',
      content: `data:application/pdf;base64,${pdfBytes.toString('base64')}`,
    });
    expect(back.statusCode, back.body).toBe(201);
    const page = (back.json() as { application: PublicDotApplication }).application;
    expect(page.cdlUploaded).toBe(true);
    expect(page.cdlBackUploaded).toBe(true);

    const docs = (await call('GET', `${HIRING}/cases/${caseId}/documents`)).json() as { driverId: string | null; documents: ComplianceDocument[] };
    expect(docs.driverId).toBeNull();
    expect(docs.documents).toEqual([]);
    const staged = (await call('GET', `${HIRING}/cases/${caseId}/dot-application/link/files`)).json() as DotLinkStagedFile[];
    expect(staged.map((f) => f.code).sort()).toEqual(['cdl', 'cdl_back']);
    expect(staged.every((f) => f.filedAt === null)).toBe(true);
    const view = await call('GET', `${HIRING}/cases/${caseId}/dot-application/link/files/${staged.find((f) => f.code === 'cdl')!.id}`);
    expect(view.statusCode).toBe(200);
    expect(view.headers['content-type']).toBe('image/png');
    expect(view.rawPayload.equals(pngBytes)).toBe(true);

    const status = ((await call('GET', `${HIRING}/cases/${caseId}/dot-application/link`)).json() as { link: DotLinkStatus }).link;
    expect(status.cdlUploadedAt).toBeTruthy();
  });

  it('returned to the driver with a note: back to a draft, the certification kept in the history', async () => {
    expect((await call('POST', `${HIRING}/cases/${caseId}/dot-application/return`, { note: '' })).statusCode).toBe(422);
    const res = await call('POST', `${HIRING}/cases/${caseId}/dot-application/return`, { note: 'Add your 2019 employer, please.' });
    expect(res.statusCode, res.body).toBe(201);
    const staff = res.json() as DotApplication;
    expect(staff.status).toBe('draft');
    expect(staff.returnNote).toBe('Add your 2019 employer, please.');
    expect(staff.form.certifiedName).toBeNull();
    const [row] = await db.select().from(hiringDotApplications).where(eq(hiringDotApplications.hiringCaseId, caseId));
    const history = row!.certificationHistory as { certifiedName: string; note: string; snapshot: unknown }[];
    expect(history).toHaveLength(1);
    expect(history[0]!.certifiedName).toBe(`Link ${last}`);
    expect(history[0]!.snapshot).toBeTruthy();

    const page = (await call('GET', `${PUBLIC}/${token}`)).json() as PublicDotApplication;
    expect(page.status).toBe('draft');
    expect(page.returnNote).toBe('Add your 2019 employer, please.');
    // The driver fixes it and certifies again.
    expect((await call('PUT', `${PUBLIC}/${token}`, { ...complete(last), ssn: undefined })).statusCode).toBe(200);
    expect(((await call('POST', `${PUBLIC}/${token}/submit`, {})).json() as PublicDotApplication).status).toBe('driver_submitted');
  });

  it('Accept files the frozen submission and then the CDL the driver sent', async () => {
    const res = await call('POST', `${HIRING}/cases/${caseId}/dot-application/accept`, {});
    expect(res.statusCode, res.body).toBe(201);
    const accepted = res.json() as DotApplication;
    expect(accepted.status).toBe('submitted');
    expect(accepted.driverId).toMatch(/^drv_/);
    expect(accepted.documentId).toMatch(/^doc_/);
    expect(accepted.submittedBy).toBe(`Link ${last} (driver link)`);
    expect(accepted.submittedAt).toBe(accepted.certifiedAt);
    expect(accepted.reviewedBy).toBeTruthy();

    const docs = (await call('GET', `${HIRING}/cases/${caseId}/documents`)).json() as { documents: ComplianceDocument[] };
    const cdl = docs.documents.find((d) => d.requirementCode === 'cdl');
    expect(cdl?.status).toBe('pending_review');
    expect(cdl?.expiresOn).toBe(`${year + 2}-03-04`);
    expect(cdl?.source).toBe('public_link');
    expect(cdl?.contentType).toBe('image/png');
    expect(docs.documents.find((d) => d.requirementCode === 'cdl_back')?.contentType).toBe('application/pdf');
    expect(docs.documents.find((d) => d.requirementCode === 'dot_application')?.source).toBe('public_link');
    const staged = (await call('GET', `${HIRING}/cases/${caseId}/dot-application/link/files`)).json() as DotLinkStagedFile[];
    expect(staged.every((f) => f.filedAt !== null && f.filedDocumentId !== null)).toBe(true);

    // Accepting twice files nothing twice.
    expect((await call('POST', `${HIRING}/cases/${caseId}/dot-application/accept`, {})).statusCode).toBe(201);
    const again = (await call('GET', `${HIRING}/cases/${caseId}/documents`)).json() as { documents: ComplianceDocument[] };
    expect(again.documents.filter((d) => d.requirementCode === 'cdl')).toHaveLength(1);

    const status = ((await call('GET', `${HIRING}/cases/${caseId}/dot-application/link`)).json() as { link: DotLinkStatus }).link;
    expect(status.applicationStatus).toBe('submitted');
    expect(status.acceptedBy).toBeTruthy();
    // Nothing is left for the driver to do, so no new link.
    expect((await call('POST', `${HIRING}/cases/${caseId}/dot-application/link`, {})).statusCode).toBe(409);
  });

  it('an address that keeps trying dead tokens is refused on every link route for a while', async () => {
    const live = await newCase(`Probe${stamp}`);
    const good = tokenOf(((await call('POST', `${HIRING}/cases/${live}/dot-application/link`, {})).json() as DotLinkCreated).url);
    const probe = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '10.66.0.1' });
    for (let i = 0; i < 20; i += 1) {
      expect((await probe(`${PUBLIC}/${randomBytes(32).toString('base64url')}`)).statusCode).toBe(404);
    }
    expect((await probe(`${PUBLIC}/${randomBytes(32).toString('base64url')}`)).statusCode).toBe(429);
    // Even a good token from that address, while another address is unaffected.
    expect((await probe(`${PUBLIC}/${good}`)).statusCode).toBe(429);
    expect((await call('GET', `${PUBLIC}/${good}`)).statusCode).toBe(200);
  });

  it('a new link turns the old one off; turning off and expiry answer like an unknown token', async () => {
    const second = await newCase(`Second${stamp}`);
    const a = tokenOf(((await call('POST', `${HIRING}/cases/${second}/dot-application/link`, {})).json() as DotLinkCreated).url);
    const b = tokenOf(((await call('POST', `${HIRING}/cases/${second}/dot-application/link`, {})).json() as DotLinkCreated).url);
    const old = await call('GET', `${PUBLIC}/${a}`);
    expect(old.statusCode).toBe(404);
    expect((old.json() as { detail: string }).detail).toBe(GONE);
    expect((await call('GET', `${PUBLIC}/${b}`)).statusCode).toBe(200);

    const off = await call('DELETE', `${HIRING}/cases/${second}/dot-application/link`);
    expect(off.statusCode, off.body).toBe(200);
    expect((off.json() as { link: DotLinkStatus }).link.state).toBe('revoked');
    const revoked = await call('GET', `${PUBLIC}/${b}`);
    expect(revoked.statusCode).toBe(404);
    expect((revoked.json() as { detail: string }).detail).toBe(GONE);
    expect((await call('PUT', `${PUBLIC}/${b}`, complete('X'))).statusCode).toBe(404);

    const c = tokenOf(((await call('POST', `${HIRING}/cases/${second}/dot-application/link`, {})).json() as DotLinkCreated).url);
    await db
      .update(hiringDotLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(hiringDotLinks.hiringCaseId, second), isNull(hiringDotLinks.revokedAt)));
    const expired = await call('GET', `${PUBLIC}/${c}`);
    expect(expired.statusCode).toBe(404);
    expect((expired.json() as { detail: string }).detail).toBe(GONE);

    // Kept, never deleted: three links on the case, two turned off, every change audited.
    const rows = await db.select().from(hiringDotLinks).where(eq(hiringDotLinks.hiringCaseId, second));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.revokedAt).length).toBe(2);
    const [hc] = await db.select().from(hiringCases).where(eq(hiringCases.id, second));
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, hc!.applicantId!), inArray(auditLogs.action, ['dot_link_created', 'dot_link_revoked'])));
    expect(audits.filter((x) => x.action === 'dot_link_created')).toHaveLength(3);
    expect(audits.filter((x) => x.action === 'dot_link_revoked')).toHaveLength(2);
  });

  it("another company's case cannot be given a link or read", async () => {
    await db.insert(companies).values({ id: otherCompanyId, name: `Other Carrier DOT ${stamp}` });
    const foreign = `hc_e2e_dot_${stamp}`;
    await db.insert(hiringCases).values({ id: foreign, companyId: otherCompanyId, candidateName: 'Foreign Driver', state: 'application' });
    expect((await call('POST', `${HIRING}/cases/${foreign}/dot-application/link`, {})).statusCode).toBe(404);
    expect((await call('GET', `${HIRING}/cases/${foreign}/dot-application/link`)).statusCode).toBe(404);
    expect((await call('DELETE', `${HIRING}/cases/${foreign}/dot-application/link`)).statusCode).toBe(404);
    const rows = await db.select().from(hiringDotLinks).where(eq(hiringDotLinks.hiringCaseId, foreign));
    expect(rows).toHaveLength(0);
  });
});
