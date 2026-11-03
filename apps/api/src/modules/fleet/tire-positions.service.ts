import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  TIRE_PARSER_VERSION,
  UNASSIGNED_TIRE,
  allocateTireCost,
  parseTireText,
  tirePositionChip,
  type FleetExpenseQuery,
  type FleetSpendEvent,
  type ParsedTireEvent,
  type TireEvent,
  type TirePositionsResponse,
  type TireTagInput,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { repairTireEvents, workOrderLines } from '../../database/schema';
import { AuditService } from '../people/audit.service';
import { FleetExpenseService } from './fleet-expense.service';

type Row = typeof repairTireEvents.$inferSelect;
type Kind = FleetSpendEvent['kind'];
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];


/**
 * Tire positions behind the Tire replacement page (owner brief, 2026-10-13).
 *
 * The records are the summary's own tire records - the same period, units and window the page
 * reads - so the map can only ever count what the table lists. Each record's description is read
 * by the shared rules the first time it is seen and again whenever it changes; a manual tag
 * replaces what the rules read and is never re-read over.
 */
@Injectable()
export class TirePositionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly expenses: FleetExpenseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async list(principal: Principal, query: FleetExpenseQuery, by = 'system'): Promise<TirePositionsResponse & { report: { records: number; parsed: number; unassigned: number; noTireWork: number; written: number } }> {
    const summary = await this.expenses.summary(principal, query);
    const records = new Map<string, FleetSpendEvent>();
    for (const e of summary.events) if (e.type === 'tire_replacement') records.set(`${e.kind}:${e.id}`, e);
    const report = { records: records.size, parsed: 0, unassigned: 0, noTireWork: 0, written: 0 };
    if (records.size === 0) return { events: [], report };

    const ids = [...new Set([...records.values()].map((e) => e.id))];
    const workOrderIds = [...records.values()].filter((e) => e.kind === 'work_order').map((e) => e.id);
    const lines = workOrderIds.length
      ? await this.db
          .select({ workOrderId: workOrderLines.workOrderId, systemCode: workOrderLines.systemCode, amount: workOrderLines.totalAmount })
          .from(workOrderLines)
          .where(and(eq(workOrderLines.companyId, principal.companyId), inArray(workOrderLines.workOrderId, workOrderIds)))
      : [];
    const tireLines = new Map<string, number>();
    for (const l of lines) if (l.systemCode === 'tires_wheels') tireLines.set(l.workOrderId, (tireLines.get(l.workOrderId) ?? 0) + Number(l.amount ?? 0));

    const active = await this.db.transaction(async (tx) => {
      // One reader at a time per company, so two pages opening together cannot both write the rows.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tires:${principal.companyId}`}))`);
      const rows = await tx
        .select()
        .from(repairTireEvents)
        .where(and(eq(repairTireEvents.companyId, principal.companyId), inArray(repairTireEvents.recordId, ids), isNull(repairTireEvents.voidedAt)));
      const out: Row[] = [];
      for (const [key, e] of records) {
        const mine = rows.filter((r) => `${r.recordKind}:${r.recordId}` === key);
        if (mine.some((r) => r.source === 'manual')) {
          out.push(...mine.filter((r) => r.source === 'manual'));
          continue;
        }
        const text = e.description ?? '';
        // What was read, and by which version of the rules: either changing reads it again.
        const readFrom = `v${TIRE_PARSER_VERSION}:${text}`;
        if (mine.length > 0 && mine.every((r) => r.parsedFrom === readFrom)) {
          out.push(...mine);
          continue;
        }
        if (mine.length > 0) await this.voidRows(tx, mine.map((r) => r.id), by, 'The description or the tire rules changed; read again');
        const read = parseTireText(text, e.unitKind);
        // Nothing tire-shaped (a wheel seal, a rim, a tire check): no tire event, nothing written.
        const fresh = await this.insert(tx, principal, e, read, this.tireCents(e, tireLines), 'parsed', readFrom, by);
        report.written += fresh.length;
        out.push(...fresh);
      }
      return out;
    });

