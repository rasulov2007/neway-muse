import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  Campaign,
  CostEntry,
  CostSummary,
  HiringAnalytics,
  HiringCase,
  Lead,
} from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { CostLedgerService } from '../src/modules/hiring/cost-ledger.service';
import { HiringService } from '../src/modules/hiring/hiring.service';

const HIRING = '/api/v1/hiring';
const COMPLIANCE = '/api/v1/compliance';

/**
 * Campaigns and the cost ledger. The ledger prices a screening report the moment Safety files it,
 * from the unit costs in Settings; a ticket, an orientation and a hire price themselves; a report
 * filed twice is charged once; a corrected orientation replaces its own line; and a lead's cost
 * follows it into the case.
 */
describe('Cost ledger (e2e)', () => {
  let app: NestFastifyApplication;
  // Unique across runs: the last six digits of the clock repeat every 1000 seconds.
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.get(HiringSeedService).seedDotApplications();
    await app.get(HiringSeedService).seedPipeline();
    await app.get(HiringSeedService).seedCampaigns();
    await app
      .get(HiringSeedService)
      .seedPipeline([
        { first: 'E2E', last: `Ledger${stamp}`, state: 'TX', daysAgo: 45, stop: 'hired' },
      ]);
    // Seeding runs before the module's audit listeners exist (as it does at boot), so the
    // backfill prices what the seed filed — the same way the boot sequence does.
    await app.get(CostLedgerService).backfill('co_northwind');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // A run that crashed mid-test can leave the MVR unit cost at the raised price it was testing
    // with, which would then price this run's reports wrong. Put it back before anything is read.
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { 'content-type': 'application/json' },
      payload: { values: { 'hiring.cost.mvr': 18 } },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });
  const send = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown) =>
    app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      payload: payload as object,
    });
  const ledgerOf = async (caseId: string) =>
    (await get(`${HIRING}/cases/${caseId}/costs`)).json() as {
      entries: CostEntry[];
      summary: CostSummary;
    };
  const myCase = async () => {
    const cases = (await get(`${HIRING}/cases`)).json() as HiringCase[];
    return cases.find((c) => c.candidateName === `E2E Ledger${stamp}`) as HiringCase;
  };

  it('seeded campaigns with leads attributed by source', async () => {
    const campaigns = (await get(`${HIRING}/campaigns`)).json() as Campaign[];
    expect(campaigns.length).toBeGreaterThanOrEqual(5);
    expect(campaigns.some((c) => c.channel === 'job_board' && c.leadCount > 0)).toBe(true);
    expect(campaigns.some((c) => c.channel === 'referral')).toBe(true);
  });

  it('a hired candidate carries a full ledger: four checks, travel, lodging, orientation pay, bonus', async () => {
    const hired = await myCase();
    const { entries, summary } = await ledgerOf(hired.id);
    const types = new Set(entries.map((e) => e.type));
    for (const type of [
      'mvr',
      'psp',
      'clearinghouse',
      'drug_test',
      'travel',
      'lodging',
      'orientation_pay',
    ]) {
      expect(types.has(type as CostEntry['type']), type).toBe(true);
    }
    expect(summary.byType.mvr).toBe(18);
    expect(summary.byType.psp).toBe(10);
    expect(summary.byType.clearinghouse).toBe(1.25);
    expect(summary.byType.drug_test).toBe(65);
    expect(summary.byType.orientation_pay).toBe(450);
    expect(summary.total).toBeGreaterThan(500);
    expect(entries.every((e) => e.source === 'auto' && e.sourceRef)).toBe(true);
  });

  it('prices a report from the unit cost in force, and a re-filed report replaces its line rather than doubling', async () => {
    const hired = await myCase();
    const before = (await ledgerOf(hired.id)).summary.byType.mvr;
    await send('PATCH', '/api/v1/admin/settings', { values: { 'hiring.cost.mvr': 22 } });
    try {
      const upload = () =>
        send('POST', `${COMPLIANCE}/documents`, {
          ownerType: 'driver',
          ownerId: hired.driverId,
          ownerLabel: hired.candidateName,
          requirementCode: 'mvr_review',
          title: 'Motor vehicle record (re-ordered)',
          fileName: 'mvr.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1000,
          issuedOn: '2026-09-01',
          expiresOn: '2027-09-01',
        });
      expect((await upload()).statusCode).toBe(201);
      const after = await ledgerOf(hired.id);
      const mvrs = after.entries.filter((e) => e.type === 'mvr');
      // The first report stays on the ledger at the price it had; the new one is priced at 22.
      expect(mvrs).toHaveLength(2);
      expect(mvrs.map((e) => e.amount).sort()).toEqual([before, 22].sort());
      expect(mvrs.find((e) => e.amount === 22)?.note).toBe('Re-ordered report');
      // Pricing everything again changes nothing: neither a third line nor a re-priced first one.
      await app.get(CostLedgerService).backfill('co_northwind');
      const again = (await ledgerOf(hired.id)).entries.filter((e) => e.type === 'mvr');
      expect(again).toHaveLength(2);
      expect(again.map((e) => e.amount).sort()).toEqual([before, 22].sort());
    } finally {
      await send('PATCH', '/api/v1/admin/settings', { values: { 'hiring.cost.mvr': 18 } });
    }
  }, 60_000);

  it('a manual cost on a lead follows it into the case, and a case cost needs a case', async () => {
    const lead = (
      await send('POST', `${HIRING}/leads`, {
        firstName: 'E2E',
        lastName: `LeadCost${stamp}`,
        phone: `+1512555${stamp.slice(-4)}`,
        source: 'agency',
      })
    ).json() as Lead;
    const entry = (
      await send('POST', `${HIRING}/costs`, {
        leadId: lead.id,
        type: 'lead_acquisition',
        amount: 250,
        incurredOn: '2026-09-01',
        note: 'Agency fee',
      })
    ).json() as CostEntry;
    expect(entry.source).toBe('manual');
    expect(entry.leadId).toBe(lead.id);
    const listed = (await get(`${HIRING}/costs?leadId=${lead.id}`)).json() as CostEntry[];
    expect(listed.map((e) => e.id)).toEqual([entry.id]);

    const floating = await send('POST', `${HIRING}/costs`, {
      type: 'other',
      amount: 5,
      incurredOn: '2026-09-01',
    });
    expect(floating.statusCode).toBe(422);
    const missing = await send('POST', `${HIRING}/costs`, {
      hiringCaseId: 'hc_nope',
      type: 'other',
      amount: 5,
      incurredOn: '2026-09-01',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('campaigns can be created and updated, and attribute leads by id', async () => {
    const created = (
      await send('POST', `${HIRING}/campaigns`, {
        name: `E2E campaign ${stamp}`,
        channel: 'social',
        periodStart: '2026-09-01',
        spend: 300,
      })
    ).json() as Campaign;
    expect(created.leadCount).toBe(0);
    const lead = (
      await send('POST', `${HIRING}/leads`, {
        firstName: 'E2E',
        lastName: `Attributed${stamp}`,
        phone: `+1737555${stamp.slice(-4)}`,
        source: 'social',
        campaignId: created.id,
      })
    ).json() as Lead;
    expect(lead.campaignId).toBe(created.id);
    // What was spent at set-up is the first dated entry; later spend is an entry of its own, and
    // an edit of the campaign no longer carries spend at all (0038).
    expect(created).toMatchObject({ spend: 300, spendEntryCount: 1 });
    const more = await send('POST', `${HIRING}/campaigns/${created.id}/spend`, {
      spentOn: '2026-09-15',
      amount: 150,
    });
    expect(more.statusCode, more.body).toBe(201);
    const updated = (
      await send('PATCH', `${HIRING}/campaigns/${created.id}`, { spend: 9999, active: false })
    ).json() as Campaign;
    expect(updated.spend).toBe(450);
    expect(updated.spendEntryCount).toBe(2);
    expect(updated.active).toBe(false);
    expect(updated.leadCount).toBe(1);
  });

  it('refuses ledger writes to a principal without recruiting.manage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${HIRING}/campaigns`,
      headers: { 'x-demo-role': 'operations', 'content-type': 'application/json' },
      payload: { name: 'Nope', channel: 'other', periodStart: '2026-09-01' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('Hiring analytics (e2e)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('computes the funnel, cost per hire, retention and days to first load from the seeded records', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/hiring/analytics?from=2026-01-01&to=2026-12-31',
    });
    expect(response.statusCode).toBe(200);
    const a = response.json() as HiringAnalytics;
    expect(a.totals.leads).toBeGreaterThan(30);
    expect(a.totals.hires).toBeGreaterThanOrEqual(1);
    expect(a.funnelBySource.length).toBeGreaterThan(3);
    expect(a.funnelByCampaign.some((c) => c.leads > 0)).toBe(true);
    expect(a.costPerHire.directPerHire).toBeGreaterThan(400);
    expect(a.costPerHire.truePerHire).toBeGreaterThan(a.costPerHire.directPerHire as number);
    expect(a.costPerHire.notes.some((n) => n.includes('campaign'))).toBe(true);
    expect(a.stageDurations.find((s) => s.stage === 'offer')?.n).toBeGreaterThan(0);
    expect(a.retention).toHaveLength(3);
    for (const r of a.retention) expect(r.rate === null ? r.reason : r.eligible).toBeTruthy();
    // Every figure that could not be computed says why.
    if (a.daysToFirstLoad.meanDays === null) expect(a.daysToFirstLoad.reason).toBeTruthy();
  });

  it('refuses a malformed period', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/hiring/analytics?from=yesterday',
    });
    expect(response.statusCode).toBe(422);
  });
});
