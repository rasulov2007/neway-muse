import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverRecord, EmployeeRecord, OnboardingChecklistRecord } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';

const ROSTER = '/api/v1';
const HR = '/api/v1/hr';
const PEOPLE = '/api/v1/employees';

/**
 * A driver added to the roster is a person the company has to onboard.
 *
 * Before this, adding a driver here opened a qualification file and nothing else — no employee, no
 * onboarding plan — while the Onboarding board reads plans, which hang off an employee. So a
 * driver hired through recruiting appeared on the board and a driver typed into the roster never
 * did: the one nobody had chased yet was the one nobody could see.
 */
describe('Adding a driver opens their onboarding (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(HiringSeedService).seedOnboardingTemplates();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: payload as object,
    });

  async function addDriver(suffix: string) {
    const response = await post(`${ROSTER}/drivers`, {
      firstName: 'Onboard',
      lastName: `Test${suffix}`,
      phone: '+1 312 555 0142',
      email: `onboard.${suffix}@example.com`,
      driverType: 'company',
      cdlState: 'IL',
      cdlClass: 'A',
      cdlEndorsements: [],
      cdlExpiresOn: '2030-05-14',
      medicalCardExpiresOn: '2027-06-02',
      hireDate: '2026-09-14',
      homeCity: 'Chicago',
      homeState: 'IL',
      dispatcherId: 'usr_001',
      payPlan: { kind: 'per_mile', rate: 0.6 },
      preferredLanguage: 'en',
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as DriverRecord;
  }

  it('creates the person, the plan and the file, and leaves them undispatchable', async () => {
    const driver = await addDriver(stamp);

    // The person exists, and the roster row points at them.
    expect(driver.employeeId).toBeTruthy();
    const employee = (await get(`${PEOPLE}/${driver.employeeId}`)).json() as EmployeeRecord;
    expect(employee.position).toBe('Driver');
    expect(employee.workEmail.toLowerCase()).toBe(`onboard.${stamp}@example.com`);

    // The plan exists and is open, which is what puts them on the board.
    // The board's own default view: nothing finished, nothing filtered.
    const plans = (await get(`${HR}/onboarding?pageSize=200`)).json() as {
      data: OnboardingChecklistRecord[];
    };
    const plan = plans.data.find((row) => row.employeeId === driver.employeeId);
    expect(plan, 'the new driver has an onboarding plan').toBeTruthy();
    expect(plan?.status).not.toBe('completed');
    expect(plan?.totalItems ?? 0).toBeGreaterThan(0);

    // Nothing was verified by adding them, and nothing dispatchable was granted.
    expect(driver.status).toBe('onboarding');
    expect(driver.cdlStatus).toBe('missing');
    expect(driver.medicalCardStatus).toBe('missing');
  });

  it('shows the new driver on the board without waiting for them to be available', async () => {
    const driver = await addDriver(`${stamp}b`);

    const plans = (await get(`${HR}/onboarding?pageSize=200`)).json() as {
      data: OnboardingChecklistRecord[];
    };
    const mine = plans.data.find((row) => row.employeeId === driver.employeeId);

    expect(mine, 'an off-duty driver is still on the onboarding board').toBeTruthy();
    // The board is a list of cases, not a list of people cleared to drive.
    expect(driver.status).not.toBe('available');
  });

  it('keeps the driver when the plan cannot be opened twice', async () => {
    // Two drivers cannot share a work email; the second add is refused before anything is written.
    const suffix = `${stamp}c`;
    await addDriver(suffix);
    const second = await post(`${ROSTER}/drivers`, {
      firstName: 'Onboard',
      lastName: 'Duplicate',
      phone: '+1 312 555 0143',
      email: `onboard.${suffix}@example.com`,
      driverType: 'company',
      cdlState: 'IL',
      cdlClass: 'A',
      cdlEndorsements: [],
      cdlExpiresOn: '2030-05-14',
      medicalCardExpiresOn: '2027-06-02',
      hireDate: '2026-09-14',
      homeCity: 'Chicago',
      homeState: 'IL',
      dispatcherId: 'usr_001',
      payPlan: { kind: 'per_mile', rate: 0.6 },
      preferredLanguage: 'en',
    });
    expect(second.statusCode).toBe(409);
  });
});
