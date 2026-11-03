/**
 * When a unit is next due, on whichever limit arrives first.
 *
 * A PM interval has two limits — miles and days — and the one that binds is whichever runs out
 * first. Reporting only the odometer makes a parked truck look forever healthy; reporting only the
 * calendar makes a hard-running truck look fine until its engine says otherwise. This engine
 * answers on both and names which limit bound.
 *
 * Honesty rules:
 *  - A schedule with neither a mileage limit nor a date limit is `unknown`, not `ok`.
 *  - Miles remaining needs a current odometer. Without one the mileage limit simply does not
 *    participate, and `basis` says so.
 */

export const MAINTENANCE_URGENCY = ['ok', 'due_soon', 'overdue', 'scheduled', 'unknown'] as const;
export type MaintenanceUrgency = (typeof MAINTENANCE_URGENCY)[number];

export interface MaintenancePolicy {
  /** Miles remaining at or below which a service is called due soon. */
  dueSoonMiles: number;
  /** Days remaining at or below which a service is called due soon. */
  dueSoonDays: number;
}

export const DEFAULT_MAINTENANCE_POLICY: MaintenancePolicy = {
  dueSoonMiles: 2000,
  dueSoonDays: 14,
};

export interface MaintenanceDueInput {
  /** Odometer at which the service falls due, when the schedule has a mileage limit. */
  nextDueOdometer?: number | null;
  /** Date on which the service falls due, when the schedule has a calendar limit (YYYY-MM-DD). */
  nextDueAt?: string | null;
  /** The unit's current odometer. */
  currentOdometer?: number | null;
  /** Set when the work is already booked into a shop. */
  scheduledFor?: string | null;
}

export interface MaintenanceDue {
  urgency: MaintenanceUrgency;
  /** Positive = miles remaining; negative = miles overdue. Null when it cannot be computed. */
  milesRemaining: number | null;
  /** Positive = days remaining; negative = days overdue. Null when it cannot be computed. */
  daysRemaining: number | null;
  /** Which limit produced the urgency. */
  basis: 'miles' | 'days' | 'both' | 'scheduled' | 'none';
  /** One sentence a shop foreman can act on. */
  summary: string;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(fromIsoDate: string, toIsoDate: string): number | null {
  const from = Date.parse(`${fromIsoDate.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toIsoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / MS_PER_DAY);
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${Math.abs(n) === 1 ? one : many}`;
}

export function maintenanceDue(
  input: MaintenanceDueInput,
  today: string,
  policy: MaintenancePolicy = DEFAULT_MAINTENANCE_POLICY,
): MaintenanceDue {
  const milesRemaining =
    typeof input.nextDueOdometer === 'number' && typeof input.currentOdometer === 'number'
      ? Math.round(input.nextDueOdometer - input.currentOdometer)
      : null;
  const daysRemaining = input.nextDueAt ? daysBetween(today, input.nextDueAt) : null;

  if (milesRemaining === null && daysRemaining === null) {
    return {
      urgency: 'unknown',
      milesRemaining: null,
      daysRemaining: null,
      basis: 'none',
      summary: 'No service interval recorded for this unit',
    };
  }

  const milesOverdue = milesRemaining !== null && milesRemaining < 0;
  const daysOverdue = daysRemaining !== null && daysRemaining < 0;

  // Overdue is reported even when the work is booked: a scheduled repair does not un-overdue a
  // unit that is already past its limit, and the shop needs to see both facts.
  if (milesOverdue || daysOverdue) {
    const parts: string[] = [];
    if (milesOverdue) parts.push(`${plural(Math.abs(milesRemaining), 'mile', 'miles')} past due`);
    if (daysOverdue) parts.push(`${plural(Math.abs(daysRemaining), 'day', 'days')} past due`);
    return {
      urgency: 'overdue',
      milesRemaining,
      daysRemaining,
      basis: milesOverdue && daysOverdue ? 'both' : milesOverdue ? 'miles' : 'days',
      summary: `Overdue — ${parts.join(' and ')}${input.scheduledFor ? `; booked for ${input.scheduledFor}` : ''}`,
    };
  }

  if (input.scheduledFor) {
    return {
      urgency: 'scheduled',
      milesRemaining,
      daysRemaining,
      basis: 'scheduled',
      summary: `Booked into a shop for ${input.scheduledFor}`,
    };
  }

  const milesSoon = milesRemaining !== null && milesRemaining <= policy.dueSoonMiles;
  const daysSoon = daysRemaining !== null && daysRemaining <= policy.dueSoonDays;

  if (milesSoon || daysSoon) {
    const parts: string[] = [];
    if (milesSoon) parts.push(`${plural(milesRemaining, 'mile', 'miles')} remaining`);
    if (daysSoon) parts.push(`${plural(daysRemaining, 'day', 'days')} remaining`);
    return {
      urgency: 'due_soon',
      milesRemaining,
      daysRemaining,
      basis: milesSoon && daysSoon ? 'both' : milesSoon ? 'miles' : 'days',
      summary: `Due soon — ${parts.join(' and ')}`,
    };
  }

  const parts: string[] = [];
  if (milesRemaining !== null) parts.push(`${plural(milesRemaining, 'mile', 'miles')} remaining`);
  if (daysRemaining !== null) parts.push(`${plural(daysRemaining, 'day', 'days')} remaining`);
  return {
    urgency: 'ok',
    milesRemaining,
    daysRemaining,
    basis:
      milesRemaining !== null && daysRemaining !== null
        ? 'both'
        : milesRemaining !== null
          ? 'miles'
          : 'days',
    summary: `Next service ${parts.join(' and ')}`,
  };
}

/** Ranking used to sort a mixed list worst-first. */
export const MAINTENANCE_URGENCY_RANK: Record<MaintenanceUrgency, number> = {
  overdue: 0,
  due_soon: 1,
  scheduled: 2,
  unknown: 3,
  ok: 4,
};
