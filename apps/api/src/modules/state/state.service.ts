import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { LEGACY_WORKSPACE_KEY, WORKSPACE_PREFIX, workspaceCollectionOf } from '@neway/shared';
import { DatabaseService } from '../../database/database.service';

const KEY_RE = /^[a-z0-9_-]{1,64}$/;

/**
 * The company whose workspace is stored under the bare keys (owner, 2026-10-02).
 *
 * The workspace table had no company in it: every company read and wrote the same rows, so the
 * second customer (Harbor Line) opened NORTHWIND FREIGHT's notifications, PTI records and everything else the
 * browser keeps there. NORTHWIND FREIGHT's rows stay exactly where they are - nothing is moved or
 * rewritten - and every other company is stored under `t.<companyId>.<key>`. A client key can never
 * contain a dot, so the two can never meet.
 */
export const LEGACY_WORKSPACE_COMPANY = process.env.WORKSPACE_LEGACY_COMPANY ?? 'co_northwind';

/** Where a company's copy of a client key is stored. */
export function storageKeyFor(companyId: string, key: string): string {
  return companyId === LEGACY_WORKSPACE_COMPANY ? key : `t.${companyId}.${key}`;
}

/** The client key a stored key belongs to for this company, or null when it is not this company's. */
export function clientKeyOf(companyId: string, stored: string): string | null {
  if (companyId === LEGACY_WORKSPACE_COMPANY) return stored.startsWith('t.') ? null : stored;
  const prefix = `t.${companyId}.`;
  return stored.startsWith(prefix) ? stored.slice(prefix.length) : null;
}

@Injectable()
export class StateService implements OnModuleInit {
  constructor(private readonly database: DatabaseService) {}

