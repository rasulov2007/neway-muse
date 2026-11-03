import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SyncReport } from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import { DatabaseService } from '../../../database/database.service';
import { integrationAccounts } from '../../../database/schema/admin';
import { decrypt, type SealedCredential } from '../credential-vault';
import { AzureSpeechClient, AzureSpeechError } from './azure-speech.client';

/** The Uzbek voice when the account names none. uz-UZ-MadinaNeural is the female one. */
export const DEFAULT_UZ_VOICE = 'uz-UZ-SardorNeural';

export interface Speaker {
  accountId: string;
  client: AzureSpeechClient;
  voiceUz: string;
}

const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

/**
 * Azure Speech, the company's text-to-speech account (Integrations → AI & voice). The region and
 * the Uzbek voice live in `config`; the key is sealed in `credentials` and opened only for the
 * request that needs it. "Test" lists the region's voices — the only way it earns `connected` —
 * and checks that an Uzbek one is there. There is nothing to sync; NeWay AI speaks through
 * `speaker()`.
 */
@Injectable()
export class AzureSpeechService {
  private fetchImpl: typeof fetch | undefined;

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** Tests answer for Azure; production leaves this alone. */
  setFetch(fetchImpl: typeof fetch | undefined): void {
    this.fetchImpl = fetchImpl;
  }

  private open(row: { name: string; config: unknown; credentials: unknown }): Omit<Speaker, 'accountId'> {
    const config = (row.config ?? {}) as Record<string, string>;
    const sealed = ((row.credentials ?? {}) as Record<string, SealedCredential>).key;
    const region = (config.region ?? '').trim().toLowerCase();
    if (!region) throw unprocessable(`${row.name} has no region stored.`);
    if (!sealed) throw unprocessable(`${row.name} has no Speech key stored.`);
    let key: string;
    try {
      key = decrypt(sealed);
    } catch {
      throw unprocessable('The stored Speech key cannot be read: it was sealed under a different server secret. Replace the credential.');
    }
    let client: AzureSpeechClient;
    try {
      client = new AzureSpeechClient(key, region, { fetchImpl: this.fetchImpl });
    } catch (error) {
      throw unprocessable((error as Error).message);
    }
    return { client, voiceUz: config.voiceUz?.trim() || DEFAULT_UZ_VOICE };
  }

  private async row(companyId: string, accountId: string) {
    const [row] = await this.db
      .select({
        id: integrationAccounts.id,
        provider: integrationAccounts.provider,
        name: integrationAccounts.name,
        config: integrationAccounts.config,
        credentials: integrationAccounts.credentials,
        errorCount: integrationAccounts.errorCount,
      })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.companyId, companyId), eq(integrationAccounts.id, accountId)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such integration account' });
    if (row.provider !== 'azure_speech') throw unprocessable(`${row.name} is a ${row.provider} account, not Azure Speech.`);
    return row;
  }

  async test(principal: Principal, accountId: string): Promise<{ organisation: string }> {
    const row = await this.row(principal.companyId, accountId);
    const { client, voiceUz } = this.open(row);
    try {
      const voices = await client.voices();
      const uzbek = voices.filter((v) => v.locale.toLowerCase() === 'uz-uz');
      if (uzbek.length === 0) throw new AzureSpeechError('This region offers no Uzbek (uz-UZ) voice. Use a region that does, e.g. eastus.', 422, false);
      const chosen = uzbek.some((v) => v.shortName === voiceUz);
      const config = (row.config ?? {}) as Record<string, string>;
      await this.db
        .update(integrationAccounts)
        .set({
          status: 'connected',
          externalName: `Azure Speech · ${config.region}`,
          lastError: chosen ? null : `${voiceUz} is not offered here; Uzbek voices: ${uzbek.map((v) => v.shortName).join(', ')}`,
          errorCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(integrationAccounts.id, row.id));
      return { organisation: `Azure Speech · ${config.region} · ${voices.length} voices · Uzbek: ${uzbek.map((v) => v.shortName).join(', ')}${chosen ? '' : ` (${voiceUz} is not among them)`}` };
    } catch (error) {
      await this.recordFailure(row.id, row.errorCount, error);
      const e = error instanceof AzureSpeechError ? error : new AzureSpeechError('Azure Speech failed.', 0, true);
      throw new AppError({ status: e.retryable ? 503 : 422, title: e.retryable ? 'Service Unavailable' : 'Unprocessable Entity', detail: `Azure Speech: ${e.message}` });
    }
  }

  sync(): Promise<SyncReport> {
    throw unprocessable('Azure Speech reads answers aloud; there is nothing to sync.');
  }

  /**
   * The account NeWay AI speaks through: the first usable one (connected before merely stored), or
   * null when the company has none. Disabled, refused and archived accounts are never used.
   */
  async speaker(companyId: string): Promise<Speaker | null> {
    const rows = await this.db
      .select({
        id: integrationAccounts.id,
        name: integrationAccounts.name,
        status: integrationAccounts.status,
        config: integrationAccounts.config,
        credentials: integrationAccounts.credentials,
      })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.companyId, companyId), eq(integrationAccounts.provider, 'azure_speech'), inArray(integrationAccounts.status, ['connected', 'credentials_stored'])))
      .orderBy(asc(integrationAccounts.createdAt));
    const ordered = [...rows.filter((r) => r.status === 'connected'), ...rows.filter((r) => r.status !== 'connected')];
    for (const row of ordered) {
      try {
        return { accountId: row.id, ...this.open(row) };
      } catch {
        // Unreadable or incomplete: try the next account.
      }
    }
    return null;
  }

  /** A refusal from Azure while speaking: counted on the account, so Integrations shows it. */
  async recordFailure(accountId: string, errorCount: number | null, error: unknown): Promise<void> {
    const refused = error instanceof AzureSpeechError && !error.retryable && (error.status === 401 || error.status === 403);
    const [current] = errorCount === null ? await this.db.select({ errorCount: integrationAccounts.errorCount }).from(integrationAccounts).where(eq(integrationAccounts.id, accountId)).limit(1) : [{ errorCount }];
    await this.db
      .update(integrationAccounts)
      .set({
        ...(refused ? { status: 'error' } : {}),
        lastError: error instanceof Error ? error.message : 'Azure Speech failed.',
        errorCount: (current?.errorCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, accountId));
  }
}
