import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import type { DriverTeamRow } from '../../database/schema/roster';
import type { WriteAuditInput } from '../people/audit.service';
import type { EndTeamPatch, NewTeamRow, TeamDriver, TeamStore } from './teams.data';
import { TeamsService } from './teams.service';

/**
 * Team pairing at the service, over an in-memory store that keeps the same promises as the SQL
 * one: company-filtered reads, one open row per driver (a second raises 23505, like the unique
 * index), a version-checked end of both sides, and the audit lines written with the change.
 */
class MemoryTeamStore implements TeamStore {
  drivers_: Array<TeamDriver & { companyId: string }> = [];
  rows: DriverTeamRow[] = [];
  audits: Array<WriteAuditInput & { companyId: string }> = [];

  async driver(companyId: string, idOrNumber: string) {
    return this.drivers_.find((d) => d.companyId === companyId && (d.id === idOrNumber || d.driverNumber === idOrNumber)) ?? null;
  }
  async drivers(companyId: string, ids: readonly string[]) {
    return this.drivers_.filter((d) => d.companyId === companyId && ids.includes(d.id));
  }
  async openRows(companyId: string, driverIds?: readonly string[]) {
    return this.rows.filter((r) => r.companyId === companyId && r.endedOn === null && (!driverIds || driverIds.includes(r.driverId)));
  }
  async rowsOf(companyId: string, driverId: string) {
    return this.rows.filter((r) => r.companyId === companyId && r.driverId === driverId).sort((a, b) => b.startedOn.localeCompare(a.startedOn));
  }
  async insertPair(principal: Principal, rows: readonly [NewTeamRow, NewTeamRow], audits: readonly WriteAuditInput[]) {
    for (const r of rows) {
      if (this.rows.some((x) => x.companyId === principal.companyId && x.driverId === r.driverId && x.endedOn === null)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "driver_teams_open_key"'), { code: '23505' });
      }
    }
    for (const r of rows) this.rows.push({ ...r, companyId: principal.companyId, endedOn: null, endedBy: null, endedAt: null, endReason: null, version: 1 });
    for (const a of audits) this.audits.push({ ...a, companyId: principal.companyId });
  }
  async endPair(principal: Principal, pairId: string, sideId: string, version: number, patch: EndTeamPatch, audits: readonly WriteAuditInput[]) {
    const side = this.rows.find((r) => r.companyId === principal.companyId && r.id === sideId && r.version === version && r.endedOn === null);
    if (!side) return null;
    const open = this.rows.filter((r) => r.companyId === principal.companyId && r.pairId === pairId && r.endedOn === null);
    for (const r of open) Object.assign(r, patch, { version: version + 1, updatedAt: patch.endedAt });
    for (const a of audits) this.audits.push({ ...a, companyId: principal.companyId });
    return open;
  }
}

const principal = (companyId = 'co_1', permissions = ['drivers.edit', 'drivers.view']): Principal => ({
  userId: 'usr_1',
  userName: 'Dina Dispatch',
  companyId,
  companyTimezone: 'America/New_York',
  weekStart: 1,
  roles: [],
  permissions: new Set(permissions),
  signedIn: true,
});

