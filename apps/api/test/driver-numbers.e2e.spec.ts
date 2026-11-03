import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverRecord } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';

const ROSTER = '/api/v1';

/**
 * Round-3 P1 #4: every driver gets a unique, stable, sequential number.
 *
 * The number is read and the row written under one company-wide advisory lock, and the table
 * carries a unique index on (company, driver number). This proves the first: a burst of creates
 * fired together all succeed and none of them share a number.
 */
describe('Driver numbers under concurrent creates (e2e)', () => {
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

  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: payload as object,
    });

  const addDriver = (suffix: string) =>
    post(`${ROSTER}/drivers`, {
      firstName: 'Batch',
      lastName: `Driver${suffix}`,
      phone: '+1 312 555 0142',
      secondaryPhone: '+1 312 555 0199',
      secondaryPhoneLabel: 'spouse',
      email: `batch.${suffix}@example.com`,
      driverType: 'company',
      cdlState: 'IL',
      cdlClass: 'A',
      cdlEndorsements: [],
      cdlExpiresOn: '2030-05-14',
      medicalCardExpiresOn: '2027-06-02',
      hireDate: '2026-09-17',
      homeCity: 'Chicago',
      homeState: 'IL',
      dispatcherId: 'usr_001',
      payPlan: { kind: 'per_mile', rate: 0.6 },
      preferredLanguage: 'en',
    });

  it('hands eight simultaneous creates eight different, consecutive numbers', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => addDriver(`${stamp}${i}`)),
    );
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    const drivers = responses.map((r) => r.json() as DriverRecord);

    const numbers = drivers.map((d) => d.driverNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const number of numbers) expect(number).toMatch(/^D-\d+$/);

    // Sequential: sorted, the numbers step by one, and the id carries the same digits.
    const digits = numbers.map((n) => Number(n.slice(2))).sort((a, b) => a - b);
    for (let i = 1; i < digits.length; i += 1) expect(digits[i]).toBe(digits[i - 1]! + 1);
    for (const d of drivers) expect(d.id).toBe(`drv_${d.driverNumber.slice(2)}`);
  });

  it('keeps the secondary phone and its label on the record', async () => {
    const response = await addDriver(`${stamp}x`);
    expect(response.statusCode, response.body).toBe(201);
    const driver = response.json() as DriverRecord;
    expect(driver.secondaryPhone).toBe('+1 312 555 0199');
    expect(driver.secondaryPhoneLabel).toBe('spouse');
  });
});
