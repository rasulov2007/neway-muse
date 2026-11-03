import { z } from 'zod';
import type { TrackingState } from './tracking.js';

/**
 * Load risk.
 *
 * A load is at risk when the projected arrival no longer fits the appointment it was booked
 * against. That judgement needs two facts — a current ETA and an appointment window — and when
 * either is absent the engine says `insufficient_data` and names what it is missing. It never
 * guesses, and it never quietly returns `on_track` for a load it could not assess: a silent
 * "fine" on an untrackable load is the failure mode this whole module exists to prevent.
 *
 * Tracking age is an input rather than a verdict: a load can be running perfectly and still be
 * unverifiable, and dispatch needs to see those separately.
 */

export const LOAD_RISK_STATES = [
  'on_track',
  'watch',
  'at_risk',
  'critical',
  'insufficient_data',
  'not_applicable',
] as const;
export const LoadRiskStateSchema = z.enum(LOAD_RISK_STATES);
export type LoadRiskState = z.infer<typeof LoadRiskStateSchema>;

export interface RiskPolicy {
  /** Projected lateness beyond this many minutes is critical. */
  criticalLateMinutes: number;
  /** Any projected lateness at or above this is at risk. */
  atRiskLateMinutes: number;
  /** Arriving within this margin of the window closing is worth watching. */
  watchMarginMinutes: number;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  criticalLateMinutes: 60,
  atRiskLateMinutes: 1,
  watchMarginMinutes: 30,
};

/** Load statuses that have already reached an end state and are no longer assessed. */
const TERMINAL_STATUSES = new Set(['delivered', 'closed', 'cancelled', 'tonu']);

export interface LoadRiskInput {
  loadStatus: string;
  /** Projected arrival at the controlling appointment. */
  etaAt: string | null;
  /** The appointment the ETA is judged against — normally the final delivery. */
  appointmentStartAt: string | null;
  appointmentEndAt: string | null;
  /** An exception already raised on the load, if any. */
  exception: { code: string; reason: string } | null;
  /** How current the position behind the ETA is. */
  tracking: TrackingState;
  nowIso: string;
}

export interface LoadRisk {
  state: LoadRiskState;
  /** Projected minutes past the appointment window; negative means early. Null when unknown. */
  minutesLate: number | null;
  /** True when the verdict rests on a position too old to trust. */
  unverified: boolean;
  reasons: string[];
  /** What is missing, when the state is `insufficient_data`. */
  missing: string[];
  requiredAction: string | null;
}

const RANK: Record<LoadRiskState, number> = {
  not_applicable: 0,
  on_track: 1,
  insufficient_data: 2,
  watch: 3,
  at_risk: 4,
  critical: 5,
};

function raise(current: LoadRiskState, next: LoadRiskState): LoadRiskState {
  return RANK[next] > RANK[current] ? next : current;
}

/**
 * Grades one load. Pure: `nowIso` is supplied, never read from the clock.
 *
 * An exception already raised by a human or an upstream detector is trusted and floors the state,
 * because someone with more context than this function has already said something is wrong.
 */
export function assessLoadRisk(
  input: LoadRiskInput,
  policy: RiskPolicy = DEFAULT_RISK_POLICY,
): LoadRisk {
  const reasons: string[] = [];
  const missing: string[] = [];

  if (TERMINAL_STATUSES.has(input.loadStatus)) {
    return {
      state: 'not_applicable',
      minutesLate: null,
      unverified: false,
      reasons: [`Load is ${input.loadStatus.replace(/_/g, ' ')}; risk is no longer tracked`],
      missing: [],
      requiredAction: null,
    };
  }

  const unverified =
    input.tracking === 'stale' || input.tracking === 'offline' || input.tracking === 'none';

  if (!input.etaAt) missing.push('a current ETA');
  if (!input.appointmentEndAt) missing.push('a delivery appointment window');

  let state: LoadRiskState;
  let minutesLate: number | null = null;

  if (missing.length > 0) {
    state = 'insufficient_data';
    reasons.push(`Cannot judge this load without ${missing.join(' and ')}`);
  } else {
    const eta = Date.parse(input.etaAt as string);
    const end = Date.parse(input.appointmentEndAt as string);
    if (Number.isNaN(eta) || Number.isNaN(end)) {
      state = 'insufficient_data';
      missing.push('a readable ETA or appointment timestamp');
      reasons.push('ETA or appointment could not be read');
    } else {
      minutesLate = Math.round((eta - end) / 60_000);
      if (minutesLate >= policy.criticalLateMinutes) {
        state = 'critical';
        reasons.push(`Projected ${minutesLate} min past the appointment window`);
      } else if (minutesLate >= policy.atRiskLateMinutes) {
        state = 'at_risk';
        reasons.push(`Projected ${minutesLate} min past the appointment window`);
      } else if (Math.abs(minutesLate) <= policy.watchMarginMinutes) {
        state = 'watch';
        reasons.push(
          `Projected arrival is within ${policy.watchMarginMinutes} min of the window closing`,
        );
      } else {
        state = 'on_track';
        reasons.push(`Projected ${Math.abs(minutesLate)} min inside the appointment window`);
      }
    }
  }

  if (input.exception) {
    const floor = input.exception.code === 'at_risk' ? 'at_risk' : 'watch';
    state = raise(state, floor as LoadRiskState);
    reasons.push(`Exception on file: ${input.exception.reason || input.exception.code}`);
  }

  if (unverified && state !== 'not_applicable') {
    state = raise(state, 'watch');
    reasons.push(
      input.tracking === 'none'
        ? 'No tracking on this unit, so the ETA cannot be verified'
        : `Position is ${input.tracking}, so the ETA cannot be verified`,
    );
  }

  let requiredAction: string | null = null;
  if (state === 'critical' || state === 'at_risk') {
    requiredAction = 'Contact the driver and notify the customer of the projected delay';
  } else if (state === 'insufficient_data') {
    requiredAction = `Obtain ${missing.join(' and ')} for this load`;
  } else if (unverified) {
    requiredAction = 'Refresh tracking or contact the driver for a position';
  }

  return { state, minutesLate, unverified, reasons, missing, requiredAction };
}
