import { eq } from 'drizzle-orm';
import {
  accountFor,
  driverPayKey,
  expenseKey,
  factoringKey,
  staffPayrollKey,
  type ExpenseCategory,
  type JournalEntry,
} from '@neway/shared';
import type { DatabaseService } from '../../../database/database.service';
import {
  acctBills,
  acctExpenses,
  acctInvoices,
  acctJournalEntries,
  acctSettlements,
} from '../../../database/schema/accounting';
import type { ExpenseLine } from '../facts';

/**
 * What a period actually cost, from the accounting ledger.
 *
 * The dashboard used to read costs from the browser workspace, which is not where Accounting
 * books anything: a company whose costs live in `acct_*` saw "no expense data" and a profit that
 * was really just revenue. These lines come from the posted journal instead, so the dashboard and
 * Accounting cannot disagree about the amount, the date or the number of times a cost was
 * recorded.
 *
 * Three properties follow from reading the journal rather than re-deriving from the operational
 * records:
 *
 * - **A payment is never a second expense.** Paying a driver or a staff member debits the
 *   liability and credits cash; it touches no expense account, so it cannot appear here. An
 *   approved-but-unpaid statement is already a cost (the work was done) and remains a liability
 *   until it is paid.
 * - **The date basis is Accounting's own.** A line lands on the day the entry was posted, which
 *   is the day the period, the P&L and the trial balance all use.
 * - **Nothing is counted twice.** A reversal posts mirrored lines, and the net of debits minus
 *   credits per account is what the period carries.
 *
 * Each line keeps the reference the entry was posted from, so every figure drills down to the
 * settlement, invoice or expense behind it, and to the load when the record names one. It also
 * keeps the **obligation key** the entry settles, which is how an unposted estimate knows that
 * its own posting has arrived — see `settledObligationKeys`.
 */

/** A posted expense account to the dashboard's cost vocabulary. Unlisted expense accounts are "other". */
const CATEGORY_BY_ACCOUNT: Record<string, ExpenseCategory> = {
  '5100': 'fuel',
  '5200': 'driver_pay',
  '5300': 'maintenance',
  '5400': 'tolls',
  '6100': 'insurance',
  '6400': 'staff_payroll',
  '6500': 'staff_payroll',
  '6600': 'factoring',
};

export interface LoadDimension {
  loadNumber: string;
  truckId: string | null;
  driverId: string | null;
}

interface Dimensions {
  truckId: string | null;
  driverId: string | null;
  loadNumber: string | null;
  /** The obligation the entry settles, when the referenced record identifies one. */
  obligationKey: string | null;
  /**
   * The day the cost belongs to when it is not the posting day: a driver statement's period end,
   * so pay lands in the week it was earned, not the week Accounting posted it (owner, 2026-10-25).
   */
  earnedOn?: string | null;
}

const NONE: Dimensions = { truckId: null, driverId: null, loadNumber: null, obligationKey: null };

/** The net of debits minus credits across an entry's expense accounts, in cents. */
function expenseCentsOf(entry: JournalEntry): number {
  let cents = 0;
  for (const line of entry.lines) {
    if (accountFor(line.accountCode)?.type !== 'expense') continue;
    cents += line.debit - line.credit;
  }
  return cents;
}

/**
 * Resolves what each entry is about, by looking up the records its reference points at.
 *
 * `loads` supplies the operational dimensions (unit, driver, load number) for the drill-down; pass
 * an empty map when only the obligation keys are wanted.
 */
