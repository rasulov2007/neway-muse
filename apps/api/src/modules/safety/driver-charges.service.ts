import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  CLAIM_CHARGE_POLICY,
  DRIVER_CHARGE_BASIS_LABEL,
  DRIVER_CHARGE_STATE_LABEL,
  DRIVER_RESPONSE_LABEL,
  NOTIFY_METHOD_LABEL,
  REJECT_REASON_LABEL,
  driverKindOf,
  installmentCapFor,
  installmentsFor,
  isActiveCharge,
  policyCentsFor,
  type ApplyDriverChargeInput,
  type ApproveDriverChargeInput,
  type ChangeRequestInput,
  type DisputeDriverChargeInput,
  type DriverCharge,
  type DriverChargeHistoryEntry,
  type DriverChargePaymentInput,
  type DriverChargeReasonInput,
  type DriverChargeState,
  type NotifyDriverInput,
  type RejectDriverChargeInput,
  type ResolveDriverChargeInput,
  type SafetyClaim,
  type VersionOnlyChargeInput,
} from '@neway/shared';
import type { DriverTx } from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { drivers } from '../../database/schema';
import {
  safetyAccountingEntries,
  safetyClaims,
  safetyCounters,
  safetyDriverCharges,
  type SafetyClaimRow,
  type SafetyDriverChargeRow,
} from '../../database/schema/safety';
import { DriverAccountsService } from '../accounting/driver-accounts.service';
import { SafetyCoreService } from './safety-core.service';

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DAY = 86_400_000;

/**
 * Driver charges on claims (Claims v2 phase 1, owner brief 2026-10-13).
 *
 * The workflow is this table: Safety applies the deductible, records how the driver was told,
 * sends it to Accounting; Accounting approves against a checklist the server enforces; disputes,
 * waivers and amounts outside policy wait for Management. The money is Accounting's own driver
 * transaction, created on approval and recovered by the settlement engine, so a charge can never
 * be deducted from two places. Every transition is versioned and lands on the claim's timeline.
 */
@Injectable()
export class DriverChargesService {
  constructor(
    private readonly core: SafetyCoreService,
    private readonly accounts: DriverAccountsService,
  ) {}

  private get db() {
    return this.core.db;
  }

  // ------------------------------------------------------------------------------------- reads

  async list(principal: Principal, query: { claimId?: string; driverId?: string } = {}): Promise<DriverCharge[]> {
    const parts = [eq(safetyDriverCharges.companyId, principal.companyId)];
    if (query.claimId) parts.push(eq(safetyDriverCharges.claimId, query.claimId));
    if (query.driverId) parts.push(eq(safetyDriverCharges.driverId, query.driverId));
    const rows = await this.db.select().from(safetyDriverCharges).where(and(...parts)).orderBy(desc(safetyDriverCharges.createdAt));
    return this.views(principal, rows);
  }

  async get(principal: Principal, id: string): Promise<DriverCharge> {
    const [view] = await this.views(principal, [await this.row(principal.companyId, id)]);
    return view as DriverCharge;
  }

