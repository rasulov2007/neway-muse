import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SYSTEM_ROLES, accidentsV2 as A } from '@neway/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, membershipRoles, users } from '../src/database/schema/admin';
import { companies } from '../src/database/schema/roster';
import { AccidentsV2Controller } from '../src/modules/safety/accidents-v2/accidents-v2.controller';
import { ClaimsV2Service } from '../src/modules/safety/accidents-v2/claims-v2.service';
import { loadAccidentFixtures } from './fixtures/accidents-v2-fixtures';

/**
 * Accident & Claims v2 go-live (IMPLEMENTATION-PLAN §17): the Accidents settings screen's endpoints (item 8).
 * A fictional TEST company per run.
 */
const RUN = Date.now().toString(36);
const CO = `co_acc2_gl_${RUN}`;
const permsOf = (role: string) => SYSTEM_ROLES.find((r) => r.code === role)?.permissions ?? [];
const as = (role: string, userId = `usr_acc2_gl_${role}`, userName = `Test ${role}`): Principal => ({
  userId,
  userName,
  companyId: CO,
  companyTimezone: 'America/New_York',
  weekStart: 1,
  roles: [role],
  permissions: new Set(permsOf(role)),
});
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; detail: string };
  }
  throw new Error('expected a refusal');
};

describe('Accident & Claims v2 — go-live: Accidents settings (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let acc: AccidentsV2Controller;
  const SM = as('safety_manager', 'usr_acc2_gl_sm', 'Gina Safety');

  beforeAll(async () => {
    setFeatureFlagForTests('accidents_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    db = app.get(DatabaseService).db;
    acc = app.get(AccidentsV2Controller);
    await loadAccidentFixtures(db, { company: CO, prefix: `gl${RUN}_` });
    await db.update(companies).set({ name: `Accidents v2 go-live run ${RUN} (TEST, fictional)` }).where(eq(companies.id, CO));
    for (const [uid, first] of [['usr_acc2_gl_sm', 'Gina'], ['usr_acc2_gl_claims', 'Clara']] as const) {
      await db.insert(users).values({ id: uid, email: `${uid}@acc2.test`, firstName: first, lastName: 'Test' }).onConflictDoNothing();
      await db.insert(memberships).values({ id: `mem_${uid}_${RUN}`, companyId: CO, userId: uid, status: 'active' }).onConflictDoNothing();
      await db.insert(membershipRoles).values({ membershipId: `mem_${uid}_${RUN}`, roleId: 'rol_safety_manager' }).onConflictDoNothing();
    }
  }, 120_000);

  afterAll(async () => {
    setFeatureFlagForTests('accidents_v2', null);
    await app.close();
  });

  it('reads the defaults: no assignees, no insurers, SPEC deductibles, the $640 fallback shown read-only', async () => {
    const s = await acc.getSettings(SM);
    expect(s.version).toBeNull();
    expect(Object.values(s.deptAssignees).every((x) => x === null)).toBe(true);
    expect(Object.keys(s.deptAssignees)).toEqual([...A.DEPTS]);
    expect(Object.values(s.insurers).every((x) => x === '')).toBe(true);
    expect(s.deductibles).toEqual({ physicalDamageDeductibleCents: 500_000, autoLiabilityDeductibleCents: 250_000, cargoDeductibleCents: 250_000 });
    expect(s.fallbackDailyContributionCents).toBe(64_000);
    expect(s.canEdit).toBe(true);
    expect(s.people.map((x) => x.id)).toEqual(expect.arrayContaining(['usr_acc2_gl_sm', 'usr_acc2_gl_claims']));
  });

  it('Safety saves assignees, insurers and a deductible (one audit entry); the claims service uses them; a stale save is 409', async () => {
    const before = await acc.getSettings(SM);
    const saved = await acc.putSettings(SM, {
      version: before.version,
      deptAssignees: { Claims: 'usr_acc2_gl_claims', Safety: 'usr_acc2_gl_sm' },
      insurers: { physical_damage: 'Prairie Mutual', auto_liability: 'Great Plains Casualty' },
      deductibles: { physicalDamageDeductibleCents: 750_000 },
    });
    expect(saved.deptAssignees.Claims).toEqual({ id: 'usr_acc2_gl_claims', name: 'Clara Test' });
    expect(saved.insurers.physical_damage).toBe('Prairie Mutual');
    expect(saved.deductibles.physicalDamageDeductibleCents).toBe(750_000);
    expect(saved.version).not.toBeNull();
    const audits = (await db.execute(sql`select summary, changes from audit_logs where company_id = ${CO} and action = 'accident_settings_updated'`)) as unknown as Array<{ summary: string; changes: { field: string }[] }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.changes.map((c) => c.field).sort()).toEqual(['claimInsurer.auto_liability', 'claimInsurer.physical_damage', 'deptDefaultAssignee.Claims', 'deptDefaultAssignee.Safety', 'physicalDamageDeductibleCents']);
    // The stale version (before the save) is refused, nothing written.
    expect((await err(acc.putSettings(SM, { version: before.version, insurers: { cargo: 'X' } }))).status).toBe(409);
    // The claims service reads the same rows: a new standalone PD claim gets the insurer and the new deductible.
    const created = await app.get(ClaimsV2Service).create(SM, { standaloneKind: 'Other loss', title: 'Go-live settings check', isTest: true, lines: [{ type: 'physical_damage' }] } as never);
    const detail = await app.get(ClaimsV2Service).detail(SM, created.created[0]!.id);
    expect([detail.claim.insurer, detail.claim.deductibleCents]).toEqual(['Prairie Mutual', 750_000]);
    // Clearing an assignee and an insurer removes them.
    const cleared = await acc.putSettings(SM, { version: saved.version, deptAssignees: { Safety: null }, insurers: { auto_liability: '' } });
    expect([cleared.deptAssignees.Safety, cleared.insurers.auto_liability, cleared.deptAssignees.Claims?.name]).toEqual([null, '', 'Clara Test']);
  });

  it('only Safety Managers and the owner save; editors read; a person outside the company is refused', async () => {
    const ops = as('operations_manager');
    const read = await acc.getSettings(ops);
    expect(read.canEdit).toBe(false);
    expect((await err(app.get(AccidentsV2Controller).putSettings(ops, { version: read.version, insurers: { cargo: 'X' } }))).status).toBe(403);
    expect((await err(acc.putSettings(SM, { version: read.version, deptAssignees: { Fleet: 'usr_not_in_company' } }))).status).toBe(422);
    expect(SYSTEM_ROLES.filter((r) => r.permissions.includes('accidents.override')).map((r) => r.code).sort()).toEqual(['administrator', 'safety_manager']);
  });

  it('only Dispatch confirms Dispatch requests: accidents.confirm is Dispatch lead (and owner) only, never the Operations Manager', () => {
    expect(SYSTEM_ROLES.filter((r) => r.permissions.includes('accidents.confirm')).map((r) => r.code).sort()).toEqual(['administrator', 'dispatch_lead']);
  });
});
