import * as SQLite from 'expo-sqlite';

import type { QueueItem } from './queue-core';
import type { QueueStore } from './queue-runner';

/**
 * The phone's own database: the upload/action queue and form drafts. One row per item, the item
 * itself as JSON plus the columns the queue filters on (scope and status).
 */
let opened: Promise<SQLite.SQLiteDatabase> | null = null;

function db(): Promise<SQLite.SQLiteDatabase> {
  if (!opened) {
    opened = (async () => {
      const database = await SQLite.openDatabaseAsync('neway-mobile.db');
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS queue_items (
          id TEXT PRIMARY KEY NOT NULL,
          company_id TEXT NOT NULL,
          membership_id TEXT NOT NULL,
          status TEXT NOT NULL,
          body TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS queue_items_scope ON queue_items (company_id, membership_id, status);
        CREATE TABLE IF NOT EXISTS drafts (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          body TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, key)
        );
      `);
      return database;
    })();
  }
  return opened;
}

export const queueStore: QueueStore = {
  async all() {
    const rows = await (await db()).getAllAsync<{ body: string }>('SELECT body FROM queue_items');
    return rows.map((r) => JSON.parse(r.body) as QueueItem);
  },
  async put(item) {
    await (await db()).runAsync(
      `INSERT INTO queue_items (id, company_id, membership_id, status, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, body = excluded.body, updated_at = excluded.updated_at`,
      item.id,
      item.companyId,
      item.membershipId,
      item.status,
      JSON.stringify(item),
      item.updatedAt,
    );
  },
  async remove(id) {
    await (await db()).runAsync('DELETE FROM queue_items WHERE id = ?', id);
  },
};

export const draftStore = {
  async get<T>(scope: string, key: string): Promise<T | null> {
    const row = await (await db()).getFirstAsync<{ body: string }>(
      'SELECT body FROM drafts WHERE scope = ? AND key = ?',
      scope,
      key,
    );
    return row ? (JSON.parse(row.body) as T) : null;
  },
  async set(scope: string, key: string, value: unknown): Promise<void> {
    await (await db()).runAsync(
      `INSERT INTO drafts (scope, key, body, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      scope,
      key,
      JSON.stringify(value),
      Date.now(),
    );
  },
  async remove(scope: string, key: string): Promise<void> {
    await (await db()).runAsync('DELETE FROM drafts WHERE scope = ? AND key = ?', scope, key);
  },
  async clearScope(scope: string): Promise<void> {
    await (await db()).runAsync('DELETE FROM drafts WHERE scope = ?', scope);
  },
};
