import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  ComplianceDocument,
  ConsentRequest,
  DotApplication,
  HiringCase,
  Lead,
  QualificationItem,
  SaveDotApplicationInput,
  VerificationCase,
} from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { HiringService } from '../src/modules/hiring/hiring.service';
import { isSignedDocumentUrl, signedGet } from './authz/signed-get';

const HIRING = '/api/v1/hiring';
const COMPLIANCE = '/api/v1/compliance';

/**
 * The application stage, end to end: a converted lead's DOT application is recorded, refused
 * while incomplete with the gaps named, then submitted — which files a rendered PDF in the
 * qualification file under a reserved driver id, opens the verification case, drafts one
 * previous-employer consent per DOT-regulated employer, and moves the case to Checks.
 */
describe('DOT application (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = Date.now();
  const year = new Date().getUTCFullYear();
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.get(HiringSeedService).seedDotApplications();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => (isSignedDocumentUrl(url) ? signedGet(app, url) : app.inject({ method: 'GET', url }));
  const send = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
    app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      payload: payload as object,
    });

  const employer = (
    name: string,
    from: string,
    to: string | null,
    flags: Partial<{ droveCmv: boolean; dotRegulated: boolean }> = {},
  ) => ({
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
    ...flags,
  });

  const complete: SaveDotApplicationInput = {
    legalFirstName: 'E2E',
    legalMiddleName: null,
    legalLastName: `Applicant${stamp}`,
    dateOfBirth: '1990-02-02',
    ssn: '123-45-6789',
    addresses: [
      {
        street: '1 Main St',
        city: 'Dallas',
        state: 'tx',
        zip: '75201',
        from: `${year - 5}-01-01`,
        to: null,
      },
    ],
    licenses: [
      {
        state: 'TX',
        number: '12345678',
        licenseClass: 'A',
        endorsements: ['H'],
        expiresOn: `${year + 2}-01-01`,
      },
    ],
    employment: [
      employer('Acme Freight', `${year - 2}-06-01`, null),
      employer('Blue Line Logistics', `${year - 11}-06-01`, `${year - 2}-06-01`),
      employer('Corner Store', `${year - 12}-01-01`, `${year - 11}-06-01`, {
        droveCmv: false,
        dotRegulated: false,
      }),
    ],
    accidents: [],
    convictions: [],
    licenseDeniedOrRevoked: false,
    licenseDeniedOrRevokedDetail: null,
    certifiedName: `E2E Applicant${stamp}`,
    certifiedOn: today,
  };

  let caseId = '';

  it('seeded three candidates at Application: two submitted with a PDF on file, one draft', async () => {
    // The seed's three, by name: other suites build their own candidates beside these.
    const seeded = ['Terrell Gaines', 'Ruben Acosta', 'Desmond Pratt'];
    const cases = ((await get(`${HIRING}/cases`)).json() as HiringCase[]).filter((c) =>
      seeded.includes(c.candidateName),
    );
    const submitted = cases.filter((c) => c.dotApplication?.status === 'submitted');
    const drafts = cases.filter((c) => c.dotApplication?.status === 'draft');
    expect(submitted.length).toBeGreaterThanOrEqual(2);
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    for (const c of submitted) {
      expect(c.driverId).toMatch(/^drv_\d+$/);
      expect(c.verificationCaseId).toBeTruthy();
      // Submitting leaves Application; later seeds carry some of these cases much further.
      expect(['lead', 'prequalified', 'application']).not.toContain(c.state);
    }
    const doc = (
      await get(`${COMPLIANCE}/documents?requirementCode=dot_application`)
    ).json() as ComplianceDocument[];
    expect(doc.filter((d) => d.hasFile).length).toBeGreaterThanOrEqual(2);
  });

  it('backfilled a verified DOT application item for every hired driver, saying it is on the paper file', async () => {
    const items = (
      await get(`${COMPLIANCE}/items?scope=driver&entityId=drv_2031`)
    ).json() as QualificationItem[];
    const item = items.find((i) => i.requirementCode === 'dot_application');
    expect(item?.verifiedAt).toBeTruthy();
    // A database seeded before the requirement existed carries the backfilled item (no document,
    // said to be on the paper file); one seeded since then — any clean database — carries the
    // seeded signed application instead. Either way the hired driver's item is verified.
    if (item?.documentId === null) expect(item?.notes).toMatch(/^Backfilled/);
    else expect(item?.documentId).toMatch(/^doc_/);
    // Nothing that was Active before the requirement existed moved because of it. Only Active
    // cases: other suites open fresh cases in the same database (e.g. "Gate Probe …"), which are
    // rightly still waiting for their application.
    const cases = (await get(`${COMPLIANCE}/verification`)).json() as VerificationCase[];
    const active = cases.filter((c) => c.stage === 'active');
    expect(active.length).toBeGreaterThan(0);
    for (const c of active) expect(c.steps[0]?.status, c.driverName).toBe('complete');
  });

  it('converts a lead and finds no application yet', async () => {
    // A number no lead in this database has yet (other suites add 469-555 leads too).
    let phone = `+1469555${String(stamp).slice(-4)}`;
    for (let i = 0; i < 50; i += 1) {
      const found = (await get(`${HIRING}/leads?search=${phone.slice(2)}&pageSize=5`)).json() as { data: Lead[] };
      if (found.data.length === 0) break;
      phone = `+1469555${String(Math.floor(1000 + Math.random() * 8999))}`;
    }
    const lead = (
      await send('POST', `${HIRING}/leads`, {
        firstName: 'E2E',
        lastName: `Applicant${stamp}`,
        phone,
        email: `e2e.applicant.${stamp}@example.com`,
        source: 'referral',
      })
    ).json() as Lead;
    await send('POST', `${HIRING}/leads/${lead.id}/prequalify`, {
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
    const converted = (await send('POST', `${HIRING}/leads/${lead.id}/convert`, {})).json() as Lead;
    caseId = converted.hiringCaseId as string;
    const none = (await get(`${HIRING}/cases/${caseId}/dot-application`)).json() as {
      application: null;
    };
    expect(none.application).toBeNull();
    const byApplicant = (
      await get(`${HIRING}/cases?applicantId=${converted.applicantId}`)
    ).json() as HiringCase[];
    expect(byApplicant.map((c) => c.id)).toEqual([caseId]);
  });

  it('saves a draft, returns only the last four of the SSN, and refuses to submit it with the gaps named', async () => {
    const draft = (
      await send('PUT', `${HIRING}/cases/${caseId}/dot-application`, {
        ...complete,
        employment: [employer('Acme Freight', `${year - 1}-01-01`, null)],
        certifiedName: null,
        certifiedOn: null,
      })
    ).json() as DotApplication;
    expect(draft.status).toBe('draft');
    expect(draft.ssnLast4).toBe('6789');
    expect(JSON.stringify(draft)).not.toContain('123-45');
    expect(draft.form.addresses[0]?.state).toBe('TX');

    const refused = await send('POST', `${HIRING}/cases/${caseId}/dot-application/submit`, {});
    expect(refused.statusCode).toBe(422);
    const body = refused.json() as { detail: string; issues: { section: string }[] };
    expect(body.issues.map((i) => i.section)).toEqual([
      'employment',
      'employment',
      'certification',
    ]);
    expect(body.detail).toMatch(/Employment is not accounted for/);
  });

  it('submits: files the PDF under a reserved driver id, opens the case, drafts employer consents, moves to Checks', async () => {
    await send('PUT', `${HIRING}/cases/${caseId}/dot-application`, { ...complete, ssn: undefined });
    const response = await send('POST', `${HIRING}/cases/${caseId}/dot-application/submit`, {});
    expect(response.statusCode, response.body).toBe(201);
    const submitted = response.json() as DotApplication;
    expect(submitted.status).toBe('submitted');
    expect(submitted.driverId).toMatch(/^drv_\d+$/);
    expect(submitted.documentId).toMatch(/^doc_/);
    expect(submitted.verificationCaseId).toMatch(/^vc_/);
    // Two DOT-regulated employers in the window; the corner store is neither.
    expect(submitted.consentIds).toHaveLength(2);

    const file = await get(`${COMPLIANCE}/documents/${submitted.documentId}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const items = (
      await get(`${COMPLIANCE}/items?scope=driver&entityId=${submitted.driverId}`)
    ).json() as QualificationItem[];
    const item = items.find((i) => i.requirementCode === 'dot_application');
    expect(item?.documentId).toBe(submitted.documentId);
    expect(item?.verifiedAt).toBeNull();

    const consents = (
      await get(`${COMPLIANCE}/consents?driverId=${submitted.driverId}`)
    ).json() as ConsentRequest[];
    expect(
      consents
        .map((c) => [c.purpose, c.subject, c.status])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      ['employment_verification', 'Acme Freight', 'draft'],
      ['employment_verification', 'Blue Line Logistics', 'draft'],
    ]);
    expect(consents[0]?.driverName).toBe(`E2E Applicant${stamp}`);

    const vc = (
      await get(`${COMPLIANCE}/verification/${submitted.verificationCaseId}`)
    ).json() as VerificationCase;
    expect(vc.steps[0]?.status).toBe('complete');
    expect(vc.stage).toBe('document_collection');

    const hiringCase = (await get(`${HIRING}/cases/${caseId}`)).json() as HiringCase;
    expect(hiringCase.state).toBe('checks');
    expect(hiringCase.driverId).toBe(submitted.driverId);
    expect(hiringCase.events.map((e) => e.toState)).toEqual([
      'lead',
      'prequalified',
      'application',
      'checks',
    ]);
    expect(hiringCase.events[3]?.source).toBe('verification');
  });

  it('is read-only once submitted, and a second submit is a no-op', async () => {
    const edit = await send('PUT', `${HIRING}/cases/${caseId}/dot-application`, complete);
    expect(edit.statusCode).toBe(409);
    const again = (
      await send('POST', `${HIRING}/cases/${caseId}/dot-application/submit`, {})
    ).json() as DotApplication;
    expect(again.consentIds).toHaveLength(2);
  });

  it('refuses application writes to a principal without recruiting.manage', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `${HIRING}/cases/${caseId}/dot-application`,
      headers: { 'x-demo-role': 'operations', 'content-type': 'application/json' },
      payload: complete,
    });
    expect(response.statusCode).toBe(403);
  });
});
