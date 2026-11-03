import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  DashboardDataHealthSchema,
  DashboardDispatchSchema,
  DashboardDrilldownSchema,
  DashboardFuelSchema,
  DashboardOpsNetSchema,
  DashboardOverviewSchema,
  DashboardTrendsSchema,
  DashboardTruckPnlSchema,
  OpsNetCostsSchema,
  ProblemDetailsSchema,
} from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';

const BASE = '/api/v1/dashboard';

describe('Dashboard API (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // These assertions describe the deterministic demo book — one week deliberately without
    // expense data, a known reconciliation total. The dashboard normally reports the workspace's
    // own loads, which change as somebody uses the app, so the generated source is pinned here.
    process.env.REPORTING_SOURCE = 'generated';
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.REPORTING_SOURCE;
    await app.close();
  });

  it('GET overview as admin returns 200 with a schema-valid, unmasked body', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/overview?period=last_week` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, max-age=30');
    const body = DashboardOverviewSchema.parse(response.json());
    expect(body.meta.source).toBe('demo');
    expect(body.meta.period.preset).toBe('last_week');
    expect(body.financial.gross.masked).toBe(false);
    expect(body.financial.gross.value).toBeGreaterThan(0);
    expect(body.reconciliation.status).toBe('ok');
  });

  it('every section returns 200 and validates against its contract', async () => {
    const sections = [
      ['trends', DashboardTrendsSchema],
      ['ops-net', DashboardOpsNetSchema],
      ['truck-pnl', DashboardTruckPnlSchema],
      ['fuel', DashboardFuelSchema],
      ['dispatch-performance', DashboardDispatchSchema],
      ['data-health', DashboardDataHealthSchema],
    ] as const;
    for (const [path, schema] of sections) {
      const response = await app.inject({ method: 'GET', url: `${BASE}/${path}?period=last_week` });
      expect(response.statusCode, path).toBe(200);
      expect(schema.safeParse(response.json()).success, path).toBe(true);
    }
    const drilldown = await app.inject({
      method: 'GET',
      url: `${BASE}/drilldown?metric=gross&period=last_week`,
    });
    expect(drilldown.statusCode).toBe(200);
    expect(DashboardDrilldownSchema.parse(drilldown.json()).rows.length).toBeGreaterThan(0);
  });

  it('executive gets masked money and the admin gross value appears nowhere in the body', async () => {
    const admin = await app.inject({ method: 'GET', url: `${BASE}/overview?period=last_week` });
    const adminGross = DashboardOverviewSchema.parse(admin.json()).financial.gross.value;
    expect(adminGross).not.toBeNull();

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/overview?period=last_week`,
      headers: { 'x-demo-role': 'executive' },
    });
    expect(response.statusCode).toBe(200);
    const body = DashboardOverviewSchema.parse(response.json());
    expect(body.financial.gross).toMatchObject({ value: null, masked: true });
    expect(body.financial.cost.masked).toBe(true);
    expect(body.unitEconomics.rpm.masked).toBe(true);
    expect(body.fleet.activeTrucks.value).not.toBeNull();
    expect(response.body).not.toContain(String(adminGross));
  });

  it('executive truck-pnl masks gross, cost and profit columns', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/truck-pnl?period=last_week&pageSize=20`,
      headers: { 'X-Demo-Role': 'executive' },
    });
    expect(response.statusCode).toBe(200);
    const body = DashboardTruckPnlSchema.parse(response.json());
    expect(body.masked).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(row.gross).toBeNull();
      expect(row.cost).toBeNull();
      expect(row.profit).toBeNull();
      expect(row.costEstimated).toBeNull();
    }
    expect(body.totals.gross).toBeNull();
    expect(body.totals.trucks).toBeGreaterThan(0);
  });

  it('ops-net as admin returns per-category costs, unit economics and a reconciling total', async () => {
    const [overviewResponse, response] = await Promise.all([
      app.inject({ method: 'GET', url: `${BASE}/overview?period=last_week` }),
      app.inject({ method: 'GET', url: `${BASE}/ops-net?period=last_week` }),
    ]);
    expect(response.statusCode).toBe(200);
    const overview = DashboardOverviewSchema.parse(overviewResponse.json());
    const body = DashboardOpsNetSchema.parse(response.json());

    expect(body.totals.label).toBe('Total');
    expect(body.totals.gross).toBe(overview.financial.gross.value);
    expect(body.totals.totalCost).toBe(overview.financial.cost.value);
    expect(body.totals.activeTrucks).toBe(overview.fleet.activeTrucks.value);
    expect(body.inactiveTruckLoss).toBe(overview.financial.inactiveTruckLoss.value);
    expect(body.netOperatingProfit).toBe(overview.financial.netOperatingProfit.value);

    const company = body.buckets.find((b) => b.payType === 'company');
    expect(company).toBeDefined();
    // Every cost category the contract names is reported, so adding one cannot go unnoticed.
    expect(Object.keys(company?.costs ?? {})).toHaveLength(
      Object.keys(OpsNetCostsSchema.shape).length,
    );
    expect(company?.rpm).not.toBeNull();
    expect(company?.avgGrossPerTruck).not.toBeNull();
    expect(company?.avgMilesPerTruck).not.toBeNull();
  });

  it('trends as admin returns ppm, truck counts and a pay-type split per week', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/trends?period=last_week` });
    expect(response.statusCode).toBe(200);
    const body = DashboardTrendsSchema.parse(response.json());
    expect(body.weeks).toHaveLength(8);
    for (const week of body.weeks) {
      const split = week.activeByPayType;
      expect(split).not.toBeNull();
      if (split === null) continue;
      expect(Object.values(split).reduce((acc, n) => acc + n, 0)).toBe(week.activeTrucks);
    }
    const latest = body.weeks.at(-1);
    expect(latest?.ppm).not.toBeNull();
    expect(latest?.totalMiles).not.toBeNull();
    expect(latest?.avgProfitPerTruck).not.toBeNull();
  });

  it('trends as admin returns a summary rolling the window up against the previous one', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/trends?period=last_week` });
    expect(response.statusCode).toBe(200);
    const body = DashboardTrendsSchema.parse(response.json());
    const summary = body.summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;

    expect(summary.window).toEqual({
      from: body.weeks[0]?.weekStart,
      to: body.weeks.at(-1)?.weekEnd,
      weeks: body.weeks.length,
    });
    expect(summary.previousWindow.weeks).toBe(body.weeks.length);
    expect(summary.previousWindow.to < summary.window.from).toBe(true);

    // Gross is a plain sum, so the window rollup agrees with the weeks it covers.
    const weekGross = body.weeks.reduce((acc, week) => acc + (week.gross ?? 0), 0);
    expect(summary.gross.value).toBe(Math.round(weekGross * 100) / 100);
    expect(summary.gross.previous).not.toBeNull();
    expect(summary.gross.deltaPct).not.toBeNull();
    expect(summary.gross.masked).toBe(false);
    expect(summary.activeTrucks.value).toBeGreaterThan(0);

    // The demo window holds one week with revenue but no expense data; the rollup discloses it.
    expect(summary.expenseCoverage).toEqual({ weeks: body.weeks.length, weeksWithData: 7 });
    expect(body.weeks.filter((week) => week.hasExpenseData)).toHaveLength(7);
  });

  it('executive trends summary is masked and holds none of the admin summary money', async () => {
    const adminBody = DashboardTrendsSchema.parse(
      (await app.inject({ method: 'GET', url: `${BASE}/trends?period=last_week` })).json(),
    );
    const adminSummary = adminBody.summary;
    expect(adminSummary).not.toBeNull();
    if (adminSummary === null) return;
    const adminMoney = [adminSummary.gross, adminSummary.cost, adminSummary.profit]
      .flatMap((metric) => [metric.value, metric.previous, metric.delta])
      .filter((value): value is number => value !== null && value !== 0);
    expect(adminMoney.length).toBe(9);

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/trends?period=last_week`,
      headers: { 'X-Demo-Role': 'executive' },
    });
    expect(response.statusCode).toBe(200);
    const body = DashboardTrendsSchema.parse(response.json());
    expect(body.masked).toBe(true);
    const summary = body.summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;

    for (const key of ['gross', 'cost', 'profit', 'rpm', 'cpm', 'ppm', 'marginPct'] as const) {
      expect(summary[key], key).toMatchObject({
        value: null,
        previous: null,
        delta: null,
        deltaPct: null,
        masked: true,
      });
    }
    // Operational figures stay visible, as they do on the per-week rows.
    expect(summary.totalMiles.value).not.toBeNull();
    expect(summary.activeTrucks.value).not.toBeNull();
    expect(summary.window).toEqual(adminSummary.window);
    expect(summary.expenseCoverage).toEqual(adminSummary.expenseCoverage);

    for (const value of adminMoney) {
      expect(response.body, String(value)).not.toContain(String(value));
    }
  });

  it('executive ops-net and trends carry none of the admin money values', async () => {
    const adminOpsNet = DashboardOpsNetSchema.parse(
      (await app.inject({ method: 'GET', url: `${BASE}/ops-net?period=last_week` })).json(),
    );
    const adminMoney = [
      adminOpsNet.totals.gross,
      adminOpsNet.totals.totalCost,
      adminOpsNet.totals.operatingProfit,
      adminOpsNet.totals.rpm,
      adminOpsNet.inactiveTruckLoss,
      adminOpsNet.netOperatingProfit,
      ...adminOpsNet.buckets.map((b) => b.gross),
      ...adminOpsNet.buckets.map((b) => b.avgGrossPerTruck),
      ...adminOpsNet.buckets.flatMap((b) => Object.values(b.costs)),
    ].filter((value): value is number => value !== null && value !== 0);
    expect(adminMoney.length).toBeGreaterThan(5);

    const headers = { 'X-Demo-Role': 'executive' };
    const opsNetResponse = await app.inject({
      method: 'GET',
      url: `${BASE}/ops-net?period=last_week`,
      headers,
    });
    const trendsResponse = await app.inject({
      method: 'GET',
      url: `${BASE}/trends?period=last_week`,
      headers,
    });
    expect(opsNetResponse.statusCode).toBe(200);
    expect(trendsResponse.statusCode).toBe(200);

    const opsNet = DashboardOpsNetSchema.parse(opsNetResponse.json());
    expect(opsNet.masked).toBe(true);
    expect(opsNet.inactiveTruckLoss).toBeNull();
    expect(opsNet.netOperatingProfit).toBeNull();
    for (const row of [...opsNet.buckets, opsNet.totals]) {
      expect(Object.values(row.costs).every((value) => value === null)).toBe(true);
      expect(row.gross).toBeNull();
      expect(row.rpm).toBeNull();
      expect(row.avgGrossPerTruck).toBeNull();
      // Operational figures stay visible.
      expect(row.activeTrucks).not.toBeNull();
      expect(row.totalMiles).not.toBeNull();
      expect(row.avgMilesPerTruck).not.toBeNull();
    }

    const trends = DashboardTrendsSchema.parse(trendsResponse.json());
    for (const week of trends.weeks) {
      expect(week.ppm).toBeNull();
      expect(week.avgGrossPerTruck).toBeNull();
      expect(week.avgCostPerTruck).toBeNull();
      expect(week.avgProfitPerTruck).toBeNull();
      expect(week.activeByPayType).not.toBeNull();
    }

    for (const value of adminMoney) {
      expect(opsNetResponse.body, String(value)).not.toContain(String(value));
      expect(trendsResponse.body, String(value)).not.toContain(String(value));
    }
  });

  it('rejects a companyId in the query with a 400 problem', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/overview?period=last_week&companyId=other`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.detail).toBe('Company is determined by the authenticated session');
  });

  it('drilldown as operations is forbidden', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/drilldown?metric=gross&period=last_week`,
      headers: { 'x-demo-role': 'operations' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.detail).toContain('dashboard.drilldown');
  });

  it('custom period without dates is a 422 problem with errors[]', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/overview?period=custom` });
    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const json = response.json<{ errors?: unknown[] }>();
    const problem = ProblemDetailsSchema.parse(json);
    expect(problem.status).toBe(422);
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.errors?.length).toBeGreaterThan(0);
  });
});
