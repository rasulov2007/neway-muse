import { Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AccountingSettingsSchema, billingVerdict, earningsPreview, readRosterPercent, settleableAmounts, type AccessorialAllocation, type BillableLoad, type CompletionRecord, type EarningCandidate, type SettleableLoadV2, type StoredLoad } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AuditService } from '../people/audit.service';
import { LoadsService } from '../loads/loads.service';
import { DriverAccountsService } from './driver-accounts.service';
import { InvoicesService } from './invoices.service';
import { SettlementsService } from './settlements.service';
import { AccountingStore } from './store.service';

/**
 * The completed-load pipeline (section 3).
 *
 * Every write to a load ends here (the loads service calls its listeners after commit): a
 * delivered, closed or TONU load gets one `acct_completions` row - keyed on the load, so a retry,
 * a second completion or a backfill cannot make a second one - holding the invoice candidate
 * (which queue, which conditions) and one earning candidate per entitled recipient, computed
 * from the profile in force with its blockers spelled out. A failure is recorded on the row
 * with the error and retried from the API; nothing is swallowed.
 *
 * Candidates are previews: no invoice is issued and no statement is approved from here.
 */

const COMPLETED = new Set(['delivered', 'closed', 'tonu']);

/** The record without the fields that change on every run. */
function strip(rec: CompletionRecord): unknown {
  return { ...rec, attempts: 0, processedAt: '', source: '', provenance: null };
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

@Injectable()
export class CompletionsService implements OnModuleInit {
  constructor(
    private readonly store: AccountingStore,
    private readonly loads: LoadsService,
    private readonly invoices: InvoicesService,
    private readonly settlements: SettlementsService,
    private readonly accounts: DriverAccountsService,
    private readonly audit: AuditService,
  ) {}

  clock: () => Date = () => new Date();

  onModuleInit(): void {
    this.loads.afterWrite.push((principal, load) => this.onLoadWritten(principal, load));
    // An invoice or a statement moving on re-reads that load's completion, so the row never goes stale.
    const rewrite = async (principal: Principal, loadId: string) => {
      if (!(await this.forLoad(principal, loadId))) return;
      try {
        await this.process(principal, loadId, 'rewrite');
      } catch {
        // recorded by process; the row keeps its last good state
      }
    };
    this.invoices.afterChange.push(rewrite);
    this.settlements.afterChange.push(rewrite);
    // A saved profile or a confirmed rate re-reads every completion that pays this driver.
    this.accounts.afterProfileChange.push(async (principal, driverId) => {
      const mine = await this.store.list<CompletionRecord>('acct_completions', principal.companyId, sql`record->'earnings' @> ${JSON.stringify([{ recipientId: driverId }])}::jsonb`);
      for (const c of mine) {
        try {
          await this.process(principal, c.record.loadId, 'rewrite');
        } catch (error) {
          await this.recordError(principal, { id: c.record.loadId, loadNumber: c.record.loadNumber, status: c.record.loadStatus, deliveredAt: c.record.completedAt } as StoredLoad, error);
        }
      }
    });
  }

  private async onLoadWritten(principal: Principal, load: StoredLoad): Promise<void> {
    if (!COMPLETED.has(load.status)) return;
    try {
      await this.process(principal, load.id, 'completion');
    } catch (error) {
      await this.recordError(principal, load, error);
    }
  }

  private async recordError(principal: Principal, load: StoredLoad, error: unknown): Promise<void> {
    const existing = await this.store.find<CompletionRecord>('acct_completions', principal.companyId, `cmp_${load.id}`);
    const now = this.clock().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const rec: CompletionRecord = existing?.record
      ? { ...existing.record, state: 'error', error: message, attempts: existing.record.attempts + 1, processedAt: now }
      : { id: `cmp_${load.id}`, loadId: load.id, loadNumber: load.loadNumber, loadStatus: load.status, completedAt: load.deliveredAt ?? null, grossCents: 0, linehaulCents: 0, state: 'error', error: message, attempts: 1, processedAt: now, source: 'completion', invoiceCandidate: { queue: null, conditions: [], invoiceId: null, invoiceStatus: null }, earnings: [], provenance: { firstSeenAt: now, firstSource: 'completion' } };
    if (existing) await this.store.update('acct_completions', principal.companyId, existing.id, existing.version, rec);
    else await this.store.insert('acct_completions', principal.companyId, rec);
  }

  async list(principal: Principal): Promise<CompletionRecord[]> {
    return (await this.store.list<CompletionRecord>('acct_completions', principal.companyId, undefined, 'created_at desc')).map((r) => r.record);
  }

  async forLoad(principal: Principal, loadId: string): Promise<CompletionRecord | null> {
    return (await this.store.find<CompletionRecord>('acct_completions', principal.companyId, `cmp_${loadId}`))?.record ?? null;
  }

  private toSettleable(l: StoredLoad, allocations: Record<string, AccessorialAllocation>): SettleableLoadV2 {
    const r = l as StoredLoad & Record<string, unknown>;
    // The earnings preview pays on the For driver amounts, as the statement does (owner, 2026-10-23).
    const money = settleableAmounts(r);
    const drivers = [l.driverId, (r['coDriverId'] as string | null | undefined) ?? null].filter((d): d is string => Boolean(d));
    return {
      id: l.id,
      loadNumber: l.loadNumber,
      completedAt: l.deliveredAt ?? l.updatedAt,
      originLabel: `${l.stops[0]?.city ?? ''}, ${l.stops[0]?.state ?? ''}`,
      destinationLabel: `${l.stops.at(-1)?.city ?? ''}, ${l.stops.at(-1)?.state ?? ''}`,
      loadedMiles: Number(r['loadedMiles']) || 0,
      emptyMiles: Number(r['emptyMiles']) || 0,
      grossCents: money.grossCents,
      linehaulCents: money.linehaulCents,
      realLinehaulCents: money.realLinehaulCents,
      brokerReference: (r['brokerReference'] as string | null | undefined) ?? null,
      driverIds: drivers,
      accessorials: money.accessorials.map((a) => ({ id: a.id, type: a.type, description: a.description, amountCents: a.amountCents, realAmountCents: a.realAmountCents, allocation: allocations[`${l.id}:${a.id}`] ?? null })),
      funded: false,
      status: l.status,
    };
  }

  /** Computes and stores the completion for one load. Idempotent: the same facts write nothing new. */
  async process(principal: Principal, loadId: string, source: CompletionRecord['source'], options: { dryRun?: boolean } = {}): Promise<CompletionRecord> {
    const load = await this.loads.get(principal, loadId);
    const r = load as StoredLoad & Record<string, unknown>;
    const settingsRaw = await this.store.settings(principal.companyId);
    const settings = AccountingSettingsSchema.parse(settingsRaw.record);
    const allocations = ((settingsRaw.record['accessorialAllocations'] as Record<string, AccessorialAllocation>) ?? {});
    const settleable = this.toSettleable(load, allocations);

    // Invoice candidate: the queue the billing rules put this load in, right now.
    const queue = await this.invoices.queue(principal);
    const row = queue.rows.find((x) => x.load.id === loadId) ?? null;
    const invoice = await this.invoices.invoiceForLoad(principal, loadId);
    // An invoiced load has left the queue: its candidate is the invoice itself, not a re-derived verdict on an empty document list.
    const verdict = row?.verdict ?? (invoice ? { queue: null, conditions: [] } : billingVerdict({ ...(await this.billable(principal, load)) }, { invoices: [], hashesElsewhere: () => [], resolvedExceptions: () => [] }));

    // Earnings: one per entitled recipient, from the profile in force at completion.
    const completedOn = (load.deliveredAt ?? load.updatedAt).slice(0, 10);
    const statements = await this.store.list<{ id: string; status: string; loadIds: string[]; partyId: string }>('acct_settlements', principal.companyId, sql`record->'loadIds' ? ${loadId}`);
    const earnings: EarningCandidate[] = [];
    const drivers = [{ id: load.driverId, role: 'driver' as const }, { id: (r['coDriverId'] as string | null | undefined) ?? null, role: 'co_driver' as const }].filter((d): d is { id: string; role: 'driver' | 'co_driver' } => Boolean(d.id));
    for (const d of drivers) {
      const profile = await this.accounts.profile(principal, d.id);
      const version = profile.defaulted ? profile.current : (await this.accounts.profileOn(principal, d.id, completedOn));
      const ambiguous = Boolean(version && (version.loadedPlan.kind === 'percent_of_gross' || version.loadedPlan.kind === 'percent_of_linehaul') && readRosterPercent(version.loadedPlan.rate).ambiguous && !profile.record.rateConfirmedAt);
      const preview = earningsPreview(settleable, d.id, version, { teamBaseMileageSplit: settings.teamBaseMileageSplit }, ambiguous);
      if (profile.defaulted) preview.blockers.unshift('Pay plan not reviewed');
      const stm = statements.find((s) => s.record.partyId === d.id && s.record.status !== 'reversed');
      earnings.push({
        recipientId: d.id,
        recipientName: (await this.accounts.driverName(principal, d.id)) ?? d.id,
        role: d.role,
        cents: preview.cents,
        lines: preview.lines,
        planKind: version?.loadedPlan.kind ?? null,
        planRate: version?.loadedPlan.rate ?? null,
        planEffectiveFrom: profile.defaulted ? null : (version?.effectiveFrom ?? null),
        rateConfirmed: !ambiguous,
        blockers: preview.blockers,
        settlementId: stm?.id ?? null,
        settlementStatus: stm?.record.status ?? null,
      });
    }
    if (drivers.length === 0) earnings.push({ recipientId: '', recipientName: 'No driver on the load', role: 'driver', cents: null, lines: [], planKind: null, planRate: null, planEffectiveFrom: null, rateConfirmed: false, blockers: ['The load has no driver: nobody to pay.'], settlementId: null, settlementStatus: null });

    const now = this.clock().toISOString();
    const existing = await this.store.find<CompletionRecord>('acct_completions', principal.companyId, `cmp_${loadId}`);
    const next: CompletionRecord = {
      id: `cmp_${loadId}`,
      loadId,
      loadNumber: load.loadNumber,
      loadStatus: load.status,
      completedAt: load.deliveredAt ?? null,
      grossCents: settleable.grossCents,
      linehaulCents: settleable.linehaulCents,
      state: 'processed',
      error: null,
      attempts: (existing?.record.attempts ?? 0) + 1,
      processedAt: now,
      source,
      invoiceCandidate: { queue: verdict.queue, conditions: verdict.conditions, invoiceId: invoice?.id ?? null, invoiceStatus: invoice?.status ?? null },
      earnings,
      provenance: existing?.record.provenance ?? { firstSeenAt: now, firstSource: source },
    };
    if (options.dryRun) return next;
    if (existing) {
      // Postgres jsonb reorders keys, so the comparison sorts them: only a real change writes.
      const same = stable({ ...existing.record, attempts: 0, processedAt: '', source: '' }) === stable({ ...next, attempts: 0, processedAt: '', source: '' });
      if (same) return existing.record;
      await this.store.update('acct_completions', principal.companyId, existing.id, existing.version, next);
    } else {
      const { created } = await this.store.insert('acct_completions', principal.companyId, next);
      if (created) await this.audit.write(principal, { action: 'load_completion_processed', entityType: 'load', entityId: loadId, entityLabel: load.loadNumber, summary: `${load.loadNumber}: invoice candidate ${verdict.queue ?? 'none'}, ${earnings.length} earning candidate(s) (${source})`, changes: [] });
    }
    return next;
  }

  private async billable(principal: Principal, load: StoredLoad): Promise<BillableLoad> {
    const r = load as StoredLoad & Record<string, unknown>;
    void principal;
    return { id: load.id, loadNumber: load.loadNumber, status: load.status, brokerReference: (r['brokerReference'] as string | null) ?? null, customerId: null, brokerId: null, customerName: String(r['customerName'] ?? ''), brokerName: (r['brokerName'] as string | null) ?? null, rate: Number(r['rate']) || 0, documents: [], charges: [], stops: load.stops.map((s) => ({ kind: s.kind, status: s.status })), cancellation: null, invoiceId: (r['invoiceId'] as string | null) ?? null, openFlags: 0, deliveredAt: load.deliveredAt, updatedAt: load.updatedAt };
  }

  /**
   * The reconciliation of every completed load (section 3): which have no completion record,
   * which are stale, and what processing them would produce - as a report first, then applied
   * when asked. Applying writes only completion records; it never issues, approves or posts.
   */
  async backfill(principal: Principal, apply: boolean): Promise<{ dryRun: boolean; scanned: number; missing: string[]; stale: string[]; errors: Array<{ loadId: string; loadNumber: string; error: string }>; totals: { grossCents: number; earnedCents: number; blocked: number }; created: number; updated: number }> {
    const loads = (await this.loads.list(principal, { includeDemo: false })).filter((l) => COMPLETED.has(l.status));
    const existing = new Map((await this.list(principal)).map((c) => [c.loadId, c]));
    const missing = loads.filter((l) => !existing.has(l.id)).map((l) => l.loadNumber);
    // Stale = the stored row no longer matches what the rules produce now (a profile saved since,
    // a rate confirmed, a statement approved, a document reviewed), or it ended in an error.
    const stale: string[] = [];
    let created = 0;
    let updated = 0;
    const errors: Array<{ loadId: string; loadNumber: string; error: string }> = [];
    const totals = { grossCents: 0, earnedCents: 0, blocked: 0 };
    for (const l of loads) {
      try {
        const before = existing.get(l.id);
        const fresh = await this.process(principal, l.id, 'backfill', { dryRun: true });
        const differs = before ? before.state === 'error' || stable(strip(before)) !== stable(strip(fresh)) : false;
        if (before && differs) stale.push(l.loadNumber);
        if (apply && (!before || differs)) {
          await this.process(principal, l.id, 'backfill');
          if (!before) created += 1;
          else updated += 1;
        }
        totals.grossCents += fresh.grossCents;
        for (const e of fresh.earnings) {
          if (e.cents !== null && e.blockers.length === 0) totals.earnedCents += e.cents;
          else totals.blocked += 1;
        }
      } catch (error) {
        errors.push({ loadId: l.id, loadNumber: l.loadNumber, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (apply) await this.audit.write(principal, { action: 'load_completion_backfill', entityType: 'company', entityId: principal.companyId, entityLabel: 'accounting', summary: `Backfill: ${loads.length} completed loads scanned, ${created} created, ${updated} updated, ${errors.length} error(s)`, changes: [] });
    return { dryRun: !apply, scanned: loads.length, missing, stale, errors, totals, created, updated };
  }

  async retry(principal: Principal, loadId: string): Promise<CompletionRecord> {
    return this.process(principal, loadId, 'retry');
  }
}
