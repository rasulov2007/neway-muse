import { companyBpsOf } from '@neway/shared';
import { arrangementsFor, vendorNames } from '../../roster/truck-vendor.data';
import { applyVendorTrucks, type VendorArrangementFact } from '../vendor-trucks';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../../../config/env';
import { DatabaseService } from '../../../database/database.service';
import { acctDriverTransactions, acctSettlements } from '../../../database/schema/accounting';
import { fleetExpenses, workOrders } from '../../../database/schema/fleet';
import { loads as loadsTable } from '../../../database/schema/loads';
import { drivers, trucks } from '../../../database/schema/roster';
import { StateService } from '../../state/state.service';
import { localDateOf } from '../period/date-utils';
import { ledgerFacts, type LedgerFacts, type LoadDimension } from './posted-costs';
import { driverPayKey, expenseKey, realLinehaulOf } from '@neway/shared';
import { DEMO_COMPANY } from '../demo/demo-company';
import { DemoReportingDataSource } from '../demo/demo-reporting-data-source';
import type {
  DateRange,
  DriverFact,
  ExpenseCategory,
  ExpenseCoverage,
  ExpenseLine,
  ExpenseSource,
  FactsProvenance,
  FuelTransactionFact,
  IsoDate,
  ReportingDataSource,
  RecoveredFor,
  ReportingFacts,
  RevenueLine,
  TruckFact,
} from '../facts';

/**
 * Every business date in reporting is US Eastern (owner, 2026-09-25): a delivery at 23:30 ET on
 * the 18th belongs to the 18th, not to the UTC 19th.
 */
export const REPORTING_TIMEZONE = 'America/New_York';

/**
 * Reporting facts built from the company's own records.
 *
 * Revenue comes from NeWay Loads - the loads table the load screens, the Daily Board and
 * Accounting write (owner, 2026-10-25); the Google Sheet is only for comparison. Costs come from
 * the posted ledger first, then from the operational records the books have not taken on yet:
 * card fuel (Relay), completed work orders, manual Fleet expenses and the older workspace book.
 * What drivers paid back is a separate negative line.
 *
 * The rules, each from an owner decision of 2026-10-25:
 *
 *  - **Revenue is dated by delivery**, in Eastern time. A TONU is revenue (the broker pays it) on
 *    the day of the cancellation, kept on its own line.
 *  - **Gross = linehaul + billed accessorials + TONU**, at the amounts billed to the broker, never
 *    the For driver amounts.
 *  - **Driver pay is dated by the week it was earned** - the statement's period - not by the day
 *    Accounting posted it. (Settlements themselves keep "Counts for pay on"; that is not touched.)
 *  - **Recovered money reduces cost** as its own negative line; the cost stays recorded in full.
 *  - **DEF is its own cost line**, never blended into diesel.
 *  - **Trailer repairs belong to the trailer**, never to a truck's P&L.
 *  - **One miles rule**: load miles (loaded + empty) from the delivered loads. No mileage records
 *    are emitted; ELD miles are for MPG and verification only.
 *
 * Nothing is inferred: a load with no priced financials contributes its rate and miles and no
 * cost. With no loads at all and the demo seeds on (development and the API tests) it falls back
 * to the generated demo book; a live company with nothing booked reports nothing.
 */
@Injectable()
export class WorkspaceReportingDataSource implements ReportingDataSource {
  /** The configured default; what was actually read is in each result's `provenance`. */
  readonly kind = env.SEED_DEMO_DATA ? ('demo' as const) : ('database' as const);

  /** The key the browser writes its operational snapshot to. */
  static readonly SNAPSHOT_KEY = 'demo-data-v1';

  constructor(
    private readonly state: StateService,
    private readonly database: DatabaseService,
    private readonly fallback: DemoReportingDataSource,
  ) {}

