import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Principal } from '../../common/auth/principal';
import { hasPermission } from '../../common/auth/principal';
import { AuditService } from '../people/audit.service';
import { decrypt, encrypt, type SealedCredential } from '../admin/credential-vault';
import { forbidden, newId, unprocessable } from '../dispatch-board/ops.helpers';
import { AccountingStore } from './store.service';

/**
 * Payee profiles and payment batches (§10).
 *
 * Bank details are sealed with the credential vault the moment they arrive; the record keeps
 * the legal name, the account type and the last four digits. No route returns the numbers, no
 * audit line carries them, and an export never includes them. A payment batch freezes the
 * payee version it was approved with; a later bank change puts an unsent batch back to review.
 * ADP is not connected: batches are prepared and exported as a file, never submitted.
 */

export interface PayeeRecord {
  id: string;
  partyType: 'driver' | 'vendor';
  partyId: string;
  legalName: string;
  payeeIdentity: string | null;
  accountType: 'checking' | 'savings' | null;
  accountLast4: string | null;
  routingLast4: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  /** Bumped on every bank-detail change; batches freeze it. */
  bankVersion: number;
  history: Array<{ at: string; by: string; action: string; detail: string }>;
  updatedAt: string;
}

export interface PaymentBatchRecord {
  id: string;
  kind: 'driver' | 'vendor' | 'staff';
  status: 'prepared' | 'review' | 'approved' | 'exported' | 'submitted' | 'accepted' | 'rejected' | 'paid';
  provider: 'ADP' | 'file';
  lines: Array<{ statementId: string; partyType: string; partyId: string; partyName: string; amountCents: number; payeeId: string | null; payeeBankVersion: number | null; accountLast4: string | null; problems: string[] }>;
  totalCents: number;
  externalId: string | null;
  errors: string[];
  approvedAt: string | null;
  approvedBy: string | null;
  exportedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const BANK_PERMISSION = 'accounting.bank';

@Injectable()
export class PayeesService {
  constructor(
    private readonly store: AccountingStore,
    private readonly audit: AuditService,
  ) {}

  clock: () => Date = () => new Date();

  private requireBank(principal: Principal): void {
    if (!hasPermission(principal, BANK_PERMISSION)) throw forbidden('Bank details are restricted to the finance role that holds accounting.bank.');
  }

  async list(principal: Principal): Promise<PayeeRecord[]> {
    return (await this.store.list<PayeeRecord>('acct_payee_profiles', principal.companyId)).map((r) => r.record);
  }

  async forParty(principal: Principal, partyType: string, partyId: string): Promise<PayeeRecord | null> {
    const rows = await this.store.list<PayeeRecord>('acct_payee_profiles', principal.companyId, sql`party_type = ${partyType} and party_id = ${partyId}`);
    return rows[0]?.record ?? null;
  }

  /** Creates or updates a payee. Bank numbers are sealed and only their last four kept in the clear. */
  async save(principal: Principal, input: { partyType: 'driver' | 'vendor'; partyId: string; legalName: string; payeeIdentity?: string | null; accountType?: 'checking' | 'savings' | null; routingNumber?: string; accountNumber?: string; reason?: string }): Promise<PayeeRecord> {
    this.requireBank(principal);
    const existing = (await this.store.list<PayeeRecord>('acct_payee_profiles', principal.companyId, sql`party_type = ${input.partyType} and party_id = ${input.partyId}`))[0] ?? null;
    const now = this.clock().toISOString();
    const bankChange = Boolean(input.routingNumber || input.accountNumber);
    if (bankChange && (!/^\d{9}$/.test(input.routingNumber ?? '') || !/^\d{4,17}$/.test(input.accountNumber ?? ''))) throw unprocessable('A routing number is nine digits and an account number four to seventeen.');
    const base: PayeeRecord = existing?.record ?? { id: newId('pye'), partyType: input.partyType, partyId: input.partyId, legalName: input.legalName, payeeIdentity: null, accountType: null, accountLast4: null, routingLast4: null, verifiedAt: null, verifiedBy: null, bankVersion: 0, history: [], updatedAt: now };
    const rec: PayeeRecord = {
      ...base,
      legalName: input.legalName.trim(),
      payeeIdentity: input.payeeIdentity === undefined ? base.payeeIdentity : input.payeeIdentity,
      accountType: input.accountType === undefined ? base.accountType : input.accountType,
      accountLast4: bankChange ? input.accountNumber!.slice(-4) : base.accountLast4,
      routingLast4: bankChange ? input.routingNumber!.slice(-4) : base.routingLast4,
      // Any bank change needs a fresh verification.
      verifiedAt: bankChange ? null : base.verifiedAt,
      verifiedBy: bankChange ? null : base.verifiedBy,
      bankVersion: bankChange ? base.bankVersion + 1 : base.bankVersion,
      history: [...base.history, { at: now, by: principal.userName ?? principal.userId, action: bankChange ? 'bank_changed' : 'updated', detail: bankChange ? `Account ending ${input.accountNumber!.slice(-4)} (v${base.bankVersion + 1}) — ${input.reason ?? ''}` : (input.reason ?? 'Profile updated') }],
      updatedAt: now,
    };
    if (existing) await this.store.update('acct_payee_profiles', principal.companyId, existing.id, existing.version, rec);
    else await this.store.insert('acct_payee_profiles', principal.companyId, rec);
    if (bankChange) {
      const sealed = { routing: encrypt(input.routingNumber!, 'pii'), account: encrypt(input.accountNumber!, 'pii') };
      await this.store.setPayeeSealed(principal.companyId, rec.id, sealed);
      // A batch approved on the old version must not silently pay the new account.
      // Only payment batches: RTS export batches share this table under their own kind.
      const batches = await this.store.list<PaymentBatchRecord>('acct_payment_batches', principal.companyId, sql`status in ('approved','exported') and kind in ('driver','vendor')`);
      for (const b of batches) {
        if (b.record.lines.some((l) => l.payeeId === rec.id)) {
          await this.store.update('acct_payment_batches', principal.companyId, b.id, b.version, { ...b.record, status: 'review', errors: [...b.record.errors, `Bank details for ${rec.legalName} changed after approval (v${rec.bankVersion}); re-approve.`], updatedAt: now });
        }
      }
    }
    await this.audit.write(principal, { action: bankChange ? 'payee_bank_changed' : 'payee_updated', entityType: 'payee', entityId: rec.id, entityLabel: rec.legalName, summary: bankChange ? `Bank details replaced (account ending ${rec.accountLast4}); verification required` : `Payee ${rec.legalName} updated`, reason: input.reason ?? null, changes: [] });
    return rec;
  }