  /** The table is created imperatively: one blob table does not warrant a
   * migration-journal entry, and IF NOT EXISTS makes every boot safe. */
  async onModuleInit(): Promise<void> {
    await this.database.db.execute(sql`
      CREATE TABLE IF NOT EXISTS app_state (
        key text PRIMARY KEY,
        value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  /**
   * The whole workspace as one object, for the reads that aggregate it (the fleet expense
   * summary, workspace reporting).
   *
   * It is stored as one row per collection; this puts them back together under the collection
   * names the client uses. The single blob it replaced is still read when no split rows exist,
   * so a server that has not run the split yet answers from the same data it always did.
   */
  async workspace(companyId: string): Promise<{ data: Record<string, unknown>; updatedAt: string } | null> {
    const index = await this.listFor(companyId, WORKSPACE_PREFIX);
    if (index.length > 0) {
      const rows = await this.getManyFor(companyId, index.map((row) => row.key));
      const data: Record<string, unknown> = {};
      let updatedAt = '';
      for (const row of rows) {
        const name = workspaceCollectionOf(row.key);
        if (!name) continue;
        try {
          data[name] = JSON.parse(row.value);
        } catch {
          // One unreadable collection is not a reason to report nothing for the rest.
        }
        if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
      }
      return Object.keys(data).length > 0 ? { data, updatedAt } : null;
    }
    const legacy = await this.getFor(companyId, LEGACY_WORKSPACE_KEY);
    if (!legacy) return null;
    try {
      const parsed = JSON.parse(legacy.value) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return null;
      return { data: parsed as Record<string, unknown>, updatedAt: legacy.updatedAt };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ one company's workspace
  //
  // What the /state routes and the server's workspace readers use: keys as the client names them,
  // stored under the company's own prefix. The unscoped methods below are for keys that already
  // carry their company (dispatch targets) and for the one-off split of the legacy blob.

  async listFor(companyId: string, prefix: string): Promise<{ key: string; updatedAt: string; bytes: number }[]> {
    if (!KEY_RE.test(prefix)) throw new Error('Invalid state key prefix');
    const rows = await this.listStored(storageKeyFor(companyId, prefix));
    return rows.flatMap((r) => {
      const key = clientKeyOf(companyId, r.key);
      return key === null ? [] : [{ ...r, key }];
    });
  }

  async getManyFor(companyId: string, keys: string[]): Promise<{ key: string; value: string; updatedAt: string }[]> {
    const wanted = keys.filter((k) => KEY_RE.test(k));
    const rows = await this.getManyStored(wanted.map((k) => storageKeyFor(companyId, k)));
    return rows.flatMap((r) => {
      const key = clientKeyOf(companyId, r.key);
      return key === null ? [] : [{ ...r, key }];
    });
  }

  async getFor(companyId: string, key: string): Promise<{ value: string; updatedAt: string } | null> {
    this.assertKey(key);
    return this.getStored(storageKeyFor(companyId, key));
  }

  async putFor(companyId: string, key: string, value: string, ifUnchangedSince?: string): Promise<string | null> {
    this.assertKey(key);
    return this.putStored(storageKeyFor(companyId, key), value, ifUnchangedSince);
  }

  // ------------------------------------------------------------------ unscoped

  assertKey(key: string): void {
    if (!KEY_RE.test(key)) throw new Error('Invalid state key');
  }

  /**
   * Every row under a prefix, without its value: what a client polls to learn that another
   * browser changed a collection. Cheap on purpose - the values are megabytes, the list is bytes.
   */
  async list(prefix: string): Promise<{ key: string; updatedAt: string; bytes: number }[]> {
    if (!KEY_RE.test(prefix)) throw new Error('Invalid state key prefix');
    return this.listStored(prefix);
  }

  private async listStored(prefix: string): Promise<{ key: string; updatedAt: string; bytes: number }[]> {
    const rows = await this.database.db.execute(
      sql`SELECT key, updated_at, length(value) AS bytes FROM app_state WHERE key LIKE ${prefix + '%'} ORDER BY key`,
    );
    return (rows as unknown as { key: string; updated_at: string; bytes: number }[]).map((r) => ({
      key: r.key,
      updatedAt: String(r.updated_at),
      bytes: Number(r.bytes),
    }));
  }

  /** The named rows with their values, in one round trip. Unknown keys are simply absent. */
  async getMany(keys: string[]): Promise<{ key: string; value: string; updatedAt: string }[]> {
    return this.getManyStored(keys.filter((k) => KEY_RE.test(k)));
  }

  private async getManyStored(wanted: string[]): Promise<{ key: string; value: string; updatedAt: string }[]> {
    if (wanted.length === 0) return [];
    const rows = await this.database.db.execute(
      sql`SELECT key, value, updated_at FROM app_state WHERE key IN ${sql.raw(
        '(' + wanted.map((k) => "'" + k.replace(/'/g, "''") + "'").join(',') + ')',
      )} ORDER BY key`,
    );
    return (rows as unknown as { key: string; value: string; updated_at: string }[]).map((r) => ({
      key: r.key,
      value: r.value,
      updatedAt: String(r.updated_at),
    }));
  }

  async get(key: string): Promise<{ value: string; updatedAt: string } | null> {
    this.assertKey(key);
    return this.getStored(key);
  }

  private async getStored(key: string): Promise<{ value: string; updatedAt: string } | null> {
    const rows = await this.database.db.execute(
      sql`SELECT value, updated_at FROM app_state WHERE key = ${key}`,
    );
    const row = (rows as unknown as { value: string; updated_at: string }[])[0];
    return row ? { value: row.value, updatedAt: String(row.updated_at) } : null;
  }

  /**
   * Writes a blob, refusing a stale one.
   *
   * `ifUnchangedSince` is the `updatedAt` the client last read. When the stored row has moved on
   * since — another tab, another device, or a session that started before this one — the write is
   * refused instead of applied. Without that check, a browser holding an older copy of the
   * workspace silently overwrote newer work, which is exactly how a day's edits reverted to the
   * generated demo data a couple of minutes after they were made.
   *
   * Returns the row's new timestamp, or `null` when the write was refused as stale.
   */
  async put(key: string, value: string, ifUnchangedSince?: string): Promise<string | null> {
    this.assertKey(key);
    return this.putStored(key, value, ifUnchangedSince);
  }

  private async putStored(key: string, value: string, ifUnchangedSince?: string): Promise<string | null> {
    if (ifUnchangedSince !== undefined) {
      const current = await this.getStored(key);
      if (current && new Date(current.updatedAt).getTime() > new Date(ifUnchangedSince).getTime()) {
        return null;
      }
    }
    const rows = await this.database.db.execute(sql`
      INSERT INTO app_state (key, value, updated_at) VALUES (${key}, ${value}, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
      RETURNING updated_at
    `);
    const row = (rows as unknown as { updated_at: string }[])[0];
    return row ? String(row.updated_at) : new Date().toISOString();
  }
}