  async facts(companyId: string, range: DateRange): Promise<ReportingFacts> {
    // An explicit way back to the deterministic book, used by the engine tests and available if a
    // demo ever needs the generated numbers again.
    if (process.env.REPORTING_SOURCE === 'generated') return this.generated(companyId, range);

    const loads = (
      await this.database.db
        .select({ record: loadsTable.record })
        .from(loadsTable)
        .where(and(eq(loadsTable.companyId, companyId), eq(loadsTable.isDemo, false)))
    ).map((r) => r.record as LoadRecord);
    if (loads.length === 0 && env.SEED_DEMO_DATA) return this.generated(companyId, range);

    // The browser workspace (fuel, legacy expenses, settlements, repair orders kept there) belongs to
    // one company only; another tenant gets nothing from it - never a neighbour's costs.
    const snapshot = companyId === SNAPSHOT_COMPANY_ID ? await this.snapshot(companyId) : null;
    const loadDimensions = new Map<string, LoadDimension>(
      loads.map((load) => [
        load.id,
        { loadNumber: load.loadNumber, truckId: load.truckId ?? null, driverId: load.driverId ?? null },
      ]),
    );

    const db = this.database.db;
    const [ledger, truckRows, driverRows, orderRows, manualRows, txRows, settlementRows] =
      await Promise.all([
        ledgerFacts(this.database, companyId, range, loadDimensions),
        db.select().from(trucks).where(eq(trucks.companyId, companyId)),
        db.select().from(drivers).where(eq(drivers.companyId, companyId)),
        db
          .select()
          .from(workOrders)
          .where(and(eq(workOrders.companyId, companyId), isNull(workOrders.voidedAt))),
        db
          .select()
          .from(fleetExpenses)
          .where(
            and(
              eq(fleetExpenses.companyId, companyId),
              eq(fleetExpenses.status, 'recorded'),
              eq(fleetExpenses.isTest, false),
              isNull(fleetExpenses.voidedAt),
            ),
          ),
        db
          .select({
            id: acctDriverTransactions.id,
            driverId: acctDriverTransactions.driverId,
            kind: acctDriverTransactions.kind,
            onDate: acctDriverTransactions.onDate,
            recoveredCents: acctDriverTransactions.recoveredCents,
            state: acctDriverTransactions.state,
            source: acctDriverTransactions.source,
            truckId: acctDriverTransactions.truckId,
            settlementId: acctDriverTransactions.settlementId,
            record: acctDriverTransactions.record,
          })
          .from(acctDriverTransactions)
          .where(eq(acctDriverTransactions.companyId, companyId)),
        db
          .select({ id: acctSettlements.id, record: acctSettlements.record })
          .from(acctSettlements)
          .where(eq(acctSettlements.companyId, companyId)),
      ]);

    const built = buildReportingFacts(companyId, range, {
      loads,
      snapshot,
      ledger,
      trucks: truckRows.map((t) => ({
        id: t.id,
        unitNumber: t.unitNumber,
        status: t.status,
        currentDriverId: t.currentDriverId ?? null,
      })),
      drivers: driverRows.map((d) => ({
        id: d.id,
        firstName: d.firstName,
        lastName: d.lastName,
        driverType: d.driverType,
      })),
      workOrders: orderRows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        workType: r.workType,
        assetType: r.assetType,
        unitId: r.unitId,
        unitNumber: r.unitNumber,
        vendorName: r.vendorName ?? null,
        invoiceNumber: r.invoiceNumber ?? null,
        invoiceTotal: r.invoiceTotal === null || r.invoiceTotal === undefined ? null : Number(r.invoiceTotal),
        total: r.total === null || r.total === undefined ? null : Number(r.total),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        migratedFrom: r.migratedFrom ?? null,
        chargeParty: r.chargeParty ?? null,
      })),
      fleetExpenses: manualRows.map((m) => ({
        id: m.id,
        reference: m.reference,
        truckId: m.truckId,
        category: m.category,
        expenseDate: String(m.expenseDate),
        amountCents: m.amountCents,
        paidBy: m.paidBy,
        chargeTo: m.chargeTo,
        acctExpenseId: m.acctExpenseId ?? null,
        acctBillId: m.acctBillId ?? null,
        description: m.description ?? null,
      })),
      driverTransactions: txRows.map((t) => {
        const record = (t.record ?? {}) as { companyCost?: boolean; recoveryLog?: RecoveryLogRow[]; description?: string };
        return {
          id: t.id,
          driverId: t.driverId,
          kind: t.kind,
          onDate: String(t.onDate),
          recoveredCents: Number(t.recoveredCents) || 0,
          state: t.state,
          source: t.source,
          truckId: t.truckId ?? null,
          settlementId: t.settlementId ?? null,
          companyCost: record.companyCost === true,
          recoveryLog: Array.isArray(record.recoveryLog) ? record.recoveryLog : [],
          description: record.description ?? null,
        };
      }),
      statements: settlementRows.map((s) => {
        const r = (s.record ?? {}) as {
          status?: string;
          partyType?: string;
          partyId?: string;
          periodEnd?: string;
          truckId?: string | null;
          settlementNumber?: string;
          computation?: { earnings?: Array<{ loadId?: string | null; cents?: number; kind?: string }> };
        };
        return {
          id: s.id,
          status: r.status ?? '',
          partyType: r.partyType ?? '',
          partyId: r.partyId ?? '',
          periodEnd: typeof r.periodEnd === 'string' ? r.periodEnd.slice(0, 10) : '',
          truckId: r.truckId ?? null,
          settlementNumber: r.settlementNumber ?? s.id,
          earnings: (r.computation?.earnings ?? []).map((e) => ({ loadId: e.loadId ?? null, cents: Number(e.cents) || 0, kind: e.kind ?? '' })),
        };
      }),
      settlementPeriodEnd: new Map(
        settlementRows
          .map((s) => [s.id, (s.record as { periodEnd?: string | null })?.periodEnd ?? null] as const)
          .filter((pair): pair is readonly [string, string] => typeof pair[1] === 'string')
          .map(([id, end]) => [id, end.slice(0, 10)]),
      ),
    });
    // Vendor trucks (owner, 2026-10-28): the company share counts, the truck's costs do not.
    return applyVendorTrucks(built, await this.vendorArrangements(companyId));
  }

  /** Every truck -> vendor arrangement with a company percentage, named. */
  private async vendorArrangements(companyId: string): Promise<VendorArrangementFact[]> {
    const rows = await arrangementsFor(this.database.db, companyId);
    const names = await vendorNames(this.database.db, companyId, [...new Set(rows.map((r) => r.vendorId))]);
    return rows.flatMap((r) => {
      const companyBps = companyBpsOf(r);
      if (companyBps === null) return [];
      return [{ truckId: r.truckId, vendorId: r.vendorId, vendorName: names.get(r.vendorId) ?? r.vendorName ?? 'Vendor', companyBps, from: r.effectiveFrom, to: r.effectiveTo }];
    });
  }

  /** The generated book, labelled as such - its provenance says so, not a setting. */
  private async generated(companyId: string, range: DateRange): Promise<ReportingFacts> {
    const facts = await this.fallback.facts(companyId, range);
    return {
      ...facts,
      provenance: {
        generated: true,
        loadsOnFile: 0,
        revenueLines: facts.revenue.length,
        expenseLines: countBySource(facts.expenses),
        fuelRows: facts.fuel.length,
        fuelLatestAt: null,
        unlinkedLedgerFuel: 0,
      },
    };
  }

  /** The stored workspace, or null when nobody has used the app yet. */
  private async snapshot(companyId: string): Promise<Snapshot | null> {
    // One row per collection since the round-3 P0 work; `workspace()` reassembles them, and a
    // corrupt or absent workspace still leaves the generated book to answer.
    const row = await this.state.workspace(companyId);
    return (row?.data as Snapshot | undefined) ?? null;
  }
}

