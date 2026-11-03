import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  LINK_DELIVERY_STATUS_LABELS,
  toE164,
  type CandidateDeliveries,
  type JourneyLinkKind,
  type LinkChannelState,
  type LinkDeliveryChannel,
  type LinkDeliveryStatus,
  type LinkDeliveryView,
  type SendLinkRequest,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { hiringLinkDeliveries, type HiringLinkDeliveryRow } from '../../database/schema/hiring';
import { companies } from '../../database/schema/roster';
import { EmailTransport } from '../accounting/email.transport';
import { deliveryStatusOf, TwilioError, twilioSignatureValid } from '../admin/connectors/twilio.client';
import { TwilioService } from '../admin/connectors/twilio.service';
import { AuditService } from '../people/audit.service';
import { ConsentService } from './consent.service';
import { DriverApplicationService, type ApplicationSubject } from './driver-application.service';
import { linkMessage } from './link-messages';
import { RecruitService } from './recruit.service';
import { SmsPreferencesService } from './sms-preferences.service';

const fail = (status: number, title: string, detail: string) => new AppError({ status, title, detail });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A delivery never goes backwards: a late "sent" callback cannot undo "delivered". */
const RANK: Record<LinkDeliveryStatus, number> = { sending: 0, sent: 1, delivered: 2, failed: 2 };

const LINK_LABEL: Record<JourneyLinkKind, string> = { consent: 'Consent link', application: 'Application link' };
const CHANNEL_LABEL: Record<LinkDeliveryChannel, string> = { sms: 'SMS', email: 'email' };
const PROVIDER_LABEL: Record<string, string> = { twilio: 'Twilio', smtp: 'the mail server', graph: 'Microsoft 365', file: 'the sandbox outbox' };

/**
 * Sending the candidate's private links from the TMS (owner brief, 2026-10-11): the consent link
 * (step 2) and the application link (step 5), by SMS through the company's Twilio account or by
 * email through SMTP.
 *
 * Each send makes a new link — a link is shown once and only its digest is kept, so the TMS cannot
 * send the old one again — and turns the previous one off. Each attempt is a row: `sent` only once
 * the provider accepted it, `delivered` only on the carrier's receipt (Twilio's status callback, or
 * "Check status" asking Twilio), `failed` with the provider's reason. With no provider set up the
 * send is refused with the reason and nothing claims a message went out; Copy link still works.
 * Every attempt and every outcome lands in the candidate's history (the audit trail).
 */
@Injectable()
export class LinkDeliveryService {
  private readonly logger = new Logger(LinkDeliveryService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly email: EmailTransport,
    private readonly twilio: TwilioService,
    private readonly consents: ConsentService,
    private readonly driverApps: DriverApplicationService,
    private readonly recruit: RecruitService,
    private readonly smsPrefs: SmsPreferencesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ---------------------------------------------------------------------------------- reads

  async channels(companyId: string): Promise<Record<LinkDeliveryChannel, LinkChannelState>> {
    const sender = await this.twilio.sender(companyId);
    const mail = this.email.describe();
    return {
      sms: sender.ok ? { available: true, via: sender.label, reason: null } : { available: false, via: null, reason: sender.reason },
      email:
        mail.kind === 'none'
          ? { available: false, via: null, reason: `Email is not set up on this TMS: ${mail.detail}.` }
          : { available: true, via: mail.kind === 'file' ? 'Sandbox outbox (QA: nothing leaves the server)' : `${mail.kind === 'graph' ? 'Microsoft 365' : 'SMTP'} · ${mail.from ?? 'default sender'}`, reason: null },
    };
  }

  private view(r: HiringLinkDeliveryRow, live: Record<JourneyLinkKind, string | null>): LinkDeliveryView {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: r.id,
      link: r.linkKind as JourneyLinkKind,
      channel: r.channel as LinkDeliveryChannel,
      recipient: r.recipient,
      status: r.status as LinkDeliveryStatus,
      provider: r.provider,
      providerStatus: r.providerStatus,
      error: r.errorMessage ? `${r.errorMessage}${r.errorCode ? ` (code ${r.errorCode})` : ''}` : r.errorCode ? `Error code ${r.errorCode}` : null,
      createdAt: r.createdAt.toISOString(),
      createdByName: r.createdByName,
      sentAt: iso(r.sentAt),
      deliveredAt: iso(r.deliveredAt),
      failedAt: iso(r.failedAt),
      statusCheckedAt: iso(r.statusCheckedAt),
      resendOfId: r.resendOfId,
      linkLive: live[r.linkKind as JourneyLinkKind] === r.sessionId,
      version: r.version,
    };
  }

