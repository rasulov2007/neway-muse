/**
 * Planning a driver import from Ditat.
 *
 * Pure, like the trailer and broker planners: the caller reads what is on file, hands it here with
 * today's business date, and writes exactly what comes back.
 *
 * Only drivers Ditat calls `Driving` are imported. `On leave`, `Terminated` and `Applicant` are
 * that system's history, and a terminated driver arriving here as an active one would be read by
 * dispatch as somebody they can call.
 *
 * The ladder, per row:
 *
 *   1. the link key — imported before → update in place
 *   2. the same name **and** the same CDL expiry → adopt: stamp the key, fill only what is empty
 *   3. the same name alone → **needs review**, never merged
 *   4. nothing → create
 */

export type DriverOutcome = 'create' | 'update' | 'adopt' | 'unchanged' | 'review' | 'skip';

/** A row of Ditat's driver export, already read out of the CSV. */
export interface DitatDriverRow {
  driverId: string;
  status: string;
  driverType: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  city: string;
  state: string;
  licenceState: string;
  licenceClass: string;
  licenceExpiresOn: string;
  physicalExpiresOn: string;
  hiredOn: string;
  truckId: string;
  trailerId: string;
  endorsements: {
    hazmat: string;
    tanker: string;
    hazmatTanker: string;
    doubleTriple: string;
    passenger: string;
    schoolBus: string;
  };
}

/** A driver already on file here, as the planner needs to see it. */
export interface ExistingDriver {
  id: string;
  driverNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  homeCity: string;
  homeState: string;
  cdlExpiresOn: string;
  medicalCardExpiresOn: string | null;
  currentTruckId: string | null;
  source: string | null;
  externalId: string | null;
}

export interface DriverValues {
  driverNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  driverType: string;
  cdlState: string;
  cdlClass: string;
  cdlEndorsements: string[];
  cdlExpiresOn: string;
  cdlStatus: string;
  medicalCardExpiresOn: string | null;
  medicalCardStatus: string;
  hireDate: string;
  status: string;
  homeCity: string;
  homeState: string;
  /** Ditat's own truck number, for the caller to resolve against this fleet. Never a truck id. */
  truckUnitNumber: string | null;
  source: string;
  externalId: string;
}

export interface DriverPlanRow {
  outcome: DriverOutcome;
  externalId: string;
  name: string;
  targetId: string | null;
  values: Partial<DriverValues> | null;
  note: string | null;
}

export interface DriverPlan {
  rows: DriverPlanRow[];
  counts: Record<DriverOutcome, number>;
  skippedBy: Record<string, number>;
}

/** The only Ditat status this import takes. */
export const IMPORTED_STATUS = 'Driving';

const TYPES: Record<string, string> = {
  'company driver': 'company',
  company: 'company',
  'owner operator': 'owner_operator',
  'leased driver': 'lease_operator',
  'lease operator': 'lease_operator',
  'lease purchase': 'lease_operator',
};

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function yes(value: string | undefined): boolean {
  return /^(yes|true|1)$/i.test(clean(value));
}

/** `11/26/2030` → `2030-11-26`. Anything else is not a date and is reported as missing. */
export function isoFromUs(value: string | undefined): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean(value));
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const iso = `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** Comparable name, so `  Jose   Ramirez ` and `JOSE RAMIREZ` are one person. */
export function nameKey(first: string, last: string): string {
  return `${clean(first)} ${clean(last)}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Verified, expiring inside 30 days, expired, or no certificate at all. */
export function certificateStatus(expiresOn: string | null, today: string): string {
  if (!expiresOn) return 'missing';
  if (expiresOn < today) return 'expired';
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 30);
  return expiresOn <= limit.toISOString().slice(0, 10) ? 'expiring' : 'verified';
}

function endorsementsOf(row: DitatDriverRow): string[] {
  const e = row.endorsements;
  const out: string[] = [];
  if (yes(e.hazmat)) out.push('H');
  if (yes(e.tanker)) out.push('N');
  if (yes(e.hazmatTanker)) out.push('X');
  if (yes(e.doubleTriple)) out.push('T');
  if (yes(e.passenger)) out.push('P');
  if (yes(e.schoolBus)) out.push('S');
  return out;
}

/**
 * The address a driver with no email address on file gets.
 *
 * `.invalid` can never be delivered to (RFC 2606), so nobody will ever mistake it for a way to
 * reach this person — but the column is unique and not null, and thirty blank strings cannot all
 * be the same blank string. It reads as what it is: no email on file.
 */
export function placeholderEmail(externalId: string): string {
  return `no-email.ditat-${externalId}@neway.invalid`;
}