// ------------------------------------------------------------------------------ the pure builder

/** Everything `buildReportingFacts` reads, already scoped to one company. */
export interface RawReportingRows {
  loads: LoadRecord[];
  snapshot: Snapshot | null;
  ledger: LedgerFacts;
  trucks: Array<{ id: string; unitNumber: string; status: string | null; currentDriverId: string | null }>;
  drivers: Array<{ id: string; firstName: string; lastName: string; driverType: string }>;
  workOrders: WorkOrderRow[];
  fleetExpenses: FleetExpenseRowRaw[];
  driverTransactions: DriverTxRow[];
  /** Settlement id → its period end (YYYY-MM-DD). */
  settlementPeriodEnd: Map<string, string>;
  /** Driver statements (acct_settlements), for the pay not posted yet. Absent = none. */
  statements?: StatementRow[];
}

export interface StatementRow {
  id: string;
  status: string;
  partyType: string;
  partyId: string;
  periodEnd: IsoDate;
  truckId: string | null;
  settlementNumber: string;
  earnings: Array<{ loadId: string | null; cents: number; kind: string }>;
}

/**
 * Builds the facts for one company and range from rows already read. Pure: no clock, no I/O, so
 * the data-parity tests can recompute every KPI from the same rows independently.
 */
export function buildReportingFacts(
  companyId: string,
  range: DateRange,
  raw: RawReportingRows,
  timeZone: string = REPORTING_TIMEZONE,
): ReportingFacts {
  const inRange = (date: IsoDate | null): date is IsoDate =>
    date !== null && date >= range.from && date <= range.to;
  const dayOf = (at: string | null | undefined): IsoDate | null => businessDay(at, timeZone);
  const snapshot = raw.snapshot;

  // ---- revenue ------------------------------------------------------------------------
  // Revenue by DELIVERED load (Eastern delivery day), plus TONU fees on the day the broker
  // cancelled. A booked load with a planned delivery in the week is not revenue yet.
  const revenue: RevenueLine[] = [];
  for (const load of raw.loads) {
    const counted = revenueDayOf(load, timeZone);
    if (!counted || !inRange(counted.on)) continue;
    const { on, at } = counted;
    if (counted.kind === 'tonu') {
      revenue.push({
        loadId: load.id,
        loadNumber: load.loadNumber,
        // A cancel frees the truck and driver; a TONU earns no miles.
        truckId: load.truckId ?? null,
        driverId: load.driverId ?? null,
        teamId: null,
        deliveredAt: at ?? `${on}T12:00:00Z`,
        deliveredOn: on,
        linehaul: 0,
        accessorials: 0,
        tonu: tonuFeeOf(load),
        kind: 'tonu',
        loadedMiles: 0,
        emptyMiles: 0,
      });
      continue;
    }
    revenue.push({
      loadId: load.id,
      loadNumber: load.loadNumber,
      truckId: load.truckId ?? null,
      driverId: load.driverId ?? null,
      teamId: null,
      deliveredAt: at ?? `${on}T12:00:00Z`,
      deliveredOn: on,
      linehaul: round(realLinehaulOf(load)),
      accessorials: round(billedAccessorialsOf(load)),
      tonu: 0,
      kind: 'load',
      loadedMiles: Number(load.loadedMiles) || 0,
      emptyMiles: Number(load.emptyMiles) || 0,
    });
  }

  // ---- fuel ---------------------------------------------------------------------------
  const allFuel = snapshot?.fuelTransactions ?? [];
  const fuelRows = allFuel.filter((row) => inRange(dayOf(row.at)));
  const fuel: FuelTransactionFact[] = fuelRows.map((row) => ({
    id: row.id,
    at: row.at,
    date: dayOf(row.at) ?? range.from,
    truckId: row.truckId ?? null,
    driverId: row.driverId ?? null,
    state: row.station?.state ?? '',
    gallons: row.gallons ?? 0,
    grossCost: row.amount ?? 0,
    discountedCost: row.amount ?? 0,
    stationName: row.station?.name ?? '',
    product: row.product ?? 'diesel',
  }));

  // ---- expenses -----------------------------------------------------------------------
  // What Accounting posted, first: the ledger is the authority for the amount, the date and the
  // number of times a cost was recorded. Operational sources then supply what the books have NOT
  // yet taken on - matched per obligation, never per category, so posting one driver's statement
  // or one fuel purchase retires that one estimate and nobody else's.
  const { settled, postedRefs } = raw.ledger;
  const outstanding = <T extends { obligationKey?: string | null }>(line: T): boolean =>
    !(line.obligationKey && settled.has(line.obligationKey));

  // Work orders, every one the company has (not just completed), so a bill raised from one can be
  // classed by the work it paid for.
  const orderByKey = new Map<string, WorkOrderRow>();
  for (const r of raw.workOrders) {
    const key = expenseKey(`work_order:${r.id}`);
    if (key) orderByKey.set(key, r);
  }

  const expenses: ExpenseLine[] = raw.ledger.lines.map((line) => {
    const order = line.obligationKey ? orderByKey.get(line.obligationKey) : undefined;
    if (!order) return line;
    // A repair bill posts to 5300 whatever the work was; class it by the order (F20), and a
    // trailer's bill belongs to the trailer, never to a truck (owner, 2026-10-25).
    if (order.assetType === 'trailer') {
      return { ...line, category: 'trailer_repairs' as const, truckId: null, trailerId: order.unitId, trailerUnit: order.unitNumber || null };
    }
    return { ...line, category: repairCategory(order.workType), truckId: line.truckId ?? order.unitId };
  });

  // Card fuel: each purchase is its own obligation (`fuel:<transaction>`), so a posting of one
  // purchase retires that purchase only (F9). Diesel and DEF are separate lines.
  const bookedExpenses = (snapshot?.expenses ?? []).filter((row) => inRange(row.onDate));
  // The older workspace book has no per-purchase link; when it booked fuel for the range, the
  // card rows stay out as before rather than being counted beside it.
  const workspaceBookedFuel = bookedExpenses.some((row) => categoryOf(row.categoryCode) === 'fuel');
  const fuelKeys = new Set(allFuel.map((row) => expenseKey(`fuel:${row.id}`)).filter(Boolean) as string[]);
  if (!workspaceBookedFuel) {
    for (const row of fuelRows) {
      const key = expenseKey(`fuel:${row.id}`);
      if (key && settled.has(key)) continue;
      expenses.push({
        id: `fuel_${row.id}`,
        date: dayOf(row.at) ?? range.from,
        category: (row.product ?? '').toLowerCase() === 'def' ? 'def' : 'fuel',
        amount: row.amount ?? 0,
        truckId: row.truckId ?? null,
        driverId: row.driverId ?? null,
        source: 'fuel',
        isEstimate: false,
        description: row.station?.name ?? 'Fuel',
        obligationKey: key,
      });
    }
  }
  // Ledger fuel not tied to a card purchase cannot be matched; it is kept and named, since it may
  // be the same diesel as card rows (an aggregated fuel bill).
  const unlinkedLedgerFuel = round(
    raw.ledger.lines
      .filter((l) => l.category === 'fuel' && !(l.obligationKey && fuelKeys.has(l.obligationKey)))
      .reduce((s, l) => s + l.amount, 0),
  );

  for (const row of bookedExpenses) {
    const line: ExpenseLine = {
      id: row.id,
      date: row.onDate,
      category: categoryOf(row.categoryCode),
      amount: row.amount ?? 0,
      truckId: row.truckId ?? null,
      driverId: row.driverId ?? null,
      source: 'accounting',
      isEstimate: false,
      description: row.description,
      obligationKey: expenseKey(row.id),
    };
    if (outstanding(line)) expenses.push(line);
  }

  // What a driver is owed for the period (the older workspace book). Once Accounting posts that
  // driver's statement the posting replaces this line.
  for (const row of snapshot?.settlements ?? []) {
    if (!inRange(row.periodEnd) || row.status === 'reversed') continue;
    const line: ExpenseLine = {
      id: row.id,
      date: row.periodEnd,
      category: 'driver_pay',
      amount: row.net ?? 0,
      truckId: row.truckId ?? null,
      driverId: row.driverId ?? null,
      source: 'settlement',
      isEstimate: row.status === 'draft',
      description: `Settlement ${row.settlementNumber}`,
      obligationKey: driverPayKey(row.driverId ?? null, row.periodEnd ?? null),
    };
    if (outstanding(line)) expenses.push(line);
  }

  // Driver statements Accounting has not posted yet (draft, review): what the company still
  // expects to pay for that week, an ESTIMATE on the statement's period end, retired the moment the
  // statement is posted (same driver + period key). Only earnings on loads that exist in NeWay
  // Loads count, so a statement for loads that are in no table adds nothing.
  const knownLoads = new Set(raw.loads.map((l) => l.id));
  for (const s of raw.statements ?? []) {
    if (s.partyType !== 'driver' || !UNPOSTED_STATEMENT.has(s.status)) continue;
    if (!inRange(s.periodEnd || null)) continue;
    const cents = s.earnings
      .filter((e) => e.loadId && knownLoads.has(e.loadId) && e.kind !== 'reimbursement')
      .reduce((sum, e) => sum + e.cents, 0);
    if (cents <= 0) continue;
    const line: ExpenseLine = {
      id: `stm_est_${s.id}`,
      date: s.periodEnd,
      category: 'driver_pay',
      amount: cents / 100,
      truckId: s.truckId,
      driverId: s.partyId,
      source: 'settlement',
      isEstimate: true,
      description: `Statement ${s.settlementNumber} (not approved yet)`,
      obligationKey: driverPayKey(s.partyId, s.periodEnd),
      reference: `settlement:${s.id}`,
    };
    if (outstanding(line)) expenses.push(line);
  }

  // ---- repairs ------------------------------------------------------------------------
  // What the shops charged: completed work orders at their invoice total, on the Eastern day the
  // unit came back. A trailer's order is the trailer's cost; a voided completion counts not at all.
  const migrated = new Set(raw.workOrders.map((r) => r.migratedFrom).filter(Boolean));
  const alreadyBooked = new Set(
    bookedExpenses.map((row) => row.description).filter((d): d is string => Boolean(d)),
  );
  for (const r of raw.workOrders) {
    if (r.status !== 'completed') continue;
    // Vendor pays (owner, 2026-10-28): the truck's vendor paid the shop; not the company's money.
    if (r.chargeParty === 'vendor') continue;
    const date = dayOf(r.completedAt);
    if (!inRange(date)) continue;
    const amount = Number(r.invoiceTotal ?? r.total ?? 0);
    if (!(amount > 0)) continue;
    // Accounts Payable may already carry this invoice as a bill; the number is the link.
    if (r.invoiceNumber && alreadyBooked.has(r.invoiceNumber)) continue;
    // Accounting posts a repair as an expense or a bill keyed on the work order it came from.
    const key = expenseKey(`work_order:${r.id}`);
    if (key && settled.has(key)) continue;
    const trailer = r.assetType === 'trailer';
    expenses.push({
      id: `wo_${r.id}`,
      obligationKey: key,
      date,
      category: trailer ? 'trailer_repairs' : repairCategory(r.workType),
      amount,
      truckId: r.assetType === 'truck' ? r.unitId : null,
      ...(trailer ? { trailerId: r.unitId, trailerUnit: r.unitNumber || null } : {}),
      driverId: null,
      source: 'maintenance',
      isEstimate: false,
      description: `${r.number}${r.vendorName ? ` · ${r.vendorName}` : ''}`,
    });
  }
  for (const o of snapshot?.repairOrders ?? []) {
    if (o.status !== 'completed' || migrated.has(o.id)) continue;
    const roKey = expenseKey(`work_order:${o.id}`);
    if (roKey && settled.has(roKey)) continue;
    const date = dayOf(o.completedAt ?? null);
    if (!inRange(date)) continue;
    const amount = Number(o.total ?? 0);
    if (!(amount > 0)) continue;
    const trailer = o.unitType === 'trailer';
    expenses.push({
      id: `ro_${o.id}`,
      obligationKey: roKey,
      date,
      category: trailer ? 'trailer_repairs' : repairCategory(o.type ?? 'repair'),
      amount,
      truckId: trailer ? null : (o.truckId ?? null),
      ...(trailer ? { trailerId: o.truckId ?? null } : {}),
      driverId: null,
      source: 'maintenance',
      isEstimate: false,
      description: `${o.roNumber ?? o.id}${o.vendorName ? ` · ${o.vendorName}` : ''}`,
    });
  }

  // ---- manual Fleet expenses ------------------------------------------------------------
  // Parking, washes, tolls, permits... entered on the Fleet Expenses page (F18). A company cost
  // when the company paid it or bears it; a driver-paid, driver-borne one is not the company's.
  // Once Accounting has posted it (a payment or a bill), the posting is the cost and this is not.
  for (const m of raw.fleetExpenses) {
    if (!inRange(m.expenseDate)) continue;
    if (!(m.paidBy === 'company' || m.chargeTo === 'company')) continue;
    if (m.acctExpenseId && postedRefs.has(`expense:${m.acctExpenseId}`)) continue;
    if (m.acctBillId && postedRefs.has(`bill:${m.acctBillId}`)) continue;
    const key = expenseKey(`fleet_expense:${m.id}`);
    if (key && settled.has(key)) continue;
    expenses.push({
      id: `fx_${m.id}`,
      date: m.expenseDate,
      category: FLEET_EXPENSE_CATEGORY[m.category] ?? 'other',
      amount: m.amountCents / 100,
      truckId: m.truckId || null,
      driverId: null,
      source: 'fleet_expense',
      isEstimate: false,
      description: [m.reference, m.description].filter(Boolean).join(' · '),
      obligationKey: key,
    });
  }

  // ---- recovered from drivers ---------------------------------------------------------
  // Money held back on statements for costs the company paid: a negative line on the statement's
  // week, so net cost = cost - recovered (owner, 2026-10-25). Lease payments, cash advances,
  // escrow, carried balances and opening balances are not cost recoveries.
  for (const tx of raw.driverTransactions) {
    const recoveredFor = recoveryClassOf(tx);
    if (recoveredFor === null) continue;
    if (tx.companyCost || tx.state === 'void') continue;
    const parts: Array<{ settlementId: string | null; cents: number }> =
      tx.recoveryLog.length > 0
        ? tx.recoveryLog.filter((e) => !e.reversedAt).map((e) => ({ settlementId: e.settlementId ?? null, cents: Number(e.cents) || 0 }))
        : tx.recoveredCents > 0
          ? [{ settlementId: tx.settlementId, cents: tx.recoveredCents }]
          : [];
    parts.forEach((part, index) => {
      if (part.cents === 0) return;
      const date = (part.settlementId && raw.settlementPeriodEnd.get(part.settlementId)) || tx.onDate;
      if (!inRange(date)) return;
      expenses.push({
        id: `rec_${tx.id}_${index}`,
        date,
        category: 'recovered',
        amount: -part.cents / 100,
        truckId: tx.truckId,
        driverId: tx.driverId,
        source: 'recovery',
        recoveredFor,
        isEstimate: false,
        description: `Recovered · ${tx.description ?? tx.kind}`,
        reference: part.settlementId ? `settlement:${part.settlementId}` : null,
      });
    });
  }

  // A recovery never takes a cost category below zero (owner, 2026-10-25): what drivers paid back
  // for fuel can only offset fuel cost recorded in the same period. The part with no matching cost
  // (a company whose fuel is not connected) is kept out of the net and named in the provenance.
  const unappliedRecoveries = capRecoveries(expenses);
  for (let i = expenses.length - 1; i >= 0; i -= 1) {
    if (expenses[i]!.category === 'recovered' && expenses[i]!.amount === 0) expenses.splice(i, 1);
  }

  // ---- the roster ---------------------------------------------------------------------
  const driverNameById = new Map(raw.drivers.map((d) => [d.id, `${d.firstName} ${d.lastName}`]));
  const truckFacts: TruckFact[] = raw.trucks.map((truck) => ({
    truckId: truck.id,
    unitNumber: truck.unitNumber,
    status: truckStatus(truck.status),
    driverId: truck.currentDriverId ?? null,
    driverName: truck.currentDriverId ? (driverNameById.get(truck.currentDriverId) ?? null) : null,
  }));
  const driverFacts: DriverFact[] = raw.drivers.map((driver) => ({
    driverId: driver.id,
    name: `${driver.firstName} ${driver.lastName}`,
    payType: PAY_TYPE[driver.driverType] ?? null,
    rawPayTag: driver.driverType,
  }));

  // ---- coverage -----------------------------------------------------------------------
  const weeks = new Set(expenses.map((row) => weekStart(row.date)));
  const expenseCoverage: ExpenseCoverage[] = [...weeksBetween(range)].map((week) => ({
    weekStart: week,
    hasExpenseData: weeks.has(week),
  }));

  const latestFuel = allFuel.reduce<string | null>((max, row) => (row.at && (!max || row.at > max) ? row.at : max), null);
  const provenance: FactsProvenance = {
    generated: false,
    loadsOnFile: raw.loads.length,
    revenueLines: revenue.length,
    expenseLines: countBySource(expenses),
    fuelRows: fuelRows.length,
    fuelLatestAt: latestFuel,
    unlinkedLedgerFuel,
    unappliedRecoveries,
  };

  return {
    companyId,
    range: { from: range.from, to: range.to },
    revenue,
    expenses,
    fuel,
    // One miles rule (owner, 2026-10-25): RPM, CPM and PPM all divide by the load miles on the
    // revenue lines. Mileage records are for odometer (ELD) data, which reporting does not use.
    mileage: [],
    trucks: truckFacts,
    drivers: driverFacts,
    // Dispatcher teams are not a concept the workspace records yet; the dashboard says so rather
    // than inventing a split.
    dispatchWeeks: [],
    expenseCoverage,
    revenueLedgerTotal: round(revenue.reduce((s, row) => s + row.linehaul + (row.accessorials ?? 0) + (row.tonu ?? 0), 0)),
    provenance,
  };
}

