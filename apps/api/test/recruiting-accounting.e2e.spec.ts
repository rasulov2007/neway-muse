import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Campaign, CampaignSpendEntry, CostEntry, HiringAnalytics, HiringCase } from '@neway/shared';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { memberships, users } from '../src/database/schema/admin';
import { auditLogs } from '../src/database/schema/people';
import { companies } from '../src/database/schema/roster';
import { hiringCampaigns, hiringCampaignSpend, hiringCostEntries } from '../src/database/schema/hiring';
import { HiringService } from '../src/modules/hiring/hiring.service';

const HIRING = '/api/v1/hiring';
const ACCT = '/api/v1/accounting';

interface Expense {
  id: string;
  expenseNumber: string;
  sourceKey: string;
  source: string;
  categoryCode: string;
  accountCode: string;
  amount: number;
  onDate: string;
  status: string;
  description: string;
  reversalEntryId?: string | null;
}

/**
 * The owner's recruiting decisions of 2026-10-01 on the server:
 *   1. candidate costs post to Accounting as expenses - once, never for a cost attributed from an
 *      existing expense, voided through Accounting's own void (or the cost void is refused), and
 *      left "not posted" for a recruiter who may not post;
 *   2. campaign spend is dated, so a period's spend, cost per lead and cost per hire reconcile
 *      with the entries dated inside it;
 *   3. retention is judged at 30, 60 and 90 days.
 */