  /** The id of each live link, so a delivery can say whether its link still works. */
  private async liveSessions(principal: Principal, subject: ApplicationSubject): Promise<Record<JourneyLinkKind, string | null>> {
    const [consent, application] = await Promise.all([this.consents.view(principal, subject), this.driverApps.view(principal, subject)]);
    return {
      consent: consent.session?.state === 'live' ? consent.session.id : null,
      application: application.session && application.session.state === 'live' ? application.session.id : null,
    };
  }

  async list(principal: Principal, subject: ApplicationSubject, phone: string | null): Promise<CandidateDeliveries> {
    const [channels, rows, live, sms] = await Promise.all([
      this.channels(principal.companyId),
      this.db
        .select()
        .from(hiringLinkDeliveries)
        .where(and(eq(hiringLinkDeliveries.companyId, principal.companyId), eq(hiringLinkDeliveries.subjectKey, subject.subjectKey)))
        .orderBy(desc(hiringLinkDeliveries.createdAt))
        .limit(50),
      this.liveSessions(principal, subject),
      this.smsPrefs.view(principal.companyId, phone),
    ]);
    return { channels, items: rows.map((r) => this.view(r, live)), sms };
  }

  // ---------------------------------------------------------------------------------- writes

  private assertManage(principal: Principal) {
    if (!hasPermission(principal, 'recruiting.manage')) throw fail(403, 'Forbidden', 'This needs the recruiting manage permission.');
  }

  private recipientFor(channel: LinkDeliveryChannel, given: string | null, candidate: { phone: string | null; email: string | null }): string {
    if (channel === 'sms') {
      const raw = given ?? candidate.phone;
      if (!raw) throw fail(422, 'Unprocessable Entity', 'This candidate has no phone number. Add one or copy the link.');
      const e164 = toE164(raw);
      if (!e164) throw fail(422, 'Unprocessable Entity', `"${raw}" is not a phone number the TMS can text. Use a US number or +country code.`);
      return e164;
    }
    const raw = (given ?? candidate.email ?? '').trim();
    if (!raw) throw fail(422, 'Unprocessable Entity', 'This candidate has no email address. Add one or copy the link.');
    if (!EMAIL.test(raw) || raw.length > 160) throw fail(422, 'Unprocessable Entity', `"${raw}" is not a valid email address.`);
    return raw.toLowerCase();
  }