/**
 * The Eastern business day of an instant; a bare `YYYY-MM-DD` is already a business day.
 * Exported for the tests: a 23:30 ET event lands on the ET day, not the UTC one.
 */
export function businessDay(at: string | null | undefined, timeZone: string = REPORTING_TIMEZONE): IsoDate | null {
  if (!at) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) return at.slice(0, 10);
  return localDateOf(instant, timeZone);
}

/** The cost categories a recovery of each kind pays back. */
export const RECOVERY_COST_CATEGORIES: Record<RecoveredFor, readonly ExpenseCategory[]> = {
  fuel: ['fuel', 'def'],
  repairs: ['repairs', 'maintenance', 'trailer_repairs'],
  damage: ['repairs', 'maintenance', 'trailer_repairs', 'other'],
  tolls: ['tolls'],
  fleet_expense: ['fuel', 'tolls', 'repairs', 'maintenance', 'other'],
};

/**
 * Scales each kind's recovery lines down (in place) so they never exceed the cost they pay back
 * in the period, and returns what was left unapplied, per kind. Kinds are capped in a fixed order
 * against the remaining cost, so two kinds cannot both use the same dollars.
 */
function capRecoveries(expenses: ExpenseLine[]): Array<{ kind: RecoveredFor; recovered: number; applied: number; cost: number }> {
  const remaining = new Map<ExpenseCategory, number>();
  for (const line of expenses) {
    if (line.category === 'recovered') continue;
    remaining.set(line.category, (remaining.get(line.category) ?? 0) + line.amount);
  }
  const out: Array<{ kind: RecoveredFor; recovered: number; applied: number; cost: number }> = [];
  for (const kind of ['fuel', 'tolls', 'repairs', 'damage', 'fleet_expense'] as RecoveredFor[]) {
    const lines = expenses.filter((l) => l.category === 'recovered' && (l.recoveredFor ?? 'damage') === kind);
    if (lines.length === 0) continue;
    const recovered = -lines.reduce((s, l) => s + l.amount, 0);
    const categories = RECOVERY_COST_CATEGORIES[kind];
    const available = Math.max(0, categories.reduce((s, c) => s + Math.max(0, remaining.get(c) ?? 0), 0));
    const applied = Math.min(recovered, available);
    if (recovered > applied + 0.005) {
      const factor = recovered === 0 ? 0 : applied / recovered;
      for (const line of lines) line.amount = round(line.amount * factor);
      out.push({ kind, recovered: round(recovered), applied: round(applied), cost: round(available) });
    }
    // Use up the matched cost so another kind cannot offset the same dollars.
    let left = applied;
    for (const c of categories) {
      const have = Math.max(0, remaining.get(c) ?? 0);
      const take = Math.min(have, left);
      remaining.set(c, have - take);
      left -= take;
    }
  }
  return out;
}

