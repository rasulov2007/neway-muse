/**
 * Who may read the roster lists (owner brief, 2026-10-25: deny by default).
 *
 * The driver, truck and trailer lists feed pickers on nearly every page - a dispatcher picking a
 * driver, Accounting opening a statement, a mechanic opening a unit, Driver Relations checking who
 * wrote. So they are open to any role that works with drivers or units, and closed to an account
 * that holds none of these (before this they were open to every signed-in account).
 *
 * What a reader then SEES of a driver is narrowed per field by `driver-pii.ts` (phone, CDL,
 * medical dates, pay), so a wide list here does not mean wide PII.
 */
export const DRIVER_PICKER_PERMISSIONS = [
  'drivers.view',
  'dispatch.view',
  'loads.view',
  'accounting.view',
  'maintenance.view',
  'safety.view',
  'compliance.view',
  'trucks.view',
  'driver_relations.view',
  'recruiting.view',
  'accidents.view',
] as const;

export const UNIT_PICKER_PERMISSIONS = [
  'trucks.view',
  'trailers.view',
  'maintenance.view',
  'dispatch.view',
  'loads.view',
  'accounting.view',
  'safety.view',
  'compliance.view',
  'drivers.view',
  'driver_relations.view',
  'accidents.view',
] as const;
