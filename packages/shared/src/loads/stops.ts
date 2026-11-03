import { resolveStopZone } from './timezone.js';
import { stopHandlingOf, type StopHandling, type StopLike } from './model.js';

/**
 * Editing a route (P0.2).
 *
 * A stop that stays where it was keeps its record: its arrival and departure happened. A stop
 * whose city changed is a different place, so it gets that place's clock - never the previous
 * city's zone - and its arrival and departure are cleared only once a person has said so. The
 * rule below reports what a proposed route would lose; the caller shows that and comes back with
 * `confirmClearEvents` when the person agreed.
 */
export interface StopEdit {
  kind: 'pickup' | 'delivery';
  city: string;
  state: string;
  zip?: string | null;
  facilityName?: string;
  facilityId?: string;
  /** Appointment start, ISO (UTC). */
  at: string;
  /** Appointment end, ISO (UTC). Absent keeps the existing window length or sets no window. */
  endAt?: string | null;
  /** The customer gave a time, not a window. */
  noWindow?: boolean;
  /** A zone the person chose by hand; wins over the lookup. */
  timezone?: string | null;
  /** Live or drop (owner, 2026-10-25). Absent keeps what the stop had. */
  handling?: StopHandling | null;
}

export interface StopLoss {
  index: number;
  stopId: string;
  from: string;
  to: string;
  arrivedAt: string | null;
  departedAt: string | null;
}

export interface RoutePlan<S extends StopLike> {
  stops: S[];
  /** Stops whose city changed while they carried an arrival or departure. */
  losses: StopLoss[];
  /** Stops whose zone could not be resolved and are left marked unknown. */
  unresolved: { index: number; city: string; state: string }[];
  changed: boolean;
}

export function placeLabel(stop: { city: string; state: string }): string {
  return `${stop.city}, ${stop.state}`;
}

export function routeLabel(stops: readonly { city: string; state: string }[]): string {
  return stops.map(placeLabel).join(' → ');
}

function sameCity(a: { city: string; state: string }, b: { city: string; state: string }): boolean {
  return (
    a.city.trim().toLowerCase() === b.city.trim().toLowerCase() &&
    a.state.trim().toUpperCase() === b.state.trim().toUpperCase()
  );
}

/**
 * The route a set of edits produces over the existing stops, by position.
 *
 * `confirmClearEvents` is the person's answer to the losses this same function reported a
 * moment ago; without it a stop that would lose its events keeps them and `losses` says which,
 * so the caller can stop and ask rather than write.
 */
export function planRoute<S extends StopLike>(
  existing: readonly S[],
  edits: readonly StopEdit[],
  options: {
    confirmClearEvents?: boolean;
    newId: (index: number) => string;
    make: (base: StopLike, index: number) => S;
  },
): RoutePlan<S> {
  const losses: StopLoss[] = [];
  const unresolved: RoutePlan<S>['unresolved'] = [];
  const stops = edits.map((edit, index) => {
    const prior = existing[index];
    const moved = !prior || !sameCity(prior, edit) || prior.kind !== edit.kind;
    const lossHere = moved && prior !== undefined && (prior.arrivedAt !== null || prior.departedAt !== null);
    if (lossHere) {
      losses.push({
        index,
        stopId: prior.id,
        from: placeLabel(prior),
        to: placeLabel(edit),
        arrivedAt: prior.arrivedAt,
        departedAt: prior.departedAt,
      });
    }
    const keepEvents = !moved || (lossHere && !options.confirmClearEvents);

    let timezone: string;
    if (edit.timezone) {
      timezone = edit.timezone;
    } else if (!moved && prior.timezone) {
      timezone = prior.timezone;
    } else {
      const resolved = resolveStopZone({ zip: edit.zip, city: edit.city, state: edit.state });
      if (resolved.zone) {
        timezone = resolved.zone;
      } else {
        timezone = '';
        unresolved.push({ index, city: edit.city, state: edit.state });
      }
    }

    const startMs = Date.parse(edit.at);
    let appointmentEndAt: string;
    let appointmentNoWindow = false;
    if (edit.noWindow) {
      appointmentEndAt = edit.at;
      appointmentNoWindow = true;
    } else if (edit.endAt) {
      appointmentEndAt = edit.endAt;
    } else if (prior && !Number.isNaN(startMs)) {
      // The window keeps its length when only the start moves.
      const priorLength = Math.max(0, Date.parse(prior.appointmentEndAt) - Date.parse(prior.appointmentStartAt));
      appointmentEndAt = new Date(startMs + priorLength).toISOString();
      appointmentNoWindow = priorLength === 0 || prior.appointmentNoWindow === true;
    } else {
      appointmentEndAt = edit.at;
      appointmentNoWindow = true;
    }

    const base: StopLike = {
      id: prior?.id ?? options.newId(index),
      sequence: index + 1,
      kind: edit.kind,
      facilityId: edit.facilityId ?? (moved ? '' : (prior.facilityId ?? '')),
      facilityName: edit.facilityName ?? (moved ? `${edit.city} ${edit.kind}` : prior.facilityName),
      city: edit.city.trim(),
      state: edit.state.trim().toUpperCase(),
      // A ZIP the person gave wins; otherwise a stop that stayed keeps whatever it had, as it had it.
      zip: edit.zip !== undefined ? edit.zip : moved ? null : prior.zip,
      timezone,
      appointmentStartAt: edit.at,
      appointmentEndAt,
      appointmentNoWindow,
      status: keepEvents && prior ? prior.status : 'pending',
      arrivedAt: keepEvents && prior ? prior.arrivedAt : null,
      departedAt: keepEvents && prior ? prior.departedAt : null,
    };
    const handling = edit.handling !== undefined ? edit.handling : prior?.handling;
    if (handling !== undefined) base.handling = handling;
    return options.make(base, index);
  });

  const changed =
    stops.length !== existing.length ||
    stops.some((stop, index) => {
      const prior = existing[index];
      return (
        !prior ||
        !sameCity(prior, stop) ||
        prior.kind !== stop.kind ||
        prior.appointmentStartAt !== stop.appointmentStartAt ||
        prior.appointmentEndAt !== stop.appointmentEndAt ||
        (prior.appointmentNoWindow ?? false) !== stop.appointmentNoWindow ||
        prior.timezone !== stop.timezone ||
        prior.facilityName !== stop.facilityName ||
        // A stop that never said is live, so saying "live" on it is no change.
        stopHandlingOf(prior) !== stopHandlingOf(stop)
      );
    });

  return { stops, losses, unresolved, changed };
}