  async verify(principal: Principal, id: string): Promise<PayeeRecord> {
    this.requireBank(principal);
    const stored = await this.store.get<PayeeRecord>('acct_payee_profiles', principal.companyId, id);
    const now = this.clock().toISOString();
    const rec: PayeeRecord = { ...stored.record, verifiedAt: now, verifiedBy: principal.userName ?? principal.userId, history: [...stored.record.history, { at: now, by: principal.userName ?? principal.userId, action: 'verified', detail: `Account ending ${stored.record.accountLast4 ?? '—'} verified` }], updatedAt: now };
    await this.store.update('acct_payee_profiles', principal.companyId, id, stored.version, rec);
    await this.audit.write(principal, { action: 'payee_verified', entityType: 'payee', entityId: id, entityLabel: rec.legalName, summary: `Bank details verified (ending ${rec.accountLast4 ?? '—'})`, changes: [] });
    return rec;
  }

  /** Opens the sealed numbers for a file export only; never for a screen. */
  private async openBank(principal: Principal, id: string): Promise<{ routing: string; account: string } | null> {
    this.requireBank(principal);
    const sealed = (await this.store.payeeSealed(principal.companyId, id)) as { routing: SealedCredential; account: SealedCredential } | null;
    if (!sealed) return null;
    return { routing: decrypt(sealed.routing, 'pii'), account: decrypt(sealed.account, 'pii') };
  }

  // ------------------------------------------------------------ payment batches

  async batches(principal: Principal): Promise<PaymentBatchRecord[]> {
    return (await this.store.list<PaymentBatchRecord>('acct_payment_batches', principal.companyId, sql`kind in ('driver','vendor')`)).map((r) => r.record);
  }

  /** Prepares a payout batch from approved statements; each line freezes the payee's bank version. */
  async prepare(principal: Principal, input: { kind: 'driver' | 'vendor'; statementIds: string[] }): Promise<PaymentBatchRecord> {
    if (!hasPermission(principal, 'accounting.edit')) throw forbidden('Only Accounting prepares payment batches.');
    const statements = await this.store.list<{ id: string; partyType: string; partyId: string; partyName: string; status: string; payableCents: number }>('acct_settlements', principal.companyId, sql`id in (${sql.join(input.statementIds.map((s) => sql`${s}`), sql`, `)})`);
    const payees = await this.list(principal);
    const now = this.clock().toISOString();
    const lines = statements.map((s) => {
      const payee = payees.find((p) => p.partyType === s.record.partyType && p.partyId === s.record.partyId) ?? null;
      const problems: string[] = [];
      if (s.record.status !== 'approved') problems.push(`Statement is ${s.record.status}`);
      if (s.record.payableCents <= 0) problems.push('Nothing payable (carried forward)');
      if (!payee) problems.push('No payee profile');
      else if (!payee.verifiedAt) problems.push('Bank details not verified');
      return { statementId: s.id, partyType: s.record.partyType, partyId: s.record.partyId, partyName: s.record.partyName, amountCents: s.record.payableCents, payeeId: payee?.id ?? null, payeeBankVersion: payee?.bankVersion ?? null, accountLast4: payee?.accountLast4 ?? null, problems };
    });
    const rec: PaymentBatchRecord = { id: newId('pmb'), kind: input.kind, status: lines.some((l) => l.problems.length > 0) ? 'review' : 'prepared', provider: 'file', lines, totalCents: lines.filter((l) => l.problems.length === 0).reduce((s, l) => s + l.amountCents, 0), externalId: null, errors: [], approvedAt: null, approvedBy: null, exportedAt: null, createdAt: now, updatedAt: now };
    await this.store.insert('acct_payment_batches', principal.companyId, rec);
    return rec;
  }

