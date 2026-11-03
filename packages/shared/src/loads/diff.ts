/**
 * What changed between two copies of a load (P0.2).
 *
 * The edit form's promise is that saving without touching anything changes nothing - no
 * re-suggested miles, no re-assigned dispatcher, no status nudged along. That promise is a test,
 * and this is what the test measures: a field-by-field diff of the record before and after,
 * with the bookkeeping fields (`updatedAt`, the timeline) left out so that only what a person
 * would call a change counts.
 */
export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

const BOOKKEEPING = new Set(['updatedAt', 'timeline', 'schemaVersion']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(path: string, before: unknown, after: unknown, out: FieldChange[]): void {
  if (Object.is(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (path === '' && BOOKKEEPING.has(key)) continue;
      walk(path ? `${path}.${key}` : key, before[key], after[key], out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      out.push({ path: `${path}.length`, before: before.length, after: after.length });
    }
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i += 1) walk(`${path}[${i}]`, before[i], after[i], out);
    return;
  }
  if (typeof before === 'number' && typeof after === 'number' && Number.isNaN(before) && Number.isNaN(after)) return;
  out.push({ path, before, after });
}

/** Every field that differs, as dotted paths. Empty when the two copies say the same thing. */
export function diffLoad(before: unknown, after: unknown): FieldChange[] {
  const out: FieldChange[] = [];
  walk('', before, after, out);
  return out;
}

/** `Rate $1,200 → $1,250` style lines for a timeline entry, from a diff. */
export function describeChanges(changes: readonly FieldChange[]): string[] {
  return changes.map((change) => `${change.path}: ${show(change.before)} → ${show(change.after)}`);
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
