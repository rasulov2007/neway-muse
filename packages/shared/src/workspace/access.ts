/**
 * Who may read and write each workspace key (owner brief, 2026-10-25, finding 1).
 *
 * `/state` used to be one generic door: `workspace.view` read every collection and
 * `workspace.edit` wrote any key - and neither was even checked, so any signed-in account read and
 * overwrote loads, invoices, settlements and the rest. Now every key the API will serve is listed
 * here with the permission codes that may read it and the codes that may write it, and:
 *
 *   - `GET /state` (the index and `?keys=`) answers only the keys the caller may read;
 *   - `GET /state/:key` and `PUT /state/:key` refuse a key the caller may not read / write;
 *   - a key that is not listed here is refused outright, for reading and for writing;
 *   - writing also needs read access, so nobody saves over a collection they could not load.
 *
 * Each list is "any of": the codes of every page that reads (or writes) the collection, taken
 * from the browser modules that use it. Shared with the web so the browser does not try to save
 * a collection it may not write (that save would be refused every twenty seconds).
 */
import { WORKSPACE_COLLECTIONS, workspaceKey, LEGACY_WORKSPACE_FILES_KEY, LEGACY_WORKSPACE_KEY, type WorkspaceCollection } from './keys.js';

export interface WorkspaceKeyPolicy {
  /** Any one of these reads the key. */
  read: readonly string[];
  /** Any one of these writes it (on top of read). Empty = nobody writes it through /state. */
  write: readonly string[];
  /**
   * Maintenance money (invoice totals, part and labour prices, fuel cost) is removed from the copy
   * served to a reader without COST_PERMISSIONS, and such a reader may not write the key: saving a
   * stripped copy back would erase the figures (the Maintenance role never sees money).
   */
  stripsCosts?: boolean;
  /** Listed in the permission matrix as a mapping to confirm with the owner. */
  unsure?: boolean;
}

/** Who sees what maintenance cost (the same codes the Fleet cost screens use). */
export const COST_PERMISSIONS = ['maintenance_costs.view', 'accounting.view'] as const;

const FLEET_READ = ['maintenance.view', 'trucks.view', 'trailers.view', 'maintenance_costs.view'] as const;
const FLEET_WRITE = ['maintenance.edit', 'trucks.edit', 'trucks.create', 'trailers.edit', 'truck_assignment.edit'] as const;
const SAFETY_READ = ['safety.view', 'compliance.view', 'accidents.view'] as const;
const SAFETY_WRITE = ['safety.manage', 'compliance.manage', 'accidents.edit'] as const;
const OPS_READ = ['loads.view', 'dispatch.view'] as const;
const OPS_WRITE = ['loads.create', 'loads.edit', 'dispatch.edit'] as const;

/**
 * Collections every working page touches - the notification bell, tasks, the activity feed. Open to
 * any role that works in the product (one code of any module), closed to an account with none.
 */
const SHARED_READ = [
  'workspace.view', ...OPS_READ, ...FLEET_READ, 'drivers.view', ...SAFETY_READ, 'accounting.view',
  'employees.view', 'driver_relations.view', 'recruiting.view',
] as const;
const SHARED_WRITE = [
  'workspace.edit', ...OPS_WRITE, ...FLEET_WRITE, 'drivers.edit', ...SAFETY_WRITE, 'accounting.edit',
  'employees.edit', 'driver_relations.contact', 'recruiting.manage', 'documents.create',
] as const;

const p = (read: readonly string[], write: readonly string[], extra: Partial<WorkspaceKeyPolicy> = {}): WorkspaceKeyPolicy => ({ read, write, ...extra });