function countBySource(lines: readonly ExpenseLine[]): Partial<Record<ExpenseSource, number>> {
  const out: Partial<Record<ExpenseSource, number>> = {};
  for (const line of lines) out[line.source] = (out[line.source] ?? 0) + 1;
  return out;
}

/**
 * The business day a load counts as revenue on, and as what: the one date rule Analytics uses
 * (owner, 2026-10-25). A TONU counts on the Eastern day of the cancellation, a delivered (or closed)
 * load on its Eastern delivery day. Null for a load that is not revenue (booked, moving, cancelled
 * without a fee) or has no date. Exported so the accessorial split counts exactly the loads gross
 * counts.
 */
export function revenueDayOf(
  load: LoadRecord,
  timeZone: string = REPORTING_TIMEZONE,
): { kind: 'tonu' | 'load'; on: IsoDate; at: string | null } | null {
  if (isTonu(load)) {
    const at = load.cancellation?.at ?? load.updatedAt ?? null;
    const on = businessDay(at, timeZone);
    return on ? { kind: 'tonu', on, at } : null;
  }
  if (!COMPLETED.has(load.status)) return null;
  const at = load.deliveredAt ?? load.deliveryAt ?? lastStopAppointment(load);
  const on = businessDay(at, timeZone);
  return on ? { kind: 'load', on, at } : null;
}

