import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FleetExpenseDetail, FleetExpenseList, FleetExpenseSummary, StatementComputation } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { acctDriverTransactions, acctExpenses } from '../src/database/schema/accounting';
import { vendors, workOrders } from '../src/database/schema/fleet';
import { loads } from '../src/database/schema/loads';
import { drivers } from '../src/database/schema/roster';
import { FleetExpensesService } from '../src/modules/fleet-expenses/fleet-expenses.service';

const FX = '/api/v1/fleet/expenses';
const ACCT = '/api/v1/accounting';

/**
 * The owner's Fleet Expenses acceptance dataset (2026-10-12), on fictional records:
 * truck "0008" with Parking $150 company-borne, a $468.06 repair from Maintenance, Parking $100
 * company-paid by EFS and charged to the driver, and a $80 Truck Wash the driver paid and bears.
 */
describe('Fleet Expenses (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let companyId = '';
  const tag = Date.now().toString(36).toUpperCase();
  const eastern = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = eastern(new Date());
  const daysAgo = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const from = daysAgo(60);
  /** The Wednesday of the week `weeks` back: clear of the Monday cutoff that moves a load a week. */
  const wednesday = (weeks: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - weeks * 7 - ((d.getUTCDay() + 4) % 7));
    return d.toISOString().slice(0, 10);
  };
  let truckId = '';
  let unit = '';
  const driverId = `drv_e2e_fx_${tag}`.toLowerCase();
  const vendorId = `ven_e2e_fx_${tag}`.toLowerCase();
  const woId = `wo_e2e_fx_${tag}`.toLowerCase();
  const woNumber = `RO-FX-${tag}`;
  const ids: Record<string, string> = {};
  const EFS_CODE = '7012 3456 7890 4321';

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...(headers ?? {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });

  const base = (over: Record<string, unknown>) => ({
    status: 'recorded',
    truckId,
    expenseDate: daysAgo(28),
    vendorId: null,
    vendorName: null,
    invoiceNumber: null,
    description: null,
    notes: null,
    location: { placeName: null, address: null, city: null, state: null, postalCode: null },
    payerDriverId: null,
    payerName: null,
    paymentMethod: 'card',
    paid: true,
    paymentReference: null,
    charge: null,
    efs: null,
    notDuplicateOf: null,
    ...over,
  });
  const create = async (body: Record<string, unknown>) => {
    const res = await call('POST', FX, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as FleetExpenseDetail;
  };
  const detail = async (id: string) => (await call('GET', `${FX}/${id}`)).json() as FleetExpenseDetail;
  const list = async (q = '') => {
    const res = await call('GET', `${FX}?truckId=${truckId}&from=${from}&to=${today}&pageSize=100${q}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as FleetExpenseList;
  };

  async function settle(day: string, rate: number) {
    // One delivered load for the driver in that week: earnings $2,000 on a flat plan.
    const loadId = `lod_e2e_fx_${tag}_${day}`.toLowerCase();
    const deliveredAt = `${day}T15:00:00.000Z`;
    await db.insert(loads).values({
      id: loadId,
      companyId,
      loadNumber: `E2E-FX-${tag}-${day}`,
      status: 'delivered',
      driverId,
      truckId,
      record: { id: loadId, loadNumber: `E2E-FX-${tag}-${day}`, status: 'delivered', driverId, truckId, deliveredAt, updatedAt: deliveredAt, rate, documents: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: rate, billable: true }], stops: [{ kind: 'pickup', city: 'Chicago', state: 'IL' }, { kind: 'delivery', city: 'Dallas', state: 'TX' }] },
    });
    const gen = await call('POST', `${ACCT}/settlements/generate`, { kind: 'cd', weekOf: day });
    expect(gen.statusCode, gen.body).toBeLessThan(300);
    const all = (await call('GET', `${ACCT}/settlements`)).json() as Array<{ id: string; partyId: string; periodStart: string; periodEnd: string }>;
    const mine = all.find((s) => s.partyId === driverId && s.periodStart <= day && s.periodEnd >= day);
    expect(mine).toBeTruthy();
    return mine!.id;
  }
  const statement = async (id: string) => (await call('GET', `${ACCT}/settlements/${id}`)).json() as { status: string; netCents: number; computation: StatementComputation };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const opts = (await call('GET', `${FX}/options`)).json() as { trucks: Array<{ id: string }> };
    expect(Array.isArray(opts.trucks)).toBe(true);
    unit = `0008-${tag}`.slice(0, 20);
    const t = await call('POST', '/api/v1/trucks', { unitNumber: unit, vin: `1FX${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '8').slice(0, 17), year: 2022, make: 'E2E', model: 'Expenses', odometer: 100_000, status: 'available' });
    expect(t.statusCode, t.body).toBe(201);
    truckId = (t.json() as { id: string }).id;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-FX-${tag}`, firstName: 'E2E', lastName: `Expenses ${tag}`, phone: '5550000000', email: `e2e-fx-${tag}@example.test`.toLowerCase(), driverType: 'company', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: daysAgo(90), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: null, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'flat_rate' });
    await db.insert(vendors).values({ id: vendorId, companyId, name: `E2E Truck Stop ${tag}`, kind: 'other' } as typeof vendors.$inferInsert);
    await db.insert(workOrders).values({ id: woId, companyId, number: woNumber, assetType: 'truck', unitId: truckId, unitNumber: unit, status: 'completed', workType: 'repair', title: 'Brake chamber', shopInAt: new Date(`${daysAgo(28)}T14:00:00Z`), completedAt: new Date(`${daysAgo(27)}T16:00:00Z`), total: '468.06', invoiceTotal: '468.06', invoiceNumber: `INV-${tag}`, vendorName: `E2E Diesel ${tag}`, createdBy: 'e2e' } as typeof workOrders.$inferInsert);
    // The driver's pay profile and the settlement cutoff, as Accounting would set them.
    const prof = await call('PUT', `${ACCT}/drivers/${driverId}/profile`, { effectiveFrom: daysAgo(90), contractType: 'CD', switches: { deductFuel: false, deductTolls: false, deductApprovedAdvances: true, recurringDeductions: false, escrowEnabled: false }, loadedPlan: { kind: 'flat_per_load', rate: 2000 }, emptyPlan: { kind: 'none', rate: 0 }, escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true }, openingDebtCents: 0, openingDebtReconciled: true, confirmRate: true, expectedVersion: 0 });
    expect(prof.statusCode, prof.body).toBeLessThan(300);
    const s = (await call('GET', `${ACCT}/settings`)).json() as { version: number; settings: { cutoffBasis: string | null; cutoffTimezoneConfirmed: boolean | null } };
    if (s.settings.cutoffBasis === null || s.settings.cutoffTimezoneConfirmed !== true) {
      const put = await call('PUT', `${ACCT}/settings`, { expectedVersion: s.version, settings: { cutoffBasis: s.settings.cutoffBasis ?? 'delivered_at', cutoffTimezoneConfirmed: true } });
      expect(put.statusCode, put.body).toBeLessThan(300);
    }
  }, 120_000);

  afterAll(async () => {
    // Test data is never deleted: the loads are cancelled; the expenses stay void or recorded.
    await db.update(loads).set({ status: 'cancelled' }).where(and(eq(loads.companyId, companyId), eq(loads.driverId, driverId)));
    await app.close();
  });

  it('records the four acceptance expenses and refuses an incomplete parking', async () => {
    const bad = await call('POST', FX, base({ category: 'parking', amountCents: 15000, paidBy: 'company', chargeTo: 'company' }));
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { problems: Array<{ field: string }> }).problems.map((p) => p.field)).toEqual(expect.arrayContaining(['location.placeName', 'location.address']));

    const parking = await create(base({ category: 'parking', amountCents: 15000, paidBy: 'company', chargeTo: 'company', vendorId, location: { placeName: 'Love’s Travel Stop', address: '1201 W Main St', city: 'Gary', state: 'IN', postalCode: '46402' }, notes: 'x'.repeat(3000) }));
    ids.parking = parking.id;
    expect(parking.reference).toMatch(/^EXP-\d{5}$/);
    expect(parking.notes).toHaveLength(3000);
    expect(parking.accounting.state).toBe('awaiting_posting');

    const efs = await create(base({ category: 'parking', amountCents: 10000, paidBy: 'company', paymentMethod: 'efs', chargeTo: 'driver', location: { placeName: 'TA Petro', address: null, city: 'Joliet', state: 'IL', postalCode: null }, charge: { driverId, amountCents: 10000, reason: 'Overnight parking on a personal stop', deductFromSettlement: true }, efs: { code: EFS_CODE, issuedOn: daysAgo(28), issuedCents: 10000, usedCents: 10000, status: 'used', receiptFileId: null } }));
    ids.efs = efs.id;
    expect(efs.efs).toMatchObject({ masked: '•••• 4321', issuedCents: 10000, usedCents: 10000, unusedCents: 0 });
    expect(JSON.stringify(efs)).not.toContain('7890');
    expect(efs.recoveryStatus).toBe('not_posted');

    const wash = await create(base({ category: 'truck_wash', amountCents: 8000, paidBy: 'driver', payerDriverId: driverId, paymentMethod: null, chargeTo: 'driver', location: { placeName: 'Blue Beacon', address: null, city: 'Gary', state: 'IN', postalCode: null } }));
    ids.wash = wash.id;
    expect(wash.outcome).toBe('external');
    expect(wash.paymentStatus).toBe('paid_externally');
    expect(wash.accounting.state).toBe('not_required');
  });

  it('adds up exactly as the owner specified, with the repair counted once from Maintenance', async () => {
    const l = await list();
    expect(l.totals.spendCents).toBe(79806);
    expect(l.totals.companyCents).toBe(61806);
    expect(l.totals.driverChargeCents).toBe(10000);
    expect(l.totals.externalCents).toBe(8000);
    const cat = Object.fromEntries(l.totals.byCategory.map((c) => [c.category, c.cents]));
    expect(cat).toEqual({ parking: 25000, repair_maintenance: 46806, truck_wash: 8000 });
    const repair = l.rows.find((r) => r.source === 'work_order');
    expect(repair).toMatchObject({ reference: woNumber, workOrderId: woId, amountCents: 46806, paymentStatus: 'not_billed' });
    expect(l.rows.filter((r) => r.reference === woNumber)).toHaveLength(1);
    // The dashboard tells the same story for the same filters.
    const d = (await call('GET', `${FX}/dashboard?truckId=${truckId}&from=${from}&to=${today}`)).json() as { totals: FleetExpenseList['totals'] };
    expect(d.totals.spendCents).toBe(79806);
  });

  it('refuses a manual repair that duplicates the work order invoice, unless confirmed different', async () => {
    const dup = await call('POST', FX, base({ category: 'repair_maintenance', amountCents: 46806, paidBy: 'company', chargeTo: 'company', expenseDate: daysAgo(27) }));
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { duplicates: Array<{ roNumber: string }> }).duplicates[0]?.roNumber).toBe(woNumber);
    const check = (await call('GET', `${FX}/duplicate-check?truckId=${truckId}&category=repair_maintenance&invoiceNumber=INV-${tag}`)).json() as { matches: unknown[] };
    expect(check.matches).toHaveLength(1);
  });

  it('posts once however often Post is pressed, and an external cost never posts', async () => {
    const [a, b] = await Promise.all([call('POST', `${FX}/${ids.parking}/post`), call('POST', `${FX}/${ids.parking}/post`)]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const p = await detail(ids.parking!);
    expect(p.accounting.state).toBe('posted');
    const mine = await db.select().from(acctExpenses).where(and(eq(acctExpenses.companyId, companyId), eq(acctExpenses.sourceKey, `manual:fleet_expense:${ids.parking}`)));
    expect(mine).toHaveLength(1);
    expect(p.accounting.links.map((x) => x.kind)).toEqual(['payment']);

    await Promise.all([call('POST', `${FX}/${ids.efs}/post`), call('POST', `${FX}/${ids.efs}/post`)]);
    const e = await detail(ids.efs!);
    const txs = await db.select().from(acctDriverTransactions).where(and(eq(acctDriverTransactions.companyId, companyId), eq(acctDriverTransactions.sourceKey, `fleet_expense:${ids.efs}`)));
    expect(txs).toHaveLength(1);
    expect(e.recovery).toMatchObject({ chargeCents: 10000, deductedCents: 0, remainingCents: 10000, state: 'pending' });
    expect(e.recoveryStatus).toBe('pending_review');
    expect(e.paymentStatus).toBe('paid');

    const ext = await call('POST', `${FX}/${ids.wash}/post`);
    expect(ext.statusCode).toBe(422);
  });

  it('a draft settlement previews the deduction; only posting it lowers the balance; partial 40 + 60; reversal restores', async () => {
    const sched = await call('POST', `${FX}/${ids.efs}/recovery`, { action: 'add_to_settlement', perSettlementCents: null });
    expect(sched.statusCode, sched.body).toBe(201);
    const w1 = await settle(wednesday(3), 2000);
    let s1 = await statement(w1);
    expect(s1.computation.grossCents).toBe(200000);
    expect(s1.netCents).toBe(190000);
    const line = s1.computation.deductions.find((d) => d.kind === 'debt_recovery');
    expect(line?.cents).toBe(10000);
    expect(line?.description).toContain((await detail(ids.efs!)).reference);
    let e = await detail(ids.efs!);
    expect(e.recovery).toMatchObject({ deductedCents: 0, remainingCents: 10000 });
    expect(e.recovery?.inDraft).toMatchObject({ settlementId: w1, cents: 10000 });
    expect(e.recoveryStatus).toBe('in_settlement');
    expect((await list()).totals.spendCents).toBe(79806);

    // Partial: $40 this settlement.
    await call('POST', `${FX}/${ids.efs}/recovery`, { action: 'add_to_settlement', perSettlementCents: 4000 });
    s1 = await statement(w1);
    expect(s1.netCents).toBe(196000);
    const [ap1, ap2] = await Promise.all([call('POST', `${ACCT}/settlements/${w1}/approve`), call('POST', `${ACCT}/settlements/${w1}/approve`)]);
    expect([ap1.statusCode, ap2.statusCode].some((c) => c < 300), `${ap1.body} ${ap2.body}`).toBe(true);
    e = await detail(ids.efs!);
    expect(e.recovery).toMatchObject({ deductedCents: 4000, remainingCents: 6000 });
    expect(e.recovery?.entries).toHaveLength(1);
    expect(e.recoveryStatus).toBe('partially_deducted');

    // The remaining $60 next settlement; more than outstanding is refused.
    expect((await call('POST', `${FX}/${ids.efs}/recovery`, { action: 'add_to_settlement', perSettlementCents: 6001 })).statusCode).toBe(422);
    await call('POST', `${FX}/${ids.efs}/recovery`, { action: 'add_to_settlement', perSettlementCents: 6000 });
    const w2 = await settle(wednesday(2), 2000);
    expect((await statement(w2)).netCents).toBe(194000);
    expect((await call('POST', `${ACCT}/settlements/${w2}/approve`)).statusCode).toBeLessThan(300);
    e = await detail(ids.efs!);
    expect(e.recovery).toMatchObject({ deductedCents: 10000, remainingCents: 0 });
    expect(e.recoveryStatus).toBe('deducted');
    expect((await list()).totals.spendCents).toBe(79806);

    // Reversing the $60 deduction restores exactly $60, once, and refunds it on the next statement.
    const rev = { action: 'reverse', settlementId: w2, reason: 'Deducted in error' };
    await Promise.all([call('POST', `${FX}/${ids.efs}/recovery`, rev), call('POST', `${FX}/${ids.efs}/recovery`, rev)]);
    e = await detail(ids.efs!);
    expect(e.recovery).toMatchObject({ deductedCents: 4000, remainingCents: 6000 });
    expect(e.recovery?.entries.find((x) => x.settlementId === w2)?.status).toBe('reversed');
    const refunds = await db.select().from(acctDriverTransactions).where(and(eq(acctDriverTransactions.companyId, companyId), eq(acctDriverTransactions.sourceKey, `recovery_reversal:${e.recovery!.driverTxId}:${w2}`)));
    expect(refunds).toHaveLength(1);
    const w3 = await settle(wednesday(1), 2000);
    const s3 = await statement(w3);
    expect(s3.computation.deductions.find((d) => d.kind === 'reversal')?.cents).toBe(-6000);
  }, 180_000);

  it('a driver-paid company expense becomes one reimbursement and nothing else', async () => {
    const tolls = await create(base({ category: 'tolls', amountCents: 2500, paidBy: 'driver', payerDriverId: driverId, paymentMethod: null, chargeTo: 'company', expenseDate: daysAgo(10) }));
    await Promise.all([call('POST', `${FX}/${tolls.id}/post`), call('POST', `${FX}/${tolls.id}/post`)]);
    const t = await detail(tolls.id);
    expect(t.accounting.links.map((l) => l.kind)).toEqual(['reimbursement']);
    expect(t.paymentStatus).toBe('reimbursement_pending');
    expect(t.recovery).toBeNull();
    const [re] = await db.select().from(acctExpenses).where(and(eq(acctExpenses.companyId, companyId), eq(acctExpenses.id, t.accounting.links[0]!.id)));
    expect((re?.record as { reimbursement: { driverFundedCents: number } }).reimbursement.driverFundedCents).toBe(2500);
  });

  it('an unpaid company expense becomes one vendor bill, and needs a vendor', async () => {
    const wash = await create(base({ category: 'truck_wash', amountCents: 6500, paidBy: 'company', paid: false, paymentMethod: 'check', chargeTo: 'company', expenseDate: daysAgo(9), location: { placeName: 'Wash Bay', address: null, city: 'Gary', state: 'IN', postalCode: null } }));
    expect((await call('POST', `${FX}/${wash.id}/post`)).statusCode).toBe(422);
    const withVendor = await call('PATCH', `${FX}/${wash.id}`, { ...base({ category: 'truck_wash', amountCents: 6500, paidBy: 'company', paid: false, paymentMethod: 'check', chargeTo: 'company', expenseDate: daysAgo(9), vendorId, location: { placeName: 'Wash Bay', address: null, city: 'Gary', state: 'IN', postalCode: null } }), expectedVersion: wash.version });
    expect(withVendor.statusCode, withVendor.body).toBe(200);
    const stale = await call('PATCH', `${FX}/${wash.id}`, { ...base({ category: 'truck_wash', amountCents: 6500, paidBy: 'company', paid: false, paymentMethod: 'check', chargeTo: 'company', expenseDate: daysAgo(9), vendorId, location: { placeName: 'Wash Bay', address: null, city: 'Gary', state: 'IN', postalCode: null } }), expectedVersion: wash.version });
    expect(stale.statusCode).toBe(409);
    await Promise.all([call('POST', `${FX}/${wash.id}/post`), call('POST', `${FX}/${wash.id}/post`)]);
    const w = await detail(wash.id);
    expect(w.accounting.links.filter((l) => l.kind === 'bill')).toHaveLength(1);
    expect(w.paymentStatus).toBe('unpaid');
    ids.unpaid = wash.id;
  });

  it('issued but unused EFS is zero spend and posts nothing', async () => {
    const before = (await list()).totals.spendCents;
    const unused = await create(base({ category: 'fuel', amountCents: 0, paidBy: 'company', paymentMethod: 'efs', chargeTo: 'company', expenseDate: daysAgo(8), efs: { code: '1111222233334444', issuedOn: daysAgo(8), issuedCents: 10000, usedCents: 0, status: 'unused', receiptFileId: null } }));
    expect(unused.amountCents).toBe(0);
    expect(unused.efs?.unusedCents).toBe(10000);
    expect((await list()).totals.spendCents).toBe(before);
    expect((await call('POST', `${FX}/${unused.id}/post`)).statusCode).toBe(422);
  });

  it('removes the right attachment, keeps it removed after a refresh, and keeps evidence Accounting relies on', async () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = async (name: string) => ((await call('POST', '/api/v1/files', { fileName: name, content: PNG })).json() as { id: string }).id;
    const draft = await create(base({ status: 'draft', category: 'other', amountCents: 1200, paidBy: 'company', chargeTo: 'company', expenseDate: daysAgo(5) }));
    const f1 = await up('receipt-a.png');
    const f2 = await up('receipt-b.png');
    await call('POST', `${FX}/${draft.id}/files`, { fileId: f1, kind: 'receipt' });
    let d = (await (await call('POST', `${FX}/${draft.id}/files`, { fileId: f2, kind: 'receipt' })).json()) as FleetExpenseDetail;
    expect(d.files.map((f) => f.fileName)).toEqual(['receipt-a.png', 'receipt-b.png']);
    const target = d.files.find((f) => f.fileName === 'receipt-b.png')!;
    const removed = await call('POST', `${FX}/${draft.id}/files/${target.id}/remove`, { reason: 'Wrong receipt' });
    expect(removed.statusCode, removed.body).toBe(201);
    d = await detail(draft.id);
    expect(d.files.map((f) => f.fileName)).toEqual(['receipt-a.png']);
    expect(d.history.some((h) => h.action === 'fleet_expense_file_removed')).toBe(true);

    // On the posted unpaid wash the file went onto the vendor bill: it stays.
    const f3 = await up('wash-invoice.png');
    await call('POST', `${FX}/${ids.unpaid}/files`, { fileId: f3, kind: 'invoice' });
    const w = await detail(ids.unpaid!);
    expect(w.files[0]?.removable).toBe(true); // attached after the bill was made: not the bill's evidence
  });

  it('PDFs: one expense and the filtered report, with no full EFS code', async () => {
    const one = await call('GET', `${FX}/${ids.efs}/pdf`);
    expect(one.statusCode).toBe(200);
    expect(one.headers['content-type']).toContain('application/pdf');
    expect(one.rawPayload.includes(Buffer.from('7890'))).toBe(false);
    const rep = await call('GET', `${FX}/report.pdf?truckId=${truckId}&from=${from}&to=${today}`);
    expect(rep.statusCode).toBe(200);
    expect(rep.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('Costs: All fleet costs adds parking and wash without touching Maintenance only', async () => {
    const q = `period=year&at=${daysAgo(28)}&units=${truckId}`;
    const maint = (await call('GET', `/api/v1/fleet/expense-summary?${q}&scope=maintenance`)).json() as FleetExpenseSummary;
    const all = (await call('GET', `/api/v1/fleet/expense-summary?${q}&scope=all`)).json() as FleetExpenseSummary;
    const mine = (s: FleetExpenseSummary) => s.events.filter((e) => e.truckId === truckId);
    expect(mine(maint).every((e) => e.kind !== 'fleet_expense')).toBe(true);
    expect(mine(maint).filter((e) => e.kind === 'work_order').map((e) => e.amount)).toEqual([468.06]);
    const extra = mine(all).filter((e) => e.kind === 'fleet_expense');
    expect(extra.map((e) => e.type)).toEqual(expect.arrayContaining(['parking', 'truck_wash']));
    expect(mine(all).filter((e) => e.kind === 'work_order')).toHaveLength(1);
  });

  it('a Pay later repair counts in Unpaid vendor bills; Company paid does not (owner, 2026-10-13)', async () => {
    const unpaid = async () => (await list()).rows.find((r) => r.workOrderId === woId);
    const before = (await list()).totals.unpaidBillsCents;
    await db.update(workOrders).set({ paymentTerms: 'pay_later' }).where(eq(workOrders.id, woId));
    expect((await unpaid())?.paymentStatus).toBe('unpaid');
    expect((await list()).totals.unpaidBillsCents).toBe(before + 46806);
    await db.update(workOrders).set({ paymentTerms: 'company_paid' }).where(eq(workOrders.id, woId));
    expect((await unpaid())?.paymentStatus).toBe('paid');
    expect((await list()).totals.unpaidBillsCents).toBe(before);
    await db.update(workOrders).set({ paymentTerms: null }).where(eq(workOrders.id, woId));
  });

  it('a repair change or void updates Expenses once', async () => {
    await db.update(workOrders).set({ invoiceTotal: '500.00', total: '500.00' }).where(eq(workOrders.id, woId));
    let l = await list();
    expect(l.rows.filter((r) => r.workOrderId === woId).map((r) => r.amountCents)).toEqual([50000]);
    await db.update(workOrders).set({ voidedAt: new Date(), voidedBy: 'e2e', voidReason: 'test' }).where(eq(workOrders.id, woId));
    l = await list();
    expect(l.rows.some((r) => r.workOrderId === woId)).toBe(false);
  });

  it('voids a posted expense through Accounting’s own reversal and drops it from the totals', async () => {
    const before = (await list()).totals.companyCents;
    const res = await call('POST', `${FX}/${ids.parking}/void`, { reason: 'Entered on the wrong truck' });
    expect(res.statusCode, res.body).toBe(201);
    const v = await detail(ids.parking!);
    expect(v.status).toBe('void');
    expect((await list()).totals.companyCents).toBe(before - 15000);
    const [pay] = await db.select().from(acctExpenses).where(and(eq(acctExpenses.companyId, companyId), eq(acctExpenses.sourceKey, `manual:fleet_expense:${ids.parking}`)));
    expect((pay?.record as { status: string }).status).toBe('void');
  });

  it('keeps companies and roles apart', async () => {
    const svc = app.get(FleetExpensesService);
    const other = { userId: 'u_other', companyId: 'co_other_tenant', companyTimezone: 'America/New_York', weekStart: 1, roles: ['administrator'], permissions: new Set(['maintenance_costs.view', 'accounting.view', 'maintenance.edit', 'accounting.edit']) };
    await expect(svc.detail(other, ids.efs!)).rejects.toMatchObject({ status: 404 });
    const theirs = await svc.list(other, { page: 1, pageSize: 100, sort: 'date_desc' });
    expect(theirs.rows.some((r) => r.truckId === truckId)).toBe(false);
    const fleetOnly = { ...other, companyId, permissions: new Set(['maintenance_costs.view', 'maintenance.edit']) };
    await expect(svc.post(fleetOnly, ids.unpaid!)).rejects.toMatchObject({ status: 403 });
    await expect(svc.recovery(fleetOnly, ids.efs!, { action: 'add_to_settlement', perSettlementCents: null })).rejects.toMatchObject({ status: 403 });
    const viewer = { ...other, companyId, permissions: new Set(['maintenance_costs.view']) };
    await expect(svc.create(viewer, base({ category: 'other', amountCents: 100, paidBy: 'company', chargeTo: 'company' }))).rejects.toMatchObject({ status: 403 });
  });
});
