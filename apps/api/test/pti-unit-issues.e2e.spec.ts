import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PtiBoard, PtiDefect, PtiUnitIssues } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';

const BASE = '/api/v1/fleet/pti';

/**
 * The "PTI issue" sign beside a unit's status (owner, 2026-10-21): a defect not yet fixed puts it
 * on the unit; a fixed, verified or dismissed one does not. Everything this creates it leaves
 * closed, so a second run starts clean.
 */
describe('PTI unit issues (e2e)', () => {
  let app: NestFastifyApplication;
  let unitId = '';
  let unitNumber = '';
  const created: PtiDefect[] = [];

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload ? { payload } : {}) });

  const issues = async () => {
    const response = await call('GET', `${BASE}/unit-issues`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as Record<string, PtiUnitIssues>;
  };

  const ids = (map: Record<string, PtiUnitIssues>) => (map[unitId]?.defects ?? []).map((d) => d.id);

  const move = async (defect: PtiDefect, to: string, extra: Record<string, unknown> = {}) => {
    const current = (await call('GET', `${BASE}/defects/${defect.id}`)).json() as PtiDefect;
    const response = await call('POST', `${BASE}/defects/${defect.id}/transition`, { version: current.version, to, ...extra });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as PtiDefect;
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const board = (await call('GET', `${BASE}/board`)).json() as PtiBoard;
    const row = board.rows[0];
    if (!row) throw new Error('No unit on the board to test with');
    unitId = row.inspection.unitId;
    unitNumber = row.inspection.unitNumber;
  });

  afterAll(async () => {
    // Leave nothing open behind: dismiss whatever this run created and did not close.
    for (const defect of created) {
      const current = (await call('GET', `${BASE}/defects/${defect.id}`)).json() as PtiDefect;
      if (['verified', 'dismissed'].includes(current.state)) continue;
      await call('POST', `${BASE}/defects/${defect.id}/transition`, { version: current.version, to: 'dismissed', reason: 'Test clean-up' });
    }
    await app.close();
  });

  it('puts an open defect on its unit, worst first, with a line per defect', async () => {
    const response = await call('POST', `${BASE}/defects`, {
      unitId,
      component: 'brakes',
      description: 'Brake chamber leaking air on axle two',
      severity: 'replace_now',
    });
    expect(response.statusCode, response.body).toBe(201);
    const defect = response.json() as PtiDefect;
    created.push(defect);

    const map = await issues();
    const unit = map[unitId];
    expect(unit, 'the unit has PTI issues').toBeDefined();
    expect(ids(map)).toContain(defect.id);
    expect(unit?.open).toBe(unit?.defects.length);
    // Replace now is urgent unless the unit already carries an out-of-service one.
    expect(['urgent', 'oos']).toContain(unit?.worst);
    expect(unit?.summary).toContain('Brake chamber leaking air on axle two');
    // Keyed by id for the Trucks list; the number is there for the dispatch board.
    expect(unit?.unitNumber).toBe(unitNumber);
  });

  it('keeps an assigned or in-repair defect, and drops one once it is fixed', async () => {
    const defect = created[0] as PtiDefect;
    await move(defect, 'in_repair');
    expect(ids(await issues())).toContain(defect.id);

    await move(defect, 'fixed_pending_verify', { fixedVia: 'yard', note: 'Chamber replaced' });
    expect(ids(await issues())).not.toContain(defect.id);
  });

  it('keeps an out-of-service defect while it awaits verification, and drops it once verified', async () => {
    const response = await call('POST', `${BASE}/defects`, {
      unitId,
      component: 'steer_tyres',
      description: 'Steer tire cut to the cords on the sidewall',
      severity: 'oos_risk',
    });
    expect(response.statusCode, response.body).toBe(201);
    const defect = response.json() as PtiDefect;
    created.push(defect);
    expect((await issues())[unitId]?.worst).toBe('oos');

    await move(defect, 'fixed_pending_verify', { fixedVia: 'roadside', note: 'Tire replaced' });
    expect(ids(await issues())).toContain(defect.id);

    await move(defect, 'verified');
    expect(ids(await issues())).not.toContain(defect.id);
  });

  it('drops a dismissed defect', async () => {
    const response = await call('POST', `${BASE}/defects`, {
      unitId,
      component: 'lights_reflectors',
      description: 'Left marker lamp out on the trailer side',
      severity: 'monitor',
    });
    expect(response.statusCode, response.body).toBe(201);
    const defect = response.json() as PtiDefect;
    created.push(defect);
    expect(ids(await issues())).toContain(defect.id);

    await move(defect, 'dismissed', { reason: 'Reflection on the video, the lamp works' });
    expect(ids(await issues())).not.toContain(defect.id);
  });

  it('is not there when fleet_v2 is off', async () => {
    setFeatureFlagForTests('fleet_v2', false);
    try {
      expect((await call('GET', `${BASE}/unit-issues`)).statusCode).toBe(404);
    } finally {
      setFeatureFlagForTests('fleet_v2', null);
    }
  });
});
