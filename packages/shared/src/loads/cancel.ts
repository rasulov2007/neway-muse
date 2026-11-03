import { z } from 'zod';
import type { Cancellation, CancelOutcome, LoadLike, LoadStatusCode } from './model.js';

/**
 * Cancelling a load (P0.1).
 *
 * Who may cancel depends only on how far the load got. Before the driver was dispatched anybody
 * on dispatch may; once the driver is rolling it takes the lead, because a truck already moving
 * toward the pickup is money the company will ask about. Past the pickup the freight is on the
 * trailer and the load can no longer be cancelled - it is delivered, or it is a claim, and
 * neither is this dialog.
 */
export type CancelRequirement = 'any' | 'lead' | 'forbidden';

export function cancelRequires(status: LoadStatusCode): CancelRequirement {
  switch (status) {
    case 'booked':
    case 'assigned':
      return 'any';
    case 'dispatched':
    case 'at_pickup':
      return 'lead';
    default:
      return 'forbidden';
  }
}

export const CancelLoadSchema = z.object({
  outcome: z.enum(['cancelled', 'tonu']),
  reason: z.string().trim().min(3, 'Say why the load is being cancelled').max(500),
  /** Who asked - the broker's or the customer's name, or "us". */
  requestedBy: z.string().trim().min(1, 'Say who requested it').max(120),
  /**
   * The broker's approval (rule 1.9). A cancellation the broker has not agreed to is a dispute,
   * not a cancellation, so this is required: who said yes, how, and the reference or note that
   * shows it.
   */
  approval: z.object({
    by: z.string().trim().min(1, 'Say who at the broker approved it').max(120),
    method: z.enum(['email', 'phone', 'other']),
    reference: z.string().trim().max(200).nullable().optional(),
    at: z.string().min(1, 'Say when the approval came'),
  }),
  /** Dollars. Required for a TONU, ignored otherwise. */
  fee: z.number().nonnegative().max(100_000).nullable().optional(),
  /** The `updatedAt` the caller was looking at; a stale one is refused, never merged. */
  expectedUpdatedAt: z.string().min(1),
});
export type CancelLoadInput = z.infer<typeof CancelLoadSchema>;
export type CancelLoadRequest = z.input<typeof CancelLoadSchema>;

export interface CancelActor {
  id: string;
  name: string;
  isLead: boolean;
}

export type CancelRefusal =
  | { code: 'status'; message: string }
  | { code: 'lead'; message: string }
  | { code: 'fee'; message: string };

/** Why this actor cannot cancel this load now, or null when they can. */
export function cancelRefusal(
  load: Pick<LoadLike, 'status' | 'loadNumber'>,
  input: Pick<CancelLoadInput, 'outcome' | 'fee'>,
  actor: Pick<CancelActor, 'isLead'>,
): CancelRefusal | null {
  const requirement = cancelRequires(load.status);
  if (requirement === 'forbidden') {
    return {
      code: 'status',
      message: `${load.loadNumber} is ${load.status.replace(/_/g, ' ')}; a load past the pickup is delivered or claimed, not cancelled.`,
    };
  }
  if (requirement === 'lead' && !actor.isLead) {
    return {
      code: 'lead',
      message: `${load.loadNumber} is already dispatched. Ask a dispatch lead to cancel it.`,
    };
  }
  if (input.outcome === 'tonu' && (input.fee === null || input.fee === undefined)) {
    return { code: 'fee', message: 'A TONU needs the fee the broker agreed to, even if it is $0.' };
  }
  return null;
}

export interface TonuCharge {
  id: string;
  type: 'tonu';
  description: string;
  amount: number;
  billable: true;
  payableToDriver: false;
}

export interface CancelledLoadPatch {
  status: CancelOutcome;
  cancellation: Cancellation;
  /** A TONU is the one charge left to bill; a cancelled load bills nothing. */
  charges: TonuCharge[];
  driverId: null;
  driverName: null;
  truckId: null;
  truckUnit: null;
  trailerId: null;
  trailerUnit: null;
  exception: null;
  etaAt: null;
  milesRemaining: null;
  updatedAt: string;
}

/**
 * The fields a cancel changes, and nothing else. The driver, truck and trailer are freed so the
 * board offers them again; the stops keep whatever happened at them; the rate stays as the
 * record of what was agreed, but the charges become the TONU fee alone (or nothing), because
 * the linehaul was never earned.
 */
export function cancelPatch(
  input: Pick<CancelLoadInput, 'outcome' | 'reason' | 'requestedBy' | 'fee' | 'approval'>,
  actor: Pick<CancelActor, 'id' | 'name'>,
  now: string,
  chargeId: string,
): CancelledLoadPatch {
  return {
    status: input.outcome,
    charges:
      input.outcome === 'tonu'
        ? [
            {
              id: chargeId,
              type: 'tonu',
              description: 'Truck ordered not used',
              amount: input.fee ?? 0,
              billable: true,
              payableToDriver: false,
            },
          ]
        : [],
    cancellation: {
      outcome: input.outcome,
      reason: input.reason.trim(),
      requestedBy: input.requestedBy.trim(),
      approval: {
        by: input.approval.by.trim(),
        method: input.approval.method,
        reference: input.approval.reference?.trim() || null,
        at: input.approval.at,
      },
      fee: input.outcome === 'tonu' ? (input.fee ?? 0) : null,
      at: now,
      byId: actor.id,
      byName: actor.name,
    },
    driverId: null,
    driverName: null,
    truckId: null,
    truckUnit: null,
    trailerId: null,
    trailerUnit: null,
    exception: null,
    etaAt: null,
    milesRemaining: null,
    updatedAt: now,
  };
}

/** The timeline line a cancel writes, in the words the history reads. */
export function cancelEventTitle(input: Pick<CancelLoadInput, 'outcome' | 'fee'>): string {
  if (input.outcome === 'tonu') {
    const fee = input.fee ?? 0;
    return `TONU - $${fee.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} fee`;
  }
  return 'Cancelled';
}

export function cancelEventDetail(
  input: Pick<CancelLoadInput, 'reason' | 'requestedBy'>,
  freed: { driverName: string | null; truckUnit: string | null; trailerUnit: string | null },
): string {
  const parts = [`Requested by ${input.requestedBy.trim()}`, input.reason.trim()];
  const released = [
    freed.driverName ? `driver ${freed.driverName}` : null,
    freed.truckUnit ? `unit ${freed.truckUnit}` : null,
    freed.trailerUnit ? `trailer ${freed.trailerUnit}` : null,
  ].filter((part): part is string => part !== null);
  if (released.length > 0) parts.push(`Released ${released.join(', ')}`);
  return parts.join(' · ');
}