    const events: TireEvent[] = [];
    for (const [key, e] of records) {
      const mine = active.filter((r) => `${r.recordKind}:${r.recordId}` === key);
      if (mine.length === 0) report.noTireWork += 1;
      else if (mine.some((r) => r.positionId === UNASSIGNED_TIRE)) report.unassigned += 1;
      else report.parsed += 1;
      // A tire work order priced each tire itself; anything else splits the record's tire amount.
      const priced = mine.length > 0 && mine.every((r) => r.tireCostCents !== null);
      const costed = priced ? mine.map((r) => ({ ...r, costCents: (r.tireCostCents ?? 0) + (r.laborCents ?? 0) })) : allocateTireCost(mine, this.tireCents(e, tireLines));
      for (const r of costed)
        events.push({
          id: r.id,
          recordKind: r.recordKind as Kind,
          recordId: r.recordId,
          positionId: r.positionId as TireEvent['positionId'],
          eventType: r.eventType as TireEvent['eventType'],
          quantity: r.quantity,
          costCents: r.costCents,
          source: r.source as TireEvent['source'],
          confidence: Number(r.confidence),
          note: r.note,
          unitId: r.unitId || e.truckId,
          unitKind: (r.unitKind as TireEvent['unitKind']) ?? e.unitKind,
          recordedOnUnitId: r.recordedOnUnitId,
          eventOn: r.eventOn ? String(r.eventOn) : e.date,
          action: (r.action as TireEvent['action']) ?? null,
          brand: r.brand,
          model: r.model,
          reason: r.reason,
          treadRemoved32: r.treadRemoved32 === null ? null : Number(r.treadRemoved32),
          tireCostCents: r.tireCostCents,
          laborCents: r.laborCents,
          odometer: r.odometer,
          vendorName: r.vendorName ?? e.vendorName,
        });
    }
    return { events, report };
  }

  /** A person's tag: replaces whatever stood for the record, refused when it changed meanwhile. */
  async tag(principal: Principal, kind: Kind, recordId: string, input: TireTagInput): Promise<{ ok: true; count: number }> {
    const by = principal.userName ?? principal.userId;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tires:${principal.companyId}`}))`);
      const current = await tx
        .select()
        .from(repairTireEvents)
        .where(
          and(
            eq(repairTireEvents.companyId, principal.companyId),
            eq(repairTireEvents.recordKind, kind),
            eq(repairTireEvents.recordId, recordId),
            isNull(repairTireEvents.voidedAt),
          ),
        );
      const same = [...current.map((r) => r.id)].sort().join(',') === [...input.basis].sort().join(',');
      if (!same) throw new ConflictException('Somebody changed these tire positions meanwhile. Reload and tag again.');
      const total = current.reduce((s, r) => s + r.allocatedCostCents, 0);
      if (current.length > 0) await this.voidRows(tx, current.map((r) => r.id), by, 'Replaced by a manual tag');
      const unit = { id: recordId, kind, truckId: input.unitId || current[0]?.unitId || '', unitKind: input.unitKind ?? (current[0]?.unitKind as 'truck' | 'trailer' | null) ?? 'truck' } as FleetSpendEvent;
      const events: ParsedTireEvent[] = input.events.map((t) => ({ ...t, confidence: 1, note: null }));
      await this.insert(tx, principal, unit, events, total, 'manual', null, by);
      await this.audit.writeIn(tx, principal, {
        action: 'tire_positions_tagged',
        entityType: kind,
        entityId: recordId,
        entityLabel: recordId,
        summary: `Tire positions set by hand: ${input.events.map((t) => `${tirePositionChip(t.positionId)}${t.quantity > 1 ? ` ×${t.quantity}` : ''} (${t.eventType})`).join(', ')}`,
        changes: [
          {
            field: 'tirePositions',
            old: current.map((r) => `${r.positionId}:${r.eventType}:${r.quantity}:${r.source}`).join(', ') || null,
            new: input.events.map((t) => `${t.positionId}:${t.eventType}:${t.quantity}:manual`).join(', '),
          },
        ],
      });
    });
    return { ok: true, count: input.events.length };
  }

  private tireCents(e: FleetSpendEvent, tireLines: Map<string, number>): number {
    const lines = e.kind === 'work_order' ? (tireLines.get(e.id) ?? 0) : 0;
    const dollars = lines > 0 && lines <= e.amount ? lines : e.amount;
    return Math.round(dollars * 100);
  }

  private async voidRows(tx: Tx, ids: string[], by: string, reason: string): Promise<void> {
    await tx.update(repairTireEvents).set({ voidedAt: new Date(), voidedBy: by, voidReason: reason }).where(inArray(repairTireEvents.id, ids));
  }

  private async insert(
    tx: Tx,
    principal: Principal,
    e: Pick<FleetSpendEvent, 'id' | 'kind' | 'truckId' | 'unitKind'>,
    events: ParsedTireEvent[],
    cents: number,
    source: 'parsed' | 'manual',
    parsedFrom: string | null,
    by: string,
  ): Promise<Row[]> {
    const rows = allocateTireCost(events, cents).map((t) => ({
      id: `rte_${crypto.randomUUID()}`,
      companyId: principal.companyId,
      recordKind: e.kind,
      recordId: e.id,
      unitId: e.truckId,
      unitKind: e.unitKind,
      positionId: t.positionId,
      eventType: t.eventType,
      quantity: t.quantity,
      allocatedCostCents: t.costCents,
      source,
      confidence: t.confidence.toFixed(2),
      note: t.note,
      parsedFrom,
      eventOn: 'date' in e ? (e as FleetSpendEvent).date : null,
      vendorName: 'vendorName' in e ? (e as FleetSpendEvent).vendorName : null,
      createdBy: by,
    }));
    if (rows.length === 0) return [];
    return tx.insert(repairTireEvents).values(rows).returning();
  }
}
