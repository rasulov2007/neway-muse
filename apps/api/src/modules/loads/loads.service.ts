import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, lte, or, sql } from 'drizzle-orm';
import {
  applyAddNote,
  applyAttachDocument,
  applyPayFacts,
  type LoadPayFactsInput,
  applyEdit,
  refusedEditFields,
  applyCheckCall,
  type CheckCallInput,
  transition,
  type TransitionActor,
  type TransitionSource,
  applyPinNote,
  applyChargeDecision,
  applyRemoveDocument,
  applyReview,
  type AddLoadNoteInput,
  type CancelLoadInput,
  type ConfirmUploadInput,
  type PinLoadNoteInput,
  type AssignLoadInput,
  type AttachLoadDocumentInput,
  type ChangeStatusInput,
  type StopEventInput,
  type LoadStatusCode,
  type DecideLoadChargeInput,
  type RemoveLoadDocumentInput,
  type ReviewDocumentInput,
  type PayDateOverride,
  versionConflict,
  type StoredLoad,
  type WriteRefusal,
  type WriteResult,
  driverLastDrop,
  type DriverLastDrop,
  type LastDropLoad,
  applyChooseRoute,
  applyClearRoute,
  type ChosenRoute,
  type RouteOption,
  type RouteSettingsUsed,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { dispatchBoardCells, dispatchBoardEdits, dispatchRoster, loads as loadsTable } from '../../database/schema';
import { AuditService } from '../people/audit.service';

/**
 * What the Daily Board should say about a driver once the load has moved.
 *
 * Availability, not freight: the board word answers "can this driver take something", which is
 * why only these five load statuses have an answer at all. Everything else - COVERED, HOME,
 * SHOP, a driver resting - is the board's own business and is never overwritten from here.
 */
const BOARD_STATUS_FOR: Partial<Record<LoadStatusCode, string>> = {
  dispatched: 'DISPATCHED',
  // Standing on the shipper (owner, 2026-10-13).
  at_pickup: 'AT PU',
  loading: 'AT PU',
  loaded: 'ENROUTE',
  in_transit: 'ENROUTE',
  at_delivery: 'UNLOADING',
  unloading: 'UNLOADING',
  delivered: 'READY',
};

/** The board words a load event may replace. A driver who is off stays off. */
/** The statuses that make a load somebody's work today. */
const LIVE_STATUSES = new Set([
  'booked', 'assigned', 'dispatched', 'at_pickup', 'loading', 'loaded', 'in_transit', 'at_delivery', 'unloading',
]);
const MOVING_STATUSES = new Set(['at_pickup', 'loading', 'loaded', 'in_transit', 'at_delivery', 'unloading']);

const BOARD_OVERWRITABLE = new Set([
  '',
  'READY',
  'COVERED',
  'RESERVED',
  'HOLD FOR LOAD',
  'RE-UPDATE',
  'DISPATCHED',
  'AT PU',
  'ENROUTE',
  'UNLOADING',
]);

/** What a write answers with: the record as stored, and the collection's new timestamp. */
export interface LoadWriteResponse {
  load: StoredLoad;
  /**
   * The load's own `updatedAt` after the write. The name is from the days the browser saved the
   * whole collection and needed its timestamp back; the value now belongs to this one load.
   */
  collectionUpdatedAt: string;
}

/** Fields the client may change through PATCH. Status and assignment have their own routes. */
// The fields Edit may change live in the shared rule (`EDITABLE_LOAD_FIELDS`), tested there.

/** Which record fields sit in their own columns, for the filters and joins the board runs. */
function columnsOf(record: StoredLoad) {
  return {
    loadNumber: record.loadNumber,
    status: record.status,
    dispatcherId: record.dispatcherId ?? '',
    updaterId: (record['updaterId'] as string | null | undefined) ?? null,
    driverId: record.driverId ?? null,
    truckId: record.truckId ?? null,
    trailerId: record.trailerId ?? null,
  };
}

/**
 * Per-record writes to loads while loads still live in the workspace blob (P0.1, P0.5).
 *
 * Loads are one JSON list in `app_state` under `ws2-loads`, written whole by the browser's
 * autosave. The writes here are the ones that have to be true across browsers the moment they
 * happen and the ones a rule guards: a cancel, a note, a document's review, a confirmed
 * suggestion. Each one reads the list, finds the record, checks the `updatedAt` the caller was
 * looking at, runs the shared rule, and writes the list back under the row's own version check -
 * so two writes to two loads serialise through the lock below rather than racing on the row,
 * and a browser autosave that lands in between is refused and merged on its side, never here.
 *
 * The lead rule lives here: `dispatch.manage` is read off the principal the session proved, not
 * off anything the browser sent.
 */
@Injectable()
export class LoadsService {
  constructor(
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  /** The clock every write stamps; a test replaces it. */
  clock: () => Date = () => new Date();

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Called after every committed write with the load as written. Accounting's completion
   * pipeline registers here (it cannot be imported: it depends on this service). A listener's
   * failure is its own to record; it never fails the write.
   */
  readonly afterWrite: Array<(principal: Principal, load: StoredLoad) => Promise<void>> = [];

  /**
   * Called after a document's review is written (Mark reviewed / Verify / Reject), with the load as
   * written and the document reviewed. The mobile module registers here to tell the driver who sent
   * the file (0081). A listener's failure never fails the review.
   */
  readonly afterDocumentReview: Array<(principal: Principal, load: StoredLoad, documentId: string) => Promise<void>> = [];

  /**
   * Once invoiced, the load's billed facts belong to Accounting (§3): only somebody with
   * accounting.edit may edit, reassign, cancel or replace documents on it. Notes stay open.
   */
  private invoicedLock(principal: Principal, record: StoredLoad): { ok: false; refusal: { code: 'forbidden'; message: string } } | null {
    if (!record['invoiceId']) return null;
    if (hasPermission(principal, 'accounting.edit')) return null;
    return { ok: false, refusal: { code: 'forbidden', message: `${record.loadNumber} is invoiced (${String(record['invoiceId'])}). Ask Accounting for a correction; notes can still be added.` } };
  }

  /** Accounting's own write: the invoice this load is billed on (null when voided). */
  async markInvoiced(principal: Principal, id: string, invoiceId: string | null): Promise<LoadWriteResponse> {
    return this.write(principal, id, (record, now) => ({ ok: true, record: { ...record, invoiceId, updatedAt: now } as StoredLoad, event: null }), (_before, after) => ({
      action: invoiceId ? 'load_invoiced' : 'load_uninvoiced',
      summary: invoiceId ? `${after.loadNumber} invoiced on ${invoiceId}` : `${after.loadNumber} invoice voided`,
      changes: [{ field: 'invoiceId', old: null, new: invoiceId }],
    }));
  }

  /**
   * Accounting's "Counts for pay on" (owner, 2026-10-21): the moment the load counts for driver
   * pay, overriding its delivered time for settlements only. The delivery facts are not touched.
   * Version-checked against the copy the screen read, audited with the reason. The settlement
   * rules (which statement may still change) are Accounting's and are checked before this runs.
   */
  async setPayDate(
    principal: Principal,
    id: string,
    input: { override: PayDateOverride | null; reason: string; expectedUpdatedAt: string; previousAt: string | null },
  ): Promise<LoadWriteResponse> {
    return this.write(
      principal,
      id,
      (record, now) => {
        const stale = versionConflict(record, input.expectedUpdatedAt);
        if (stale) return { ok: false, refusal: stale };
        return { ok: true, record: { ...record, payDateOverride: input.override, updatedAt: now } as StoredLoad, event: null };
      },
      (before, after) => {
        const was = (before['payDateOverride'] as PayDateOverride | null | undefined)?.at ?? null;
        const now = (after['payDateOverride'] as PayDateOverride | null | undefined)?.at ?? null;
        return {
          action: 'load_pay_date_set',
          summary: now
            ? `${after.loadNumber} counts for pay at ${now} (was ${input.previousAt ?? 'its delivered time'}): ${input.reason}`
            : `${after.loadNumber} counts for pay at its delivered time again (override ${was ?? 'none'} removed): ${input.reason}`,
          reason: input.reason,
          changes: [{ field: 'payDateOverride', old: was, new: now }],
        };
      },
    );
  }

  /**
   * Accounting's correction from a driver statement (owner, 2026-10-23): the For driver rate, the
   * For driver amount of an accessorial, the broker's REF number. Billing is not touched - the
   * real rate and the real charge amounts stay what the invoice reads. Version-checked against
   * the copy the statement read, audited field by field with the reason. Which statement may
   * still change is Accounting's rule and is checked before this runs.
   */
  async setPayFacts(principal: Principal, id: string, input: LoadPayFactsInput): Promise<LoadWriteResponse> {
    const money = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : null);
    return this.write(
      principal,
      id,
      (record, now) => applyPayFacts(record, input, now),
      (before, after) => {
        const changes: { field: string; old: string | null; new: string | null }[] = [];
        if (before['driverRate'] !== after['driverRate']) changes.push({ field: 'driverRate', old: money(before['driverRate']), new: money(after['driverRate']) });
        if (before['brokerReference'] !== after['brokerReference']) changes.push({ field: 'brokerReference', old: (before['brokerReference'] as string | null) ?? null, new: (after['brokerReference'] as string | null) ?? null });
        const chargesBefore = (before['charges'] as Array<{ id: string; driverAmount?: number | null }> | undefined) ?? [];
        for (const c of (after['charges'] as Array<{ id: string; driverAmount?: number | null }> | undefined) ?? []) {
          const was = chargesBefore.find((x) => x.id === c.id)?.driverAmount ?? null;
          if ((c.driverAmount ?? null) !== was) changes.push({ field: `charges.${c.id}.driverAmount`, old: money(was), new: money(c.driverAmount ?? null) });
        }
        return {
          action: 'load_pay_facts_set',
          summary: `${after.loadNumber} corrected from the driver statement: ${changes.map((c) => `${c.field} ${c.old ?? 'same as real'} → ${c.new ?? 'same as real'}`).join(', ')}`,
          reason: input.reason?.trim() || undefined,
          changes,
        };
      },
    );
  }

  /**
   * The road the dispatcher chose from TollGuru's options (owner, 2026-10-27). The option is
   * the server's own - looked up by id in the list it priced - so the numbers stored are never
   * the browser's. Version-checked; the timeline says "Route chosen: …".
   */
  async chooseRoute(
    principal: Principal,
    id: string,
    input: { expectedUpdatedAt: string; option: RouteOption; settings: RouteSettingsUsed },
  ): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(principal, id, (record, now) => applyChooseRoute(record, input, actor, now), (before, after) => {
      const was = before['route'] as ChosenRoute | null | undefined;
      return {
        action: 'load_route_chosen',
        summary: `Route chosen on ${after.loadNumber}: ${input.option.via} · ${input.option.miles} mi · tolls ${input.option.tollCost.toFixed(2)} · fuel ${input.option.fuelCost.toFixed(2)}`,
        changes: [{ field: 'route', old: was ? `${was.via} (${was.miles} mi)` : null, new: `${input.option.via} (${input.option.miles} mi)` }],
      };
    });
  }

  /** Takes the chosen road off the load. */
  async clearRoute(principal: Principal, id: string, input: { expectedUpdatedAt: string }): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(principal, id, (record, now) => applyClearRoute(record, input, actor, now), (before, after) => {
      const was = before['route'] as ChosenRoute | null | undefined;
      return {
        action: 'load_route_cleared',
        summary: `Route cleared on ${after.loadNumber}`,
        changes: [{ field: 'route', old: was ? `${was.via} (${was.miles} mi)` : null, new: null }],
      };
    });
  }

  /**
   * Who is speaking, for the one transition function.
   *
   * A person's write is `user`; one that came from the Daily Board says so, because the board's
   * word and the load's status are the same record moved from two places and the timeline should
   * say which. The upload sources are named where a confirmation is turned into a status.
   */
  private actorOf(principal: Principal, source: TransitionSource = 'user'): TransitionActor {
    return {
      id: principal.userId,
      name: principal.userName ?? 'Signed-in user',
      isLead: this.isLead(principal),
      source,
    };
  }

  /**
   * Whether this person may cancel this load (rule 1.9). Owner, 2026-11-03: every dispatcher, not
   * only the load's own dispatcher or updater; the broker's approval and the reason stay required.
   */
  private mayCancel(principal: Principal, record: StoredLoad): boolean {
    return (
      record.dispatcherId === principal.userId ||
      (record['updaterId'] as string | null | undefined) === principal.userId ||
      this.mayCancelAny(principal)
    );
  }

  /** Cancelling any load, dispatched ones included: loads.edit (every dispatcher) or dispatch.manage. */
  mayCancelAny(principal: Principal): boolean {
    return hasPermission(principal, 'loads.edit') || hasPermission(principal, 'dispatch.manage');
  }

  /** True when this principal may cancel a load already dispatched. The screen asks; the write checks anyway. */
  isLead(principal: Principal): boolean {
    return hasPermission(principal, 'dispatch.manage');
  }

  async get(principal: Principal, id: string): Promise<StoredLoad> {
    const [row] = await this.database.db
      .select({ record: loadsTable.record })
      .from(loadsTable)
      .where(and(eq(loadsTable.companyId, principal.companyId), or(eq(loadsTable.id, id), eq(loadsTable.loadNumber, id))))
      .limit(1);
    if (!row) throw new NotFoundException(`No load '${id}'.`);
    return row.record as StoredLoad;
  }

  /**
   * Every load the company has, newest first. Demo rows stay out unless asked for: they are
   * hidden from every screen and every count by default (rule 1.2), never deleted.
   */
  async list(principal: Principal, options: { includeDemo: boolean }): Promise<StoredLoad[]> {
    const filters = [eq(loadsTable.companyId, principal.companyId)];
    if (!options.includeDemo) filters.push(eq(loadsTable.isDemo, false));
    const rows = await this.database.db
      .select({ record: loadsTable.record })
      .from(loadsTable)
      .where(and(...filters))
      .orderBy(desc(loadsTable.updatedAt));
    return rows.map((r) => r.record as StoredLoad);
  }

  /**
   * Where the driver's latest load ends (owner, 2026-10-25): the place the Add load form measures
   * empty miles from. Read from the table, not the browser's copy of the list, so a load another
   * dispatcher booked a minute ago counts. Hidden (`is_demo`) loads are not anybody's last drop.
   */
  async driverLastDrop(principal: Principal, driverId: string, excludeLoadId: string | null): Promise<DriverLastDrop | null> {
    const rows = await this.database.db
      .select({ record: loadsTable.record })
      .from(loadsTable)
      .where(
        and(
          eq(loadsTable.companyId, principal.companyId),
          eq(loadsTable.isDemo, false),
          or(eq(loadsTable.driverId, driverId), sql`${loadsTable.record}->>'coDriverId' = ${driverId}`),
        ),
      );
    return driverLastDrop(rows.map((r) => r.record as LastDropLoad), driverId, excludeLoadId);
  }

  /**
   * The highest `L-<n>` number the company has used, hidden (`is_demo`) loads included: a hidden
   * load keeps its number, so the next booking must not be offered it again (owner, 2026-10-14).
   */
  async highestNumber(principal: Principal): Promise<number> {
    const [row] = await this.database.db
      .select({ n: sql<string | null>`max(substring(${loadsTable.loadNumber} from '^L-([0-9]+)$')::bigint)` })
      .from(loadsTable)
      .where(eq(loadsTable.companyId, principal.companyId));
    return Number(row?.n ?? 0);
  }

  /**
   * A new load, as the booking screen built it.
   *
   * The screen assembles the document - customer, stops, money, the first timeline entry - and
   * the server owns the write: the number is checked for a twin inside the same transaction, the
   * id is the server's, and the row is stamped here.
   */
  async create(principal: Principal, record: StoredLoad): Promise<LoadWriteResponse> {
    const at = this.clock();
    const now = at.toISOString();
    const loadNumber = String(record.loadNumber ?? '').trim();
    if (!loadNumber) throw new UnprocessableEntityException('A load needs a number.');

    const stored = await this.database.db.transaction(async (tx) => {
      const [twin] = await tx
        .select({ id: loadsTable.id })
        .from(loadsTable)
        .where(and(eq(loadsTable.companyId, principal.companyId), eq(loadsTable.loadNumber, loadNumber)))
        .limit(1);
      if (twin) throw new ConflictException(`Load ${loadNumber} already exists.`);
      const wanted = (record.id && String(record.id).trim()) || `ld_${loadNumber.replace(/^L-/, '').replace(/[^A-Za-z0-9]/g, '')}`;
      const [taken] = await tx.select({ id: loadsTable.id }).from(loadsTable).where(eq(loadsTable.id, wanted)).limit(1);
      const id = taken ? `${wanted}_${at.getTime().toString(36)}` : wanted;
      const document: StoredLoad = {
        ...record,
        id,
        loadNumber,
        createdAt: (record['createdAt'] as string | undefined) ?? now,
        updatedAt: now,
      };
      await tx.insert(loadsTable).values({
        id,
        companyId: principal.companyId,
        ...columnsOf(document),
        isDemo: false,
        version: 1,
        record: document,
        createdAt: at,
        updatedAt: at,
      });
      return document;
    });

    // A load booked straight into a completed status (imports, walkthroughs) is a completion too.
    for (const listener of this.afterWrite) {
      try {
        await listener(principal, stored);
      } catch {
        // The listener records its own failure; the booking stands.
      }
    }
    await this.audit.write(principal, {
      action: 'load_booked',
      entityType: 'load',
      entityId: stored.id,
      entityLabel: stored.loadNumber,
      summary: `Booked ${stored.loadNumber}.`,
      reason: null,
      changes: [],
    });
    return { load: stored, collectionUpdatedAt: now };
  }

  /**
   * An edit: only the fields the person changed, nothing else (rule 1.3).
   *
   * The screen sends the fields it changed and the `updatedAt` it was looking at; the server
   * merges those fields alone, so opening Edit and changing the reference cannot rewrite the
   * miles, the dispatcher or the times. Status, driver, truck and trailer are refused here -
   * they have their own routes, with their own rules and their own board effects.
   */
  async patch(
    principal: Principal,
    id: string,
    input: { expectedUpdatedAt: string; patch: Record<string, unknown>; summary?: string | null },
  ): Promise<LoadWriteResponse> {
    const keys = Object.keys(input.patch);
    const refused = refusedEditFields(input.patch);
    if (refused.length > 0) {
      throw new UnprocessableEntityException(
        `${refused.join(', ')} cannot be changed through Edit. Status moves on the Daily Board or Record an event; the assignment has its own route.`,
      );
    }
    const actor = this.actorOf(principal);
    return this.write(
      principal,
      id,
      (record, now) => this.invoicedLock(principal, record) ?? applyEdit(record, input, now, actor),
      (before, after) => ({
        action: 'load_edited',
        summary: `${actor.name} edited ${after.loadNumber}: ${keys.join(', ')}.`,
        changes: keys.map((field) => ({
          field,
          old: before[field] === undefined ? null : JSON.stringify(before[field]),
          new: after[field] === undefined ? null : JSON.stringify(after[field]),
        })),
      }),
    );
  }

  async cancel(principal: Principal, id: string, input: CancelLoadInput): Promise<LoadWriteResponse> {
    // Every dispatcher may cancel a dispatched load too (owner, 2026-11-03), not only a lead.
    const actor = { ...this.actorOf(principal), isLead: this.mayCancelAny(principal) };
    return this.write(principal, id, (record, now) => {
      if (!this.mayCancel(principal, record)) {
        return { ok: false, refusal: { code: 'forbidden', message: `Cancelling ${record.loadNumber} takes loads.edit.` } };
      }
      return this.invoicedLock(principal, record) ?? transition(record, { kind: 'cancel', input }, actor, now);
    }, (before, after) => ({
      action: 'cancel',
      summary: `${after.loadNumber} ${after.status === 'tonu' ? 'TONU' : 'cancelled'} - ${input.reason.trim()}`,
      reason: input.reason.trim(),
      changes: [
        { field: 'status', old: before.status, new: after.status },
        { field: 'driverId', old: before.driverId, new: null },
        { field: 'truckId', old: before.truckId, new: null },
        { field: 'trailerId', old: before.trailerId, new: null },
        ...(after.status === 'tonu' ? [{ field: 'tonuFee', old: null, new: String(input.fee ?? 0) }] : []),
      ],
    }));
  }

  async addNote(principal: Principal, id: string, input: AddLoadNoteInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(principal, id, (record, now) => applyAddNote(record, input, actor, now), (_before, after) => ({
      action: 'update',
      summary: `Note ${input.pinned ? 'pinned' : 'added'} on ${after.loadNumber}`,
      changes: [{ field: 'notes', old: null, new: input.body.trim().slice(0, 200) }],
    }));
  }

  /** A check call or a person's ETA: on the timeline, so "last update" reads it. */
  async checkCall(principal: Principal, id: string, input: CheckCallInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(principal, id, (record, now) => applyCheckCall(record, input, actor, now), (_before, after) => ({
      action: 'update',
      summary: `${input.kind === 'check_call' ? 'Check call' : 'ETA changed'} on ${after.loadNumber}`,
      changes: [
        { field: 'timeline', old: null, new: input.kind },
        ...(input.etaAt ? [{ field: 'manualEta.at', old: null, new: input.etaAt }] : []),
      ],
    }));
  }

  async pinNote(principal: Principal, id: string, input: PinLoadNoteInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(principal, id, (record, now) => applyPinNote(record, input, actor, now), (_before, after) => ({
      action: 'update',
      summary: `Note ${input.pinned ? 'pinned' : 'unpinned'} on ${after.loadNumber}`,
      changes: [{ field: `notes.${input.noteId}.pinned`, old: String(!input.pinned), new: String(input.pinned) }],
    }));
  }

  /** A drafted accessorial accepted or dropped (owner, 2026-11-02): Dispatch or Accounting. */
  async decideCharge(principal: Principal, id: string, chargeId: string, input: DecideLoadChargeInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(
      principal,
      id,
      (record, now) => this.invoicedLock(principal, record) ?? applyChargeDecision(record, chargeId, input, actor, now),
      (before, after) => {
        const was = (before['charges'] as Array<{ id: string; description: string; amount: number; status?: string }> | undefined)?.find((c) => c.id === chargeId);
        const is = (after['charges'] as Array<{ id: string; amount: number; status?: string }> | undefined)?.find((c) => c.id === chargeId);
        return {
          action: 'update',
          summary: `${was?.description ?? 'Charge'} ${input.decision} on ${after.loadNumber}`,
          changes: [
            { field: `charges.${chargeId}.status`, old: was?.status ?? 'draft', new: input.decision },
            ...(was && is && was.amount !== is.amount ? [{ field: `charges.${chargeId}.amount`, old: String(was.amount), new: String(is.amount) }] : []),
          ],
        };
      },
    );
  }

  /**
   * A file filed by mistake taken off the load (owner, 2026-11-02), kept on the record as removed.
   * A BOL or POD can take the load back the step it made; the board follows the status.
   */
  async removeDocument(principal: Principal, id: string, documentId: string, input: RemoveLoadDocumentInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(
      principal,
      id,
      (record, now) => this.invoicedLock(principal, record) ?? applyRemoveDocument(record, documentId, input, actor, now),
      (before, after) => {
        const doc = before.documents.find((d) => d.id === documentId);
        return {
          action: 'update',
          summary: `${doc?.title ?? 'Document'} removed from ${after.loadNumber}${before.status !== after.status ? ` · back to ${after.status.replace(/_/g, ' ')}` : ''}`,
          reason: input.reason.trim(),
          changes: [
            { field: `documents.${documentId}`, old: doc?.fileName ?? null, new: 'removed' },
            ...(before.status !== after.status ? [{ field: 'status', old: before.status, new: after.status }] : []),
          ],
        };
      },
      (before, after, rows) => {
        if (!this.isCurrentLoad(after, rows)) return null;
        return before.status !== after.status ? this.boardSyncFor(after) : null;
      },
    );
  }

  async reviewDocument(principal: Principal, id: string, documentId: string, input: ReviewDocumentInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    const written = await this.write(principal, id, (record, now) => applyReview(record, documentId, input, actor, now), (before, after) => {
      const was = before.documents.find((d) => d.id === documentId);
      const is = after.documents.find((d) => d.id === documentId);
      return {
        action: 'update',
        summary: `${is?.title ?? 'Document'} ${input.review} on ${after.loadNumber}`,
        changes: [{ field: `documents.${documentId}.review`, old: was?.review ?? was?.status ?? null, new: is?.review ?? null }],
      };
    });
    for (const listener of this.afterDocumentReview) {
      try {
        await listener(principal, written.load, documentId);
      } catch {
        // The listener records its own failure; the review stands.
      }
    }
    return written;
  }

  // ------------------------------------------------------------------ the driver app (0081)

  /**
   * A rule that runs only while the load is still this driver's. The driver app's writes check
   * ownership on the locked row, not on an earlier read: a load reassigned a second ago is not
   * the old driver's to touch. Anything else reads as not found, like a load of another company.
   */
  private ownedBy(driverId: string, rule: (record: StoredLoad, now: string) => WriteResult<StoredLoad>) {
    return (record: StoredLoad, now: string): WriteResult<StoredLoad> =>
      record.driverId === driverId && !record['isDemo'] ? rule(record, now) : { ok: false, refusal: { code: 'not_found', message: 'No such load.' } };
  }

  /** The driver says they have seen the load (once; a second ack changes nothing). */
  async driverAcknowledge(principal: Principal, id: string, driverId: string, expectedUpdatedAt?: string): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal, 'driver_app');
    return this.write(
      principal,
      id,
      this.ownedBy(driverId, (record, now) => {
        if (expectedUpdatedAt) {
          const stale = versionConflict(record, expectedUpdatedAt);
          if (stale) return { ok: false, refusal: stale };
        }
        if (record['driverAck'] && (record['driverAck'] as { driverId?: string }).driverId === driverId) return { ok: true, record, event: null };
        const event = {
          id: `evt_${record.loadNumber.replace(/^L-/, '')}_${record.timeline.length + 1}_ack`,
          at: now,
          kind: 'driver_acknowledged',
          actorType: 'driver',
          actorName: `${actor.name} · Driver app`,
          title: 'Load acknowledged by the driver',
          detail: null,
          stopId: null,
        };
        return {
          ok: true,
          record: { ...record, driverAck: { driverId, at: now, byId: actor.id, byName: actor.name }, timeline: [...record.timeline, event], updatedAt: now },
          event,
        };
      }),
      (_before, after) => ({
        action: 'update',
        summary: `${after.loadNumber} acknowledged by the driver (driver app)`,
        changes: [{ field: 'driverAck', old: null, new: (after['driverAck'] as { at?: string } | undefined)?.at ?? null }],
      }),
    );
  }

  /**
   * A stop event from the driver app: through the same transition door as the board and the load
   * page, with the source `driver_app`. The zone is the stop's own (the server's, never the phone's),
   * and the version check is the caller's when it sent one, else the row as locked.
   */
  async driverStopEvent(
    principal: Principal,
    id: string,
    driverId: string,
    input: Omit<StopEventInput, 'zone' | 'expectedUpdatedAt' | 'bypassPaperwork' | 'boardStatus'> & { expectedUpdatedAt?: string },
  ): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal, 'driver_app');
    let full: StopEventInput | null = null;
    return this.write(
      principal,
      id,
      this.ownedBy(driverId, (record, now) => {
        const stop = record.stops.find((s) => s.id === input.stopId);
        if (!stop) return { ok: false, refusal: { code: 'invalid', message: 'That stop is no longer on the load.' } };
        full = { ...input, zone: stop.timezone, bypassPaperwork: false, expectedUpdatedAt: input.expectedUpdatedAt ?? record.updatedAt };
        return transition(record, { kind: 'stop_event', input: full }, actor, now);
      }),
      (before, after) => {
        const stop = after.stops.find((s) => s.id === input.stopId);
        return {
          action: 'update',
          summary: `${after.loadNumber} ${input.kind} ${stop ? `at ${stop.facilityName || stop.city}` : ''} (driver app)`.trim(),
          reason: input.delayReason?.trim(),
          changes: [
            { field: `stops.${input.stopId}.${input.kind === 'arrived' ? 'arrivedAt' : 'departedAt'}`, old: null, new: full?.at ?? input.at },
            ...(before.status !== after.status ? [{ field: 'status', old: before.status, new: after.status }] : []),
          ],
        };
      },
      (before, after, rows) => {
        if (!this.isCurrentLoad(after, rows)) return null;
        if (before.status !== after.status) return this.boardSyncFor(after);
        if (input.kind !== 'arrived' && after.status === 'in_transit' && after.driverId) {
          return { driverId: after.driverId as string, status: 'ENROUTE' };
        }
        return null;
      },
    );
  }

  /**
   * A paper the driver sent from the phone: filed as received, source `driver_app`. It never moves
   * the load and never marks anything reviewed; the office confirms what it suggests, as always.
   */
  async driverAttachDocument(principal: Principal, id: string, driverId: string, input: Omit<AttachLoadDocumentInput, 'expectedUpdatedAt'> & { expectedUpdatedAt?: string }): Promise<LoadWriteResponse & { documentId: string }> {
    const actor = { ...this.actorOf(principal, 'driver_app'), name: `${principal.userName ?? 'Driver'} · Driver app` };
    let documentId = '';
    const written = await this.write(
      principal,
      id,
      this.ownedBy(driverId, (record, now) => {
        const locked = this.invoicedLock(principal, record);
        if (locked) return locked;
        if (input.replacesId && !record.documents.some((d) => d.id === input.replacesId)) {
          return { ok: false, refusal: { code: 'invalid', message: 'The file this replaces is not on the load.' } };
        }
        const result = applyAttachDocument(record, { ...input, expectedUpdatedAt: input.expectedUpdatedAt ?? record.updatedAt }, actor, now);
        if (result.ok) documentId = result.record.documents[result.record.documents.length - 1]?.id ?? '';
        return result;
      }),
      (_before, after) => ({
        action: 'update',
        summary: `${input.type.replace(/_/g, ' ')} filed on ${after.loadNumber} from the driver app`,
        changes: [{ field: `documents.${input.type}`, old: input.replacesId ?? null, new: input.fileName }],
      }),
    );
    return { ...written, documentId };
  }

  async confirmUpload(principal: Principal, id: string, input: ConfirmUploadInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal, input.kind === 'mark_loaded' ? 'bol_upload' : 'pod_upload');
    return this.write(principal, id, (record, now) => transition(record, { kind: 'confirm_upload', input }, actor, now), (before, after) => ({
      action: 'update',
      summary: `${input.kind === 'mark_loaded' ? 'Loaded' : 'Delivered'} confirmed from paperwork on ${after.loadNumber}`,
      changes: [
        { field: 'status', old: before.status, new: after.status },
        { field: `stops.${input.stopId}.status`, old: before.stops.find((s) => s.id === input.stopId)?.status ?? null, new: 'completed' },
      ],
    }),
      (_before, after, rows) => {
        if (!this.isCurrentLoad(after, rows) || !after.driverId) return null;
        const word = input.boardStatus?.trim();
        const chosen = word && BOARD_OVERWRITABLE.has(word) ? word : (BOARD_STATUS_FOR[after.status as LoadStatusCode] ?? null);
        return chosen ? { driverId: after.driverId as string, status: chosen } : null;
      },
    );
  }

  /**
   * A status move.
   *
   * The load and the driver's board row change together, in one transaction: there is no moment
   * where a driver reads READY while the freight is unfinished.
   */
  async changeStatus(principal: Principal, id: string, input: ChangeStatusInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal, input.boardStatus ? 'daily_board' : 'user');
    return this.write(
      principal,
      id,
      (record, now) => transition(record, { kind: 'status', input }, actor, now),
      (before, after) => ({
        action: 'update',
        summary: `${after.loadNumber} ${before.status.replace(/_/g, ' ')} → ${after.status.replace(/_/g, ' ')}`,
        reason: input.reason?.trim(),
        changes: [{ field: 'status', old: before.status, new: after.status }],
      }),
      (_before, after, rows) => {
        if (!this.isCurrentLoad(after, rows)) return null;
        const chosen = input.boardStatus?.trim();
        if (chosen && after.driverId) return { driverId: after.driverId as string, status: chosen };
        return this.boardSyncFor(after);
      },
    );
  }

  /** One stop arriving or leaving; the load follows the stop, never the other way round. */
  async recordStopEvent(principal: Principal, id: string, input: StopEventInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal, input.boardStatus ? 'daily_board' : 'user');
    return this.write(
      principal,
      id,
      (record, now) => transition(record, { kind: 'stop_event', input }, actor, now),
      (before, after) => {
        const stop = after.stops.find((s) => s.id === input.stopId);
        return {
          action: 'update',
          summary: `${after.loadNumber} ${input.kind} ${stop ? `at ${stop.facilityName || stop.city}` : ''}`.trim(),
          changes: [
            { field: `stops.${input.stopId}.${input.kind === 'arrived' ? 'arrivedAt' : 'departedAt'}`, old: null, new: input.at },
            ...(before.status !== after.status ? [{ field: 'status', old: before.status, new: after.status }] : []),
          ],
        };
      },
      /*
       * The board follows the stop as well as the status: finishing an intermediate delivery
       * leaves the load in transit, and the driver is back on the road rather than unloading.
       */
      (before, after, rows) => {
        if (!this.isCurrentLoad(after, rows)) return null;
        const chosen = input.boardStatus?.trim();
        if (chosen && after.driverId) return { driverId: after.driverId as string, status: chosen };
        if (before.status !== after.status) return this.boardSyncFor(after);
        if (input.kind !== 'arrived' && after.status === 'in_transit' && after.driverId) {
          return { driverId: after.driverId as string, status: 'ENROUTE' };
        }
        return null;
      },
    );
  }

  /** Driver, truck and trailer. Nothing here dispatches: that is a promise a person makes. */
  async assign(principal: Principal, id: string, input: AssignLoadInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(
      principal,
      id,
      (record, now) => this.invoicedLock(principal, record) ?? transition(record, { kind: 'assignment', input }, actor, now),
      (before, after) => ({
        action: 'update',
        summary: `${after.loadNumber} assigned to ${after.driverName ?? 'nobody'}`,
        changes: [
          { field: 'driverId', old: (before.driverId as string | null) ?? null, new: (after.driverId as string | null) ?? null },
          { field: 'truckId', old: (before.truckId as string | null) ?? null, new: (after.truckId as string | null) ?? null },
          { field: 'trailerId', old: (before.trailerId as string | null) ?? null, new: (after.trailerId as string | null) ?? null },
        ],
      }),
      /*
       * Your rule: putting a driver on their current load shows as DISPATCHED with the number
       * beside it. A load booked for later is not their current load, so the row keeps saying
       * what the driver is doing today.
       */
      (_before, after, rows) => {
        if (!after.driverId || !this.isCurrentLoad(after, rows)) return null;
        if (after.status === 'assigned' || after.status === 'dispatched') {
          return { driverId: after.driverId as string, status: 'DISPATCHED' };
        }
        return this.boardSyncFor(after);
      },
    );
  }

  /**
   * Whether this load is the one the driver is on now.
   *
   * The same rule the Daily Board reads with: the load that is moving, else the dispatched one,
   * else the earliest pickup. A future booking never takes the row from today's work.
   */
  private isCurrentLoad(load: StoredLoad, rows: StoredLoad[]): boolean {
    if (!load.driverId) return false;
    const live = rows.filter(
      (r) => r.driverId === load.driverId && LIVE_STATUSES.has(r.status) && r.id !== load.id,
    );
    if (MOVING_STATUSES.has(load.status)) return true;
    if (live.some((r) => MOVING_STATUSES.has(r.status))) return false;
    if (load.status === 'dispatched') return true;
    if (live.some((r) => r.status === 'dispatched')) return false;
    const pickupOf = (r: StoredLoad) => Date.parse(r.stops[0]?.appointmentStartAt ?? '') || Number.MAX_SAFE_INTEGER;
    return live.every((r) => pickupOf(load) <= pickupOf(r));
  }

  /** Filing a document: the bytes are already stored, this records the paper on the load. */
  async attachDocument(principal: Principal, id: string, input: AttachLoadDocumentInput): Promise<LoadWriteResponse> {
    const actor = this.actorOf(principal);
    return this.write(
      principal,
      id,
      (record, now) => this.invoicedLock(principal, record) ?? applyAttachDocument(record, input, actor, now),
      (_before, after) => ({
        action: 'update',
        summary: `${input.type.replace(/_/g, ' ')} filed on ${after.loadNumber}${input.type === 'lumper_receipt' && input.chargeAmount ? ` with a ${input.chargeAmount} lumper charge` : ''}`,
        changes: [
          { field: `documents.${input.type}`, old: null, new: input.fileName },
          ...(input.type === 'lumper_receipt' && input.chargeAmount ? [{ field: 'charges.lumper', old: null, new: String(input.chargeAmount) }] : []),
        ],
      }),
    );
  }

  /** What the board should read for this load's driver, or null when the board is not involved. */
  private boardSyncFor(load: StoredLoad): { driverId: string; status: string } | null {
    const word = BOARD_STATUS_FOR[load.status as LoadStatusCode];
    if (!word || !load.driverId) return null;
    return { driverId: load.driverId, status: word };
  }

  /**
   * The board half of a load write, inside the caller's transaction.
   *
   * Written as the board's own cell so the Daily Board needs no special case, and recorded in the
   * board's edit history with `source: 'load'` so the row can say the load moved it rather than
   * a person. A driver who is off - HOME, SHOP, NO ANSWER - is left where they are.
   */
  private async syncBoard(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    principal: Principal,
    sync: { driverId: string; status: string },
    now: Date,
  ): Promise<void> {
    // The board's day is the company's (Eastern) day, not UTC's: after 8 pm the UTC date is
    // already tomorrow, and the row written there left today's board reading READY.
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: principal.companyTimezone || 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const [row] = await tx
      .select({ id: dispatchRoster.id })
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.driverId, sync.driverId)))
      .limit(1);
    if (!row) return; // A driver with no board row: the load moved, the board has nothing to say.

    const [cell] = await tx
      .select()
      .from(dispatchBoardCells)
      .where(
        and(
          eq(dispatchBoardCells.companyId, principal.companyId),
          eq(dispatchBoardCells.driverId, row.id),
          eq(dispatchBoardCells.day, day),
          eq(dispatchBoardCells.column, 'status'),
        ),
      )
      .limit(1);
    // With no row of its own today the board shows the latest earlier status (it carries), so
    // that is the word a load event may replace - and the one the history says it replaced.
    const [carried] = cell
      ? [cell]
      : await tx
          .select()
          .from(dispatchBoardCells)
          .where(
            and(
              eq(dispatchBoardCells.companyId, principal.companyId),
              eq(dispatchBoardCells.driverId, row.id),
              lte(dispatchBoardCells.day, day),
              eq(dispatchBoardCells.column, 'status'),
            ),
          )
          .orderBy(desc(dispatchBoardCells.day))
          .limit(1);
    const current = carried?.value ?? '';
    if (current === sync.status) return;
    if (!BOARD_OVERWRITABLE.has(current)) return;

    const by = principal.userId;
    const byName = principal.userName ?? principal.userId;
    if (cell) {
      await tx
        .update(dispatchBoardCells)
        .set({ value: sync.status, setBy: by, setByName: byName, setAt: now, version: cell.version + 1 })
        .where(eq(dispatchBoardCells.id, cell.id));
    } else {
      await tx.insert(dispatchBoardCells).values({
        id: `dbc_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
        companyId: principal.companyId,
        driverId: row.id,
        day,
        column: 'status',
        value: sync.status,
        setBy: by,
        setByName: byName,
        setAt: now,
        version: 1,
      });
    }
    await tx.insert(dispatchBoardEdits).values({
      id: `dbe_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      companyId: principal.companyId,
      driverId: row.id,
      day,
      column: 'status',
      oldValue: carried?.value ?? null,
      newValue: sync.status,
      by,
      byName,
      at: now,
      source: 'load',
    });
  }

  // --------------------------------------------------------------------------- the write path

  private refuse(refusal: WriteRefusal): never {
    switch (refusal.code) {
      case 'conflict':
        throw new ConflictException(refusal.message);
      case 'forbidden':
        throw new ForbiddenException(refusal.message);
      case 'not_found':
        throw new NotFoundException(refusal.message);
      default:
        throw new UnprocessableEntityException(refusal.message);
    }
  }

  /**
   * Read, rule, write, audit - one load at a time.
   *
   * The row is taken `for update`, so a second write to the same load waits its turn instead of
   * being refused; a browser that was looking at an older copy is still caught by the rule's
   * `updatedAt` check, and the version column moves with every write regardless.
   */
  private write(
    principal: Principal,
    id: string,
    rule: (record: StoredLoad, now: string) => WriteResult<StoredLoad>,
    describe: (before: StoredLoad, after: StoredLoad) => {
      action: string;
      summary: string;
      reason?: string;
      changes: { field: string; old: string | null; new: string | null }[];
    },
    /**
     * What the Daily Board should read afterwards, when this write concerns the board at all.
     * It is given the driver's other live loads too, because "the driver's current load" is a
     * question about the others: a load booked for Friday never takes the row from the one
     * running today.
     */
    board?: (before: StoredLoad, after: StoredLoad, rows: StoredLoad[]) => { driverId: string; status: string } | null,
  ): Promise<LoadWriteResponse> {
    const run = this.queue.then(async () => {
      const at = this.clock();
      const now = at.toISOString();
      const outcome = await this.database.db.transaction(async (tx) => {
        const locked = (await tx.execute(
          sql`SELECT record, version FROM loads
              WHERE company_id = ${principal.companyId} AND (id = ${id} OR load_number = ${id})
              FOR UPDATE`,
        )) as unknown as { record: StoredLoad | string; version: number }[];
        const row = locked[0];
        if (!row) throw new NotFoundException(`No load '${id}'.`);
        // A raw execute may hand jsonb back as text; the Drizzle selects elsewhere parse it.
        const before: StoredLoad = typeof row.record === 'string' ? (JSON.parse(row.record) as StoredLoad) : row.record;

        const result = rule(before, now);
        if (!result.ok) return { kind: 'refused' as const, refusal: result.refusal };
        const after = result.record;
        if (after === before) return { kind: 'unchanged' as const, load: after, collectionUpdatedAt: before.updatedAt };

        await tx
          .update(loadsTable)
          .set({ ...columnsOf(after), record: after, version: row.version + 1, updatedAt: new Date(after.updatedAt) })
          .where(eq(loadsTable.id, before.id));

        let sync: { driverId: string; status: string } | null = null;
        if (board) {
          const driverId = after.driverId ?? before.driverId;
          const others = driverId
            ? await tx
                .select({ record: loadsTable.record })
                .from(loadsTable)
                .where(and(eq(loadsTable.companyId, principal.companyId), eq(loadsTable.driverId, driverId)))
            : [];
          const rows = others.map((r) => ((r.record as StoredLoad).id === after.id ? after : (r.record as StoredLoad)));
          if (!rows.some((r) => r.id === after.id)) rows.push(after);
          sync = board(before, after, rows);
        }
        if (sync) await this.syncBoard(tx, principal, sync, at);

        return { kind: 'written' as const, load: after, before, collectionUpdatedAt: after.updatedAt };
      });

      if (outcome.kind === 'refused') this.refuse(outcome.refusal);
      if (outcome.kind === 'written') {
        for (const listener of this.afterWrite) {
          try {
            await listener(principal, outcome.load);
          } catch {
            // The listener records its own failure (acct_completions.error); the write stands.
          }
        }
        const description = describe(outcome.before, outcome.load);
        await this.audit.write(principal, {
          action: description.action,
          entityType: 'load',
          entityId: outcome.load.id,
          entityLabel: outcome.load.loadNumber,
          summary: description.summary,
          reason: description.reason ?? null,
          changes: description.changes,
        });
      }
      return { load: outcome.load, collectionUpdatedAt: outcome.collectionUpdatedAt };
    });
    // The queue never rejects: a refused write must not block the next one.
    this.queue = run.catch(() => undefined);
    return run;
  }
}
