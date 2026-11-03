import { unitKey } from '../dispatch/roster-match.js';

/**
 * Planning a broker import from Ditat's customer list.
 *
 * Brokers live in the workspace collection the Brokers page already reads, so this planner talks
 * in that record's own shape rather than inventing a second one. Pure, like the trailer planner:
 * the caller reads what exists, hands it here, and writes exactly what comes back.
 *
 * The ladder:
 *
 *   1. the Ditat key — imported before → update in place
 *   2. name **and** MC/FF number together → adopt the row that is here
 *   3. the name alone → **needs review**, never merged. "Prime" is four different companies in a
 *      list of 850, and a wrong merge sends an invoice to the wrong office
 *   4. nothing → create
 */

export type BrokerOutcome = 'create' | 'update' | 'adopt' | 'unchanged' | 'review' | 'skip';

export interface DitatCustomerRow {
  customerId: string;
  company: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  address1: string;
  address2: string;
  municipality: string;
  administrativeArea: string;
  postalCode: string;
  mcOrFFNumber: string;
  paymentTermsDays: string;
  isOnCreditHold: string;
  isActive: string;
}

/** A broker as the workspace holds it; only the fields the planner reads or writes. */
export interface ExistingBroker {
  id: string;
  name: string;
  mcNumber: string;
  usdot: string;
  address: { line1: string; city: string; state: string; zip: string };
  paymentTermsDays: number;
  status: string;
  primaryContact: { name: string; email: string; phone: string };
  source?: string | null;
  externalId?: string | null;
}

export interface BrokerPlanRow {
  outcome: BrokerOutcome;
  externalId: string;
  name: string;
  targetId: string | null;
  /** The whole record to write on a create; the changed fields on an update or an adoption. */
  values: Partial<ExistingBroker> | null;
  note: string | null;
}

export interface BrokerPlan {
  rows: BrokerPlanRow[];
  counts: Record<BrokerOutcome, number>;
  skippedBy: Record<string, number>;
}

function clean(value: string): string {
  return value.trim();
}

/** Comparable name: case, punctuation and the company suffixes people write inconsistently. */
export function brokerKey(name: string): string {
  return clean(name)
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|ltd|co|corp|company|logistics|transport|trucking)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `MC-123456` and `123456` are one number; a blank one is not a key at all. */
export function mcKey(value: string): string {
  const digits = clean(value).replace(/\D+/g, '');
  return digits.length >= 4 ? digits : '';
}

function termsOf(value: string): number {
  const n = Number.parseInt(clean(value), 10);
  return Number.isFinite(n) && n >= 0 && n <= 365 ? n : 30;
}

function yes(value: string): boolean {
  return /^(yes|true|1)$/i.test(clean(value));
}

export function planBrokers(rows: DitatCustomerRow[], existing: ExistingBroker[]): BrokerPlan {
  const byKey = new Map(existing.filter((b) => b.externalId).map((b) => [`ditat|${b.externalId}`, b]));
  const byNameAndMc = new Map(
    existing.filter((b) => mcKey(b.mcNumber)).map((b) => [`${brokerKey(b.name)}|${mcKey(b.mcNumber)}`, b]),
  );
  const byName = new Map(existing.map((b) => [brokerKey(b.name), b]));
  const seen = new Set<string>();

  const out: BrokerPlanRow[] = [];
  for (const row of rows) {
    const id = clean(row.customerId);
    const name = clean(row.company) || [clean(row.firstName), clean(row.lastName)].filter(Boolean).join(' ');
    const base: BrokerPlanRow = { outcome: 'skip', externalId: id, name, targetId: null, values: null, note: null };

    if (!id) {
      out.push({ ...base, note: 'The row carries no customer id, so a later run could not recognise it.' });
      continue;
    }
    if (!name) {
      out.push({ ...base, note: 'The row carries no company or contact name, so there is nothing to file it under.' });
      continue;
    }
    if (seen.has(id)) {
      out.push({ ...base, note: `Customer ${id} appears twice in this export; the first row was used.` });
      continue;
    }
    seen.add(id);

    const values: Partial<ExistingBroker> = {
      name,
      mcNumber: clean(row.mcOrFFNumber),
      usdot: '',
      address: {
        line1: [clean(row.address1), clean(row.address2)].filter(Boolean).join(', '),
        city: clean(row.municipality),
        state: clean(row.administrativeArea).toUpperCase(),
        zip: clean(row.postalCode),
      },
      paymentTermsDays: termsOf(row.paymentTermsDays),
      // A customer on credit hold is not "do not use"; it is a broker somebody must decide about,
      // and the word for that here is on_hold.
      status: yes(row.isOnCreditHold) ? 'on_hold' : yes(row.isActive) ? 'active' : 'inactive',
      primaryContact: {
        name: [clean(row.firstName), clean(row.lastName)].filter(Boolean).join(' '),
        email: clean(row.email).toLowerCase(),
        phone: clean(row.phone),
      },
      source: 'ditat',
      externalId: id,
    };

    const linked = byKey.get(`ditat|${id}`);
    if (linked) {
      const changed =
        linked.name !== values.name ||
        linked.mcNumber !== values.mcNumber ||
        linked.paymentTermsDays !== values.paymentTermsDays ||
        linked.status !== values.status ||
        linked.address.line1 !== values.address!.line1 ||
        linked.address.city !== values.address!.city ||
        linked.address.state !== values.address!.state ||
        linked.address.zip !== values.address!.zip ||
        linked.primaryContact.email !== values.primaryContact!.email ||
        linked.primaryContact.phone !== values.primaryContact!.phone;
      out.push({ ...base, outcome: changed ? 'update' : 'unchanged', targetId: linked.id, values: changed ? values : null });
      continue;
    }

    const mc = mcKey(row.mcOrFFNumber);
    const confirmed = mc ? byNameAndMc.get(`${brokerKey(name)}|${mc}`) : undefined;
    if (confirmed) {
      out.push({
        ...base,
        outcome: 'adopt',
        targetId: confirmed.id,
        values: { source: 'ditat', externalId: id },
        note: `${confirmed.name} is already here with the same MC number; the Ditat key was stamped on it.`,
      });
      continue;
    }

    const sameName = byName.get(brokerKey(name));
    if (sameName) {
      out.push({
        ...base,
        outcome: 'review',
        targetId: sameName.id,
        values: null,
        note: `"${name}" matches "${sameName.name}" by name only, with no MC number to confirm it. Left alone for a person to decide.`,
      });
      continue;
    }

    out.push({ ...base, outcome: 'create', values });
  }

  const counts: Record<BrokerOutcome, number> = {
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

/** Kept so the trailer and broker planners agree on what a unit number means. */
export { unitKey };
