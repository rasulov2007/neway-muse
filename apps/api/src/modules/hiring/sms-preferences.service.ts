import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { toE164, type SmsConsentView, type SmsOptInSource } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { smsPreferences, type SmsPreferenceRow } from '../../database/schema/hiring';
import { twilioSignatureValid } from '../admin/connectors/twilio.client';
import { TwilioService } from '../admin/connectors/twilio.service';
import { AuditService } from '../people/audit.service';

/** Carrier and Twilio opt-out words (Twilio Advanced Opt-Out uses the same list). */
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES', 'OPTIN']);

const conflict = (detail: string) => new AppError({ status: 409, title: 'Conflict', detail });

/**
 * Texting consent per phone number (owner brief, 2026-10-11). Staff record how a person agreed to
 * texts (opt-in); the person's own STOP ends it and only their START brings it back. A text goes
 * only to a number with an opt-in and no STOP after it. Replies arrive on Twilio's messaging webhook
 * (signed by the account), and Twilio's "recipient unsubscribed" refusal (21610) counts as a STOP.
 */
@Injectable()
export class SmsPreferencesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly twilio: TwilioService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async row(companyId: string, phone: string): Promise<SmsPreferenceRow | null> {
    const [row] = await this.db.select().from(smsPreferences).where(and(eq(smsPreferences.companyId, companyId), eq(smsPreferences.phone, phone))).limit(1);
    return row ?? null;
  }

  async view(companyId: string, rawPhone: string | null): Promise<SmsConsentView> {
    const phone = rawPhone ? toE164(rawPhone) : null;
    const empty: SmsConsentView = { phone, status: 'none', optedInAt: null, optedInBy: null, optedInSource: null, optedOutAt: null, optedOutSource: null };
    if (!phone) return empty;
    const r = await this.row(companyId, phone);
    if (!r) return empty;
    return {
      phone,
      status: r.status as 'opted_in' | 'opted_out',
      optedInAt: r.optedInAt?.toISOString() ?? null,
      optedInBy: r.optedInBy,
      optedInSource: (r.optedInSource as SmsOptInSource | null) ?? null,
      optedOutAt: r.optedOutAt?.toISOString() ?? null,
      optedOutSource: r.optedOutSource,
    };
  }

  /** Why this number may not be texted, or null when it may. */
  async refusal(companyId: string, phone: string): Promise<string | null> {
    const r = await this.row(companyId, phone);
    if (!r) return 'No texting consent is recorded for this number. Record how the candidate agreed to texts first, or send by email.';
    if (r.status === 'opted_out') {
      const when = r.optedOutAt?.toISOString().slice(0, 10) ?? '';
      return r.optedOutSource === 'staff'
        ? `Texts were turned off by staff on ${when}.`
        : `The candidate opted out of texts (STOP) on ${when}; only their own START turns texts back on.`;
    }
    return null;
  }

  private async write(
    companyId: string,
    phone: string,
    patch: Partial<typeof smsPreferences.$inferInsert> & { status: string },
    audit: { principal: Principal; summary: string; system?: boolean },
  ): Promise<void> {
    const at = new Date();
    const before = await this.row(companyId, phone);
    const event = await this.db.transaction(async (tx) => {
      if (before) {
        await tx
          .update(smsPreferences)
          .set({ ...patch, updatedAt: at, version: before.version + 1 })
          .where(and(eq(smsPreferences.companyId, companyId), eq(smsPreferences.phone, phone)));
      } else {
        await tx.insert(smsPreferences).values({ companyId, phone, ...patch, updatedAt: at });
      }
      return this.audit.writeIn(tx, audit.principal, {
        action: patch.status === 'opted_in' ? 'sms_opt_in' : 'sms_opt_out',
        entityType: 'sms_preference',
        entityId: phone,
        entityLabel: phone,
        summary: audit.summary,
        changes: [{ field: 'sms_status', old: before?.status ?? 'none', new: patch.status }],
        actorType: audit.system ? 'system' : 'user',
        actor: audit.system ? { id: 'twilio', name: 'Twilio (reply)' } : undefined,
        at,
      });
    });
    await this.audit.publish(event);
  }

  /** Staff record the person's consent, or turn texts off on their request. A STOP is never overridden. */
  async setByStaff(principal: Principal, rawPhone: string, input: { action: 'opt_in' | 'opt_out'; source: SmsOptInSource | null; note: string | null }): Promise<void> {
    const phone = toE164(rawPhone);
    if (!phone) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `"${rawPhone}" is not a phone number the TMS can text.` });
    const current = await this.row(principal.companyId, phone);
    const by = principal.userName ?? principal.userId;
    if (input.action === 'opt_in') {
      if (!input.source) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Say how the candidate agreed to texts.' });
      if (current?.status === 'opted_out' && current.optedOutSource !== 'staff') {
        throw conflict('The candidate replied STOP. Only their own START reply turns texts back on.');
      }
      await this.write(
        principal.companyId,
        phone,
        { status: 'opted_in', optedInAt: new Date(), optedInBy: by, optedInSource: input.source, optedInNote: input.note },
        { principal, summary: `Texting consent recorded for ${phone} (${input.source.replace(/_/g, ' ')})${input.note ? `: ${input.note}` : ''}` },
      );
      return;
    }
    await this.write(principal.companyId, phone, { status: 'opted_out', optedOutAt: new Date(), optedOutSource: 'staff' }, { principal, summary: `Texts to ${phone} turned off by ${by}${input.note ? `: ${input.note}` : ''}` });
  }

  /**
   * The public application's consent named SMS: the driver opted in when they applied. Recorded only
   * when nothing is on file — an earlier STOP (or a staff record) is never overwritten.
   */
  async optInFromApplication(principal: Principal, rawPhone: string, consentText: string): Promise<void> {
    const phone = toE164(rawPhone);
    if (!phone || (await this.row(principal.companyId, phone))) return;
    await this.write(
      principal.companyId,
      phone,
      { status: 'opted_in', optedInAt: new Date(), optedInBy: 'The driver (online application)', optedInSource: 'applied_online', optedInNote: consentText.slice(0, 300) },
      { principal, summary: `${phone} agreed to texts on the online application`, system: true },
    );
  }

  /** Twilio refused a send because the person unsubscribed (error 21610): that is their STOP. */
  async carrierOptOut(principal: Principal, phone: string): Promise<void> {
    await this.write(principal.companyId, phone, { status: 'opted_out', optedOutAt: new Date(), optedOutSource: 'carrier' }, { principal, summary: `${phone} has unsubscribed from texts (Twilio 21610)` });
  }

  private system(companyId: string): Principal {
    return { userId: 'system', userName: 'Twilio', companyId, companyTimezone: 'America/New_York', weekStart: 0, roles: [], permissions: new Set() };
  }

  /**
   * A reply to the company's Twilio number. Believed only with the account's signature. STOP-type
   * words opt the number out, START-type words opt it back in; anything else changes nothing.
   */
  async inbound(accountId: string, params: Record<string, string>, signature: string | undefined): Promise<{ status: number }> {
    const companyId = await this.twilio.companyOf(accountId);
    if (!companyId) return { status: 404 };
    const account = await this.twilio.clientFor(companyId, accountId);
    const url = `${env.PUBLIC_APP_BASE_URL.replace(/\/+$/, '')}/api/v1/public/sms/twilio/inbound/${accountId}`;
    if (!account || !twilioSignatureValid(account.authToken, url, params, signature)) return { status: 403 };
    const phone = params.From ? toE164(params.From) : null;
    if (!phone) return { status: 200 };
    const word = (params.OptOutType || params.Body || '').trim().toUpperCase().split(/\s+/)[0] ?? '';
    const principal = this.system(companyId);
    if (STOP_WORDS.has(word)) {
      await this.write(companyId, phone, { status: 'opted_out', optedOutAt: new Date(), optedOutSource: 'reply_stop' }, { principal, summary: `${phone} replied ${word}: no more texts`, system: true });
    } else if (START_WORDS.has(word)) {
      const before = await this.row(companyId, phone);
      await this.write(
        companyId,
        phone,
        { status: 'opted_in', optedInAt: new Date(), optedInBy: 'The candidate (START reply)', optedInSource: before?.optedInSource ?? 'texted_first' },
        { principal, summary: `${phone} replied ${word}: texts back on`, system: true },
      );
    }
    return { status: 200 };
  }
}
