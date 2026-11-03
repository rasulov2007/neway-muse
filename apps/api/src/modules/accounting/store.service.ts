import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { conflict, notFound } from '../dispatch-board/ops.helpers';

/**
 * The accounting store: one small layer over the `acct_*` tables (migration 0035).
 *
 * Every table holds `record` (the document the screens read) beside the columns the server
 * filters and enforces on; the columns are derived from the record on every write by the
 * table's `columns` function, so the two cannot drift. Every write names the version it read
 * and bumps it - a stale write is refused - and every insert carries a source key that the
 * database keeps unique, so a retried event lands once.
 */

export type AcctTable =
  | 'acct_invoices'
  | 'acct_payments'
  | 'acct_bills'
  | 'acct_expenses'
  | 'acct_journal_entries'
  | 'acct_driver_transactions'
  | 'acct_recurring_deductions'
  | 'acct_vendor_arrangements'
  | 'acct_settlement_batches'
  | 'acct_settlements'
  | 'acct_payee_profiles'
  | 'acct_payment_batches'
  | 'acct_payroll_periods'
  | 'acct_staff_pay_plans'
  | 'acct_import_records'
  | 'acct_deliveries'
  | 'acct_billing_exceptions'
  | 'acct_completions';

type Rec = Record<string, unknown>;
type Cols = Record<string, string | number | boolean | null>;

/** The indexed columns each table derives from its record. */
const COLUMNS: Record<AcctTable, (r: Rec) => Cols> = {
  acct_invoices: (r) => ({
    invoice_number: str(r.invoiceNumber),
    family: str(r.family ?? r.invoiceNumber),
    revision: num(r.revision ?? 1),
    is_current: r.isCurrent !== false,
    load_id: nstr(r.loadId),
    bill_to_type: str(r.billToType),
    bill_to_id: str(r.billToId),
    status: str(r.status),
    issued_on: nstr(r.issuedOn),
    due_on: nstr(r.dueOn),
    total_cents: cents(r.total),
    balance_cents: cents(r.balance),
    source_key: str(r.sourceKey ?? r.id),
  }),
  acct_payments: (r) => ({ direction: str(r.direction), party_type: str(r.partyType), party_id: str(r.partyId), received_on: str(r.receivedOn), amount_cents: cents(r.amount), source_key: str(r.sourceKey ?? r.id) }),
  acct_bills: (r) => ({ bill_number: str(r.billNumber), vendor_id: str(r.vendorId), status: str(r.status), due_on: str(r.dueOn), amount_cents: cents(r.amount), balance_cents: cents(r.balance), source: str(r.source), source_key: str(r.sourceKey ?? r.id), truck_id: nstr(r.truckId), load_id: nstr(r.loadId) }),
  acct_expenses: (r) => ({ on_date: str(r.onDate), category: str(r.categoryCode), amount_cents: cents(r.amount), truck_id: nstr(r.truckId), driver_id: nstr(r.driverId), load_id: nstr(r.loadId), vendor_id: nstr(r.vendorId), source: str(r.source), source_key: str(r.sourceKey ?? r.id), burden: str(r.burden ?? 'company_borne'), status: str(r.status) }),
  acct_journal_entries: (r) => ({ on_date: str(r.onDate), source: str(r.source), source_key: str(r.sourceKey), memo: str(r.memo ?? ''), reversal_of: nstr(r.reversalOf), posted_at: str(r.postedAt), posted_by: str(r.postedBy ?? '') }),
  acct_driver_transactions: (r) => ({ driver_id: str(r.driverId), kind: str(r.kind), on_date: str(r.onDate), amount_cents: num(r.amountCents), recovered_cents: num(r.recoveredCents ?? 0), state: str(r.state), source: str(r.source), source_key: str(r.sourceKey), truck_id: nstr(r.truckId), load_id: nstr(r.loadId), settlement_id: nstr(r.settlementId) }),
  acct_recurring_deductions: (r) => ({ driver_id: str(r.driverId), category: str(r.category), cadence: str(r.cadence), amount_cents: num(r.amountCents), starts_on: str(r.startsOn), ends_on: nstr(r.endsOn), status: str(r.status) }),
  acct_vendor_arrangements: (r) => ({ vendor_id: str(r.vendorId), truck_id: str(r.truckId), effective_from: str(r.effectiveFrom), effective_to: nstr(r.effectiveTo), percent_bps: r.percentBps === null || r.percentBps === undefined ? null : num(r.percentBps) }),
  acct_settlement_batches: (r) => ({ kind: str(r.kind), period_start: str(r.periodStart), period_end: str(r.periodEnd), cutoff_at: str(r.cutoffAt), pay_date: str(r.payDate), status: str(r.status) }),
  acct_settlements: (r) => ({ batch_id: nstr(r.batchId), kind: str(r.kind), party_type: str(r.partyType), party_id: str(r.partyId), period_start: str(r.periodStart), period_end: str(r.periodEnd), status: str(r.status), net_cents: num(r.netCents ?? 0), payable_cents: num(r.payableCents ?? 0), carry_cents: num(r.carryCents ?? 0), source_key: str(r.sourceKey) }),
  acct_payee_profiles: (r) => ({ party_type: str(r.partyType), party_id: str(r.partyId), legal_name: str(r.legalName), account_type: nstr(r.accountType), account_last4: nstr(r.accountLast4), verified_at: nstr(r.verifiedAt), verified_by: nstr(r.verifiedBy) }),
  acct_payment_batches: (r) => ({ kind: str(r.kind), status: str(r.status) }),
  acct_payroll_periods: (r) => ({ kind: str(r.kind), period_start: str(r.periodStart), period_end: str(r.periodEnd), pay_date: str(r.payDate), status: str(r.status) }),
  acct_staff_pay_plans: (r) => ({ employee_id: str(r.employeeId), kind: str(r.kind), effective_from: str(r.effectiveFrom), effective_to: nstr(r.effectiveTo) }),
  acct_import_records: (r) => ({ provider: str(r.provider), source_key: str(r.sourceKey), occurred_on: str(r.occurredOn), amount_cents: num(r.amountCents), state: str(r.state), truck_id: nstr(r.truckId), driver_id: nstr(r.driverId) }),
  acct_deliveries: (r) => ({ document_type: str(r.documentType), document_id: str(r.documentId), channel: str(r.channel), recipient: nstr(r.recipient), status: str(r.status) }),
  acct_billing_exceptions: (r) => ({ load_id: str(r.loadId), kind: str(r.kind), status: str(r.status) }),
  acct_completions: (r) => ({ load_id: str(r.loadId), load_number: str(r.loadNumber), load_status: str(r.loadStatus), state: str(r.state), source_key: str(r.id) }),
};