  /** Send consent / Send application by SMS or email: a new link, sent now, recorded either way. */
  async send(principal: Principal, key: string, input: SendLinkRequest, resendOf: HiringLinkDeliveryRow | null = null): Promise<LinkDeliveryView> {
    this.assertManage(principal);
    const subject = await this.recruit.subjectFor(principal, key);
    const candidate = await this.recruit.candidate(principal, key);
    const recipient = this.recipientFor(input.channel, input.to, candidate);

    // Refuse before a link is made when the channel cannot send: nothing may look sent.
    const channels = await this.channels(principal.companyId);
    const state = channels[input.channel];
    if (!state.available) throw fail(409, 'Conflict', `${state.reason} Copy the link and send it yourself.`);
    const sender = input.channel === 'sms' ? await this.twilio.sender(principal.companyId) : null;
    if (sender && !sender.ok) throw fail(409, 'Conflict', `${sender.reason} Copy the link and send it yourself.`);
    if (input.channel === 'sms') {
      const refused = await this.smsPrefs.refusal(principal.companyId, recipient);
      if (refused) throw fail(409, 'Conflict', refused);
    }

    // The link itself: the same doors as Copy link, with the same rules (the application waits for
    // Safety). Made waiting: it works — and the current link stops — only once the message is accepted.
    const issued =
      input.link === 'consent'
        ? await this.consents.issue(principal, subject, { deferred: true }).then((r) => ({ url: r.url, expiresAt: r.expiresAt, sessionId: r.session.id }))
        : await this.recruit.issueDriverApplication(principal, key, { deferred: true }).then((r) => ({ url: r.url, expiresAt: r.expiresAt, sessionId: r.session.id }));

    const [company] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, principal.companyId)).limit(1);
    const message = linkMessage({
      kind: input.link,
      companyName: company?.name ?? 'Recruiting',
      firstName: subject.name.split(' ')[0] ?? '',
      url: issued.url,
      expiresAt: issued.expiresAt,
    });

    const id = `hld_${crypto.randomUUID()}`;
    const by = principal.userName ?? principal.userId;
    const provider = input.channel === 'sms' ? 'twilio' : this.email.describe().kind;
    await this.db.insert(hiringLinkDeliveries).values({
      id,
      companyId: principal.companyId,
      leadId: subject.leadId,
      hiringCaseId: subject.caseId,
      subjectKey: subject.subjectKey,
      linkKind: input.link,
      sessionId: issued.sessionId,
      channel: input.channel,
      recipient,
      status: 'sending',
      provider,
      integrationAccountId: sender?.ok ? sender.accountId : null,
      resendOfId: resendOf?.id ?? null,
      createdByUserId: principal.userId,
      createdByName: by,
    });

    let outcome: { status: LinkDeliveryStatus; providerMessageId: string | null; providerStatus: string | null; errorCode: string | null; errorMessage: string | null };
    try {
      if (sender?.ok) {
        const sent = await sender.client.send({ to: recipient, from: sender.from, body: message.sms, statusCallback: this.callbackUrl(id) });
        outcome = { status: deliveryStatusOf(sent.status), providerMessageId: sent.sid || null, providerStatus: sent.status, errorCode: sent.errorCode, errorMessage: sent.errorMessage };
      } else {
        const sent = await this.email.send({ to: recipient, subject: message.subject, text: message.text, html: message.html, attachments: [] });
        outcome = { status: 'sent', providerMessageId: sent.messageId, providerStatus: 'accepted', errorCode: null, errorMessage: null };
      }
    } catch (error) {
      const e = error as Partial<TwilioError> & Error;
      // The provider's words, never the credential or the message body.
      this.logger.warn(`link ${input.channel} not sent: ${e.name}${e.code ? ` ${e.code}` : ''}`);
      outcome = {
        status: 'failed',
        providerMessageId: null,
        providerStatus: null,
        errorCode: e.code ?? null,
        errorMessage: input.channel === 'sms' ? (e.message ?? 'Twilio refused the message') : 'The mail server did not accept the message',
      };
    }

    const at = new Date();
    const sentOk = outcome.status !== 'failed';
    const via = input.channel === 'sms' ? 'SMS' : 'email';
    if (sentOk) {
      await (input.link === 'consent' ? this.consents.activate(principal, subject, issued.sessionId, via) : this.driverApps.activate(principal, subject, issued.sessionId, via));
    } else {
      // Not accepted: the new link never works and the driver's current link keeps working.
      await (input.link === 'consent' ? this.consents.discard(principal.companyId, issued.sessionId, `Message not sent: ${outcome.errorMessage ?? 'refused'}`) : this.driverApps.discard(principal.companyId, issued.sessionId));
      if (outcome.errorCode === '21610') await this.smsPrefs.carrierOptOut(principal, recipient);
    }
    const event = await this.db.transaction(async (tx) => {
      await tx
        .update(hiringLinkDeliveries)
        .set({
          status: outcome.status,
          providerMessageId: outcome.providerMessageId,
          providerStatus: outcome.providerStatus,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
          sentAt: sentOk ? at : null,
          deliveredAt: outcome.status === 'delivered' ? at : null,
          failedAt: sentOk ? null : at,
          version: 2,
          updatedAt: at,
        })
        .where(eq(hiringLinkDeliveries.id, id));
      return this.audit.writeIn(tx, principal, {
        action: sentOk ? 'link_delivery_sent' : 'link_delivery_failed',
        ...this.entity(subject),
        entityLabel: subject.name,
        summary: sentOk
          ? `${LINK_LABEL[input.link]} ${resendOf ? 're-sent' : 'sent'} by ${CHANNEL_LABEL[input.channel]} to ${recipient} — accepted by ${PROVIDER_LABEL[provider] ?? provider}`
          : `${LINK_LABEL[input.link]} by ${CHANNEL_LABEL[input.channel]} to ${recipient} failed: ${outcome.errorMessage ?? 'not accepted'} (the earlier link, if any, still works)`,
        changes: [{ field: 'link_delivery', old: resendOf?.id ?? null, new: id }],
        at,
      });
    });
    await this.audit.publish(event);
    const live = await this.liveSessions(principal, subject);
    const [row] = await this.db.select().from(hiringLinkDeliveries).where(eq(hiringLinkDeliveries.id, id)).limit(1);
    return this.view(row as HiringLinkDeliveryRow, live);
  }

  private entity(subject: ApplicationSubject) {
    return subject.caseId ? { entityType: 'hiring_case', entityId: subject.caseId } : { entityType: 'hiring_lead', entityId: subject.leadId as string };
  }

  private async own(principal: Principal, subject: ApplicationSubject, id: string): Promise<HiringLinkDeliveryRow> {
    const [row] = await this.db
      .select()
      .from(hiringLinkDeliveries)
      .where(and(eq(hiringLinkDeliveries.companyId, principal.companyId), eq(hiringLinkDeliveries.subjectKey, subject.subjectKey), eq(hiringLinkDeliveries.id, id)))
      .limit(1);
    if (!row) throw fail(404, 'Not Found', 'No such message for this candidate.');
    return row;
  }

  /** Resend: the same link kind, channel and recipient — as a new link (the old one stops working). */
  async resend(principal: Principal, key: string, id: string): Promise<LinkDeliveryView> {
    this.assertManage(principal);
    const subject = await this.recruit.subjectFor(principal, key);
    const row = await this.own(principal, subject, id);
    return this.send(principal, key, { link: row.linkKind as JourneyLinkKind, channel: row.channel as LinkDeliveryChannel, to: row.recipient }, row);
  }

  /** Check status: asks Twilio where the text is now (for when its callback cannot reach us). */
  async refresh(principal: Principal, key: string, id: string): Promise<LinkDeliveryView> {
    const subject = await this.recruit.subjectFor(principal, key);
    const row = await this.own(principal, subject, id);
    if (row.channel !== 'sms' || !row.providerMessageId || !row.integrationAccountId) {
      throw fail(409, 'Conflict', row.channel === 'email' ? 'Email has no delivery receipt: "Sent" means the mail server accepted it.' : 'This message never reached Twilio; there is nothing to check.');
    }
    const account = await this.twilio.clientFor(principal.companyId, row.integrationAccountId);
    if (!account) throw fail(409, 'Conflict', 'The Twilio account that sent this message is no longer available.');
    try {
      const m = await account.client.fetchMessage(row.providerMessageId);
      await this.apply(row, { providerStatus: m.status, errorCode: m.errorCode, errorMessage: m.errorMessage }, principal, true);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw fail(503, 'Service Unavailable', `Twilio did not answer: ${(error as Error).message}`);
    }
    const live = await this.liveSessions(principal, subject);
    const [fresh] = await this.db.select().from(hiringLinkDeliveries).where(eq(hiringLinkDeliveries.id, row.id)).limit(1);
    return this.view(fresh as HiringLinkDeliveryRow, live);
  }

  /** Records a provider status on a delivery, forward only, with a history entry when it settles. */
  private async apply(
    row: HiringLinkDeliveryRow,
    update: { providerStatus: string; errorCode: string | null; errorMessage: string | null },
    principal: Principal,
    checked: boolean,
  ): Promise<void> {
    const next = deliveryStatusOf(update.providerStatus);
    const current = row.status as LinkDeliveryStatus;
    const at = new Date();
    if (next === current || RANK[next] <= RANK[current]) {
      // Nothing new (or a late, older status): note that it was checked, change nothing else.
      await this.db
        .update(hiringLinkDeliveries)
        .set({ ...(checked ? { statusCheckedAt: at } : {}), providerStatus: next === current ? update.providerStatus : row.providerStatus, updatedAt: at })
        .where(eq(hiringLinkDeliveries.id, row.id));
      return;
    }
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(hiringLinkDeliveries)
        .set({
          status: next,
          providerStatus: update.providerStatus,
          errorCode: update.errorCode ?? row.errorCode,
          errorMessage: update.errorMessage ?? (next === 'failed' && update.errorCode ? `Twilio error ${update.errorCode}` : row.errorMessage),
          deliveredAt: next === 'delivered' ? at : row.deliveredAt,
          failedAt: next === 'failed' ? at : row.failedAt,
          statusCheckedAt: checked ? at : row.statusCheckedAt,
          version: row.version + 1,
          updatedAt: at,
        })
        .where(and(eq(hiringLinkDeliveries.id, row.id), eq(hiringLinkDeliveries.version, row.version)))
        .returning({ id: hiringLinkDeliveries.id });
      if (!done || next === 'sent') return null;
      return this.audit.writeIn(tx, principal, {
        action: next === 'delivered' ? 'link_delivery_delivered' : 'link_delivery_failed',
        entityType: row.hiringCaseId ? 'hiring_case' : 'hiring_lead',
        entityId: (row.hiringCaseId ?? row.leadId) as string,
        entityLabel: row.recipient,
        summary: `${LINK_LABEL[row.linkKind as JourneyLinkKind]} SMS to ${row.recipient}: ${LINK_DELIVERY_STATUS_LABELS[next]}${next === 'failed' && update.errorCode ? ` (Twilio error ${update.errorCode})` : ''}`,
        changes: [{ field: 'delivery_status', old: current, new: next }],
        actorType: checked ? 'user' : 'system',
        actor: checked ? undefined : { id: 'twilio', name: 'Twilio' },
        at,
      });
    });
    if (event) await this.audit.publish(event);
  }

  // ------------------------------------------------------------------------ Twilio callback

  callbackUrl(deliveryId: string): string | null {
    const base = env.PUBLIC_APP_BASE_URL.replace(/\/+$/, '');
    // Twilio can only call a public HTTPS address; a local TMS checks status on demand instead.
    if (!base.startsWith('https://')) return null;
    return `${base}/api/v1/public/sms/twilio/status/${deliveryId}`;
  }

  /**
   * Twilio's status callback. Accepted only with a valid signature from the account that sent the
   * message and a MessageSid that matches it; anything else is answered 403 and changes nothing.
   */
  async callback(deliveryId: string, params: Record<string, string>, signature: string | undefined): Promise<{ status: number }> {
    if (!/^hld_[0-9a-f-]{36}$/.test(deliveryId)) return { status: 404 };
    const [row] = await this.db.select().from(hiringLinkDeliveries).where(eq(hiringLinkDeliveries.id, deliveryId)).limit(1);
    if (!row || row.channel !== 'sms' || !row.integrationAccountId) return { status: 404 };
    const url = this.callbackUrl(deliveryId);
    const account = await this.twilio.clientFor(row.companyId, row.integrationAccountId);
    if (!url || !account || !twilioSignatureValid(account.authToken, url, params, signature)) return { status: 403 };
    if (!params.MessageSid || params.MessageSid !== row.providerMessageId || !params.MessageStatus) return { status: 403 };
    const system: Principal = {
      userId: 'system',
      userName: 'Twilio',
      companyId: row.companyId,
      companyTimezone: 'America/New_York',
      weekStart: 0,
      roles: [],
      permissions: new Set(),
    };
    await this.apply(row, { providerStatus: params.MessageStatus, errorCode: params.ErrorCode || null, errorMessage: null }, system, false);
    return { status: 204 };
  }
}
