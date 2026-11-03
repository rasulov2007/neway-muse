import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { sumCents, type CompletionRecord, type StoredLoad } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { trucks } from '../../database/schema';
import { LoadsService } from '../loads/loads.service';
import type { InvoiceRecord } from './invoices.service';
import type { ExpenseRecord } from './payables.service';
import type { StatementRecord } from './settlements.service';
import { AccountingStore } from './store.service';

/**
 * Profitability (section 6), from verified attribution only: operational gross from completed
 * loads, invoiced revenue from issued invoices, driver pay from approved statements, posted
 * costs from expenses by truck/load. What cannot be attributed is shown as unallocated, never
 * spread; a team load's revenue is never given whole to both drivers.
 */
@Injectable()
export class ProfitabilityService {
  constructor(
    private readonly store: AccountingStore,
    private readonly loads: LoadsService,
  ) {}

  async report(principal: Principal, range: { from: string; to: string }) {
    const [allLoads, invoices, expenses, statements, completions, truckRows] = await Promise.all([
      this.loads.list(principal, { includeDemo: false }),
      this.store.list<InvoiceRecord>('acct_invoices', principal.companyId),
      this.store.list<ExpenseRecord>('acct_expenses', principal.companyId),
      this.store.list<StatementRecord>('acct_settlements', principal.companyId),
      this.store.list<CompletionRecord>('acct_completions', principal.companyId),
      this.store.db.select({ id: trucks.id, unitNumber: trucks.unitNumber }).from(trucks).where(eq(trucks.companyId, principal.companyId)),
    ]);
    const inRange = (d: string | null | undefined) => Boolean(d) && d!.slice(0, 10) >= range.from && d!.slice(0, 10) <= range.to;
    const completed = allLoads.filter((l) => ['delivered', 'closed', 'tonu'].includes(l.status) && inRange(l.deliveredAt ?? l.updatedAt));
    const unit = (id: string | null) => truckRows.find((t) => t.id === id)?.unitNumber ?? null;
    const grossOf = (l: StoredLoad) => completions.find((c) => c.record.loadId === l.id)?.record.grossCents ?? Math.round((Number((l as StoredLoad & Record<string, unknown>)['rate']) || 0) * 100);
    const invoicedFor = (loadId: string) => sumCents(invoices.filter((i) => i.record.loadId === loadId && i.record.isCurrent && i.record.status !== 'draft' && i.record.status !== 'void').map((i) => Math.round(i.record.total * 100)));
    const approved = statements.filter((s) => (s.record.status === 'approved' || s.record.status === 'paid') && s.record.partyType === 'driver');
    // Driver pay per load: an approved statement's earning lines carry their load id.
    const payByLoad = new Map<string, number>();
    for (const s of approved) for (const e of s.record.computation?.earnings ?? []) if (e.loadId && e.kind !== 'reimbursement') payByLoad.set(e.loadId, (payByLoad.get(e.loadId) ?? 0) + e.cents);
    const posted = expenses.filter((e) => e.record.status === 'posted' && inRange(e.record.onDate));
    const loadsOut = completed.map((l) => {
      const r = l as StoredLoad & Record<string, unknown>;
      const costs = posted.filter((e) => e.record.loadId === l.id);
      const gross = grossOf(l);
      const pay = payByLoad.get(l.id) ?? null;
      const drivers = [l.driverId, (r['coDriverId'] as string | null | undefined) ?? null].filter(Boolean) as string[];
      const missing: string[] = [];
      if (pay === null) missing.push('driver pay not approved yet');
      if (invoicedFor(l.id) === 0) missing.push('not invoiced');
      return { loadId: l.id, loadNumber: l.loadNumber, truckId: l.truckId, unitNumber: unit(l.truckId), drivers, grossCents: gross, invoicedCents: invoicedFor(l.id), driverPayCents: pay, postedCostsCents: sumCents(costs.map((e) => Math.round(e.record.amount * 100))), marginCents: pay === null ? null : gross - pay - sumCents(costs.map((e) => Math.round(e.record.amount * 100))), missing };
    });
    const byTruck = new Map<string, { truckId: string; unitNumber: string | null; loads: number; grossCents: number; invoicedCents: number; driverPayCents: number; payMissing: number; loadCostsCents: number; truckCostsCents: number }>();
    for (const l of loadsOut) {
      const key = l.truckId ?? 'none';
      const t = byTruck.get(key) ?? { truckId: key, unitNumber: l.unitNumber, loads: 0, grossCents: 0, invoicedCents: 0, driverPayCents: 0, payMissing: 0, loadCostsCents: 0, truckCostsCents: 0 };
      t.loads += 1;
      t.grossCents += l.grossCents;
      t.invoicedCents += l.invoicedCents;
      if (l.driverPayCents === null) t.payMissing += 1;
      else t.driverPayCents += l.driverPayCents;
      t.loadCostsCents += l.postedCostsCents;
      byTruck.set(key, t);
    }
    for (const e of posted) {
      if (e.record.loadId) continue;
      const key = e.record.truckId ?? 'unallocated';
      const t = byTruck.get(key) ?? { truckId: key, unitNumber: unit(e.record.truckId), loads: 0, grossCents: 0, invoicedCents: 0, driverPayCents: 0, payMissing: 0, loadCostsCents: 0, truckCostsCents: 0 };
      t.truckCostsCents += Math.round(e.record.amount * 100);
      byTruck.set(key, t);
    }
    const unallocated = posted.filter((e) => !e.record.truckId && !e.record.loadId);
    const ledgerRevenue = sumCents(invoices.filter((i) => i.record.isCurrent && i.record.status !== 'draft' && i.record.status !== 'void' && inRange(i.record.issuedOn)).map((i) => Math.round(i.record.total * 100)));
    const operationalGross = sumCents(loadsOut.map((l) => l.grossCents));
    return {
      range,
      loads: loadsOut,
      trucks: [...byTruck.values()].map((t) => ({ ...t, marginCents: t.payMissing > 0 ? null : t.grossCents - t.driverPayCents - t.loadCostsCents - t.truckCostsCents })),
      unallocatedCostsCents: sumCents(unallocated.map((e) => Math.round(e.record.amount * 100))),
      unallocatedCount: unallocated.length,
      reconciliation: { operationalGrossCents: operationalGross, invoicedRevenueCents: ledgerRevenue, unbilledCents: operationalGross - sumCents(loadsOut.map((l) => l.invoicedCents)), note: 'Operational gross counts every completed load in the period at its charges; invoiced revenue counts issued invoices by issue date. The difference is the unbilled pipeline plus timing.' },
    };
  }
}
