/**
 * The clock the create path stamped on every stop in the v1 era: Chicago, the company zone of
 * the day. The product's clock is Eastern now, but a v1 record was written against this one,
 * and the correction below has to recognise the stamp it actually carries.
 */
const V1_COMPANY_ZONE = 'America/Chicago';
import { isKnownZone, resolveStopZone } from './timezone.js';

/**
 * Versioned migration of a load record (docs/dispatch/00-plan.md §6).
 *
 * Each record carries `schemaVersion`; absent means 1. A step reads a record at version n and
 * returns it at n+1, touching only the fields that step is about and carrying every other
 * field through untouched - the store holds things this module does not know about, and a
 * migration that dropped them would be a data loss dressed as a tidy-up. A record a step cannot
 * make sense of is reported: in development that is thrown, so the seed or the code is fixed
 * before anyone builds on it; in production it is logged and the record is left at its old
 * version, readable and unmigrated, for a person to look at.
 */
export const LOADS_SCHEMA_VERSION = 2;

export interface MigrationLogEntry {
  loadId: string;
  loadNumber: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface MigrationResult<T> {
  rows: T[];
  changed: number;
  failed: number;
  log: MigrationLogEntry[];
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function versionOf(row: Row): number {
  const v = row.schemaVersion;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

class Unmigratable extends Error {}

/**
 * v1 → v2 (P0.4, P0.5): a zone on every stop, the "no window" flag where the customer gave one
 * time, and a review state on every document.
 */
function toV2(row: Row, log: (level: MigrationLogEntry['level'], message: string) => void): Row {
  if (!Array.isArray(row.stops)) throw new Unmigratable('stops is not a list');
  if (row.documents !== undefined && !Array.isArray(row.documents)) {
    throw new Unmigratable('documents is not a list');
  }
  const stops = (row.stops as unknown[]).map((raw, index) => {
    if (!isRow(raw)) throw new Unmigratable(`stop ${index + 1} is not a record`);
    const stop: Row = { ...raw };
    const city = typeof stop.city === 'string' ? stop.city : '';
    const state = typeof stop.state === 'string' ? stop.state : '';
    const zip = typeof stop.zip === 'string' ? stop.zip : null;
    const stored = typeof stop.timezone === 'string' ? stop.timezone : '';
    const label = `stop ${index + 1} (${city}, ${state})`;

    const resolved = resolveStopZone({ zip, city, state });
    if (!isKnownZone(stored)) {
      if (resolved.zone) {
        stop.timezone = resolved.zone;
        log('info', `${label}: zone set to ${resolved.zone} from ${resolved.source}`);
      } else {
        stop.timezone = '';
        log('warn', `${label}: zone unknown - no ZIP, city or state matched`);
      }
    } else if (stored === V1_COMPANY_ZONE && resolved.zone && resolved.zone !== stored) {
      // The create path used to stamp the company's clock on every stop. A stop that carries it
      // while its own place says otherwise is that bug, not a choice.
      stop.timezone = resolved.zone;
      log('info', `${label}: zone corrected ${stored} → ${resolved.zone} from ${resolved.source}`);
    } else if (resolved.zone && resolved.zone !== stored) {
      log('warn', `${label}: keeps ${stored}; the lookup says ${resolved.zone} from ${resolved.source}`);
    }

    if (stop.appointmentNoWindow === undefined) {
      const start = typeof stop.appointmentStartAt === 'string' ? Date.parse(stop.appointmentStartAt) : NaN;
      const end = typeof stop.appointmentEndAt === 'string' ? Date.parse(stop.appointmentEndAt) : NaN;
      stop.appointmentNoWindow = Number.isNaN(start) || Number.isNaN(end) || end <= start;
    }
    return stop;
  });

  const documents = ((row.documents as unknown[] | undefined) ?? []).map((raw, index) => {
    if (!isRow(raw)) throw new Unmigratable(`document ${index + 1} is not a record`);
    const doc: Row = { ...raw };
    if (doc.review === undefined) {
      if (doc.status === 'verified') {
        // Verified before names were kept: the state stands, the person is unknown, and the
        // label says so rather than inventing one.
        doc.review = 'verified';
        doc.verifiedBy = doc.verifiedBy ?? null;
        doc.verifiedAt = doc.verifiedAt ?? null;
      } else if (doc.status === 'pending') {
        doc.review = 'received';
      }
    }
    return doc;
  });

  return { ...row, stops, documents, schemaVersion: 2 };
}

const STEPS: Record<number, (row: Row, log: (level: MigrationLogEntry['level'], message: string) => void) => Row> = {
  1: toV2,
};

/**
 * Brings one record to the current version. Returns the record unchanged (and `changed: false`)
 * when it is already current; throws `Unmigratable` in strict mode when a step cannot run.
 */
export function migrateLoad<T>(
  record: T,
  options: { strict: boolean; log?: (entry: MigrationLogEntry) => void } = { strict: false },
): { record: T; changed: boolean; failed: boolean } {
  if (!isRow(record)) {
    if (options.strict) throw new Unmigratable('load is not a record');
    return { record, changed: false, failed: true };
  }
  const loadId = typeof record.id === 'string' ? record.id : '?';
  const loadNumber = typeof record.loadNumber === 'string' ? record.loadNumber : '?';
  const emit = (level: MigrationLogEntry['level'], message: string) =>
    options.log?.({ loadId, loadNumber, level, message });

  let row: Row = record;
  let version = versionOf(row);
  if (version >= LOADS_SCHEMA_VERSION) return { record, changed: false, failed: false };
  try {
    while (version < LOADS_SCHEMA_VERSION) {
      const step = STEPS[version];
      if (!step) throw new Unmigratable(`no step from v${version}`);
      row = step(row, emit);
      version += 1;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.strict) {
      throw new Error(`Load ${loadNumber} (${loadId}) cannot be migrated from v${version}: ${reason}`);
    }
    emit('error', `left at v${version}: ${reason}`);
    return { record, changed: false, failed: true };
  }
  return { record: row as T, changed: true, failed: false };
}

/** Every record, in place order; the log says what moved and what could not. */
export function migrateLoads<T>(rows: readonly T[], options: { strict: boolean }): MigrationResult<T> {
  const log: MigrationLogEntry[] = [];
  let changed = 0;
  let failed = 0;
  const out = rows.map((row) => {
    const result = migrateLoad(row, { strict: options.strict, log: (entry) => log.push(entry) });
    if (result.changed) changed += 1;
    if (result.failed) failed += 1;
    return result.record;
  });
  return { rows: out, changed, failed, log };
}
