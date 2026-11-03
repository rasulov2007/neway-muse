import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { buildEntry, canPost, type BuildEntryResult, type JournalEntry, type LedgerPeriod } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AuditService } from '../people/audit.service';
import { unprocessable } from '../dispatch-board/ops.helpers';
import { AccountingStore } from './store.service';

/**
 * The general ledger on the server (§2, §12). `commit` is the only way an entry lands: the
 * builder must have balanced it, the period must be open, and the source key must be new -
 * the database enforces the last one, so two servers retrying the same event still post once.
 * Corrections are reversals that reference the entry they reverse; nothing is edited.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly store: AccountingStore,
    private readonly audit: AuditService,
  ) {}

  clock: () => Date = () => new Date();

  async periods(companyId: string): Promise<LedgerPeriod[]> {
    const rows = await this.store.ledgerPeriods(companyId);
    return rows.map((r) => ({ id: r.id, year: r.year, month: r.month, status: r.status as LedgerPeriod['status'], closedAt: r.closedAt, closedBy: r.closedBy }));
  }

  async journal(companyId: string): Promise<JournalEntry[]> {
    const rows = await this.store.list<JournalEntry>('acct_journal_entries', companyId);
    return rows.map((r) => r.record);
  }

  /** Posts a built entry; returns the stored entry, or the refusal in words. */
  async commit(principal: Principal, result: BuildEntryResult): Promise<{ ok: true; entry: JournalEntry } | { ok: false; blocked: string }> {
    if (!result.ok) return { ok: false, blocked: result.error };
    const period = canPost(result.entry.onDate, await this.periods(principal.companyId));
    if (!period.allowed) return { ok: false, blocked: period.reason ?? 'The period is closed.' };
    const entry: JournalEntry = {
      ...result.entry,
      id: `je_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      postedAt: this.clock().toISOString(),
      postedBy: principal.userName ?? principal.userId,
    };
    const { stored, created } = await this.store.insert('acct_journal_entries', principal.companyId, entry as unknown as Record<string, unknown> & { id: string });
    if (!created) return { ok: false, blocked: `That event has already been posted (${stored.id}); posting it again would double the money.` };
    return { ok: true, entry };
  }

  /** A manual adjustment: a balanced entry with a memo, source key unique per call. */
  async postAdjustment(principal: Principal, input: { onDate: string; memo: string; lines: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }> }) {
    const built = buildEntry({
      onDate: input.onDate,
      source: 'adjustment',
      sourceKey: `adjustment:${input.onDate}:${input.memo}:${this.clock().getTime()}`,
      memo: input.memo.trim(),
      lines: input.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit === undefined ? undefined : Math.round(l.debit * 100), credit: l.credit === undefined ? undefined : Math.round(l.credit * 100), memo: l.memo })),
    });
    const out = await this.commit(principal, built);
    if (out.ok) await this.audit.write(principal, { action: 'ledger_adjustment', entityType: 'ledger', entityId: out.entry.id, entityLabel: out.entry.id, summary: `Adjustment posted: ${input.memo}`, changes: [] });
    return out;
  }

  /** Reverses a posted entry: the same lines mirrored, dated today, linked back. */
  async reverse(principal: Principal, entryId: string, reason: string) {
    const original = await this.store.get<JournalEntry>('acct_journal_entries', principal.companyId, entryId);
    const already = await this.store.list<JournalEntry>('acct_journal_entries', principal.companyId, sql`reversal_of = ${entryId}`);
    if (already.length > 0) return { ok: false as const, blocked: `${entryId} was already reversed by ${already[0]!.id}.` };
    const onDate = this.clock().toISOString().slice(0, 10);
    const built = buildEntry({
      onDate,
      source: 'adjustment',
      sourceKey: `reversal:${entryId}`,
      memo: `Reversal of ${original.record.memo} — ${reason.trim()}`,
      reference: original.record.reference,
      lines: original.record.lines.map((l) => ({ accountCode: l.accountCode, debit: l.credit || undefined, credit: l.debit || undefined, memo: l.memo })),
    });
    if (!built.ok) return { ok: false as const, blocked: built.error };
    const out = await this.commit(principal, { ok: true, entry: { ...built.entry, reversalOf: entryId } as JournalEntry & { reversalOf: string } });
    if (out.ok) await this.audit.write(principal, { action: 'ledger_reversal', entityType: 'ledger', entityId: entryId, entityLabel: entryId, summary: `Reversed ${entryId}: ${reason}`, reason, changes: [] });
    return out;
  }

  async closePeriod(principal: Principal, periodId: string) {
    if (!/^\d{4}-\d{2}$/.test(periodId)) throw unprocessable('A period is YYYY-MM.');
    const existing = (await this.periods(principal.companyId)).find((p) => p.id === periodId);
    if (existing && (existing.status === 'closed' || existing.status === 'locked')) return { ok: false as const, blocked: `${periodId} is already ${existing.status}.` };
    await this.store.upsertLedgerPeriod(principal.companyId, periodId, { status: 'closed', closedAt: this.clock().toISOString(), closedBy: principal.userName ?? principal.userId });
    await this.audit.write(principal, { action: 'ledger_period_closed', entityType: 'ledger_period', entityId: periodId, entityLabel: periodId, summary: `${periodId} closed; postings into it are refused.`, changes: [{ field: 'status', old: existing?.status ?? 'open', new: 'closed' }] });
    return { ok: true as const };
  }

  async reopenPeriod(principal: Principal, periodId: string, reason: string) {
    await this.store.upsertLedgerPeriod(principal.companyId, periodId, { status: 'open', closedAt: null, closedBy: null });
    await this.audit.write(principal, { action: 'ledger_period_reopened', entityType: 'ledger_period', entityId: periodId, entityLabel: periodId, summary: `${periodId} reopened: ${reason}`, reason, changes: [{ field: 'status', old: 'closed', new: 'open' }] });
    return { ok: true as const };
  }
}