  async approveBatch(principal: Principal, id: string): Promise<PaymentBatchRecord> {
    this.requireBank(principal);
    const stored = await this.store.get<PaymentBatchRecord>('acct_payment_batches', principal.companyId, id);
    const b = stored.record;
    if (b.lines.some((l) => l.problems.length > 0)) throw unprocessable('Fix the lines with problems, or remove them, before approving.');
    const payees = await this.list(principal);
    // Frozen versions must still be the current ones.
    for (const l of b.lines) {
      const p = payees.find((x) => x.id === l.payeeId);
      if (!p || p.bankVersion !== l.payeeBankVersion) throw unprocessable(`${l.partyName}: bank details changed since the batch was prepared. Prepare it again.`);
    }
    const now = this.clock().toISOString();
    const rec: PaymentBatchRecord = { ...b, status: 'approved', approvedAt: now, approvedBy: principal.userName ?? principal.userId, updatedAt: now };
    await this.store.update('acct_payment_batches', principal.companyId, id, stored.version, rec);
    await this.audit.write(principal, { action: 'payment_batch_approved', entityType: 'payment_batch', entityId: id, entityLabel: id, summary: `${b.lines.length} payout(s), $${(b.totalCents / 100).toFixed(2)}`, changes: [] });
    return rec;
  }

  /**
   * The NACHA-style CSV a bank or ADP import takes. This is the only place the sealed numbers
   * are opened, and only for an approved batch, by a holder of accounting.bank. Marks exported;
   * never paid - paid needs the bank's evidence.
   */
  async exportBatch(principal: Principal, id: string): Promise<{ csv: string; batch: PaymentBatchRecord }> {
    this.requireBank(principal);
    const stored = await this.store.get<PaymentBatchRecord>('acct_payment_batches', principal.companyId, id);
    const b = stored.record;
    if (b.status !== 'approved' && b.status !== 'exported') throw unprocessable(`The batch is ${b.status}; approve it first.`);
    const rows = [['Payee', 'Account type', 'Routing', 'Account', 'Amount', 'Statement']];
    for (const l of b.lines) {
      const bank = l.payeeId ? await this.openBank(principal, l.payeeId) : null;
      const payee = l.payeeId ? (await this.store.find<PayeeRecord>('acct_payee_profiles', principal.companyId, l.payeeId))?.record : null;
      rows.push([`'${l.partyName.replace(/^[=+\-@]/, '')}`, payee?.accountType ?? '', bank?.routing ?? '', bank?.account ?? '', (l.amountCents / 100).toFixed(2), l.statementId]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const now = this.clock().toISOString();
    const rec: PaymentBatchRecord = { ...b, status: 'exported', exportedAt: now, updatedAt: now };
    await this.store.update('acct_payment_batches', principal.companyId, id, stored.version, rec);
    await this.audit.write(principal, { action: 'payment_batch_exported', entityType: 'payment_batch', entityId: id, entityLabel: id, summary: `Exported ${b.lines.length} payout(s) as a bank file (numbers not logged)`, changes: [] });
    return { csv, batch: rec };
  }

  async markBatch(principal: Principal, id: string, input: { status: 'submitted' | 'accepted' | 'rejected' | 'paid'; externalId?: string; errors?: string[] }): Promise<PaymentBatchRecord> {
    this.requireBank(principal);
    const stored = await this.store.get<PaymentBatchRecord>('acct_payment_batches', principal.companyId, id);
    if (input.status === 'paid' && !input.externalId) throw unprocessable('Paid needs the bank or ADP reference as evidence.');
    const rec: PaymentBatchRecord = { ...stored.record, status: input.status, externalId: input.externalId ?? stored.record.externalId, errors: input.errors ?? stored.record.errors, updatedAt: this.clock().toISOString() };
    await this.store.update('acct_payment_batches', principal.companyId, id, stored.version, rec);
    return rec;
  }
}
