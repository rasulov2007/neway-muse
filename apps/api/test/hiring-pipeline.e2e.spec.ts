import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  DriverRecord,
  HireDriverResult,
  HiringCase,
  OfferRecord,
  Orientation,
  QualificationItem,
  TravelTicket,
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
 * The back of the funnel. The suite builds its own candidates through the seed's real path (file
 * completed and verified, decision recorded, offer sent) so every run starts from the same place,
 * then checks the guards and drives one candidate the rest of the way: the offer can only be
 * drafted at Offer, the ticket only on an accepted offer, the hire only after an attended
 * orientation with a passed road test — and the hire opens the roster row with the id the
 * qualification file has carried since the application.
 */
describe('Hiring pipeline (e2e)', () => {
  let app: NestFastifyApplication;
  // Unique across runs: the last six digits of the clock repeat every 1000 seconds.
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const name = (stop: string) => ({ first: 'E2E', last: `${stop}${stamp}` });

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.get(HiringSeedService).seedDotApplications();
    await app.get(HiringSeedService).seedPipeline();
    await app.get(HiringSeedService).seedPipeline([
      { ...name('Offer'), state: 'TX', daysAgo: 30, stop: 'offer_sent' },
      { ...name('Ticketed'), state: 'GA', daysAgo: 35, stop: 'ticketed' },
      { ...name('Orientation'), state: 'OH', daysAgo: 40, stop: 'orientation' },
      { ...name('Hired'), state: 'MO', daysAgo: 50, stop: 'hired' },
      { ...name('Declined'), state: 'IL', daysAgo: 33, stop: 'declined' },
      { ...name('Drop'), state: 'FL', daysAgo: 31, stop: 'offer_sent' },
      { ...name('Testdata'), state: 'IN', daysAgo: 32, stop: 'offer_sent' },
    ]);
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
  const mine = async (stop: string) => {
    const cases = (await get(`${HIRING}/cases`)).json() as HiringCase[];
    const found = cases.find((c) => c.candidateName === `E2E ${stop}${stamp}`);
    if (!found) throw new Error(`no case for ${stop}`);
    return found;
  };
  const caseById = async (id: string) => (await get(`${HIRING}/cases/${id}`)).json() as HiringCase;

  it('built a case at every stage of the back of the funnel, and one who declined', async () => {
    expect((await mine('Offer')).state).toBe('offer');
    expect((await mine('Ticketed')).state).toBe('ticketed');
    expect((await mine('Orientation')).state).toBe('orientation');
    expect((await mine('Hired')).state).toBe('hired');
    expect((await mine('Declined')).state).toBe('declined_offer');
  });

  it('the hired case has an employee, a roster row with the reserved id, and the road test on file', async () => {
    const hired = await mine('Hired');
    expect(hired.employeeId).toMatch(/^emp_/);
    expect(hired.hiredAt).toBeTruthy();
    expect(hired.firstDispatchAt).toBeNull();
    const driver = (await get(`/api/v1/drivers/${hired.driverId}`)).json() as DriverRecord;
    expect(driver.id).toBe(hired.driverId);
    expect(driver.status).toBe('off_duty');
    const employee = (await get(`/api/v1/employees/${hired.employeeId}`)).json() as {
      driverId: string | null;
      position: string;
    };
    expect(employee.driverId).toBe(hired.driverId);
    expect(employee.position).toBe('Driver');
    const items = (
      await get(`${COMPLIANCE}/items?scope=driver&entityId=${hired.driverId}`)
    ).json() as QualificationItem[];
    const roadTest = items.find((i) => i.requirementCode === 'road_test');
    expect(roadTest?.documentId).toMatch(/^doc_/);
    expect(roadTest?.verifiedAt).toBeTruthy();
    const file = await get(`${COMPLIANCE}/documents/${roadTest!.documentId}/file`);
    expect(file.statusCode).toBe(200);
  });

  it('a hired driver becomes an active driver when the roster first dispatches them', async () => {
    const hired = await mine('Hired');
    // The onboarding gate is the other half (covered in its own suite); clear it here so the
    // dispatch alone is what activates the driver.
    if (hired.onboardingGate) {
      const items = (
        await get(`/api/v1/hr/onboarding/${hired.onboardingGate.checklistId}/items`)
      ).json() as {
        id: string;
        blocking: boolean;
        status: string;
        requirementCode: string | null;
      }[];
      for (const item of items.filter(
        (i) => i.blocking && i.status !== 'completed' && !i.requirementCode,
      )) {
        const done = await app.inject({
          method: 'PATCH',
          url: `/api/v1/hr/onboarding/items/${item.id}`,
          headers: { 'content-type': 'application/json' },
          payload: { status: 'completed' },
        });
        expect(done.statusCode).toBe(200);
      }
      expect((await mine('Hired')).onboardingGate?.blockingOpen).toBe(0);
    }
    const response = await send('POST', `/api/v1/drivers/${hired.driverId}/status`, {
      status: 'dispatched',
    });
    expect(response.statusCode, response.body).toBe(201);
    const after = await caseById(hired.id);
    expect(after.state).toBe('active_driver');
    expect(after.firstDispatchAt).toBeTruthy();
    expect(after.events.at(-1)?.note).toBe('First dispatch');
    // Put them back; the case does not move backwards.
    await send('POST', `/api/v1/drivers/${hired.driverId}/status`, { status: 'off_duty' });
    expect((await caseById(hired.id)).state).toBe('active_driver');
  });

  it('the pipeline read returns the offer, ticket and orientation of a case', async () => {
    const orientation = await mine('Orientation');
    const pipeline = (await get(`${HIRING}/cases/${orientation.id}/pipeline`)).json() as {
      offer: OfferRecord | null;
      ticket: TravelTicket | null;
      orientation: Orientation | null;
    };
    expect(pipeline.offer?.status).toBe('accepted');
    expect(pipeline.offer?.payPlanKind).toMatch(/per_mile|percent_of_linehaul/);
    expect(pipeline.ticket?.travelCost).toBeGreaterThan(0);
    expect(pipeline.orientation?.attendance).toBe('attended');
    expect(pipeline.orientation?.roadTest?.result).toBe('pass');
    expect(pipeline.orientation?.roadTestDocumentId).toMatch(/^doc_/);
  });

  it('refuses each step out of order', async () => {
    const ticketed = await mine('Ticketed');
    const offerAgain = await send('POST', `${HIRING}/cases/${ticketed.id}/offer`, {
      driverType: 'company',
      payPlan: { kind: 'per_mile', rate: 0.6 },
      orientationDate: '2026-10-01',
    });
    expect(offerAgain.statusCode).toBe(409);
    const hireEarly = await send('POST', `${HIRING}/cases/${ticketed.id}/hire`, {
      hireDate: '2026-10-05',
      dispatcherId: 'usr_002',
    });
    expect(hireEarly.statusCode).toBe(409);

    const atOffer = await mine('Offer');
    const ticketEarly = await send('POST', `${HIRING}/cases/${atOffer.id}/ticket`, {
      travelMode: 'bus',
      departAt: '2026-10-01T12:00:00.000Z',
    });
    expect(ticketEarly.statusCode).toBe(409);
    expect((ticketEarly.json() as { detail: string }).detail).toMatch(/once the offer is accepted/);
  });

  it('carries the offer case the rest of the way: accept, ticket, orientation, hire', async () => {
    const atOffer = await mine('Offer');
    const caseId = atOffer.id;
    const accepted = (
      await send('POST', `${HIRING}/cases/${caseId}/offer/status`, { status: 'accepted' })
    ).json() as OfferRecord;
    expect(accepted.status).toBe('accepted');

    const ticket = (
      await send('POST', `${HIRING}/cases/${caseId}/ticket`, {
        travelMode: 'flight',
        carrier: 'Southwest',
        departAt: '2026-10-01T12:00:00.000Z',
        travelCost: 210,
        lodgingNights: 2,
        lodgingCost: 190,
      })
    ).json() as TravelTicket;
    expect(ticket.travelMode).toBe('flight');
    expect((await caseById(caseId)).state).toBe('ticketed');

    const noRoadTest = (
      await send('PUT', `${HIRING}/cases/${caseId}/orientation`, {
        startDate: '2026-10-02',
        days: 3,
        perDayPay: 150,
        attendance: 'attended',
      })
    ).json() as Orientation;
    expect(noRoadTest.roadTest).toBeNull();
    expect((await caseById(caseId)).state).toBe('orientation');
    const tooSoon = await send('POST', `${HIRING}/cases/${caseId}/hire`, {
      hireDate: '2026-10-05',
      dispatcherId: 'usr_002',
    });
    expect(tooSoon.statusCode).toBe(409);
    expect((tooSoon.json() as { detail: string }).detail).toMatch(/road test passed/);

    const passed = (
      await send('PUT', `${HIRING}/cases/${caseId}/orientation`, {
        startDate: '2026-10-02',
        days: 3,
        perDayPay: 150,
        attendance: 'attended',
        roadTest: {
          result: 'pass',
          testedOn: '2026-10-04',
          examinerName: 'Tom Brennan',
          vehicleType: 'Tractor-semitrailer',
        },
        completedOn: '2026-10-04',
      })
    ).json() as Orientation;
    expect(passed.roadTestDocumentId).toMatch(/^doc_/);

    // Filed for review, not accepted by being filed: the hire waits until Safety verifies it.
    const unreviewed = await send('POST', `${HIRING}/cases/${caseId}/hire`, {
      hireDate: '2026-10-05',
      dispatcherId: 'usr_002',
    });
    expect(unreviewed.statusCode).toBe(409);
    expect((unreviewed.json() as { missing: string[] }).missing.join(' ')).toMatch(/Road test certificate: pending verification/);
    const verified = await send('POST', `${COMPLIANCE}/documents/${passed.roadTestDocumentId}/verify`, {});
    expect(verified.statusCode, verified.body).toBe(201);

    const response = await send('POST', `${HIRING}/cases/${caseId}/hire`, {
      hireDate: '2026-10-05',
      dispatcherId: 'usr_002',
      preferredLanguage: 'en',
    });
    expect(response.statusCode, response.body).toBe(201);
    const hired = response.json() as HireDriverResult;
    expect(hired.driverId).toBe(atOffer.driverId);
    expect(hired.driverNumber).toBe(`D-${atOffer.driverId!.replace('drv_', '')}`);
    expect(hired.onboardingChecklistId).toMatch(/^onb_/);
    const after = await caseById(caseId);
    expect(after.state).toBe('hired');
    expect(after.employeeId).toBe(hired.employeeId);
    expect(after.events.map((e) => e.toState).slice(-3)).toEqual([
      'ticketed',
      'orientation',
      'hired',
    ]);

    // Hiring twice is never repeated (owner, 2026-10-08): the second Confirm answers with the hire
    // that already happened — the same employee and driver — and nothing new is created.
    const again = await send('POST', `${HIRING}/cases/${caseId}/hire`, {
      hireDate: '2026-10-05',
      dispatcherId: 'usr_002',
    });
    expect(again.statusCode, again.body).toBeLessThan(300);
    const second = again.json() as HireDriverResult;
    expect(second.driverId).toBe(hired.driverId);
    expect(second.employeeId).toBe(hired.employeeId);
    expect((await caseById(caseId)).events.filter((e) => e.toState === 'hired')).toHaveLength(1);
  });

  it('a declined offer ends the case as declined_offer and withdraws the applicant', async () => {
    const declined = await mine('Declined');
    expect(declined.endReason).toBe('declined_offer');
    expect(declined.closedAt).toBeTruthy();
    const applicant = (
      await get(`/api/v1/hr/recruiting/candidates/${declined.applicantId}`)
    ).json() as { stage: string };
    expect(applicant.stage).toBe('withdrawn');
  });

  it('a recruiter drops a case Safety has not ended, with a reason, and it reads as withdrawn', async () => {
    const drop = await mine('Drop');
    const res = await send('POST', `${HIRING}/cases/${drop.id}/drop`, { reason: 'unresponsive', note: 'No answer for a week' });
    expect(res.statusCode).toBe(201);
    const after = res.json() as HiringCase;
    expect(after.state).toBe('withdrawn');
    expect(after.endReason).toBe('unresponsive');
    expect(after.events.at(-1)?.note).toBe('No answer for a week');
  });

  it('refuses to drop a hired driver', async () => {
    const hired = await mine('Hired');
    const res = await send('POST', `${HIRING}/cases/${hired.id}/drop`, { reason: 'other' });
    expect(res.statusCode).toBe(409);
  });

  it('the calendar lists travel, orientation and hires by date', async () => {
    const events = (await get(`${HIRING}/calendar?from=2000-01-01&to=2100-01-01`)).json() as { kind: string; candidateName: string }[];
    const mineOnly = events.filter((e) => e.candidateName.endsWith(stamp));
    expect(mineOnly.some((e) => e.kind === 'travel' && e.candidateName.includes('Ticketed'))).toBe(true);
    expect(mineOnly.some((e) => e.kind === 'orientation')).toBe(true);
    expect(mineOnly.some((e) => e.kind === 'hired' && e.candidateName.includes('Hired'))).toBe(true);
    expect((await get(`${HIRING}/calendar?from=bad&to=2100-01-01`)).statusCode).toBe(422);
  });

  it('HR uploads a candidate document into the driver file, pending Safety, and can open it', async () => {
    const ticketed = await mine('Ticketed');
    const before = (await get(`${HIRING}/cases/${ticketed.id}/documents`)).json() as { driverId: string | null; documents: { id: string; requirementCode: string; status: string }[] };
    expect(before.driverId).toBe(ticketed.driverId);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
    const up = await send('POST', `${HIRING}/cases/${ticketed.id}/documents`, {
      requirementCode: 'psp_review', title: 'PSP report', fileName: 'psp.pdf', contentType: 'application/pdf',
      sizeBytes: 40, content: pdf,
    });
    expect(up.statusCode).toBe(201);
    const doc = up.json() as { id: string; status: string; ownerId: string };
    expect(doc.status).toBe('pending_review');
    expect(doc.ownerId).toBe(ticketed.driverId);
    const after = (await get(`${HIRING}/cases/${ticketed.id}/documents`)).json() as { documents: { id: string }[] };
    expect(after.documents.some((d) => d.id === doc.id)).toBe(true);
    expect((await get(`${HIRING}/cases/${ticketed.id}/documents/${doc.id}/file`)).statusCode).toBe(200);

    // Another candidate's case cannot open this document.
    const other = await mine('Orientation');
    expect((await get(`${HIRING}/cases/${other.id}/documents/${doc.id}/file`)).statusCode).toBe(404);
  });

  it('refuses a document that is not on the hiring list', async () => {
    const ticketed = await mine('Ticketed');
    const res = await send('POST', `${HIRING}/cases/${ticketed.id}/documents`, {
      requirementCode: 'truck_registration', title: 'x', fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1, content: 'eA==',
    });
    expect(res.statusCode).toBe(422);
  });

  it('a candidate marked as test data is kept but leaves the pipeline list and counts', async () => {
    const target = await mine('Testdata');
    const before = (await get(`${HIRING}/cases/summary`)).json() as Record<string, number>;
    await app.get(HiringService).markTest(
      { userId: 'e2e', userName: 'e2e', companyId: 'co_northwind', companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set() },
      target.id,
      'e2e test data',
    );
    await expect(mine('Testdata')).rejects.toThrow();
    const after = (await get(`${HIRING}/cases/summary`)).json() as Record<string, number>;
    expect(after[target.state]).toBe((before[target.state] ?? 0) - 1);
  });
});
