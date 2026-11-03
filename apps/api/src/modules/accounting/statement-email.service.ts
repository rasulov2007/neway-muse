import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Principal } from '../../common/auth/principal';
import { drivers } from '../../database/schema';
import { emailMessages, type EmailMessageRow } from '../../database/schema/dot-application';
import { conflict, unprocessable } from '../dispatch-board/ops.helpers';
import { EmailService } from '../email/email.service';
import { AuditService } from '../people/audit.service';
import { driverPiiReach, maskEmail } from '../roster/driver-pii';
import type { BatchRecord, StatementRecord } from './settlements.service';
import { SettlementsService } from './settlements.service';
import { AccountingStore } from './store.service';

/** What `email_messages.entity_type` says for a driver statement, so the webhook status lands on it. */
export const STATEMENT_ENTITY = 'settlement';
const STATEMENT_KIND = 'statement';
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type StatementRender = (s: StatementRecord) => Promise<{ pdf: Buffer; fileName: string; subject: string }>;

/** Why a statement is not sent. `no_email` is listed for Accounting by name. */
export type StatementEmailSkip = 'no_email' | 'invalid_email' | 'not_approved' | 'already_sent' | 'not_driver' | 'in_progress';

export interface StatementEmailState {
  /** The latest message for this statement: queued · sent · delivered · bounced · complained · failed · skipped. */
  status: string;
  at: string;
  to: string;
  error: string | null;
  /** The latest statement email to this driver's current address bounced (or was marked spam). */
  bounced: boolean;
}

export interface StatementEmailItem {
  statementId: string;
  settlementNumber: string;
  driverId: string;
  driverName: string;
  /** Masked unless the reader holds drivers.view_contact. */
  recipient: string | null;
  action: 'send' | 'skip';
  reason: StatementEmailSkip | null;
  last: StatementEmailState | null;
  /** Set when the double-check refused the statement (driver mismatch, shared address). */
  refused?: string;
}

export interface StatementEmailOutcome {
  statementId: string;
  settlementNumber: string;
  driverId: string;
  driverName: string;
  recipient: string | null;
  status: 'sent' | 'failed' | 'skipped';
  reason: StatementEmailSkip | null;
  error: string | null;
  emailMessageId: string | null;
  deliveryId: string | null;
}

export interface StatementEmailSummary {
  batchId: string;
  sent: StatementEmailOutcome[];
  failed: StatementEmailOutcome[];
  skipped_no_email: StatementEmailOutcome[];
  /** Not approved yet, already emailed, not a driver statement … with the reason. */
  skipped: StatementEmailOutcome[];
}

interface Resolved {
  statement: StatementRecord;
  driverId: string;
  driverName: string;
  firstName: string;
  /** The address from the statement's own driver record; never from a request. */
  email: string | null;
  reason: StatementEmailSkip | null;
}

const LATEST_SENT = new Set(['queued', 'sent', 'delivered']);
const BOUNCED = new Set(['bounced', 'complained']);
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Driver statements by email (owner brief 2026-10-27 §7.4): "Send by email" for one statement and
 * "Send all" for a pay period, through the shared EmailService (Resend).
 *
 *  - ONE email per driver statement, the PDF of that statement attached, nothing else.
 *  - The address is read here, on the server, from the driver row with the statement's own
 *    company and party id. A request can name a statement and whether to resend - nothing more;
 *    the routes refuse any other field. A statement whose stored party does not match the driver
 *    row it resolves to, or an address another driver of the company also uses, is refused.
 *  - Drivers with no (valid) email are skipped and listed by name.
 *  - Bulk runs on the server, one at a time (EmailService spaces sends and retries temporary
 *    failures 3×); a second "Send all" for the same week is refused while one runs, and a
 *    statement already emailed is not sent again unless "resend" is asked for.
 *  - Every send is an acct_deliveries row and an audit entry on the statement; the email_messages
 *    row carries entity 'settlement' + the statement id, so Resend's delivered / bounced events
 *    land on it (and on the delivery row, by the listener below).
 */
@Injectable()
export class StatementEmailService implements OnModuleInit {
  private readonly logger = new Logger(StatementEmailService.name);
  private readonly runningBatches = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: AccountingStore,
    private readonly settlements: SettlementsService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  clock: () => Date = () => new Date();

