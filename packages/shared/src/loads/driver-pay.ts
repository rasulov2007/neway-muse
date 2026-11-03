import { z } from 'zod';
import type { StoredLoad, WriteResult } from './write-rules.js';

/**
 * Real rate and "For driver" rate (owner, 2026-10-23).
 *
 * The company sometimes gives a lane to a driver for less than the broker pays: the broker pays
 * $3,000 (the Real rate, on the RC, on the invoice, sent to RTS) and the driver is paid as if the
 * load were $2,500 (the For driver rate). Driver pay - the statement, its percentage, the PDF the
 * driver reads - is figured on the For driver amount; billing never reads it.
 *
 * Stored inside the load record, no column of its own: `driverRate` on the load for the linehaul,
 * `driverAmount` on a charge for an accessorial (detention, layover). Null or absent means "the
 * same as the real amount", so a load nobody touched pays exactly what it always did, and a rate
 * the broker moves is followed until somebody sets a different For driver figure.
 */

/** A load charge as far as driver pay is concerned. */
export interface DriverPayCharge {
  id: string;
  type: string;
  description: string;
  amount: number;
  billable?: boolean;
  status?: string;
  /** What the driver is paid on for this charge; null or absent = `amount`. */
  driverAmount?: number | null;
}

/** Any load record or load: only `rate`, `driverRate` and `charges` are read. */
type LoadMoney = object;
const field = (load: LoadMoney, key: 'rate' | 'driverRate' | 'charges'): unknown => (load as Record<string, unknown>)[key];

const cents = (dollars: number) => Math.round(dollars * 100);

function chargesOf(load: LoadMoney): DriverPayCharge[] {
  return Array.isArray(field(load, 'charges')) ? (field(load, 'charges') as DriverPayCharge[]) : [];
}

/** A set For driver figure: a finite, non-negative number. Anything else reads as "not set". */
function setAmount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The linehaul the broker pays: the linehaul charge, else the load's rate. */
export function realLinehaulOf(load: LoadMoney): number {
  const linehaul = chargesOf(load).find((c) => c.type === 'linehaul');
  return linehaul ? Number(linehaul.amount) || 0 : Number(field(load, 'rate')) || 0;
}

/** The linehaul the driver is paid on: the For driver rate when one is set, else the real one. */
export function driverRateOf(load: LoadMoney): number {
  return setAmount(field(load, 'driverRate')) ?? realLinehaulOf(load);
}

/** Whether the load carries a For driver rate different from the real one. */
export function hasDriverRate(load: LoadMoney): boolean {
  const set = setAmount(field(load, 'driverRate'));
  return set !== null && cents(set) !== cents(realLinehaulOf(load));
}

/** What the driver is paid on for one accessorial: its For driver amount, else the real amount. */
export function chargeDriverAmount(charge: Pick<DriverPayCharge, 'amount' | 'driverAmount'>): number {
  return setAmount(charge.driverAmount) ?? (Number(charge.amount) || 0);
}

/** The accessorials that count: accepted ones, never a draft nobody accepted or one dropped. */
function liveAccessorials(load: LoadMoney): DriverPayCharge[] {
  return chargesOf(load).filter((c) => c.type !== 'linehaul' && c.status !== 'draft' && c.status !== 'dropped');
}

/**
 * A load's money for settlements, real and For driver side by side.
 *
 * `linehaulCents` and each accessorial's `amountCents` are the For driver figures - what the pay
 * plan reads. `grossCents` stays the real gross (linehaul + billable accessorials as billed): it is
 * the load's revenue, which the vendor (truck owner) statement and the revenue columns read.
 */
export function settleableAmounts(load: LoadMoney): {
  grossCents: number;
  realLinehaulCents: number;
  linehaulCents: number;
  accessorials: Array<{ id: string; type: string; description: string; billable: boolean; realAmountCents: number; amountCents: number }>;
} {
  const accessorials = liveAccessorials(load);
  const realLinehaul = realLinehaulOf(load);
  return {
    grossCents: cents(realLinehaul + accessorials.filter((a) => a.billable).reduce((s, a) => s + (Number(a.amount) || 0), 0)),
    realLinehaulCents: cents(realLinehaul),
    linehaulCents: cents(driverRateOf(load)),
    accessorials: accessorials.map((a) => ({
      id: a.id,
      type: a.type,
      description: a.description,
      billable: a.billable !== false,
      realAmountCents: cents(Number(a.amount) || 0),
      amountCents: cents(chargeDriverAmount(a)),
    })),
  };
}

