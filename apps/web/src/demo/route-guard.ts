import type { StopLoss } from '@neway/shared';

/**
 * A route edit that would erase what happened at a stop (dispatch P0.2).
 *
 * Changing a stop's city while the stop carries an arrival or a departure is thrown back to the
 * caller as this error rather than written: the events are things that happened, and the person
 * has to say they meant to lose them. The form catches it, shows the stops and their times, and
 * re-runs the same edit with `confirmClearEvents` once they have.
 */
export class StopEventsLossError extends Error {
  readonly losses: StopLoss[];

  constructor(losses: StopLoss[]) {
    super(
      `${losses.length === 1 ? 'A stop' : `${losses.length} stops`} with recorded arrival or departure would change city. Confirm to clear those times.`,
    );
    this.name = 'StopEventsLossError';
    this.losses = losses;
  }
}

export function isStopEventsLoss(error: unknown): error is StopEventsLossError {
  return error instanceof StopEventsLossError;
}
