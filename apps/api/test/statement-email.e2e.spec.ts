import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { StatementComputation } from '@neway/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { emailMessages } from '../src/database/schema/dot-application';
import { drivers } from '../src/database/schema/roster';
import { AccountingStore } from '../src/modules/accounting/store.service';
import { EmailService } from '../src/modules/email/email.service';
import { DEMO_COMPANY } from '../src/modules/reporting/demo/demo-company';

const ACCT = '/api/v1/accounting';

interface Captured {
  to: string;
  subject: string;
  from?: string | null;
  attachments: Array<{ filename: string; content: Buffer }>;
}
interface Outcome { statementId: string; driverName: string; status: string; reason: string | null; recipient: string | null; error: string | null }
interface Summary { sent: Outcome[]; failed: Outcome[]; skipped_no_email: Outcome[]; skipped: Outcome[] }

/**
 * Driver statement emails (owner brief 2026-10-27 §7.4). The one thing that must never happen: a
 * driver receiving another driver's statement. The address is read on the server from the
 * statement's own driver record; a request that tries to name a recipient is refused; a statement
 * whose stored driver disagrees with its record is refused; the PDF is that statement's.
 */
describe('Driver statement emails (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let store: AccountingStore;
  let emailService: EmailService;
  let companyId = '';
  const tag = Date.now().toString(36).toUpperCase();
  const outbox: Captured[] = [];
  let sendDelayMs = 0;
  // A Monday far in the past, unique to this run, so the batch never meets a real week.
  const monday = new Date(Date.UTC(1990, 0, 1) + (Date.now() % 1500) * 7 * 86_400_000).toISOString().slice(0, 10);
  const sunday = new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  const batchId = `stb_e2e_mail_${tag}`.toLowerCase();
  const people = {
    a: { id: `drv_e2e_mail_a_${tag}`.toLowerCase(), email: `e2e-mail-a-${tag}@example.test`.toLowerCase(), first: 'Alpha' },
    b: { id: `drv_e2e_mail_b_${tag}`.toLowerCase(), email: `e2e-mail-b-${tag}@example.test`.toLowerCase(), first: 'Bravo' },
    c: { id: `drv_e2e_mail_c_${tag}`.toLowerCase(), email: `no-address-${tag}`.toLowerCase(), first: 'Charlie' },
    d: { id: `drv_e2e_mail_d_${tag}`.toLowerCase(), email: `e2e-mail-d-${tag}@example.test`.toLowerCase(), first: 'Delta' },
  };
  const st = (k: keyof typeof people) => `stm_e2e_mail_${k}_${tag}`.toLowerCase();
  const number = (k: keyof typeof people) => `ST-E2E-${k.toUpperCase()}-${tag}`;

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });

  const computation = (cents: number): StatementComputation => ({
    earnings: [{ kind: 'flat', loadId: null, loadNumber: null, description: 'E2E flat pay', cents, basis: 'e2e' }],
    deductions: [],
    grossCents: cents,
    reimbursementsCents: 0,
    deductionsCents: 0,
    escrowCents: 0,
    netCents: cents,
    payableCents: cents,
    carryCents: 0,
    openingDebtCents: 0,
    closingDebtCents: 0,
    escrowBalanceAfterCents: null,
    loadCount: 0,
    totalMiles: 0,
    exceptions: [],
    excluded: [],
    recoveries: [],
    recurringCharges: [],
  });

  async function statement(k: keyof typeof people, status: 'approved' | 'draft', cents: number) {
    const p = people[k];
    const now = new Date().toISOString();
    await store.insert('acct_settlements', companyId, {
      id: st(k), sourceKey: `e2e-mail:${tag}:${k}`, settlementNumber: number(k), batchId, kind: 'cd', partyType: 'driver', partyId: p.id, partyName: `${p.first} E2E${tag}`,
      truckId: null, unitNumber: null, periodStart: monday, periodEnd: sunday, cutoffAt: `${sunday}T17:00:00.000Z`, payDate: sunday, status,
      netCents: cents, payableCents: cents, carryCents: 0, computation: computation(cents), vendor: null, snapshot: null, loadIds: [], exceptions: [],
      approvedAt: status === 'approved' ? now : null, approvedBy: status === 'approved' ? 'e2e' : null, paidAt: null, paymentId: null, paidCents: null, reversedAt: null, notes: null, versions: [], createdAt: now, updatedAt: now,
    });
  }

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    store = app.get(AccountingStore);
    emailService = app.get(EmailService);
    // Capture instead of sending: every message the email module hands to the provider.
    const transport = (emailService as unknown as { transport: { describe: () => unknown; send: (m: Captured) => Promise<{ messageId: string; info: string }> } }).transport;
    transport.describe = () => ({ kind: 'file', from: null, detail: 'e2e capture' });
    transport.send = async (m: Captured) => {
      if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
      outbox.push(m);
      return { messageId: `e2e-msg-${outbox.length}-${tag}`, info: 'captured' };
    };
    companyId = DEMO_COMPANY.id;
    for (const [k, p] of Object.entries(people)) {
      await db.insert(drivers).values({ id: p.id, companyId, driverNumber: `E2E-M${k.toUpperCase()}-${tag}`, firstName: p.first, lastName: `E2E${tag}`, phone: '5550000020', email: p.email, driverType: 'company_driver', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: '2020-01-01', status: 'active', dispatcherId: '', dispatcherName: '', homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'per_mile', payPlanRate: '0.6' });
    }
    await store.insert('acct_settlement_batches', companyId, { id: batchId, kind: 'cd', periodStart: monday, periodEnd: sunday, cutoffAt: `${sunday}T17:00:00.000Z`, payDate: sunday, timezone: 'America/New_York', cutoffBasis: 'delivered_at', status: 'approved', generatedAt: new Date().toISOString(), generatedBy: 'e2e', statementIds: [st('a'), st('b'), st('c'), st('d')], lateLoads: [] });
    await statement('a', 'approved', 111_100);
    await statement('b', 'approved', 222_200);
    await statement('c', 'approved', 333_300);
    await statement('d', 'draft', 444_400);
  }, 120_000);

  afterAll(async () => {
    // Test rows are retired, never deleted from a shared database by hand: archive the drivers.
    await db.update(drivers).set({ archivedAt: new Date(), archivedReason: 'e2e statement email', archivedBy: 'e2e' }).where(inArray(drivers.id, Object.values(people).map((p) => p.id)));
    await app.close();
  });

  const delivered = (statementId: string) => db.select().from(emailMessages).where(and(eq(emailMessages.companyId, companyId), eq(emailMessages.entityType, 'settlement'), eq(emailMessages.entityId, statementId)));

  it('1 · a request that names a recipient or another driver is refused, and nothing is sent', async () => {
    for (const body of [{ to: people.b.email }, { recipient: people.b.email }, { driverId: people.b.id }, { resend: true, items: [{ documentId: st('a'), recipient: people.b.email }] }]) {
      const r = await call('POST', `${ACCT}/settlements/${st('a')}/email`, body);
      expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
    }
    const bulk = await call('POST', `${ACCT}/settlements/batches/${batchId}/email`, { to: people.b.email });
    expect(bulk.statusCode).toBeGreaterThanOrEqual(400);
    expect(outbox).toHaveLength(0);
    expect(await delivered(st('a'))).toHaveLength(0);
  });

  it('2 · Send by email goes to the statement’s own driver, with that statement’s PDF only', async () => {
    const r = await call('POST', `${ACCT}/settlements/${st('a')}/email`, {});
    expect(r.statusCode, r.body).toBeLessThan(300);
    expect((r.json() as Outcome).status).toBe('sent');
    expect(outbox).toHaveLength(1);
    const m = outbox[0]!;
    expect(m.to).toBe(people.a.email);
    expect(m.to).not.toBe(people.b.email);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.filename).toContain(number('a'));
    expect(m.attachments[0]!.filename).not.toContain(number('b'));
    expect(m.attachments[0]!.content.subarray(0, 4).toString()).toBe('%PDF');
    expect(m.subject).toContain(number('a'));
    expect(m.from).toMatch(/Accounting" <accounting@/);
    // Logged on the statement: the email row (webhook link), the delivery row and the audit entry.
    const rows = await delivered(st('a'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toAddress).toBe(people.a.email);
    expect(rows[0]!.kind).toBe('statement');
    const dl = (await store.list<{ emailMessageId: string; recipient: string; driverId: string; status: string }>('acct_deliveries', companyId, sql`document_id = ${st('a')}`)).map((x) => x.record);
    expect(dl[0]).toMatchObject({ emailMessageId: rows[0]!.id, recipient: people.a.email, driverId: people.a.id, status: 'sent' });
    const audit = (await db.execute(sql`select action from audit_logs where company_id = ${companyId} and entity_type = 'settlement' and entity_id = ${st('a')}`)) as unknown as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('statement_emailed');
  }, 60_000);

  it('3 · a second send is refused unless Resend is asked for', async () => {
    const again = await call('POST', `${ACCT}/settlements/${st('a')}/email`, {});
    expect(again.statusCode).toBe(409);
    const resend = await call('POST', `${ACCT}/settlements/${st('a')}/email`, { resend: true });
    expect(resend.statusCode, resend.body).toBeLessThan(300);
    expect(outbox.at(-1)!.to).toBe(people.a.email);
  }, 60_000);

  it('4 · a statement whose stored driver disagrees with its record is refused', async () => {
    // Someone (or a bug) points A's statement record at driver B; the stored party column still says A.
    await db.execute(sql`update acct_settlements set record = jsonb_set(record, '{partyId}', ${JSON.stringify(people.b.id)}::jsonb) where company_id = ${companyId} and id = ${st('a')}`);
    const before = outbox.length;
    const r = await call('POST', `${ACCT}/settlements/${st('a')}/email`, { resend: true });
    expect(r.statusCode).toBe(422);
    expect(outbox.length).toBe(before);
    await db.execute(sql`update acct_settlements set record = jsonb_set(record, '{partyId}', ${JSON.stringify(people.a.id)}::jsonb) where company_id = ${companyId} and id = ${st('a')}`);
  });

  it('5 · Send all: one email per driver, no email listed by name, drafts and already-sent skipped, every address matches its statement', async () => {
    const preview = (await call('GET', `${ACCT}/settlements/batches/${batchId}/email`)).json() as { items: Array<{ statementId: string; action: string; reason: string | null }> };
    expect(preview.items.find((i) => i.statementId === st('b'))).toMatchObject({ action: 'send' });
    expect(preview.items.find((i) => i.statementId === st('c'))).toMatchObject({ action: 'skip', reason: 'invalid_email' });
    expect(preview.items.find((i) => i.statementId === st('a'))).toMatchObject({ action: 'skip', reason: 'already_sent' });
    expect(preview.items.find((i) => i.statementId === st('d'))).toMatchObject({ action: 'skip', reason: 'not_approved' });

    const start = outbox.length;
    const r = await call('POST', `${ACCT}/settlements/batches/${batchId}/email`, {});
    expect(r.statusCode, r.body).toBeLessThan(300);
    const s = r.json() as Summary;
    expect(s.sent.map((o) => o.statementId)).toEqual([st('b')]);
    expect(s.skipped_no_email.map((o) => o.driverName)).toEqual([`Charlie E2E${tag}`]);
    expect(s.skipped.map((o) => [o.statementId, o.reason]).sort()).toEqual([[st('a'), 'already_sent'], [st('d'), 'not_approved']].sort());
    expect(s.failed).toHaveLength(0);
    const sentNow = outbox.slice(start);
    expect(sentNow.map((m) => m.to)).toEqual([people.b.email]);
    expect(sentNow[0]!.attachments[0]!.filename).toContain(number('b'));

    // Across everything sent in this run: each email row's address is its statement's driver's.
    const all = await db.select().from(emailMessages).where(and(eq(emailMessages.companyId, companyId), eq(emailMessages.entityType, 'settlement'), inArray(emailMessages.entityId, [st('a'), st('b'), st('c'), st('d')])));
    const owner: Record<string, string> = { [st('a')]: people.a.email, [st('b')]: people.b.email };
    for (const row of all) expect(row.toAddress).toBe(owner[row.entityId!]);
  }, 60_000);

  it('6 · a second Send all for the same week is refused while one runs', async () => {
    sendDelayMs = 400;
    const [one, two] = await Promise.all([call('POST', `${ACCT}/settlements/batches/${batchId}/email`, { resend: true }), new Promise((r) => setTimeout(r, 50)).then(() => call('POST', `${ACCT}/settlements/batches/${batchId}/email`, { resend: true }))]);
    sendDelayMs = 0;
    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
  }, 60_000);

  it('7 · a bounce lands on the statement: status, "check address" flag and the delivery row', async () => {
    const [latest] = (await delivered(st('b'))).sort((x, y) => +y.createdAt - +x.createdAt);
    await db.update(emailMessages).set({ status: 'bounced', bouncedAt: new Date(), lastError: 'Mailbox does not exist' }).where(eq(emailMessages.id, latest!.id));
    const listeners = (emailService as unknown as { listeners: Map<string, Array<(row: unknown, type: string) => Promise<void>>> }).listeners.get('settlement') ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    for (const l of listeners) await l({ ...latest!, status: 'bounced', lastError: 'Mailbox does not exist' }, 'email.bounced');
    const status = (await call('GET', `${ACCT}/settlements/email-status?batchId=${batchId}`)).json() as Record<string, { status: string; bounced: boolean }>;
    expect(status[st('b')]).toMatchObject({ status: 'bounced', bounced: true });
    expect(status[st('a')]?.bounced).toBe(false);
    const dl = (await store.list<{ emailMessageId: string; status: string }>('acct_deliveries', companyId, sql`record->>'emailMessageId' = ${latest!.id}`)).map((x) => x.record);
    expect(dl[0]?.status).toBe('bounced');
    // A bounced statement is eligible again without Resend (the address was presumably fixed).
    const preview = (await call('GET', `${ACCT}/settlements/batches/${batchId}/email`)).json() as { items: Array<{ statementId: string; action: string }> };
    expect(preview.items.find((i) => i.statementId === st('b'))?.action).toBe('send');
  }, 60_000);
});
