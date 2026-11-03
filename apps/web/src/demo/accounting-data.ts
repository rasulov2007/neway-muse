/**
 * The accounting records, derived from the operational events that already happened.
 *
 * This is the part that makes the module a ledger rather than a table: almost nothing here is
 * invented. Bills come from repair orders, expenses come from fuel fills and repair orders,
 * settlements come from delivered loads and the driver's own pay plan, and every one of them posts
 * a balanced journal entry through the shared posting rules.
 *
 * The one thing seeded rather than derived is the vendor list and the staff payroll, because
 * neither has an operational source in this system yet.
 */
import {
  calculateSettlement,
  needsApproval,
  postBill,
  postBillPaid,
  postExpense,
  postInvoiceIssued,
  postPaymentReceived,
  postPayrollFinalized,
  postSettlementFinalized,
  postSettlementPaid,
  runPayroll,
  type BuildEntryResult,
  type JournalEntry,
  type LedgerPeriod,
  type PayKind,
} from '@neway/shared';
import type { Rng } from './data';
import type {
  Bill,
  DeductionPlan,
  Expense,
  InvoiceLine,
  PayrollPeriod,
  Payment,
  PaymentApplication,
  Payslip,
  Settlement,
  SettlementLineRecord,
  Vendor,
} from './accounting-types';
import type { Driver, FuelTransaction, Invoice, Load, RepairOrder, Truck, User } from './types';

const DAY = 86_400_000;

export interface AccountingData {
  vendors: Vendor[];
  invoiceLines: InvoiceLine[];
  payments: Payment[];
  bills: Bill[];
  expenses: Expense[];
  settlements: Settlement[];
  deductionPlans: DeductionPlan[];
  payrollPeriods: PayrollPeriod[];
  payslips: Payslip[];
  journal: JournalEntry[];
  ledgerPeriods: LedgerPeriod[];
}

export interface AccountingSeedInput {
  loads: Load[];
  invoices: Invoice[];
  drivers: Driver[];
  trucks: Truck[];
  users: User[];
  repairOrders: RepairOrder[];
  fuelTransactions: FuelTransaction[];
  now: Date;
}

