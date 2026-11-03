import {
  DRIVER_RELATION_TOPICS,
  PERMISSION_CODES,
  Rng,
  buildComplianceSeed,
  isOpenDefectState,
  queuesFor,
  unitServiceStatus,
} from '@neway/shared';
import { generateDemoData } from '@/demo/data';
import { primeLoads } from '@/demo/loads-api';
import {
  applyAddNote,
  applyAssignment,
  applyAttachDocument,
  applyCancel,
  applyCheckCall,
  applyConfirmUpload,
  applyStatusChange,
  applyStopEvent,
  type StoredLoad,
} from '@neway/shared';
import { fleetExpenseFixture } from './fixtures/fleet-expense';
import type { LoadProblem, PtiBoard, PtiBoardRow, PtiDefect, WorkOrderDetail } from '@neway/shared';
import { fleetTodayFixture, workOrderDetailFixture } from './fixtures/fleet-today';

/**
 * A stand-in for the roster API in unit tests.
 *
 * Tests do not have PostgreSQL, but they must still exercise the real client — the fetch, the
 * paging, the problem+json error mapping. So this stubs the transport and nothing above it: the
 * code under test takes exactly the path it takes in the browser. A route this does not recognise
 * fails loudly rather than resolving empty, because a silent empty response is precisely the class
 * of bug that let a "created" truck disappear without anything reporting an error.
 */

const fixture = generateDemoData();

/**
 * The qualification file the same generator gives the API seed, over this fixture's fleet. Read
 * routes only: a test that verifies or signs something mocks the client module instead, because a
 * write here would be a second implementation of the server's rules.
 */
const compliance = buildComplianceSeed(new Rng(7), {
  drivers: fixture.drivers.map((d) => ({
    id: d.id,
    driverNumber: d.driverNumber,
    firstName: d.firstName,
    name: d.name,
    hireDate: d.hireDate,
    cdlStatus: d.cdlStatus,
    cdlExpiresOn: d.cdlExpiresOn,
    medicalCardStatus: d.medicalCardStatus,
    medicalCardExpiresOn: d.medicalCardExpiresOn,
  })),
  // A truck added without an in-service date has nothing to seed a document from.
  trucks: fixture.trucks.flatMap((t) =>
    t.inServiceDate
      ? [{ id: t.id, unitNumber: t.unitNumber, status: t.status, inServiceDate: t.inServiceDate }]
      : [],
  ),
  // A trailer added without an inspection date has no inspection to seed a document from.
  trailers: fixture.trailers.flatMap((t) =>
    t.nextInspectionDate
      ? [
          {
            id: t.id,
            unitNumber: t.unitNumber,
            status: t.status,
            nextInspectionDate: t.nextInspectionDate,
          },
        ]
      : [],
  ),
  people: [
    { id: 'usr_006', name: 'Tom Brennan', department: 'safety' },
    { id: 'usr_010', name: 'Monica Alvarez', department: 'hr' },
    { id: 'usr_012', name: 'Robert Lindqvist', department: 'management' },
  ],
  now: new Date('2026-09-06T14:30:00-05:00'),
});

interface Row {
  id: string;
  status: string;
  [key: string]: unknown;
}

const store: {
  trucks: Row[];
  drivers: Row[];
  trailers: Row[];
  /** Served from their own table since 2026-09-25; the stub keeps one copy per test. */
  loads: Row[];
  /** Flags on loads (rule 1.10), kept for the session. */
  problems: LoadProblem[];
  workOrder: WorkOrderDetail;
  ptiDefects: PtiDefect[];
  ptiBoard: PtiBoardRow[] | null;
  /** Expenses with a review block: what the Reimbursements screen reads. */
  reimbursements: Row[];
} = {
  trucks: structuredClone(fixture.trucks) as unknown as Row[],
  drivers: structuredClone(fixture.drivers) as unknown as Row[],
  // Trailers are served from their own table since 2026-09-25, so the stub serves them too.
  trailers: structuredClone(fixture.trailers) as unknown as Row[],
  loads: structuredClone(fixture.loads) as unknown as Row[],
  problems: [],
  // Held as state rather than returned from the fixture each time: a screen that writes then
  // refetches — which every one of them does — must see what it wrote, or a passing test would be
  // proving only that the fixture is constant.
  workOrder: workOrderDetailFixture(),
  // The walk-around's defects, which the unit-status route derives a verdict from exactly as the
  // API does. Empty unless a test puts one there.
  ptiDefects: [],
  // This week's board rows, when a test has set them; the board route counts them the way the
  // API counts its own.
  ptiBoard: null,
  reimbursements: reimbursementFixture(),
};

/**
 * One reimbursement in each state a screen has to draw.
 *
 * They are ordinary expenses with a `reimbursement` block, because that is what the server
 * returns - the screen is reading an expense from the driver's side, not a record of its own.
 */
function makeReimbursement(id: string, status: string, over: Record<string, unknown> = {}): Row {
  const receiptCents = Number(over.receiptCents ?? 15_000);
  const driverFundedCents = Number(over.driverFundedCents ?? receiptCents);
  return {
    id,
    expenseNumber: `EX-${id.slice(-5)}`,
    sourceKey: `manual:${id}`,
    onDate: '2026-09-23',
    accountingDate: '2026-09-23',
    categoryCode: '5500',
    description: String(over.description ?? 'Lumper at the Fresno DC'),
    amount: receiptCents / 100,
    currency: 'USD',
    provider: null,
    truckId: 'trk_1',
    unitNumber: '412',
    trailerId: null,
    driverId: 'drv_1',
    driverName: 'Remy Calloway',
    loadId: 'ld_1',
    loadNumber: 'NW-2026-08-114872',
    vendorId: null,
    vendorName: null,
    source: 'manual',
    sourceId: null,
    billId: null,
    paymentMethod: 'driver',
    payer: 'driver',
    burden: 'company_borne',
    chargeRecipientId: null,
    allocations: [],
    driverTransactionId: null,
    receiptFileId: status === 'pending' ? 'file_receipt_1' : null,
    accountCode: '5500',
    status: 'posted',
    postedAt: '2026-09-23T12:00:00.000Z',
    notes: null,
    reimbursement: {
      status,
      category: 'lumper',
      receiptCents,
      driverFundedCents,
      currency: 'USD',
      paymentSource: 'driver_personal',
      payerDriverId: 'drv_1',
      payerDriverName: 'Remy Calloway',
      missingReceipt: status === 'pending' ? null : { reason: 'Receipt lost at the dock', authorizedBy: 'Test Admin', authorizedAt: '2026-09-23T12:00:00.000Z' },
      note: 'Paid cash at the dock',
      submittedBy: 'Test Admin',
      submittedAt: '2026-09-23T12:00:00.000Z',
      reviewedBy: status === 'pending' ? null : 'Test Admin',
      reviewedAt: status === 'pending' ? null : '2026-09-24T12:00:00.000Z',
      rejectedReason: status === 'rejected' ? 'No receipt and no authorisation' : null,
      settlementId: status === 'included' || status === 'paid' ? 'stm_1' : null,
      settlementNumber: status === 'included' || status === 'paid' ? 'ST-20260921-CD_1001' : null,
      includedAt: status === 'included' || status === 'paid' ? '2026-09-28T12:00:00.000Z' : null,
      paidAt: status === 'paid' ? '2026-09-29T12:00:00.000Z' : null,
    },
    ...over,
  } as unknown as Row;
}

