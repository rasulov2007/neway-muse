import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  ApplicantRecord,
  Campaign,
  CostEntry,
  CostSummary,
  HiringCase,
  JobOpeningRecord,
  Lead,
  LeadSummary,
  TravelTicket,
} from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { HiringService } from '../src/modules/hiring/hiring.service';

const HIRING = '/api/v1/hiring';
const HR = '/api/v1/hr/recruiting';

/**
 * The recruiting redesign's server rules (2026-10-01): retries never duplicate (conversion, manual
 * costs, offer answers, travel), a cost already booked in Accounting backs one candidate cost only,
 * mistaken costs are voided not deleted, drivers and office staff stay on separate tracks (and a
 * driver cannot be hired or offered around Safety through the office routes), leads read by
 * period and sort on the server, and references on a lead must be this company's.
 */
describe('Recruiting redesign (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const phone = (n: number) => `+1415${String(Date.now()).slice(-5)}${n}`;

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.get(HiringSeedService).seedDotApplications();
    await app.get(HiringSeedService).seedPipeline([
      { first: 'E2E', last: `Retry${stamp}`, state: 'TX', daysAgo: 20, stop: 'offer_sent' },
    ]);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      payload: payload as object | undefined,
    });
  const answers = {
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
  };

  async function prequalifiedLead(tag: string, n: number): Promise<Lead> {
    const made = await call('POST', `${HIRING}/leads`, {
      firstName: 'E2E',
      lastName: `${tag}${stamp}`,
      phone: phone(n),
      source: 'website',
    });
    expect(made.statusCode, made.body).toBe(201);
    const lead = made.json() as Lead;
    const pq = await call('POST', `${HIRING}/leads/${lead.id}/prequalify`, answers);
    expect(pq.statusCode, pq.body).toBeLessThan(300);
    return pq.json() as Lead;
  }

  let driverLead: Lead;

  it('converts a lead once, even when two conversions arrive together', async () => {
    const lead = await prequalifiedLead('Convert', 1);
    const [a, b] = await Promise.all([
      call('POST', `${HIRING}/leads/${lead.id}/convert`, {}),
      call('POST', `${HIRING}/leads/${lead.id}/convert`, {}),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const one = a.json() as Lead;
    const two = b.json() as Lead;
    expect(one.status).toBe('converted');
    expect(two.applicantId).toBe(one.applicantId);
    expect(two.hiringCaseId).toBe(one.hiringCaseId);
    const cases = (await call('GET', `${HIRING}/cases?applicantId=${one.applicantId}`)).json() as HiringCase[];
    expect(cases).toHaveLength(1);
    const same = (await call('GET', `${HR}/candidates?search=Convert${stamp}&includeClosed=true`)).json() as {
      data: ApplicantRecord[];
    };
    expect(same.data).toHaveLength(1);
    driverLead = one;
  });

  it('keeps drivers off the office track, and off the office hire and offer routes', async () => {
    const office = (await call('GET', `${HR}/candidates?track=office&search=Convert${stamp}`)).json() as { data: ApplicantRecord[] };
    expect(office.data).toHaveLength(0);
    const driver = (await call('GET', `${HR}/candidates?track=driver&search=Convert${stamp}`)).json() as { data: ApplicantRecord[] };
    expect(driver.data).toHaveLength(1);
    expect(driver.data[0]?.hiringCaseId).toBe(driverLead.hiringCaseId);
    const hire = await call('POST', `${HR}/candidates/${driverLead.applicantId}/hire`, {
      hireDate: '2026-10-01',
      employmentType: 'full_time',
    });
    expect(hire.statusCode).toBe(409);
    expect(hire.json().detail).toMatch(/driver candidate/);
    const stage = await call('POST', `${HR}/candidates/${driverLead.applicantId}/stage`, { stage: 'offer', reason: null });
    expect(stage.statusCode).toBe(409);
  });

  it('reads leads by Eastern period and sorts them on the server', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const inToday = (await call('GET', `${HIRING}/leads?from=${today}&to=${today}&search=${stamp}&sort=name&dir=asc`)).json() as {
      data: Lead[];
      total: number;
    };
    expect(inToday.total).toBeGreaterThanOrEqual(1);
    const names = inToday.data.map((l) => l.lastName);
    expect([...names].sort()).toEqual(names);
    const before = (await call('GET', `${HIRING}/leads?from=2001-01-01&to=2001-01-31&search=${stamp}`)).json() as { total: number };
    expect(before.total).toBe(0);
    const summary = (await call('GET', `${HIRING}/leads/summary?from=2001-01-01&to=2001-01-31`)).json() as LeadSummary;
    expect(summary.total).toBe(0);
  });

  it('refuses a lead attributed to a campaign or recruiter that is not this company’s', async () => {
    const bad = await call('POST', `${HIRING}/leads`, {
      firstName: 'E2E',
      lastName: `Foreign${stamp}`,
      phone: phone(2),
      source: 'website',
      campaignId: 'cmp_does_not_exist',
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].path).toBe('campaignId');
    const badRecruiter = await call('POST', `${HIRING}/leads`, {
      firstName: 'E2E',
      lastName: `Foreign${stamp}`,
      phone: phone(3),
      source: 'website',
      recruiterEmployeeId: 'emp_not_here',
    });
    expect(badRecruiter.statusCode).toBe(422);
    expect(badRecruiter.json().errors[0].path).toBe('recruiterEmployeeId');
  });

  it('records a manual cost once per request key, and voids it instead of deleting', async () => {
    const caseId = driverLead.hiringCaseId as string;
    const body = { hiringCaseId: caseId, type: 'other', amount: 42.5, incurredOn: '2026-09-30', note: `retry ${stamp}`, clientKey: `k${stamp}abc` };
    const [a, b] = await Promise.all([call('POST', `${HIRING}/costs`, body), call('POST', `${HIRING}/costs`, body)]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect((a.json() as CostEntry).id).toBe((b.json() as CostEntry).id);
    const again = await call('POST', `${HIRING}/costs`, body);
    expect((again.json() as CostEntry).id).toBe((a.json() as CostEntry).id);
    const ledger = (await call('GET', `${HIRING}/cases/${caseId}/costs`)).json() as { entries: CostEntry[]; summary: CostSummary };
    expect(ledger.entries.filter((e) => e.note === `retry ${stamp}`)).toHaveLength(1);
    expect(ledger.summary.total).toBe(42.5);

    const zero = await call('POST', `${HIRING}/costs`, { ...body, amount: 0, clientKey: null });
    expect(zero.statusCode).toBe(422);
    expect(zero.json().errors[0].path).toBe('amount');
    const noReceipt = await call('POST', `${HIRING}/costs`, { ...body, clientKey: null, receiptFileId: 'fil_nope' });
    expect(noReceipt.statusCode).toBe(422);
    expect(noReceipt.json().errors[0].path).toBe('receiptFileId');

    const voided = await call('POST', `${HIRING}/costs/${(a.json() as CostEntry).id}/void`, { reason: 'Typed twice by mistake' });
    expect(voided.statusCode).toBe(201);
    expect((voided.json() as CostEntry).voidedAt).not.toBeNull();
    const after = (await call('GET', `${HIRING}/cases/${caseId}/costs`)).json() as { entries: CostEntry[]; summary: CostSummary };
    expect(after.entries.some((e) => e.id === (a.json() as CostEntry).id && e.voidReason === 'Typed twice by mistake')).toBe(true);
    expect(after.summary.total).toBe(0);
    const noReason = await call('POST', `${HIRING}/costs/${(a.json() as CostEntry).id}/void`, { reason: '' });
    expect(noReason.statusCode).toBe(422);
  });

  it('attributes an Accounting expense to one candidate only, taking its amount and date', async () => {
    const made = await call('POST', '/api/v1/accounting/expenses', {
      onDate: '2026-09-29',
      categoryCode: 'other',
      description: `Bus ticket ${stamp}`,
      amount: 87.25,
      truckId: null,
      driverId: null,
      loadId: null,
      vendorId: null,
      paymentMethod: null,
      paidDirectly: false,
      notes: null,
    });
    expect(made.statusCode, made.body).toBeLessThan(300);
    const expense = (made.json() as { expense: { id: string } }).expense;
    const caseId = driverLead.hiringCaseId as string;
    const linked = await call('POST', `${HIRING}/costs`, {
      hiringCaseId: caseId,
      type: 'travel',
      amount: 0,
      incurredOn: '2026-10-01',
      accountingExpenseId: expense.id,
    });
    expect(linked.statusCode, linked.body).toBe(201);
    const entry = linked.json() as CostEntry;
    expect(entry.amount).toBe(87.25);
    expect(entry.incurredOn).toBe('2026-09-29');
    const twice = await call('POST', `${HIRING}/costs`, {
      hiringCaseId: caseId,
      type: 'travel',
      amount: 0,
      incurredOn: '2026-10-01',
      accountingExpenseId: expense.id,
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().errors[0].path).toBe('accountingExpenseId');
    // Voided, the expense is free to be attributed again.
    await call('POST', `${HIRING}/costs/${entry.id}/void`, { reason: 'Wrong candidate' });
    const relinked = await call('POST', `${HIRING}/costs`, {
      hiringCaseId: caseId,
      type: 'travel',
      amount: 0,
      incurredOn: '2026-10-01',
      accountingExpenseId: expense.id,
    });
    expect(relinked.statusCode).toBe(201);
  });

  it('answers a repeated offer answer and a repeated travel save with the first one', async () => {
    const cases = (await call('GET', `${HIRING}/cases`)).json() as HiringCase[];
    const kase = cases.find((c) => c.candidateName === `E2E Retry${stamp}`);
    expect(kase?.state).toBe('offer');
    const id = kase?.id as string;
    const [x, y] = await Promise.all([
      call('POST', `${HIRING}/cases/${id}/offer/status`, { status: 'accepted' }),
      call('POST', `${HIRING}/cases/${id}/offer/status`, { status: 'accepted' }),
    ]);
    expect([x.statusCode, y.statusCode]).toEqual([201, 201]);
    const trip = {
      travelMode: 'bus',
      carrier: 'Greyhound',
      bookingReference: `E2E-${stamp}`,
      departAt: '2026-10-03T13:00:00.000Z',
      arriveAt: null,
      travelCost: 120,
      lodgingNights: 2,
      lodgingCost: 180,
      notes: null,
    };
    const [t1, t2] = await Promise.all([
      call('POST', `${HIRING}/cases/${id}/ticket`, trip),
      call('POST', `${HIRING}/cases/${id}/ticket`, trip),
    ]);
    expect([t1.statusCode, t2.statusCode]).toEqual([201, 201]);
    expect((t1.json() as TravelTicket).id).toBe((t2.json() as TravelTicket).id);
    const ledger = (await call('GET', `${HIRING}/cases/${id}/costs`)).json() as { entries: CostEntry[] };
    // Travel and lodging priced once each, automatically.
    expect(ledger.entries.filter((e) => e.type === 'travel' && e.source === 'auto')).toHaveLength(1);
    expect(ledger.entries.filter((e) => e.type === 'lodging' && e.source === 'auto')).toHaveLength(1);
    const auto = ledger.entries.find((e) => e.type === 'travel' && e.source === 'auto') as CostEntry;
    const voidAuto = await call('POST', `${HIRING}/costs/${auto.id}/void`, { reason: 'try' });
    expect(voidAuto.statusCode).toBe(409);
  });

  it('counts a driver candidate on an opening by their case, and refuses a closed opening', async () => {
    const job = (
      await call('POST', `${HR}/jobs`, {
        title: `E2E Company driver ${stamp}`,
        department: 'dispatch',
        location: null,
        employmentType: 'full_time',
        hiringManagerEmployeeId: null,
        openDate: '2026-10-01',
        targetHireDate: null,
        positionsCount: 2,
      })
    ).json() as JobOpeningRecord;
    const assigned = await call('PATCH', `${HR}/candidates/${driverLead.applicantId}`, { jobOpeningId: job.id });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const listed = ((await call('GET', `${HR}/jobs`)).json() as JobOpeningRecord[]).find((j) => j.id === job.id);
    expect(listed?.activeCandidates).toBe(1);
    await call('POST', `${HR}/jobs/${job.id}/status`, { status: 'closed' });
    const other = await prequalifiedLead('Closed', 4);
    const converted = (await call('POST', `${HIRING}/leads/${other.id}/convert`, {})).json() as Lead;
    const refused = await call('PATCH', `${HR}/candidates/${converted.applicantId}`, { jobOpeningId: job.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().errors[0].path).toBe('jobOpeningId');
  });

  it('reports each campaign’s performance to date from the server', async () => {
    const made = await call('POST', `${HIRING}/campaigns`, {
      name: `E2E Radio ${stamp}`,
      channel: 'radio',
      periodStart: '2026-09-01',
      spend: 300,
    });
    expect(made.statusCode).toBe(201);
    const campaign = made.json() as Campaign;
    expect(campaign).toMatchObject({ leadCount: 0, costPerLead: null, costPerHire: null, totalCost: 300 });
    const badDates = await call('PATCH', `${HIRING}/campaigns/${campaign.id}`, { periodStart: '2026-09-10', periodEnd: '2026-09-01' });
    expect(badDates.statusCode).toBe(422);
    await call('POST', `${HIRING}/leads`, {
      firstName: 'E2E',
      lastName: `Radio${stamp}`,
      phone: phone(5),
      source: 'other',
      campaignId: campaign.id,
    });
    const listed = ((await call('GET', `${HIRING}/campaigns`)).json() as Campaign[]).find((c) => c.id === campaign.id);
    expect(listed).toMatchObject({ leadCount: 1, candidateCount: 0, hireCount: 0, costPerLead: 300 });
  });
});