export function isTonu(load: Pick<LoadRecord, 'status' | 'cancellation'>): boolean {
  return load.status === 'tonu' || load.cancellation?.outcome === 'tonu';
}

/** The TONU fee: the cancellation's agreed fee, else the TONU charge on the load. */
export function tonuFeeOf(load: LoadRecord): number {
  const fee = load.cancellation?.fee;
  if (typeof fee === 'number' && Number.isFinite(fee)) return round(fee);
  const charge = (load.charges ?? []).find((c) => c.type === 'tonu');
  return round(Number(charge?.amount) || 0);
}

/**
 * Billed accessorials at the amount billed to the broker: accepted (not draft, not dropped),
 * billable, non-linehaul, non-TONU charges. The For driver amount is a pay figure, never revenue.
 */
function billedAccessorialsOf(load: LoadRecord): number {
  let total = 0;
  for (const c of load.charges ?? []) {
    if (!isBilledAccessorial(c)) continue;
    total += Number(c.amount) || 0;
  }
  return total;
}

/** One charge that counts in billed accessorials (the rule above), exported for the split. */
export function isBilledAccessorial(c: { type: string; billable?: boolean; status?: string }): boolean {
  if (c.type === 'linehaul' || c.type === 'tonu') return false;
  if (c.status === 'draft' || c.status === 'dropped') return false;
  return c.billable !== false;
}