function reimbursementFixture(): Row[] {
  return [
    makeReimbursement('rb_pending', 'pending'),
    makeReimbursement('rb_approved', 'approved', { description: 'Scale at Effingham', receiptCents: 15_000, driverFundedCents: 6_000 }),
    makeReimbursement('rb_included', 'included', { description: 'Parking, Laredo', receiptCents: 4_200, driverFundedCents: 4_200 }),
    makeReimbursement('rb_paid', 'paid', { description: 'Supplies, Dallas', receiptCents: 9_000, driverFundedCents: 9_000 }),
    makeReimbursement('rb_rejected', 'rejected', { description: 'Unreceipted cash', receiptCents: 7_000, driverFundedCents: 7_000 }),
  ];
}

/** Puts defects on the PTI server for the test that follows; `resetRosterServer` clears them. */
export function servePtiDefects(defects: PtiDefect[]): void {
  store.ptiDefects = defects;
}

/** Puts rows on this week's PTI board for the test that follows. */
export function servePtiBoard(rows: PtiBoardRow[]): void {
  store.ptiBoard = rows;
}

/** Restores the fixture. Called between tests so one test's writes cannot leak into the next. */
/**
 * Puts loads on the server for the test that follows.
 *
 * A test that builds a load in memory and then files a document against it is testing a write
 * the server owns, so the server has to know the load. `resetRosterServer` clears them.
 */
export function serveLoads(rows: { id: string }[]): void {
  for (const row of rows) {
    const at = store.loads.findIndex((l) => l.id === row.id);
    if (at >= 0) store.loads[at] = row as unknown as Row;
    else store.loads.unshift(row as unknown as Row);
  }
}

export function resetRosterServer(): void {
  store.trucks = structuredClone(fixture.trucks) as unknown as Row[];
  store.drivers = structuredClone(fixture.drivers) as unknown as Row[];
  store.trailers = structuredClone(fixture.trailers) as unknown as Row[];
  store.loads = structuredClone(fixture.loads) as unknown as Row[];
  store.problems = [];
  // The browser holds the same rows as the stub, from the same copy: two generator runs are not
  // the same dataset (relative times move), and a lazy refetch would throw away a test's edits.
  primeLoads(store.loads as unknown as Parameters<typeof primeLoads>[0]);
  store.workOrder = workOrderDetailFixture();
  store.ptiDefects = [];
  store.ptiBoard = null;
  store.reimbursements = reimbursementFixture();
  reopenedStatements.clear();
  removedFromSt1.splice(0, removedFromSt1.length, ...REMOVED_FROM_ST1());
  loadPay.clear();
  Object.assign(st1PayFacts, ST1_PAY_FACTS());
  st1PayFactsWrites.length = 0;
}

/** Approved statements reopened in this test: served as drafts again. */
const reopenedStatements = new Set<string>();

/** Loads taken off the draft st_1 ("Not on this statement"), until put back. */
const REMOVED_FROM_ST1 = () => [{ loadId: 'l9', loadNumber: 'L-100009', reason: 'POD not received yet', by: 'Test Admin', at: '2026-10-05T14:00:00.000Z' }];
const removedFromSt1: Array<{ loadId: string; loadNumber: string; reason: string; by: string; at: string }> = REMOVED_FROM_ST1();

/** Real vs For driver of the load on st_1 (owner, 2026-10-23), as the statement reports it. */
const ST1_PAY_FACTS = () => ({ loadId: 'l1', loadNumber: 'L-100006', brokerReference: '123456', loadUpdatedAt: '2026-10-04T15:00:00.000Z', realLinehaulCents: 300000, linehaulCents: 250000, accessorials: [{ id: 'det', type: 'detention', description: 'Detention', realAmountCents: 20000, amountCents: 15000 }] });
const st1PayFacts = ST1_PAY_FACTS();
/** What the statement's pay-facts route was sent, for the tests to read. */
export const st1PayFactsWrites: unknown[] = [];

/** Accounting's pay-date overrides set in this test, per load id. */
const loadPay = new Map<string, { at: string; reason: string; updatedAt: string }>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function page(rows: Row[], url: URL): Response {
  const pageNumber = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '50');
  const start = (pageNumber - 1) * pageSize;
  return json({
    data: rows.slice(start, start + pageSize),
    total: rows.length,
    page: pageNumber,
    pageSize,
  });
}

function nextTruckId(): string {
  const highest = store.trucks.reduce((max, row) => {
    const value = Number.parseInt(String(row.id).replace(/\D/g, ''), 10);
    return Number.isNaN(value) ? max : Math.max(max, value);
  }, 0);
  return `trk_${highest + 1}`;
}

function nextDriverNumber(): number {
  return (
    store.drivers.reduce((max, row) => {
      const value = Number.parseInt(String(row.driverNumber).replace(/\D/g, ''), 10);
      return Number.isNaN(value) ? max : Math.max(max, value);
    }, 2000) + 1
  );
}

/** The account every test is signed in as, matching the administrator the product ships with. */
export const TEST_ACCOUNT = {
  membershipId: 'mbr_test',
  userId: 'usr_test_admin',
  name: 'System Administrator',
  email: 'admin@neway.local',
  companyId: 'cmp_test',
  roles: ['administrator'],
  // The administrator role grants every code; the menu shows only what an account may open.
  permissions: [...PERMISSION_CODES],
  isOwner: false,
  mustChangePassword: false,
  appearance: 'system',
};

