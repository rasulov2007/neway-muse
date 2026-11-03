import { z } from 'zod';

/**
 * Tracking freshness.
 *
 * A position is only worth as much as its age. Dispatch decisions made on a 40-minute-old fix are
 * guesses, so the age is surfaced as a first-class state rather than hidden behind a map pin.
 * `docs/OPERATIONS.md` §4.
 *
 * Thresholds are policy, not physics: a carrier polling every 30 seconds and one polling every 15
 * minutes disagree about what "stale" means, so the caller supplies the policy.
 */

export const TRACKING_STATES = ['live', 'recent', 'stale', 'offline', 'none'] as const;
export const TrackingStateSchema = z.enum(TRACKING_STATES);
export type TrackingState = z.infer<typeof TrackingStateSchema>;

export interface FreshnessPolicy {
  /** Up to this age, the position is treated as current. */
  liveMinutes: number;
  /** Up to this age, usable but no longer live. */
  recentMinutes: number;
  /** Beyond this age the feed is treated as offline rather than merely stale. */
  staleMinutes: number;
}

/** Matches a telematics feed reporting every 1–2 minutes, which is the common case. */
export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  liveMinutes: 2,
  recentMinutes: 15,
  staleMinutes: 60,
};

export interface TrackingFreshness {
  state: TrackingState;
  /** Whole minutes since the last fix; null when there has never been one. */
  ageMinutes: number | null;
  /** True only for `live` and `recent`: the position may be acted on. */
  usable: boolean;
  reasons: string[];
}

/**
 * Grades the age of the last position fix.
 *
 * `none` and `offline` are deliberately different: `none` means this unit has never reported (no
 * integration, or a truck with no device), `offline` means it did report and then stopped, which
 * is an operational exception someone has to chase.
 */
export function trackingFreshness(
  lastFixAt: string | null,
  nowIso: string,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
): TrackingFreshness {
  if (!lastFixAt) {
    return {
      state: 'none',
      ageMinutes: null,
      usable: false,
      reasons: ['No position has ever been reported for this unit'],
    };
  }
  const fix = Date.parse(lastFixAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(fix) || Number.isNaN(now)) {
    return {
      state: 'none',
      ageMinutes: null,
      usable: false,
      reasons: ['The last position timestamp could not be read'],
    };
  }

  // A fix in the future is a clock-skew problem, not a fresh position; clamp so it cannot read live.
  const ageMinutes = Math.max(0, Math.floor((now - fix) / 60_000));

  if (ageMinutes <= policy.liveMinutes) {
    return { state: 'live', ageMinutes, usable: true, reasons: [`Updated ${ageMinutes} min ago`] };
  }
  if (ageMinutes <= policy.recentMinutes) {
    return {
      state: 'recent',
      ageMinutes,
      usable: true,
      reasons: [`Updated ${ageMinutes} min ago`],
    };
  }
  if (ageMinutes <= policy.staleMinutes) {
    return {
      state: 'stale',
      ageMinutes,
      usable: false,
      reasons: [`Last fix is ${ageMinutes} min old; position may no longer be accurate`],
    };
  }
  return {
    state: 'offline',
    ageMinutes,
    usable: false,
    reasons: [`No position for ${ageMinutes} min; the unit's feed has stopped reporting`],
  };
}
