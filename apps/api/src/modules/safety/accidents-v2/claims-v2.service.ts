import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, like } from 'drizzle-orm';
import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import type { Database } from '../../../database/client';
import { DatabaseService } from '../../../database/database.service';
import { restrictedAccessLog, safetyClaimDocuments, safetyClaimLog, safetySettings, safetyTimelineEvents } from '../../../database/schema/accidents-v2';
import {
  safetyAccidents,
  safetyAccountingEntries,
  safetyClaimLines,
  safetyClaimPayments,
  safetyClaims,
  safetyDriverCharges,
  type SafetyAccidentRow,
  type SafetyClaimRow,
} from '../../../database/schema/safety';
import { AuditService, type AuditChange, type AuditEvent } from '../../people/audit.service';
import { SafetyCoreService } from '../safety-core.service';
import { claimRow, claimsSummary, hidden, listClaims } from './claims-views';
import { LEGACY_KIND, accidentInjured, legacyClaimView, legacyStageFor, tri, v2ClaimStatus } from './mapping';
import { AccidentsV2StateService, type CompanyState } from './state.service';
import * as V from './views';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Exec = Database | Tx;

/** Audit entity of a claim (the same one Claims v2 uses, so one trail per claim). */
const ENTITY = 'safety_claim';
const OTHER_PARTY = 'Other party’s insurer';
const TERMINAL = new Set<R.ClaimStatus>(['Settled', 'Denied', 'Closed']);
const MONEY_FIELDS = ['claimedCents', 'reserveCents', 'deductibleCents', 'settlementCents'] as const;

function forbidden(permission: string, detail: string): AppError {
  return new AppError({ status: 403, title: 'Forbidden', type: '/problems/forbidden', detail, extensions: { permission } });
}
function invalid(path: string, message: string): AppError {
  return new AppError({ status: 422, title: 'Unprocessable Entity', type: '/problems/validation', detail: message, extensions: { errors: [{ path, message }] } });
}
function conflict(row: { version: number; updatedAt: Date; number: string }): AppError {
  return new AppError({
    status: 409,
    title: 'Conflict',
    type: '/problems/version-conflict',
    detail: `${row.number} was changed by someone else at ${row.updatedAt.toISOString()}. Reload it and make your change again.`,
    extensions: { currentVersion: row.version },
  });
}
const isUniqueViolation = (e: unknown, name: string) =>
  new RegExp(name).test(String((e as { message?: string })?.message ?? '') + String((e as { constraint_name?: string })?.constraint_name ?? ''));

/**
 * Claims (Accident & Claims v2, phase P2): one claim per coverage line, many per accident, or standalone.
 *
 * A v2 claim is a `safety_claims` row, so the existing Claims v2 flows on that row — driver charge, driver notice,
 * Accounting approval of claim money — keep working unchanged (the legacy `kind` and `stage` are mirrored one way,
 * new → legacy). Claim money is only ever the claim's payments; every write is version-checked, audited once and
 * logged on the claim's timeline and its accident's.
 */