  /** One summary per claim for the list and the claim view: the live charge, or the last one. */
  async summaries(principal: Principal, claimIds: string[]): Promise<Map<string, SafetyClaim['driverCharge']>> {
    const out = new Map<string, SafetyClaim['driverCharge']>();
    if (claimIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(safetyDriverCharges)
      .where(and(eq(safetyDriverCharges.companyId, principal.companyId), inArray(safetyDriverCharges.claimId, claimIds)))
      .orderBy(desc(safetyDriverCharges.createdAt));
    const views = await this.views(principal, rows);
    for (const v of views) {
      if (!v.claimId) continue;
      const current = out.get(v.claimId);
      if (!current || (isActiveCharge(v.state) && !isActiveCharge(current.state))) {
        out.set(v.claimId, { id: v.id, number: v.number, state: v.state, amountCents: v.amountCents, recoveredCents: v.recoveredCents, driverName: v.driverName, ageDays: v.ageDays });
      }
    }
    return out;
  }

  private async row(companyId: string, id: string): Promise<SafetyDriverChargeRow> {
    const [row] = await this.db
      .select()
      .from(safetyDriverCharges)
      .where(and(eq(safetyDriverCharges.companyId, companyId), eq(safetyDriverCharges.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That driver charge');
    return row;
  }

  /**
   * Rows with their money read from Accounting. Approved charges move to Recovering and Recovered
   * from what settlements actually took - never typed in - and the stored state follows.
   */
  private async views(principal: Principal, rows: SafetyDriverChargeRow[]): Promise<DriverCharge[]> {
    const out: DriverCharge[] = [];
    for (const row of rows) {
      let tx: DriverTx | null = null;
      if (row.driverTxId) {
        try {
          tx = await this.accounts.transaction(principal, row.driverTxId);
        } catch {
          tx = null;
        }
      }
      let state = row.state as DriverChargeState;
      const recovered = tx ? tx.recoveredCents : 0;
      if ((state === 'approved' || state === 'recovering') && tx) {
        const next: DriverChargeState = recovered >= row.amountCents ? 'recovered' : recovered > 0 ? 'recovering' : 'approved';
        if (next !== state) {
          await this.db
            .update(safetyDriverCharges)
            .set({ state: next, stateChangedAt: this.core.now(), history: [...(row.history as DriverChargeHistoryEntry[]), { at: this.core.now().toISOString(), by: 'Settlements', action: next === 'recovered' ? 'recovered' : 'recovering', from: state, to: next, note: `${dollars(recovered)} of ${dollars(row.amountCents)} recovered` }], updatedAt: this.core.now() })
            .where(eq(safetyDriverCharges.id, row.id));
          state = next;
        }
      }
      out.push(this.toView(row, state, tx));
    }
    return out;
  }

  private toView(row: SafetyDriverChargeRow, state: DriverChargeState, tx: DriverTx | null): DriverCharge {
    const recovered = tx ? tx.recoveredCents : 0;
    return {
      id: row.id,
      number: row.number,
      claimId: row.claimId,
      claimNumber: row.claimNumber,
      driverId: row.driverId,
      driverName: row.driverName,
      driverKind: row.driverKind === 'owner_operator' ? 'owner_operator' : 'company',
      basis: row.basis as DriverCharge['basis'],
      policyCents: row.policyCents,
      amountCents: row.amountCents,
      adjustReason: row.adjustReason,
      state,
      stateBeforeHold: (row.stateBeforeHold as DriverChargeState | null) ?? null,
      notifiedOn: row.notifiedOn ? String(row.notifiedOn) : null,
      notifiedBy: row.notifiedBy,
      notifyMethod: (row.notifyMethod as DriverCharge['notifyMethod']) ?? null,
      driverResponse: (row.driverResponse as DriverCharge['driverResponse']) ?? null,
      noticeFileId: row.noticeFileId,
      authorizationFileId: row.authorizationFileId,
      leaseClause: row.leaseClause,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      rejectedBy: row.rejectedBy,
      rejectedAt: row.rejectedAt?.toISOString() ?? null,
      rejectReason: row.rejectReason,
      recoveryMethod: (row.recoveryMethod as DriverCharge['recoveryMethod']) ?? null,
      installmentCents: row.installmentCents,
      installmentsTotal: row.installmentsTotal,
      driverTxId: row.driverTxId,
      recoveredCents: recovered,
      remainingCents: ['waived', 'rejected', 'cancelled'].includes(state) ? 0 : Math.max(0, row.amountCents - recovered),
      disputeText: row.disputeText,
      disputeRaisedBy: row.disputeRaisedBy,
      pendingChange: (row.pendingChange as DriverCharge['pendingChange']) ?? null,
      waiveReason: row.waiveReason,
      isTest: row.isTest,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ageDays: Math.max(0, Math.floor((this.core.now().getTime() - row.stateChangedAt.getTime()) / DAY)),
      history: row.history as DriverChargeHistoryEntry[],
      recoveryLog: (tx?.recoveryLog ?? []).map((l) => ({ label: l.settlementNumber ?? l.settlementId, cents: l.cents, at: l.at, reversed: Boolean(l.reversedAt) })),
      version: row.version,
    };
  }

  // ------------------------------------------------------------------------------------ writes

  private isMgmt(p: Principal) {
    return hasPermission(p, 'claims.approve_exceptions');
  }

  private need(p: Principal, codes: string[], what: string) {
    if (!codes.some((c) => hasPermission(p, c))) throw this.core.forbidden(`${what} takes ${codes.join(' or ')}`);
  }

  private async claim(companyId: string, id: string): Promise<SafetyClaimRow> {
    const [row] = await this.db
      .select()
      .from(safetyClaims)
      .where(and(eq(safetyClaims.companyId, companyId), eq(safetyClaims.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That claim');
    return row;
  }

  private async nextNumber(companyId: string): Promise<string> {
    const rows = await this.db
      .insert(safetyCounters)
      .values({ companyId, kind: 'driver_charge', last: 1 })
      .onConflictDoUpdate({ target: [safetyCounters.companyId, safetyCounters.kind], set: { last: sql`${safetyCounters.last} + 1` } })
      .returning({ last: safetyCounters.last });
    return `DCH-${this.core.today().slice(0, 4)}-${String(rows[0]?.last ?? 1).padStart(4, '0')}`;
  }

  /** Every transition: the version check, the history line, the claim's timeline and activity. */
  private async move(
    principal: Principal,
    row: SafetyDriverChargeRow,
    version: number,
    to: DriverChargeState,
    action: string,
    summary: string,
    patch: Partial<typeof safetyDriverCharges.$inferInsert> = {},
    note: string | null = null,
  ): Promise<DriverCharge> {
    if (row.version !== version) throw this.core.stale(row.number, row);
    const at = this.core.now();
    const who = this.core.actor(principal);
    const from = row.state as DriverChargeState;
    const history: DriverChargeHistoryEntry[] = [...(row.history as DriverChargeHistoryEntry[]), { at: at.toISOString(), by: who, action, from, to, note }];
    const updated = await this.db
      .update(safetyDriverCharges)
      .set({ ...patch, state: to, stateChangedAt: from === to ? row.stateChangedAt : at, history, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyDriverCharges.id, row.id), eq(safetyDriverCharges.version, version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.touchClaim(principal, row, `${row.number}: ${summary}`, from === to ? [] : [{ field: 'driverCharge.state', old: from, new: to }], note);
    return this.get(principal, row.id);
  }

  private async touchClaim(principal: Principal, row: Pick<SafetyDriverChargeRow, 'claimId' | 'claimNumber'>, summary: string, changes: { field: string; old: string | null; new: string | null }[], reason: string | null) {
    if (!row.claimId) return;
    const at = this.core.now();
    await this.db.update(safetyClaims).set({ lastActivityAt: at }).where(eq(safetyClaims.id, row.claimId));
    await this.core.write(principal, 'claim', { id: row.claimId, number: row.claimNumber ?? row.claimId }, 'driver_charge', summary, { changes, reason, at });
  }

  async apply(principal: Principal, claimId: string, input: ApplyDriverChargeInput): Promise<DriverCharge> {
    this.need(principal, ['claims.apply_charges', 'claims.approve_exceptions'], 'Applying a driver charge');
    const claim = await this.claim(principal.companyId, claimId);
    if (claim.voidedAt) throw this.core.refused(`${claim.number} is void`);
    if (claim.stage === 'closed') throw this.core.refused(`${claim.number} is closed`);
    if (claim.liabilityParty !== 'our_driver' && claim.liabilityParty !== 'shared') {
      throw this.core.invalid('A driver deductible needs liability decided as our driver (or shared). Record who is responsible first.');
    }
    if (!claim.driverId) throw this.core.invalid('Name the driver on the claim first.');
    const [driver] = await this.db
      .select({ type: drivers.driverType, first: drivers.firstName, last: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, claim.driverId)))
      .limit(1);
    if (!driver) throw this.core.invalid('The claim’s driver is not in this company.');
    const kind = driverKindOf(driver.type);
    const policy = policyCentsFor(kind);
    const reason = input.reason?.trim() || null;
    if (input.amountCents !== policy && !reason) throw this.core.invalid(`The policy amount is ${dollars(policy)}; say why this charge is ${dollars(input.amountCents)}.`);
    const outsidePolicy = input.amountCents > policy || policy - input.amountCents > CLAIM_CHARGE_POLICY.mgmtThresholdCents;
    const notice = input.notice ?? null;
    const afterNotice: DriverChargeState = notice ? (notice.response === 'disputes' ? 'disputed' : 'informed') : 'on_hold';
    const state: DriverChargeState = outsidePolicy && !this.isMgmt(principal) ? 'pending_management' : afterNotice;
    const at = this.core.now();
    const who = this.core.actor(principal);
    const id = this.core.newId('dch');
    const number = await this.nextNumber(principal.companyId);
    const history: DriverChargeHistoryEntry[] = [{ at: at.toISOString(), by: who, action: 'applied', from: null, to: state, note: reason }];
    const inserted = await this.db
      .insert(safetyDriverCharges)
      .values({
        id,
        companyId: principal.companyId,
        number,
        sourceType: 'claim',
        sourceId: claim.id,
        claimId: claim.id,
        claimNumber: claim.number,
        driverId: claim.driverId,
        driverName: claim.driverName ?? `${driver.first} ${driver.last}`.trim(),
        driverKind: kind,
        basis: input.basis,
        policyCents: policy,
        amountCents: input.amountCents,
        adjustReason: reason,
        state,
        stateBeforeHold: state === 'pending_management' ? afterNotice : null,
        pendingChange: state === 'pending_management' ? { kind: 'adjust', amountCents: input.amountCents, reason: reason ?? 'Outside policy', requestedBy: who } : null,
        notifiedOn: notice?.notifiedOn ?? null,
        notifiedBy: notice ? who : null,
        notifyMethod: notice?.method ?? null,
        driverResponse: notice?.response ?? null,
        noticeFileId: notice?.fileId ?? null,
        disputeText: notice?.response === 'disputes' ? 'The driver disputed the charge when told' : null,
        disputeRaisedBy: notice?.response === 'disputes' ? claim.driverName : null,
        history,
        isTest: input.isTest ?? claim.isTest,
        createdBy: who,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: safetyDriverCharges.id });
    if (inserted.length === 0) throw this.core.refused(`${claim.driverName ?? 'This driver'} already has an active ${DRIVER_CHARGE_BASIS_LABEL[input.basis].toLowerCase()} on ${claim.number}`);
    await this.db
      .update(safetyClaims)
      .set({ nextAction: state === 'on_hold' ? `Inform ${claim.driverName ?? 'the driver'} of the ${dollars(input.amountCents)} deductible and get a signed acknowledgment` : claim.nextAction, lastActivityAt: at, version: claim.version + 1, updatedAt: at })
      .where(eq(safetyClaims.id, claim.id));
    await this.core.write(principal, 'claim', claim, 'driver_charge', `${number}: ${DRIVER_CHARGE_BASIS_LABEL[input.basis]} ${dollars(input.amountCents)} applied to ${claim.driverName ?? 'the driver'} — ${DRIVER_CHARGE_STATE_LABEL[state]}`, { reason, at, changes: [{ field: 'driverCharge.state', old: null, new: state }] });
    return this.get(principal, id);
  }

  async notify(principal: Principal, id: string, input: NotifyDriverInput): Promise<DriverCharge> {
    this.need(principal, ['safety.manage', 'claims.approve_exceptions'], 'Recording the driver notice');
    const row = await this.row(principal.companyId, id);
    if (row.state !== 'on_hold') throw this.core.refused(`${row.number} is ${DRIVER_CHARGE_STATE_LABEL[row.state as DriverChargeState]}, not on hold`);
    const disputes = input.response === 'disputes';
    return this.move(
      principal,
      row,
      input.version,
      disputes ? 'disputed' : 'informed',
      'driver_informed',
      `driver informed on ${input.notifiedOn} (${NOTIFY_METHOD_LABEL[input.method]}): ${DRIVER_RESPONSE_LABEL[input.response]}`,
      {
        notifiedOn: input.notifiedOn,
        notifiedBy: this.core.actor(principal),
        notifyMethod: input.method,
        driverResponse: input.response,
        noticeFileId: input.fileId,
        disputeText: disputes ? (input.note?.trim() || 'The driver disputed the charge when told') : row.disputeText,
        disputeRaisedBy: disputes ? row.driverName : row.disputeRaisedBy,
        stateBeforeHold: disputes ? 'informed' : row.stateBeforeHold,
      },
      input.note?.trim() || null,
    );
  }

  async sendToAccounting(principal: Principal, id: string, input: VersionOnlyChargeInput): Promise<DriverCharge> {
    this.need(principal, ['safety.manage', 'claims.approve_exceptions'], 'Sending a charge to Accounting');
    const row = await this.row(principal.companyId, id);
    if (row.state !== 'informed') throw this.core.refused(`${row.number} can go to Accounting once the driver is informed`);
    const view = await this.move(principal, row, input.version, 'pending_accounting', 'sent_to_accounting', `sent to Accounting for review (${dollars(row.amountCents)})`, {}, input.note?.trim() || null);
    await this.upsertEntry(principal, row, 'pending_review');
    return view;
  }

  /** The charge's line in "Suggested for accounting": one per charge; approve and reject act on both. */
  private async upsertEntry(principal: Principal, row: SafetyDriverChargeRow, state: 'pending_review' | 'confirmed' | 'rejected' | 'superseded', note: string | null = null) {
    if (!row.claimId) return;
    const at = this.core.now();
    const key = `driver_charge:${row.id}`;
    const [existing] = await this.db
      .select()
      .from(safetyAccountingEntries)
      .where(and(eq(safetyAccountingEntries.companyId, principal.companyId), eq(safetyAccountingEntries.sourceKey, key)))
      .limit(1);
    const memo = `${row.number}: ${DRIVER_CHARGE_BASIS_LABEL[row.basis as keyof typeof DRIVER_CHARGE_BASIS_LABEL]} ${dollars(row.amountCents)} — ${row.driverName}. Approve or reject on the charge card.`;
    if (!existing) {
      await this.db
        .insert(safetyAccountingEntries)
        .values({ id: this.core.newId('sae'), companyId: principal.companyId, claimId: row.claimId, claimNumber: row.claimNumber ?? '', kind: 'driver_charge', amountCents: row.amountCents, sourceKey: key, memo, state, createdAt: at, updatedAt: at })
        .onConflictDoNothing();
      return;
    }
    await this.db
      .update(safetyAccountingEntries)
      .set({ state, amountCents: row.amountCents, memo, reviewNote: note, reviewedBy: state === 'pending_review' ? null : this.core.actor(principal), reviewedAt: state === 'pending_review' ? null : at, version: existing.version + 1, updatedAt: at })
      .where(eq(safetyAccountingEntries.id, existing.id));
  }

  async approve(principal: Principal, id: string, input: ApproveDriverChargeInput): Promise<DriverCharge> {
    this.need(principal, ['accounting.edit', 'claims.approve_exceptions'], 'Approving a driver charge');
    const row = await this.row(principal.companyId, id);
    if (row.state !== 'pending_accounting') throw this.core.refused(`${row.number} is not waiting for Accounting`);
    if (row.version !== input.version) throw this.core.stale(row.number, row);
    const missing: string[] = [];
    if (!row.noticeFileId) missing.push('The driver notice with evidence is not recorded');
    const authorization = input.authorizationFileId ?? row.authorizationFileId;
    const leaseClause = input.leaseClause?.trim() || row.leaseClause;
    if (row.driverKind === 'company' && !authorization) missing.push('Attach the driver’s signed authorization for this charge');
    if (row.driverKind === 'owner_operator' && !leaseClause) missing.push('Name the lease chargeback clause that covers this charge');
    const cap = installmentCapFor(row.driverKind === 'owner_operator' ? 'owner_operator' : 'company');
    if (input.installmentCents > cap && !input.overrideNote?.trim()) missing.push(`The installment is above the ${dollars(cap)} cap; add an override note`);
    if (input.installmentCents > row.amountCents) missing.push('The installment cannot exceed the charge');
    if (missing.length > 0) throw this.core.refused(`${row.number} cannot be approved yet`, missing);
    const tx = await this.accounts.fromDriverCharge(principal, {
      chargeId: row.id,
      reference: `${row.number}${row.claimNumber ? ` · ${row.claimNumber}` : ''}`,
      driverId: row.driverId,
      amountCents: row.amountCents,
      onDate: this.core.today(),
      description: `Claim ${row.claimNumber ?? ''} · ${DRIVER_CHARGE_BASIS_LABEL[row.basis as keyof typeof DRIVER_CHARGE_BASIS_LABEL]}`.trim(),
      reason: input.overrideNote?.trim() || `Approved ${row.number}`,
      truckId: null,
      perSettlementCents: input.installmentCents,
    });
    // Collected directly: the settlement engine must not also take it.
    if (input.method === 'direct_payment') await this.accounts.setChargeTxState(principal, tx.id, 'paused', 'Collected directly, not from settlements');
    const total = installmentsFor(row.amountCents, input.installmentCents);
    const view = await this.move(
      principal,
      row,
      input.version,
      'approved',
      'approved',
      `approved by Accounting: ${input.method === 'settlement_deduction' ? `${total} × ${dollars(input.installmentCents)} from weekly settlements, starting with the next` : input.method === 'escrow' ? 'recovered through escrow' : 'collected directly'}`,
      { approvedBy: this.core.actor(principal), approvedAt: this.core.now(), recoveryMethod: input.method, installmentCents: input.installmentCents, installmentsTotal: total, authorizationFileId: authorization ?? null, leaseClause: leaseClause ?? null, driverTxId: tx.id },
      input.overrideNote?.trim() || null,
    );
    await this.upsertEntry(principal, { ...row, amountCents: row.amountCents }, 'confirmed', 'Approved on the charge card');
    return view;
  }

  async reject(principal: Principal, id: string, input: RejectDriverChargeInput): Promise<DriverCharge> {
    this.need(principal, ['accounting.edit', 'claims.approve_exceptions'], 'Rejecting a driver charge');
    const row = await this.row(principal.companyId, id);
    if (row.state !== 'pending_accounting') throw this.core.refused(`${row.number} is not waiting for Accounting`);
    const view = await this.move(principal, row, input.version, 'rejected', 'rejected', `rejected by Accounting: ${REJECT_REASON_LABEL[input.reason]}`, { rejectedBy: this.core.actor(principal), rejectedAt: this.core.now(), rejectReason: `${REJECT_REASON_LABEL[input.reason]}: ${input.note}` }, input.note);
    await this.upsertEntry(principal, row, 'rejected', input.note);
    if (row.claimId) await this.db.update(safetyClaims).set({ nextAction: `Accounting rejected ${row.number}: ${REJECT_REASON_LABEL[input.reason]}` }).where(eq(safetyClaims.id, row.claimId));
    return view;
  }

  async payment(principal: Principal, id: string, input: DriverChargePaymentInput): Promise<DriverCharge> {
    this.need(principal, ['accounting.edit', 'claims.approve_exceptions'], 'Recording a driver payment');
    const row = await this.row(principal.companyId, id);
    if (!row.driverTxId || !['approved', 'recovering'].includes(row.state)) throw this.core.refused(`${row.number} is not being recovered`);
    if (row.version !== input.version) throw this.core.stale(row.number, row);
    await this.accounts.recordDirectRecovery(principal, row.driverTxId, {
      key: `direct:${row.id}:${input.receivedOn}:${input.amountCents}:${input.reference ?? ''}`,
      cents: input.amountCents,
      label: `${input.source === 'escrow' ? 'Escrow' : 'Direct payment'} ${input.receivedOn}${input.reference ? ` · ${input.reference}` : ''}`,
      at: this.core.now().toISOString(),
    });
    return this.move(principal, row, input.version, row.state as DriverChargeState, 'payment', `${dollars(input.amountCents)} received (${input.source === 'escrow' ? 'escrow' : 'direct'}) on ${input.receivedOn}`, {}, input.reference ?? null);
  }

  async pause(principal: Principal, id: string, input: DriverChargeReasonInput): Promise<DriverCharge> {
    this.need(principal, ['safety.manage', 'accounting.edit', 'claims.approve_exceptions'], 'Putting a charge on hold');
    const row = await this.row(principal.companyId, id);
    if (!['informed', 'pending_accounting', 'approved', 'recovering'].includes(row.state)) throw this.core.refused(`${row.number} cannot be paused from ${DRIVER_CHARGE_STATE_LABEL[row.state as DriverChargeState]}`);
    if (row.driverTxId) await this.accounts.setChargeTxState(principal, row.driverTxId, 'paused', input.reason);
    return this.move(principal, row, input.version, 'paused', 'paused', 'put on hold', { stateBeforeHold: row.state }, input.reason);
  }

  async resume(principal: Principal, id: string, input: DriverChargeReasonInput): Promise<DriverCharge> {
    this.need(principal, ['safety.manage', 'accounting.edit', 'claims.approve_exceptions'], 'Resuming a charge');
    const row = await this.row(principal.companyId, id);
    if (row.state !== 'paused') throw this.core.refused(`${row.number} is not paused`);
    const back = (row.stateBeforeHold as DriverChargeState | null) ?? 'informed';
    if (row.driverTxId && row.recoveryMethod !== 'direct_payment') await this.accounts.setChargeTxState(principal, row.driverTxId, 'approved', input.reason);
    return this.move(principal, row, input.version, back, 'resumed', `resumed (${DRIVER_CHARGE_STATE_LABEL[back]})`, { stateBeforeHold: null }, input.reason);
  }

  async dispute(principal: Principal, id: string, input: DisputeDriverChargeInput): Promise<DriverCharge> {
    this.need(principal, ['safety.manage', 'accounting.edit', 'claims.approve_exceptions'], 'Recording a dispute');
    const row = await this.row(principal.companyId, id);
    if (!['informed', 'pending_accounting', 'approved', 'recovering', 'paused', 'on_hold'].includes(row.state)) throw this.core.refused(`${row.number} cannot be disputed from ${DRIVER_CHARGE_STATE_LABEL[row.state as DriverChargeState]}`);
    if (row.driverTxId) await this.accounts.setChargeTxState(principal, row.driverTxId, 'disputed', input.text);
    return this.move(principal, row, input.version, 'disputed', 'disputed', `disputed by ${input.raisedBy}`, { stateBeforeHold: row.state === 'paused' ? row.stateBeforeHold : row.state, disputeText: input.text, disputeRaisedBy: input.raisedBy }, input.text);
  }

  async resolve(principal: Principal, id: string, input: ResolveDriverChargeInput): Promise<DriverCharge> {
    this.need(principal, ['claims.approve_exceptions'], 'Resolving a dispute');
    const row = await this.row(principal.companyId, id);
    if (row.state !== 'disputed') throw this.core.refused(`${row.number} is not disputed`);
    if (input.outcome === 'waive') return this.waive(principal, row, input.version, `Dispute resolved: waived. ${input.note}`, 'dispute_resolved');
    const amount = input.outcome === 'reduce' ? (input.amountCents ?? 0) : row.amountCents;
    if (input.outcome === 'reduce' && !(amount > 0 && amount < row.amountCents)) throw this.core.invalid('A reduced amount is more than zero and less than the charge.');
    if (row.driverTxId) {
      if (amount !== row.amountCents) await this.accounts.adjustChargeTx(principal, row.driverTxId, amount, input.note);
      if (row.recoveryMethod !== 'direct_payment') await this.accounts.setChargeTxState(principal, row.driverTxId, 'approved', input.note);
    }
    const back: DriverChargeState = row.driverTxId ? 'approved' : row.noticeFileId ? 'pending_accounting' : 'on_hold';
    const view = await this.move(principal, row, input.version, back, 'dispute_resolved', `dispute resolved: ${input.outcome === 'uphold' ? 'upheld' : `reduced to ${dollars(amount)}`}`, { amountCents: amount, disputeResolution: `${input.outcome}: ${input.note}`, stateBeforeHold: null }, input.note);
    if (back === 'pending_accounting') await this.upsertEntry(principal, { ...row, amountCents: amount }, 'pending_review');
    return view;
  }

  /** Safety asks, Management decides: a waiver always, an adjustment outside the threshold. */
  async changeRequest(principal: Principal, id: string, input: ChangeRequestInput): Promise<DriverCharge> {
    this.need(principal, ['safety.manage', 'accounting.edit', 'claims.approve_exceptions'], 'Asking to waive or adjust a charge');
    const row = await this.row(principal.companyId, id);
    if (!isActiveCharge(row.state as DriverChargeState) || row.state === 'pending_management') throw this.core.refused(`${row.number} is not open to a change`);
    if (input.kind === 'adjust' && !(input.amountCents && input.amountCents > 0)) throw this.core.invalid('Give the new amount.');
    const withinThreshold = input.kind === 'adjust' && (input.amountCents as number) <= row.policyCents && row.amountCents - (input.amountCents as number) <= CLAIM_CHARGE_POLICY.mgmtThresholdCents;
    if (this.isMgmt(principal) || withinThreshold) {
      if (input.kind === 'waive') return this.waive(principal, row, input.version, input.reason, 'waived');
      return this.adjust(principal, row, input.version, input.amountCents as number, input.reason);
    }
    return this.move(principal, row, input.version, 'pending_management', 'change_requested', `${input.kind === 'waive' ? 'waiver' : `adjustment to ${dollars(input.amountCents as number)}`} asked of Management`, { stateBeforeHold: row.state, pendingChange: { kind: input.kind, amountCents: input.amountCents ?? null, reason: input.reason, requestedBy: this.core.actor(principal) } }, input.reason);
  }

  async decideChange(principal: Principal, id: string, approve: boolean, input: VersionOnlyChargeInput): Promise<DriverCharge> {
    this.need(principal, ['claims.approve_exceptions'], 'Deciding a waiver or adjustment');
    const row = await this.row(principal.companyId, id);
    if (row.state !== 'pending_management') throw this.core.refused(`${row.number} is not waiting on Management`);
    const change = row.pendingChange as DriverCharge['pendingChange'];
    const back = (row.stateBeforeHold as DriverChargeState | null) ?? 'on_hold';
    if (!change) return this.move(principal, row, input.version, back, 'change_declined', 'nothing was pending', { stateBeforeHold: null });
    if (!approve) {
      // Declined: the charge goes on as it was - at the policy amount if it was applied outside it.
      const firstApply = row.history && (row.history as DriverChargeHistoryEntry[]).length === 1;
      return this.move(principal, row, input.version, back, 'change_declined', `${change.kind === 'waive' ? 'waiver' : 'adjustment'} declined by Management`, { stateBeforeHold: null, pendingChange: null, ...(firstApply && change.kind === 'adjust' ? { amountCents: row.policyCents } : {}) }, input.note ?? null);
    }
    if (change.kind === 'waive') return this.waive(principal, { ...row, state: back }, input.version, change.reason, 'change_approved', row);
    const firstApply = (row.history as DriverChargeHistoryEntry[]).length === 1;
    if (firstApply) return this.move(principal, row, input.version, back, 'change_approved', `amount ${dollars(change.amountCents as number)} approved by Management`, { stateBeforeHold: null, pendingChange: null, amountCents: change.amountCents as number }, input.note ?? null);
    return this.adjust(principal, row, input.version, change.amountCents as number, change.reason, back);
  }

  private async adjust(principal: Principal, row: SafetyDriverChargeRow, version: number, amountCents: number, reason: string, to?: DriverChargeState) {
    if (row.driverTxId) await this.accounts.adjustChargeTx(principal, row.driverTxId, amountCents, reason);
    const view = await this.move(principal, row, version, to ?? (row.state as DriverChargeState), 'adjusted', `amount ${dollars(row.amountCents)} → ${dollars(amountCents)}`, { amountCents, adjustReason: reason, pendingChange: null, stateBeforeHold: null }, reason);
    if ((to ?? row.state) === 'pending_accounting') await this.upsertEntry(principal, { ...row, amountCents }, 'pending_review');
    return view;
  }

  private async waive(principal: Principal, row: SafetyDriverChargeRow, version: number, reason: string, action: string, stored?: SafetyDriverChargeRow) {
    const base = stored ?? row;
    if (base.driverTxId) await this.accounts.setChargeTxState(principal, base.driverTxId, 'void', `Waived: ${reason}`);
    const view = await this.move(principal, base, version, 'waived', action, 'waived', { waiveReason: reason, waivedBy: this.core.actor(principal), waivedAt: this.core.now(), pendingChange: null, stateBeforeHold: null }, reason);
    await this.upsertEntry(principal, base, 'superseded', `Waived: ${reason}`);
    return view;
  }

  /** Charges a void claim still holds are cancelled with it. */
  async cancelForClaim(principal: Principal, claimId: string, reason: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(safetyDriverCharges)
      .where(and(eq(safetyDriverCharges.companyId, principal.companyId), eq(safetyDriverCharges.claimId, claimId), isNull(safetyDriverCharges.waivedAt)));
    for (const row of rows) {
      if (!isActiveCharge(row.state as DriverChargeState)) continue;
      if (row.driverTxId) await this.accounts.setChargeTxState(principal, row.driverTxId, 'void', `Claim voided: ${reason}`);
      await this.move(principal, row, row.version, 'cancelled', 'cancelled', 'cancelled with the claim', {}, reason);
    }
  }
}
