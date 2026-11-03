/**
 * Stolen-unit privacy (owner decision, binding).
 *
 * Only the `administrator` role sees what is known about a stolen unit: the account of what
 * happened, the police report, where it was taken from, the claim, what was in it, where it is now,
 * who recorded it and when. Everybody else - managers and the owner flag included, when they do not
 * hold the administrator role - sees the word "Stolen" and the unit's status, nothing more.
 *
 * These are the pure rules; `StolenUnitsService` loads the company's exits and applies them. Every
 * reader that can return one of these details goes through one of the functions below, so the rule
 * cannot drift between the workspace, the audit trail and the unit records.
 */

import type { Principal } from '../../common/auth/principal';

/** The one role that sees stolen details. */
export const STOLEN_DETAIL_ROLE = 'administrator';

/** What a redacted audit line says instead of its summary. */
export const RESTRICTED_SUMMARY = 'Restricted (stolen unit)';

/** The workspace rows that carry stolen details. */
export const UNIT_EXITS_KEY = 'ws2-unitexits';
export const COMPLIANCE_AUDIT_KEY = 'ws2-complianceaudit';
/** Notes people keep on a unit (the truck page's Notes): written after a theft, they are details too. */
export const TRUCK_NOTES_KEY = 'ws2-trucknotes';

/**
 * How far before the exit record an audit line still counts as "about the theft": the status
 * change is written a moment before the exit record itself, and a slow browser can take a while.
 */
const AUDIT_LEAD_MS = 10 * 60 * 1000;

const MENTIONS_STOLEN = /\b(stolen|theft)\b/i;

export function seesStolenDetails(principal: Principal): boolean {
  return principal.roles.includes(STOLEN_DETAIL_ROLE);
}

export function mentionsStolen(...texts: unknown[]): boolean {
  return texts.some((text) => typeof text === 'string' && MENTIONS_STOLEN.test(text));
}

/** What the server knows about the company's stolen units, for one non-admin read. */
export interface StolenContext {
  /** Units whose latest exit is "stolen": their location, notes and documents are withheld. */
  current: Set<string>;
  /** Every unit that was ever recorded stolen, with the earliest moment its audit lines hide. */
  since: Map<string, number>;
}

export const EMPTY_STOLEN_CONTEXT: StolenContext = { current: new Set(), since: new Map() };

