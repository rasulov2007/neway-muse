import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { companyProfiles } from '../../database/schema/company-profile';
import { emailMessages, type EmailMessageRow } from '../../database/schema/dot-application';
import { companies } from '../../database/schema/roster';
import { EmailTransport, TransientEmailError } from '../accounting/email.transport';

export type EmailSender = 'recruiting' | 'accounting';

export interface SendEmailInput {
  companyId: string;
  /** application_link · application_code · application_changes · statement … */
  kind: string;
  sender: EmailSender;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
  entityType?: string;
  entityId?: string;
  actorName?: string;
}

export interface SendEmailResult {
  id: string;
  status: 'sent' | 'failed' | 'skipped';
  messageId: string | null;
  error: string | null;
}

export type EmailEventListener = (row: EmailMessageRow, event: string) => Promise<void> | void;

const RETRIES = 3;
/** Resend's default limit is a few requests a second; bulk sends are spaced under it. */
const MIN_GAP_MS = 550;

/** "Harbor Line Transport" → safe inside a From display name (no quotes, angle brackets or line breaks). */
function displayName(name: string): string {
  return name.replace(/[\r\n"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'NeWay';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The one email module (owner brief 2026-10-27 §7). Every feature sends through here:
 *   - the sender is the candidate's / driver's company from the database —
 *     "<Company> <recruiting@mail.neway.example.com>" or "<Company> Accounting <accounting@…>", with the
 *     company's own Reply-To when one is set;
 *   - every message is a row in `email_messages` (who, what, to whom, the provider id, the status);
 *   - temporary failures (rate limit, provider 5xx, network) are retried up to 3 times, with the
 *     same idempotency key so a retry never delivers twice; sends are spaced for the rate limit;
 *   - the Resend webhook (signature verified) moves the row to delivered / bounced / complained.
 * The API key is read from the environment only and never logged.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private lastSendAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Map<string, EmailEventListener[]>();

  constructor(
    private readonly database: DatabaseService,
    private readonly transport: EmailTransport,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** What the server can send with, for screens that offer a Send button. */
  status(): { ready: boolean; provider: string; detail: string } {
    const t = this.transport.describe();
    return { ready: t.kind !== 'none', provider: t.kind, detail: t.detail };
  }

  /** Called with each provider event for rows of an entity type (e.g. settlement statements). */
  onEvent(entityType: string, listener: EmailEventListener): void {
    this.listeners.set(entityType, [...(this.listeners.get(entityType) ?? []), listener]);
  }

  async senderFor(companyId: string, sender: EmailSender): Promise<{ from: string; replyTo: string | null; companyName: string }> {
    const [row] = await this.db
      .select({ name: companies.name, recruiting: companies.recruitingReplyTo, accounting: companies.accountingReplyTo, record: companyProfiles.record })
      .from(companies)
      .leftJoin(companyProfiles, eq(companyProfiles.companyId, companies.id))
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!row) throw new Error(`No company ${companyId}`);
    const legal = ((row.record ?? {}) as { legalName?: string }).legalName?.trim();
    const companyName = legal || row.name;
    const name = displayName(sender === 'accounting' ? `${companyName} Accounting` : companyName);
    const local = sender === 'accounting' ? 'accounting' : 'recruiting';
    return {
      from: `"${name}" <${local}@${env.EMAIL_FROM_DOMAIN}>`,
      replyTo: (sender === 'accounting' ? row.accounting : row.recruiting) || null,
      companyName,
    };
  }

  /** Sends one message (queued behind the previous one so bulk sends stay under the rate limit). */
  send(input: SendEmailInput): Promise<SendEmailResult> {
    const run = this.queue.then(() => this.sendNow(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendNow(input: SendEmailInput): Promise<SendEmailResult> {
    const id = `eml_${crypto.randomUUID()}`;
    const { from, replyTo } = await this.senderFor(input.companyId, input.sender);
    const kind = this.transport.describe().kind;
    await this.db.insert(emailMessages).values({
      id,
      companyId: input.companyId,
      kind: input.kind,
      toAddress: input.to,
      fromAddress: from,
      replyTo,
      subject: input.subject,
      provider: kind,
      status: 'queued',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      createdByName: input.actorName ?? null,
    });
    if (kind === 'none') {
      const error = `Email is not set up on the server (${this.transport.describe().detail}).`;
      await this.db.update(emailMessages).set({ status: 'skipped', lastError: error }).where(eq(emailMessages.id, id));
      return { id, status: 'skipped', messageId: null, error };
    }
    let lastError = '';
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      const wait = this.lastSendAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastSendAt = Date.now();
      try {
        const sent = await this.transport.send({
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          attachments: input.attachments ?? [],
          from,
          replyTo,
          idempotencyKey: id,
        });
        await this.db
          .update(emailMessages)
          .set({ status: 'sent', attempts: attempt, providerMessageId: sent.messageId, sentAt: new Date(), lastError: null })
          .where(eq(emailMessages.id, id));
        return { id, status: 'sent', messageId: sent.messageId, error: null };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await this.db.update(emailMessages).set({ attempts: attempt, lastError }).where(eq(emailMessages.id, id));
        if (!(error instanceof TransientEmailError) || attempt === RETRIES) break;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    this.logger.warn(`Email ${id} (${input.kind}) failed: ${lastError}`);
    await this.db.update(emailMessages).set({ status: 'failed' }).where(eq(emailMessages.id, id));
    return { id, status: 'failed', messageId: null, error: lastError };
  }

  async forEntity(companyId: string, entityType: string, entityId: string): Promise<EmailMessageRow[]> {
    return this.db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.companyId, companyId), eq(emailMessages.entityType, entityType), eq(emailMessages.entityId, entityId)))
      .orderBy(desc(emailMessages.createdAt));
  }

  /**
   * The Resend webhook (Svix-style signature: svix-id / svix-timestamp / svix-signature over the raw
   * body). A bad or missing signature is refused; an unknown message id is acknowledged and ignored.
   */
  async webhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<{ status: number }> {
    if (!env.RESEND_WEBHOOK_SECRET) return { status: 503 };
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    let event: { type?: string; created_at?: string; data?: { email_id?: string; bounce?: { message?: string } } };
    try {
      // verify() checks the signature only; the key is not used for it.
      const resend = new Resend(env.RESEND_EMAIL_API ?? 're_verify_only');
      event = resend.webhooks.verify({
        payload: rawBody,
        headers: { id: h('svix-id') ?? '', timestamp: h('svix-timestamp') ?? '', signature: h('svix-signature') ?? '' },
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
      }) as unknown as typeof event;
    } catch {
      return { status: 401 };
    }
    const messageId = event.data?.email_id;
    const type = event.type ?? '';
    if (!messageId) return { status: 200 };
    const [row] = await this.db.select().from(emailMessages).where(eq(emailMessages.providerMessageId, messageId)).limit(1);
    if (!row) return { status: 200 };
    const at = new Date(event.created_at ?? Date.now());
    const status =
      type === 'email.delivered'
        ? 'delivered'
        : type === 'email.bounced'
          ? 'bounced'
          : type === 'email.complained'
            ? 'complained'
            : type === 'email.failed'
              ? 'failed'
              : null;
    const patch: Partial<EmailMessageRow> = {};
    // Delivered never overwrites a bounce or a complaint that already arrived.
    if (status && !(status === 'delivered' && ['bounced', 'complained'].includes(row.status))) patch.status = status;
    if (status === 'delivered') patch.deliveredAt = at;
    if (status === 'bounced') {
      patch.bouncedAt = at;
      patch.lastError = event.data?.bounce?.message ?? 'Bounced';
    }
    if (status === 'complained') patch.complainedAt = at;
    await this.db
      .update(emailMessages)
      .set({ ...patch, events: sql`${emailMessages.events} || ${JSON.stringify([{ type, at: at.toISOString() }])}::jsonb` })
      .where(eq(emailMessages.id, row.id));
    if (row.entityType) {
      const updated = { ...row, ...patch };
      for (const listener of this.listeners.get(row.entityType) ?? []) {
        try {
          await listener(updated as EmailMessageRow, type);
        } catch (error) {
          this.logger.warn(`Email event listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { status: 200 };
  }
}
