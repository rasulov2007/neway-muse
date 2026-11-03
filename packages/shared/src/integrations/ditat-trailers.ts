/**
 * Planning a trailer import from Ditat.
 *
 * Pure: no database, no clock, no network, so the rules can be argued with in a test rather than
 * against a live workspace. The service reads what exists, hands it here, and applies exactly
 * what comes back — that split is the house pattern and the reason a dry run is simply a plan
 * that was never applied.
 *
 * The ladder, in order, per row:
 *
 *   1. the link key — this row was imported before → update it in place
 *   2. the natural key — a trailer already carries that unit number → adopt it: stamp the key,
 *      fill only what is empty, and report it so a person confirms
 *   3. no match → create
 *
 * There is no fuzzy step for trailers. A unit number is either the same or it is a different
 * trailer, and matching `904490` to `90449` would move a real asset's history onto the wrong row.
 */

export type TrailerOutcome = 'create' | 'update' | 'adopt' | 'unchanged' | 'skip';

/** A row of Ditat's trailer export, already read out of the CSV. */
export interface DitatTrailerRow {
  /** `TrailerId` — the unit number people say out loud, and Ditat's own key. */
  trailerId: string;
  trailerType: string;
  isActive: string;
  vin: string;
  make: string;
  model: string;
  makeYear: string;
  plateNumber: string;
  plateState: string;
  ownerType: string;
}

/** A trailer already on file here, as the planner needs to see it. */
export interface ExistingTrailer {
  id: string;
  unitNumber: string;
  vin: string;
  make: string | null;
  year: number | null;
  type: string;
  plate: string | null;
  plateState: string | null;
  status: string;
  ownership: string;
  source: string | null;
  externalId: string | null;
}

export interface TrailerPlanRow {
  outcome: TrailerOutcome;
  /** The Ditat key, and the unit number a person reads. */
  externalId: string;
  unitNumber: string;
  /** The row this lands on, when it lands on one. */
  targetId: string | null;
  /** What will be written. Empty on `unchanged` and `skip`. */
  values: Partial<{
    unitNumber: string;
    vin: string;
    make: string | null;
    year: number | null;
    type: string;
    plate: string | null;
    plateState: string | null;
    status: string;
    ownership: string;
    source: string;
    externalId: string;
  }>;
  /** Why, in a sentence, for a skip or an adoption, or when a retired status was kept. */
  note: string | null;
  /** The status left in place because the trailer is retired here (see {@link DITAT_KEPT_TRAILER_STATUSES}). */
  statusKept?: string;
}

/**
 * Statuses a re-run never changes. Retiring a trailer is a decision made here, and Ditat's
 * active / not active flag cannot express it, so the import leaves these alone.
 */
export const DITAT_KEPT_TRAILER_STATUSES: ReadonlySet<string> = new Set(['inactive', 'sold', 'archived']);

export interface TrailerPlan {
  rows: TrailerPlanRow[];
  counts: Record<TrailerOutcome, number>;
  /** Reason → how many, so the report aggregates without reading every row. */
  skippedBy: Record<string, number>;
}

/** Ditat's own demo rows, which are not equipment. */
const SAMPLE_KEYS = new Set(['DITATTRL', 'DITATTRK']);

/** `Dry Van` → `dry_van`. An unmapped word is reported, never guessed at. */
const TYPES: Record<string, string> = {
  'dry van': 'dry_van',
  reefer: 'reefer',
  refrigerated: 'reefer',
  flatbed: 'flatbed',
  'step deck': 'step_deck',
  'power only': 'power_only',
  tanker: 'tanker',
  container: 'container',
};

const OWNERSHIP: Record<string, string> = {
  company: 'owned',
  owned: 'owned',
  'owner operator': 'owner_operator',
  leased: 'leased',
  lease: 'leased',
  rented: 'rented',
};

export function normaliseUnit(value: string): string {
  return value.trim();
}

/**
 * Comparable form of a unit number - leading zeros are decoration in one system and meaning in
 * the other. The roster matcher already answers this question; both imports must answer it the
 * same way or a trailer matched on the board would miss here.
 */
export { unitKey } from '../dispatch/roster-match.js';
import { unitKey } from '../dispatch/roster-match.js';

function year(value: string): number | null {
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 1900 && n < 2100 ? n : null;
}

function blank(value: string | null | undefined): boolean {
  return !value || value.trim() === '';
}

