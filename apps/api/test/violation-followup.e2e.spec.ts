import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CreateViolationSchema, type SafetyViolation } from '@neway/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { drivers, trucks } from '../src/database/schema/roster';
import { safetyViolations } from '../src/database/schema/safety';
import { DriverAccountsService } from '../src/modules/accounting/driver-accounts.service';
import { ViolationsService } from '../src/modules/safety/violations.service';

/**
 * Violations follow-up on the row (owner, 2026-10-13): training, the status Safety decides, the
 * charge or bonus sent to Accounting (Charged / Bonus received only once Accounting approves),
 * and the notes. Every write is version-checked and nothing is deducted on sending.
 */
describe('Violation follow-up (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let driverId = '';
  let truckId = '';
  const p = (permissions: string[]): Principal => ({ userId: 'usr_vf', userName: 'Alan Smith', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(permissions) });

  beforeAll(async () => {
    setFeatureFlagForTests('safety_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    const db = app.get(DatabaseService).db;
    const [d] = await db.select({ id: drivers.id, companyId: drivers.companyId }).from(drivers).where(isNull(drivers.archivedAt)).limit(1);
    if (!d) throw new Error('A driver is needed');
    companyId = d.companyId;
    driverId = d.id;
    const [t] = await db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.companyId, companyId))).limit(1);
    truckId = t?.id ?? '';
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const create = async () =>
    app.get(ViolationsService).createViolation(p(['safety.manage', 'safety.view']), {
      occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
      description: 'Tire air leak',
      code: '393.75A3',
      issuedTo: 'driver',
      agency: 'State Police',
      violationType: 'inspection',
      driverId,
      truckId: truckId || null,
      oos: false,
      isTest: true,
    });

  it('training, status, a charge Accounting approves, and a note', async () => {
    const svc = app.get(ViolationsService);
    const safety = p(['safety.manage', 'safety.view']);
    let v: SafetyViolation = await create();
    expect(v.status).toBe('undecided');
    expect(v.trainingStatus).toBe('pending');

    v = await svc.setTraining(safety, v.id, { version: v.version, status: 'completed', completedOn: '2026-10-13', trainerName: 'Alan Smith' });
    expect(v).toMatchObject({ trainingStatus: 'completed', trainingCompletedOn: '2026-10-13', trainerName: 'Alan Smith' });
    // A stale version is refused, never written over.
    await expect(svc.setStatus(safety, v.id, { version: v.version - 1, status: 'not_charged' })).rejects.toMatchObject({ status: 409 });

    v = await svc.sendMoney(safety, v.id, { version: v.version, kind: 'charge', amountCents: 100_000, party: 'driver', reason: 'Tire air leak' });
    expect(v).toMatchObject({ status: 'charge_pending', moneyKind: 'charge', moneyCents: 100_000, moneyTxState: 'pending' });
    // One charge with Accounting at a time.
    await expect(svc.sendMoney(safety, v.id, { version: v.version, kind: 'charge', amountCents: 5_000, party: 'driver', reason: 'Again' })).rejects.toBeTruthy();

    await app.get(DriverAccountsService).setTransactionState(p(['accounting.edit']), v.moneyTxId as string, 'approved', 'Checked');
    v = (await svc.violationDetail(safety, v.id)).record;
    expect(v.status).toBe('charged');

    v = await svc.addNote(safety, v.id, { version: v.version, body: 'Driver bilan gaplashildi. Training Friday kuni.' });
    expect(v.notes[0]).toMatchObject({ body: 'Driver bilan gaplashildi. Training Friday kuni.', by: 'Alan Smith' });
  });

  it('a bonus waits for Accounting; nothing charged with training done reads Ready to close', async () => {
    const svc = app.get(ViolationsService);
    const safety = p(['safety.manage', 'safety.view']);
    let v = await create();
    v = await svc.sendMoney(safety, v.id, { version: v.version, kind: 'bonus', amountCents: 50_000, party: 'driver', reason: 'Safe driving' });
    expect(v.status).toBe('bonus_pending');
    await app.get(DriverAccountsService).setTransactionState(p(['accounting.edit']), v.moneyTxId as string, 'approved', 'OK');
    expect((await svc.violationDetail(safety, v.id)).record.status).toBe('bonus_received');

    let w = await create();
    w = await svc.setStatus(safety, w.id, { version: w.version, status: 'not_charged' });
    expect(w.status).toBe('not_charged');
    w = await svc.setTraining(safety, w.id, { version: w.version, status: 'not_required' });
    expect(w.status).toBe('ready_to_close');
  });

  it('a warning may leave "issued to" blank; an inspection may not (owner, 2026-10-19)', async () => {
    const base = { occurredAt: new Date().toISOString(), description: 'Warning for a lamp out', oos: false };
    expect(CreateViolationSchema.safeParse({ ...base, violationType: 'warning' }).success).toBe(true);
    expect(CreateViolationSchema.safeParse({ ...base, violationType: 'inspection' }).success).toBe(false);
    const svc = app.get(ViolationsService);
    const safety = p(['safety.manage', 'safety.view']);
    const w = await svc.createViolation(safety, { ...CreateViolationSchema.parse({ ...base, violationType: 'warning' }), isTest: true });
    expect(w.issuedTo).toBeNull();
    expect(w.violationType).toBe('warning');
    // Turning it into an inspection asks who received it.
    await expect(svc.updateViolation(safety, w.id, { version: w.version, violationType: 'inspection' })).rejects.toThrow();
    const ok = await svc.updateViolation(safety, w.id, { version: w.version, violationType: 'inspection', issuedTo: 'carrier' });
    expect(ok.issuedTo).toBe('carrier');
  });

  it('"issued to" Driver and Carrier is stored as both and round-trips; single values still read (owner, 2026-10-24)', async () => {
    const svc = app.get(ViolationsService);
    const safety = p(['safety.manage', 'safety.view']);
    const both = await svc.createViolation(safety, { ...CreateViolationSchema.parse({ occurredAt: new Date().toISOString(), description: 'Brake out of adjustment', violationType: 'inspection', issuedTo: 'both', oos: false }), isTest: true });
    expect(both.issuedTo).toBe('both');
    expect((await svc.violationDetail(safety, both.id)).record.issuedTo).toBe('both');
    const db = app.get(DatabaseService).db;
    const [stored] = await db.select({ issuedTo: safetyViolations.issuedTo }).from(safetyViolations).where(eq(safetyViolations.id, both.id));
    expect(stored?.issuedTo).toBe('both');
    // Back to one party, version-checked.
    const driverOnly = await svc.updateViolation(safety, both.id, { version: both.version, issuedTo: 'driver' });
    expect(driverOnly.issuedTo).toBe('driver');
    await expect(svc.updateViolation(safety, both.id, { version: both.version, issuedTo: 'both' })).rejects.toMatchObject({ status: 409 });
    // A value written by hand in the old column (e.g. an import list) reads as both.
    await db.update(safetyViolations).set({ issuedTo: 'driver,carrier' }).where(eq(safetyViolations.id, both.id));
    expect((await svc.violationDetail(safety, both.id)).record.issuedTo).toBe('both');
  });

  it('Safety sets Charged, Bonus received and Bonus dismissed itself (owner, 2026-10-19)', async () => {
    const svc = app.get(ViolationsService);
    const safety = p(['safety.manage', 'safety.view']);
    let v = await create();
    for (const status of ['charged', 'bonus_received', 'bonus_dismissed'] as const) {
      v = await svc.setStatus(safety, v.id, { version: v.version, status });
      expect(v.status).toBe(status);
    }
  });
});