export function planDrivers(
  rows: DitatDriverRow[],
  existing: ExistingDriver[],
  today: string,
): DriverPlan {
  const byKey = new Map(existing.filter((d) => d.externalId).map((d) => [`ditat|${d.externalId}`, d]));
  const byNameAndCdl = new Map(
    existing.map((d) => [`${nameKey(d.firstName, d.lastName)}|${d.cdlExpiresOn}`, d]),
  );
  const byName = new Map(existing.map((d) => [nameKey(d.firstName, d.lastName), d]));
  const seen = new Set<string>();

  const out: DriverPlanRow[] = [];
  for (const row of rows) {
    const id = clean(row.driverId);
    const name = `${clean(row.firstName)} ${clean(row.lastName)}`.trim();
    const base: DriverPlanRow = { outcome: 'skip', externalId: id, name, targetId: null, values: null, note: null };

    if (clean(row.status) !== IMPORTED_STATUS) {
      out.push({ ...base, note: `Ditat has this driver as "${clean(row.status) || 'blank'}", not ${IMPORTED_STATUS}.` });
      continue;
    }
    if (!id) {
      out.push({ ...base, note: 'The row carries no driver id, so a later run could not recognise it.' });
      continue;
    }
    if (!clean(row.firstName) || !clean(row.lastName)) {
      out.push({ ...base, note: 'The row carries no first and last name.' });
      continue;
    }
    if (seen.has(id)) {
      out.push({ ...base, note: `Driver ${id} appears twice in this export; the first row was used.` });
      continue;
    }
    seen.add(id);

    const cdlExpiresOn = isoFromUs(row.licenceExpiresOn);
    if (!cdlExpiresOn) {
      out.push({ ...base, note: 'The CDL has no expiry date, and a driver file without one cannot be kept current.' });
      continue;
    }
    const hireDate = isoFromUs(row.hiredOn);
    if (!hireDate) {
      out.push({ ...base, note: 'The row carries no hire date.' });
      continue;
    }
    const cdlClass = clean(row.licenceClass).toUpperCase();
    if (cdlClass !== 'A' && cdlClass !== 'B') {
      out.push({ ...base, note: `CDL class "${clean(row.licenceClass) || 'blank'}" is not A or B; it needs a person to say which.` });
      continue;
    }
    const cdlState = clean(row.licenceState).toUpperCase();
    if (cdlState.length !== 2) {
      out.push({ ...base, note: `CDL state "${cdlState || 'blank'}" is not a two-letter state.` });
      continue;
    }

    const medicalCardExpiresOn = isoFromUs(row.physicalExpiresOn);
    const email = clean(row.email).toLowerCase() || placeholderEmail(id);
    const values: DriverValues = {
      driverNumber: id,
      firstName: clean(row.firstName),
      lastName: clean(row.lastName),
      phone: clean(row.phone),
      email,
      driverType: TYPES[clean(row.driverType).toLowerCase()] ?? 'company',
      cdlState,
      cdlClass,
      cdlEndorsements: endorsementsOf(row),
      cdlExpiresOn,
      cdlStatus: certificateStatus(cdlExpiresOn, today),
      medicalCardExpiresOn,
      medicalCardStatus: certificateStatus(medicalCardExpiresOn, today),
      hireDate,
      /*
       * `available`, not `driving`. Ditat's "Driving" means employed and working; this product's
       * `driving` means on a load right now, which the import has no way to know.
       */
      status: 'available',
      homeCity: clean(row.city),
      homeState: clean(row.state).toUpperCase(),
      truckUnitNumber: clean(row.truckId) || null,
      source: 'ditat',
      externalId: id,
    };

    const linked = byKey.get(`ditat|${id}`);
    if (linked) {
      const changed =
        linked.firstName !== values.firstName ||
        linked.lastName !== values.lastName ||
        linked.phone !== values.phone ||
        linked.cdlExpiresOn !== values.cdlExpiresOn ||
        (linked.medicalCardExpiresOn ?? null) !== values.medicalCardExpiresOn ||
        linked.homeCity !== values.homeCity ||
        linked.homeState !== values.homeState;
      out.push({ ...base, outcome: changed ? 'update' : 'unchanged', targetId: linked.id, values: changed ? values : null });
      continue;
    }

    const confirmed = byNameAndCdl.get(`${nameKey(row.firstName, row.lastName)}|${cdlExpiresOn}`);
    if (confirmed) {
      /* Adoption fills the gaps and leaves the rest alone: somebody here typed that record. */
      const fill: Partial<DriverValues> = { source: 'ditat', externalId: id };
      if (!clean(confirmed.phone) && values.phone) fill.phone = values.phone;
      if (!clean(confirmed.homeCity) && values.homeCity) fill.homeCity = values.homeCity;
      if (confirmed.medicalCardExpiresOn === null && values.medicalCardExpiresOn) {
        fill.medicalCardExpiresOn = values.medicalCardExpiresOn;
        fill.medicalCardStatus = values.medicalCardStatus;
      }
      out.push({
        ...base,
        outcome: 'adopt',
        targetId: confirmed.id,
        values: fill,
        note: `${name} is already on file with the same CDL expiry; the Ditat key was stamped on it and only empty fields were filled.`,
      });
      continue;
    }

    const sameName = byName.get(nameKey(row.firstName, row.lastName));
    if (sameName) {
      out.push({
        ...base,
        outcome: 'review',
        targetId: sameName.id,
        values: null,
        note: `"${name}" matches a driver already here by name only, with a different CDL expiry. Left alone for a person to decide.`,
      });
      continue;
    }

    out.push({ ...base, outcome: 'create', values });
  }

  const counts: Record<DriverOutcome, number> = {
    create: 0,
    update: 0,
    adopt: 0,
    unchanged: 0,
    review: 0,
    skip: 0,
  };
  const skippedBy: Record<string, number> = {};
  for (const row of out) {
    counts[row.outcome] += 1;
    if (row.outcome === 'skip' && row.note) skippedBy[row.note] = (skippedBy[row.note] ?? 0) + 1;
  }
  return { rows: out, counts, skippedBy };
}
