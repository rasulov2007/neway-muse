import { Injectable } from '@nestjs/common';

import {
  CreateReimbursementSchema,
  REIMBURSEMENT_ACCOUNT,
  REIMBURSEMENT_CATEGORY_LABEL,
  ReviewReimbursementSchema,
  canTransitionReimbursement,
  isEligibleFor,
  reimbursableCents,
  reimbursementProblems,
  totalsByCurrency,
  type ReimbursementBlock,
  type ReimbursementStatus,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { hasPermission } from '../../common/auth/principal';
import { AuditService } from '../people/audit.service';
import { forbidden, unprocessable } from '../dispatch-board/ops.helpers';
import { LoadsService } from '../loads/loads.service';
import { DriverAccountsService } from './driver-accounts.service';
import { PayablesService, type ExpenseRecord } from './payables.service';
import { AccountingStore } from './store.service';

/**
 * Reimbursing a driver for money they laid out.
 *
 * Every reimbursement here is an ordinary expense with a review block on it, written through the
 * existing expense pipeline: one posting, one receipt, one link to the load and the truck. There
 * is no second table, no second expense and no separate approval ledger - what a reimbursement
 * adds is who actually paid, how much of it was their own money, and where in the review it has
 * got to.
 *
 * The workflow is deliberately narrow. Accounting approves; a draft statement picks up what is
 * approved and unclaimed; and the item is paid only when that settlement is recorded paid. A
 * draft that is thrown away hands its items straight back, so nothing is ever stranded on a
 * statement that no longer exists, and nothing lands on two.
 */
@Injectable()
export class ReimbursementsService {
  constructor(
    private readonly store: AccountingStore,
    private readonly payables: PayablesService,
    private readonly drivers: DriverAccountsService,
    private readonly loads: LoadsService,
    private readonly audit: AuditService,
  ) {}

  clock: () => Date = () => new Date();

  private requireEdit(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.edit')) {
      throw forbidden('Only Accounting can record or review reimbursements.');
    }
  }

  private requireView(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.view')) {
      throw forbidden('You do not have access to reimbursements.');
    }
  }

  // ------------------------------------------------------------ reads

  /** Every expense in this company that carries a reimbursement block. */
  private async rows(companyId: string) {
    const all = await this.store.list<ExpenseRecord>('acct_expenses', companyId, undefined, 'on_date desc');
    return all.filter((r) => r.record.reimbursement !== null && r.record.reimbursement !== undefined);
  }

  /**
   * Whether anything is owed to a driver for this receipt.
   *
   * A receipt the company funded in full is a company expense and nothing else. Early records of
   * that kind were filed with a review block on them; they stay exactly where they are in Expenses,
   * but they are not reimbursements, so they are never counted, queued or listed as one.
   */
  private owesDriver(e: ExpenseRecord): boolean {
    return Boolean(e.reimbursement) && reimbursableCents(e.reimbursement!) > 0;
  }

  /**
   * Fills in a load number the record never stored, from the load id it did store.
   *
   * Reimbursements recorded before the expense kept its load number carry the id alone. The id is
   * a reliable reference - it was chosen from this company's loads - so the number is read from
   * that load at display time. Nothing is written back, nothing is guessed from a description, and
   * an id that no longer resolves in this company stays unresolved and says so.
   */
  private async withLoadNumbers(principal: Principal, items: ExpenseRecord[]): Promise<Array<ExpenseRecord & { loadUnresolved?: boolean }>> {
    const missing = items.filter((e) => e.loadId && !e.loadNumber);
    if (missing.length === 0) return items;
    const loads = await this.loads.list(principal, { includeDemo: false });
    const byId = new Map(loads.map((l) => [l.id, l.loadNumber] as const));
    return items.map((e) => {
      if (!e.loadId || e.loadNumber) return e;
      const number = byId.get(e.loadId) ?? null;
      return number ? { ...e, loadNumber: number } : { ...e, loadUnresolved: true };
    });
  }

  async list(principal: Principal, where?: { status?: ReimbursementStatus; driverId?: string; truckId?: string; category?: string; from?: string; to?: string }) {
    this.requireView(principal);
    let items = (await this.rows(principal.companyId)).map((r) => r.record).filter((e) => this.owesDriver(e));
    const w = where ?? {};
    if (w.status) items = items.filter((e) => e.reimbursement!.status === w.status);
    if (w.driverId) items = items.filter((e) => e.reimbursement!.payerDriverId === w.driverId);
    if (w.truckId) items = items.filter((e) => e.truckId === w.truckId);
    if (w.category) items = items.filter((e) => e.reimbursement!.category === w.category);
    if (w.from) items = items.filter((e) => e.onDate >= w.from!);
    if (w.to) items = items.filter((e) => e.onDate <= w.to!);
    return this.withLoadNumbers(principal, items);
  }

  /**
   * One driver's own reimbursements (mobile M3): what the driver app lists. No permission check
   * here - the caller resolved the driver on the server and reads nothing but that driver's.
   */
  async forDriver(principal: Principal, driverId: string): Promise<ExpenseRecord[]> {
    const items = (await this.rows(principal.companyId)).map((r) => r.record).filter((e) => this.owesDriver(e) && e.reimbursement!.payerDriverId === driverId);
    return this.withLoadNumbers(principal, items);
  }

  /** The four cards, per currency, over every reimbursement on file. */
  async summary(principal: Principal) {
    this.requireView(principal);
    const blocks = (await this.rows(principal.companyId)).map((r) => r.record).filter((e) => this.owesDriver(e)).map((e) => e.reimbursement!);
    return { byCurrency: totalsByCurrency(blocks) };
  }

  async get(principal: Principal, id: string): Promise<ExpenseRecord> {
    this.requireView(principal);
    const stored = await this.store.get<ExpenseRecord>('acct_expenses', principal.companyId, id);
    if (!stored.record.reimbursement) throw unprocessable(`${id} is an expense, not a reimbursement.`);
    return (await this.withLoadNumbers(principal, [stored.record]))[0]!;
  }

  /**
   * Loads a reimbursement can be filed against, for the picker.
   *
   * Company-scoped because every read here is, and served from Accounting because the person
   * filing a lumper receipt may not have the dispatch board's permissions. The chosen driver's own
   * loads - as driver or co-driver - come first, since that is almost always the one they want.
   */
  async loadOptions(principal: Principal, input: { q?: string; driverId?: string }) {
    this.requireView(principal);
    const q = (input.q ?? '').trim().toLowerCase();
    const loads = (await this.loads.list(principal, { includeDemo: false })).filter((l) => l.status !== 'cancelled');
    const drives = (l: (typeof loads)[number]) => {
      const r = l as typeof l & { coDriverId?: string | null };
      return Boolean(input.driverId) && (l.driverId === input.driverId || r.coDriverId === input.driverId);
    };
    const matching = loads.filter((l) => {
      if (!q) return true;
      const r = l as typeof l & { brokerReference?: string | null; customerName?: string | null };
      return [l.loadNumber, r.brokerReference, r.customerName].some((v) => String(v ?? '').toLowerCase().includes(q));
    });
    matching.sort((a, b) => Number(drives(b)) - Number(drives(a)) || String(b.deliveredAt ?? b.updatedAt).localeCompare(String(a.deliveredAt ?? a.updatedAt)));
    return matching.slice(0, 25).map((l) => {
      const r = l as typeof l & { coDriverId?: string | null; coDriverName?: string | null; truckUnit?: string | null };
      const first = l.stops[0];
      const last = l.stops.at(-1);
      return {
        id: l.id,
        loadNumber: l.loadNumber,
        route: first && last ? `${first.city}, ${first.state} \u2192 ${last.city}, ${last.state}` : null,
        deliveredOn: l.deliveredAt ? l.deliveredAt.slice(0, 10) : null,
        driverId: l.driverId,
        driverName: l.driverName ?? null,
        coDriverId: r.coDriverId ?? null,
        coDriverName: r.coDriverName ?? null,
        truckId: l.truckId ?? null,
        truckUnit: r.truckUnit ?? null,
        onThisDriver: drives(l),
      };
    });
  }

  // ------------------------------------------------------------ writing one

  /**
   * Called after a reimbursement is approved or rejected, and after the statement carrying it is
   * paid (mobile M3): the mobile module registers here to tell the driver who filed it from the
   * app. A listener's failure never fails the review.
   */
  readonly afterDecision: Array<(principal: Principal, expense: ExpenseRecord, event: 'approved' | 'rejected' | 'paid') => Promise<void>> = [];

  private async announce(principal: Principal, expense: ExpenseRecord, event: 'approved' | 'rejected' | 'paid'): Promise<void> {
    for (const listener of this.afterDecision) {
      try {
        await listener(principal, expense, event);
      } catch {
        // The listener records its own failure; the review stands.
      }
    }
  }

  async create(principal: Principal, raw: unknown): Promise<{ ok: true; expense: ExpenseRecord; reimbursable?: boolean } | { ok: false; blocked: string }> {
    this.requireEdit(principal);
    return this.record(principal, raw, null);
  }

  /**
   * A receipt the driver filed from the driver app (mobile M3). The same expense and review block
   * Accounting's own form writes - pending, never approved, never a deduction - with who filed it
   * and from where. The driver was resolved on the server; `payerDriverId` is that driver. The
   * Idempotency-Key makes the expense's source key, so a retry finds the first expense instead of
   * posting a second.
   */
  async createFromDriver(
    principal: Principal,
    raw: unknown,
    origin: { driverId: string; idempotencyKey: string; location: string | null },
  ): Promise<{ ok: true; expense: ExpenseRecord; reimbursable?: boolean } | { ok: false; blocked: string }> {
    const input = CreateReimbursementSchema.parse(raw);
    if (input.payerDriverId !== origin.driverId) throw forbidden('A driver files receipts for themselves only.');
    return this.record(principal, input, origin);
  }

  private async record(
    principal: Principal,
    raw: unknown,
    origin: { driverId: string; idempotencyKey: string; location: string | null } | null,
  ): Promise<{ ok: true; expense: ExpenseRecord; reimbursable?: boolean } | { ok: false; blocked: string }> {
    const input = CreateReimbursementSchema.parse(raw);
    const problems = reimbursementProblems({
      receiptCents: input.receiptCents,
      driverFundedCents: input.driverFundedCents,
      paymentSource: input.paymentSource,
      payerDriverId: input.payerDriverId,
      hasReceiptFile: Boolean(input.receiptFileId),
      missingReceiptReason: input.missingReceiptReason,
    });
    if (problems.length) return { ok: false, blocked: problems.join(' ') };

    const now = this.clock().toISOString();
    const who = principal.userName ?? principal.userId;
    const payerDriverName = await this.drivers.driverName(principal, input.payerDriverId);
    const block: ReimbursementBlock = {
      status: 'pending',
      category: input.category,
      receiptCents: input.receiptCents,
      driverFundedCents: input.driverFundedCents,
      currency: input.currency,
      paymentSource: input.paymentSource,
      payerDriverId: input.payerDriverId,
      payerDriverName,
      // A missing receipt is an exception somebody signed for, not an omission.
      missingReceipt: input.receiptFileId ? null : input.missingReceiptReason ? { reason: input.missingReceiptReason, authorizedBy: who, authorizedAt: now } : null,
      note: input.note,
      submittedBy: who,
      submittedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      rejectedReason: null,
      settlementId: null,
      settlementNumber: null,
      includedAt: null,
      paidAt: null,
      ...(origin ? { source: 'driver_app' as const, submittedByDriverId: origin.driverId, location: origin.location } : {}),
    };

    // The load is checked, not trusted: it has to be this company's, and the driver who paid has
    // to be on it. An id from another company used to be stored as given and simply never resolve.
    let load: Awaited<ReturnType<LoadsService['get']>> | null = null;
    if (input.loadId) {
      load = await this.loads.get(principal, input.loadId).catch(() => null);
      if (!load) return { ok: false, blocked: 'That load is not on file in this company.' };
      const coDriverId = (load as typeof load & { coDriverId?: string | null }).coDriverId ?? null;
      if (load.driverId !== input.payerDriverId && coDriverId !== input.payerDriverId) {
        return { ok: false, blocked: `${payerDriverName ?? 'That driver'} is not a driver on load ${load.loadNumber}. Choose the load they ran, or leave the load empty for an expense that is not on one.` };
      }
    }
    const owed = reimbursableCents(block);

    // The whole receipt is the company's cost; only the driver-funded part is owed back to them.
    const out = await this.payables.createExpense(principal, {
      onDate: input.onDate,
      categoryCode: REIMBURSEMENT_ACCOUNT[input.category],
      description: input.description,
      amount: input.receiptCents / 100,
      truckId: input.truckId ?? load?.truckId ?? null,
      driverId: input.payerDriverId,
      loadId: input.loadId,
      loadNumber: load?.loadNumber ?? null,
      vendorId: null,
      paymentMethod: input.paymentSource === 'driver_personal' ? 'driver' : input.paymentSource === 'company_card' ? 'card' : input.paymentSource,
      // The company's bank paid whatever the driver did not.
      paidDirectly: true,
      notes: input.note,
      payer: owed > 0 ? 'driver' : 'company',
      receiptFileId: input.receiptFileId,
      // A receipt the company funded in full owes the driver nothing: it is recorded as the company
      // expense it is and never enters the reimbursement queue.
      reimbursement: owed > 0 ? block : null,
      // From the driver app the Idempotency-Key is the source: a retry finds the first expense.
      ...(origin ? { sourceId: `driver_app:${origin.driverId}:${origin.idempotencyKey}` } : {}),
    });
    if (!out.ok) return out;
    if (owed === 0) return { ok: true, expense: out.expense, reimbursable: false };
    if (!out.created) return { ok: true, expense: out.expense };
    await this.audit.write(principal, {
      action: 'reimbursement_recorded',
      entityType: 'expense',
      entityId: out.expense.id,
      entityLabel: out.expense.expenseNumber,
      summary: `${REIMBURSEMENT_CATEGORY_LABEL[input.category]} $${(input.receiptCents / 100).toFixed(2)}, driver funded $${(reimbursableCents(block) / 100).toFixed(2)} for ${payerDriverName ?? input.payerDriverId}`,
      changes: [],
    });
    return { ok: true, expense: out.expense };
  }

  async review(principal: Principal, id: string, raw: unknown): Promise<ExpenseRecord> {
    this.requireEdit(principal);
    const input = ReviewReimbursementSchema.parse(raw);
    const to: ReimbursementStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    if (input.decision === 'reject' && !input.reason) throw unprocessable('A rejection needs a reason the driver can read.');
    const stored = await this.store.get<ExpenseRecord>('acct_expenses', principal.companyId, id);
    const block = stored.record.reimbursement;
    if (!block) throw unprocessable(`${id} is an expense, not a reimbursement.`);
    // Only an item nobody has decided on is reviewed here. The transition table also allows
    // `included` back to `approved`, but that is a statement releasing what it was carrying -
    // reaching it through the review button would quietly take a reimbursement off a statement
    // that is still counting on it.
    if (block.status !== 'pending') {
      throw unprocessable(
        block.status === 'included'
          ? `This reimbursement is already on statement ${block.settlementNumber ?? 'a statement'}. Take it off that statement before reviewing it again.`
          : `This reimbursement has already been ${block.status}.`,
      );
    }
    if (!canTransitionReimbursement(block.status, to)) {
      throw unprocessable(`A reimbursement that is ${block.status} cannot be ${to === 'approved' ? 'approved' : 'rejected'}.`);
    }
    if (to === 'approved' && reimbursableCents(block) <= 0) {
      throw unprocessable('There is nothing to reimburse: the company funded all of this receipt.');
    }
    const now = this.clock().toISOString();
    const after: ExpenseRecord = {
      ...stored.record,
      reimbursement: { ...block, status: to, reviewedBy: principal.userName ?? principal.userId, reviewedAt: now, rejectedReason: to === 'rejected' ? input.reason : null },
    };
    await this.store.update('acct_expenses', principal.companyId, id, stored.version, after);
    await this.audit.write(principal, {
      action: to === 'approved' ? 'reimbursement_approved' : 'reimbursement_rejected',
      entityType: 'expense',
      entityId: id,
      entityLabel: stored.record.expenseNumber,
      summary: `$${(reimbursableCents(block) / 100).toFixed(2)} to ${block.payerDriverName ?? block.payerDriverId}${input.reason ? ` · ${input.reason}` : ''}`,
      changes: [{ field: 'status', old: block.status, new: to }],
    });
    await this.announce(principal, after, to);
    return after;
  }

  // ------------------------------------------------------------ what a statement does with them

  /**
   * The approved reimbursements this statement may carry: the payer's own, dated in the period,
   * and either unclaimed or already on this same statement. Recomputing a draft therefore lands
   * the same items on the same statement, once.
   */
  async eligibleFor(principal: Principal, input: { driverId: string; periodStart: string; periodEnd: string; settlementId: string }): Promise<ExpenseRecord[]> {
    const items = await this.withLoadNumbers(principal, (await this.rows(principal.companyId)).map((r) => r.record));
    return items.filter(
      (e) =>
        e.reimbursement!.payerDriverId === input.driverId &&
        e.onDate >= input.periodStart &&
        e.onDate <= input.periodEnd &&
        reimbursableCents(e.reimbursement!) > 0 &&
        isEligibleFor(e.reimbursement!, input.settlementId),
    );
  }

  /** Marks these items as carried by this statement. Idempotent: one statement, one claim. */
  async attach(principal: Principal, ids: readonly string[], settlement: { id: string; settlementNumber: string }): Promise<void> {
    const now = this.clock().toISOString();
    for (const id of ids) {
      await this.store.modify<ExpenseRecord>('acct_expenses', principal.companyId, id, (e) => {
        const b = e.reimbursement;
        if (!b || b.status === 'paid') return e;
        if (b.settlementId && b.settlementId !== settlement.id) return e;
        return { ...e, reimbursement: { ...b, status: 'included', settlementId: settlement.id, settlementNumber: settlement.settlementNumber, includedAt: b.includedAt ?? now } };
      });
    }
  }

  /**
   * Makes this statement carry exactly these items and no others.
   *
   * A draft is recalculated every time it is read, and what it is entitled to can change - a load
   * moves out of the week, an approval is withdrawn. Attaching what belongs and releasing what no
   * longer does, in one step, is what keeps an item from being stranded on a statement that has
   * stopped claiming it while never letting it sit on two.
   */
  async syncFor(principal: Principal, settlement: { id: string; settlementNumber: string }, keepIds: readonly string[]): Promise<void> {
    const keep = new Set(keepIds);
    const attached = (await this.rows(principal.companyId))
      .map((r) => r.record)
      .filter((e) => e.reimbursement!.settlementId === settlement.id && e.reimbursement!.status === 'included');
    for (const e of attached) {
      if (keep.has(e.id)) continue;
      await this.store.modify<ExpenseRecord>('acct_expenses', principal.companyId, e.id, (row) => {
        const b = row.reimbursement;
        if (!b || b.status !== 'included') return row;
        return { ...row, reimbursement: { ...b, status: 'approved', settlementId: null, settlementNumber: null, includedAt: null } };
      });
    }
    if (keep.size) await this.attach(principal, [...keep], settlement);
  }

  /**
   * Hands every item back that a statement was carrying.
   *
   * Called when a draft is regenerated or a statement is reversed. An item that has already been
   * paid keeps its link - that money left the building, and the record of where it went stays.
   */
  async release(principal: Principal, settlementId: string): Promise<number> {
    const items = (await this.rows(principal.companyId)).map((r) => r.record).filter((e) => e.reimbursement!.settlementId === settlementId && e.reimbursement!.status === 'included');
    for (const e of items) {
      await this.store.modify<ExpenseRecord>('acct_expenses', principal.companyId, e.id, (row) => {
        const b = row.reimbursement;
        if (!b || b.status !== 'included') return row;
        return { ...row, reimbursement: { ...b, status: 'approved', settlementId: null, settlementNumber: null, includedAt: null } };
      });
    }
    return items.length;
  }

  /** The settlement was actually paid, so the money reached the driver. Only then is it paid. */
  async markPaid(principal: Principal, settlementId: string, paidAt: string): Promise<number> {
    const items = (await this.rows(principal.companyId)).map((r) => r.record).filter((e) => e.reimbursement!.settlementId === settlementId && e.reimbursement!.status === 'included');
    for (const e of items) {
      await this.store.modify<ExpenseRecord>('acct_expenses', principal.companyId, e.id, (row) => {
        const b = row.reimbursement;
        if (!b || b.status !== 'included') return row;
        return { ...row, reimbursement: { ...b, status: 'paid', paidAt } };
      });
      await this.announce(principal, { ...e, reimbursement: { ...e.reimbursement!, status: 'paid', paidAt } }, 'paid');
    }
    if (items.length) {
      await this.audit.write(principal, {
        action: 'reimbursement_paid',
        entityType: 'settlement',
        entityId: settlementId,
        entityLabel: settlementId,
        summary: `${items.length} reimbursement(s) paid with the settlement`,
        changes: [],
      });
    }
    return items.length;
  }

  /** How many are waiting for someone to look at them: the count on the Accounting overview. */
  async awaitingReview(principal: Principal): Promise<{ count: number; cents: number }> {
    const blocks = (await this.rows(principal.companyId)).map((r) => r.record).filter((e) => this.owesDriver(e)).map((e) => e.reimbursement!).filter((b) => b.status === 'pending');
    return { count: blocks.length, cents: blocks.reduce((t, b) => t + reimbursableCents(b), 0) };
  }
}

