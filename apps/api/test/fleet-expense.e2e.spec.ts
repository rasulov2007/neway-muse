import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FleetExpenseSummarySchema } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { WORKSPACE_COLLECTIONS, workspaceKey } from '@neway/shared';
import { StateService } from '../src/modules/state/state.service';

const BASE = '/api/v1/fleet/expense-summary';

/**
 * The endpoint over a workspace snapshot this test writes itself, so the assertions are about
 * attribution and the contract rather than about whatever the demo happened to contain.
 */
describe('Fleet expense summary (e2e)', () => {
  let app: NestFastifyApplication;
  let state: StateService;
  let previous: { key: string; value: string; updatedAt: string }[] = [];
  let truckId = '';
  const today = new Date().toISOString();

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    state = app.get(StateService);
    // The workspace is one row per collection; the summary reads those, so the spec writes
    // and restores them rather than the single blob they replaced.
    previous = await state.getMany(WORKSPACE_COLLECTIONS.map((name) => workspaceKey(name)));

    const trucks = await app.inject({ method: 'GET', url: '/api/v1/trucks?pageSize=1' });
    truckId = (trucks.json() as { data: Array<{ id: string }> }).data[0]?.id ?? '';
    expect(truckId).not.toBe('');

    const fixture: Record<string, unknown> = {
      repairOrders: [
        {
          id: 'ro_e2e_mine',
          roNumber: 'RO-E2E-1',
          truckId,
          status: 'completed',
          type: 'brake_repair',
          vendorName: 'E2E Shop',
          openedAt: today,
          completedAt: today,
          odometer: 1000,
          total: 640.25,
          invoices: [{ amount: 640.25, uploadedAt: today }],
        },
        {
          id: 'ro_e2e_open',
          roNumber: 'RO-E2E-2',
          truckId,
          status: 'in_shop',
          type: 'engine',
          vendorName: 'E2E Shop',
          openedAt: today,
          completedAt: null,
          odometer: 1000,
          total: 5000,
        },
        {
          id: 'ro_e2e_theirs',
          roNumber: 'RO-E2E-3',
          truckId: 'trk_not_on_this_roster',
          status: 'completed',
          type: 'engine',
          vendorName: 'Somebody Else',
          openedAt: today,
          completedAt: today,
          odometer: 1000,
          total: 99_999,
        },
      ],
      serviceRecords: [
        {
          id: 'sr_e2e_linked',
          truckId,
          type: 'brake_repair',
          description: 'Same repair, seen twice',
          doneAt: today.slice(0, 10),
          odometer: 1000,
          vendorName: 'E2E Shop',
          cost: 640.25,
          repairOrderId: 'ro_e2e_mine',
        },
      ],
      fuelTransactions: [],
    };
    for (const name of WORKSPACE_COLLECTIONS) {
      await state.put(workspaceKey(name), JSON.stringify(fixture[name] ?? []));
    }
  });

  afterAll(async () => {
    for (const name of WORKSPACE_COLLECTIONS) {
      const key = workspaceKey(name);
      const before = previous.find((row) => row.key === key);
      await state.put(key, before?.value ?? '[]');
    }
    await app.close();
  });

  it('answers a schema-valid summary computed from the workspace, attributed through the roster', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}?period=week` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = FleetExpenseSummarySchema.parse(response.json());

    expect(body.meta.period.preset).toBe('week');
    expect(body.meta.source.kind).toBe('workspace_snapshot');
    expect(body.kpis.totalSpend.value).toBe(640.25);
    // The fixture event is reported. Anything else in the list came from the work_orders table
    // this shared database also holds, which is always keyed wo_*, never a workspace repair order.
    const ids = body.events.map((e) => e.id);
    expect(ids).toContain('ro_e2e_mine');
    expect(ids.filter((id) => id !== 'ro_e2e_mine').every((id) => id.startsWith('wo_'))).toBe(true);
    expect(body.coverage.excluded.unattributedTruck).toBe(1);
    // The fixture's one unfinished order is excluded. The count also carries the server's own
    // work_orders rows, which this shared database holds and this suite must not delete.
    expect(body.coverage.excluded.notCompleted).toBeGreaterThanOrEqual(1);
    expect(body.coverage.excluded.linkedServiceRecords).toBe(1);
    expect(body.vendors.rows[0]).toMatchObject({ name: 'E2E Shop', spend: 640.25, events: 1 });
    expect(body.kpis.leaseOverage.value).toBeNull();
    expect(body.anomalies.checks.find((c) => c.rule === 'long_shop_stay')?.status).toBe(
      'unavailable',
    );
  });

  it('a chosen past week shows that whole Monday-to-Sunday week; a future one falls back to this week', async () => {
    const now = await app.inject({ method: 'GET', url: `${BASE}?period=week` });
    const current = FleetExpenseSummarySchema.parse(now.json()).meta.period;
    const lastMonday = new Date(`${current.from}T12:00:00Z`);
    lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
    const last = lastMonday.toISOString().slice(0, 10);
    const sunday = new Date(lastMonday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);

    // Any day of the week picks its week.
    const midWeek = new Date(lastMonday);
    midWeek.setUTCDate(midWeek.getUTCDate() + 3);
    const res = await app.inject({ method: 'GET', url: `${BASE}?period=week&week=${midWeek.toISOString().slice(0, 10)}` });
    expect(res.statusCode, res.body).toBe(200);
    const period = FleetExpenseSummarySchema.parse(res.json()).meta.period;
    expect(period.from).toBe(last);
    expect(period.to).toBe(sunday.toISOString().slice(0, 10));

    const future = await app.inject({ method: 'GET', url: `${BASE}?period=week&week=2099-01-05` });
    expect(FleetExpenseSummarySchema.parse(future.json()).meta.period).toMatchObject({ from: current.from, to: current.to });
    expect((await app.inject({ method: 'GET', url: `${BASE}?period=week&week=last-week` })).statusCode).toBe(422);
  });

  it('a chosen past month, quarter or year shows the whole period; the current one runs to today', async () => {
    const read = async (q: string) => FleetExpenseSummarySchema.parse((await app.inject({ method: 'GET', url: `${BASE}?${q}` })).json()).meta.period;
    expect(await read('period=month&at=2025-02-14')).toMatchObject({ from: '2025-02-01', to: '2025-02-28' });
    expect(await read('period=quarter&at=2025-05-20')).toMatchObject({ from: '2025-04-01', to: '2025-06-30' });
    expect(await read('period=year&at=2024-07-01')).toMatchObject({ from: '2024-01-01', to: '2024-12-31' });
    const current = await read('period=month');
    expect(await read('period=month&at=2099-03-01')).toMatchObject({ from: current.from, to: current.to });
  });

  it('defaults to the year, restricts to the selected units and names ids it does not know', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}?units=${truckId},trk_not_on_this_roster`,
    });
    expect(response.statusCode).toBe(200);
    const body = FleetExpenseSummarySchema.parse(response.json());
    expect(body.meta.period.preset).toBe('year');
    expect(body.meta.period.from.endsWith('-01-01')).toBe(true);
    expect(body.meta.filters.units).toEqual([truckId]);
    expect(body.meta.filters.unknownUnits).toEqual(['trk_not_on_this_roster']);
    expect(body.vehicles.rows.map((v) => v.truckId)).toEqual([truckId]);
  });

  it('refuses a period it does not offer and a company chosen through the query string', async () => {
    const bad = await app.inject({ method: 'GET', url: `${BASE}?period=decade` });
    expect(bad.statusCode).toBe(422);
    const tenant = await app.inject({ method: 'GET', url: `${BASE}?companyId=co_other` });
    expect(tenant.statusCode).toBe(400);
  });
});