/** Per collection. Typed over the collection list, so a new collection fails to compile until it has a policy. */
export const WORKSPACE_COLLECTION_POLICIES: Record<WorkspaceCollection, WorkspaceKeyPolicy> = {
  customers: p(['customers.view', ...OPS_READ, 'accounting.view'], ['customers.edit', ...OPS_WRITE, 'accounting.edit']),
  brokers: p(['brokers.view', ...OPS_READ, 'accounting.view'], ['brokers.edit', ...OPS_WRITE, 'accounting.edit']),
  facilities: p([...OPS_READ], [...OPS_WRITE]),

  maintenance: p([...FLEET_READ, 'dispatch.view', 'accounting.view'], [...FLEET_WRITE, 'accounting.edit']),
  repairOrders: p([...FLEET_READ, 'dispatch.view', 'accounting.view', 'safety.view'], [...FLEET_WRITE, 'accounting.edit'], { stripsCosts: true, unsure: true }),
  serviceRecords: p([...FLEET_READ, 'accounting.view'], [...FLEET_WRITE, 'accounting.edit'], { stripsCosts: true }),
  fuelTransactions: p([...FLEET_READ, 'accounting.view'], [...FLEET_WRITE, 'accounting.edit'], { stripsCosts: true }),
  downPeriods: p([...FLEET_READ, ...OPS_READ, 'safety.view', 'drivers.view'], [...FLEET_WRITE, 'safety.manage']),
  workOrderTypes: p([...FLEET_READ, 'accounting.view'], [...FLEET_WRITE]),
  unitDocumentRules: p([...FLEET_READ, 'compliance.view'], [...FLEET_WRITE, 'compliance.manage']),
  truckNotes: p([...FLEET_READ, ...OPS_READ, 'safety.view', 'driver_relations.view'], [...FLEET_WRITE, 'dispatch.edit', 'safety.manage']),
  unitExits: p([...FLEET_READ, ...OPS_READ, 'safety.view', 'accounting.view'], [...FLEET_WRITE, 'safety.manage']),

  ptiRecords: p([...FLEET_READ, ...SAFETY_READ], [...FLEET_WRITE, 'safety.manage']),
  ptiComponents: p([...FLEET_READ, ...SAFETY_READ], [...FLEET_WRITE, 'safety.manage']),
  ptiRatings: p([...FLEET_READ, ...SAFETY_READ], [...FLEET_WRITE, 'safety.manage']),
  ptiConditionConfig: p([...FLEET_READ, ...SAFETY_READ], [...FLEET_WRITE, 'safety.manage']),
  inspections: p([...FLEET_READ, ...SAFETY_READ], [...FLEET_WRITE, ...SAFETY_WRITE]),
  defects: p([...FLEET_READ, ...SAFETY_READ], [...FLEET_WRITE, ...SAFETY_WRITE]),

  safetyEvents: p([...SAFETY_READ, ...FLEET_READ, 'drivers.view'], [...SAFETY_WRITE]),
  violations: p([...SAFETY_READ, 'drivers.view'], [...SAFETY_WRITE]),
  accidents: p([...SAFETY_READ], [...SAFETY_WRITE]),
  claims: p([...SAFETY_READ, 'accounting.view'], [...SAFETY_WRITE, 'accounting.edit']),
  correctiveActions: p([...SAFETY_READ], [...SAFETY_WRITE]),
  complianceAudit: p([...SAFETY_READ, ...FLEET_READ], [...SAFETY_WRITE, ...FLEET_WRITE], { unsure: true }),

  invoices: p(['accounting.view'], ['accounting.edit']),
  invoiceLines: p(['accounting.view'], ['accounting.edit']),
  payments: p(['accounting.view'], ['accounting.edit']),
  bills: p(['accounting.view'], ['accounting.edit']),
  expenses: p(['accounting.view'], ['accounting.edit']),
  journal: p(['accounting.view'], ['accounting.edit']),
  ledgerPeriods: p(['accounting.view'], ['accounting.edit']),
  settlements: p(['accounting.view', 'payroll.view'], ['accounting.edit'], { unsure: true }),
  payrollPeriods: p(['accounting.view', 'payroll.view'], ['accounting.edit']),
  payslips: p(['accounting.view', 'payroll.view'], ['accounting.edit']),
  vendors: p(['accounting.view', ...FLEET_READ], ['accounting.edit', ...FLEET_WRITE]),
  deductionPlans: p(['accounting.view', 'maintenance.view', 'drivers.view', 'safety.view'], ['accounting.edit', 'maintenance.edit', 'drivers.edit', 'safety.manage'], { unsure: true }),
  escrowEntries: p(['accounting.view', 'drivers.view'], ['accounting.edit', 'drivers.edit'], { unsure: true }),
  terminations: p(['accounting.view', 'drivers.view', 'safety.view'], ['accounting.edit', 'drivers.edit'], { unsure: true }),

  notifications: p(SHARED_READ, SHARED_WRITE, { unsure: true }),
  tasks: p(SHARED_READ, SHARED_WRITE, { unsure: true }),
  activity: p(SHARED_READ, SHARED_WRITE, { unsure: true }),
  aiInsights: p(SHARED_READ, SHARED_WRITE, { unsure: true }),
};