const VENDOR_DEFS: ReadonlyArray<Omit<Vendor, 'id' | 'status'>> = [
  {
    name: 'TA Truck Service',
    kind: 'shop',
    city: 'Effingham',
    state: 'IL',
    paymentTermsDays: 30,
    defaultCategory: 'maintenance',
    contactName: 'Service desk',
    contactEmail: 'ap@tatruckservice.example',
  },
  {
    name: 'Pilot Flying J',
    kind: 'fuel',
    city: 'Knoxville',
    state: 'TN',
    paymentTermsDays: 7,
    defaultCategory: 'fuel',
    contactName: null,
    contactEmail: 'billing@pilot.example',
  },
  {
    name: 'Love’s Travel Stops',
    kind: 'fuel',
    city: 'Oklahoma City',
    state: 'OK',
    paymentTermsDays: 7,
    defaultCategory: 'fuel',
    contactName: null,
    contactEmail: null,
  },
  {
    name: 'Great West Casualty',
    kind: 'insurance',
    city: 'South Sioux City',
    state: 'NE',
    paymentTermsDays: 15,
    defaultCategory: 'insurance',
    contactName: 'Policy services',
    contactEmail: 'billing@greatwest.example',
  },
  {
    name: 'PrePass',
    kind: 'tolls',
    city: 'Phoenix',
    state: 'AZ',
    paymentTermsDays: 15,
    defaultCategory: 'tolls',
    contactName: null,
    contactEmail: null,
  },
  {
    name: 'Penske Truck Leasing',
    kind: 'lease',
    city: 'Reading',
    state: 'PA',
    paymentTermsDays: 30,
    defaultCategory: 'lease',
    contactName: 'Lease billing',
    contactEmail: null,
  },
  {
    name: 'FleetPride',
    kind: 'parts',
    city: 'Irving',
    state: 'TX',
    paymentTermsDays: 30,
    defaultCategory: 'maintenance',
    contactName: null,
    contactEmail: null,
  },
  {
    name: 'Comdata',
    kind: 'other',
    city: 'Brentwood',
    state: 'TN',
    paymentTermsDays: 7,
    defaultCategory: 'other',
    contactName: null,
    contactEmail: null,
  },
];

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildAccounting(rng: Rng, input: AccountingSeedInput): AccountingData {
  const { loads, invoices, drivers, trucks, users, repairOrders, fuelTransactions, now } = input;
  const nowMs = now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const today = isoDate(nowMs);

  const journal: JournalEntry[] = [];
  let journalSeq = 0;
  /** Refuses a duplicate posting the same way the write path does. */
  const postedKeys = new Set<string>();

  const post = (result: BuildEntryResult, by = 'System'): JournalEntry | null => {
    if (!result.ok) return null;
    if (postedKeys.has(result.entry.sourceKey)) return null;
    postedKeys.add(result.entry.sourceKey);
    journalSeq += 1;
    const entry: JournalEntry = {
      ...result.entry,
      id: `je_${pad(journalSeq, 5)}`,
      postedAt: `${result.entry.onDate}T12:00:00.000Z`,
      postedBy: by,
    };
    journal.push(entry);
    return entry;
  };

  // ----- Vendors --------------------------------------------------------------------------------
  const vendors: Vendor[] = VENDOR_DEFS.map((def, i) => ({
    ...def,
    id: `ven_${pad(i + 1, 3)}`,
    status: 'active',
  }));
  const vendorByName = new Map(vendors.map((v) => [v.name, v]));
  const knownVendorIds = new Set(vendors.map((v) => v.id));

  // ----- Invoice lines, and the revenue they post ----------------------------------------------
  const invoiceLines: InvoiceLine[] = [];
  const loadById = new Map(loads.map((l) => [l.id, l]));
  let lineSeq = 0;

  for (const invoice of invoices) {
    const load = loadById.get(invoice.loadId);
    const charges = load?.charges ?? [];
    const billable = charges.filter((c) => c.billable);

    // Where the load carries no charge breakdown, the invoice is a single linehaul line rather than
    // an invented split — inventing charge types would put revenue in accounts nothing supports.
    const lines =
      billable.length > 0
        ? billable.map((c) => ({
            chargeType: c.type,
            description: c.description,
            amount: c.amount,
          }))
        : [{ chargeType: 'linehaul', description: 'Linehaul', amount: invoice.subtotal }];

    for (const line of lines) {
      lineSeq += 1;
      invoiceLines.push({
        id: `inl_${pad(lineSeq, 5)}`,
        invoiceId: invoice.id,
        loadId: invoice.loadId,
        chargeType: line.chargeType,
        description: line.description,
        quantity: 1,
        rate: line.amount,
        amount: line.amount,
      });
    }

    if (invoice.status !== 'draft' && invoice.issuedOn) {
      post(
        postInvoiceIssued({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          issuedOn: invoice.issuedOn,
          billToName: invoice.billToName,
          lines,
        }),
      );
    }
  }

  // ----- Payments against invoices --------------------------------------------------------------
  const payments: Payment[] = [];
  let paymentSeq = 0;
  let applicationSeq = 0;

  const settledInvoices = invoices.filter((i) => i.paid > 0);
  // Group by party so one ACH covers several invoices, which is how customers actually pay.
  const byParty = new Map<string, Invoice[]>();
  for (const invoice of settledInvoices) {
    const bucket = byParty.get(invoice.billToId);
    if (bucket) bucket.push(invoice);
    else byParty.set(invoice.billToId, [invoice]);
  }

  for (const [partyId, partyInvoices] of byParty) {
    const batches: Invoice[][] = [];
    let batch: Invoice[] = [];
    for (const invoice of partyInvoices) {
      batch.push(invoice);
      if (batch.length >= rng.int(1, 3)) {
        batches.push(batch);
        batch = [];
      }
    }
    if (batch.length > 0) batches.push(batch);

    for (const group of batches) {
      paymentSeq += 1;
      const receivedMs = Math.min(
        nowMs,
        Math.max(
          ...group.map((i) =>
            i.paidOn ? Date.parse(`${i.paidOn}T00:00:00Z`) : nowMs - rng.int(1, 40) * DAY,
          ),
        ),
      );
      const applications: PaymentApplication[] = group.map((invoice) => {
        applicationSeq += 1;
        return {
          id: `pap_${pad(applicationSeq, 5)}`,
          paymentId: `pay_${pad(paymentSeq, 4)}`,
          invoiceId: invoice.id,
          billId: null,
          amount: invoice.paid,
          appliedAt: iso(receivedMs),
        };
      });
      const applied = round(applications.reduce((sum, a) => sum + a.amount, 0));
      if (applied <= 0) continue;

      const method = rng.pick(['ach', 'check', 'wire'] as const);
      const payment: Payment = {
        id: `pay_${pad(paymentSeq, 4)}`,
        direction: 'in',
        partyType: group[0]?.billToType === 'broker' ? 'broker' : 'customer',
        partyId,
        partyName: group[0]?.billToName ?? partyId,
        amount: applied,
        method,
        receivedOn: isoDate(receivedMs),
        reference:
          method === 'check' ? `CHK-${rng.int(1000, 9999)}` : `ACH-${rng.int(100000, 999999)}`,
        unappliedAmount: 0,
        applications,
        notes: null,
        createdAt: iso(receivedMs),
        createdBy: 'Accounting',
      };
      payments.push(payment);

      post(
        postPaymentReceived({
          paymentId: payment.id,
          reference: payment.reference,
          receivedOn: payment.receivedOn,
          partyName: payment.partyName,
          appliedAmount: applied,
          unappliedAmount: 0,
        }),
      );
    }
  }

  // ----- Bills, from repair orders and recurring vendor charges ---------------------------------
  const bills: Bill[] = [];
  let billSeq = 0;

  const makeBill = (
    vendor: Vendor,
    amount: number,
    issuedMs: number,
    categoryCode: string,
    source: Bill['source'],
    sourceId: string | null,
    truck: Truck | null,
    vendorInvoiceNumber: string | null,
    notes: string | null,
  ): Bill => {
    billSeq += 1;
    const dueMs = issuedMs + vendor.paymentTermsDays * DAY;
    const approval = needsApproval({ amount, vendorId: vendor.id }, knownVendorIds);
    const age = Math.round((nowMs - issuedMs) / DAY);

    // Older bills have mostly been paid; recent ones are still open, and a few sit unapproved —
    // which is the state an AP desk spends its week on.
    const paidInFull = age > vendor.paymentTermsDays + 5 && rng.chance(0.8);
    const partial = !paidInFull && rng.chance(0.12);
    const paid = paidInFull ? amount : partial ? round(amount * rng.float(0.2, 0.6)) : 0;

    let status: Bill['status'];
    if (paidInFull) status = 'paid';
    else if (partial) status = 'partially_paid';
    else if (approval.required && rng.chance(0.5)) status = 'pending_approval';
    else if (rng.chance(0.2)) status = 'scheduled';
    else if (rng.chance(0.05)) status = 'disputed';
    else status = 'open';

    const approved = status !== 'pending_approval';

    return {
      id: `bil_${pad(billSeq, 4)}`,
      billNumber: `AP-${pad(billSeq, 4)}`,
      vendorInvoiceNumber,
      vendorId: vendor.id,
      vendorName: vendor.name,
      issuedOn: isoDate(issuedMs),
      dueOn: isoDate(dueMs),
      paymentTermsDays: vendor.paymentTermsDays,
      amount,
      paid,
      balance: round(amount - paid),
      status,
      categoryCode,
      source,
      sourceId,
      truckId: truck?.id ?? null,
      unitNumber: truck?.unitNumber ?? null,
      trailerId: null,
      loadId: null,
      loadNumber: null,
      approvedAt: approved ? iso(issuedMs + rng.int(1, 3) * DAY) : null,
      approvedBy: approved ? 'Sarah Chen' : null,
      approvalReason: approval.reason,
      scheduledFor: status === 'scheduled' ? isoDate(dueMs - DAY) : null,
      notes,
      createdAt: iso(issuedMs),
    };
  };

  // A completed repair order becomes a shop bill. Same event, one record each side.
  const shop = vendorByName.get('TA Truck Service') as Vendor;
  const parts = vendorByName.get('FleetPride') as Vendor;
  for (const order of repairOrders) {
    if (order.status !== 'completed' || order.total <= 0) continue;
    const truck = trucks.find((t) => t.id === order.truckId) ?? null;
    const vendor = order.vendorName.includes('FleetPride') ? parts : shop;
    const issuedMs = order.completedAt
      ? Date.parse(order.completedAt)
      : nowMs - rng.int(5, 90) * DAY;
    bills.push(
      makeBill(
        vendor,
        order.total,
        issuedMs,
        'maintenance',
        'repair_order',
        order.id,
        truck,
        order.roNumber,
        `${order.roNumber}: ${order.summary}`,
      ),
    );
  }

  // Recurring vendor charges the carrier pays every month.
  const recurring: Array<{
    vendor: Vendor;
    amount: () => number;
    category: string;
    label: string;
  }> = [
    {
      vendor: vendorByName.get('Great West Casualty') as Vendor,
      amount: () => round(rng.int(28_000, 34_000)),
      category: 'insurance',
      label: 'Fleet liability and physical damage',
    },
    {
      vendor: vendorByName.get('Penske Truck Leasing') as Vendor,
      amount: () => round(rng.int(41_000, 47_000)),
      category: 'lease',
      label: 'Equipment lease',
    },
    {
      vendor: vendorByName.get('PrePass') as Vendor,
      amount: () => round(rng.int(3_200, 5_400)),
      category: 'tolls',
      label: 'Toll and bypass service',
    },
    {
      vendor: vendorByName.get('Comdata') as Vendor,
      amount: () => round(rng.int(900, 1_600)),
      category: 'other',
      label: 'Card processing and fees',
    },
  ];

  for (let monthsBack = 5; monthsBack >= 0; monthsBack -= 1) {
    const issuedMs = nowMs - monthsBack * 30 * DAY;
    for (const item of recurring) {
      bills.push(
        makeBill(
          item.vendor,
          item.amount(),
          issuedMs,
          item.category,
          'manual',
          null,
          null,
          `${item.vendor.name.slice(0, 3).toUpperCase()}-${rng.int(10000, 99999)}`,
          item.label,
        ),
      );
    }
  }

  for (const bill of bills) {
    post(
      postBill({
        billId: bill.id,
        billNumber: bill.billNumber,
        issuedOn: bill.issuedOn,
        vendorName: bill.vendorName,
        categoryCode: bill.categoryCode,
        amount: bill.amount,
      }),
    );
    if (bill.paid > 0) {
      paymentSeq += 1;
      const paidMs = Date.parse(`${bill.dueOn}T00:00:00Z`) - rng.int(0, 5) * DAY;
      const payment: Payment = {
        id: `pay_${pad(paymentSeq, 4)}`,
        direction: 'out',
        partyType: 'vendor',
        partyId: bill.vendorId,
        partyName: bill.vendorName,
        amount: bill.paid,
        method: rng.pick(['ach', 'check'] as const),
        receivedOn: isoDate(Math.min(nowMs, paidMs)),
        reference: `AP-${rng.int(100000, 999999)}`,
        unappliedAmount: 0,
        applications: [
          {
            id: `pap_${pad(++applicationSeq, 5)}`,
            paymentId: `pay_${pad(paymentSeq, 4)}`,
            invoiceId: null,
            billId: bill.id,
            amount: bill.paid,
            appliedAt: iso(Math.min(nowMs, paidMs)),
          },
        ],
        notes: null,
        createdAt: iso(Math.min(nowMs, paidMs)),
        createdBy: 'Accounting',
      };
      payments.push(payment);
      post(
        postBillPaid({
          paymentId: payment.id,
          reference: payment.reference,
          paidOn: payment.receivedOn,
          vendorName: bill.vendorName,
          amount: bill.paid,
        }),
      );
    }
  }

  // ----- Expenses, from fuel fills and the bills above ------------------------------------------
  const expenses: Expense[] = [];
  let expenseSeq = 0;

  const addExpense = (
    onMs: number,
    categoryCode: string,
    description: string,
    amount: number,
    dims: Partial<Expense>,
    source: Expense['source'],
    sourceId: string | null,
    accountCode: string,
    paidDirectly: boolean,
  ) => {
    expenseSeq += 1;
    const expense: Expense = {
      id: `exp_${pad(expenseSeq, 5)}`,
      expenseNumber: `EX-${pad(expenseSeq, 5)}`,
      onDate: isoDate(onMs),
      categoryCode,
      description,
      amount,
      truckId: null,
      unitNumber: null,
      trailerId: null,
      driverId: null,
      driverName: null,
      loadId: null,
      loadNumber: null,
      vendorId: null,
      vendorName: null,
      source,
      sourceId,
      billId: null,
      paymentMethod: paidDirectly ? 'card' : null,
      accountCode,
      status: 'posted',
      postedAt: iso(onMs),
      notes: null,
      ...dims,
    };
    expenses.push(expense);
    post(
      postExpense({
        expenseId: expense.id,
        expenseNumber: expense.expenseNumber,
        onDate: expense.onDate,
        description: expense.description,
        categoryCode,
        amount,
        paidDirectly,
      }),
    );
  };

  // Fuel: every card fill is a direct expense against the unit and driver that bought it.
  for (const fill of fuelTransactions) {
    const vendor =
      vendorByName.get(
        fill.station.brand === 'Love’s' ? 'Love’s Travel Stops' : 'Pilot Flying J',
      ) ?? null;
    addExpense(
      Date.parse(fill.at),
      'fuel',
      `${fill.gallons.toFixed(1)} gal at ${fill.station.name}`,
      fill.amount,
      {
        truckId: fill.truckId,
        unitNumber: fill.unitNumber,
        driverId: fill.driverId || null,
        driverName: fill.driverName || null,
        loadId: fill.loadId,
        vendorId: vendor?.id ?? null,
        vendorName: vendor?.name ?? null,
        paymentMethod: 'card',
      },
      'fuel',
      fill.id,
      '5100',
      true,
    );
  }

  // Every bill is also an expense: same cost, recorded once, sitting in AP rather than cash.
  for (const bill of bills) {
    expenseSeq += 1;
    expenses.push({
      id: `exp_${pad(expenseSeq, 5)}`,
      expenseNumber: `EX-${pad(expenseSeq, 5)}`,
      onDate: bill.issuedOn,
      categoryCode: bill.categoryCode,
      description: bill.notes ?? `${bill.vendorName} — ${bill.categoryCode}`,
      amount: bill.amount,
      truckId: bill.truckId,
      unitNumber: bill.unitNumber,
      trailerId: null,
      driverId: null,
      driverName: null,
      loadId: null,
      loadNumber: null,
      vendorId: bill.vendorId,
      vendorName: bill.vendorName,
      source: bill.source === 'repair_order' ? 'maintenance' : 'manual',
      sourceId: bill.sourceId,
      billId: bill.id,
      paymentMethod: null,
      accountCode:
        bill.categoryCode === 'maintenance'
          ? '5300'
          : bill.categoryCode === 'insurance'
            ? '6100'
            : bill.categoryCode === 'lease'
              ? '6300'
              : bill.categoryCode === 'tolls'
                ? '5400'
                : '6900',
      status: 'posted',
      // Already posted as part of the bill; posting it again would double the cost.
      postedAt: bill.createdAt,
      notes: null,
    });
  }

  // ----- Settlements, from delivered loads and each driver's own pay plan ------------------------
  const settlements: Settlement[] = [];
  const deductionPlans: DeductionPlan[] = [];
  let settlementSeq = 0;
  let settlementLineSeq = 0;

  const activeDrivers = drivers.filter((d) => d.status !== 'terminated');
  for (const driver of activeDrivers) {
    // Owner-operators carry escrow and a lease; company drivers carry occupational insurance.
    if (driver.driverType === 'owner_operator' || driver.driverType === 'lease_operator') {
      deductionPlans.push({
        id: `ded_${driver.id}_escrow`,
        driverId: driver.id,
        kind: 'escrow',
        description: 'Maintenance escrow',
        amountPerPeriod: 100,
        balance: null,
        totalCap: 2_500,
        startsOn: driver.hireDate,
        endsOn: null,
        status: 'active',
      });
      deductionPlans.push({
        id: `ded_${driver.id}_lease`,
        driverId: driver.id,
        kind: 'lease',
        description: 'Equipment lease',
        amountPerPeriod: rng.int(550, 850),
        balance: null,
        totalCap: null,
        startsOn: driver.hireDate,
        endsOn: null,
        status: 'active',
      });
    } else {
      deductionPlans.push({
        id: `ded_${driver.id}_occacc`,
        driverId: driver.id,
        kind: 'insurance',
        description: 'Occupational accident cover',
        amountPerPeriod: rng.int(28, 46),
        balance: null,
        totalCap: null,
        startsOn: driver.hireDate,
        endsOn: null,
        status: 'active',
      });
    }
  }

  const deliveredByDriver = new Map<string, Load[]>();
  for (const load of loads) {
    if (load.status !== 'delivered' || !load.driverId) continue;
    const bucket = deliveredByDriver.get(load.driverId);
    if (bucket) bucket.push(load);
    else deliveredByDriver.set(load.driverId, [load]);
  }

  // Three weekly periods, most recent last, so the desk has one to approve and two settled.
  for (let weeksBack = 2; weeksBack >= 0; weeksBack -= 1) {
    const endMs = nowMs - weeksBack * 7 * DAY;
    const startMs = endMs - 6 * DAY;
    const periodStart = isoDate(startMs);
    const periodEnd = isoDate(endMs);

    for (const driver of activeDrivers) {
      const delivered = (deliveredByDriver.get(driver.id) ?? []).filter((load) => {
        const at = load.deliveryAt ? Date.parse(load.deliveryAt) : null;
        return at !== null && at >= startMs && at <= endMs + DAY;
      });
      if (delivered.length === 0) continue;

      const plans = deductionPlans.filter((p) => p.driverId === driver.id);
      const result = calculateSettlement({
        driverId: driver.id,
        driverName: driver.name,
        payPlan: { kind: driver.payPlan.kind as PayKind, rate: driver.payPlan.rate },
        periodStart,
        periodEnd,
        loads: delivered.map((load) => ({
          id: load.id,
          loadNumber: load.loadNumber,
          deliveredOn: load.deliveryAt?.slice(0, 10) ?? periodEnd,
          originLabel: `${load.origin.city}, ${load.origin.state}`,
          destinationLabel: `${load.destination.city}, ${load.destination.state}`,
          loadedMiles: load.loadedMiles,
          emptyMiles: load.emptyMiles,
          linehaulRevenue:
            load.charges?.find((c) => c.type === 'linehaul')?.amount ??
            load.financials?.revenue ??
            null,
          driverAccessorials: (load.charges ?? [])
            .filter((c) => c.payableToDriver)
            .map((c) => ({ description: c.description, amount: c.amount })),
        })),
        deductions: plans.map((p) => ({
          kind: p.kind,
          description: p.description,
          amountPerPeriod: p.amountPerPeriod,
          balance: p.balance,
        })),
        adjustments: [],
      });

      if (result.gross <= 0) continue;

      settlementSeq += 1;
      const id = `set_${pad(settlementSeq, 4)}`;
      const status = weeksBack === 0 ? 'pending_review' : weeksBack === 1 ? 'finalized' : 'paid';
      const finalizedMs = endMs + 2 * DAY;

      const lines: SettlementLineRecord[] = result.lines.map((line) => {
        settlementLineSeq += 1;
        return {
          id: `stl_${pad(settlementLineSeq, 5)}`,
          settlementId: id,
          kind: line.kind,
          loadId: line.loadId,
          loadNumber: line.loadNumber,
          description: line.description,
          amount: line.amount,
          basis: line.basis,
        };
      });

      const settlement: Settlement = {
        id,
        settlementNumber: `SET-${pad(settlementSeq, 4)}`,
        driverId: driver.id,
        driverName: driver.name,
        truckId: driver.currentTruckId,
        unitNumber: driver.currentTruckUnit,
        periodStart,
        periodEnd,
        status,
        payPlanKind: driver.payPlan.kind,
        payPlanRate: driver.payPlan.rate,
        gross: result.gross,
        deductions: result.deductions,
        escrow: result.escrow,
        adjustments: result.adjustments,
        net: result.net,
        loadCount: result.paidLoads,
        totalMiles: result.totalMiles,
        lines,
        excluded: result.excluded,
        shortfall: result.shortfall,
        finalizedAt: status === 'pending_review' ? null : iso(finalizedMs),
        finalizedBy: status === 'pending_review' ? null : 'Sarah Chen',
        paidAt: status === 'paid' ? iso(finalizedMs + DAY) : null,
        paymentId: null,
        notes: null,
      };
      settlements.push(settlement);

      if (status === 'finalized' || status === 'paid') {
        post(
          postSettlementFinalized({
            settlementId: settlement.id,
            settlementNumber: settlement.settlementNumber,
            onDate: isoDate(finalizedMs),
            driverName: driver.name,
            gross: settlement.gross,
            deductions: settlement.deductions,
            escrow: settlement.escrow,
            net: settlement.net,
          }),
        );
      }
      if (status === 'paid') {
        post(
          postSettlementPaid({
            settlementId: settlement.id,
            settlementNumber: settlement.settlementNumber,
            onDate: isoDate(finalizedMs + DAY),
            driverName: driver.name,
            net: settlement.net,
          }),
        );
      }
    }
  }

  // ----- Staff payroll --------------------------------------------------------------------------
  const payrollPeriods: PayrollPeriod[] = [];
  const payslips: Payslip[] = [];
  let periodSeq = 0;
  let payslipSeq = 0;

  const staff = users.filter((u) => u.status === 'active');

  for (let periodsBack = 2; periodsBack >= 0; periodsBack -= 1) {
    const endMs = nowMs - periodsBack * 14 * DAY;
    const startMs = endMs - 13 * DAY;
    periodSeq += 1;
    const periodId = `pp_${pad(periodSeq, 3)}`;

    const slips: Payslip[] = staff.map((user) => {
      payslipSeq += 1;
      const hourly = user.department === 'dispatch' && rng.chance(0.3);
      const basePay = hourly ? 0 : round(rng.int(2_100, 4_600));
      const hours = hourly ? rng.int(70, 88) : null;
      const hourlyPay = hourly ? round((hours as number) * rng.int(24, 34)) : 0;
      const gross = round(basePay + hourlyPay);
      const bonuses = rng.chance(0.2) ? round(rng.int(150, 900)) : 0;
      const total = round(gross + bonuses);
      // Withholding as recorded by the payroll provider. Nothing here computes it.
      const tax = round(total * rng.float(0.18, 0.26));
      const deductions = round(rng.int(40, 220));

      return {
        id: `psl_${pad(payslipSeq, 5)}`,
        payrollPeriodId: periodId,
        employeeId: user.id,
        employeeName: user.name,
        title: user.title,
        workerType: 'employee' as const,
        hourly,
        hours,
        basePay: hourly ? hourlyPay : basePay,
        bonuses,
        taxWithheld: tax,
        deductions,
        gross: total,
        netPay: round(total - tax - deductions),
        locked: periodsBack > 0,
        notes: null,
      };
    });

    const run = runPayroll(
      slips.map((s) => ({
        id: s.id,
        employeeId: s.employeeId,
        employeeName: s.employeeName,
        workerType: s.workerType,
        basePay: s.basePay,
        bonuses: s.bonuses,
        taxWithheld: s.taxWithheld,
        deductions: s.deductions,
        hours: s.hours,
        hourly: s.hourly,
      })),
    );

    const status: PayrollPeriod['status'] =
      periodsBack === 0 ? 'review' : periodsBack === 1 ? 'paid' : 'closed';

    payrollPeriods.push({
      id: periodId,
      periodNumber: `PR-${pad(periodSeq, 3)}`,
      periodStart: isoDate(startMs),
      periodEnd: isoDate(endMs),
      payDate: isoDate(endMs + 5 * DAY),
      status,
      gross: run.gross,
      taxWithheld: run.taxWithheld,
      deductions: run.deductions,
      net: run.net,
      workerCount: run.workers,
      finalizedAt: status === 'review' ? null : iso(endMs + 2 * DAY),
      finalizedBy: status === 'review' ? null : 'Sarah Chen',
      paidAt: status === 'review' ? null : iso(endMs + 5 * DAY),
      closedAt: status === 'closed' ? iso(endMs + 10 * DAY) : null,
    });
    payslips.push(...slips);

    if (status !== 'review') {
      post(
        postPayrollFinalized({
          periodId,
          periodLabel: `${isoDate(startMs)} – ${isoDate(endMs)}`,
          onDate: isoDate(endMs + 2 * DAY),
          gross: run.gross,
          taxWithheld: run.taxWithheld,
          deductions: run.deductions,
          net: run.net,
        }),
      );
    }
  }

  // ----- Ledger periods -------------------------------------------------------------------------
  // The current month is open, the one before it is closing, and everything older is closed.
  const ledgerPeriods: LedgerPeriod[] = [];
  const seenPeriods = new Set<string>();
  for (const entry of journal) {
    const id = entry.onDate.slice(0, 7);
    if (seenPeriods.has(id)) continue;
    seenPeriods.add(id);
    const [year, month] = id.split('-').map(Number);
    const current = today.slice(0, 7);
    const status = id === current ? 'open' : id > current ? 'open' : 'closed';
    ledgerPeriods.push({
      id,
      year: year ?? 2026,
      month: month ?? 1,
      status,
      closedAt: status === 'closed' ? `${id}-28T23:59:00.000Z` : null,
      closedBy: status === 'closed' ? 'Sarah Chen' : null,
    });
  }
  ledgerPeriods.sort((a, b) => a.id.localeCompare(b.id));
  // The most recently closed month is still closing, which is the state a real desk lives in.
  const closed = ledgerPeriods.filter((p) => p.status === 'closed');
  const lastClosed = closed.at(-1);
  if (lastClosed) {
    lastClosed.status = 'closing';
    lastClosed.closedAt = null;
    lastClosed.closedBy = null;
  }

  journal.sort((a, b) => (a.onDate < b.onDate ? 1 : a.onDate > b.onDate ? -1 : 0));

  return {
    vendors,
    invoiceLines,
    payments,
    bills,
    expenses,
    settlements,
    deductionPlans,
    payrollPeriods,
    payslips,
    journal,
    ledgerPeriods,
  };
}