/**
 * How a statement names a load (owner, 2026-10-23): the broker's REF beside our L-number, so a
 * driver and the broker's paperwork can be matched line for line. "REF 123456 / L-100015".
 */
export function loadRefLabel(brokerReference: string | null | undefined, loadNumber: string | null | undefined): string {
  const ref = (brokerReference ?? '').trim();
  const number = (loadNumber ?? '').trim();
  if (!ref) return number;
  return number ? `REF ${ref} / ${number}` : `REF ${ref}`;
}

/** A company driver (CD) is paid by the company's plan; the load's rate is not theirs to see. */
export function isCompanyDriverType(driverType: string | null | undefined): boolean {
  const t = (driverType ?? '').trim().toLowerCase();
  return t === 'company' || t === 'cd' || t === 'company_driver';
}

// ------------------------------------------------------------------ the write

/**
 * Accounting's correction of a load's pay facts from the statement: the For driver rate, a For
 * driver amount per accessorial, and the broker's REF number. Version-checked against the load as
 * the screen read it; null clears a For driver figure back to "same as real".
 */
export const LoadPayFactsSchema = z
  .object({
    expectedUpdatedAt: z.string().min(1),
    driverRate: z.number().finite().min(0).nullable().optional(),
    charges: z.array(z.object({ chargeId: z.string().min(1), driverAmount: z.number().finite().min(0).nullable() })).max(50).optional(),
    brokerReference: z.string().trim().max(80).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.driverRate !== undefined || (v.charges?.length ?? 0) > 0 || v.brokerReference !== undefined, { message: 'Nothing to change.' });
export type LoadPayFactsInput = z.infer<typeof LoadPayFactsSchema>;

/**
 * The pay facts merged onto the record. A For driver figure equal to the real one is stored as
 * null, so it keeps following the real amount. A charge the load does not have is refused, never
 * created here.
 */
export function applyPayFacts<T extends StoredLoad>(record: T, input: LoadPayFactsInput, now: string): WriteResult<T> {
  if (record.updatedAt !== input.expectedUpdatedAt) {
    return { ok: false, refusal: { code: 'conflict', message: `${record.loadNumber} changed since you opened it. Reload and try again.` } };
  }
  const next: Record<string, unknown> = { ...record };
  let changed = false;
  if (input.driverRate !== undefined) {
    const real = realLinehaulOf(record);
    const value = input.driverRate === null || cents(input.driverRate) === cents(real) ? null : input.driverRate;
    if ((setAmount(record['driverRate']) ?? null) !== value) {
      next['driverRate'] = value;
      changed = true;
    }
  }
  if (input.charges && input.charges.length > 0) {
    const charges = chargesOf(record).map((c) => ({ ...c }));
    for (const change of input.charges) {
      const charge = charges.find((c) => c.id === change.chargeId);
      if (!charge || charge.type === 'linehaul') {
        return { ok: false, refusal: { code: 'not_found', message: `${record.loadNumber} has no accessorial ${change.chargeId}.` } };
      }
      const value = change.driverAmount === null || cents(change.driverAmount) === cents(Number(charge.amount) || 0) ? null : change.driverAmount;
      if ((setAmount(charge.driverAmount) ?? null) !== value) {
        charge.driverAmount = value;
        changed = true;
      }
    }
    next['charges'] = charges;
  }
  if (input.brokerReference !== undefined) {
    const ref = input.brokerReference.trim();
    if (!ref) return { ok: false, refusal: { code: 'invalid', message: 'The REF number cannot be blank.' } };
    if (ref !== String(record['brokerReference'] ?? '')) {
      next['brokerReference'] = ref;
      changed = true;
    }
  }
  if (!changed) return { ok: true, record, event: null };
  return { ok: true, record: { ...next, updatedAt: now } as T, event: null };
}