  private get db() {
    return this.store.db;
  }

  onModuleInit(): void {
    this.email.onEvent(STATEMENT_ENTITY, (row, type) => this.onProviderEvent(row, type));
  }

  // ------------------------------------------------------------ resolving the recipient

  /**
   * The statement's driver and address, double-checked: the stored party column and the record
   * agree, the driver row is the same company and the same id, and no other driver of the company
   * has the same address.
   */
  private async resolve(principal: Principal, s: StatementRecord, resend: boolean, last: StatementEmailState | null): Promise<Resolved> {
    const base = { statement: s, driverId: s.partyId, driverName: s.partyName, firstName: s.partyName.split(' ')[0] ?? s.partyName, email: null as string | null };
    if (s.partyType !== 'driver') return { ...base, reason: 'not_driver' };
    const stored = (await this.db.execute(sql`select party_type, party_id from acct_settlements where company_id = ${principal.companyId} and id = ${s.id}`)) as unknown as Array<{ party_type: string; party_id: string }>;
    if (!stored[0] || stored[0].party_type !== 'driver' || stored[0].party_id !== s.partyId) {
      throw unprocessable(`Statement ${s.settlementNumber}: its stored driver does not match the statement. Not sent.`);
    }
    const [d] = await this.db
      .select({ id: drivers.id, companyId: drivers.companyId, email: drivers.email, firstName: drivers.firstName, lastName: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, s.partyId)))
      .limit(1);
    if (!d || d.id !== s.partyId || d.companyId !== principal.companyId) {
      throw unprocessable(`Statement ${s.settlementNumber}: driver ${s.partyId} is not on file in this company. Not sent.`);
    }
    const email = (d.email ?? '').trim();
    const named = { ...base, driverName: `${d.firstName} ${d.lastName}`.trim() || s.partyName, firstName: d.firstName || base.firstName, email: email || null };
    if (!email) return { ...named, reason: 'no_email' };
    if (!EMAIL.test(email)) return { ...named, reason: 'invalid_email' };
    const others = (await this.db.execute(sql`select id from drivers where company_id = ${principal.companyId} and lower(trim(email)) = ${email.toLowerCase()} and id <> ${d.id} limit 1`)) as unknown as Array<{ id: string }>;
    if (others[0]) throw unprocessable(`Statement ${s.settlementNumber}: the address on ${named.driverName}'s file is also on another driver's file. Fix the address before sending.`);
    if (s.status !== 'approved' && s.status !== 'paid') return { ...named, reason: 'not_approved' };
    if (this.inFlight.has(s.id)) return { ...named, reason: 'in_progress' };
    if (!resend && last && LATEST_SENT.has(last.status)) return { ...named, reason: 'already_sent' };
    return { ...named, reason: null };
  }

  private shown(principal: Principal, email: string | null): string | null {
    if (!email) return null;
    return driverPiiReach(principal).contact ? email : maskEmail(email);
  }

  // ------------------------------------------------------------ status

  /** The last email per statement, with the bounced flag for the driver's current address. */
  async states(principal: Principal, statements: StatementRecord[]): Promise<Record<string, StatementEmailState>> {
    const ids = statements.map((s) => s.id);
    if (ids.length === 0) return {};
    const rows = await this.db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.companyId, principal.companyId), eq(emailMessages.entityType, STATEMENT_ENTITY), inArray(emailMessages.entityId, ids)))
      .orderBy(desc(emailMessages.createdAt));
    const latest = new Map<string, EmailMessageRow>();
    for (const r of rows) if (r.entityId && !latest.has(r.entityId)) latest.set(r.entityId, r);
    // The driver's current address: has the latest statement email to it bounced?
    const driverIds = [...new Set(statements.filter((s) => s.partyType === 'driver').map((s) => s.partyId))];
    const addresses = driverIds.length
      ? await this.db.select({ id: drivers.id, email: drivers.email }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), inArray(drivers.id, driverIds)))
      : [];
    const addressOf = new Map(addresses.map((a) => [a.id, (a.email ?? '').trim().toLowerCase()]));
    const wanted = [...new Set([...addressOf.values()].filter(Boolean))];
    const toAddress = new Map<string, string>();
    if (wanted.length) {
      const sentTo = (await this.db.execute(
        sql`select distinct on (lower(to_address)) lower(to_address) as address, status from email_messages where company_id = ${principal.companyId} and kind = ${STATEMENT_KIND} and lower(to_address) in (${sql.join(wanted.map((w) => sql`${w}`), sql`, `)}) order by lower(to_address), created_at desc`,
      )) as unknown as Array<{ address: string; status: string }>;
      for (const r of sentTo) toAddress.set(r.address, r.status);
    }
    const out: Record<string, StatementEmailState> = {};
    for (const s of statements) {
      const r = latest.get(s.id);
      const current = addressOf.get(s.partyId) ?? '';
      const addressBounced = current ? BOUNCED.has(toAddress.get(current) ?? '') : false;
      if (!r && !addressBounced) continue;
      out[s.id] = {
        status: r?.status ?? 'none',
        at: (r?.bouncedAt ?? r?.deliveredAt ?? r?.sentAt ?? r?.createdAt ?? this.clock()).toISOString(),
        to: this.shown(principal, r?.toAddress ?? null) ?? '',
        error: r?.lastError ?? null,
        // Bounced: this statement's own latest email, or the latest one to the address on file now.
        bounced: (r ? BOUNCED.has(r.status) && (r.toAddress.trim().toLowerCase() === current || !current) : false) || addressBounced,
      };
    }
    return out;
  }

  async statesFor(principal: Principal, query: { batchId?: string; ids?: string[] }): Promise<Record<string, StatementEmailState>> {
    const where = query.batchId ? sql`batch_id = ${query.batchId}` : query.ids?.length ? sql`id in (${sql.join(query.ids.map((i) => sql`${i}`), sql`, `)})` : null;
    if (!where) return {};
    const rows = (await this.store.list<StatementRecord>('acct_settlements', principal.companyId, where)).map((r) => r.record);
    return this.states(principal, rows);
  }

  // ------------------------------------------------------------ preview

  private async batchStatements(principal: Principal, batchId: string): Promise<{ batch: BatchRecord; statements: StatementRecord[] }> {
    const batch = (await this.store.get<BatchRecord>('acct_settlement_batches', principal.companyId, batchId)).record;
    const statements = (await this.store.list<StatementRecord>('acct_settlements', principal.companyId, sql`batch_id = ${batchId}`, 'created_at asc')).map((r) => r.record);
    return { batch, statements };
  }

  /** What "Send all" would do for a week: who gets one, who is skipped and why. Writes nothing. */
  async preview(principal: Principal, batchId: string, resend = false): Promise<{ batchId: string; running: boolean; ready: boolean; transport: string; items: StatementEmailItem[] }> {
    const { statements } = await this.batchStatements(principal, batchId);
    const states = await this.states(principal, statements);
    const items: StatementEmailItem[] = [];
    for (const s of statements) {
      if (s.partyType !== 'driver') continue;
      const r = await this.resolve(principal, s, resend, states[s.id] ?? null).catch((e: unknown) => ({ statement: s, driverId: s.partyId, driverName: s.partyName, firstName: '', email: null, reason: null, refused: e instanceof Error ? e.message : String(e) }));
      items.push({ statementId: s.id, settlementNumber: s.settlementNumber, driverId: r.driverId, driverName: r.driverName, recipient: this.shown(principal, r.email), action: r.reason || 'refused' in r ? 'skip' : 'send', reason: r.reason, last: states[s.id] ?? null, ...('refused' in r ? { refused: r.refused } : {}) });
    }
    const status = this.email.status();
    return { batchId, running: this.runningBatches.has(`${principal.companyId}:${batchId}`), ready: status.ready, transport: status.provider, items };
  }

  // ------------------------------------------------------------ sending

  private outcome(principal: Principal, r: Resolved, status: StatementEmailOutcome['status'], extra: Partial<StatementEmailOutcome> = {}): StatementEmailOutcome {
    return { statementId: r.statement.id, settlementNumber: r.statement.settlementNumber, driverId: r.driverId, driverName: r.driverName, recipient: this.shown(principal, r.email), status, reason: r.reason, error: null, emailMessageId: null, deliveryId: null, ...extra };
  }

  /** Sends one resolved statement; the PDF is rendered from that statement record only. */
  private async deliver(principal: Principal, r: Resolved, render: StatementRender, resend: boolean): Promise<StatementEmailOutcome> {
    const s = r.statement;
    this.inFlight.add(s.id);
    try {
      let doc: { pdf: Buffer; fileName: string; subject: string };
      try {
        doc = await render(s);
      } catch (error) {
        return this.outcome(principal, r, 'failed', { error: `The statement PDF could not be made: ${error instanceof Error ? error.message : String(error)}` });
      }
      const company = (await this.email.senderFor(principal.companyId, 'accounting')).companyName;
      const text = [
        `Hello ${r.firstName},`,
        '',
        `Your pay statement ${s.settlementNumber} for ${s.periodStart} to ${s.periodEnd} is attached (${doc.fileName}).`,
        `To pay out: ${usd(s.payableCents)}. Pay date: ${s.payDate}.`,
        '',
        'Questions about it? Reply to this email and Accounting will answer.',
        '',
        `${company} Accounting`,
      ].join('\n');
      const esc = (v: string) => v.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
      const html = text.split('\n').map((l) => (l ? `<p style="margin:0 0 8px">${esc(l)}</p>` : '')).join('');
      const sent = await this.email.send({
        companyId: principal.companyId,
        kind: STATEMENT_KIND,
        sender: 'accounting',
        to: r.email!,
        subject: doc.subject,
        text,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px">${html}</div>`,
        attachments: [{ filename: doc.fileName, content: doc.pdf }],
        entityType: STATEMENT_ENTITY,
        entityId: s.id,
        actorName: principal.userName ?? principal.userId,
      });
      const status = sent.status === 'sent' ? 'sent' : 'failed';
      const error = sent.status === 'sent' ? null : (sent.error ?? 'Not sent.');
      const deliveryId = `dlv_${crypto.randomUUID()}`;
      await this.store.insert('acct_deliveries', principal.companyId, {
        id: deliveryId,
        documentType: 'statement',
        documentId: s.id,
        channel: 'email',
        recipient: r.email,
        driverId: r.driverId,
        status,
        reason: error,
        resend,
        amountCents: s.payableCents,
        label: `${r.driverName} (${s.settlementNumber})`,
        transport: this.email.status().provider,
        emailMessageId: sent.id,
        providerMessageId: sent.messageId,
        byName: principal.userName ?? principal.userId,
        at: this.clock().toISOString(),
      });
      await this.audit.write(principal, {
        action: status === 'sent' ? 'statement_emailed' : 'statement_email_failed',
        entityType: STATEMENT_ENTITY,
        entityId: s.id,
        entityLabel: s.settlementNumber,
        summary: status === 'sent' ? `Statement emailed to ${r.driverName} (${maskEmail(r.email)})${resend ? ' · resent' : ''}` : `Statement email to ${r.driverName} failed: ${error}`,
        changes: [],
      });
      return this.outcome(principal, r, status, { error, emailMessageId: sent.id, deliveryId });
    } finally {
      this.inFlight.delete(s.id);
    }
  }

  /** "Send by email" on one statement. A skip is said as a refusal so the person sees why. */
  async sendOne(principal: Principal, statementId: string, render: StatementRender, resend = false): Promise<StatementEmailOutcome> {
    const s = await this.settlements.statement(principal, statementId);
    const last = (await this.states(principal, [s]))[s.id] ?? null;
    const r = await this.resolve(principal, s, resend, last);
    if (r.reason === 'already_sent') throw conflict(`${s.settlementNumber} was already emailed to ${r.driverName} (${last?.status}). Choose Resend to send it again.`);
    if (r.reason === 'in_progress') throw conflict(`${s.settlementNumber} is being emailed right now.`);
    if (r.reason === 'not_driver') throw unprocessable('Send by email is for driver statements.');
    if (r.reason === 'not_approved') throw unprocessable(`${s.settlementNumber} is not approved yet. Approve it first; drafts are not emailed.`);
    if (r.reason === 'no_email') throw unprocessable(`${r.driverName} has no email on file. Add one on the driver's profile.`);
    if (r.reason === 'invalid_email') throw unprocessable(`The email on ${r.driverName}'s file is not a valid address. Fix it on the driver's profile.`);
    return this.deliver(principal, r, render, resend);
  }

  /** "Send all by email" for a pay period: sequential, on the server, one summary back. */
  async sendBatch(principal: Principal, batchId: string, render: StatementRender, resend = false): Promise<StatementEmailSummary> {
    const key = `${principal.companyId}:${batchId}`;
    if (this.runningBatches.has(key)) throw conflict('Send all is already running for this week. Wait for it to finish.');
    this.runningBatches.add(key);
    try {
      const { statements } = await this.batchStatements(principal, batchId);
      const states = await this.states(principal, statements);
      const summary: StatementEmailSummary = { batchId, sent: [], failed: [], skipped_no_email: [], skipped: [] };
      for (const s of statements) {
        if (s.partyType !== 'driver') continue;
        let r: Resolved;
        try {
          // The approved record, read again by id: the PDF is the statement exactly as stored.
          const fresh = s.status === 'approved' || s.status === 'paid' ? await this.settlements.statement(principal, s.id) : s;
          r = await this.resolve(principal, fresh, resend, states[s.id] ?? null);
        } catch (error) {
          summary.failed.push({ statementId: s.id, settlementNumber: s.settlementNumber, driverId: s.partyId, driverName: s.partyName, recipient: null, status: 'failed', reason: null, error: error instanceof Error ? error.message : String(error), emailMessageId: null, deliveryId: null });
          continue;
        }
        if (r.reason === 'no_email' || r.reason === 'invalid_email') {
          summary.skipped_no_email.push(this.outcome(principal, r, 'skipped'));
          continue;
        }
        if (r.reason) {
          summary.skipped.push(this.outcome(principal, r, 'skipped'));
          continue;
        }
        const out = await this.deliver(principal, r, render, resend);
        (out.status === 'sent' ? summary.sent : summary.failed).push(out);
      }
      await this.audit.write(principal, {
        action: 'statements_emailed',
        entityType: 'settlement_batch',
        entityId: batchId,
        entityLabel: batchId,
        summary: `Send all: ${summary.sent.length} sent, ${summary.failed.length} failed, ${summary.skipped_no_email.length} without email${summary.skipped_no_email.length ? ` (${summary.skipped_no_email.map((o) => o.driverName).join(', ')})` : ''}, ${summary.skipped.length} skipped${resend ? ' · resend' : ''}`,
        changes: [],
      });
      return summary;
    } finally {
      this.runningBatches.delete(key);
    }
  }

  // ------------------------------------------------------------ provider events

  /** Resend's delivered / bounced / complained / failed, onto the delivery row and the statement's history. */
  private async onProviderEvent(row: EmailMessageRow, type: string): Promise<void> {
    if (!row.entityId) return;
    const rows = await this.store.list<Record<string, unknown>>('acct_deliveries', row.companyId, sql`record->>'emailMessageId' = ${row.id}`);
    for (const d of rows) {
      await this.store.update('acct_deliveries', row.companyId, d.id, d.version, { ...d.record, status: row.status, reason: BOUNCED.has(row.status) || row.status === 'failed' ? (row.lastError ?? row.status) : (d.record['reason'] ?? null), eventAt: this.clock().toISOString() });
    }
    if (!BOUNCED.has(row.status) && row.status !== 'failed') return;
    const system: Principal = { userId: 'system:resend', userName: 'Email provider', companyId: row.companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set() };
    const [s] = await this.store.list<StatementRecord>('acct_settlements', row.companyId, sql`id = ${row.entityId}`);
    await this.audit
      .write(system, {
        action: `statement_email_${row.status}`,
        actorType: 'system',
        entityType: STATEMENT_ENTITY,
        entityId: row.entityId,
        entityLabel: s?.record.settlementNumber ?? row.entityId,
        summary: row.status === 'bounced' ? `Statement email bounced (${maskEmail(row.toAddress)}): ${row.lastError ?? 'no reason given'} — check the address` : `Statement email ${row.status} (${maskEmail(row.toAddress)}) · ${type}`,
        changes: [],
      })
      .catch((e: unknown) => this.logger.warn(`audit for ${row.id} failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}
