import { describe, expect, it } from 'vitest';
import { createDriver, createTruck, listDrivers, listTrucks, getTruck } from './index';
import { invalidateRoster } from './roster-api';
import { setDemoLatency } from './internals';

setDemoLatency(false);

/**
 * These tests exist because of a specific defect: a truck and a driver created through the UI came
 * back, looked saved, and were gone after a refresh. They had never left the browser.
 *
 * `invalidateRoster()` is what a refresh does to this module — it drops everything cached in the
 * tab and forces the next read to go back to the server. A record that survives that has survived
 * the thing that used to destroy it.
 */

const truckInput = {
  unitNumber: '9911',
  vin: '1XKYDP9X8KP999911',
  year: 2024,
  make: 'Peterbilt',
  model: '579',
  plate: 'TEST911',
  plateState: 'IL',
  color: 'White',
  ownership: 'owned' as const,
  odometer: 1200,
  engineHours: 40,
  inServiceDate: '2026-09-10',
  homeTerminal: 'Chicago, IL',
  status: 'available' as const,
  driverId: null,
  serviceIntervalMiles: 25_000,
  nextServiceType: 'pm_service' as const,
  nextServiceDate: '2026-12-01',
};

const driverInput = {
  firstName: 'Ada',
  lastName: 'Persistence',
  phone: '+16305550199',
  email: 'ada.persistence@example.com',
  driverType: 'company' as const,
  cdlState: 'IL',
  cdlClass: 'A' as const,
  cdlEndorsements: ['T'],
  cdlExpiresOn: '2028-04-01',
  medicalCardExpiresOn: '2027-06-15',
  hireDate: '2026-09-10',
  homeCity: 'Naperville',
  homeState: 'IL',
  dispatcherId: 'usr_004',
  payPlan: { kind: 'per_mile' as const, rate: 0.62 },
  preferredLanguage: 'en' as const,
};

describe('the roster survives the tab', () => {
  it('gives a created truck the id the server assigned, not one invented here', async () => {
    const truck = await createTruck(truckInput);
    expect(truck.id).toMatch(/^trk_/);
    expect(truck.unitNumber).toBe('9911');
    // The server decides these; a client that fills them in is guessing.
    expect(truck.nextServiceOdometer).toBe(26_200);
    expect(truck.location).toBeNull();
    expect(truck.mpg30d).toBe(0);
  });

  it('still has the truck after everything cached in the tab is thrown away', async () => {
    const truck = await createTruck(truckInput);
    invalidateRoster();
    const page = await listTrucks({ pageSize: 200, search: '9911' });
    expect(page.data.map((t) => t.id)).toContain(truck.id);
    expect(await getTruck(truck.id)).not.toBeNull();
  });

  it('still has the driver after everything cached in the tab is thrown away', async () => {
    const driver = await createDriver(driverInput);
    expect(driver.id).toMatch(/^drv_/);
    invalidateRoster();
    const page = await listDrivers({ pageSize: 200, search: 'Persistence' });
    expect(page.data.map((d) => d.id)).toContain(driver.id);
  });

  it('starts a new driver off duty with nothing verified', async () => {
    const driver = await createDriver(driverInput);
    // A date typed into a hiring form is a claim. Nothing is valid until a document is checked.
    expect(driver.status).toBe('off_duty');
    expect(driver.cdlStatus).toBe('missing');
    expect(driver.medicalCardStatus).toBe('missing');
  });

  it('reports the server refusing a duplicate unit rather than reporting success', async () => {
    await createTruck(truckInput);
    invalidateRoster();
    await expect(createTruck(truckInput)).rejects.toThrow(/already exists/i);
  });

  it('does not add the truck to the list when the server refused it', async () => {
    await createTruck(truckInput);
    invalidateRoster();
    await createTruck(truckInput).catch(() => undefined);
    invalidateRoster();
    const page = await listTrucks({ pageSize: 200, search: '9911' });
    expect(page.data.filter((t) => t.unitNumber === '9911')).toHaveLength(1);
  });
});