describe('Recruiting ↔ Accounting and dated campaign spend (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  let recruiter = '';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({
      method,
      url,
      headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...(headers ?? {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const asRecruiter = { 'x-account': '' };
  const expenses = async () => (await call('GET', `${ACCT}/expenses`)).json() as Expense[];
  const postedFor = async (costId: string) =>
    (await expenses()).filter((e) => e.sourceKey === `recruiting:${costId}` || e.sourceKey.startsWith(`recruiting:${costId}:r`));
  const caseNamed = async (name: string) =>
    ((await call('GET', `${HIRING}/cases`)).json() as HiringCase[]).find((c) => c.candidateName === name) as HiringCase;
  const cost = (caseId: string, over: Record<string, unknown> = {}) => ({
    hiringCaseId: caseId,
    type: 'other',
    amount: 64.5,
    incurredOn: '2026-09-30',
    note: `Welcome kit ${stamp}`,
    ...over,
  });

  async function hrManagerAccount(email: string): Promise<string> {
    const roles = (await call('GET', '/api/v1/admin/roles')).json() as { id: string; code: string }[];
    const role = roles.find((r) => r.code === 'hr_manager');
    if (!role) throw new Error('No hr_manager role');
    const created = await call('POST', '/api/v1/admin/users', {
      firstName: 'Rita',
      lastName: 'Recruiter',
      email,
      phone: null,
      employeeId: null,
      roleIds: [role.id],
      invite: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
    const activated = await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'active', reason: 'recruiting accounting e2e' });
    expect(activated.statusCode, activated.body).toBe(200);
    await app.get(DatabaseService).db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await app.get(DatabaseService).db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
    return membershipId;
  }

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.get(HiringSeedService).seedDotApplications();
    await app.get(HiringSeedService).seedPipeline([
      { first: 'E2E', last: `Acct${stamp}`, state: 'TX', daysAgo: 20, stop: 'offer_sent' },
      { first: 'E2E', last: `Trip${stamp}`, state: 'OH', daysAgo: 20, stop: 'offer_sent' },
    ]);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    recruiter = await hrManagerAccount(`rita.${stamp}@test.local`);
    asRecruiter['x-account'] = recruiter;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('posts a manual cost to Accounting once, however often the save is sent', async () => {
    const kase = await caseNamed(`E2E Acct${stamp}`);
    const body = cost(kase.id, { clientKey: `acct${stamp}one` });
    const [a, b] = await Promise.all([call('POST', `${HIRING}/costs`, body), call('POST', `${HIRING}/costs`, body)]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const entry = a.json() as CostEntry;
    expect((b.json() as CostEntry).id).toBe(entry.id);
    expect(entry.accounting).toMatchObject({ state: 'posted', actionable: false });
    // A third send, and the Post button pressed twice more: still one expense.
    await call('POST', `${HIRING}/costs`, body);
    await Promise.all([
      call('POST', `${HIRING}/costs/${entry.id}/accounting`, {}),
      call('POST', `${HIRING}/costs/${entry.id}/accounting`, {}),
    ]);
    const mine = await postedFor(entry.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      source: 'recruiting',
      categoryCode: 'recruiting',
      accountCode: '6700',
      amount: 64.5,
      onDate: '2026-09-30',
      status: 'posted',
    });
    expect(mine[0]!.description).toBe(`Recruiting · Other · E2E Acct${stamp}`);
    expect(entry.accounting.expenseNumber).toBe(mine[0]!.expenseNumber);
    // Both sides audited: Accounting's expense_recorded and the candidate's posting line.
    const db = app.get(DatabaseService).db;
    const acctAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'expense'), eq(auditLogs.entityId, mine[0]!.id)));
    expect(acctAudit.map((r) => r.action)).toContain('expense_recorded');
    const caseAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'hiring_case'), eq(auditLogs.entityId, kase.id)));
    expect(caseAudit.some((r) => r.summary.startsWith(`Cost posted to Accounting as ${mine[0]!.expenseNumber}`))).toBe(true);
  });

  it('never posts a second expense for a cost attributed from an existing Accounting expense', async () => {
    const kase = await caseNamed(`E2E Acct${stamp}`);
    const made = await call('POST', `${ACCT}/expenses`, {
      onDate: '2026-09-28',
      categoryCode: 'other',
      description: `Motel ${stamp}`,
      amount: 95,
      truckId: null,
      driverId: null,
      loadId: null,
      vendorId: null,
      paymentMethod: null,
      paidDirectly: false,
      notes: null,
    });
    expect(made.statusCode, made.body).toBeLessThan(300);
    const booked = (made.json() as { expense: Expense }).expense;
    const before = (await expenses()).length;
    const linked = await call('POST', `${HIRING}/costs`, { ...cost(kase.id), type: 'lodging', amount: 0, accountingExpenseId: booked.id });
    expect(linked.statusCode, linked.body).toBe(201);
    const entry = linked.json() as CostEntry;
    expect(entry.accounting).toMatchObject({ state: 'attributed', expenseId: booked.id, actionable: false });
    // The Post button has nothing to do for it either.
    await call('POST', `${HIRING}/costs/${entry.id}/accounting`, {});
    expect((await expenses()).length).toBe(before);
    expect(await postedFor(entry.id)).toHaveLength(0);
    // Voiding it lets go of the expense; the expense stays posted in Accounting.
    await call('POST', `${HIRING}/costs/${entry.id}/void`, { reason: 'Wrong candidate' });
    expect((await expenses()).find((e) => e.id === booked.id)?.status).toBe('posted');
  });

  it('voids the posted expense with the cost, by a reversing entry, never a delete', async () => {
    const kase = await caseNamed(`E2E Acct${stamp}`);
    const entry = (await call('POST', `${HIRING}/costs`, cost(kase.id, { amount: 33, note: `Void me ${stamp}` }))).json() as CostEntry;
    expect(entry.accounting.state).toBe('posted');
    const voided = await call('POST', `${HIRING}/costs/${entry.id}/void`, { reason: 'Typed on the wrong candidate' });
    expect(voided.statusCode, voided.body).toBe(201);
    expect((voided.json() as CostEntry).accounting).toMatchObject({ state: 'voided', expenseStatus: 'void' });
    const [expense] = await postedFor(entry.id);
    expect(expense).toMatchObject({ status: 'void' });
    expect(expense!.reversalEntryId).toBeTruthy();
    const ledger = (await call('GET', `${ACCT}/ledger`)).json() as { journal: { id: string; reversalOf?: string }[] };
    expect(ledger.journal.some((j) => j.id === expense!.reversalEntryId)).toBe(true);
  });

  it('refuses the cost void, in words, when Accounting will not void the expense (closed month)', async () => {
    const kase = await caseNamed(`E2E Acct${stamp}`);
    const entry = (await call('POST', `${HIRING}/costs`, cost(kase.id, { amount: 21, incurredOn: '2025-02-10', note: `Closed month ${stamp}` }))).json() as CostEntry;
    expect(entry.accounting.state).toBe('posted');
    const closed = await call('POST', `${ACCT}/ledger/periods/2025-02/close`, {});
    expect(closed.statusCode, closed.body).toBeLessThan(300);
    try {
      const refused = await call('POST', `${HIRING}/costs/${entry.id}/void`, { reason: 'Wrong amount' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().detail).toMatch(/Accounting refused to void .*closed month/);
      const ledger = (await call('GET', `${HIRING}/cases/${kase.id}/costs`)).json() as { entries: CostEntry[] };
      const still = ledger.entries.find((e) => e.id === entry.id) as CostEntry;
      expect(still.voidedAt).toBeNull();
      expect(still.accounting.state).toBe('posted');
      expect((await postedFor(entry.id))[0]?.status).toBe('posted');
    } finally {
      await call('POST', `${ACCT}/ledger/periods/2025-02/reopen`, { reason: 'recruiting accounting e2e' });
    }
    const after = await call('POST', `${HIRING}/costs/${entry.id}/void`, { reason: 'Wrong amount' });
    expect(after.statusCode).toBe(201);
  });

  it('posts automatic travel and lodging once each when the trip is saved', async () => {
    const kase = await caseNamed(`E2E Trip${stamp}`);
    await call('POST', `${HIRING}/cases/${kase.id}/offer/status`, { status: 'accepted' });
    const trip = {
      travelMode: 'bus',
      carrier: 'Greyhound',
      bookingReference: `ACCT-${stamp}`,
      // 01:30 UTC on Oct 3 is 9:30 pm Eastern on Oct 2: the business date is the 2nd.
      departAt: '2026-10-03T01:30:00.000Z',
      arriveAt: null,
      travelCost: 140,
      lodgingNights: 1,
      lodgingCost: 89,
      notes: null,
    };
    const [t1, t2] = await Promise.all([
      call('POST', `${HIRING}/cases/${kase.id}/ticket`, trip),
      call('POST', `${HIRING}/cases/${kase.id}/ticket`, trip),
    ]);
    expect([t1.statusCode, t2.statusCode]).toEqual([201, 201]);
    const ledger = (await call('GET', `${HIRING}/cases/${kase.id}/costs`)).json() as { entries: CostEntry[] };
    const travel = ledger.entries.filter((e) => e.type === 'travel' && e.source === 'auto');
    const lodging = ledger.entries.filter((e) => e.type === 'lodging' && e.source === 'auto');
    expect(travel).toHaveLength(1);
    expect(lodging).toHaveLength(1);
    expect(travel[0]!.incurredOn).toBe('2026-10-02');
    expect(travel[0]!.accounting.state).toBe('posted');
    const t = await postedFor(travel[0]!.id);
    const l = await postedFor(lodging[0]!.id);
    expect(t).toHaveLength(1);
    expect(l).toHaveLength(1);
    expect(t[0]).toMatchObject({ amount: 140, onDate: '2026-10-02', categoryCode: 'recruiting' });
    expect(l[0]).toMatchObject({ amount: 89 });
  });

  it('saves a recruiter’s cost unposted, says who may post it, and lets that person post it', async () => {
    const kase = await caseNamed(`E2E Acct${stamp}`);
    const saved = await call('POST', `${HIRING}/costs`, cost(kase.id, { amount: 18, note: `By recruiter ${stamp}` }), asRecruiter);
    expect(saved.statusCode, saved.body).toBe(201);
    const entry = saved.json() as CostEntry;
    expect(entry.accounting.state).toBe('not_posted');
    expect(entry.accounting.actionable).toBe(true);
    expect(entry.accounting.message).toContain('needs someone with accounting.edit');
    expect(await postedFor(entry.id)).toHaveLength(0);
    // The recruiter may not press Post.
    const denied = await call('POST', `${HIRING}/costs/${entry.id}/accounting`, {}, asRecruiter);
    expect(denied.statusCode).toBe(403);
    // Someone with accounting.edit posts it.
    const posted = await call('POST', `${HIRING}/costs/${entry.id}/accounting`, {});
    expect(posted.statusCode, posted.body).toBe(201);
    expect((posted.json() as CostEntry).accounting.state).toBe('posted');
    expect(await postedFor(entry.id)).toHaveLength(1);
    // Now posted, the recruiter cannot void it alone: that would void an Accounting expense.
    const noVoid = await call('POST', `${HIRING}/costs/${entry.id}/void`, { reason: 'Mistake' }, asRecruiter);
    expect(noVoid.statusCode).toBe(403);
    expect(noVoid.json().detail).toContain('accounting.edit');
    expect((await postedFor(entry.id))[0]?.status).toBe('posted');
  });

  it('keeps campaign spend by date: add (retry-safe), correct with a version, void; periods reconcile', async () => {
    const made = await call('POST', `${HIRING}/campaigns`, { name: `E2E Dated ${stamp}`, channel: 'job_board', periodStart: '2026-07-01' });
    expect(made.statusCode).toBe(201);
    const campaign = made.json() as Campaign;
    expect(campaign).toMatchObject({ spend: 0, spendEntryCount: 0 });
    const july = { spentOn: '2026-07-15', amount: 100, note: 'July invoice', clientKey: `sp${stamp}july` };
    const [j1, j2] = await Promise.all([
      call('POST', `${HIRING}/campaigns/${campaign.id}/spend`, july),
      call('POST', `${HIRING}/campaigns/${campaign.id}/spend`, july),
    ]);
    expect([j1.statusCode, j2.statusCode]).toEqual([201, 201]);
    expect((j1.json() as CampaignSpendEntry).id).toBe((j2.json() as CampaignSpendEntry).id);
    const aug = (await call('POST', `${HIRING}/campaigns/${campaign.id}/spend`, { spentOn: '2026-08-10', amount: 250, note: 'August invoice' })).json() as CampaignSpendEntry;
    const periodRow = async (from: string, to: string) => {
      const a = (await call('GET', `${HIRING}/analytics?from=${from}&to=${to}`)).json() as HiringAnalytics;
      return a.funnelByCampaign.find((r) => r.key === campaign.id);
    };
    expect((await periodRow('2026-07-01', '2026-07-31'))?.spendEntries).toBe(100);
    expect((await periodRow('2026-08-01', '2026-08-31'))?.spendEntries).toBe(250);
    expect((await periodRow('2026-07-01', '2026-08-31'))?.spendEntries).toBe(350);

    // Correct August against the version read; a second save on that old version is refused.
    const fixed = await call('PATCH', `${HIRING}/campaign-spend/${aug.id}`, { version: aug.version, amount: 300 });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect((fixed.json() as CampaignSpendEntry).version).toBe(aug.version + 1);
    const stale = await call('PATCH', `${HIRING}/campaign-spend/${aug.id}`, { version: aug.version, amount: 999 });
    expect(stale.statusCode).toBe(409);
    expect((await periodRow('2026-08-01', '2026-08-31'))?.spendEntries).toBe(300);

    // Void July: kept, struck, out of every total.
    const julyEntry = j1.json() as CampaignSpendEntry;
    const voided = await call('POST', `${HIRING}/campaign-spend/${julyEntry.id}/void`, { version: julyEntry.version, reason: 'Duplicate invoice' });
    expect(voided.statusCode, voided.body).toBe(201);
    expect((await periodRow('2026-07-01', '2026-07-31'))?.spendEntries).toBe(0);
    const history = (await call('GET', `${HIRING}/campaigns/${campaign.id}/spend`)).json() as CampaignSpendEntry[];
    expect(history).toHaveLength(2);
    expect(history.find((h) => h.id === julyEntry.id)?.voidReason).toBe('Duplicate invoice');
    const listed = ((await call('GET', `${HIRING}/campaigns`)).json() as Campaign[]).find((c) => c.id === campaign.id);
    expect(listed).toMatchObject({ spend: 300, spendEntryCount: 1 });
    // The recruiter may add spend (recruiting.manage), and it is audited on the campaign.
    const byRecruiter = await call('POST', `${HIRING}/campaigns/${campaign.id}/spend`, { spentOn: '2026-08-20', amount: 10, note: null }, asRecruiter);
    expect(byRecruiter.statusCode, byRecruiter.body).toBe(201);
    const audit = await app.get(DatabaseService).db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'campaign'), eq(auditLogs.entityId, campaign.id)));
    expect(audit.filter((r) => r.summary.startsWith('Campaign spend')).length).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('judges retention at 30, 60 and 90 days', async () => {
    const a = (await call('GET', `${HIRING}/analytics?from=2026-01-01&to=2026-12-31`)).json() as HiringAnalytics;
    expect(a.retention.map((r) => r.days)).toEqual([30, 60, 90]);
  });

  it('refuses another company’s campaign spend and costs as not found', async () => {
    const db = app.get(DatabaseService).db;
    const [other] = await db.select({ id: companies.id }).from(companies).where(ne(companies.id, 'co_northwind')).limit(1);
    if (!other) throw new Error('This check needs a second company in the local database');
    const cmp = `cmp_e2e_other_${stamp}`;
    await db.insert(hiringCampaigns).values({ id: cmp, companyId: other.id, name: `Other co ${stamp}`, channel: 'other', periodStart: '2026-09-01', periodEnd: '2026-09-01', active: false, notes: 'recruiting accounting e2e (test row)' });
    await db.insert(hiringCampaignSpend).values({ id: `cmpsp_e2e_other_${stamp}`, companyId: other.id, campaignId: cmp, spentOn: '2026-09-02', amount: '5', recordedBy: 'e2e', voidedAt: new Date(), voidedBy: 'e2e', voidReason: 'Cross-company test fixture' });
    await db.insert(hiringCostEntries).values({ id: `cst_e2e_other_${stamp}`, companyId: other.id, campaignId: cmp, type: 'other', amount: '5', incurredOn: '2026-09-02', source: 'manual', recordedBy: 'e2e', note: 'recruiting accounting e2e (test row)', voidedAt: new Date(), voidedBy: 'e2e', voidReason: 'Cross-company test fixture' });
    expect((await call('GET', `${HIRING}/campaigns/${cmp}/spend`)).statusCode).toBe(404);
    expect((await call('POST', `${HIRING}/campaigns/${cmp}/spend`, { spentOn: '2026-09-03', amount: 1 })).statusCode).toBe(404);
    expect((await call('PATCH', `${HIRING}/campaign-spend/cmpsp_e2e_other_${stamp}`, { version: 1, amount: 1 })).statusCode).toBe(404);
    expect((await call('POST', `${HIRING}/campaign-spend/cmpsp_e2e_other_${stamp}/void`, { version: 1, reason: 'x' })).statusCode).toBe(404);
    expect((await call('POST', `${HIRING}/costs/cst_e2e_other_${stamp}/accounting`, {})).statusCode).toBe(404);
    expect((await call('POST', `${HIRING}/costs/cst_e2e_other_${stamp}/void`, { reason: 'x' })).statusCode).toBe(404);
    expect(((await call('GET', `${HIRING}/campaigns`)).json() as Campaign[]).some((c) => c.id === cmp)).toBe(false);
    // Nothing of theirs was touched. (The fixture is inert - inactive, voided - so it never counts in
    // that company's figures.)
    const [spendRow] = await db.select().from(hiringCampaignSpend).where(eq(hiringCampaignSpend.id, `cmpsp_e2e_other_${stamp}`));
    expect(spendRow).toMatchObject({ amount: '5.00', version: 1, voidReason: 'Cross-company test fixture' });
  });
});
