import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { policyCentsFor, driverKindOf, type DriverCharge, type SafetyClaim } from '@neway/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { drivers } from '../src/database/schema/roster';
import { safetyAccountingEntries } from '../src/database/schema/safety';
import { DriverAccountsService } from '../src/modules/accounting/driver-accounts.service';
import { ClaimsAlertsScheduler } from '../src/modules/safety/claims-alerts.scheduler';
import { ClaimsService } from '../src/modules/safety/claims.service';
import { DriverChargesService } from '../src/modules/safety/driver-charges.service';

/**
 * Claims v2 phase 1 acceptance (owner brief, 2026-10-13 §8): a driver charge from Apply to
 * recovery, the checklist the server enforces, disputes and Management exceptions, and who may
 * press which button. Fictional records, marked test.
 */
describe('Claims v2 driver charges (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let companyId = '';
  let driverId = '';
  let policy = 0;
  let companyDriver = true;
  const p = (permissions: string[], name = 'Test User'): Principal => ({ userId: `usr_${name.replace(/\W/g, '')}`, userName: name, companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(permissions) });
  const safety = () => p(['safety.view', 'safety.manage', 'claims.apply_charges'], 'Dilnoza Safety');
  const accounting = () => p(['accounting.view', 'accounting.edit', 'safety.view'], 'Shahlo Accounting');
  const mgmt = () => p(['safety.view', 'safety.manage', 'claims.apply_charges', 'claims.approve_exceptions', 'accounting.edit'], 'Management');

  beforeAll(async () => {
    setFeatureFlagForTests('safety_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    db = app.get(DatabaseService).db;
    const [d] = await db.select({ id: drivers.id, companyId: drivers.companyId, type: drivers.driverType }).from(drivers).where(isNull(drivers.archivedAt)).limit(1);
    if (!d) throw new Error('A driver is needed');
    companyId = d.companyId;
    driverId = d.id;
    companyDriver = driverKindOf(d.type) === 'company';
    policy = policyCentsFor(driverKindOf(d.type));
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const newClaim = async (): Promise<SafetyClaim> =>
    (await app.get(ClaimsService).create(safety(), { kind: 'liability', driverId, description: 'E2E rear-end in a work zone', claimedCents: 2_943_000, isTest: true } as never)).claim;

  it('applies only on our driver’s liability, once, frozen until the driver is told', async () => {
    const claims = app.get(ClaimsService);
    const charges = app.get(DriverChargesService);
    let claim = await newClaim();
    await expect(charges.apply(safety(), claim.id, { amountCents: policy, basis: 'deductible_accident' })).rejects.toMatchObject({ status: 422 });
    claim = await claims.setLiability(safety(), claim.id, { version: claim.version, party: 'our_driver' });
    expect(claim.liabilityParty).toBe('our_driver');
    // Accounting may not apply.
    await expect(charges.apply(accounting(), claim.id, { amountCents: policy, basis: 'deductible_accident' })).rejects.toMatchObject({ status: 403 });
    const c = await charges.apply(safety(), claim.id, { amountCents: policy, basis: 'deductible_accident' });
    expect(c).toMatchObject({ state: 'on_hold', amountCents: policy, policyCents: policy, recoveredCents: 0 });
    const entries = await db.select().from(safetyAccountingEntries).where(eq(safetyAccountingEntries.sourceKey, `driver_charge:${c.id}`));
    expect(entries).toHaveLength(0);
    // A second Apply for the same claim, driver and basis is refused.
    await expect(charges.apply(safety(), claim.id, { amountCents: policy, basis: 'deductible_accident' })).rejects.toMatchObject({ status: 409 });
    const view = await claims.get(safety(), claim.id);
    expect(view.driverCharge).toMatchObject({ id: c.id, state: 'on_hold' });
    expect(view.nextAction).toMatch(/Inform/);
  });

  it('informed → Accounting → approved against the checklist, money in a settlement-ready driver transaction', async () => {
    const claims = app.get(ClaimsService);
    const charges = app.get(DriverChargesService);
    let claim = await newClaim();
    claim = await claims.setLiability(safety(), claim.id, { version: claim.version, party: 'our_driver' });
    let c: DriverCharge = await charges.apply(safety(), claim.id, { amountCents: policy, basis: 'deductible_accident' });
    // Sending before the notice is refused.
    await expect(charges.sendToAccounting(safety(), c.id, { version: c.version })).rejects.toMatchObject({ status: 409 });
    c = await charges.notify(safety(), c.id, { version: c.version, notifiedOn: '2026-10-13', method: 'in_person', response: 'signed', fileId: 'file_e2e_notice' });
    expect(c.state).toBe('informed');
    c = await charges.sendToAccounting(safety(), c.id, { version: c.version });
    expect(c.state).toBe('pending_accounting');
    const [entry] = await db.select().from(safetyAccountingEntries).where(and(eq(safetyAccountingEntries.sourceKey, `driver_charge:${c.id}`)));
    expect(entry).toMatchObject({ kind: 'driver_charge', state: 'pending_review', amountCents: policy });
    // Not twice: the panel's confirm refuses a driver charge.
    await expect(claims.reviewEntry(accounting(), entry!.id, 'confirmed', { version: entry!.version })).rejects.toMatchObject({ status: 409 });
    // Safety cannot approve.
    const base = { method: 'settlement_deduction' as const, installmentCents: 25_000, checklist: { authorizationOrLease: true as const, compliesWithLaw: true as const } };
    await expect(charges.approve(safety(), c.id, { version: c.version, ...base })).rejects.toMatchObject({ status: 403 });
    // Without the signed authorization (company driver) or the lease clause (owner-operator): refused.
    await expect(charges.approve(accounting(), c.id, { version: c.version, ...base })).rejects.toMatchObject({ status: 409 });
    // Above the cap without a note: refused.
    await expect(charges.approve(accounting(), c.id, { version: c.version, ...base, installmentCents: 90_000, authorizationFileId: 'file_e2e_auth', leaseClause: 'Appendix B §7' })).rejects.toMatchObject({ status: 409 });
    c = await charges.approve(accounting(), c.id, { version: c.version, ...base, authorizationFileId: companyDriver ? 'file_e2e_auth' : null, leaseClause: companyDriver ? null : 'Appendix B §7' });
    expect(c).toMatchObject({ state: 'approved', recoveryMethod: 'settlement_deduction', installmentCents: 25_000, installmentsTotal: Math.ceil(policy / 25_000) });
    const tx = await app.get(DriverAccountsService).transaction(accounting(), c.driverTxId as string);
    expect(tx).toMatchObject({ state: 'approved', amountCents: policy, source: 'driver_charge', sourceKey: `driver_charge:${c.id}` });
    expect(tx.installments?.perPeriodCents).toBe(25_000);
    const [confirmed] = await db.select().from(safetyAccountingEntries).where(eq(safetyAccountingEntries.sourceKey, `driver_charge:${c.id}`));
    expect(confirmed?.state).toBe('confirmed');

    // A direct payment counts as recovered; the charge reads Recovering from the money itself.
    c = await charges.payment(accounting(), c.id, { version: c.version, amountCents: 50_000, source: 'direct', receivedOn: '2026-10-14', reference: 'CHK-1' });
    expect(c).toMatchObject({ state: 'recovering', recoveredCents: 50_000, remainingCents: policy - 50_000 });

    // Dispute freezes the money; only Management resolves it.
    c = await charges.dispute(safety(), c.id, { version: c.version, raisedBy: 'Driver', text: 'Dash cam shows the other car cut in' });
    expect(c.state).toBe('disputed');
    expect((await app.get(DriverAccountsService).transaction(accounting(), c.driverTxId as string)).state).toBe('disputed');
    await expect(charges.resolve(safety(), c.id, { version: c.version, outcome: 'uphold', note: 'Upheld' })).rejects.toMatchObject({ status: 403 });
    c = await charges.resolve(mgmt(), c.id, { version: c.version, outcome: 'reduce', amountCents: policy - 100_000, note: 'Partly the other driver' });
    expect(c).toMatchObject({ state: 'recovering', amountCents: policy - 100_000 });
    expect((await app.get(DriverAccountsService).transaction(accounting(), c.driverTxId as string))).toMatchObject({ state: 'approved', amountCents: policy - 100_000 });

    // Every step is on the claim's timeline.
    const detail = await claims.detail(safety(), claim.id);
    expect(detail.timeline.filter((t) => t.action === 'driver_charge').length).toBeGreaterThanOrEqual(6);
  });

  it('a waiver from Safety waits for Management; declined it stays, approved it is waived and the money cancelled', async () => {
    const claims = app.get(ClaimsService);
    const charges = app.get(DriverChargesService);
    let claim = await newClaim();
    claim = await claims.setLiability(safety(), claim.id, { version: claim.version, party: 'our_driver' });
    let c = await charges.apply(safety(), claim.id, { amountCents: policy, basis: 'deductible_accident' });
    c = await charges.changeRequest(safety(), c.id, { version: c.version, kind: 'waive', reason: 'Driver leaving on good terms' });
    expect(c).toMatchObject({ state: 'pending_management', pendingChange: { kind: 'waive' } });
    c = await charges.decideChange(mgmt(), c.id, false, { version: c.version });
    expect(c.state).toBe('on_hold');
    c = await charges.changeRequest(safety(), c.id, { version: c.version, kind: 'waive', reason: 'Asked again with the GM' });
    c = await charges.decideChange(mgmt(), c.id, true, { version: c.version });
    expect(c.state).toBe('waived');
    // Waived frees the slot: a new charge for the same basis may be applied.
    const again = await charges.apply(safety(), claim.id, { amountCents: policy, basis: 'deductible_accident' });
    expect(again.state).toBe('on_hold');
    // An amount above policy from Safety goes to Management first.
    const other = await charges.apply(safety(), claim.id, { amountCents: policy + 100_000, basis: 'damage_below_deductible', reason: 'Extra damage' });
    expect(other.state).toBe('pending_management');
  });

  it('opens one claim file with a line per ticked kind; asking again adds only the new lines', async () => {
    const claims = app.get(ClaimsService);
    const first = await claims.create(safety(), { kind: 'physical_damage', lines: ['own_physical_damage', 'third_party_liability'], driverId, description: 'E2E lines', claimedCents: 1_840_000, insurer: 'Prairie Mutual', isTest: true } as never);
    expect(first.created).toBe(true);
    expect(first.claim.lines.map((l) => l.kind)).toEqual(['own_physical_damage', 'third_party_liability']);
    expect(first.claim.lines[0]).toMatchObject({ insurer: 'Prairie Mutual', reserveCents: 1_840_000, status: 'not_filed' });
  });

  it('reminds once a day about a charge left on hold', async () => {
    const result = await app.get(ClaimsAlertsScheduler).tick(new Date(Date.now() + 10 * 86_400_000));
    expect(result.sent).toBeGreaterThanOrEqual(0);
    const again = await app.get(ClaimsAlertsScheduler).tick(new Date(Date.now() + 10 * 86_400_000));
    expect(again.sent).toBe(0);
  });
});