function lastStopAppointment(load: LoadRecord): string | null {
  const stops = load.stops ?? [];
  const last = [...stops].reverse().find((s) => s.kind === 'delivery') ?? stops.at(-1);
  return last?.appointmentStartAt ?? null;
}

const repairCategory = (workType: string): ExpenseCategory =>
  workType === 'oil_change' || workType === 'pm_inspection' || workType === 'annual_inspection'
    ? 'maintenance'
    : 'repairs';

/** Fleet expense categories to the reporting vocabulary. */
const FLEET_EXPENSE_CATEGORY: Record<string, ExpenseCategory> = {
  fuel: 'fuel',
  tolls: 'tolls',
  repair_maintenance: 'repairs',
};

/**
 * Whether a driver-account charge is a charge-back of a cost the company paid, and of what
 * (owner, 2026-10-25). Only fuel, repairs, tolls, damage/claims and company-paid Fleet expenses
 * count. NOT recoveries: lease payments, opening balances, carried balances, advances, escrow,
 * recurring deductions, fines, tickets and safety violations, per-mile charges, equipment,
 * uniforms and "Other" charges that name none of the above.
 */
export function recoveryClassOf(tx: Pick<DriverTxRow, 'kind' | 'source' | 'description'>): RecoveredFor | null {
  if (tx.source === 'lease' || tx.source === 'opening' || tx.source === 'safety_violation') return null;
  if (tx.kind === 'fuel') return 'fuel';
  if (tx.kind === 'tolls') return 'tolls';
  if (tx.kind === 'repair' || tx.source === 'work_order') return 'repairs';
  if (tx.kind !== 'manual_charge') return null;
  if (tx.source === 'driver_charge') return 'damage';
  if (tx.source === 'fleet_expense') return 'fleet_expense';
  const text = (tx.description ?? '').trim().toLowerCase();
  if (/^(fine|ticket|violation)/.test(text) || /cost per mile|per mile/.test(text)) return null;
  if (/^damage/.test(text)) return 'damage';
  if (/\bfuel\b|\bdef\b/.test(text)) return 'fuel';
  if (/\btolls?\b/.test(text)) return 'tolls';
  if (/\brepair|\bshop charge/.test(text)) return 'repairs';
  return null;
}