export function planTrailers(rows: DitatTrailerRow[], existing: ExistingTrailer[]): TrailerPlan {
  const byKey = new Map(
    existing.filter((t) => t.externalId).map((t) => [`${t.source}|${t.externalId}`, t]),
  );
  const byUnit = new Map(existing.map((t) => [unitKey(t.unitNumber), t]));
  const seen = new Set<string>();

  const out: TrailerPlanRow[] = [];
  for (const row of rows) {
    const unit = normaliseUnit(row.trailerId);
    const key = unitKey(unit);
    const base: TrailerPlanRow = {
      outcome: 'skip',
      externalId: unit,
      unitNumber: unit,
      targetId: null,
      values: {},
      note: null,
    };

    if (unit === '') {
      out.push({ ...base, note: 'The row carries no trailer number, so there is nothing to file it under.' });
      continue;
    }
    if (SAMPLE_KEYS.has(unit.toUpperCase())) {
      out.push({ ...base, note: "Ditat's own sample record, not a trailer of this fleet." });
      continue;
    }
    if (seen.has(key)) {
      out.push({ ...base, note: `Trailer ${unit} appears twice in this export; the first row was used.` });
      continue;
    }
    seen.add(key);

    const type = TYPES[row.trailerType.trim().toLowerCase()];
    if (!type) {
      out.push({
        ...base,
        note: `Trailer type "${row.trailerType.trim() || 'blank'}" has no equivalent here; it needs a decision before this row can be imported.`,
      });
      continue;
    }

    const values = {
      unitNumber: unit,
      vin: row.vin.trim().toUpperCase(),
      make: row.make.trim() || null,
      year: year(row.makeYear),
      type,
      plate: row.plateNumber.trim() || null,
      plateState: row.plateState.trim().toUpperCase() || null,
      status: /^(yes|true|1)$/i.test(row.isActive.trim()) ? 'available' : 'out_of_service',
      ownership: OWNERSHIP[row.ownerType.trim().toLowerCase()] ?? 'owned',
      source: 'ditat',
      externalId: unit,
    };

    const linked = byKey.get(`ditat|${unit}`);
    if (linked) {
      /*
       * A trailer somebody here has retired (inactive, sold, archived) stays retired. Ditat only
       * knows active / not active, and "not active" would otherwise read as out of service and
       * pull a sold trailer back onto the fleet's repair lists. Its status is kept and said so.
       */
      const statusKept = DITAT_KEPT_TRAILER_STATUSES.has(linked.status) && linked.status !== values.status;
      if (DITAT_KEPT_TRAILER_STATUSES.has(linked.status)) values.status = linked.status;
      const changed =
        linked.unitNumber !== values.unitNumber ||
        linked.vin !== values.vin ||
        (linked.make ?? null) !== values.make ||
        (linked.year ?? null) !== values.year ||
        linked.type !== values.type ||
        (linked.plate ?? null) !== values.plate ||
        (linked.plateState ?? null) !== values.plateState ||
        linked.status !== values.status ||
        linked.ownership !== values.ownership;
      out.push({
        ...base,
        outcome: changed ? 'update' : 'unchanged',
        targetId: linked.id,
        values: changed ? values : {},
        note: statusKept
          ? `Status kept as ${linked.status.replace(/_/g, ' ')}; Ditat marks it ${/^(yes|true|1)$/i.test(row.isActive.trim()) ? 'active' : 'not active'}, and an import does not bring a retired trailer back.`
          : null,
        statusKept: DITAT_KEPT_TRAILER_STATUSES.has(linked.status) ? linked.status : undefined,
      });
      continue;
    }

    const natural = byUnit.get(key);
    if (natural) {
      /*
       * Adoption fills the gaps and leaves the rest alone. A trailer already on file was put
       * there by somebody here, and an import is not entitled to overwrite their work - so only
       * empty fields are filled, and the row is reported for a person to confirm.
       */
      const fill: TrailerPlanRow['values'] = { source: 'ditat', externalId: unit };
      if (blank(natural.vin) && values.vin) fill.vin = values.vin;
      if (blank(natural.make) && values.make) fill.make = values.make;
      if (natural.year === null && values.year !== null) fill.year = values.year;
      if (blank(natural.plate) && values.plate) fill.plate = values.plate;
      if (blank(natural.plateState) && values.plateState) fill.plateState = values.plateState;
      out.push({
        ...base,
        outcome: 'adopt',
        targetId: natural.id,
        values: fill,
        note: `Unit ${unit} is already on file here; the Ditat key was stamped on it and only empty fields were filled. Confirm it is the same trailer.`,
      });
      continue;
    }

    out.push({ ...base, outcome: 'create', values });
  }

  const counts: Record<TrailerOutcome, number> = {
    create: 0,
    update: 0,
    adopt: 0,
    unchanged: 0,
    skip: 0,
  };
  const skippedBy: Record<string, number> = {};
  for (const row of out) {
    counts[row.outcome] += 1;
    if (row.outcome === 'skip' && row.note) skippedBy[row.note] = (skippedBy[row.note] ?? 0) + 1;
  }
  return { rows: out, counts, skippedBy };
}
