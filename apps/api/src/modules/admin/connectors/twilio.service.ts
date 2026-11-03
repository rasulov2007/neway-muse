import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SyncReport } from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import { DatabaseService } from '../../../database/database.service';
import { integrationAccounts } from '../../../database/schema/admin';
import { decrypt, type SealedCredential } from '../credential-vault';
import { env } from '../../../config/env';
import { senderReadiness, TwilioClient, TwilioError } from './twilio.client';

/** The company's SMS sender, ready to use, or exactly why there is none. */
export type SmsSender =
  | { ok: true; accountId: string; client: TwilioClient; from: string; label: string }
  | { ok: false; reason: string };

const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

/**
 * Twilio, the company's SMS account (Integrations → Communication). Credentials are the account's
 * own: the Account SID and sender in `config`, the auth token sealed in `credentials` and opened
 * only for the request that needs it. "Test" reads the account — the only way it earns
 * `connected`. There is nothing to sync; recruiting sends through `sender()`.
 */
@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  private open(row: { name: string; config: unknown; credentials: unknown }): { client: TwilioClient; from: string | null } {
    const config = (row.config ?? {}) as Record<string, string>;
    const sealed = ((row.credentials ?? {}) as Record<string, SealedCredential>).authToken;
    if (!config.accountSid) throw unprocessable(`${row.name} has no Account SID stored.`);
    if (!sealed) throw unprocessable(`${row.name} has no auth token stored.`);
    let token: string;
    try {
      token = decrypt(sealed);
    } catch {
      throw unprocessable('The stored auth token cannot be read: it was sealed under a different server secret. Replace the credential.');
    }
    return { client: new TwilioClient(config.accountSid, token), from: config.fromNumber?.trim() || null };
  }

  private async row(companyId: string, accountId: string) {
    const [row] = await this.db
      .select({
        id: integrationAccounts.id,
        provider: integrationAccounts.provider,
        name: integrationAccounts.name,
        status: integrationAccounts.status,
        config: integrationAccounts.config,
        credentials: integrationAccounts.credentials,
        errorCount: integrationAccounts.errorCount,
      })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.companyId, companyId), eq(integrationAccounts.id, accountId)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such integration account' });
    if (row.provider !== 'twilio') throw unprocessable(`${row.name} is a ${row.provider} account, not Twilio.`);
    return row;
  }

  /** Where Twilio should post replies (STOP / START) for this account: set as the number's messaging webhook. */
  inboundUrl(accountId: string): string {
    return `${env.PUBLIC_APP_BASE_URL.replace(/\/+$/, '')}/api/v1/public/sms/twilio/inbound/${accountId}`;
  }

  async test(principal: Principal, accountId: string): Promise<{ organisation: string }> {
    const row = await this.row(principal.companyId, accountId);
    const { client, from } = this.open(row);
    try {
      const account = await client.account();
      if (account.status !== 'active') throw new TwilioError(`The Twilio account is ${account.status}.`, 403, null, false);
      // The credential works; whether carriers will take texts from this sender is a separate fact.
      const readiness = from ? await senderReadiness(client, from) : { ready: false, detail: 'No sender number or Messaging Service SID stored.' };
      const config = { ...((row.config ?? {}) as Record<string, unknown>), senderReady: readiness.ready ? 'yes' : 'no', senderDetail: readiness.detail, senderCheckedAt: new Date().toISOString() };
      await this.db
        .update(integrationAccounts)
        .set({ status: 'connected', externalName: account.friendlyName, config, lastError: readiness.ready ? null : `Sender not ready: ${readiness.detail}`, errorCount: 0, updatedAt: new Date() })
        .where(eq(integrationAccounts.id, row.id));
      return {
        organisation: `${account.friendlyName} · ${readiness.ready ? `sender ready: ${readiness.detail}` : `SMS stays off — ${readiness.detail}`} · replies (STOP/START) webhook: ${this.inboundUrl(row.id)}`,
      };
    } catch (error) {
      await this.recordFailure(row.id, row.errorCount, error);
      const e = error as TwilioError;
      throw new AppError({ status: e.retryable ? 503 : 422, title: e.retryable ? 'Service Unavailable' : 'Unprocessable Entity', detail: `Twilio: ${e.message}` });
    }
  }

  sync(): Promise<SyncReport> {
    throw unprocessable('Twilio sends messages; there is nothing to sync.');
  }

  /**
   * The account recruiting sends through: the first usable Twilio account (connected first). Not
   * usable: disabled, refused by Twilio on its last test, or missing the sender.
   */
  async sender(companyId: string): Promise<SmsSender> {
    const rows = await this.db
      .select({
        id: integrationAccounts.id,
        name: integrationAccounts.name,
        status: integrationAccounts.status,
        config: integrationAccounts.config,
        credentials: integrationAccounts.credentials,
      })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.companyId, companyId), eq(integrationAccounts.provider, 'twilio'), inArray(integrationAccounts.status, ['connected', 'credentials_stored', 'error'])))
      .orderBy(asc(integrationAccounts.createdAt));
    if (rows.length === 0) return { ok: false, reason: 'SMS is not set up: no Twilio account in Settings › Integrations.' };
    const usable = rows.filter((r) => r.status === 'connected');
    if (usable.length === 0) {
      const errored = rows.find((r) => r.status === 'error');
      return {
        ok: false,
        reason: errored
          ? `SMS is off: Twilio refused ${errored.name} on its last test. Fix the credential in Settings › Integrations.`
          : 'SMS is not ready: the Twilio account has not passed "Test connection" in Settings › Integrations.',
      };
    }
    const row = usable[0]!;
    try {
      const { client, from } = this.open(row);
      if (!from) return { ok: false, reason: `SMS is not ready: ${row.name} has no sender number or Messaging Service SID.` };
      const config = (row.config ?? {}) as Record<string, string>;
      if (config.senderReady !== 'yes') {
        return { ok: false, reason: `SMS is not ready: ${config.senderDetail ?? 'the sender has not been checked'} Run "Test" in Settings › Integrations after Twilio approves the sender.` };
      }
      const masked = from.startsWith('MG') ? 'Messaging Service' : `${from.slice(0, 5)}…${from.slice(-2)}`;
      return { ok: true, accountId: row.id, client, from, label: `Twilio · ${masked}` };
    } catch (error) {
      return { ok: false, reason: (error as AppError).message || 'The Twilio credential cannot be read.' };
    }
  }

  /** The company a Twilio account belongs to (for the public reply webhook, which names the account). */
  async companyOf(accountId: string): Promise<string | null> {
    if (!/^int_[0-9a-f-]{36}$/.test(accountId)) return null;
    const [row] = await this.db
      .select({ companyId: integrationAccounts.companyId, provider: integrationAccounts.provider })
      .from(integrationAccounts)
      .where(eq(integrationAccounts.id, accountId))
      .limit(1);
    return row?.provider === 'twilio' ? row.companyId : null;
  }

  /** For checking a status callback's signature: the account that sent the message. */
  async clientFor(companyId: string, accountId: string): Promise<{ client: TwilioClient; authToken: string } | null> {
    try {
      const row = await this.row(companyId, accountId);
      const sealed = ((row.credentials ?? {}) as Record<string, SealedCredential>).authToken;
      if (!sealed) return null;
      return { client: this.open(row).client, authToken: decrypt(sealed) };
    } catch (error) {
      this.logger.warn(`twilio account unavailable for a callback: ${(error as Error).name}`);
      return null;
    }
  }

  private async recordFailure(accountId: string, errorCount: number, error: unknown): Promise<void> {
    const refused = error instanceof TwilioError && !error.retryable;
    await this.db
      .update(integrationAccounts)
      .set({
        ...(refused ? { status: 'error' } : {}),
        lastError: error instanceof Error ? error.message : String(error),
        errorCount: errorCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, accountId));
  }
}