/**
 * Roster statuses to the reporting vocabulary.
 *
 * The roster carries a couple of words reporting has no bucket for — `active` is a roster idea,
 * not a duty state — so they map to the nearest true statement rather than being passed through
 * and rejected by the contract.
 */
const TRUCK_STATUS: Record<string, TruckFact['status']> = {
  available: 'available',
  assigned: 'assigned',
  driving: 'driving',
  idle: 'idle',
  in_shop: 'in_shop',
  maintenance: 'maintenance',
  out_of_service: 'out_of_service',
  accident: 'accident',
  sold: 'sold',
  archived: 'archived',
  active: 'available',
  inactive: 'idle',
};

function truckStatus(value: string | null | undefined): TruckFact['status'] {
  return TRUCK_STATUS[(value ?? '').toLowerCase()] ?? 'idle';
}

/** Statement states whose pay is expected but not posted. Approved and paid are posted. */
const UNPOSTED_STATEMENT = new Set(['draft', 'review']);

/** Statuses that count as revenue on the dashboard: delivered, or closed after delivery. */
const COMPLETED = new Set(['delivered', 'closed']);

const PAY_TYPE: Record<string, DriverFact['payType']> = {
  company: 'company',
  owner_operator: 'owner_operator',
  lease_operator: 'lease_owner',
};

const EXPENSE_CATEGORY: Record<string, ExpenseLine['category']> = {
  fuel: 'fuel',
  def: 'def',
  insurance: 'insurance',
  maintenance: 'maintenance',
  repairs: 'repairs',
  tolls: 'tolls',
  dispatch_fee: 'dispatch_fee',
  factoring: 'factoring',
  driver_pay: 'driver_pay',
};

function categoryOf(code: string | null | undefined): ExpenseLine['category'] {
  return EXPENSE_CATEGORY[(code ?? '').toLowerCase()] ?? 'other';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Monday-start week, matching the reporting engines' own week handling. */
function weekStart(date: IsoDate): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function* weeksBetween(range: DateRange): Generator<IsoDate> {
  let cursor = weekStart(range.from);
  while (cursor <= range.to) {
    yield cursor;
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    cursor = d.toISOString().slice(0, 10);
  }
}

/** A load as the loads table stores it: only the fields reporting reads. */
export interface LoadRecord {
  id: string;
  loadNumber: string;
  status: string;
  truckId: string | null;
  driverId: string | null;
  rate: number;
  loadedMiles: number;
  emptyMiles: number;
  deliveryAt?: string | null;
  deliveredAt: string | null;
  updatedAt?: string | null;
  charges?: Array<{ id?: string; type: string; amount: number; billable?: boolean; status?: string; driverAmount?: number | null }>;
  cancellation?: { outcome: string; fee: number | null; at?: string | null } | null;
  stops?: Array<{ kind: string; appointmentStartAt?: string | null }>;
}

export interface WorkOrderRow {
  id: string;
  number: string;
  status: string;
  workType: string;
  assetType: string;
  unitId: string;
  unitNumber: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceTotal: number | null;
  total: number | null;
  completedAt: string | null;
  migratedFrom: string | null;
  /** Who pays (work order charge party); absent on older rows. */
  chargeParty?: string | null;
}

export interface FleetExpenseRowRaw {
  id: string;
  reference: string;
  truckId: string;
  category: string;
  expenseDate: IsoDate;
  amountCents: number;
  paidBy: string;
  chargeTo: string;
  acctExpenseId: string | null;
  acctBillId: string | null;
  description: string | null;
}

interface RecoveryLogRow {
  settlementId?: string | null;
  cents: number;
  reversedAt?: string | null;
}

export interface DriverTxRow {
  id: string;
  driverId: string;
  kind: string;
  onDate: IsoDate;
  recoveredCents: number;
  state: string;
  source: string;
  truckId: string | null;
  settlementId: string | null;
  companyCost: boolean;
  recoveryLog: RecoveryLogRow[];
  description: string | null;
}

/** Only the slices of the browser snapshot this source reads. */
export interface Snapshot {
  fuelTransactions?: Array<{
    id: string;
    at: string;
    truckId: string | null;
    driverId: string | null;
    gallons: number;
    amount: number;
    /** `diesel` or `def` (Relay). */
    product?: string;
    station?: { name?: string; state?: string };
  }>;
  expenses?: Array<{
    id: string;
    onDate: IsoDate;
    categoryCode: string;
    description: string;
    amount: number;
    truckId: string | null;
    driverId: string | null;
  }>;
  repairOrders?: Array<{
    id: string;
    roNumber?: string;
    status: string;
    type?: string;
    truckId?: string | null;
    unitType?: string | null;
    vendorName?: string | null;
    completedAt?: string | null;
    total?: number | null;
  }>;
  settlements?: Array<{
    id: string;
    settlementNumber: string;
    driverId: string;
    truckId: string | null;
    periodEnd: IsoDate;
    status: string;
    net: number;
  }>;
}

/** Kept so the module can name the company the snapshot belongs to. */
export const SNAPSHOT_COMPANY_ID = DEMO_COMPANY.id;
