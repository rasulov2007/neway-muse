import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DotApplication, HiringActivityEntry, HiringCase, Lead, LatestFollowUp } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { HiringSeedService } from '../src/database/hiring-seed.service';

const BASE = '/api/v1/hiring';

/**
 * The candidate record behind the Recruiting redesign (2026-09-30): a DOT application saved as an
 * incomplete draft and submitted once, a recruiter across lead / case / candidate, follow-ups that
 * are recorded (never sent), and the Activity feed that reads them beside the stage history.
 */
describe('Hiring candidate (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  let caseId = '';
  let leadId = '';

  beforeAll(async () => {
    app = await createApp();
    await app.get(HiringSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const post = (url: string, payload: unknown) => send('POST', url, payload);
    const lead = (await post(`${BASE}/leads`, {
      firstName: 'E2E',
      lastName: `Cand${stamp}`,
      phone: `+1404${String(Date.now()).slice(-7)}`,
      email: `e2e.cand.${stamp}@example.com`,
      source: 'facebook',
      // Named, so the test does not depend on who the rotation has eligible (owner, 2026-10-08).
      recruiterEmployeeId: 'emp_1010',
    })).json() as Lead;
    leadId = lead.id;
    await post(`${BASE}/leads/${lead.id}/prequalify`, {
      age23Plus: true, cdlHeldYears: 6, otrExperienceYears: 5, accidents36mo: 0, movingViolations36mo: 0,
      duiEver: false, endorsements: [], payTypePreference: 'company', homeState: 'IL', earliestStartDate: null,
    });
    const converted = (await post(`${BASE}/leads/${lead.id}/convert`, {})).json() as Lead;
    caseId = converted.hiringCaseId as string;
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, payload: payload as object });
  const get = (url: string) => app.inject({ method: 'GET', url });

  it('saves an incomplete draft and reads it back unchanged', async () => {
    const draft = {
      legalFirstName: 'E2E',
      legalMiddleName: null,
      legalLastName: `Cand${stamp}`,
      dateOfBirth: '',
      addresses: [{ street: '12 Elm St', city: '', state: 'IL', zip: '', from: '', to: null }],
      licenses: [],
      employment: [],
      accidents: [],
      convictions: [],
      licenseDeniedOrRevoked: false,
      licenseDeniedOrRevokedDetail: null,
      certifiedName: null,
      certifiedOn: null,
    };
    const saved = await send('PUT', `${BASE}/cases/${caseId}/dot-application`, draft);
    expect(saved.statusCode).toBe(200);
    const back = (await get(`${BASE}/cases/${caseId}/dot-application`)).json() as { application: DotApplication };
    expect(back.application.status).toBe('draft');
    expect(back.application.form.addresses[0]?.street).toBe('12 Elm St');
    expect(back.application.form.dateOfBirth).toBe('');
  });

  it('refuses to submit the incomplete draft, naming each field and its section', async () => {
    const res = await send('POST', `${BASE}/cases/${caseId}/dot-application/submit`, {});
    expect(res.statusCode).toBe(422);
    const issues = (res.json() as { issues: { section: string; path: string | null; detail: string }[] }).issues;
    expect(issues.some((i) => i.section === 'identity' && i.path === 'dateOfBirth')).toBe(true);
    expect(issues.some((i) => i.section === 'addresses' && i.path === 'addresses.0.city')).toBe(true);
  });

  it('submits a complete application once; a retry returns the same filing, not a second driver file', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const complete = {
      legalFirstName: 'E2E',
      legalMiddleName: null,
      legalLastName: `Cand${stamp}`,
      dateOfBirth: '1985-04-02',
      ssn: '123-45-6789',
      addresses: [{ street: '12 Elm St', city: 'Chicago', state: 'IL', zip: '60601', from: '2015-01-01', to: null }],
      licenses: [{ state: 'IL', number: `E2E${stamp}`, licenseClass: 'A', endorsements: [], expiresOn: '2030-01-01' }],
      employment: [
        {
          kind: 'employer', employer: 'E2E Freight', address: null, phone: null, contactName: null, position: 'Driver',
          from: '2010-01-01', to: null, reasonForLeaving: null, droveCmv: true, dotRegulated: true, subjectToDrugTesting: true,
        },
      ],
      accidents: [],
      convictions: [],
      licenseDeniedOrRevoked: false,
      licenseDeniedOrRevokedDetail: null,
      certifiedName: `E2E Cand${stamp}`,
      certifiedOn: today,
    };
    expect((await send('PUT', `${BASE}/cases/${caseId}/dot-application`, complete)).statusCode).toBe(200);
    const [a, b] = await Promise.all([
      send('POST', `${BASE}/cases/${caseId}/dot-application/submit`, {}),
      send('POST', `${BASE}/cases/${caseId}/dot-application/submit`, {}),
    ]);
    const first = (a.statusCode === 201 ? a : b).json() as DotApplication;
    expect(first.status).toBe('submitted');
    const retry = (await send('POST', `${BASE}/cases/${caseId}/dot-application/submit`, {})).json() as DotApplication;
    expect(retry.driverId).toBe(first.driverId);
    expect(retry.documentId).toBe(first.documentId);
    const c = (await get(`${BASE}/cases/${caseId}`)).json() as HiringCase;
    expect(c.driverId).toBe(first.driverId);
    // One application PDF in the driver file, however many times submit was pressed.
    const docs = (await get(`/api/v1/compliance/documents?ownerType=driver&ownerId=${first.driverId}&requirementCode=dot_application`)).json() as unknown[];
    expect(docs).toHaveLength(1);
  });

  it('assigns a recruiter across the case, the candidate and the lead', async () => {
    const lead = (await get(`${BASE}/leads/${leadId}`)).json() as Lead;
    const recruiter = lead.recruiterEmployeeId;
    expect(recruiter).toBeTruthy();
    const cleared = (await send('POST', `${BASE}/cases/${caseId}/recruiter`, { employeeId: null })).json() as HiringCase;
    expect(cleared.recruiterName).toBeNull();
    const set = (await send('POST', `${BASE}/cases/${caseId}/recruiter`, { employeeId: recruiter })).json() as HiringCase;
    expect(set.recruiterId).toBe(recruiter);
    expect(((await get(`${BASE}/leads/${leadId}`)).json() as Lead).recruiterEmployeeId).toBe(recruiter);
    const foreign = await send('POST', `${BASE}/cases/${caseId}/recruiter`, { employeeId: 'emp_not_ours' });
    expect(foreign.statusCode).toBe(422);
  });

  it('records a follow-up (nothing is sent), shows it as the latest, and in Activity', async () => {
    const res = await send('POST', `${BASE}/cases/${caseId}/follow-ups`, { method: 'call', outcome: 'no_answer', note: 'Rang twice' });
    expect(res.statusCode).toBe(201);
    const latest = (await get(`${BASE}/follow-ups/latest`)).json() as LatestFollowUp[];
    expect(latest.find((f) => f.entityId === caseId)?.outcome).toBe('no_answer');
    const other = await send('POST', `${BASE}/cases/${caseId}/follow-ups`, { method: 'call', outcome: 'other', note: '' });
    expect(other.statusCode).toBe(422);
    const activity = (await get(`${BASE}/cases/${caseId}/activity`)).json() as HiringActivityEntry[];
    expect(activity.some((a) => a.kind === 'follow_up' && a.detail === 'Rang twice')).toBe(true);
    expect(activity.some((a) => a.kind === 'stage')).toBe(true);
    expect(activity.some((a) => a.title.startsWith('Recruiter set to'))).toBe(true);
  });

  it('records a follow-up on a lead that has no case yet', async () => {
    const lead = (await send('POST', `${BASE}/leads`, {
      firstName: 'E2E', lastName: `Fresh${stamp}`, phone: `+1470${String(Date.now()).slice(-7)}`, source: 'instagram',
    })).json() as Lead;
    const res = await send('POST', `${BASE}/leads/${lead.id}/follow-ups`, { method: 'text', outcome: 'left_message', note: null });
    expect(res.statusCode).toBe(201);
  });
});