/**
 * Keys outside the collection list that the API still serves.
 *
 *   - `ws2-loads`: the loads collection before loads moved to their own table (2026-09-25). No
 *     browser writes it any more; it is read-only, for the same readers as the loads themselves.
 *     Load prices are served exactly as before (owner, 2026-10-25: nothing is stripped).
 *   - the single-blob workspace and its file index (pre-split). They hold every collection at
 *     once - invoices and settlements included - so only the administrator reads them; no
 *     browser needs them once the split rows exist. Never written through /state again.
 */
export const WORKSPACE_EXTRA_KEY_POLICIES: Record<string, WorkspaceKeyPolicy> = {
  [workspaceKey('loads')]: p(['loads.view'], []),
  [LEGACY_WORKSPACE_KEY]: p(['settings.edit'], [], { unsure: true }),
  [LEGACY_WORKSPACE_FILES_KEY]: p(['settings.edit'], [], { unsure: true }),
};

/** The policy for a client key, or null when the key is not served at all. */
export function workspaceKeyPolicy(key: string): WorkspaceKeyPolicy | null {
  const collection = WORKSPACE_COLLECTIONS.find((name) => workspaceKey(name) === key);
  if (collection) return WORKSPACE_COLLECTION_POLICIES[collection];
  return WORKSPACE_EXTRA_KEY_POLICIES[key] ?? null;
}

function holdsAny(permissions: ReadonlySet<string> | readonly string[], codes: readonly string[]): boolean {
  const has = (code: string) => (Array.isArray(permissions) ? (permissions as readonly string[]).includes(code) : (permissions as ReadonlySet<string>).has(code));
  return codes.some(has);
}

export function canReadWorkspaceKey(permissions: ReadonlySet<string> | readonly string[], key: string): boolean {
  const policy = workspaceKeyPolicy(key);
  return policy !== null && holdsAny(permissions, policy.read);
}

export function canWriteWorkspaceKey(permissions: ReadonlySet<string> | readonly string[], key: string): boolean {
  const policy = workspaceKeyPolicy(key);
  return (
    policy !== null &&
    policy.write.length > 0 &&
    holdsAny(permissions, policy.read) &&
    holdsAny(permissions, policy.write) &&
    (!policy.stripsCosts || seesCosts(permissions))
  );
}

export function seesCosts(permissions: ReadonlySet<string> | readonly string[]): boolean {
  return holdsAny(permissions, COST_PERMISSIONS);
}

const COST_FIELD = /(total|amount|cost|price|tax|fee|rate)$/i;

/** A value with every money-looking field nulled, at any depth (rows, their lines, their invoices). */
function stripMoneyDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMoneyDeep);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = COST_FIELD.test(k) && (typeof v === 'number' || typeof v === 'string') ? null : stripMoneyDeep(v);
  }
  return out;
}

/** A stored maintenance collection without its money, for a reader without COST_PERMISSIONS. */
export function stripCostsFromValue(value: string): string {
  try {
    return JSON.stringify(stripMoneyDeep(JSON.parse(value)));
  } catch {
    return 'null';
  }
}

