import { LOADS_CONFIG, updateIntervalMinutes, type LoadsConfig } from './config.js';
import type { TrackingState } from '../operations/tracking.js';

/**
 * Where the truck will be against where it has to be.
 *
 * Pure. Given the miles still to cover (from Samsara), the appointment, how fresh the position is
 * and the clock, it says one of four things about the next stop - and only four, because a
 * dispatcher acts on a word, not a probability:
 *
 *   on_time    the ETA lands before the deadline with the buffer to spare
 *   at_risk    the ETA lands inside the buffer before the deadline
 *   late       the ETA is past the deadline - or the deadline has passed and no arrival was recorded
 *   no_update  the position is too old to trust, or the truck has no unit; **never counted as on time**
 *
 * The deadline is the window's end for a window and the time itself for a fixed appointment.
 */

export type DeliveryState = 'on_time' | 'at_risk' | 'late' | 'no_update';

export interface EtaInput {
  nowIso: string;
  /** Miles the truck still has to cover to the stop, from its last position. Null when unknown. */
  remainingMiles: number | null;
}

/** `now + remaining / average speed`, as an ISO instant. Null when the miles are unknown. */
export function projectEta(input: EtaInput, config: LoadsConfig = LOADS_CONFIG): string | null {
  if (input.remainingMiles === null || !Number.isFinite(input.remainingMiles) || input.remainingMiles < 0) return null;
  const now = Date.parse(input.nowIso);
  if (Number.isNaN(now)) return null;
  const hours = input.remainingMiles / config.averageSpeedMph;
  return new Date(now + Math.round(hours * 3_600_000)).toISOString();
}

export interface ClassifyInput {
  nowIso: string;
  etaAt: string | null;
  appointmentStartAt: string | null;
  appointmentEndAt: string | null;
  appointmentNoWindow?: boolean;
  /** When the truck actually arrived, if it has. An arrival settles the question. */
  arrivedAt: string | null;
  tracking: TrackingState;
}

export interface DeliveryVerdict {
  state: DeliveryState;
  /** Minutes the ETA (or the arrival) lands past the deadline; negative is early. Null when unknown. */
  minutesLate: number | null;
  reason: string;
}

/** The instant a stop has to be reached by: the window's end, or the fixed time. */
export function deadlineOf(stop: Pick<ClassifyInput, 'appointmentStartAt' | 'appointmentEndAt' | 'appointmentNoWindow'>): number | null {
  const end = stop.appointmentNoWindow ? stop.appointmentStartAt : (stop.appointmentEndAt ?? stop.appointmentStartAt);
  if (!end) return null;
  const ms = Date.parse(end);
  return Number.isNaN(ms) ? null : ms;
}

export function classifyDelivery(input: ClassifyInput, config: LoadsConfig = LOADS_CONFIG): DeliveryVerdict {
  const deadline = deadlineOf(input);
  const now = Date.parse(input.nowIso);

  // An arrival on record is a fact; the ETA is a guess. The fact wins.
  if (input.arrivedAt) {
    const arrived = Date.parse(input.arrivedAt);
    if (deadline !== null && !Number.isNaN(arrived)) {
      const minutesLate = Math.round((arrived - deadline) / 60_000);
      return minutesLate > 0
        ? { state: 'late', minutesLate, reason: `Arrived ${minutesLate} min after the appointment` }
        : { state: 'on_time', minutesLate, reason: 'Arrived inside the appointment' };
    }
  }

  const usable = input.tracking === 'live' || input.tracking === 'recent';
  if (!usable) {
    // Past the deadline with no arrival on record: that is late, whatever the feed is doing.
    if (deadline !== null && !Number.isNaN(now) && now > deadline) {
      const minutesLate = Math.round((now - deadline) / 60_000);
      return { state: 'late', minutesLate, reason: `Appointment passed ${minutesLate} min ago with no arrival recorded` };
    }
    return {
      state: 'no_update',
      minutesLate: null,
      reason: input.tracking === 'none' ? 'No Samsara unit on this truck' : `Position is ${input.tracking}; the ETA cannot be trusted`,
    };
  }

  if (deadline === null) {
    return { state: 'no_update', minutesLate: null, reason: 'No appointment to judge the ETA against' };
  }
  if (!input.etaAt) {
    if (!Number.isNaN(now) && now > deadline) {
      const minutesLate = Math.round((now - deadline) / 60_000);
      return { state: 'late', minutesLate, reason: `Appointment passed ${minutesLate} min ago with no arrival recorded` };
    }
    return { state: 'no_update', minutesLate: null, reason: 'No ETA yet' };
  }
  const eta = Date.parse(input.etaAt);
  if (Number.isNaN(eta)) return { state: 'no_update', minutesLate: null, reason: 'The ETA could not be read' };

  const minutesLate = Math.round((eta - deadline) / 60_000);
  if (minutesLate > 0) return { state: 'late', minutesLate, reason: `ETA is ${minutesLate} min past the appointment` };
  if (-minutesLate <= config.latenessBufferMinutes) {
    return { state: 'at_risk', minutesLate, reason: `ETA is only ${-minutesLate} min before the appointment` };
  }
  return { state: 'on_time', minutesLate, reason: `ETA is ${-minutesLate} min before the appointment` };
}

export interface UpdateDueInput {
  nowIso: string;
  /** The next appointment the load is running to. */
  appointmentAt: string | null;
  /** The last check-call, position or stop event on the load. */
  lastUpdateAt: string | null;
}

export interface UpdateDue {
  /** How often an update is needed right now, from the cadence table. */
  everyMinutes: number;
  /** Minutes since the last update; null when there has never been one. */
  sinceMinutes: number | null;
  /** True when the load is overdue for an update. */
  due: boolean;
}

/** Whether a rolling load is owed an update: the nearer the appointment, the more often. */
export function updateDue(input: UpdateDueInput, config: LoadsConfig = LOADS_CONFIG): UpdateDue {
  const now = Date.parse(input.nowIso);
  const appointment = input.appointmentAt ? Date.parse(input.appointmentAt) : Number.NaN;
  const minutesToAppointment = Number.isNaN(appointment) || Number.isNaN(now)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.round((appointment - now) / 60_000));
  const everyMinutes = updateIntervalMinutes(minutesToAppointment, config.updateCadence);
  const last = input.lastUpdateAt ? Date.parse(input.lastUpdateAt) : Number.NaN;
  const sinceMinutes = Number.isNaN(last) || Number.isNaN(now) ? null : Math.max(0, Math.round((now - last) / 60_000));
  return { everyMinutes, sinceMinutes, due: sinceMinutes === null || sinceMinutes > everyMinutes };
}