/** Installs the stub on `globalThis.fetch`. */
export function installRosterServer(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    /*
     * Who the suite is signed in as.
     *
     * Screens that record who did something read the session rather than a name somebody typed,
     * so a stub with nobody signed in would test the signed-out path on every one of them.
     */
    if (method === 'GET' && path === '/auth/me') {
      // Whatever the test signed in as, permissions included: a screen that hides a control behind
      // a permission code cannot be tested if the session always answers with the same one.
      const stored = ((): Record<string, unknown> => {
        try {
          return JSON.parse(window.localStorage.getItem('neway.session.account') ?? '{}');
        } catch {
          return {};
        }
      })();
      return json({ ...TEST_ACCOUNT, ...stored, signedIn: true });
    }

    if (method === 'GET' && path === '/trucks') return page(store.trucks, url);
    if (method === 'GET' && path === '/trailers') return page(store.trailers, url);

    // ---- loads: one row per load, every write one load with a version check
    // Flags (rule 1.10): the stub keeps them in memory for the session.
    if (method === 'GET' && path.startsWith('/load-problems')) return json(store.problems.filter((p) => !p.closedAt));
    const problemRoute = /^\/loads\/([^/]+)\/problems(?:\/([^/]+)\/close)?$/.exec(path);
    if (problemRoute) {
      const loadId = decodeURIComponent(problemRoute[1] ?? '');
      if (method === 'GET') return json(store.problems.filter((p) => p.loadId === loadId));
      if (method === 'POST' && !problemRoute[2]) {
        const input = body as { kind: string; note: string };
        const problem: LoadProblem = {
          id: `lpr_${store.problems.length + 1}`,
          loadId,
          loadNumber: String((store.loads.find((l) => l.id === loadId) as { loadNumber?: string } | undefined)?.loadNumber ?? loadId),
          kind: input.kind as LoadProblem['kind'],
          note: input.note,
          openedById: TEST_ACCOUNT.userId,
          openedByName: TEST_ACCOUNT.name,
          openedAt: new Date().toISOString(),
          closedById: null,
          closedByName: null,
          closedAt: null,
          closeNote: null,
        };
        store.problems.push(problem);
        return json(problem, 201);
      }
      if (method === 'POST' && problemRoute[2]) {
        const problem = store.problems.find((p) => p.id === problemRoute[2]);
        if (!problem) return json({ title: 'Not Found', detail: 'No such flag', status: 404 }, 404);
        Object.assign(problem, { closedAt: new Date().toISOString(), closedById: TEST_ACCOUNT.userId, closedByName: TEST_ACCOUNT.name, closeNote: (body as { note: string }).note });
        return json(problem);
      }
    }
    // Accounting lives on the server (2026-09-27); the stub answers its reads empty.
    /*
     * Reimbursements, as the server returns them: an expense with a review block on it.
     *
     * One of each state, so the four summary cards, the status column and the review drawer all
     * have something real to render rather than an empty table.
     */
    /*
     * The receipt bytes. A real one-pixel PNG, served with its type, so the preview is exercised on
     * the bytes it will meet; `file_missing` answers 404 so the Retry path is too.
     */
    // A driver / candidate document route is read through a signed link (2026-10-25): the stub signs
    // every path and answers the signed request like the plain one.
    if (method === 'GET' && path === '/files/sign') {
      const target = url.searchParams.get('path') ?? '';
      return json({ url: `${target}${target.includes('?') ? '&' : '?'}sig=stub`, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    }
    // A stored file is read through a signed link (2026-10-25): the link first, then its bytes.
    if (method === 'GET' && /^\/files\/[^/]+\/link$/.test(path)) {
      const id = decodeURIComponent(path.slice('/files/'.length, -'/link'.length));
      if (id === 'file_missing') return json({ title: 'Not Found', detail: 'No such file', status: 404 }, 404);
      return json({ url: `/api/v1/files/signed?t=${encodeURIComponent(id)}`, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    }
    if (method === 'GET' && (path.startsWith('/files/') || path === '/files/signed')) {
      const id = path === '/files/signed' ? (url.searchParams.get('t') ?? '') : decodeURIComponent(path.slice('/files/'.length));
      if (id === 'file_missing') return json({ title: 'Not Found', detail: 'No such file', status: 404 }, 404);
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (method === 'GET' && path === '/accounting/reimbursements/load-options') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const rows = [
        { id: 'ld_1', loadNumber: 'NW-2026-08-114872', route: 'Laredo, TX → Atlanta, GA', deliveredOn: '2026-09-23', driverId: 'drv_1', driverName: 'Remy Calloway', coDriverId: null, coDriverName: null, truckId: 'trk_1', truckUnit: '412', onThisDriver: true },
        { id: 'ld_2', loadNumber: 'NW-2026-08-114903', route: 'Atlanta, GA → Charlotte, NC', deliveredOn: '2026-09-24', driverId: 'drv_2', driverName: 'Marcus Bell', coDriverId: null, coDriverName: null, truckId: 'trk_2', truckUnit: '308', onThisDriver: false },
      ];
      return json(rows.filter((r) => !q || r.loadNumber.toLowerCase().includes(q)));
    }
    // Settlements for one week: a preview, a batch with two statements, and one driver to check.
    if (method === 'GET' && path === '/accounting/settlements/preview') {
      const weekOf = url.searchParams.get('weekOf');
      const add = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
      const monday = (d: string) => add(d, -((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7));
      // The page opens on the real today, for which the fixture's week (Sep 28) stands in; any other week asked for is that week.
      const nowMonday = monday(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
      const start = !weekOf || monday(weekOf) === nowMonday ? '2026-09-28' : monday(weekOf);
      return json({ kind: 'cd', period: { start, end: add(start, 6), cutoffAt: add(start, 7) + 'T16:00:00.000Z', payDate: add(start, 10) }, timezone: 'America/New_York', cutoffBasis: 'delivered_at', previewBasis: 'delivered_at', setup: [], canGenerate: true, existingBatch: { id: 'bat_1', status: 'open', statements: 2 }, lateLoads: 0, loadsInWeek: 2, drivers: [{ driverId: 'drv_1', driverNumber: 'D-2001', name: 'Ulugbek Rakhmonov', unitNumber: '0008', contractType: 'CD', loads: [{ loadId: 'l1', loadNumber: 'L-100006', grossCents: 300000, cents: 90000, blockers: [] }], grossCents: 570000, earnedCents: 171000, blockers: [], statementStatus: 'draft' }] });
    }
    if (method === 'GET' && path === '/accounting/settlements/batches') {
      return json([{ id: 'bat_1', kind: 'cd', periodStart: '2026-09-28', periodEnd: '2026-10-04', cutoffAt: '2026-10-05T18:00:00.000Z', payDate: '2026-10-08', timezone: 'America/New_York', cutoffBasis: 'delivered_at', status: 'open', generatedAt: '', generatedBy: '', statementIds: ['st_1', 'st_2'], lateLoads: [], totals: { count: 2, signedNetCents: 257400, payableCents: 257400, carryCents: 0 }, closedAt: null, notes: null }]);
    }
    if (method === 'GET' && path === '/accounting/settlements') {
      const st = (id: string, name: string, number: string, status: string, gross: number, ded: number) => ({ id, settlementNumber: number, batchId: 'bat_1', kind: 'cd', partyType: 'driver', partyId: `drv_${id}`, partyName: name, truckId: null, unitNumber: '0008', periodStart: '2026-09-28', periodEnd: '2026-10-04', payDate: '2026-10-08', status, netCents: gross - ded, payableCents: gross - ded, carryCents: 0, computation: { grossCents: gross, reimbursementsCents: 0, deductionsCents: ded, escrowCents: 0, earnings: [], deductions: [], openingDebtCents: 0, closingDebtCents: 0 }, vendor: null, exceptions: [], snapshot: null, versions: [] });
      return json([st('st_1', 'Ulugbek Rakhmonov', 'ST-20260928-V_2001', 'draft', 120000, 36100), st('st_2', 'CHANEL SEARS', 'ST-20260928-V_2002', 'approved', 208500, 35000)]);
    }
    // Reopening an approved statement: the reason is required; it is a draft from then on.
    if (method === 'POST' && /^\/accounting\/settlements\/st_[12]\/reopen$/.test(path)) {
      const reason = String((body as { reason?: string }).reason ?? '');
      if (reason.trim().length < 3) return json({ title: 'Unprocessable', detail: 'A reason is required', status: 422 }, 422);
      const id = path.split('/').at(-2)!;
      if (id !== 'st_2') return json({ ok: false, blocked: 'ST-20260928-V_2001 is a draft; only an approved statement is reopened.', statement: null });
      reopenedStatements.add(id);
      return json({ ok: true, statement: { id, status: 'draft' } });
    }
    // A load taken off the draft st_1 and put back, one click each.
    const stLoad = /^\/accounting\/settlements\/st_1\/loads\/([^/]+)\/(remove|put-back)$/.exec(path);
    if (method === 'POST' && stLoad) {
      const [, loadId, action] = stLoad;
      if (action === 'put-back') {
        const at = removedFromSt1.findIndex((r) => r.loadId === loadId);
        if (at < 0) return json({ ok: false, blocked: 'That load was not taken off this statement.', statement: null });
        removedFromSt1.splice(at, 1);
        return json({ ok: true, statement: { id: 'st_1', status: 'draft' } });
      }
      removedFromSt1.push({ loadId: loadId!, loadNumber: loadId === 'l1' ? 'L-100006' : loadId!, reason: String((body as { reason?: string }).reason ?? ''), by: 'System Administrator', at: '2026-10-06T14:00:00.000Z' });
      return json({ ok: true, statement: { id: 'st_1', status: 'draft' }, carriedTo: null });
    }
    // Real vs For driver and the REF, corrected on the draft st_1 (owner, 2026-10-23).
    if (method === 'POST' && path === '/accounting/settlements/st_1/loads/l1/pay-facts') {
      const input = body as { expectedUpdatedAt: string; driverRate?: number | null; charges?: Array<{ chargeId: string; driverAmount: number | null }>; brokerReference?: string };
      if (input.expectedUpdatedAt !== st1PayFacts.loadUpdatedAt) return json({ title: 'Conflict', detail: 'L-100006 changed since you opened it.', status: 409 }, 409);
      st1PayFactsWrites.push(body);
      if (input.driverRate !== undefined) st1PayFacts.linehaulCents = input.driverRate === null ? st1PayFacts.realLinehaulCents : Math.round(input.driverRate * 100);
      for (const ch of input.charges ?? []) {
        const a = st1PayFacts.accessorials.find((x) => x.id === ch.chargeId);
        if (a) a.amountCents = ch.driverAmount === null ? a.realAmountCents : Math.round(ch.driverAmount * 100);
      }
      if (input.brokerReference !== undefined) st1PayFacts.brokerReference = input.brokerReference;
      st1PayFacts.loadUpdatedAt = '2026-10-06T15:00:00.000Z';
      return json({ statement: { id: 'st_1', status: 'draft' } });
    }
    // When a load counts for pay, and Accounting's "Counts for pay on".
    const payRoute = /^\/accounting\/loads\/([^/]+)\/(pay|pay-date)$/.exec(path);
    if (payRoute) {
      const [, loadId, what] = payRoute;
      const delivered = '2026-10-19T23:30:00.000Z';
      const view = () => {
        const o = loadPay.get(loadId!);
        const at = o?.at ?? delivered;
        const inA = at < '2026-10-19T16:00:00.000Z';
        return { loadId, loadNumber: 'L-100245', status: 'delivered', updatedAt: o?.updatedAt ?? '2026-10-20T01:00:00.000Z', deliveredAt: delivered, completedAt: delivered, basis: 'delivered_at', payAt: at, source: o ? 'override' : 'completed', override: o ? { at: o.at, reason: o.reason, by: 'usr_test_admin', byName: 'System Administrator', changedAt: '2026-10-20T15:00:00.000Z', previousAt: delivered } : null, timezone: 'America/New_York', statements: [], period: inA ? { start: '2026-10-12', end: '2026-10-18', startsAt: '2026-10-12T16:00:00.000Z', cutoffAt: '2026-10-19T16:00:00.000Z', payDate: '2026-10-22', timezone: 'America/New_York', label: 'Mon Oct 12, 12:00 PM – Mon Oct 19, 12:00 PM ET' } : { start: '2026-10-19', end: '2026-10-25', startsAt: '2026-10-19T16:00:00.000Z', cutoffAt: '2026-10-26T16:00:00.000Z', payDate: '2026-10-29', timezone: 'America/New_York', label: 'Mon Oct 19, 12:00 PM – Mon Oct 26, 12:00 PM ET' } };
      };
      if (method === 'GET' && what === 'pay') return json(view());
      if (method === 'POST' && what === 'pay-date') {
        const input = body as { at?: string | null; reason?: string; expectedUpdatedAt?: string };
        if (String(input.reason ?? '').trim().length < 3) return json({ title: 'Unprocessable', detail: 'Say why (at least 3 characters)', status: 422 }, 422);
        if (input.expectedUpdatedAt !== view().updatedAt) return json({ title: 'Conflict', detail: 'L-100245 changed since you opened it. Reload the load and try again.', status: 409 }, 409);
        if (input.at) loadPay.set(loadId!, { at: input.at, reason: String(input.reason), updatedAt: '2026-10-20T15:00:00.000Z' });
        else loadPay.delete(loadId!);
        return json(view());
      }
    }
    // One statement read on its own, itemised, and its driver's account.
    if (method === 'GET' && /^\/accounting\/settlements\/st_[12]$/.test(path)) {
      const draft = path.endsWith('st_1') || reopenedStatements.has('st_2');
      return json({ id: draft ? 'st_1' : 'st_2', settlementNumber: draft ? 'ST-20260928-V_2001' : 'ST-20260928-V_2002', batchId: 'bat_1', kind: 'cd', partyType: 'driver', partyId: draft ? 'drv_st_1' : 'drv_st_2', partyName: draft ? 'Ulugbek Rakhmonov' : 'CHANEL SEARS', truckId: null, unitNumber: '0008', periodStart: '2026-09-28', periodEnd: '2026-10-04', startsAt: '2026-09-28T16:00:00.000Z', cutoffAt: '2026-10-05T16:00:00.000Z', payDate: '2026-10-08', status: draft ? 'draft' : 'approved', loadIds: ['l1'], removedLoads: draft && path.endsWith('st_1') ? removedFromSt1 : [], netCents: 83900, payableCents: 83900, carryCents: 0, exceptions: [], vendor: null, snapshot: null, versions: [],
        computation: { grossCents: 120000, reimbursementsCents: 0, deductionsCents: 36100, escrowCents: 0, netCents: 83900, payableCents: 83900, carryCents: 0, openingDebtCents: 36100, closingDebtCents: 0, escrowBalanceAfterCents: null, loadCount: 1, totalMiles: 0, exceptions: [], excluded: [], recoveries: [], recurringCharges: [], loadFacts: [structuredClone(st1PayFacts)],
          earnings: [{ kind: 'percentage', loadId: 'l1', loadNumber: 'L-100006', route: 'Dallas, TX -> Atlanta, GA', rateLabel: '30%', description: 'Load pay', cents: 120000, basis: '30%' }],
          deductions: [{ kind: 'debt_recovery', description: 'Recovery · Cracked mirror', cents: 36100, onDate: '2026-10-04', txId: 'dtx_mirror', basis: 'oldest first' }] } });
    }
    if (method === 'GET' && path === '/accounting/drivers/drv_st_1/account') {
      return json({ driverId: 'drv_st_1', name: 'Ulugbek Rakhmonov', profile: { driverId: 'drv_st_1', version: 1, record: { versions: [], openingDebtCents: 0, openingDebtReconciled: true, notes: [] }, current: null, defaulted: false }, debt: { openingCents: 0, newChargesCents: 36100, recoveredCents: 0, closingCents: 36100, open: [] }, escrow: null, pendingDeductionsCents: 0, currentPayableCents: 0, paidToDateCents: 0, companyCosts: [], recurring: [], statements: [], history: [],
        transactions: [{ id: 'dtx_mirror', driverId: 'drv_st_1', kind: 'manual_charge', onDate: '2026-10-04', amountCents: 36100, recoveredCents: 0, state: 'approved', source: 'manual', sourceKey: 'x', truckId: null, loadId: null, settlementId: null, description: 'Cracked mirror', companyCost: false }] });
    }
    if (method === 'GET' && path === '/accounting/drivers/review') {
      return json([{ driverId: 'drv_elsewhere', driverNumber: 'D-9999', name: 'Not Paid This Week', contractType: 'CD', plan: null, rate: null, rateConfirmed: false, profileSaved: false, issues: [{ kind: 'plan_unreviewed', label: 'Plan', detail: 'x' }], completedLoads: 0, earnedPreviewCents: null, blockedLoads: 0 }, { driverId: 'drv_st_2', driverNumber: 'D-2002', name: 'CHANEL SEARS', contractType: 'CD', plan: { kind: 'percent_of_gross', rate: 30, basis: 'gross' }, rate: null, rateConfirmed: true, profileSaved: true, issues: [{ kind: 'no_payee', label: 'No payee', detail: 'No bank details on file' }], completedLoads: 2, earnedPreviewCents: 208500, blockedLoads: 0 }]);
    }
    if (method === 'GET' && path === '/accounting/payees') return json([]);
    // One invoice family: the issued original and a draft revision, for the revisions panel.
    if (method === 'GET' && /^\/accounting\/invoices\/inv_rev1(\/family|\/revision-options|\/supplements)?$/.test(path)) {
      const line = (id: string, chargeType: string, description: string, amount: number) => ({ id, invoiceId: 'inv_rev1', loadId: 'ld_1', chargeType, description, quantity: 1, rate: amount, amount });
      const original = { id: 'inv_rev1', invoiceNumber: 'INV-10004', family: 'INV-10004', revision: 1, isCurrent: true, status: 'issued', total: 2150, paid: 1000, balance: 1150, billToName: 'TEST Broker Co', loadId: 'ld_1', loadNumber: 'TEST-L-1', issuedOn: '2026-09-29', dueOn: '2026-10-29', lines: [line('l1', 'linehaul', 'Linehaul', 2150)], invoiceNote: null, internalNotes: [{ id: 'n1', text: 'Broker called about detention', by: 'Test Admin', at: '2026-09-29T12:00:00Z', edits: [] }], draftRevisionId: null, submission: { status: 'prepared' }, updatedAt: '2026-09-29T12:00:00Z', revisions: [], history: [] };
      if (path.endsWith('/supplements')) return json({ check: { ok: false, reason: 'INV-10004 has not been sent to RTS yet. Add the charge to it with Create revision instead.', useRevision: true }, supplements: [] });
      if (path.endsWith('/family')) return json([original]);
      if (path.endsWith('/revision-options')) return json({ charges: [{ id: 'ch_det', chargeType: 'detention', description: 'Detention', amount: 150 }], documents: [{ id: 'doc_ap', type: 'detention', fileName: 'broker-approval.pdf' }] });
      return json(original);
    }
    // An invoice already sent to RTS, with one supplemental invoice (a layover billed after it).
    if (method === 'GET' && /^\/accounting\/invoices\/inv_sent1(\/family|\/revision-options|\/supplements)?$/.test(path)) {
      const sent = { id: 'inv_sent1', invoiceNumber: 'INV-10010', family: 'INV-10010', revision: 1, isCurrent: true, status: 'submitted', total: 2000, paid: 0, balance: 2000, billToName: 'TEST Broker Co', billToType: 'broker', billToId: 'brk_1', loadId: 'ld_2', loadNumber: 'TEST-L-2', issuedOn: '2026-10-14', dueOn: '2026-11-13', paymentTermsDays: 30, lines: [{ id: 'ls1', invoiceId: 'inv_sent1', loadId: 'ld_2', chargeType: 'linehaul', description: 'Linehaul', quantity: 1, rate: 2000, amount: 2000 }], invoiceNote: null, internalNotes: [], draftRevisionId: null, submission: { provider: 'RTS', status: 'submitted', reference: 'RTS FTPS RTS-00003.csv', at: '2026-10-14T15:00:00Z', issues: [], by: 'Test Admin' }, factoring: { billViaFactoring: true, fundedGross: 0, feeCents: 0, reserveCents: 0, fundingIds: [] }, rtsBatch: { batchId: 'rtsb_3', batchNumber: 'RTS-00003' }, updatedAt: '2026-10-14T15:00:00Z', revisions: [], history: [] };
      const s1 = { ...sent, id: 'inv_sent1_s1', invoiceNumber: 'INV-10010-S1', family: 'INV-10010-S1', status: 'issued', total: 150, balance: 150, lines: [{ id: 'lx', invoiceId: 'inv_sent1_s1', loadId: 'ld_2', chargeType: 'lumper', description: 'Lumper', quantity: 1, rate: 150, amount: 150 }], submission: { provider: 'RTS', status: 'prepared', reference: null, at: null, issues: [], by: null }, rtsBatch: null, supplementOf: { invoiceId: 'inv_sent1', invoiceNumber: 'INV-10010', family: 'INV-10010', sequence: 1, reason: 'Lumper receipt came in', requestKey: 'sup-x' } };
      if (path.endsWith('/supplements')) return json({ check: { ok: true, why: 'INV-10010 has been sent to RTS (submitted)' }, supplements: [s1] });
      if (path.endsWith('/family')) return json([sent]);
      if (path.endsWith('/revision-options')) return json({ charges: [], documents: [{ id: 'doc_bol', type: 'bol', fileName: 'bol.pdf' }, { id: 'doc_lay', type: 'layover', fileName: 'layover-receipt.jpg' }] });
      return json(sent);
    }
    // RTS export batches: one eligible invoice, one that says why it cannot be chosen, one batch.
    if (method === 'GET' && path === '/accounting/rts/candidates') {
      return json([
        { invoiceId: 'inv_ok', invoiceNumber: 'INV-20001', loadNumber: 'TEST-L-1', debtor: 'TEST Broker Co', issuedOn: '2026-09-28', status: 'issued', totalCents: 300_000, documents: [{ id: 'd1', type: 'rate_confirmation', fileName: 'rc.pdf', stillCurrent: true, hasBytes: true }, { id: 'd2', type: 'pod', fileName: 'pod.pdf', stillCurrent: true, hasBytes: true }, { id: 'd3', type: 'bol', fileName: 'bol.pdf', stillCurrent: true, hasBytes: true }], inBatch: null, eligibility: { eligible: true, reasons: [], warnings: [] } },
        { invoiceId: 'inv_draft', invoiceNumber: 'INV-20002', loadNumber: 'TEST-L-2', debtor: 'TEST Broker Co', issuedOn: null, status: 'draft', totalCents: 90_000, documents: [], inBatch: null, eligibility: { eligible: false, reasons: ['Still a draft: issue it first.'], warnings: [] } },
      ]);
    }
    if (method === 'GET' && path === '/accounting/rts/batches') {
      return json([{ id: 'rtsb_1', batchNumber: 'RTS-00001', status: 'exported', lines: [], count: 2, totalCents: 480_000, createdAt: '2026-09-29T12:00:00Z', createdBy: 'Test Admin', exports: [{ at: '2026-09-29T12:05:00Z', by: 'Test Admin', fileName: 'RTS-00001_RTS_package.zip', sha256: 'ab'.repeat(32), bytes: 20480 }], submission: null, cancellation: null, history: [] }]);
    }
    if (method === 'GET' && path === '/accounting/reimbursements') {
      const status = url.searchParams.get('status');
      const rows = store.reimbursements.filter((r) => !status || r.reimbursement.status === status);
      return json(rows);
    }
    if (method === 'GET' && path === '/accounting/reimbursements/summary') {
      return json({ byCurrency: [{ currency: 'USD', totals: { pendingCount: 1, pendingCents: 15_000, approvedCount: 1, approvedCents: 6_000, includedCount: 1, includedCents: 4_200, paidCount: 1, paidCents: 9_000 } }] });
    }
    if (method === 'GET' && path.startsWith('/accounting/reimbursements/')) {
      const id = path.split('/').pop();
      const row = store.reimbursements.find((r) => r.id === id);
      if (!row) return json({ title: 'Not Found', detail: 'No such reimbursement', status: 404 }, 404);
      return json(row);
    }
    if (method === 'POST' && path.endsWith('/review') && path.startsWith('/accounting/reimbursements/')) {
      const id = path.split('/').at(-2);
      const row = store.reimbursements.find((r) => r.id === id);
      if (!row) return json({ title: 'Not Found', detail: 'No such reimbursement', status: 404 }, 404);
      const decision = (body as { decision?: string }).decision;
      row.reimbursement = { ...row.reimbursement, status: decision === 'approve' ? 'approved' : 'rejected', reviewedBy: 'Test Admin', reviewedAt: '2026-09-29T12:00:00.000Z' };
      return json(row);
    }
    if (method === 'POST' && path === '/accounting/reimbursements') {
      const row = makeReimbursement('rb_new', 'pending', { description: String((body as { description?: string }).description ?? 'New reimbursement') });
      store.reimbursements.push(row);
      return json({ ok: true, expense: row }, 201);
    }

    if (method === 'GET' && path.startsWith('/accounting/')) {
      if (path.startsWith('/accounting/ledger')) return json({ journal: [], periods: [] });
      if (path.startsWith('/accounting/settings')) return json({ version: 0, settings: {}, problems: [], dispatcherPeriodAnchor: null, integrations: {} });
      if (path.startsWith('/accounting/billing/queue')) return json({ rows: [], counts: {}, totals: {} });
      if (/^\/accounting\/drivers\/[^/]+\/account$/.test(path)) return json({ driverId: 'x', name: null, profile: { driverId: 'x', version: 0, record: { versions: [], openingDebtCents: null, openingDebtReconciled: false, notes: [] }, current: null, defaulted: true }, debt: { openingCents: null, newChargesCents: 0, recoveredCents: 0, closingCents: null, open: [] }, escrow: null, pendingDeductionsCents: 0, currentPayableCents: 0, paidToDateCents: 0, companyCosts: [], transactions: [], recurring: [], statements: [], history: [] });
      return json([]);
    }
    if (method === 'GET' && path === '/loads') return json(store.loads);
    const loadRead = /^\/loads\/([^/]+)$/.exec(path);
    if (method === 'GET' && loadRead) {
      const id = decodeURIComponent(loadRead[1] ?? '');
      const row = store.loads.find((l) => l.id === id || l.loadNumber === id);
      return row ? json(row) : json({ title: 'Not Found', detail: `No load '${id}'.`, status: 404 }, 404);
    }
    if (method === 'POST' && path === '/loads') {
      const loadNumber = String(body.loadNumber ?? '').trim();
      if (store.loads.some((l) => l.loadNumber === loadNumber)) {
        return json({ title: 'Conflict', detail: `Load ${loadNumber} already exists.`, status: 409 }, 409);
      }
      const now = new Date().toISOString();
      const load: Row = {
        ...body,
        id: (body.id as string) || `ld_${loadNumber.replace(/^L-/, '')}`,
        status: String(body.status ?? 'booked'),
        createdAt: (body.createdAt as string) ?? now,
        updatedAt: now,
      };
      store.loads.unshift(load);
      return json({ load, collectionUpdatedAt: now }, 201);
    }
    const loadPatch = /^\/loads\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && loadPatch) {
      const id = decodeURIComponent(loadPatch[1] ?? '');
      const load = store.loads.find((l) => l.id === id || l.loadNumber === id);
      if (!load) return json({ title: 'Not Found', detail: `No load '${id}'.`, status: 404 }, 404);
      if (load.updatedAt !== body.expectedUpdatedAt) {
        return json({ title: 'Conflict', detail: `${String(load.loadNumber)} changed since you opened it.`, status: 409 }, 409);
      }
      const patch = (body.patch ?? {}) as Record<string, unknown>;
      const refused = ['status', 'driverId', 'truckId', 'trailerId', 'timeline'].filter((k) => k in patch);
      if (refused.length > 0) {
        return json({ title: 'Unprocessable Entity', detail: `${refused.join(', ')} cannot be changed through Edit.`, status: 422 }, 422);
      }
      Object.assign(load, patch, { updatedAt: new Date().toISOString() });
      // The server writes the edit's own timeline line from the words the screen sent.
      if (typeof body.summary === 'string' && body.summary) {
        const timeline = (load.timeline ?? []) as unknown[];
        load.timeline = [...timeline, { id: `evt_edit_${timeline.length + 1}`, at: load.updatedAt, kind: 'note_added', actorType: 'user', actorName: 'Test', title: 'Load edited', detail: body.summary, stopId: null }];
      }
      return json({ load, collectionUpdatedAt: load.updatedAt });
    }
    /*
     * The per-load writes run the same pure rules the server runs, so the stub refuses what the
     * server refuses and files what it files - a stub that is kinder than the API would let a
     * screen pass here and fail in front of somebody.
     */
    const loadAction = /^\/loads\/([^/]+)\/(assignment|documents|status|stop-event|cancel|notes|check-call|confirm)$/.exec(path);
    if (method === 'POST' && loadAction) {
      const id = decodeURIComponent(loadAction[1] ?? '');
      const at = store.loads.findIndex((l) => l.id === id || l.loadNumber === id);
      const record = store.loads[at] as unknown as StoredLoad | undefined;
      if (!record) return json({ title: 'Not Found', detail: `No load '${id}'.`, status: 404 }, 404);
      const now = new Date().toISOString();
      const actor = { id: TEST_ACCOUNT.userId, name: TEST_ACCOUNT.name, isLead: true };
      const input = body as never;
      const result =
        loadAction[2] === 'assignment'
          ? applyAssignment(record, input, actor, now)
          : loadAction[2] === 'documents'
            ? applyAttachDocument(record, input, actor, now)
            : loadAction[2] === 'status'
              ? applyStatusChange(record, input, actor, now)
              : loadAction[2] === 'stop-event'
                ? applyStopEvent(record, input, actor, now)
                : loadAction[2] === 'cancel'
                  ? applyCancel(record, input, actor, now)
                  : loadAction[2] === 'check-call'
                    ? applyCheckCall(record, input, actor, now)
                    : loadAction[2] === 'confirm'
                      ? applyConfirmUpload(record, input, actor, now)
                      : applyAddNote(record, input, actor, now);
      if (!result.ok) {
        const status = result.refusal.code === 'conflict' ? 409 : result.refusal.code === 'forbidden' ? 403 : result.refusal.code === 'not_found' ? 404 : 422;
        return json({ title: 'Refused', detail: result.refusal.message, status }, status);
      }
      store.loads[at] = result.record as unknown as Row;
      return json({ load: result.record, collectionUpdatedAt: result.record.updatedAt });
    }

    /*
     * The performance board, with two dispatchers and a driver under each — enough to render the
     * podium, the drill-down and the reader's own line, which is where the page can actually throw.
     */
    if (method === 'GET' && path === '/dispatch/performance') {
      const driverRow = (name: string, gross: number) => ({
        driverId: `drv_${name}`,
        name,
        payTag: 'C',
        truckUnit: '2785',
        loads: 1,
        cancelled: 0,
        gross,
        miles: 1000,
        rpm: gross / 1000,
        avgWeightLbs: 40000,
        onTimePickupPct: null,
        onTimeDeliveryPct: null,
        onTimePct: null,
        rpmPct: 110,
        efficiencyPct: 90,
        activityPct: 70,
        overall: 90,
      });
      const row = (id: string, name: string, rank: number, gross: number) => ({
        dispatcherId: id,
        dispatcherName: name,
        rank,
        movement: rank === 1 ? 2 : null,
        drivers: 1,
        trucks: 1,
        loads: 1,
        cancelled: 0,
        gross,
        grossPerTruck: gross,
        miles: 1000,
        rpm: gross / 1000,
        avgWeightLbs: 40000,
        onTimePickupPct: null,
        onTimeDeliveryPct: null,
        onTimePct: null,
        rpmPct: 110,
        efficiencyPct: 90,
        activityPct: 70,
        overall: rank === 1 ? 90 : 70,
        behindPct: rank === 1 ? null : 22.2,
        driverRows: [driverRow(`${name} driver`, gross)],
      });
      return json({
        from: '2026-09-21T00:00:00.000Z',
        to: '2026-09-27T23:59:59.999Z',
        weeks: 1,
        label: 'ISO week 39 · 2026-09-21 – 2026-09-27',
        previousLabel: 'ISO week 38 · 2026-09-14 – 2026-09-20',
        targets: {
          rpm: 2.9,
          grossPerTruckWeek: 10000,
          milesPerTruckWeek: 5000,
          weights: { onTime: 0.25, rpm: 0.25, efficiency: 0.25, activity: 0.25 },
        },
        rows: [row('d1', 'MAX', 1, 9000), row('d2', 'ADIN', 2, 7000)],
        summary: {
          dispatchers: 2,
          loads: 2,
          cancelled: 0,
          gross: 16000,
          miles: 2000,
          rpm: 8,
          onTimePct: null,
          avgOverall: 80,
          efficiencyPct: 80,
        },
      });
    }
    // The one dispatcher list (2026-09-21): whoever dispatches the seeded drivers, as employees.
    if (method === 'GET' && path === '/employees/dispatchers') {
      const seen = new Map<string, string>();
      for (const d of store.drivers)
        if (!seen.has(String(d.dispatcherId)))
          seen.set(String(d.dispatcherId), String(d.dispatcherName));
      return json(
        [...seen].map(([id, name], i) => ({
          id,
          employeeNumber: 'EMP-' + String(1001 + i),
          name,
          status: 'active',
          active: true,
          position: 'Dispatcher',
        })),
      );
    }
    if (method === 'GET' && path === '/drivers') return page(store.drivers, url);

    // The board for a week, counted the way PtiService counts it (§7.1).
    if (method === 'GET' && path === '/fleet/pti/board' && store.ptiBoard) {
      const rows = store.ptiBoard;
      const queues = { chase: 0, review: 0, defects: 0, verify: 0 };
      for (const row of rows) for (const queue of queuesFor(row)) queues[queue] += 1;
      const board: PtiBoard = {
        weekStart: rows[0]?.inspection.weekStart ?? '2026-09-14',
        dueAt: '2026-09-16',
        today: '2026-09-17',
        rows,
        queues,
        quiet: {
          cleanAndClosed: rows.filter((r) => queuesFor(r).length === 0 && !r.inShop).length,
          inShopExempt: rows.filter((r) => r.inShop).length,
          dueSoon: 0,
        },
      };
      return json(board);
    }
    if (method === 'GET' && /^\/fleet\/pti\/units\/[^/]+\/inspections$/.test(path)) return json([]);
    if (method === 'GET' && path === '/fleet/pti/assignees') {
      return json([
        { id: 'usr_test_admin', name: 'System Administrator', roles: ['administrator'] },
      ]);
    }

    // The unit's service verdict (§4.2), derived here the way PtiService derives it.
    const unitStatus = /^\/fleet\/pti\/units\/([^/]+)\/status$/.exec(path);
    if (method === 'GET' && unitStatus) {
      const open = store.ptiDefects.filter(
        (d) => d.unitId === unitStatus[1] && isOpenDefectState(d.state),
      );
      return json({ verdict: unitServiceStatus(open), defects: open });
    }

    // The server-aggregated expense summary; the fixture echoes the period and units it was asked
    // for so a test can assert the page sent them.
    if (method === 'GET' && path === '/fleet/expense-summary') {
      const fixture = fleetExpenseFixture();
      const period = url.searchParams.get('period') ?? 'year';
      const units = (url.searchParams.get('units') ?? '').split(',').filter(Boolean);
      return json({
        ...fixture,
        meta: {
          ...fixture.meta,
          period: { ...fixture.meta.period, preset: period },
          filters: {
            units,
            unknownUnits: [],
            unitType: (url.searchParams.get('unitType') ?? 'all') as 'all' | 'truck' | 'trailer',
          },
        },
      });
    }

    /*
     * The shop's board and the work orders behind it.
     *
     * Served from a fixture with no cost field on it, which is what the endpoint does for a reader
     * without the cost permission — so a page that grew a total would have nothing to read it
     * from, here or in production.
     */
    if (method === 'GET' && path === '/fleet/today') return json(fleetTodayFixture());
    if (method === 'GET' && path === '/fleet/work-orders/wo_1') return json(store.workOrder);
    if (method === 'GET' && path === '/fleet/units') {
      const trailers = url.searchParams.get('assetType') === 'trailer';
      return json({
        data: trailers
          ? [
              {
                id: 'trl_5502',
                unitNumber: '5502',
                description: '2018 Wabash dry van',
                odometer: null,
              },
            ]
          : [
              {
                id: 'trk_3008',
                unitNumber: '3008',
                description: '2021 Freightliner Cascadia',
                odometer: 452_000,
              },
              {
                id: 'trk_3021',
                unitNumber: '3021',
                description: '2022 Volvo VNL',
                odometer: 311_400,
              },
            ],
      });
    }
    if (method === 'POST' && path === '/fleet/work-orders') {
      return json({ ...workOrderDetailFixture(), id: 'wo_new', number: 'RO-2026-0042', ...body });
    }
    if (method === 'POST' && path === '/fleet/work-orders/wo_1/stage') {
      const stage = String(body.stage ?? '') as WorkOrderDetail['shopStage'];
      store.workOrder = {
        ...store.workOrder,
        shopStage: stage,
        actions: [
          ...store.workOrder.actions,
          {
            id: `woa_stage_${store.workOrder.actions.length}`,
            action: 'stage_changed',
            stage,
            note: body.note ? String(body.note) : null,
            userName: TEST_ACCOUNT.name,
            createdAt: '2026-09-17T19:30:00.000Z',
          },
        ],
      };
      return json(store.workOrder);
    }
    if (method === 'POST' && path === '/fleet/work-orders/wo_1/complete') {
      // The same refusal the server gives: a completed record with no description cannot be
      // audited, and the shop has gone home by the time anyone notices.
      if (!String(body.workDone ?? '').trim()) {
        return json(
          {
            title: 'Invalid request',
            detail: 'Say what was done before completing it',
            status: 400,
          },
          400,
        );
      }
      store.workOrder = {
        ...store.workOrder,
        status: 'completed',
        workDone: String(body.workDone),
        completedAt: '2026-09-17T19:30:00.000Z',
        // Frozen at completion, which is why the page stops counting.
        downtimeMinutes: 13_350,
        actions: [
          ...store.workOrder.actions,
          {
            id: 'woa_done',
            action: 'completed',
            stage: store.workOrder.shopStage,
            note: String(body.workDone),
            userName: TEST_ACCOUNT.name,
            createdAt: '2026-09-17T19:30:00.000Z',
          },
        ],
      };
      return json(store.workOrder);
    }

    if (method === 'GET' && path === '/compliance/requirements')
      return json(compliance.requirements);
    if (method === 'GET' && path === '/compliance/items') {
      const scope = url.searchParams.get('scope');
      const entityId = url.searchParams.get('entityId');
      return json(
        compliance.items.filter(
          (i) => (!scope || i.scope === scope) && (!entityId || i.entityId === entityId),
        ),
      );
    }
    if (method === 'GET' && path === '/compliance/documents') return json(compliance.documents);
    if (method === 'GET' && path === '/compliance/consents') return json(compliance.consents);
    if (method === 'GET' && path === '/compliance/verification') {
      return json(compliance.verificationCases);
    }
    if (method === 'GET' && path === '/compliance/audit') return json(compliance.audit);

    if (method === 'POST' && path === '/trucks') {
      const unitNumber = String(body.unitNumber ?? '').trim();
      if (store.trucks.some((t) => t.unitNumber === unitNumber)) {
        return json(
          {
            title: 'Conflict',
            detail: `Unit ${unitNumber} already exists in the fleet`,
            status: 409,
          },
          409,
        );
      }
      const odometer = Number(body.odometer ?? 0);
      const truck: Row = {
        ...body,
        id: nextTruckId(),
        unitNumber,
        vin: String(body.vin ?? '').toUpperCase(),
        status: String(body.status ?? 'available'),
        health: body.status === 'out_of_service' ? 'critical' : 'healthy',
        odometerAt: new Date().toISOString(),
        currentDriverId: body.driverId ?? null,
        currentDriverName: null,
        currentTrailerId: null,
        currentLoadId: null,
        location: null,
        nextServiceOdometer: odometer + Number(body.serviceIntervalMiles ?? 0),
        telematicsProvider: 'Unassigned',
        telematicsStatus: 'disconnected',
        mpg30d: 0,
        mpg90d: 0,
        idlePercent30d: 0,
        idlePercent90d: 0,
      };
      store.trucks.unshift(truck);
      return json(truck, 201);
    }

    if (method === 'POST' && path === '/trailers') {
      const unitNumber = String(body.unitNumber ?? '').trim();
      if (store.trailers.some((t) => t.unitNumber === unitNumber)) {
        return json(
          {
            title: 'Conflict',
            detail: `Trailer ${unitNumber} already exists in the fleet`,
            status: 409,
          },
          409,
        );
      }
      const trailer: Row = {
        ...body,
        id: /^\d{1,6}$/.test(unitNumber) ? `trl_${unitNumber}` : `trl_${store.trailers.length + 1}`,
        unitNumber,
        vin: String(body.vin ?? '').toUpperCase(),
        status: 'available',
        currentTruckId: null,
        currentTruckUnit: null,
        source: null,
        externalId: null,
      };
      store.trailers.unshift(trailer);
      return json(trailer, 201);
    }

    const trailerPatch = /^\/trailers\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && trailerPatch) {
      const row = store.trailers.find((r) => r.id === decodeURIComponent(trailerPatch[1] ?? ''));
      if (!row) return json({ title: 'Not Found', detail: 'No such trailer', status: 404 }, 404);
      Object.assign(row, body);
      return json(row);
    }

    if (method === 'POST' && path === '/drivers') {
      const next = nextDriverNumber();
      const driver: Row = {
        ...body,
        id: `drv_${next}`,
        driverNumber: `D-${next}`,
        name: `${String(body.firstName ?? '')} ${String(body.lastName ?? '')}`.trim(),
        status: 'off_duty',
        cdlStatus: 'missing',
        medicalCardStatus: 'missing',
        dispatcherName: 'Unassigned',
        currentTruckId: null,
        currentTruckUnit: null,
        currentTrailerId: null,
        safetyScore: 100,
        safetyEvents30d: 0,
      };
      store.drivers.unshift(driver);
      return json(driver, 201);
    }

    // Archive / restore a truck (owner, 2026-10-05): status moves, the version is checked.
    const archiveMatch = /^\/trucks\/([^/]+)\/(archive|restore)$/.exec(path);
    if (method === 'POST' && archiveMatch) {
      const row = store.trucks.find((r) => r.id === decodeURIComponent(archiveMatch[1] ?? ''));
      if (!row) return json({ title: 'Not Found', detail: 'No such truck', status: 404 }, 404);
      if (row.updatedAt && body.expectedUpdatedAt !== row.updatedAt) {
        return json({ title: 'Conflict', detail: 'Changed by someone else', status: 409 }, 409);
      }
      row.status = archiveMatch[2] === 'archive' ? 'archived' : 'available';
      row.updatedAt = new Date(Date.parse(String(row.updatedAt ?? 0)) + 1000).toISOString();
      return json(row);
    }

    const statusMatch = /^\/(trucks|drivers|trailers)\/([^/]+)\/status$/.exec(path);
    if (method === 'POST' && statusMatch) {
      const rows =
        statusMatch[1] === 'trucks'
          ? store.trucks
          : statusMatch[1] === 'trailers'
            ? store.trailers
            : store.drivers;
      const row = rows.find((r) => r.id === decodeURIComponent(statusMatch[2] ?? ''));
      if (!row) return json({ title: 'Not Found', detail: 'No such record', status: 404 }, 404);
      row.status = String(body.status);
      return json(row);
    }

    // The sidebar polls the Driver Relations badge for every account that may see it.
    if (method === 'GET' && path === '/driver-relations/counts') {
      return json({
        needsContact: 0,
        byTopic: Object.fromEntries(DRIVER_RELATION_TOPICS.map((t) => [t, { needsContact: 0, total: 0 }])),
        byStatus: { awaitingContact: 0, contacted: 0, resolved: 0, all: 0 },
      });
    }

    throw new Error(`roster-server stub has no route for ${method} ${url.pathname}`);
  }) as typeof fetch;
}