async function resolveDimensions(
  database: DatabaseService,
  companyId: string,
  entries: readonly JournalEntry[],
  loads: Map<string, LoadDimension>,
): Promise<Map<string, Dimensions>> {
  const referenced = (type: string) =>
    new Set(entries.filter((e) => e.reference?.type === type).map((e) => e.reference!.id));
  const settlementIds = referenced('settlement');
  const invoiceIds = referenced('invoice');
  const expenseIds = referenced('expense');
  const billIds = referenced('bill');

  const settlements = new Map<string, Dimensions>();
  if (settlementIds.size > 0) {
    const stored = await database.db
      .select({ id: acctSettlements.id, partyType: acctSettlements.partyType, partyId: acctSettlements.partyId, record: acctSettlements.record })
      .from(acctSettlements)
      .where(eq(acctSettlements.companyId, companyId));
    for (const row of stored) {
      if (!settlementIds.has(row.id)) continue;
      const record = row.record as { truckId?: string | null; loadIds?: string[]; periodEnd?: string | null };
      const loadIds = record.loadIds ?? [];
      const numbers = loadIds.map((id) => loads.get(id)?.loadNumber).filter((n): n is string => Boolean(n));
      settlements.set(row.id, {
        truckId: record.truckId ?? (loadIds.map((id) => loads.get(id)?.truckId).find(Boolean) ?? null),
        driverId: row.partyType === 'driver' ? row.partyId : null,
        // A weekly statement can pay several loads; the drill-down says which, and says so plainly.
        loadNumber: numbers.length === 1 ? numbers[0]! : numbers.length > 1 ? `${numbers.length} loads: ${numbers.join(', ')}` : null,
        // This driver, for this settlement period: the same pair the unposted estimate knows.
        obligationKey: row.partyType === 'driver' ? driverPayKey(row.partyId, record.periodEnd ?? null) : null,
        earnedOn: typeof record.periodEnd === 'string' ? record.periodEnd.slice(0, 10) : null,
      });
    }
  }

  const invoices = new Map<string, Dimensions>();
  if (invoiceIds.size > 0) {
    const stored = await database.db
      .select({ id: acctInvoices.id, loadId: acctInvoices.loadId })
      .from(acctInvoices)
      .where(eq(acctInvoices.companyId, companyId));
    for (const row of stored) {
      if (!invoiceIds.has(row.id)) continue;
      const load = row.loadId ? loads.get(row.loadId) : undefined;
      invoices.set(row.id, {
        truckId: load?.truckId ?? null,
        driverId: load?.driverId ?? null,
        loadNumber: load?.loadNumber ?? null,
        // An expense posted against an invoice is the factoring fee charged on funding it.
        obligationKey: factoringKey(row.id),
      });
    }
  }

  const expenses = new Map<string, Dimensions>();
  if (expenseIds.size > 0) {
    const stored = await database.db
      .select({ id: acctExpenses.id, sourceKey: acctExpenses.sourceKey, truckId: acctExpenses.truckId, driverId: acctExpenses.driverId, loadId: acctExpenses.loadId })
      .from(acctExpenses)
      .where(eq(acctExpenses.companyId, companyId));
    for (const row of stored) {
      if (!expenseIds.has(row.id)) continue;
      expenses.set(row.id, {
        truckId: row.truckId ?? null,
        driverId: row.driverId ?? null,
        loadNumber: row.loadId ? (loads.get(row.loadId)?.loadNumber ?? null) : null,
        // The source key is what the accounting record carries back to the operational record it
        // came from (`work_order:<id>`, a fuel transaction); its own id only ever matches itself.
        obligationKey: expenseKey(row.sourceKey || row.id),
      });
    }
  }

  // A vendor bill raised from a repair order is that repair's cost: keyed like the repair, so the
  // repair's own estimate is retired by the bill instead of being counted beside it.
  const bills = new Map<string, Dimensions>();
  if (billIds.size > 0) {
    const stored = await database.db
      .select({ id: acctBills.id, source: acctBills.source, sourceKey: acctBills.sourceKey, truckId: acctBills.truckId, loadId: acctBills.loadId })
      .from(acctBills)
      .where(eq(acctBills.companyId, companyId));
    for (const row of stored) {
      if (!billIds.has(row.id)) continue;
      const repair = row.sourceKey.startsWith('repair_order:') ? row.sourceKey.slice('repair_order:'.length) : null;
      bills.set(row.id, {
        truckId: row.truckId ?? null,
        driverId: null,
        loadNumber: row.loadId ? (loads.get(row.loadId)?.loadNumber ?? null) : null,
        obligationKey: repair ? expenseKey(`work_order:${repair}`) : expenseKey(row.sourceKey || row.id),
      });
    }
  }

  const out = new Map<string, Dimensions>();
  for (const entry of entries) {
    const ref = entry.reference;
    if (!ref) {
      out.set(entry.id, NONE);
      continue;
    }
    if (ref.type === 'settlement') out.set(entry.id, settlements.get(ref.id) ?? NONE);
    else if (ref.type === 'invoice') out.set(entry.id, invoices.get(ref.id) ?? NONE);
    else if (ref.type === 'expense') out.set(entry.id, expenses.get(ref.id) ?? NONE);
    else if (ref.type === 'bill') out.set(entry.id, bills.get(ref.id) ?? NONE);
    // Staff payroll, taxes and other company-level postings belong to no truck or driver: they are
    // overhead, and attributing them to a unit would make that unit look unprofitable by accident.
    else if (ref.type === 'payroll_period') out.set(entry.id, { ...NONE, obligationKey: staffPayrollKey(ref.id) });
    else out.set(entry.id, NONE);
  }
  return out;
}

