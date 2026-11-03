/**
 * The numbers the Loads rules run on. One place, so the owner can change them without reading code.
 *
 * Every figure here is a default the product ships with; nothing else in the codebase repeats
 * them. When a company setting for one of these exists it wins - until then, this is the setting.
 */

export interface UpdateCadenceStep {
  /** Applies while the next appointment is at most this many minutes away. */
  withinMinutes: number;
  /** How often the load needs a check-call or a position while that is true. */
  everyMinutes: number;
}

export interface LoadsConfig {
  /**
   * Average over-the-road speed, in miles per hour, used to project an ETA from the miles the
   * truck still has to cover: `eta = now + remaining_miles / averageSpeedMph`.
   */
  averageSpeedMph: number;
  /**
   * How close to the appointment an ETA may land before the load reads "at risk". An ETA inside
   * this buffer before the deadline is at risk; an ETA past the deadline is late.
   */
  latenessBufferMinutes: number;
  /**
   * How often a rolling load needs an update, by how soon its next appointment is. Read top to
   * bottom; the first step whose `withinMinutes` covers the time left applies. The last step is
   * the fallback for anything further out.
   */
  updateCadence: readonly UpdateCadenceStep[];
  /** Free time at a stop before detention starts, unless the stop (from the rate con) says otherwise. */
  freeTimeMinutes: number;
  /**
   * What an hour of detention is drafted at, in dollars, when the rate con does not say. The
   * draft is a suggestion for the person who bills the broker, never a billed amount by itself.
   */
  detentionRatePerHour: number;
}

export const LOADS_CONFIG: LoadsConfig = {
  averageSpeedMph: 47,
  latenessBufferMinutes: 30,
  updateCadence: [
    { withinMinutes: 60, everyMinutes: 15 },
    { withinMinutes: 3 * 60, everyMinutes: 30 },
    { withinMinutes: 8 * 60, everyMinutes: 60 },
    { withinMinutes: 24 * 60, everyMinutes: 2 * 60 },
    { withinMinutes: Number.POSITIVE_INFINITY, everyMinutes: 4 * 60 },
  ],
  freeTimeMinutes: 120,
  detentionRatePerHour: 50,
};

/**
 * Detention at a stop, from the clock the industry runs on: free time starts when the truck is
 * on the property or when the appointment opens, whichever is later - arriving early earns
 * nothing - and every minute past the free time counts until the truck leaves.
 *
 * Returns the billable minutes (0 when none) and the draft amount at the given hourly rate,
 * rounded to whole cents.
 */
export function detentionAt(
  stop: { arrivedAt: string | null; appointmentStartAt: string; freeTimeMinutes?: number | null },
  departedAt: string,
  config: Pick<LoadsConfig, 'freeTimeMinutes' | 'detentionRatePerHour'> = LOADS_CONFIG,
): { minutes: number; amount: number; freeTimeMinutes: number } {
  const free = stop.freeTimeMinutes ?? config.freeTimeMinutes;
  const arrived = Date.parse(stop.arrivedAt ?? departedAt);
  const opens = Date.parse(stop.appointmentStartAt);
  const left = Date.parse(departedAt);
  if ([arrived, left].some(Number.isNaN)) return { minutes: 0, amount: 0, freeTimeMinutes: free };
  const clockStart = Number.isNaN(opens) ? arrived : Math.max(arrived, opens);
  const minutes = Math.max(0, Math.round((left - clockStart) / 60_000) - free);
  const amount = Math.round((minutes / 60) * config.detentionRatePerHour * 100) / 100;
  return { minutes, amount, freeTimeMinutes: free };
}

/** The update interval that applies with this many minutes to the next appointment. */
export function updateIntervalMinutes(
  minutesToAppointment: number,
  cadence: readonly UpdateCadenceStep[] = LOADS_CONFIG.updateCadence,
): number {
  const step = cadence.find((s) => minutesToAppointment <= s.withinMinutes) ?? cadence[cadence.length - 1];
  return step?.everyMinutes ?? 4 * 60;
}
