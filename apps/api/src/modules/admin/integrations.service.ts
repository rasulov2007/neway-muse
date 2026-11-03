import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import {
  ANY_CONNECTOR_IMPLEMENTED,
  credentialHint,
  INTEGRATION_PROVIDERS,
  integrationProvider,
  type IntegrationAccount,
  type IntegrationProvider,
  type SyncRun,
  type SyncSummary,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { integrationAccounts, integrationSyncRuns } from '../../database/schema/admin';
import { AuditService } from '../people/audit.service';
import { sealAll } from './credential-vault';

/** A provider and every account the company holds with it. */
export interface IntegrationView extends IntegrationProvider {
  /** The live accounts. Archived ones are not here: they are hidden, never synced, never counted. */
  accounts: IntegrationAccount[];
  /** Archived accounts, kept on record; the page shows them only behind "Show archived". */
  archivedAccounts: IntegrationAccount[];
}

/** An account nobody uses any more: no credential, hidden from the list, kept, reversible. */
export const ARCHIVED = 'archived';

/**
 * Integrations.
 *
 * Stores credentials encrypted at rest, records what is configured, and shows an administrator
 * which key is in place without ever showing them the key. A company may hold several accounts
 * with one provider — two Samsara organisations are two rows — and every operation here is keyed
 * on the account, never on the provider.
 *
 * Syncing is the connector's job (`connectors/`), not this class's. What this class knows about
 * a sync is what the connector wrote back: status, last run, last error, the counts.
 *
 * The security rules are structural rather than remembered:
 *   - `credentials` is never in a select list. Not in list, not in detail, not in export.
 *   - the only value that leaves the server is `credentialHint`, four characters, computed once at
 *     write time.
 *   - the audit entry for a credential change records that it changed, never to what.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * The columns a client may see.
   *
   * Written out rather than `select()` precisely so `credentials` cannot be added to the response
   * by someone later adding a column to the table.
   */
  private readonly visible = {
    id: integrationAccounts.id,
    provider: integrationAccounts.provider,
    name: integrationAccounts.name,
    category: integrationAccounts.category,
    status: integrationAccounts.status,
    credentialHint: integrationAccounts.credentialHint,
    credentialUpdatedAt: integrationAccounts.credentialUpdatedAt,
    config: integrationAccounts.config,
    externalName: integrationAccounts.externalName,
    lastSyncAt: integrationAccounts.lastSyncAt,
    lastSuccessAt: integrationAccounts.lastSuccessAt,
    lastError: integrationAccounts.lastError,
    lastSummary: integrationAccounts.lastSummary,
    errorCount: integrationAccounts.errorCount,
    createdAt: integrationAccounts.createdAt,
  };

  async list(principal: Principal): Promise<{
    integrations: IntegrationView[];
    connectorsImplemented: boolean;
    note: string;
  }> {
    const rows = await this.db
      .select(this.visible)
      .from(integrationAccounts)
      .where(eq(integrationAccounts.companyId, principal.companyId))
      .orderBy(integrationAccounts.createdAt);

    return {
      integrations: INTEGRATION_PROVIDERS.map((provider) => ({
        ...provider,
        accounts: rows
          .filter((r) => r.provider === provider.provider && r.status !== ARCHIVED)
          .map((r) => this.toAccount(r)),
        archivedAccounts: rows
          .filter((r) => r.provider === provider.provider && r.status === ARCHIVED)
          .map((r) => this.toAccount(r)),
      })),
      connectorsImplemented: ANY_CONNECTOR_IMPLEMENTED,
      note: 'Samsara, Motive and Five ELD sync vehicles, odometers and positions into the roster, read-only. Every other provider stores a credential and nothing more until its connector is built.',
    };
  }

  /** One account, with its provider's definition. */
  async get(principal: Principal, accountId: string): Promise<IntegrationView & { account: IntegrationAccount }> {
    const row = await this.row(principal, accountId);
    const definition = integrationProvider(row.provider);
    if (!definition) {
      throw new AppError({ status: 500, title: 'Internal Server Error', detail: `Unknown provider ${row.provider}` });
    }
    const account = this.toAccount(row);
    return {
      ...definition,
      accounts: row.status === ARCHIVED ? [] : [account],
      archivedAccounts: row.status === ARCHIVED ? [account] : [],
      account,
    };
  }

  /**
   * Adds an account.
   *
   * Always a new row. A second Samsara is a second account with its own token and its own sync
   * state; replacing the key on an existing one is `replaceCredential`. There is no "connect the
   * provider", because the provider is not the thing that has a token — the account is.
   */
  async connect(
    principal: Principal,
    input: { provider: string; name?: string; credentials: Record<string, string> },
  ): Promise<IntegrationView & { account: IntegrationAccount }> {
    const definition = this.definition(input.provider);
    const { secrets, config, hint } = this.split(definition, input.credentials);

    const siblings = await this.db
      .select({ id: integrationAccounts.id })
      .from(integrationAccounts)
      .where(
        and(
          eq(integrationAccounts.companyId, principal.companyId),
          eq(integrationAccounts.provider, definition.provider),
        ),
      );
    const name =
      input.name?.trim() || (siblings.length === 0 ? definition.name : `${definition.name} ${siblings.length + 1}`);

    const now = new Date();
    const id = `int_${crypto.randomUUID()}`;
    await this.db.insert(integrationAccounts).values({
      id,
      companyId: principal.companyId,
      provider: definition.provider,
      category: definition.category,
      name,
      status: 'credentials_stored',
      config,
      credentials: sealAll(secrets),
      credentialHint: hint,
      credentialUpdatedAt: now,
    });

    // The summary says a credential was stored. It does not say what, and the `changes` array
    // carries no value — an audit trail that records secrets is a second place they leak.
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'integration',
      entityId: id,
      entityLabel: name,
      summary: `${name} (${definition.name}) added with a credential`,
      changes: [{ field: 'credential', old: null, new: 'new credential stored' }],
    });

    return this.get(principal, id);
  }

  /** Replaces the credential on one account. The only edit a secret has. */
  async replaceCredential(
    principal: Principal,
    accountId: string,
    credentials: Record<string, string>,
  ): Promise<IntegrationView & { account: IntegrationAccount }> {
    const row = await this.row(principal, accountId);
    this.refuseArchived(row);
    const definition = this.definition(row.provider);
    const { secrets, config, hint } = this.split(definition, credentials);
    const now = new Date();

    await this.db
      .update(integrationAccounts)
      .set({
        credentials: sealAll(secrets),
        credentialHint: hint,
        credentialUpdatedAt: now,
        config,
        // A new key has not been tried yet; `connected` is earned again by the next request.
        status: 'credentials_stored',
        lastError: null,
        errorCount: 0,
        updatedAt: now,
      })
      .where(eq(integrationAccounts.id, row.id));

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'integration',
      entityId: row.id,
      entityLabel: row.name,
      summary: `Credential replaced for ${row.name}`,
      changes: [{ field: 'credential', old: row.credentialHint ? 'previous credential' : null, new: 'new credential stored' }],
    });
    return this.get(principal, row.id);
  }

  async rename(principal: Principal, accountId: string, name: string): Promise<IntegrationView & { account: IntegrationAccount }> {
    const row = await this.row(principal, accountId);
    await this.db
      .update(integrationAccounts)
      .set({ name: name.trim(), updatedAt: new Date() })
      .where(eq(integrationAccounts.id, row.id));
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'integration',
      entityId: row.id,
      entityLabel: name.trim(),
      summary: `Integration account renamed`,
      changes: [{ field: 'name', old: row.name, new: name.trim() }],
    });
    return this.get(principal, row.id);
  }

  async setStatus(
    principal: Principal,
    accountId: string,
    status: 'credentials_stored' | 'disabled',
  ): Promise<IntegrationView & { account: IntegrationAccount }> {
    const row = await this.row(principal, accountId);
    this.refuseArchived(row);
    if (status === 'credentials_stored' && !row.credentialHint) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'No credential is stored for this account. Add one first.',
      });
    }
    await this.db
      .update(integrationAccounts)
      .set({ status, updatedAt: new Date() })
      .where(eq(integrationAccounts.id, row.id));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'integration',
      entityId: row.id,
      entityLabel: row.name,
      summary: `${row.name}: ${row.status} → ${status}`,
      changes: [{ field: 'status', old: row.status, new: status }],
    });
    return this.get(principal, row.id);
  }

  /**
   * Removes the stored credential.
   *
   * The account row stays, with its history and its sync runs. Only the secret is destroyed —
   * deleting the row would also delete the record that this account was ever configured, which is
   * exactly what an audit needs to keep.
   */
  async disconnect(principal: Principal, accountId: string): Promise<IntegrationView & { account: IntegrationAccount }> {
    const row = await this.row(principal, accountId);
    await this.db
      .update(integrationAccounts)
      .set({
        credentials: null,
        credentialHint: null,
        credentialUpdatedAt: null,
        status: 'not_configured',
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, row.id));

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'integration',
      entityId: row.id,
      entityLabel: row.name,
      summary: `Credential removed from ${row.name}`,
      changes: [{ field: 'credential', old: 'stored credential', new: null }],
    });
    return this.get(principal, row.id);
  }

  /**
   * Archives an account that holds no credential.
   *
   * The row stays — with its name, configuration, history and sync runs — and only its status
   * changes, so it is hidden from the list, never synced and never counted, and Unarchive puts it
   * back. An account with a credential must have it removed first: archiving must not hide a live
   * secret.
   */
  async archive(
    principal: Principal,
    accountId: string,
    reason?: string,
  ): Promise<IntegrationView & { account: IntegrationAccount }> {
    const row = await this.row(principal, accountId);
    if (row.status === ARCHIVED) return this.get(principal, row.id);
    if (row.credentialHint || row.credentialUpdatedAt || (await this.holdsCredential(row.id))) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Remove the credential first',
      });
    }
    const why = reason?.trim() || null;
    await this.db
      .update(integrationAccounts)
      .set({ status: ARCHIVED, updatedAt: new Date() })
      .where(and(eq(integrationAccounts.id, row.id), eq(integrationAccounts.status, row.status)));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'integration',
      entityId: row.id,
      entityLabel: row.name,
      summary: why ? `${row.name} archived: ${why}` : `${row.name} archived`,
      changes: [{ field: 'status', old: row.status, new: ARCHIVED }],
      reason: why,
    });
    return this.get(principal, row.id);
  }

  /** Brings an archived account back to the list, as an account with no credential. */
  async unarchive(principal: Principal, accountId: string): Promise<IntegrationView & { account: IntegrationAccount }> {
    const row = await this.row(principal, accountId);
    if (row.status !== ARCHIVED) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This account is not archived' });
    }
    await this.db
      .update(integrationAccounts)
      .set({ status: 'not_configured', updatedAt: new Date() })
      .where(and(eq(integrationAccounts.id, row.id), eq(integrationAccounts.status, ARCHIVED)));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'integration',
      entityId: row.id,
      entityLabel: row.name,
      summary: `${row.name} unarchived`,
      changes: [{ field: 'status', old: ARCHIVED, new: 'not_configured' }],
    });
    return this.get(principal, row.id);
  }

  /** Sync history for one account, newest first. */
  async syncRuns(principal: Principal, accountId: string, limit = 25): Promise<SyncRun[]> {
    const row = await this.row(principal, accountId);
    const runs = await this.db
      .select()
      .from(integrationSyncRuns)
      .where(
        and(
          eq(integrationSyncRuns.companyId, principal.companyId),
          eq(integrationSyncRuns.integrationAccountId, row.id),
        ),
      )
      .orderBy(desc(integrationSyncRuns.startedAt))
      .limit(limit);
    return runs.map((run) => ({
      id: run.id,
      direction: run.direction,
      entity: run.entity,
      status: run.status,
      records: run.records,
      durationMs: run.durationMs,
      error: run.error,
      summary: (run.summary as SyncSummary | null) ?? null,
      startedAt: run.startedAt.toISOString(),
    }));
  }

  // ------------------------------------------------------------------------------ helpers

  private definition(provider: string): IntegrationProvider {
    const definition = integrationProvider(provider);
    if (!definition) {
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: `${provider} is not a provider this system knows about`,
      });
    }
    return definition;
  }

  /** Validates the fields a provider asks for and separates the secrets from the configuration. */
  private split(
    definition: IntegrationProvider,
    credentials: Record<string, string>,
  ): { secrets: Record<string, string>; config: Record<string, string>; hint: string | null } {
    const missing = definition.credentialFields.filter((field) => !field.optional && !credentials[field.name]?.trim());
    if (missing.length > 0) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `Missing: ${missing.map((field) => field.label).join(', ')}`,
        extensions: { errors: missing.map((field) => ({ field: field.name, message: 'Required' })) },
      });
    }
    const secrets: Record<string, string> = {};
    const config: Record<string, string> = {};
    for (const field of definition.credentialFields) {
      const value = credentials[field.name]?.trim() ?? '';
      // A blank optional field is not stored: the connector falls back to its default.
      if (field.optional && !value) continue;
      if (field.kind === 'secret') secrets[field.name] = value;
      else config[field.name] = value;
    }
    // The hint comes from the first secret field only, and is four characters. Enough to tell two
    // keys apart, not enough to be a key.
    const primary = definition.credentialFields.find((f) => f.kind === 'secret');
    const hint = primary ? credentialHint(secrets[primary.name] ?? '') : null;
    return { secrets, config, hint };
  }

  /** Whether a sealed credential is stored. Reads only that it is there, never what it is. */
  private async holdsCredential(accountId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: integrationAccounts.id })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.id, accountId), isNotNull(integrationAccounts.credentials)))
      .limit(1);
    return Boolean(row);
  }

  /** An archived account is hidden and kept; it takes no edits until it is unarchived. */
  private refuseArchived(row: { status: string }): void {
    if (row.status === ARCHIVED) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This account is archived. Unarchive it first.' });
    }
  }

  private async row(principal: Principal, accountId: string) {
    const [row] = await this.db
      .select(this.visible)
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.companyId, principal.companyId), eq(integrationAccounts.id, accountId)))
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such integration account' });
    }
    return row;
  }

  private toAccount(row: {
    id: string;
    provider: string;
    name: string;
    category: string;
    status: string;
    credentialHint: string | null;
    credentialUpdatedAt: Date | null;
    config: unknown;
    externalName: string | null;
    lastSyncAt: Date | null;
    lastSuccessAt: Date | null;
    lastError: string | null;
    lastSummary: unknown;
    errorCount: number;
    createdAt: Date;
  }): IntegrationAccount {
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      category: row.category as IntegrationAccount['category'],
      status: row.status as IntegrationAccount['status'],
      credentialHint: row.credentialHint,
      credentialUpdatedAt: row.credentialUpdatedAt?.toISOString() ?? null,
      config: (row.config ?? {}) as Record<string, string>,
      externalName: row.externalName,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastError: row.lastError,
      lastSummary: (row.lastSummary as SyncSummary | null) ?? null,
      errorCount: row.errorCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
