/**
 * "No dispatcher" (owner, 2026-10-26). An empty dispatcher on a board row means "read the driver
 * file", so a driver taken off his dispatcher is stored under this id instead - on the board row
 * and on the dated assignment that moved him - and every read turns it back into the empty team
 * the boards show as Unassigned drivers. Never shown to anyone.
 */
export const NO_DISPATCHER_ID = 'none:unassigned';
export const NO_DISPATCHER_NAME = 'Unassigned';

export function isNoDispatcher(id: string | null | undefined): boolean {
  return id === NO_DISPATCHER_ID;
}