const person = (id: string, first: string, last: string, over: Partial<TeamDriver & { companyId: string }> = {}) => ({
  id,
  firstName: first,
  lastName: last,
  driverNumber: id.replace('drv_', 'D-'),
  status: 'available',
  archivedAt: null,
  companyId: 'co_1',
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<{ status: number; detail: string }> {
  try {
    await p;
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, detail: error.detail ?? error.message };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('TeamsService', () => {
  let store: MemoryTeamStore;
  let service: TeamsService;
  const me = principal();

  beforeEach(() => {
    store = new MemoryTeamStore();
    store.drivers_ = [
      person('drv_a', 'Ali', 'Karimov'),
      person('drv_b', 'Bek', 'Tursunov', { status: 'driving' }),
      person('drv_c', 'Sardor', 'Aliev'),
      person('drv_t', 'Toxir', 'Gone', { status: 'terminated' }),
      person('drv_x', 'Xusan', 'Other', { companyId: 'co_2' }),
    ];
    service = new TeamsService(store);
    // 2026-10-25 23:30 Eastern is already the 26th in UTC: "today" must be the Eastern date.
    service.now = () => new Date('2026-10-26T03:30:00Z');
  });

  it('pairs two drivers symmetrically from today (Eastern), audited on both', async () => {
    const standing = await service.pair(me, 'drv_a', { partnerId: 'drv_b', note: 'Long-haul team' });
    expect(standing.today).toBe('2026-10-25');
    expect(standing.current).toMatchObject({ driverId: 'drv_a', partnerId: 'drv_b', partnerName: 'Bek Tursunov', state: 'active', startedOn: '2026-10-25', version: 1, startedBy: 'Dina Dispatch' });
    const other = await service.standing(me, 'drv_b');
    expect(other.current).toMatchObject({ driverId: 'drv_b', partnerId: 'drv_a', partnerName: 'Ali Karimov', pairId: standing.current!.pairId });
    expect(store.audits.map((a) => [a.action, a.entityId, a.companyId])).toEqual([
      ['driver_team_paired', 'drv_a', 'co_1'],
      ['driver_team_paired', 'drv_b', 'co_1'],
    ]);
    expect(store.audits[0]!.changes).toEqual([{ field: 'team', old: 'Solo', new: 'Team · with Bek Tursunov' }]);
    const list = await service.list(me);
    expect(list.teams.map((t) => `${t.driverId}>${t.partnerId}`).sort()).toEqual(['drv_a>drv_b', 'drv_b>drv_a']);
  });

  it('refuses pairing a driver who already has a partner (409), on either side', async () => {
    await service.pair(me, 'drv_a', { partnerId: 'drv_b' });
    const r1 = await refusal(service.pair(me, 'drv_c', { partnerId: 'drv_a' }));
    expect(r1).toEqual({ status: 409, detail: 'Ali Karimov is already in a team with Bek Tursunov. Unpair them first.' });
    const r2 = await refusal(service.pair(me, 'drv_b', { partnerId: 'drv_c' }));
    expect(r2.status).toBe(409);
    expect(store.rows).toHaveLength(2);
  });

  it('a race that slips past the check is still refused by the open-row index (409)', async () => {
    store.rows.push({ id: 'dtm_r', companyId: 'co_1', pairId: 'dtp_r', driverId: 'drv_c', partnerId: 'drv_z', startedOn: '2026-10-25', endedOn: null, note: null, startedBy: 'x', endedBy: null, endedAt: null, endReason: null, version: 1, createdAt: new Date(), updatedAt: new Date() });
    const realRowsOf = store.rowsOf.bind(store);
    store.rowsOf = async (companyId, driverId) => (driverId === 'drv_c' ? [] : realRowsOf(companyId, driverId));
    const r = await refusal(service.pair(me, 'drv_a', { partnerId: 'drv_c' }));
    expect(r.status).toBe(409);
    expect(r.detail).toMatch(/just put in another team/);
  });

  it('refuses self, terminated and future pairings (422)', async () => {
    expect((await refusal(service.pair(me, 'drv_a', { partnerId: 'drv_a' }))).status).toBe(422);
    expect((await refusal(service.pair(me, 'drv_a', { partnerId: 'drv_t' }))).status).toBe(422);
    expect((await refusal(service.pair(me, 'drv_a', { partnerId: 'drv_b', startedOn: '2026-10-26' }))).status).toBe(422);
  });

  it('is company-scoped: a driver of another company is not found, and its teams are not listed', async () => {
    const r = await refusal(service.pair(me, 'drv_a', { partnerId: 'drv_x' }));
    expect(r.status).toBe(404);
    await service.pair(me, 'drv_a', { partnerId: 'drv_b' });
    expect((await service.list(principal('co_2'))).teams).toEqual([]);
    expect((await refusal(service.standing(principal('co_2'), 'drv_a'))).status).toBe(404);
  });

  it('refuses writes without drivers.edit or dispatch.manage (403)', async () => {
    expect((await refusal(service.pair(principal('co_1', ['drivers.view']), 'drv_a', { partnerId: 'drv_b' }))).status).toBe(403);
    await service.pair(principal('co_1', ['dispatch.manage']), 'drv_a', { partnerId: 'drv_b' });
  });

  it('unpairs with a reason: both Solo, kept in history with dates, audited on both; stale version refused', async () => {
    const { current } = await service.pair(me, 'drv_a', { partnerId: 'drv_b', startedOn: '2026-10-01' });
    expect((await refusal(service.unpair(me, 'drv_a', current!.pairId, { version: 7, reason: 'Bek goes solo' }))).status).toBe(409);
    expect((await refusal(service.unpair(me, 'drv_a', current!.pairId, { version: 1, reason: 'too early', endedOn: '2026-09-30' }))).status).toBe(422);
    const after = await service.unpair(me, 'drv_a', current!.pairId, { version: 1, reason: 'Bek goes solo', endedOn: '2026-10-20' });
    expect(after.current).toBeNull();
    expect(after.history[0]).toMatchObject({ state: 'ended', startedOn: '2026-10-01', endedOn: '2026-10-20', endReason: 'Bek goes solo', endedBy: 'Dina Dispatch', version: 2 });
    expect((await service.standing(me, 'drv_b')).current).toBeNull();
    const unpaired = store.audits.filter((a) => a.action === 'driver_team_unpaired');
    expect(unpaired.map((a) => a.entityId)).toEqual(['drv_a', 'drv_b']);
    expect(unpaired[1]!.summary).toBe('Team with Ali Karimov split; solo from 2026-10-20: Bek goes solo');
    expect(unpaired[0]!.reason).toBe('Bek goes solo');
    // A second split of the same team is refused; the past week still reads its team.
    expect((await refusal(service.unpair(me, 'drv_b', current!.pairId, { version: 2, reason: 'again' }))).status).toBe(409);
    expect((await service.partnerOnDay(me, 'drv_a', '2026-10-10'))?.partnerId).toBe('drv_b');
    expect(await service.partnerOnDay(me, 'drv_a', '2026-10-20')).toBeNull();
  });

  it('a new team cannot start inside a past one, but may start on the first solo day', async () => {
    const { current } = await service.pair(me, 'drv_a', { partnerId: 'drv_b', startedOn: '2026-10-01' });
    await service.unpair(me, 'drv_a', current!.pairId, { version: 1, reason: 'Split up', endedOn: '2026-10-10' });
    expect((await refusal(service.pair(me, 'drv_c', { partnerId: 'drv_a', startedOn: '2026-10-05' }))).status).toBe(409);
    const next = await service.pair(me, 'drv_c', { partnerId: 'drv_a', startedOn: '2026-10-10' });
    expect(next.current?.partnerId).toBe('drv_a');
    expect((await service.standing(me, 'drv_a')).history.map((h) => h.state)).toEqual(['active', 'ended']);
  });
});
