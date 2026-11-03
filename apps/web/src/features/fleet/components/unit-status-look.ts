import type { BadgeTone } from '@/design-system';
import { UNIT_EXIT_REASON_LABEL, latestUnitExit, type UnitExitReason, type UnitExitRecord } from '@/demo';

/** Statuses a unit is off the road in, where the filed account says why. */
const OFF_ROAD = new Set(['inactive', 'out_of_service', 'sold']);

/**
 * The colour of a unit that is off the road follows what happened to it (owner, 2026-10-10): a loss
 * reads urgent, a breakdown reads warning, a lease return reads blue, a sale stays neutral.
 */
const REASON_TONE: Record<UnitExitReason, BadgeTone> = {
  stolen: 'danger',
  fire: 'danger',
  accident: 'danger',
  totaled: 'danger',
  mechanical: 'warning',
  sold: 'neutral',
  lease_returned: 'info',
  age_retired: 'neutral',
  other: 'warning',
};

/** Short words for the list; the long labels stay on the unit's own page. */
const REASON_SHORT: Partial<Record<UnitExitReason, string>> = {
  totaled: 'Total loss',
  mechanical: 'Mechanical',
  lease_returned: 'Returned',
  age_retired: 'Retired',
};

export interface OffRoadLook {
  exit: UnitExitRecord | null;
  tone: BadgeTone;
  /** "Inactive · Fire", or the label alone when nothing was filed. */
  text: string;
  /** The full reason and the account, for the tooltip. */
  detail: string | null;
}

/** How a unit's status reads in a list, with the reason it is off the road when it is. */
export function unitStatusLook(id: string, status: string, label: string, tone: BadgeTone): OffRoadLook {
  const exit = OFF_ROAD.has(status) ? latestUnitExit(id) : null;
  if (!exit) return { exit: null, tone: status === 'inactive' ? 'warning' : tone, text: label, detail: null };
  return {
    exit,
    tone: REASON_TONE[exit.reason],
    text: `${label} · ${REASON_SHORT[exit.reason] ?? UNIT_EXIT_REASON_LABEL[exit.reason]}`,
    detail: `${UNIT_EXIT_REASON_LABEL[exit.reason]}: ${exit.narrative}`,
  };
}

/** The colour an exit reason reads in, wherever the reason is shown. */
export function exitReasonTone(reason: UnitExitReason): BadgeTone {
  return REASON_TONE[reason];
}
