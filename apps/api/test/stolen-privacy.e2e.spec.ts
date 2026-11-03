import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import {
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
  users,
} from '../src/database/schema/admin';
import { trailers } from '../src/database/schema/fleet';
import { auditLogs } from '../src/database/schema/people';
import { companies, trucks } from '../src/database/schema/roster';
import { hashPassword } from '../src/modules/auth/password.util';
import { StateService } from '../src/modules/state/state.service';
import { isSignedDocumentUrl, signedGet } from './authz/signed-get';

/**
 * Stolen-unit privacy (owner decision, binding), end to end on the local database.
 *
 * Only the administrator role sees a stolen unit's details. Everyone else - here an account whose
 * role holds EVERY permission but is not the administrator role - sees the word "Stolen" and the
 * status: no narrative, police report, place, claim, contents, location, documents or audit text.
 * A non-admin writing the redacted copy back never wipes what the administrator recorded.
 *
 * Everything lives in a TEST company of its own (`co_e2e_stolen_*`), so no other company's
 * workspace rows are read or written. Nothing is deleted afterwards (test data is kept).
 */
describe('Stolen-unit privacy (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let state: StateService;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const companyId = `co_e2e_stolen_${stamp}`;
  const truckId = `trk_e2e_stolen_${stamp}`;
  const trailerId = `trl_e2e_stolen_${stamp}`;
  const otherTruckId = `trk_e2e_sold_${stamp}`;
  const password = `Stolen-e2e-${stamp}!`;
  let adminToken = '';
  let staffToken = '';

  // The details only an administrator may read. Every one must be absent for anyone else.
  const SECRETS = {
    narrative: `NARRATIVE-${stamp} taken overnight from the yard`,
    police: `POLICE-${stamp}`,
    place: `STOLENFROM-${stamp}`,
    claim: `CLAIM-${stamp}`,
    contents: `CONTENTS-${stamp}`,
    trailerNarrative: `TRAILERSTORY-${stamp}`,
    city: `SECRETCITY${stamp}`,
    auditText: `AUDITTEXT-${stamp}`,
    document: `DOCTITLE-${stamp}`,
    recordedBy: `RECORDER${stamp}`,
    note: `UNITNOTE-${stamp} tracker says it is in a barn`,
  };
  const leaks = (body: string): string[] =>
    Object.values(SECRETS).filter((secret) => body.includes(secret));

  const now = Date.now();
  const exitAt = new Date(now - 60_000).toISOString();
  const today = exitAt.slice(0, 10);

  const stolenTruckExit = {
    id: `exit_truck_${stamp}`,
    entity: 'truck',
    unitId: truckId,
    unitNumber: `S${stamp}`.slice(0, 20),
    toStatus: 'inactive',
    fromStatus: 'available',
    occurredOn: today,
    reason: 'stolen',
    narrative: SECRETS.narrative,
    odometer: 412_000,
    salePrice: null,
    buyer: null,
    titleTransferred: null,
    policeReport: SECRETS.police,
    stolenFrom: SECRETS.place,
    recovered: false,
    contents: [{ label: SECRETS.contents, value: 18_000, recovered: false }],
    damage: [],
    injuries: null,
    driverId: null,
    driverName: null,
    loadNumber: null,
    insuranceClaimNumber: SECRETS.claim,
    insuredValue: 95_000,
    deductible: 2_500,
    expectedRecovery: 80_000,
    recordedById: 'usr_x',
    recordedByName: SECRETS.recordedBy,
    createdAt: exitAt,
  };
  const stolenTrailerExit = {
    ...stolenTruckExit,
    id: `exit_trailer_${stamp}`,
    entity: 'trailer',
    unitId: trailerId,
    unitNumber: `T${stamp}`.slice(0, 20),
    narrative: SECRETS.trailerNarrative,
  };
  const soldExit = {
    ...stolenTruckExit,
    id: `exit_sold_${stamp}`,
    unitId: otherTruckId,
    unitNumber: `O${stamp}`.slice(0, 20),
    reason: 'sold',
    narrative: 'Sold to a dealer in Ohio',
    policeReport: null,
    stolenFrom: null,
    contents: [],
    insuranceClaimNumber: null,
    recordedByName: 'Somebody',
    salePrice: 40_000,
  };
  const auditStolen = {
    id: 'aud_0002',
    at: exitAt,
    actorId: 'usr_x',
    actorName: 'Admin',
    action: 'status_changed',
    entity: { type: 'truck', id: truckId, label: 'Unit S' },
    subject: 'Status',
    before: 'Available',
    after: 'Inactive',
    reason: `stolen: ${SECRETS.narrative}`,
    source: 'user',
  };
  const auditOther = {
    ...auditStolen,
    id: 'aud_0001',
    at: '2026-01-05T12:00:00.000Z',
    entity: { type: 'truck', id: otherTruckId, label: 'Unit O' },
    reason: 'Sold to a dealer',
  };

  const call = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    token: string,
    payload?: unknown,
  ) =>
    method === 'GET' && isSignedDocumentUrl(url) ? signedGet(app, `/api/v1${url}`, { authorization: `Bearer ${token}` }) : app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function account(label: string, roleId: string): Promise<string> {
    const userId = `usr_e2e_stolen_${label}_${stamp}`;
    const membershipId = `mem_e2e_stolen_${label}_${stamp}`;
    const email = `stolen.${label}.${stamp}@test.local`;
    await db.insert(users).values({
      id: userId,
      email,
      firstName: 'Stolen',
      lastName: label,
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
    });
    // profileCompletedAt: past Complete your profile (2026-10-26), as an existing account would be.
    await db.insert(memberships).values({ id: membershipId, companyId, userId, status: 'active', profileCompletedAt: new Date() });
    await db.insert(membershipRoles).values({ membershipId, roleId });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode, login.body).toBe(201);
    return (login.json() as { token: string }).token;
  }

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    state = app.get(StateService);

    await db.insert(companies).values({ id: companyId, name: `E2E Stolen privacy ${stamp}` });

    // A role with every permission in the registry - but not the administrator role.
    const everything = await db.select({ code: permissions.code }).from(permissions);
    const staffRoleId = `rol_e2e_stolen_${stamp}`;
    await db.insert(roles).values({
      id: staffRoleId,
      companyId,
      code: `e2e_everything_${stamp}`,
      name: `Everything but administrator ${stamp}`,
    });
    await db.insert(rolePermissions).values(everything.map((p) => ({ roleId: staffRoleId, permissionCode: p.code })));
    const [adminRole] = await db.select().from(roles).where(eq(roles.id, 'rol_administrator'));
    expect(adminRole?.code).toBe('administrator');

    adminToken = await account('admin', 'rol_administrator');
    staffToken = await account('staff', staffRoleId);

    const truckRow = (id: string, unitNumber: string) => ({
      id,
      companyId,
      unitNumber,
      vin: `1E2E${stamp}${id.length}`.toUpperCase().replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17),
      year: 2021,
      make: 'E2E',
      model: 'Stolen',
      status: 'inactive',
      health: 'healthy',
      ownership: 'owned',
      odometer: 412_000,
      odometerAt: new Date(),
      engineHours: '0',
      nextServiceOdometer: 425_000,
      nextServiceDate: '2027-01-01',
      nextServiceType: 'pm_service',
      telematicsProvider: 'samsara',
      telematicsStatus: 'connected',
      location: {
        lat: 41.6,
        lng: -87.3,
        city: SECRETS.city,
        state: 'IN',
        updatedAt: new Date().toISOString(),
        speedMph: 61,
        engineState: 'on',
      },
    });
    await db.insert(trucks).values([
      truckRow(truckId, stolenTruckExit.unitNumber),
      {
        ...truckRow(otherTruckId, soldExit.unitNumber),
        vin: '1E2E0THER0000000S'.slice(0, 17),
        location: { lat: 40, lng: -83, city: 'Columbus', state: 'OH', updatedAt: new Date().toISOString(), speedMph: 0, engineState: 'off' },
      },
    ]);
    await db.insert(trailers).values({
      id: trailerId,
      companyId,
      unitNumber: stolenTrailerExit.unitNumber,
      status: 'inactive',
    });

    // The workspace rows the browser writes when a unit is recorded stolen.
    await state.putFor(companyId, 'ws2-unitexits', JSON.stringify([stolenTruckExit, stolenTrailerExit, soldExit]));
    await state.putFor(companyId, 'ws2-complianceaudit', JSON.stringify([auditStolen, auditOther]));
    // Notes on the unit: one from before the theft (readable), one after it (restricted).
    await state.putFor(
      companyId,
      'ws2-trucknotes',
      JSON.stringify([
        { id: `tnote_after_${stamp}`, truckId, body: SECRETS.note, authorName: 'Admin', at: new Date(now).toISOString() },
        { id: `tnote_before_${stamp}`, truckId, body: 'APU rattles', authorName: 'Ops', at: '2026-01-02T12:00:00.000Z' },
      ]),
    );

    // audit_logs: one line from before the theft (stays readable), one after (restricted).
    await db.insert(auditLogs).values([
      {
        id: `aud_e2e_stolen_before_${stamp}`,
        companyId,
        at: new Date('2026-01-02T12:00:00Z'),
        actorName: 'Admin',
        action: 'updated',
        entityType: 'truck',
        entityId: truckId,
        entityLabel: 'Unit S',
        summary: 'Odometer corrected in January',
      },
      {
        id: `aud_e2e_stolen_after_${stamp}`,
        companyId,
        at: new Date(now),
        actorName: 'Admin',
        action: 'updated',
        entityType: 'truck',
        entityId: truckId,
        entityLabel: 'Unit S',
        summary: `Last seen at ${SECRETS.auditText}`,
        reason: SECRETS.auditText,
        changes: [{ field: 'location', old: null, new: SECRETS.auditText }],
      },
    ]);

    // A document on the stolen trailer, uploaded by the administrator.
    const uploaded = await call('POST', '/compliance/documents', adminToken, {
      ownerType: 'trailer',
      ownerId: trailerId,
      ownerLabel: `Trailer ${stolenTrailerExit.unitNumber}`,
      requirementCode: 'trailer_registration',
      title: SECRETS.document,
      fileName: 'registration.pdf',
      contentType: 'application/pdf',
      sizeBytes: 16,
      issuedOn: today,
      expiresOn: '2027-06-30',
      source: 'staff',
      content: Buffer.from(`%PDF-1.4 ${SECRETS.document}`).toString('base64'),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
  });

  afterAll(async () => {
    await app.close();
  });

  const documentId = async (): Promise<string> => {
    const res = await call('GET', `/compliance/documents?ownerType=trailer&ownerId=${trailerId}`, adminToken);
    const [doc] = res.json() as { id: string }[];
    if (!doc) throw new Error('the administrator should see the trailer document');
    return doc.id;
  };

  it('workspace reads: a non-admin gets "stolen" and the status, nothing else', async () => {
    const many = await call('GET', '/state?keys=ws2-unitexits,ws2-complianceaudit', staffToken);
    expect(many.statusCode, many.body).toBe(200);
    expect(leaks(many.body)).toEqual([]);
    const rows = many.json() as { key: string; value: string }[];
    const exits = JSON.parse(rows.find((r) => r.key === 'ws2-unitexits')!.value) as Record<string, unknown>[];
    const truck = exits.find((e) => e.id === stolenTruckExit.id)!;
    expect(truck).toMatchObject({ reason: 'stolen', toStatus: 'inactive', unitId: truckId, redacted: true });
    expect(truck.narrative).toBe('');
    expect(truck.contents).toEqual([]);
    // A unit that was not stolen keeps its account.
    expect(exits.find((e) => e.id === soldExit.id)).toMatchObject({ narrative: soldExit.narrative, salePrice: 40_000 });
    const audit = JSON.parse(rows.find((r) => r.key === 'ws2-complianceaudit')!.value) as Record<string, unknown>[];
    expect(audit.find((a) => a.id === 'aud_0002')).toMatchObject({ reason: null, before: null, after: null, redacted: true });
    expect(audit.find((a) => a.id === 'aud_0001')).toMatchObject({ reason: 'Sold to a dealer' });

    const one = await call('GET', '/state/ws2-unitexits', staffToken);
    expect(one.statusCode).toBe(200);
    expect(leaks(one.body)).toEqual([]);
    const audits = await call('GET', '/state/ws2-complianceaudit', staffToken);
    expect(leaks(audits.body)).toEqual([]);
    const notes = await call('GET', '/state/ws2-trucknotes', staffToken);
    expect(notes.statusCode).toBe(200);
    expect(leaks(notes.body)).toEqual([]);
    const noteRows = JSON.parse((notes.json() as { value: string }).value) as Record<string, unknown>[];
    expect(noteRows.find((n) => n.id === `tnote_after_${stamp}`)).toMatchObject({ redacted: true });
    expect(noteRows.find((n) => n.id === `tnote_before_${stamp}`)).toMatchObject({ body: 'APU rattles' });
    // A non-admin saving the notes back keeps the administrator's note.
    const putNotes = await call('PUT', '/state/ws2-trucknotes', staffToken, { value: JSON.stringify(noteRows) });
    expect(putNotes.statusCode).toBe(200);
    const storedNotes = JSON.parse((await state.getFor(companyId, 'ws2-trucknotes'))!.value) as Record<string, unknown>[];
    expect(storedNotes.find((n) => n.id === `tnote_after_${stamp}`)).toMatchObject({ body: SECRETS.note });
  });

  it('the administrator reads every detail', async () => {
    const many = await call('GET', '/state?keys=ws2-unitexits,ws2-complianceaudit', adminToken);
    expect(many.statusCode).toBe(200);
    for (const secret of [SECRETS.narrative, SECRETS.police, SECRETS.place, SECRETS.claim, SECRETS.contents, SECRETS.recordedBy]) {
      expect(many.body).toContain(secret);
    }
    const truck = await call('GET', `/trucks/${truckId}`, adminToken);
    expect(truck.body).toContain(SECRETS.city);
    const docs = await call('GET', `/compliance/documents?ownerType=trailer&ownerId=${trailerId}`, adminToken);
    expect((docs.json() as unknown[]).length).toBe(1);
    const log = await call('GET', `/admin/audit?entityId=${truckId}`, adminToken);
    expect(log.body).toContain(SECRETS.auditText);
  });

  it('trucks and trailers: no location for a stolen truck, list, detail and search alike', async () => {
    for (const url of [
      `/trucks?includeInactive=true&pageSize=200`,
      `/trucks?includeInactive=true&search=${encodeURIComponent(stolenTruckExit.unitNumber)}`,
      `/trucks/${truckId}`,
      `/trailers?includeInactive=true&pageSize=200`,
      `/trailers/${trailerId}`,
    ]) {
      const res = await call('GET', url, staffToken);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
      expect(leaks(res.body), url).toEqual([]);
    }
    const detail = (await call('GET', `/trucks/${truckId}`, staffToken)).json() as { location: unknown; status: string };
    expect(detail.location).toBeNull();
    expect(detail.status).toBe('inactive');
    // A truck that was not stolen keeps its position for everyone.
    const other = (await call('GET', `/trucks/${otherTruckId}`, staffToken)).json() as { location: { city: string } | null };
    expect(other.location?.city).toBe('Columbus');
  });

  it("documents: a stolen unit's list is empty and its file is not found for a non-admin", async () => {
    const id = await documentId();
    const list = await call('GET', `/compliance/documents?ownerType=trailer&ownerId=${trailerId}`, staffToken);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
    const all = await call('GET', '/compliance/documents', staffToken);
    expect(leaks(all.body)).toEqual([]);
    expect((await call('GET', `/compliance/documents/${id}/file`, staffToken)).statusCode).toBe(404);
    expect((await call('GET', `/compliance/documents/${id}/file`, adminToken)).statusCode).toBe(200);
  });

  it('audit trail: lines about the unit after the theft read "Restricted (stolen unit)"', async () => {
    const list = await call('GET', `/admin/audit?entityId=${truckId}&pageSize=200`, staffToken);
    expect(list.statusCode, list.body).toBe(200);
    expect(leaks(list.body)).toEqual([]);
    const entries = (list.json() as { data: { id: string; summary: string; reason: string | null; changes: unknown[] }[] }).data;
    expect(entries.find((e) => e.id === `aud_e2e_stolen_after_${stamp}`)).toMatchObject({
      summary: 'Restricted (stolen unit)',
      reason: null,
      changes: [],
    });
    expect(entries.find((e) => e.id === `aud_e2e_stolen_before_${stamp}`)?.summary).toBe('Odometer corrected in January');

    const single = await call('GET', `/admin/audit/aud_e2e_stolen_after_${stamp}`, staffToken);
    expect(single.statusCode).toBe(200);
    expect(leaks(single.body)).toEqual([]);
    const everything = await call('GET', '/admin/audit?pageSize=200', staffToken);
    expect(leaks(everything.body)).toEqual([]);
    const csv = await call('GET', '/admin/audit/export', staffToken);
    expect(csv.statusCode).toBe(200);
    expect(leaks(csv.body)).toEqual([]);
    expect(csv.body).toContain('Restricted (stolen unit)');
    // The document upload on the stolen trailer was audited after the theft.
    const compliance = await call('GET', `/compliance/audit?entityId=${trailerId}`, staffToken);
    expect(compliance.statusCode, compliance.body).toBe(200);
    expect(leaks(compliance.body)).toEqual([]);
    const complianceAdmin = await call('GET', `/compliance/audit?entityId=${trailerId}`, adminToken);
    expect(complianceAdmin.body).toContain(SECRETS.document);
  });

  it('reports and analytics that list units carry none of it', async () => {
    for (const reportKey of ['truck_profitability', 'fleet_utilization', 'maintenance_cost']) {
      const res = await call('POST', '/reports/run', staffToken, { reportKey, preset: 'this_month' });
      expect([200, 201], `${reportKey} ${res.body}`).toContain(res.statusCode);
      expect(leaks(res.body), reportKey).toEqual([]);
    }
    const ranking = await call('GET', '/analytics/trucks', staffToken);
    expect(leaks(ranking.body)).toEqual([]);
    const board = await call('GET', '/fleet/pm/board', staffToken);
    expect(leaks(board.body)).toEqual([]);
  });

  it("a non-admin writing the redacted copy back keeps the administrator's details", async () => {
    const read = await call('GET', '/state/ws2-unitexits', staffToken);
    const { value, updatedAt } = read.json() as { value: string; updatedAt: string };
    const held = JSON.parse(value) as Record<string, unknown>[];
    // The browser edits something else, drops the trailer record and files a new stolen unit.
    const filed = { ...soldExit, id: `exit_new_${stamp}`, unitId: `trk_new_${stamp}`, reason: 'stolen', narrative: 'Filed by staff' };
    const next = [filed, ...held.filter((row) => row.id !== stolenTrailerExit.id)];
    const put = await call('PUT', '/state/ws2-unitexits', staffToken, { value: JSON.stringify(next), ifUnchangedSince: updatedAt });
    expect(put.statusCode, put.body).toBe(200);

    const stored = JSON.parse((await state.getFor(companyId, 'ws2-unitexits'))!.value) as Record<string, unknown>[];
    expect(stored.find((r) => r.id === stolenTruckExit.id)).toEqual(stolenTruckExit);
    expect(stored.find((r) => r.id === stolenTrailerExit.id)).toEqual(stolenTrailerExit);
    expect(stored.find((r) => r.id === filed.id)).toEqual(filed);
    expect(stored.some((r) => r.redacted === true)).toBe(false);

    const auditRead = (await call('GET', '/state/ws2-complianceaudit', staffToken)).json() as { value: string };
    const auditPut = await call('PUT', '/state/ws2-complianceaudit', staffToken, { value: auditRead.value });
    expect(auditPut.statusCode).toBe(200);
    const storedAudit = JSON.parse((await state.getFor(companyId, 'ws2-complianceaudit'))!.value) as Record<string, unknown>[];
    expect(storedAudit.find((a) => a.id === 'aud_0002')).toEqual(auditStolen);

    // A stale write is still refused, merge or not.
    const stale = await call('PUT', '/state/ws2-unitexits', staffToken, { value: '[]', ifUnchangedSince: '2000-01-01T00:00:00.000Z' });
    expect(stale.statusCode).toBe(409);
  });
});