/** Everything one read of a company's ledger yields. */
export interface LedgerFacts {
  /** Posted cost lines whose effective day falls in the range. */
  lines: ExpenseLine[];
  /**
   * Every obligation the books have taken on, whatever period it was posted in (see
   * `settledObligationKeys`).
   */
  settled: Set<string>;
  /**
   * `<type>:<id>` of every accounting record (expense, bill, ...) whose postings carry a non-zero
   * expense, whatever their date: an operational record linked to one of these is already in the
   * books and must not be counted again (a posted Fleet expense, 2026-10-25).
   */
  postedRefs: Set<string>;
}

/**
 * One read of the company's journal: the period's cost lines, and the matching sets the
 * operational sources are reconciled against.
 *
 * Deliberately not limited to the range being shown when matching. A week's driver pay is usually
 * settled in the following week: if an estimate were only retired by a posting inside its own
 * period, a range covering both would carry the estimate and the posting as two separate costs.
 *
 * Dating: a line lands on the day it was posted, except a driver statement's pay, which lands on
 * the statement's period end - the week the pay was earned (owner, 2026-10-25). A statement
 * posted, reopened and posted again nets to the same pay in that one week.
 *
 * A key whose entries net to zero is not settled. A posting that was reversed leaves the company
 * owing the money again, so its estimate has to come back rather than disappear silently.
 *
 * `loads` carries the operational dimensions the accounting records point at, so a driver's
 * settlement reaches the truck that earned it and a factoring fee reaches the load it was
 * charged on.
 */
export async function ledgerFacts(
  database: DatabaseService,
  companyId: string,
  range: { from: string; to: string },
  loads: Map<string, LoadDimension>,
): Promise<LedgerFacts> {
  const rows = await database.db
    .select({ record: acctJournalEntries.record })
    .from(acctJournalEntries)
    .where(eq(acctJournalEntries.companyId, companyId));
  const entries = rows.map((row) => row.record as unknown as JournalEntry);
  if (entries.length === 0) return { lines: [], settled: new Set(), postedRefs: new Set() };

  const dimensions = await resolveDimensions(database, companyId, entries, loads);

  const net = new Map<string, number>();
  const refNet = new Map<string, number>();
  for (const entry of entries) {
    const cents = expenseCentsOf(entry);
    const key = dimensions.get(entry.id)?.obligationKey;
    if (key) net.set(key, (net.get(key) ?? 0) + cents);
    if (entry.reference) {
      const ref = `${entry.reference.type}:${entry.reference.id}`;
      refNet.set(ref, (refNet.get(ref) ?? 0) + cents);
    }
  }
  const settled = new Set<string>();
  for (const [key, cents] of net) if (cents !== 0) settled.add(key);
  const postedRefs = new Set<string>();
  for (const [ref, cents] of refNet) if (cents !== 0) postedRefs.add(ref);

  const lines: ExpenseLine[] = [];
  for (const entry of entries) {
    const dims = dimensions.get(entry.id) ?? NONE;
    const date = (entry.reference?.type === 'settlement' && dims.earnedOn) || entry.onDate;
    if (!(date >= range.from && date <= range.to)) continue;
    const byAccount = new Map<string, number>();
    for (const line of entry.lines) {
      if (accountFor(line.accountCode)?.type !== 'expense') continue;
      byAccount.set(line.accountCode, (byAccount.get(line.accountCode) ?? 0) + line.debit - line.credit);
    }
    for (const [accountCode, cents] of byAccount) {
      if (cents === 0) continue;
      lines.push({
        id: `jrn_${entry.id}_${accountCode}`,
        date,
        category: CATEGORY_BY_ACCOUNT[accountCode] ?? 'other',
        amount: cents / 100,
        truckId: dims.truckId,
        driverId: dims.driverId,
        source: 'ledger',
        isEstimate: false,
        description: entry.reference ? `${entry.reference.label} · ${entry.memo}` : entry.memo,
        loadNumber: dims.loadNumber,
        reference: entry.reference ? `${entry.reference.type}:${entry.reference.id}` : null,
        obligationKey: dims.obligationKey,
      });
    }
  }
  return { lines, settled, postedRefs };
}

/** Every obligation the books have taken on, whatever period it was posted in. */
export async function settledObligationKeys(
  database: DatabaseService,
  companyId: string,
): Promise<Set<string>> {
  return (await ledgerFacts(database, companyId, { from: '9999-12-31', to: '0000-01-01' }, new Map())).settled;
}

/** Posted costs for one company and range, as dashboard expense lines (see `ledgerFacts`). */
export async function postedAccountingCosts(
  database: DatabaseService,
  companyId: string,
  range: { from: string; to: string },
  loads: Map<string, LoadDimension>,
): Promise<ExpenseLine[]> {
  return (await ledgerFacts(database, companyId, range, loads)).lines;
}