/** Tables without a version column. */
const UNVERSIONED: ReadonlySet<AcctTable> = new Set(['acct_journal_entries', 'acct_deliveries']);

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
function nstr(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
/** Dollars on the record → cents in the column. */
function cents(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export interface Stored<T> {
  id: string;
  version: number;
  record: T;
}

function parsed<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

@Injectable()
export class AccountingStore {
  constructor(private readonly database: DatabaseService) {}

  get db() {
    return this.database.db;
  }

  /** Every row of a table for the company, optionally narrowed by an extra SQL condition. */
  async list<T = Rec>(table: AcctTable, companyId: string, where?: ReturnType<typeof sql>, orderBy = 'created_at desc'): Promise<Stored<T>[]> {
    const version = UNVERSIONED.has(table) ? sql`1 as version` : sql`version`;
    const order = table === 'acct_journal_entries' ? 'posted_at desc' : table === 'acct_payee_profiles' ? 'updated_at desc' : orderBy;
    const rows = await this.db.execute(
      sql`select id, ${version}, record from ${sql.raw(table)} where company_id = ${companyId} ${where ? sql`and ${where}` : sql``} order by ${sql.raw(order)}`,
    );
    return (rows as unknown as Array<{ id: string; version: number; record: unknown }>).map((r) => ({ id: r.id, version: Number(r.version), record: parsed<T>(r.record) }));
  }

  async find<T = Rec>(table: AcctTable, companyId: string, id: string): Promise<Stored<T> | null> {
    const rows = await this.list<T>(table, companyId, sql`id = ${id}`);
    return rows[0] ?? null;
  }

  async get<T = Rec>(table: AcctTable, companyId: string, id: string): Promise<Stored<T>> {
    const row = await this.find<T>(table, companyId, id);
    if (!row) throw notFound(`${table.replace('acct_', '').replace(/_/g, ' ')} ${id} is not on file.`);
    return row;
  }

  /** Inserts; a duplicate source key means the event already landed, and the existing row is returned. */
  async insert<T extends object>(table: AcctTable, companyId: string, record: T & { id: string }): Promise<{ stored: Stored<T>; created: boolean }> {
    const cols = COLUMNS[table](record as unknown as Rec);
    const names = Object.keys(cols);
    const values = names.map((n) => cols[n]);
    const existingKey = 'source_key' in cols ? sql`select id, ${UNVERSIONED.has(table) ? sql`1 as version` : sql`version`}, record from ${sql.raw(table)} where company_id = ${companyId} and source_key = ${cols.source_key as string}` : null;
    if (existingKey) {
      const dup = (await this.db.execute(existingKey)) as unknown as Array<{ id: string; version: number; record: unknown }>;
      if (dup[0]) return { stored: { id: dup[0].id, version: Number(dup[0].version), record: parsed<T>(dup[0].record) }, created: false };
    }
    const colSql = sql.join([sql.raw('id'), sql.raw('company_id'), ...names.map((n) => sql.raw(n)), sql.raw('record')], sql`, `);
    const valSql = sql.join([sql`${record.id}`, sql`${companyId}`, ...values.map((v) => sql`${v}`), sql`${JSON.stringify(record)}::jsonb`], sql`, `);
    await this.db.execute(sql`insert into ${sql.raw(table)} (${colSql}) values (${valSql})`);
    return { stored: { id: record.id, version: 1, record }, created: true };
  }

  /**
   * Replaces the record, checking the version the caller read. Columns are re-derived. A
   * stale version is a conflict, never an overwrite.
   */
  async update<T extends object>(table: AcctTable, companyId: string, id: string, expectedVersion: number, record: T): Promise<Stored<T>> {
    const cols = COLUMNS[table](record as unknown as Rec);
    const sets = [...Object.entries(cols).map(([n, v]) => sql`${sql.raw(n)} = ${v}`), sql`record = ${JSON.stringify(record)}::jsonb`];
    if (!UNVERSIONED.has(table)) sets.push(sql`version = version + 1`);
    if (table !== 'acct_journal_entries' && table !== 'acct_deliveries' && table !== 'acct_recurring_deductions' && table !== 'acct_vendor_arrangements' && table !== 'acct_staff_pay_plans') sets.push(sql`updated_at = now()`);
    const versionCheck = UNVERSIONED.has(table) ? sql`` : sql`and version = ${expectedVersion}`;
    const rows = (await this.db.execute(
      sql`update ${sql.raw(table)} set ${sql.join(sets, sql`, `)} where company_id = ${companyId} and id = ${id} ${versionCheck} returning id, ${UNVERSIONED.has(table) ? sql`1 as version` : sql`version`}`,
    )) as unknown as Array<{ id: string; version: number }>;
    if (!rows[0]) {
      const exists = await this.find(table, companyId, id);
      if (!exists) throw notFound(`${id} is not on file.`);
      throw conflict(`${id} changed since you read it (version ${exists.version}). Reload and try again.`);
    }
    return { id, version: Number(rows[0].version), record };
  }

  /** Read-modify-write under a row lock, with the version check inside the transaction. */
  async modify<T extends object>(table: AcctTable, companyId: string, id: string, change: (record: T, version: number) => T | Promise<T>): Promise<Stored<T>> {
    return this.db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`select id, ${UNVERSIONED.has(table) ? sql`1 as version` : sql`version`}, record from ${sql.raw(table)} where company_id = ${companyId} and id = ${id} for update`)) as unknown as Array<{ id: string; version: number; record: unknown }>;
      const row = rows[0];
      if (!row) throw notFound(`${id} is not on file.`);
      const before = parsed<T>(row.record);
      const after = await change(structuredClone(before), Number(row.version));
      const cols = COLUMNS[table](after as unknown as Rec);
      const sets = [...Object.entries(cols).map(([n, v]) => sql`${sql.raw(n)} = ${v}`), sql`record = ${JSON.stringify(after)}::jsonb`];
      if (!UNVERSIONED.has(table)) sets.push(sql`version = version + 1`);
      await tx.execute(sql`update ${sql.raw(table)} set ${sql.join(sets, sql`, `)} where company_id = ${companyId} and id = ${id}`);
      return { id, version: Number(row.version) + (UNVERSIONED.has(table) ? 0 : 1), record: after };
    });
  }

  // ------------------------------------------------------------ the two keyed tables

  async settings(companyId: string): Promise<{ version: number; record: Rec }> {
    const rows = (await this.db.execute(sql`select version, record from acct_settings where company_id = ${companyId}`)) as unknown as Array<{ version: number; record: unknown }>;
    if (!rows[0]) return { version: 0, record: {} };
    return { version: Number(rows[0].version), record: parsed<Rec>(rows[0].record) };
  }

  async saveSettings(companyId: string, expectedVersion: number, record: Rec, by: string): Promise<{ version: number; record: Rec }> {
    if (expectedVersion === 0) {
      const inserted = (await this.db.execute(sql`insert into acct_settings (company_id, version, record, updated_by) values (${companyId}, 1, ${JSON.stringify(record)}::jsonb, ${by}) on conflict (company_id) do nothing returning version`)) as unknown as Array<{ version: number }>;
      if (!inserted[0]) throw conflict('Settings already exist (created meanwhile). Reload and save again.');
      return { version: 1, record };
    }
    const rows = (await this.db.execute(sql`update acct_settings set record = ${JSON.stringify(record)}::jsonb, version = version + 1, updated_at = now(), updated_by = ${by} where company_id = ${companyId} and version = ${expectedVersion} returning version`)) as unknown as Array<{ version: number }>;
    if (!rows[0]) throw conflict('Settings changed since you read them. Reload and try again.');
    return { version: Number(rows[0].version), record };
  }

  async ledgerPeriods(companyId: string): Promise<Array<{ id: string; year: number; month: number; status: string; closedAt: string | null; closedBy: string | null }>> {
    const rows = (await this.db.execute(sql`select id, year, month, status, closed_at, closed_by from acct_ledger_periods where company_id = ${companyId} order by year, month`)) as unknown as Array<{ id: string; year: number; month: number; status: string; closed_at: Date | string | null; closed_by: string | null }>;
    return rows.map((r) => ({ id: r.id, year: Number(r.year), month: Number(r.month), status: r.status, closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null, closedBy: r.closed_by }));
  }

  async upsertLedgerPeriod(companyId: string, id: string, patch: { status: string; closedAt: string | null; closedBy: string | null }): Promise<void> {
    const [year, month] = id.split('-').map(Number);
    await this.db.execute(
      sql`insert into acct_ledger_periods (id, company_id, year, month, status, closed_at, closed_by) values (${id}, ${companyId}, ${year ?? 0}, ${month ?? 0}, ${patch.status}, ${patch.closedAt}, ${patch.closedBy})
          on conflict (company_id, id) do update set status = excluded.status, closed_at = excluded.closed_at, closed_by = excluded.closed_by`,
    );
  }

  async driverProfile(companyId: string, driverId: string): Promise<{ version: number; contractType: string; record: Rec } | null> {
    const rows = (await this.db.execute(sql`select version, contract_type, record from acct_driver_profiles where company_id = ${companyId} and driver_id = ${driverId}`)) as unknown as Array<{ version: number; contract_type: string; record: unknown }>;
    if (!rows[0]) return null;
    return { version: Number(rows[0].version), contractType: rows[0].contract_type, record: parsed<Rec>(rows[0].record) };
  }

  async driverProfiles(companyId: string): Promise<Array<{ driverId: string; version: number; contractType: string; record: Rec }>> {
    const rows = (await this.db.execute(sql`select driver_id, version, contract_type, record from acct_driver_profiles where company_id = ${companyId}`)) as unknown as Array<{ driver_id: string; version: number; contract_type: string; record: unknown }>;
    return rows.map((r) => ({ driverId: r.driver_id, version: Number(r.version), contractType: r.contract_type, record: parsed<Rec>(r.record) }));
  }

  async saveDriverProfile(companyId: string, driverId: string, expectedVersion: number, contractType: string, record: Rec): Promise<{ version: number }> {
    if (expectedVersion === 0) {
      await this.db.execute(sql`insert into acct_driver_profiles (driver_id, company_id, contract_type, version, record) values (${driverId}, ${companyId}, ${contractType}, 1, ${JSON.stringify(record)}::jsonb) on conflict (company_id, driver_id) do nothing`);
      const now = await this.driverProfile(companyId, driverId);
      if (!now || now.version !== 1) throw conflict('The profile was created by somebody else meanwhile. Reload.');
      return { version: 1 };
    }
    const rows = (await this.db.execute(sql`update acct_driver_profiles set contract_type = ${contractType}, record = ${JSON.stringify(record)}::jsonb, version = version + 1, updated_at = now() where company_id = ${companyId} and driver_id = ${driverId} and version = ${expectedVersion} returning version`)) as unknown as Array<{ version: number }>;
    if (!rows[0]) throw conflict('The profile changed since you read it. Reload and try again.');
    return { version: Number(rows[0].version) };
  }

  /** The sealed bank details of a payee, for the one caller allowed to open them. */
  async payeeSealed(companyId: string, id: string): Promise<unknown> {
    const rows = (await this.db.execute(sql`select sealed from acct_payee_profiles where company_id = ${companyId} and id = ${id}`)) as unknown as Array<{ sealed: unknown }>;
    return rows[0] ? parsed(rows[0].sealed) : null;
  }

  async setPayeeSealed(companyId: string, id: string, sealed: unknown): Promise<void> {
    await this.db.execute(sql`update acct_payee_profiles set sealed = ${JSON.stringify(sealed)}::jsonb where company_id = ${companyId} and id = ${id}`);
  }
}
