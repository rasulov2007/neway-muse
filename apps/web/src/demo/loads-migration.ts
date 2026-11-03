import { migrateLoads, type MigrationLogEntry } from '@neway/shared';
import type { demoData } from './data';

/**
 * Brings every load record in the workspace to the current schema version, in place, before any
 * screen reads (docs/dispatch/00-plan.md §6). The rule is the shared one; this is where it meets
 * the store. Development is strict - a record that cannot be migrated throws here, at boot, so
 * it is fixed before anyone builds on it - and production logs the record and leaves it at its
 * old version. What moved is persisted by the ordinary autosave: the migrated collection
 * differs from the synced copy, so the next save writes it.
 */
export function migrateWorkspaceLoads(
  data: { loads: (typeof demoData)['loads'] },
  options: { strict: boolean; log?: (entry: MigrationLogEntry) => void } = {
    strict: import.meta.env.DEV,
  },
): { changed: number; failed: number } {
  const result = migrateLoads(data.loads, { strict: options.strict });
  if (result.changed > 0 || result.failed > 0) {
    data.loads.length = 0;
    data.loads.push(...result.rows);
  }
  const report = options.log ?? defaultLog;
  for (const entry of result.log) report(entry);
  return { changed: result.changed, failed: result.failed };
}

function defaultLog(entry: MigrationLogEntry): void {
  const line = `loads migration ${entry.loadNumber}: ${entry.message}`;
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else if (import.meta.env.DEV) console.info(line);
}
