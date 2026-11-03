import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { HiringCase, Lead, LeadSummary } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { HiringSeedService } from '../src/database/hiring-seed.service';

const BASE = '/api/v1/hiring';

/**
 * The front of the funnel, end to end: a lead is added, contacted, prequalified against the rules
 * in Settings, flagged with the rule named, and converted into a candidate with a hiring case.
 * Every record this creates carries an `e2e` marker in its name so it reads as what it is.
 */
describe('Hiring API (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = Date.now();

  beforeAll(async () => {
    app = await createApp();
    await app.get(HiringSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, headers?: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: payload as object });

  const answers = {
    age23Plus: true,
    cdlHeldYears: 6,
    otrExperienceYears: 5,
    accidents36mo: 0,
    movingViolations36mo: 1,
    duiEver: false,
    endorsements: ['H'],
    payTypePreference: 'company',
    homeState: 'TX',
    earliestStartDate: null,
  };

  it('seeded a populated front of funnel with every tile non-empty', async () => {
    const summary = (await get(`${BASE}/leads/summary`)).json() as LeadSummary;
    expect(summary.total).toBeGreaterThanOrEqual(30);
    for (const key of ['uncontacted', 'contacted', 'prequalified', 'flagged', 'converted', 'dead'] as const) {
      expect(summary[key], key).toBeGreaterThan(0);
    }
  });

  it('refuses lead writes to a principal without recruiting.manage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/leads`,
      headers: { 'x-demo-role': 'operations', 'content-type': 'application/json' },
      payload: { firstName: 'A', lastName: 'B', phone: '+13125550100', source: 'website' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('adds a lead with a phone number and nothing else required; the recruiter is the next rotation turn', async () => {
    const nextBody = (await app.inject({ method: 'GET', url: `${BASE}/recruiting/rotation/next` })).body;
    const next = (nextBody ? JSON.parse(nextBody) : null) as { employeeId: string } | null;
    // A number no lead in this database has yet (other suites add 312-555 leads too).
    let phone = `+1312555${String(stamp).slice(-4)}`;
    for (let i = 0; i < 50; i += 1) {
      const found = (await get(`${BASE}/leads?search=${phone.slice(2)}&pageSize=5`)).json() as { data: Lead[] };
      if (found.data.length === 0) break;
      phone = `+1312555${String(Math.floor(1000 + Math.random() * 8999))}`;
    }
    const response = await post(`${BASE}/leads`, {
      firstName: 'E2E',
      lastName: `Lead${stamp}`,
      phone,
      source: 'referral',
    });
    expect(response.statusCode).toBe(201);
    const lead = response.json() as Lead;
    expect(lead.status).toBe('new');
    expect(lead.leadNumber).toMatch(/^LEAD-\d+$/);
    // Automatic by default (owner, 2026-10-08): the rotation's next turn, or unassigned when nobody is eligible.
    // (Other suites add leads in parallel, so the exact turn may have moved on; never a made-up owner.)
    if (next) expect(lead.recruiterEmployeeId).toBeTruthy();
    else expect(lead.recruiterEmployeeId).toBeNull();
    expect(lead.prequalification).toBeNull();
  });

  it('refuses a second live lead for the same phone number', async () => {
    const phone = `+1773555${String(stamp).slice(-4)}`;
    await post(`${BASE}/leads`, { firstName: 'Dup', lastName: 'One', phone, source: 'website' });
    const second = await post(`${BASE}/leads`, { firstName: 'Dup', lastName: 'Two', phone, source: 'website' });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { detail: string }).detail).toMatch(/already lead LEAD-/);
  });

  it('flags a lead that fails a rule, naming the rule, and refuses to convert it', async () => {
    const lead = (await post(`${BASE}/leads`, {
      firstName: 'E2E',
      lastName: `Flagged${stamp}`,
      phone: `+1615555${String(stamp).slice(-4)}`,
      source: 'job_board',
    })).json() as Lead;

    const evaluated = (await post(`${BASE}/leads/${lead.id}/prequalify`, { ...answers, accidents36mo: 4, duiEver: true })).json() as Lead;
    expect(evaluated.status).toBe('contacted');
    expect(evaluated.prequalResult?.qualifies).toBe(false);
    expect(evaluated.prequalResult?.failed.map((f) => f.label)).toEqual(['Too many accidents', 'DUI on record']);
    expect(evaluated.prequalResult?.failed[0]?.detail).toBe('4 accidents in 36 months; at most 2');

    const convert = await post(`${BASE}/leads/${lead.id}/convert`, {});
    expect(convert.statusCode).toBe(409);
    expect((convert.json() as { detail: string }).detail).toMatch(/Does not prequalify: Too many accidents/);

    const flagged = (await get(`${BASE}/leads?flagged=true&pageSize=100`)).json() as { data: Lead[] };
    expect(flagged.data.some((l) => l.id === lead.id)).toBe(true);

    const dead = (await post(`${BASE}/leads/${lead.id}/disqualify`, { reason: 'Two rules failed' })).json() as Lead;
    expect(dead.status).toBe('dead');
    expect(dead.deadReason).toBe('Two rules failed');

    // Reopened with a note: back to the step it had reached (contacted; its answers failed), the
    // disqualification cleared, the note on the lead's notes.
    expect((await post(`${BASE}/leads/${lead.id}/reopen`, { note: 'x' })).statusCode).toBe(422);
    const back = await post(`${BASE}/leads/${lead.id}/reopen`, { note: 'Called back - accidents were not at fault' });
    expect(back.statusCode, back.body).toBe(201);
    expect(back.json()).toMatchObject({ status: 'contacted', deadReason: null });
    expect((await post(`${BASE}/leads/${lead.id}/reopen`, { note: 'again please' })).statusCode).toBe(409);
    const notes = (await get(`/api/v1/hiring/recruiting/candidates/${lead.id}/notes`)).json() as Array<{ text: string }>;
    expect(notes.some((n) => n.text === 'Called back - accidents were not at fault')).toBe(true);
  });

  it('prequalifies a clean lead, converts it, and opens a hiring case with the lead’s own history', async () => {
    const lead = (await post(`${BASE}/leads`, {
      firstName: 'E2E',
      lastName: `Clean${stamp}`,
      phone: `+1214555${String(stamp).slice(-4)}`,
      email: `e2e.clean.${stamp}@example.com`,
      source: 'referral',
    })).json() as Lead;

    const contacted = (await post(`${BASE}/leads/${lead.id}/contacted`, {})).json() as Lead;
    expect(contacted.status).toBe('contacted');

    const prequalified = (await post(`${BASE}/leads/${lead.id}/prequalify`, answers)).json() as Lead;
    expect(prequalified.status).toBe('prequalified');
    expect(prequalified.prequalResult?.qualifies).toBe(true);

    const converted = (await post(`${BASE}/leads/${lead.id}/convert`, {})).json() as Lead;
    expect(converted.status).toBe('converted');
    expect(converted.applicantId).toMatch(/^apl_/);
    expect(converted.hiringCaseId).toMatch(/^hc_/);

    const hiringCase = (await get(`${BASE}/cases/${converted.hiringCaseId}`)).json() as HiringCase;
    expect(hiringCase.state).toBe('application');
    expect(hiringCase.applicantId).toBe(converted.applicantId);
    expect(hiringCase.events.map((e) => e.toState)).toEqual(['lead', 'prequalified', 'application']);
    // The first event is when the lead was created, not when it was converted.
    expect(hiringCase.events[0]?.at).toBe(lead.createdAt);

    // The applicant exists in recruiting as a driver candidate.
    const applicant = (await get(`/api/v1/hr/recruiting/candidates/${converted.applicantId}`)).json() as {
      position: string;
      department: string;
      source: string | null;
    };
    expect(applicant.position).toBe('Driver');
    expect(applicant.department).toBe('dispatch');
    expect(applicant.source).toBe('referral');

    // Converting twice is a no-op, not a second person.
    const again = (await post(`${BASE}/leads/${lead.id}/convert`, {})).json() as Lead;
    expect(again.applicantId).toBe(converted.applicantId);
  });

  it('reads the rules from Settings, so a changed threshold changes the verdict', async () => {
    const original = (await get(`${BASE}/leads/rules`)).json() as { maxAccidents36mo: number | null };
    expect(original.maxAccidents36mo).toBe(2);

    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { 'content-type': 'application/json' },
      payload: { values: { 'hiring.prequal.max_accidents_36mo': 5 } },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    try {
      const lead = (await post(`${BASE}/leads`, {
        firstName: 'E2E',
        lastName: `Rules${stamp}`,
        phone: `+1404555${String(stamp).slice(-4)}`,
        source: 'social',
      })).json() as Lead;
      const evaluated = (await post(`${BASE}/leads/${lead.id}/prequalify`, { ...answers, accidents36mo: 4 })).json() as Lead;
      expect(evaluated.prequalResult?.qualifies).toBe(true);
    } finally {
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/settings',
        headers: { 'content-type': 'application/json' },
        payload: { values: { 'hiring.prequal.max_accidents_36mo': 2 } },
      });
    }
  });
});
