/**
 * Dispatcher rotation (owner, 2026-10-16): which drivers joined and left each dispatcher, why, and
 * the share of the team that turned over. Read from the board's own assignment history and the
 * unassign records; nothing is stored for it.
 */

/** The reasons offered when a driver leaves a dispatcher; "Other" asks for the words. */
export const DISPATCH_CHANGE_REASONS = [
  'Driver asked for a dispatcher change',
  'Driver went on vacation',
  'Driver left the company',
  'Company moved the driver',
] as const;

export interface RotationEvent {
  at: string;
  rosterId: string;
  /** The driver file behind the board row, for the profile link; null for a row without one. */
  driverId: string | null;
  driverName: string;
  kind: 'joined' | 'left';
  /** The other side of a move: where the driver came from or went to; null for a new or unassigned driver. */
  otherDispatcher: string | null;
  reason: string | null;
  by: string | null;
}

export interface DispatcherRotationRow {
  dispatcherId: string;
  dispatcherName: string;
  /** Nickname(s) when the team is linked to employees (2026-10-26); null = show dispatcherName. */
  dispatcherNickname?: string | null;
  /** TEAM n on the boards; null for a solo dispatcher (owner, 2026-10-26). */
  teamNumber?: number | null;
  dispatcherFullName?: string | null;
  /** Drivers on the team the day before the period. */
  atStart: number;
  joined: number;
  left: number;
  /** Drivers on the team at the end of the period. */
  atEnd: number;
  /** Left ÷ drivers at the start, in percent; null when the team started empty. */
  rotationPct: number | null;
  events: RotationEvent[];
}

export interface DispatcherRotationReport {
  from: string;
  to: string;
  rows: DispatcherRotationRow[];
}