interface ExitLike {
  id?: unknown;
  unitId?: unknown;
  reason?: unknown;
  occurredOn?: unknown;
  createdAt?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function time(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Start of a calendar day, at its earliest moment anywhere in the US (Eastern standard time). */
function dayStart(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return time(`${value}T00:00:00-05:00`);
}

/** Builds the context from the stored (never the redacted) exit records. */
export function stolenContextFrom(exits: unknown): StolenContext {
  const context: StolenContext = { current: new Set(), since: new Map() };
  if (!Array.isArray(exits)) return context;
  const latest = new Map<string, { at: number; stolen: boolean }>();
  for (const raw of exits) {
    const row = asRecord(raw) as ExitLike | null;
    if (!row || typeof row.unitId !== 'string' || row.unitId === '') continue;
    const stolen = row.reason === 'stolen';
    const created = time(row.createdAt);
    const occurred = dayStart(row.occurredOn);
    const at = created ?? occurred ?? 0;
    const previous = latest.get(row.unitId);
    if (!previous || at >= previous.at) latest.set(row.unitId, { at, stolen });
    if (stolen) {
      const candidates = [created !== null ? created - AUDIT_LEAD_MS : null, occurred].filter(
        (n): n is number => n !== null,
      );
      // A stolen record with no usable date hides every line about the unit.
      const from = candidates.length > 0 ? Math.min(...candidates) : 0;
      const known = context.since.get(row.unitId);
      context.since.set(row.unitId, known === undefined ? from : Math.min(known, from));
    }
  }
  for (const [unitId, last] of latest) if (last.stolen) context.current.add(unitId);
  return context;
}

export function isStolenRecord(raw: unknown): boolean {
  return asRecord(raw)?.reason === 'stolen';
}

/** The exit record a non-admin receives: the same shape, every detail blank. */
export function redactExitRecord(raw: unknown): Record<string, unknown> {
  const row = asRecord(raw) ?? {};
  return {
    id: row.id ?? '',
    entity: row.entity ?? 'truck',
    unitId: row.unitId ?? '',
    unitNumber: row.unitNumber ?? '',
    toStatus: row.toStatus ?? '',
    fromStatus: '',
    occurredOn: '',
    reason: 'stolen',
    narrative: '',
    odometer: null,
    salePrice: null,
    buyer: null,
    titleTransferred: null,
    policeReport: null,
    stolenFrom: null,
    recovered: null,
    contents: [],
    damage: [],
    injuries: null,
    driverId: null,
    driverName: null,
    loadNumber: null,
    insuranceClaimNumber: null,
    insuredValue: null,
    deductible: null,
    expectedRecovery: null,
    recordedById: null,
    recordedByName: '',
    createdAt: '',
    redacted: true,
  };
}

export function redactExits(exits: unknown): unknown {
  if (!Array.isArray(exits)) return exits;
  return exits.map((row) => (isStolenRecord(row) ? redactExitRecord(row) : row));
}

/** True when a line about `entityId` at `at` (or carrying these texts) is withheld. */
export function hidesAuditLine(
  context: StolenContext,
  entityId: unknown,
  at: unknown,
  texts: unknown[],
): boolean {
  if (mentionsStolen(...texts)) return true;
  if (typeof entityId !== 'string') return false;
  const since = context.since.get(entityId);
  if (since === undefined) return false;
  const when = time(at);
  return when === null || when >= since;
}

/** The workspace's own audit line (`complianceAudit`, the browser's shape). */
export function hidesWorkspaceAudit(context: StolenContext, raw: unknown): boolean {
  const row = asRecord(raw);
  if (!row) return false;
  const entity = asRecord(row.entity);
  return hidesAuditLine(context, entity?.id, row.at, [row.reason, row.before, row.after, row.subject]);
}

export function redactWorkspaceAuditEntry(raw: unknown): Record<string, unknown> {
  const row = asRecord(raw) ?? {};
  return { ...row, subject: null, before: null, after: null, reason: null, redacted: true };
}

export function redactWorkspaceAudit(context: StolenContext, entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.map((row) => (hidesWorkspaceAudit(context, row) ? redactWorkspaceAuditEntry(row) : row));
}

/** An `audit_logs` row or its projection: anything with these four fields. */
export interface AuditLineLike {
  entityId: string;
  at: Date | string;
  summary: string;
  reason: string | null;
  changes: unknown;
}

function changeTexts(changes: unknown): unknown[] {
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((c) => {
    const change = asRecord(c);
    return change ? [change.old, change.new, change.field] : [];
  });
}

export function hidesAuditLog(context: StolenContext, row: AuditLineLike): boolean {
  return hidesAuditLine(context, row.entityId, row.at, [row.summary, row.reason, ...changeTexts(row.changes)]);
}

export function redactAuditLogs<T extends AuditLineLike>(context: StolenContext, rows: T[]): T[] {
  return rows.map((row) =>
    hidesAuditLog(context, row) ? { ...row, summary: RESTRICTED_SUMMARY, reason: null, changes: [] } : row,
  );
}

// ------------------------------------------------------------------------ writes from non-admins

/**
 * Merges a non-admin's write of a whole collection back onto what is stored.
 *
 * The browser holds the redacted copy and writes the whole array back. Every stored entry that is
 * redacted for this caller is kept exactly as stored: an incoming copy with the same key is
 * replaced by it, and a stored one the browser dropped is put back. A redacted placeholder that
 * matches nothing stored carries no information and is not written. Everything else - including a
 * new stolen record the caller is filing - is taken as sent.
 */
export function mergeProtected(
  stored: unknown,
  incoming: unknown,
  isProtected: (row: unknown) => boolean,
  keyOf: (row: unknown) => string,
): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const kept = new Map<string, unknown>();
  if (Array.isArray(stored)) {
    for (const row of stored) if (isProtected(row)) kept.set(keyOf(row), row);
  }
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const row of incoming) {
    const key = keyOf(row);
    const original = kept.get(key);
    if (original !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(original);
      continue;
    }
    if (asRecord(row)?.redacted === true) continue;
    out.push(row);
  }
  for (const [key, row] of kept) if (!seen.has(key)) out.push(row);
  return out;
}

export function exitKey(row: unknown): string {
  return `exit:${String(asRecord(row)?.id ?? '')}`;
}

/** Workspace audit ids are not unique (`aud_<n>`), so a line is its id and its moment. */
export function workspaceAuditKey(row: unknown): string {
  const record = asRecord(row);
  return `aud:${String(record?.id ?? '')}|${String(record?.at ?? '')}`;
}

// ------------------------------------------------------------------------------ unit notes

/** A note on a stolen unit written from the theft on (or mentioning a theft anywhere) is withheld. */
export function hidesTruckNote(context: StolenContext, raw: unknown): boolean {
  const row = asRecord(raw);
  if (!row) return false;
  return hidesAuditLine(context, row.truckId, row.at, [row.body]);
}

export function redactTruckNotes(context: StolenContext, notes: unknown): unknown {
  if (!Array.isArray(notes)) return notes;
  return notes.map((row) =>
    hidesTruckNote(context, row)
      ? { ...(asRecord(row) ?? {}), body: RESTRICTED_SUMMARY, authorName: '', redacted: true }
      : row,
  );
}

export function truckNoteKey(row: unknown): string {
  return `note:${String(asRecord(row)?.id ?? '')}`;
}
