/**
 * Where the client's operational workspace is kept, and under what keys.
 *
 * The workspace is a set of JSON rows in `app_state`, one per collection. Both sides need the
 * same names: the browser writes them, and the API's expense summary and reporting read them
 * back. They used to be one blob under `demo-data-v1`; splitting it is what made a create fast
 * (see the round-3 P0 work). The legacy key is still read when no split rows exist.
 */
export const WORKSPACE_PREFIX = 'ws2-';
export const LEGACY_WORKSPACE_KEY = 'demo-data-v1';
export const LEGACY_WORKSPACE_FILES_KEY = 'demo-documents-v1';

/**
 * Every collection the workspace owns, in the client's own spelling. The roster (trucks,
 * drivers, trailers) is NOT here: it lives in its own tables.
 *
 * Loads left this list on 2026-09-25 too: one row per load in the `loads` table, every write
 * through the server with a version check, and the browser never saving the collection again.
 *
 * Trailers left this list on 2026-09-25. They were being generated per session and saved here,
 * which is how 160 real trailers imported from Ditat could sit in the `trailers` table while the
 * page showed nothing — the page was reading a different, empty, copy.
 */
export const WORKSPACE_COLLECTIONS = [
  'customers',
  'brokers',
  'facilities',
  'maintenance',
  'repairOrders',
  'serviceRecords',
  'fuelTransactions',
  'safetyEvents',
  'invoices',
  'notifications',
  'tasks',
  'activity',
  'aiInsights',
  'complianceAudit',
  'inspections',
  'defects',
  'violations',
  'accidents',
  'claims',
  'correctiveActions',
  'vendors',
  'invoiceLines',
  'payments',
  'bills',
  'expenses',
  'journal',
  'settlements',
  'payrollPeriods',
  'payslips',
  'deductionPlans',
  'ledgerPeriods',
  'truckNotes',
  'escrowEntries',
  'terminations',
  'unitExits',
  'ptiRecords',
  'ptiComponents',
  'ptiRatings',
  'downPeriods',
  'ptiConditionConfig',
  'workOrderTypes',
  'unitDocumentRules',
] as const;

export type WorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number];

/** The `app_state` key a collection is stored under. Keys are lower-case; names are not. */
export function workspaceKey(collection: string): string {
  return `${WORKSPACE_PREFIX}${collection.toLowerCase()}`;
}

/** The collection a key belongs to, in its own spelling; null for a key we do not own. */
export function workspaceCollectionOf(key: string): WorkspaceCollection | null {
  return WORKSPACE_COLLECTIONS.find((name) => workspaceKey(name) === key) ?? null;
}