@Injectable()
export class ClaimsV2Service {
  constructor(
    private readonly database: DatabaseService,
    private readonly core: SafetyCoreService,
    private readonly audit: AuditService,
    private readonly state: AccidentsV2StateService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private viewer(p: Principal, st: CompanyState): V.ViewerContext {
    return { now: this.core.now().getTime(), canSeeRestricted: hasPermission(p, 'accidents.restricted'), settings: st.settings };
  }

  // ======================================================================================= reads

  async list(p: Principal, q: A.ClaimListQuery): Promise<A.ClaimListResponse> {
    const st = await this.state.load(p.companyId);
    return listClaims(st, q, this.viewer(p, st));
  }

  async summary(p: Principal): Promise<A.ClaimsSummaryResponse> {
    const st = await this.state.load(p.companyId);
    return claimsSummary(st, this.viewer(p, st));
  }

  async detail(p: Principal, id: string): Promise<A.ClaimDetailResponse> {
    const st = await this.state.load(p.companyId);
    const ctx = this.viewer(p, st);
    const k = R.byId(st.all.claims, id);
    const row = st.claimRows.get(id);
    if (!k || !row) throw this.core.notFound('That claim');
    const hide = hidden(k, ctx);
    const base = claimRow(st, k, ctx);
    const c = k.caseId ? R.byId(st.all.cases, k.caseId) : undefined;
    const [payments, entries, docs, charges] = await Promise.all([
      this.db.select().from(safetyClaimPayments).where(and(eq(safetyClaimPayments.companyId, p.companyId), eq(safetyClaimPayments.claimId, id))).orderBy(asc(safetyClaimPayments.createdAt)),
      this.db.select().from(safetyAccountingEntries).where(and(eq(safetyAccountingEntries.companyId, p.companyId), eq(safetyAccountingEntries.claimId, id))),
      this.db.select().from(safetyClaimDocuments).where(and(eq(safetyClaimDocuments.companyId, p.companyId), eq(safetyClaimDocuments.claimId, id))).orderBy(asc(safetyClaimDocuments.sort)),
      this.db
        .select({ id: safetyDriverCharges.id, number: safetyDriverCharges.number, state: safetyDriverCharges.state, amountCents: safetyDriverCharges.amountCents })
        .from(safetyDriverCharges)
        .where(and(eq(safetyDriverCharges.companyId, p.companyId), eq(safetyDriverCharges.claimId, id))),
    ]);
    const entryFor = (paymentId: string) => entries.find((e) => e.sourceKey === `payment:${paymentId}`)?.state as A.ClaimPaymentView['accounting'] | undefined;
    const tasks = st.all.tasks.filter((t) => t.claimId === id).map((t) => V.taskView(st, t, ctx.now));
    if (k.restricted && !hide) await this.accessLog(p, k, 'claim.detail');
    return {
      claim: {
        ...base,
        adjuster: hide ? null : k.adjuster ? { name: k.adjuster.name || null, phone: k.adjuster.phone || null, email: k.adjuster.email || null } : null,
        responsibleParty: hide ? null : (k.responsibleParty ?? null),
        unitLabel: k.unitLabel ?? null,
        load: row.loadId ? { id: row.loadId, number: row.loadNumber ?? '' } : null,
        reportedToInsurerAt: k.reportedToInsurerAt ?? null,
        deductibleCents: hide ? null : (k.deductibleCents ?? null),
        settlementCents: hide ? null : (k.settlementCents ?? null),
        disputed: Boolean(k.disputed),
        whatWasLost: row.whatWasLost,
        closedAt: k.closedAt ?? null,
        restrictedReason: hide ? null : row.restrictedReason,
      },
      version: row.version,
      money: hide ? null : R.claimMoney(k),
      payments: hide
        ? null
        : payments.map((x) => ({
            id: x.id,
            direction: (x.direction ?? 'to_us') as A.PaymentDirection,
            amountCents: x.amountCents,
            party: x.party ?? '',
            paidAt: (x.paidAt ?? new Date(`${x.receivedOn}T12:00:00Z`)).toISOString(),
            note: x.note,
            recordedBy: x.createdBy,
            voided: x.voidedAt ? { at: x.voidedAt.toISOString(), by: x.voidedBy, reason: x.voidReason } : null,
            accounting: entryFor(x.id) ?? null,
          })),
      documents: docs.map((d) => ({ id: d.id, label: d.label, received: d.received, receivedAt: d.receivedAt?.toISOString() ?? null, version: d.version })),
      log: hide ? null : k.log,
      accident: c
        ? {
            id: c.id,
            number: c.number,
            stage: c.stage,
            occurredAt: c.occurredAt,
            tz: c.tz,
            truckUnit: R.truckOf(st.all, c)?.unit ?? null,
            driverName: R.driverOf(st.all, c)?.name ?? null,
            claims: R.caseClaims(st.all, c).map((x) => ({ id: x.id, number: x.number, type: x.type, status: x.status })),
          }
        : null,
      tasks,
      legacy: { stage: row.stage, liabilityParty: row.liabilityParty, driverCharge: charges[0] ?? null },
      redacted: base.redacted,
      permissions: { edit: hasPermission(p, 'accidents.edit'), money: hasPermission(p, 'accidents.claim_money'), restricted: hasPermission(p, 'accidents.restricted') },
    };
  }

  // ===================================================================================== create

  private async settings(companyId: string): Promise<{ insurers: Partial<Record<R.ClaimType, string>>; rules: Partial<R.SafetyRuleSettings>; claimsAssignee: { id: string; name: string } | null }> {
    const rows = await this.db.select().from(safetySettings).where(eq(safetySettings.companyId, companyId));
    const insurers = (rows.find((r) => r.key === 'claim_insurers')?.value ?? {}) as Partial<Record<R.ClaimType, string>>;
    const rules = (rows.find((r) => r.key === 'rules')?.value ?? {}) as Partial<R.SafetyRuleSettings>;
    const dept = (rows.find((r) => r.key === 'dept_default_assignee')?.value ?? {}) as Partial<Record<R.Dept, { id: string; name: string }>>;
    return { insurers, rules, claimsAssignee: dept.Claims ?? null };
  }

  private async event(tx: Exec, p: Principal, e: { claimId: string; accidentId: string | null; text: string; kind: 'milestone' | 'change' | 'note' | 'task'; at: Date; restricted?: boolean; source?: R.EventSource }) {
    await tx.insert(safetyTimelineEvents).values({
      id: this.core.newId('evt'),
      companyId: p.companyId,
      accidentId: e.accidentId,
      claimId: e.claimId,
      occurredAt: e.at,
      loggedAt: e.at,
      actorId: p.userId,
      actorName: this.core.actor(p),
      source: e.source ?? 'Claims',
      kind: e.kind,
      text: e.text,
      restricted: e.restricted ?? false,
    });
  }

  private async log(tx: Exec, p: Principal, claimId: string, channel: (typeof A.CLAIM_LOG_CHANNELS)[number], text: string, at: Date) {
    await tx.insert(safetyClaimLog).values({ id: this.core.newId('clg'), companyId: p.companyId, claimId, at, byId: p.userId, byName: this.core.actor(p), channel, text });
  }

  /** A permitted read of a restricted claim is logged (SPEC §8.3); a redacted read shows nothing and logs nothing. */
  private async accessLog(p: Principal, k: R.Claim, resource: string): Promise<void> {
    await this.db.insert(restrictedAccessLog).values({ id: this.core.newId('ral'), companyId: p.companyId, at: this.core.now(), actorId: p.userId, actorName: this.core.actor(p), accidentId: k.caseId ?? null, claimId: k.id, resource });
  }

  /** POST /claims-v2 — one claim per coverage line, in one transaction (SPEC §1.5 New claim dialog). */
  async create(p: Principal, input: A.CreateClaimsInput, idempotencyKey?: string): Promise<A.CreateClaimsResponse> {
    if (idempotencyKey) {
      const again = await this.byIdempotencyKey(p.companyId, idempotencyKey);
      if (again) return again;
    }
    const types = input.lines.map((l) => l.type);
    if (new Set(types).size !== types.length) throw invalid('lines', 'Each coverage appears once — every coverage becomes its own claim');
    let accident: SafetyAccidentRow | null = null;
    if (input.accidentId) {
      const [row] = await this.db
        .select()
        .from(safetyAccidents)
        .where(and(eq(safetyAccidents.companyId, p.companyId), eq(safetyAccidents.id, input.accidentId)))
        .limit(1);
      if (!row || row.voidedAt) throw this.core.notFound('That accident');
      if (row.stage === 'draft') throw this.core.refused(`${row.number} is a draft; submit it before opening claims`);
      accident = row;
    } else if (!input.title?.trim()) {
      throw invalid('title', 'Describe what was lost');
    }
    const canMoney = hasPermission(p, 'accidents.claim_money');
    const canRestricted = hasPermission(p, 'accidents.restricted');
    const set = await this.settings(p.companyId);
    // Existing open claims of the same coverage on this accident (G2): refused unless the caller confirms.
    if (accident && !input.confirmDuplicate) {
      const st = await this.state.load(p.companyId);
      const existing = st.all.claims.filter((k) => k.caseId === accident!.id && R.OPEN_CLAIM(k.status) && types.includes(k.type));
      if (existing.length) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          type: '/problems/duplicate-claim-type',
          detail: `An open claim of this type already exists on ${accident.number}: ${existing.map((k) => `${k.number} (${R.CLAIM_TYPE_LABEL[k.type]})`).join(', ')}. Confirm to open another.`,
          extensions: { existing: existing.map((k) => ({ id: k.id, number: k.number, type: k.type, status: k.status })) },
        });
      }
    }
    const injured = accident ? tri(accident.injuriesStatus) === 'yes' : false;
    const plan = input.lines.map((l) => {
      const fallback = l.type === 'workers_comp' || (l.type === 'auto_liability' && injured);
      const restricted = l.restricted ?? fallback;
      if (l.type === 'workers_comp' && !restricted) throw invalid('lines', "A workers' comp claim is always restricted");
      if (restricted !== fallback) {
        if (!canRestricted) throw forbidden('accidents.restricted', 'Changing whether a claim is restricted is for Safety Managers and the owner');
        if (!input.restrictedReason?.trim()) throw invalid('restrictedReason', 'Say why this claim is (not) restricted');
      }
      const explicitMoney = l.claimedCents != null || l.reserveCents != null || l.deductibleCents != null;
      if (explicitMoney && !canMoney) throw forbidden('accidents.claim_money', 'Claim amounts are entered by Claims, Accounting or a Safety Manager');
      const deductible = l.type === 'recovery' ? (l.deductibleCents ?? null) : (l.deductibleCents ?? R.defaultDeductibleCents(l.type, set.rules) ?? null);
      const insurer = l.insurer?.trim() || set.insurers[l.type] || (l.type === 'recovery' ? OTHER_PARTY : null);
      return { line: l, restricted, restrictedChanged: restricted !== fallback, deductible, insurer };
    });
    const at = this.core.now();
    const owner = { id: p.userId, name: this.core.actor(p) };
    const followUp = set.claimsAssignee ?? owner;
    const created: A.CreateClaimsResponse['created'] = [];
    const audits: AuditEvent[] = [];
    try {
      await this.db.transaction(async (tx) => {
        for (const [i, x] of plan.entries()) {
          const type = x.line.type;
          const id = this.core.newId('clm');
          const number = await this.core.nextNumber(p.companyId, 'claim');
          const title = input.title?.trim() || (accident ? `${R.CLAIM_TYPE_LABEL[type]} — ${accident.number}` : input.standaloneKind || R.CLAIM_TYPE_LABEL[type]);
          const load = input.loadId ? await this.core.load(p.companyId, input.loadId) : accident?.loadId ? { id: accident.loadId, number: accident.loadNumber ?? '' } : null;
          await tx.insert(safetyClaims).values({
            id,
            companyId: p.companyId,
            number,
            ownerId: owner.id,
            ownerName: owner.name,
            nextAction: A.FIRST_FOLLOW_UP,
            nextActionDueOn: this.core.dueIn(3),
            isTest: input.isTest ?? accident?.isTest ?? false,
            createdBy: owner.name,
            createdAt: at,
            updatedAt: at,
            kind: LEGACY_KIND[type],
            accidentId: accident?.id ?? null,
            accidentNumber: accident?.number ?? null,
            loadId: load?.id ?? null,
            loadNumber: load?.number ?? null,
            driverId: accident?.driverId ?? null,
            driverName: accident?.driverName ?? null,
            truckId: accident?.truckId ?? null,
            truckNumber: accident?.truckNumber ?? null,
            description: input.whatWasLost?.trim() || title,
            insurer: x.insurer,
            openedOn: this.core.today(),
            claimedCents: x.line.claimedCents ?? null,
            deductibleCents: x.deductible,
            stage: 'opened',
            lastActivityAt: at,
            claimType: type,
            status: 'Open',
            title,
            standaloneKind: accident ? null : (input.standaloneKind ?? null),
            whatWasLost: input.whatWasLost?.trim() || null,
            claimant: x.line.claimant?.trim() || null,
            unitLabel: input.unitLabel?.trim() || (accident ? [accident.truckNumber ? `Truck ${accident.truckNumber}` : null, accident.trailerNumber ? `Trailer ${accident.trailerNumber}` : null].filter(Boolean).join(' · ') || null : null),
            openedAt: at,
            reportedToInsurerAt: null,
            reserveCents: x.line.reserveCents ?? null,
            restricted: x.restricted,
            restrictedReason: x.restrictedChanged ? (input.restrictedReason?.trim() ?? null) : null,
            nextFollowUpAt: new Date(at.getTime() + 72 * R.HOUR),
            nextFollowUpAssigneeId: followUp.id,
            nextFollowUpAssigneeName: followUp.name,
            nextFollowUpWhat: A.FIRST_FOLLOW_UP,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}:${i}` : null,
          });
          const docs = A.CLAIM_DEFAULT_DOCS[type];
          if (docs.length)
            await tx.insert(safetyClaimDocuments).values(docs.map((label, sort) => ({ id: this.core.newId('cdc'), companyId: p.companyId, claimId: id, label, sort, createdAt: at })));
          await this.log(tx, p, id, 'Note', `Claim opened${accident ? ` from ${accident.number}` : ''}.`, at);
          const money = x.line.claimedCents ? `, ${R.money(x.line.claimedCents)} claimed` : '';
          await this.event(tx, p, { claimId: id, accidentId: accident?.id ?? null, text: `${number} opened — ${R.CLAIM_TYPE_LABEL[type]}${x.restricted ? '' : money}`, kind: 'milestone', at });
          audits.push(
            await this.audit.writeIn(tx, p, {
              action: 'claim_opened',
              entityType: ENTITY,
              entityId: id,
              entityLabel: number,
              summary: `${R.CLAIM_TYPE_LABEL[type]} claim opened${accident ? ` from ${accident.number}` : ' (standalone)'}${x.restricted ? ' — restricted' : ''}`,
              changes: [
                { field: 'claimType', old: null, new: type },
                { field: 'restricted', old: null, new: String(x.restricted) },
              ],
              reason: x.restrictedChanged ? (input.restrictedReason ?? null) : null,
              at,
            }),
          );
          created.push({ id, number, type, restricted: x.restricted });
        }
        if (accident) {
          await tx.update(safetyAccidents).set({ updatedAt: at, version: accident.version + 1 }).where(and(eq(safetyAccidents.id, accident.id), eq(safetyAccidents.version, accident.version)));
        }
      });
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'safety_claims_idempotency_key')) {
        const again = await this.byIdempotencyKey(p.companyId, idempotencyKey);
        if (again) return again;
      }
      if (isUniqueViolation(error, 'safety_claims_accident_key')) {
        // Before cutover the legacy one-claim-per-accident index still holds (IMPLEMENTATION-PLAN P2 report).
        throw new AppError({
          status: 409,
          title: 'Conflict',
          type: '/problems/cutover-required',
          detail: `${accident?.number ?? 'This accident'} already has a claim, and this database still allows only one claim per accident. The Accident & Claims v2 cutover (runbook step C1) lifts that limit.`,
        });
      }
      throw error;
    }
    await this.audit.publish(...audits);
    return { created, accidentId: accident?.id ?? null };
  }

  private async byIdempotencyKey(companyId: string, key: string): Promise<A.CreateClaimsResponse | null> {
    const rows = await this.db
      .select({ id: safetyClaims.id, number: safetyClaims.number, type: safetyClaims.claimType, restricted: safetyClaims.restricted, accidentId: safetyClaims.accidentId, key: safetyClaims.idempotencyKey })
      .from(safetyClaims)
      .where(and(eq(safetyClaims.companyId, companyId), like(safetyClaims.idempotencyKey, `${key.replace(/[%_]/g, '')}:%`)));
    if (!rows.length) return null;
    rows.sort((a, b) => Number(a.key?.split(':').pop()) - Number(b.key?.split(':').pop()));
    return { created: rows.map((r) => ({ id: r.id, number: r.number, type: r.type as R.ClaimType, restricted: r.restricted })), accidentId: rows[0]?.accidentId ?? null };
  }

  // ===================================================================================== writes

  /** The v2 values a legacy claim (no claim_type) is read with, to store on its first v2 write; null for a v2 claim. */
  private async legacyAdoption(tx: Tx, row: SafetyClaimRow): Promise<Pick<SafetyClaimRow, 'claimType' | 'restricted' | 'reserveCents' | 'insurer' | 'status'> | null> {
    if (row.claimType) return null;
    const [line] = await tx
      .select()
      .from(safetyClaimLines)
      .where(and(eq(safetyClaimLines.companyId, row.companyId), eq(safetyClaimLines.claimId, row.id), isNull(safetyClaimLines.voidedAt)))
      .orderBy(asc(safetyClaimLines.createdAt), asc(safetyClaimLines.id))
      .limit(1);
    const [acc] = row.accidentId ? await tx.select().from(safetyAccidents).where(and(eq(safetyAccidents.companyId, row.companyId), eq(safetyAccidents.id, row.accidentId))).limit(1) : [];
    const v = legacyClaimView(row, line, Boolean(acc && accidentInjured(acc)));
    return v ? { ...v, status: v2ClaimStatus(row) } : null;
  }

  /** Restricted claim details (money, payments, parties, correspondence) are written only by accidents.restricted holders. */
  private guardRestricted(p: Principal, row: SafetyClaimRow, touchesRestricted: boolean): void {
    if (row.restricted && touchesRestricted && !hasPermission(p, 'accidents.restricted'))
      throw forbidden('accidents.restricted', `${row.number} is restricted; its details are handled by Safety Managers and the owner`);
  }

  /**
   * One version-checked write to a claim: the claim row (bumped, lastActivityAt), one audit entry, timeline events
   * on the claim and its accident — in one transaction. `mutate` returns the column patch plus what to log.
   */
  private async write(
    p: Principal,
    id: string,
    version: number,
    action: string,
    mutate: (row: SafetyClaimRow, tx: Tx, at: Date) => Promise<{ patch: Partial<typeof safetyClaims.$inferInsert>; summary: string; event?: string; eventKind?: 'milestone' | 'change' | 'note'; restrictedEvent?: boolean; reason?: string | null; changes?: AuditChange[]; source?: R.EventSource }>,
  ): Promise<{ id: string; version: number }> {
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    const out = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(safetyClaims)
        .where(and(eq(safetyClaims.companyId, p.companyId), eq(safetyClaims.id, id)))
        .for('update')
        .limit(1);
      if (!row || row.voidedAt) throw this.core.notFound('That claim');
      if (row.version !== version) throw conflict(row);
      // A claim written before v2 is stored in the v2 vocabulary on its first v2 write — exactly what the screens already
      // showed (legacyClaimView), so the restricted guard and every later read agree. Audited with the write below.
      const adopt = await this.legacyAdoption(tx, row);
      const m = await mutate(adopt ? { ...row, ...adopt } : row, tx, at);
      const next = row.version + 1;
      const updated = await tx
        .update(safetyClaims)
        .set({ ...(adopt ?? {}), ...m.patch, version: next, updatedAt: at, lastActivityAt: at })
        .where(and(eq(safetyClaims.id, id), eq(safetyClaims.version, row.version)))
        .returning({ id: safetyClaims.id });
      if (!updated.length) throw conflict(row);
      if (m.event) await this.event(tx, p, { claimId: id, accidentId: m.patch.accidentId ?? row.accidentId, text: m.event, kind: m.eventKind ?? 'change', at, restricted: m.restrictedEvent ?? false, ...(m.source ? { source: m.source } : {}) });
      const changes: AuditChange[] = m.changes ?? [];
      if (m.changes && adopt) changes.push({ field: 'claimType', old: null, new: adopt.claimType }, { field: 'restricted', old: String(row.restricted), new: String(adopt.restricted) });
      if (!m.changes) {
        for (const [field, value] of Object.entries({ ...(adopt ?? {}), ...m.patch })) {
          const before = (row as Record<string, unknown>)[field];
          const a = before instanceof Date ? before.toISOString() : before === null || before === undefined ? null : String(before);
          const b = value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value);
          if (a !== b) changes.push({ field, old: a, new: b });
        }
      }
      audits.push(await this.audit.writeIn(tx, p, { action, entityType: ENTITY, entityId: id, entityLabel: row.number, summary: m.summary, changes, reason: m.reason ?? null, at }));
      return { id, version: next };
    });
    await this.audit.publish(...audits);
    return out;
  }

  /** PATCH /claims-v2/:id — status, parties, follow-up; money with accidents.claim_money; restricted with accidents.restricted + reason. */
  async patch(p: Principal, id: string, input: A.PatchClaimInput): Promise<{ id: string; version: number }> {
    const moneyTouched = MONEY_FIELDS.some((f) => input[f] !== undefined);
    if (!hasPermission(p, 'accidents.edit')) {
      const other = Object.keys(input).filter((k) => input[k as keyof A.PatchClaimInput] !== undefined && !['version', 'note', ...MONEY_FIELDS].includes(k));
      if (other.length) throw forbidden('accidents.edit', `With your access only the claim amounts can be changed (not: ${other.join(', ')})`);
    }
    if (moneyTouched && !hasPermission(p, 'accidents.claim_money')) throw forbidden('accidents.claim_money', 'Claim amounts are changed by Claims, Accounting or a Safety Manager');
    if (input.restricted !== undefined) {
      if (!hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'Changing whether a claim is restricted is for Safety Managers and the owner');
      if (!input.restrictedReason?.trim()) throw invalid('restrictedReason', 'Say why');
    }
    const owner = input.ownerId ? await this.core.person(p.companyId, input.ownerId) : null;
    const fuPerson = input.nextFollowUp ? await this.core.person(p.companyId, input.nextFollowUp.assigneeId) : null;
    return this.write(p, id, input.version, input.status ? 'claim_status_changed' : 'claim_updated', async (row, tx, at) => {
      this.guardRestricted(p, row, moneyTouched || input.claimant !== undefined || input.responsibleParty !== undefined || input.adjusterName !== undefined || input.adjusterPhone !== undefined || input.adjusterEmail !== undefined);
      const patch: Partial<typeof safetyClaims.$inferInsert> = {};
      const words: string[] = [];
      const status = (row.status ?? 'Open') as R.ClaimStatus;
      if (input.status && input.status !== status) {
        patch.status = input.status;
        patch.stage = legacyStageFor(input.status, row.stage);
        if (TERMINAL.has(input.status)) Object.assign(patch, { closedAt: at, closedBy: this.core.actor(p) });
        else if (TERMINAL.has(status)) Object.assign(patch, { closedAt: null, closedBy: null });
        words.push(`Status: ${status} → ${input.status}`);
      }
      if (input.title !== undefined) patch.title = input.title;
      if (input.insurer !== undefined) patch.insurer = input.insurer;
      if (input.insurerClaimNo !== undefined) {
        patch.insurerReference = input.insurerClaimNo;
        words.push(`Insurer claim # ${input.insurerClaimNo ?? 'cleared'}`);
      }
      if (input.adjusterName !== undefined) patch.adjusterName = input.adjusterName;
      if (input.adjusterPhone !== undefined) patch.adjusterPhone = input.adjusterPhone;
      if (input.adjusterEmail !== undefined) patch.adjusterEmail = input.adjusterEmail;
      if (input.adjusterName !== undefined || input.adjusterPhone !== undefined || input.adjusterEmail !== undefined) words.push('Adjuster updated');
      if (input.claimant !== undefined) patch.claimant = input.claimant;
      if (input.responsibleParty !== undefined) patch.responsibleParty = input.responsibleParty;
      if (input.reportedToInsurerAt !== undefined) patch.reportedToInsurerAt = input.reportedToInsurerAt ? new Date(input.reportedToInsurerAt) : null;
      if (owner) Object.assign(patch, { ownerId: owner.id, ownerName: owner.name });
      if (input.disputed !== undefined) patch.disputed = input.disputed;
      for (const f of MONEY_FIELDS) {
        if (input[f] === undefined) continue;
        (patch as Record<string, unknown>)[f] = input[f];
      }
      if (moneyTouched && row.restricted) words.push('Restricted amounts updated');
      else if (moneyTouched) words.push(`Amounts updated (claimed ${R.money(input.claimedCents ?? row.claimedCents)}, reserve ${R.money(input.reserveCents ?? row.reserveCents)})`);
      if (input.nextFollowUp !== undefined) {
        Object.assign(
          patch,
          input.nextFollowUp
            ? { nextFollowUpAt: new Date(input.nextFollowUp.at), nextFollowUpWhat: input.nextFollowUp.what, nextFollowUpAssigneeId: fuPerson?.id ?? null, nextFollowUpAssigneeName: fuPerson?.name ?? null, nextAction: input.nextFollowUp.what }
            : { nextFollowUpAt: null, nextFollowUpWhat: null, nextFollowUpAssigneeId: null, nextFollowUpAssigneeName: null },
        );
        words.push(input.nextFollowUp ? `Next follow-up: ${input.nextFollowUp.what}` : 'Follow-up cleared');
      }
      if (input.restricted !== undefined && input.restricted !== row.restricted) {
        if (!input.restricted && row.claimType === 'workers_comp') throw invalid('restricted', "A workers' comp claim is always restricted");
        Object.assign(patch, { restricted: input.restricted, restrictedReason: input.restrictedReason ?? null });
        words.push(input.restricted ? 'Marked restricted' : 'Restriction removed');
      }
      const text = words.join('; ') || 'Claim updated';
      // The correspondence log carries what changed, like the prototype's notes; money stays out of it on a restricted claim.
      await this.log(tx, p, id, 'Note', input.note?.trim() ? `${text} — ${input.note.trim()}` : text, at);
      const moneyOnRestricted = row.restricted && moneyTouched;
      return {
        patch,
        summary: text,
        event: `${row.number}: ${moneyOnRestricted ? 'restricted amounts updated' : text}`,
        eventKind: input.status ? 'milestone' : 'change',
        restrictedEvent: moneyOnRestricted || (input.restricted !== undefined),
        reason: input.restrictedReason ?? input.note ?? null,
      };
    });
  }

  /** POST /claims-v2/:id/payments — the one source of claim money; Accounting reviews it (existing approval flow). */
  async recordPayment(p: Principal, id: string, input: A.ClaimPaymentInput): Promise<{ id: string; version: number; paymentId: string }> {
    if (!hasPermission(p, 'accidents.claim_money')) throw forbidden('accidents.claim_money', 'Payments are recorded by Claims, Accounting or a Safety Manager');
    const paidAt = input.paidAt ? new Date(input.paidAt) : this.core.now();
    if (paidAt.getTime() > this.core.now().getTime() + 5 * 60_000) throw invalid('paidAt', 'A payment cannot be in the future');
    const paymentId = this.core.newId('scp');
    const out = await this.write(p, id, input.version, 'claim_payment_recorded', async (row, tx, at) => {
      this.guardRestricted(p, row, true);
      if (row.status === 'Denied') throw this.core.refused('The insurer denied this claim; there is no payment to record');
      await tx.insert(safetyClaimPayments).values({
        id: paymentId,
        companyId: p.companyId,
        claimId: id,
        receivedOn: R.isoToLocalInput(paidAt.toISOString(), R.EASTERN).slice(0, 10),
        amountCents: input.amountCents,
        note: input.note ?? null,
        createdBy: this.core.actor(p),
        createdAt: at,
        direction: input.direction,
        party: input.party,
        paidAt,
      });
      const verb =
        input.direction === 'to_us'
          ? `Payment received ${R.money(input.amountCents)} from ${input.party}`
          : input.direction === 'by_us'
            ? `We paid ${R.money(input.amountCents)}${input.note ? ` (${input.note})` : ''}`
            : `${input.party} paid the claimant ${R.money(input.amountCents)}`;
      await this.log(tx, p, id, 'Note', verb, at);
      // Money we receive or pay goes to Accounting to confirm (review before post); insurer-to-claimant is not our cash.
      const kind = input.direction === 'to_us' ? 'insurer_payment_received' : input.direction === 'by_us' ? 'company_deductible' : null;
      if (kind)
        await tx
          .insert(safetyAccountingEntries)
          .values({ id: this.core.newId('sae'), companyId: p.companyId, claimId: id, claimNumber: row.number, kind, amountCents: input.amountCents, sourceKey: `payment:${paymentId}`, memo: `${row.number}: ${verb}`, createdAt: at, updatedAt: at })
          .onConflictDoNothing();
      return {
        patch: {},
        summary: row.restricted ? 'Payment recorded (restricted claim)' : verb,
        event: `${row.number}: ${row.restricted ? 'payment recorded (restricted)' : verb}`,
        eventKind: 'milestone',
        restrictedEvent: row.restricted,
        source: input.direction === 'by_insurer_to_claimant' ? 'Claims' : 'Accounting',
        changes: [{ field: 'payments', old: null, new: paymentId }],
      };
    });
    return { ...out, paymentId };
  }

  /** Payments are never deleted: a void keeps the row with who, when and why; a pending Accounting entry is withdrawn. */
  async voidPayment(p: Principal, id: string, paymentId: string, input: A.VoidClaimPaymentInput): Promise<{ id: string; version: number }> {
    if (!hasPermission(p, 'accidents.claim_money')) throw forbidden('accidents.claim_money', 'Payments are voided by Claims, Accounting or a Safety Manager');
    return this.write(p, id, input.version, 'claim_payment_voided', async (row, tx, at) => {
      this.guardRestricted(p, row, true);
      const [pay] = await tx
        .select()
        .from(safetyClaimPayments)
        .where(and(eq(safetyClaimPayments.companyId, p.companyId), eq(safetyClaimPayments.claimId, id), eq(safetyClaimPayments.id, paymentId)))
        .limit(1);
      if (!pay) throw this.core.notFound('That payment');
      if (pay.voidedAt) throw this.core.refused('That payment is already void');
      await tx.update(safetyClaimPayments).set({ voidedAt: at, voidedBy: this.core.actor(p), voidReason: input.reason }).where(eq(safetyClaimPayments.id, paymentId));
      await tx
        .update(safetyAccountingEntries)
        .set({ state: 'superseded', reviewNote: 'Payment voided before Accounting reviewed it', updatedAt: at })
        .where(and(eq(safetyAccountingEntries.companyId, p.companyId), eq(safetyAccountingEntries.sourceKey, `payment:${paymentId}`), eq(safetyAccountingEntries.state, 'pending_review')));
      const text = `Payment of ${R.money(pay.amountCents)} voided — ${input.reason}`;
      await this.log(tx, p, id, 'Note', text, at);
      return { patch: {}, summary: row.restricted ? 'Payment voided (restricted claim)' : text, event: `${row.number}: ${row.restricted ? 'payment voided (restricted)' : text}`, restrictedEvent: row.restricted, reason: input.reason, changes: [{ field: 'payments', old: paymentId, new: null }] };
    });
  }

  async document(p: Principal, id: string, docId: string, input: A.ClaimDocumentInput): Promise<{ id: string; version: number }> {
    return this.write(p, id, input.version, 'claim_document_checked', async (row, tx, at) => {
      const [doc] = await tx
        .select()
        .from(safetyClaimDocuments)
        .where(and(eq(safetyClaimDocuments.companyId, p.companyId), eq(safetyClaimDocuments.claimId, id), eq(safetyClaimDocuments.id, docId)))
        .limit(1);
      if (!doc) throw this.core.notFound('That document on the checklist');
      await tx
        .update(safetyClaimDocuments)
        .set({ received: input.received, receivedAt: input.received ? at : null, receivedBy: input.received ? this.core.actor(p) : null, version: doc.version + 1 })
        .where(eq(safetyClaimDocuments.id, docId));
      const text = `${doc.label}: ${input.received ? 'received' : 'marked missing'}`;
      await this.log(tx, p, id, 'Note', text, at);
      return { patch: {}, summary: text, event: `${row.number}: ${text}`, changes: [{ field: `documents.${doc.label}`, old: String(doc.received), new: String(input.received) }] };
    });
  }

  async addLog(p: Principal, id: string, input: A.ClaimLogInput): Promise<{ id: string; version: number }> {
    return this.write(p, id, input.version, 'claim_correspondence_logged', async (row, tx, at) => {
      this.guardRestricted(p, row, true);
      await this.log(tx, p, id, input.channel, input.text, at);
      return { patch: {}, summary: `${input.channel}: ${row.restricted ? '(restricted)' : input.text}`, event: `${row.number}: ${input.channel} — ${input.text}`, eventKind: 'note', restrictedEvent: row.restricted, changes: [] };
    });
  }

  /** A standalone claim found to belong to an accident (G3). */
  async linkAccident(p: Principal, id: string, input: A.LinkAccidentInput): Promise<{ id: string; version: number }> {
    const [acc] = await this.db
      .select()
      .from(safetyAccidents)
      .where(and(eq(safetyAccidents.companyId, p.companyId), eq(safetyAccidents.id, input.accidentId)))
      .limit(1);
    if (!acc || acc.voidedAt) throw this.core.notFound('That accident');
    if (acc.stage === 'draft') throw this.core.refused(`${acc.number} is a draft`);
    try {
      return await this.write(p, id, input.version, 'claim_linked_to_accident', async (row) => {
        if (row.accidentId) throw this.core.refused(`${row.number} is already linked to ${row.accidentNumber}`);
        return {
          patch: { accidentId: acc.id, accidentNumber: acc.number, standaloneKind: null, driverId: row.driverId ?? acc.driverId, driverName: row.driverName ?? acc.driverName, truckId: row.truckId ?? acc.truckId, truckNumber: row.truckNumber ?? acc.truckNumber },
          summary: `Linked to ${acc.number}`,
          event: `${row.number} linked to ${acc.number}`,
          eventKind: 'milestone',
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'safety_claims_accident_key'))
        throw new AppError({ status: 409, title: 'Conflict', type: '/problems/cutover-required', detail: `${acc.number} already has a claim, and this database still allows only one claim per accident (cutover step C1).` });
      throw error;
    }
  }
}
