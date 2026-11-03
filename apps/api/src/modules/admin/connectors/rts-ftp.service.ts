import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { Client, FTPError } from 'basic-ftp';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { RTS_FTP_HOST, type SyncReport } from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import { DatabaseService } from '../../../database/database.service';
import { integrationAccounts } from '../../../database/schema/admin';
import { decrypt, type SealedCredential } from '../credential-vault';
import { rtsTlsOptions } from './rts-tls';

const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

/** A connected RTS FTPS account, ready to upload to - or exactly why there is none. */
export type RtsUploader =
  | { ok: true; accountId: string; name: string; clientNumber: string; host: string; /** RTS's test folder: upload, mark nothing. */ test: boolean }
  | { ok: false; reason: string };

interface Opened {
  host: string;
  user: string;
  password: string;
}

/**
 * RTS Financial over FTPS (Integrations → Accounting). RTS takes invoices one way only: PDFs into
 * the client's folder, then the CSV that triggers them. The client number (the FTP username) and
 * the server sit in `config`; the password is sealed in `credentials` and opened only for the
 * session that uses it. "Test" logs in and lists the folder - the only way it earns `connected`.
 */
@Injectable()
export class RtsFtpService {
  private readonly logger = new Logger(RtsFtpService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  private open(row: { name: string; config: unknown; credentials: unknown }): Opened {
    const config = (row.config ?? {}) as Record<string, string>;
    const sealed = ((row.credentials ?? {}) as Record<string, SealedCredential>).password;
    if (!config.clientNumber) throw unprocessable(`${row.name} has no client number stored.`);
    if (!sealed) throw unprocessable(`${row.name} has no password stored.`);
    let password: string;
    try {
      password = decrypt(sealed);
    } catch {
      throw unprocessable('The stored RTS password cannot be read: it was sealed under a different server secret. Replace the credential.');
    }
    return { host: config.host?.trim() || RTS_FTP_HOST, user: config.clientNumber.trim(), password };
  }

  /** Logs in over explicit FTPS (port 21), runs `work`, and always closes the session. */
  private async session<T>(o: Opened, work: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client(60_000);
    try {
      // An RTS alias host is verified against RTS's canonical certificate name; see rts-tls.ts.
      await client.access({ host: o.host, port: 21, user: o.user, password: o.password, secure: true, secureOptions: rtsTlsOptions(o.host) });
      return await work(client);
    } finally {
      client.close();
    }
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
    if (row.provider !== 'rts') throw unprocessable(`${row.name} is a ${row.provider} account, not RTS.`);
    return row;
  }

  async test(principal: Principal, accountId: string): Promise<{ organisation: string }> {
    const row = await this.row(principal.companyId, accountId);
    const o = this.open(row);
    try {
      const listing = await this.session(o, (c) => c.list());
      await this.db
        .update(integrationAccounts)
        .set({ status: 'connected', externalName: `${o.user} @ ${o.host}`, lastError: null, errorCount: 0, updatedAt: new Date() })
        .where(eq(integrationAccounts.id, row.id));
      return { organisation: `Logged in to ${o.host} as ${o.user} · ${listing.length} file(s) waiting in the folder` };
    } catch (error) {
      await this.recordFailure(row.id, row.errorCount, error);
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `RTS FTPS: ${(error as Error).message}` });
    }
  }

  sync(): Promise<SyncReport> {
    throw unprocessable('RTS takes uploads only; there is nothing to sync. Send invoices from Accounting › RTS batches.');
  }

  /** The account Accounting uploads through: the first RTS account that passed "Test". */
  async uploader(companyId: string): Promise<RtsUploader> {
    const rows = await this.db
      .select({ id: integrationAccounts.id, name: integrationAccounts.name, status: integrationAccounts.status, config: integrationAccounts.config })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.companyId, companyId), eq(integrationAccounts.provider, 'rts'), inArray(integrationAccounts.status, ['connected', 'credentials_stored', 'error'])))
      .orderBy(asc(integrationAccounts.createdAt));
    if (rows.length === 0) return { ok: false, reason: 'RTS is not set up: add the RTS FTPS account in Settings › Integrations.' };
    const row = rows.find((r) => r.status === 'connected');
    if (!row) return { ok: false, reason: 'RTS is not ready: the RTS account has not passed "Test" in Settings › Integrations.' };
    const config = (row.config ?? {}) as Record<string, string>;
    const env = (config.environment ?? '').trim().toLowerCase();
    if (env !== 'test' && env !== 'production') return { ok: false, reason: `${row.name}: set Environment to test or production in Settings › Integrations.` };
    return { ok: true, accountId: row.id, name: row.name, clientNumber: (config.clientNumber ?? '').trim(), host: config.host?.trim() || RTS_FTP_HOST, test: env === 'test' };
  }

  /** The client number on the company's RTS account, connected or not - for the CSV of a test export. */
  async clientNumberOf(companyId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ config: integrationAccounts.config })
      .from(integrationAccounts)
      // An archived account (an old, emptied RTS row) must not lend its client number to an export.
      .where(and(eq(integrationAccounts.companyId, companyId), eq(integrationAccounts.provider, 'rts'), ne(integrationAccounts.status, 'archived')))
      .orderBy(asc(integrationAccounts.createdAt))
      .limit(1);
    return ((row?.config ?? {}) as Record<string, string>).clientNumber?.trim() || null;
  }

  /**
   * One submission: every PDF first, then the CSV - RTS takes the folder when the CSV lands, so
   * a PDF after it could be left behind. Stops at the first failure and says which file; the CSV
   * is never sent unless every PDF went.
   */
  async upload(companyId: string, accountId: string, pdfs: Array<{ name: string; data: Buffer }>, csv: { name: string; data: Buffer }): Promise<{ uploaded: string[] }> {
    const row = await this.row(companyId, accountId);
    const o = this.open(row);
    const uploaded: string[] = [];
    try {
      await this.session(o, async (c) => {
        for (const f of pdfs) {
          await c.uploadFrom(Readable.from(f.data), f.name);
          uploaded.push(f.name);
        }
        await c.uploadFrom(Readable.from(csv.data), csv.name);
        uploaded.push(csv.name);
      });
      return { uploaded };
    } catch (error) {
      await this.recordFailure(row.id, row.errorCount, error);
      const at = uploaded.length < pdfs.length ? pdfs[uploaded.length]?.name : csv.name;
      this.logger.warn({ companyId, at, sent: uploaded.length, error: String(error) }, 'RTS upload failed');
      throw new AppError({
        status: 502,
        title: 'Bad Gateway',
        detail: `RTS upload stopped at ${at}: ${(error as Error).message}. ${uploaded.length} file(s) reached RTS; the CSV ${uploaded.includes(csv.name) ? 'was' : 'was not'} sent, so RTS ${uploaded.includes(csv.name) ? 'has' : 'has not'} taken this submission.`,
      });
    }
  }

  private async recordFailure(accountId: string, errorCount: number, error: unknown): Promise<void> {
    // 530 = login refused: the credential is wrong, not the network.
    const refused = error instanceof FTPError && error.code === 530;
    await this.db
      .update(integrationAccounts)
      .set({ ...(refused ? { status: 'error' } : {}), lastError: error instanceof Error ? error.message : String(error), errorCount: errorCount + 1, updatedAt: new Date() })
      .where(eq(integrationAccounts.id, accountId));
  }
}
