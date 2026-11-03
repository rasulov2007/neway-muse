import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  HireDriverResult,
  HiringCase,
  OnboardingItemRecord,
  OnboardingTemplate,
} from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { HiringService } from '../src/modules/hiring/hiring.service';

const HIRING = '/api/v1/hiring';
const HR = '/api/v1/hr';

/**
 * Onboarding templates and the gate. The hire picks the template for the offer's driver type,
 * its file-linked items are already complete from the qualification file, a hand tick on one of
 * them is refused, and the driver stays at Hired through their first dispatch until nothing
 * blocking is open — then becomes an active driver the moment the last blocking item closes.
 */
describe('Onboarding templates and the gate (e2e)', () => {
  let app: NestFastifyApplication;
  // Unique across runs: the last six digits of the clock repeat every 1000 seconds.
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.get(HiringSeedService).seedDotApplications();
    await app.get(HiringSeedService).seedPipeline();
    await app.get(HiringSeedService).seedCampaigns();
    await app.get(HiringSeedService).seedOnboardingTemplates();
    await app
      .get(HiringSeedService)
      .seedPipeline([
        { first: 'E2E', last: `Gate${stamp}`, state: 'TX', daysAgo: 40, stop: 'orientation' },
      ]);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });
  const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
    app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      payload: payload as object,
    });
  const myCase = async () => {
    const cases = (await get(`${HIRING}/cases`)).json() as HiringCase[];
    return cases.find((c) => c.candidateName === `E2E Gate${stamp}`) as HiringCase;
  };

  it('installed one template per driver type, with blocking and file-linked items', async () => {
    const templates = (await get(`${HR}/onboarding/templates`)).json() as OnboardingTemplate[];
    expect(templates.map((t) => t.driverType).sort()).toEqual([
      'company',
      'lease_operator',
      'owner_operator',
    ]);
    const lease = templates.find((t) => t.driverType === 'lease_operator')!;
    expect(lease.items.some((i) => /Lease agreement/.test(i.title) && i.blocking)).toBe(true);
    expect(lease.items.some((i) => i.requirementCode === 'road_test')).toBe(true);
  });

  let checklistId = '';
  let caseId = '';

  it('the hire builds the plan from the driver-type template and completes file-linked items from the file', async () => {
    const before = await myCase();
    caseId = before.id;
    const response = await send('POST', `${HIRING}/cases/${caseId}/hire`, {
      hireDate: '2026-10-05',
      dispatcherId: 'usr_002',
    });
    expect(response.statusCode, response.body).toBe(201);
    const hired = response.json() as HireDriverResult;
    checklistId = hired.onboardingChecklistId as string;
    expect(checklistId).toMatch(/^onb_/);

    const items = (
      await get(`${HR}/onboarding/${checklistId}/items`)
    ).json() as OnboardingItemRecord[];
    const linked = items.filter((i) => i.requirementCode);
    expect(linked.length).toBeGreaterThanOrEqual(4);
    // CDL, medical, DOT application and road test are all verified in the file for this hire.
    for (const i of linked) expect(i.status, i.title).toBe('completed');
    expect(items.some((i) => i.blocking && i.status === 'pending')).toBe(true);

    const after = await myCase();
    expect(after.state).toBe('hired');
    expect(after.onboardingGate?.checklistId).toBe(checklistId);
    expect(after.onboardingGate?.blockingOpen).toBeGreaterThan(0);
  });

  it('refuses a hand tick on a file-linked item', async () => {
    const items = (
      await get(`${HR}/onboarding/${checklistId}/items`)
    ).json() as OnboardingItemRecord[];
    const linked = items.find((i) => i.requirementCode === 'road_test')!;
    const response = await send('PATCH', `${HR}/onboarding/items/${linked.id}`, {
      status: 'pending',
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { detail: string }).detail).toMatch(
      /completes from the qualification file/,
    );
  });

  it('holds the driver at Hired through first dispatch while blocking items are open, then activates on the last one', async () => {
    const hired = await myCase();
    const dispatch = await send('POST', `/api/v1/drivers/${hired.driverId}/status`, {
      status: 'dispatched',
    });
    expect(dispatch.statusCode).toBe(201);
    const held = await myCase();
    expect(held.state).toBe('hired');
    expect(held.firstDispatchAt).toBeTruthy();

    const items = (
      await get(`${HR}/onboarding/${checklistId}/items`)
    ).json() as OnboardingItemRecord[];
    // Only hand items are left open: the linked ones completed from the file at the hire.
    const open = items.filter(
      (i) => i.blocking && i.status !== 'completed' && i.status !== 'skipped',
    );
    expect(open.every((i) => i.requirementCode === null)).toBe(true);
    for (const [index, item] of open.entries()) {
      const response = await send('PATCH', `${HR}/onboarding/items/${item.id}`, {
        status: 'completed',
      });
      expect(response.statusCode, item.title).toBe(200);
      const state = (await myCase()).state;
      expect(state, `after ${item.title}`).toBe(
        index === open.length - 1 ? 'active_driver' : 'hired',
      );
    }
    const done = await myCase();
    expect(done.onboardingGate?.blockingOpen).toBe(0);
    expect(done.events.at(-1)?.note).toMatch(/Onboarding gate cleared/);
  });
});
