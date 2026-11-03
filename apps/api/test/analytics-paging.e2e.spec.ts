import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';

const BASE = '/api/v1/analytics';

/** Trucks and drivers paging over HTTP (2026-10-25): additive, server-side, guarded as before. */
describe('Analytics ranking paging (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.REPORTING_SOURCE = 'generated';
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.REPORTING_SOURCE;
    await app.close();
  });

  it('without paging parameters the response is the full, unpaged list as before', async () => {
    const response = await app.inject({ method: 'GET', url: `${BASE}/trucks?preset=last_month` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { rows: unknown[]; total?: number };
    expect(body.total).toBeUndefined();
    expect(body.rows.length).toBeGreaterThan(25);
  });

  it('pages, sorts and searches over every truck on the server', async () => {
    const full = (await app.inject({ method: 'GET', url: `${BASE}/trucks?preset=last_month` })).json() as {
      rows: { id: string; label: string; profit: number | null }[];
    };
    const first = (
      await app.inject({ method: 'GET', url: `${BASE}/trucks?preset=last_month&page=1&pageSize=25&sort=profit&dir=desc` })
    ).json() as { rows: { id: string; profit: number | null }[]; total: number; totalAll: number };
    expect(first.total).toBe(full.rows.length);
    expect(first.rows).toHaveLength(25);
    const best = Math.max(...full.rows.map((r) => r.profit ?? -Infinity));
    expect(first.rows[0]?.profit).toBe(best);

    const label = full.rows[0]!.label;
    const searched = (
      await app.inject({ method: 'GET', url: `${BASE}/trucks?preset=last_month&page=1&pageSize=25&q=${encodeURIComponent(label)}` })
    ).json() as { rows: { label: string }[]; total: number; totalAll: number };
    expect(searched.totalAll).toBe(full.rows.length);
    for (const row of searched.rows) expect(row.label.toLowerCase()).toContain(label.toLowerCase());
  });

  it('drivers page by gross by default', async () => {
    const page = (
      await app.inject({ method: 'GET', url: `${BASE}/drivers?preset=last_month&page=1&pageSize=5` })
    ).json() as { rows: { gross: number; profit: null }[]; total: number };
    expect(page.rows.length).toBeLessThanOrEqual(5);
    const grosses = page.rows.map((r) => r.gross);
    expect(grosses).toEqual([...grosses].sort((a, b) => b - a));
    for (const row of page.rows) expect(row.profit).toBeNull();
  });

  it('a company cannot be chosen through the query string', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/trucks?preset=last_month&page=1&companyId=co_other`,
    });
    expect(response.statusCode).toBe(400);
  });
});
