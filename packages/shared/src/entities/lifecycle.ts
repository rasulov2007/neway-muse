import { z } from 'zod';

/**
 * Entity lifecycle.
 *
 * One engine owns, for every managed entity: which statuses exist, which actions each status
 * offers, which dependencies block a change, and what the confirmation must say. Pages read it;
 * they never decide for themselves whether a driver can be deactivated.
 *
 * Two rules shape the design.
 *
 * **Operational records are never destroyed.** Deactivating, archiving and cancelling are the
 * lifecycle; a hard delete is reserved for a draft that has never been operational. History is what
 * a carrier is audited on.
 *
 * **A blocked action explains itself.** Refusing to deactivate a driver is only useful if it also
 * says "one active load, reassign it first". `decideTransition` returns the blockers and what to do
 * about each, so a confirmation dialog is never a bare "are you sure".
 */

export const MANAGED_ENTITIES = [
  'customer',
  'broker',
  'driver',
  'truck',
  'trailer',
  'worker',
  'load',
] as const;
export const ManagedEntitySchema = z.enum(MANAGED_ENTITIES);
export type ManagedEntity = z.infer<typeof ManagedEntitySchema>;

export const ENTITY_LABEL: Record<ManagedEntity, string> = {
  customer: 'Customer',
  broker: 'Broker',
  driver: 'Driver',
  truck: 'Unit',
  trailer: 'Trailer',
  worker: 'Worker',
  load: 'Load',
};

/** What kind of thing an action is, which decides how the UI renders and guards it. */
export const ACTION_KINDS = ['status', 'edit', 'navigate', 'create'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface EntityAction {
  key: string;
  label: string;
  kind: ActionKind;
  /** Target status for a `status` action; null otherwise. */
  to: string | null;
  /** True when the action must be confirmed before it runs. */
  confirm: boolean;
  /** Renders in the destructive style and always confirms. */
  destructive: boolean;
  /** RBAC permission, `module.action`, checked against the principal's set. */
  permission: string;
}

const act = (
  key: string,
  label: string,
  permission: string,
  options: Partial<Omit<EntityAction, 'key' | 'label' | 'permission'>> = {},
): EntityAction => ({
  key,
  label,
  kind: options.kind ?? 'status',
  to: options.to ?? null,
  confirm: options.confirm ?? options.kind === undefined,
  destructive: options.destructive ?? false,
  permission,
});

const edit = (permission: string) =>
  act('edit', 'Edit', permission, { kind: 'edit', confirm: false });

/**
 * Actions available from each status.
 *
 * Statuses a page can display but that offer no transitions (a driver mid-delivery) still appear
 * here with their navigation actions, so the menu is never empty and never guesses.
 */
export const LIFECYCLE: Record<ManagedEntity, Record<string, readonly EntityAction[]>> = {
  customer: {
    active: [
      edit('customers.edit'),
      act('create_load', 'Create load', 'loads.create', { kind: 'create', confirm: false }),
      act('hold', 'Put on hold', 'customers.edit', { to: 'on_hold' }),
      act('deactivate', 'Make inactive', 'customers.edit', { to: 'inactive' }),
      act('archive', 'Archive', 'customers.archive', { to: 'archived', destructive: true }),
    ],
    on_hold: [
      edit('customers.edit'),
      act('activate', 'Make active', 'customers.edit', { to: 'active' }),
      act('deactivate', 'Make inactive', 'customers.edit', { to: 'inactive' }),
      act('archive', 'Archive', 'customers.archive', { to: 'archived', destructive: true }),
    ],
    inactive: [
      edit('customers.edit'),
      act('activate', 'Make active', 'customers.edit', { to: 'active' }),
      act('archive', 'Archive', 'customers.archive', { to: 'archived', destructive: true }),
    ],
    archived: [act('restore', 'Restore', 'customers.archive', { to: 'active' })],
  },
  broker: {
    active: [
      edit('brokers.edit'),
      act('create_load', 'Create load', 'loads.create', { kind: 'create', confirm: false }),
      act('hold', 'Put on hold', 'brokers.edit', { to: 'on_hold' }),
      act('deactivate', 'Make inactive', 'brokers.edit', { to: 'inactive' }),
      act('archive', 'Archive', 'brokers.archive', { to: 'archived', destructive: true }),
    ],
    on_hold: [
      edit('brokers.edit'),
      act('activate', 'Make active', 'brokers.edit', { to: 'active' }),
      act('deactivate', 'Make inactive', 'brokers.edit', { to: 'inactive' }),
      act('archive', 'Archive', 'brokers.archive', { to: 'archived', destructive: true }),
    ],
    inactive: [
      edit('brokers.edit'),
      act('activate', 'Make active', 'brokers.edit', { to: 'active' }),
      act('archive', 'Archive', 'brokers.archive', { to: 'archived', destructive: true }),
    ],
    archived: [act('restore', 'Restore', 'brokers.archive', { to: 'active' })],
  },
  driver: {
    available: [
      edit('drivers.edit'),
      act('vacation', 'Send on vacation', 'drivers.edit', { to: 'vacation' }),
      act('safety_hold', 'Put on safety hold', 'safety.manage', { to: 'suspended' }),
      act('deactivate', 'Make inactive', 'drivers.edit', { to: 'inactive' }),
    ],
    off_duty: [
      edit('drivers.edit'),
      act('vacation', 'Send on vacation', 'drivers.edit', { to: 'vacation' }),
      act('safety_hold', 'Put on safety hold', 'safety.manage', { to: 'suspended' }),
      act('deactivate', 'Make inactive', 'drivers.edit', { to: 'inactive' }),
    ],
    // Back from vacation: the driver page says whether a drug test is due first (owner, 2026-10-16).
    vacation: [
      edit('drivers.edit'),
      act('return_from_vacation', 'Back from vacation', 'drivers.edit', { to: 'available' }),
      act('deactivate', 'Make inactive', 'drivers.edit', { to: 'inactive' }),
    ],
    sleeper: [edit('drivers.edit')],
    dispatched: [edit('drivers.edit')],
    driving: [edit('drivers.edit')],
    suspended: [
      edit('drivers.edit'),
      act('release_hold', 'Release hold', 'safety.manage', { to: 'available' }),
      act('deactivate', 'Make inactive', 'drivers.edit', { to: 'inactive' }),
    ],
    inactive: [
      edit('drivers.edit'),
      act('reactivate', 'Reactivate', 'drivers.edit', { to: 'available' }),
    ],
    terminated: [],
  },
  truck: {
    active: [
      edit('trucks.edit'),
      act('out_of_service', 'Take out of service', 'trucks.edit', { to: 'out_of_service' }),
      act('deactivate', 'Make inactive', 'trucks.edit', { to: 'inactive' }),
    ],
    available: [
      edit('trucks.edit'),
      act('out_of_service', 'Take out of service', 'trucks.edit', { to: 'out_of_service' }),
      act('deactivate', 'Make inactive', 'trucks.edit', { to: 'inactive' }),
    ],
    idle: [
      edit('trucks.edit'),
      act('out_of_service', 'Take out of service', 'trucks.edit', { to: 'out_of_service' }),
      act('deactivate', 'Make inactive', 'trucks.edit', { to: 'inactive' }),
    ],
    driving: [edit('trucks.edit')],
    in_shop: [
      edit('trucks.edit'),
      act('return_to_service', 'Return to service', 'trucks.edit', { to: 'available' }),
    ],
    out_of_service: [
      edit('trucks.edit'),
      act('return_to_service', 'Return to service', 'trucks.edit', { to: 'available' }),
      act('deactivate', 'Make inactive', 'trucks.edit', { to: 'inactive' }),
    ],
    inactive: [
      edit('trucks.edit'),
      act('reactivate', 'Reactivate', 'trucks.edit', { to: 'available' }),
    ],
    sold: [],
    // Archive and restore have their own route, reason and audit (owner, 2026-10-05).
    archived: [],
  },
  trailer: {
    available: [
      edit('trailers.edit'),
      // Off the fleet for good; the dialog asks why - totaled, stolen, returned, sold... (owner,
      // 2026-10-07). Listed before "Take out of service" so a stolen or totaled trailer is not
      // recorded as out of service by mistake (owner, 2026-10-08).
      act('deactivate', 'Make inactive', 'trailers.edit', { to: 'inactive', destructive: true }),
      act('out_of_service', 'Take out of service', 'trailers.edit', { to: 'out_of_service' }),
    ],
    assigned: [edit('trailers.edit')],
    in_shop: [
      edit('trailers.edit'),
      act('return_to_service', 'Return to service', 'trailers.edit', { to: 'available' }),
      act('deactivate', 'Make inactive', 'trailers.edit', { to: 'inactive', destructive: true }),
    ],
    out_of_service: [
      edit('trailers.edit'),
      act('return_to_service', 'Return to service', 'trailers.edit', { to: 'available' }),
      act('deactivate', 'Make inactive', 'trailers.edit', { to: 'inactive', destructive: true }),
    ],
    sold: [],
    inactive: [act('reactivate', 'Reactivate', 'trailers.edit', { to: 'available' })],
  },
  worker: {
    active: [
      edit('employees.edit'),
      act('leave', 'Put on leave', 'employees.edit', { to: 'on_hold' }),
      act('deactivate', 'Make inactive', 'employees.edit', { to: 'inactive' }),
      act('terminate', 'Terminate', 'employees.edit', { to: 'terminated', destructive: true }),
    ],
    on_hold: [
      edit('employees.edit'),
      act('activate', 'Return to active', 'employees.edit', { to: 'active' }),
    ],
    inactive: [
      edit('employees.edit'),
      act('activate', 'Make active', 'employees.edit', { to: 'active' }),
    ],
    terminated: [
      act('archive', 'Archive', 'employees.edit', { to: 'archived', destructive: true }),
    ],
    archived: [],
  },
  load: {
    booked: [
      edit('loads.edit'),
      act('cancel', 'Cancel load', 'loads.edit', { to: 'cancelled', destructive: true }),
    ],
    assigned: [
      edit('loads.edit'),
      act('cancel', 'Cancel load', 'loads.edit', { to: 'cancelled', destructive: true }),
    ],
    dispatched: [edit('loads.edit')],
    in_transit: [edit('loads.edit')],
    delivered: [edit('loads.edit')],
    cancelled: [act('restore', 'Restore to booked', 'loads.edit', { to: 'booked' })],
    closed: [],
  },
};

/** The actions offered from a status. Unknown statuses yield nothing rather than guessing. */
export function actionsFor(entity: ManagedEntity, status: string): readonly EntityAction[] {
  return LIFECYCLE[entity]?.[status] ?? [];
}

// ---------------------------------------------------------------------------------------------
// Dependency rules
// ---------------------------------------------------------------------------------------------

/** Things attached to an entity that a status change has to reckon with. */
export const DEPENDENCY_KEYS = [
  'active_loads',
  'assigned_truck',
  'assigned_driver',
  'open_claims',
  'unpaid_invoices',
  'direct_reports',
] as const;
export type DependencyKey = (typeof DEPENDENCY_KEYS)[number];

export interface DependencyInput {
  key: DependencyKey;
  count: number;
}

export interface EntityDependency extends DependencyInput {
  label: string;
  /** True when the change cannot proceed until this is cleared. */
  blocking: boolean;
  /** What the operator has to do about it. */
  resolution: string;
}

const DEPENDENCY_LABEL: Record<DependencyKey, (n: number) => string> = {
  active_loads: (n) => `${n} active load${n === 1 ? '' : 's'}`,
  assigned_truck: (n) => `${n} assigned unit${n === 1 ? '' : 's'}`,
  assigned_driver: (n) => `${n} assigned driver${n === 1 ? '' : 's'}`,
  open_claims: (n) => `${n} open claim${n === 1 ? '' : 's'}`,
  unpaid_invoices: (n) => `${n} unpaid invoice${n === 1 ? '' : 's'}`,
  direct_reports: (n) => `${n} direct report${n === 1 ? '' : 's'}`,
};

const DEPENDENCY_RESOLUTION: Record<DependencyKey, string> = {
  active_loads: 'Reassign or complete the loads first',
  assigned_truck: 'Release the unit first',
  assigned_driver: 'Release the driver first',
  open_claims: 'Claims stay open and keep referencing this record',
  unpaid_invoices: 'Balances remain collectable after the change',
  direct_reports: 'Reassign the reports to another manager first',
};

/**
 * Which dependencies block which target statuses.
 *
 * Only genuinely inconsistent operational states are blocked. Open claims and unpaid invoices do
 * *not* block deactivating a counterparty — you stop giving them freight while still collecting —
 * so they surface as warnings instead. Blocking on them would push people toward deleting records.
 */
const BLOCKING: Partial<Record<ManagedEntity, Record<string, readonly DependencyKey[]>>> = {
  customer: { archived: ['active_loads'] },
  broker: { archived: ['active_loads'] },
  driver: {
    inactive: ['active_loads', 'assigned_truck'],
    suspended: [],
  },
  truck: {
    inactive: ['active_loads'],
    out_of_service: [],
  },
  worker: { terminated: ['direct_reports'], archived: ['direct_reports'] },
  load: {},
};

export interface TransitionDecision {
  allowed: boolean;
  /** Dependencies that must be cleared first. Empty when allowed. */
  blockers: EntityDependency[];
  /** Dependencies worth stating that do not prevent the change. */
  warnings: EntityDependency[];
  /** Copy for the confirmation dialog. Null when the action needs no confirmation. */
  confirmation: { title: string; body: string; confirmLabel: string } | null;
}

/**
 * Whether an action may run, and what to tell the operator either way.
 *
 * Pure: the caller counts the dependencies from real records and this decides. That keeps the rule
 * ("a driver on an active load cannot be deactivated") in one testable place instead of in a
 * dialog.
 */
export function decideTransition(
  entity: ManagedEntity,
  action: EntityAction,
  dependencies: readonly DependencyInput[],
  context: { name: string } = { name: 'this record' },
): TransitionDecision {
  if (action.kind !== 'status' || !action.to) {
    return { allowed: true, blockers: [], warnings: [], confirmation: null };
  }

  const blockingKeys = BLOCKING[entity]?.[action.to] ?? [];
  const present = dependencies.filter((d) => d.count > 0);

  const describe = (d: DependencyInput, blocking: boolean): EntityDependency => ({
    ...d,
    label: DEPENDENCY_LABEL[d.key](d.count),
    blocking,
    resolution: DEPENDENCY_RESOLUTION[d.key],
  });

  const blockers = present
    .filter((d) => blockingKeys.includes(d.key))
    .map((d) => describe(d, true));
  const warnings = present
    .filter((d) => !blockingKeys.includes(d.key))
    .map((d) => describe(d, false));

  if (blockers.length > 0) {
    return {
      allowed: false,
      blockers,
      warnings,
      confirmation: {
        title: `${action.label} is blocked`,
        body: `${context.name} has ${blockers.map((b) => b.label).join(' and ')}. ${blockers
          .map((b) => b.resolution)
          .join('. ')}.`,
        confirmLabel: 'Close',
      },
    };
  }

  if (!action.confirm) {
    return { allowed: true, blockers: [], warnings, confirmation: null };
  }

  const consequence =
    warnings.length > 0
      ? ` It still has ${warnings.map((w) => w.label).join(' and ')}; those records are kept.`
      : '';

  return {
    allowed: true,
    blockers: [],
    warnings,
    confirmation: {
      title: `${action.label}?`,
      body: `${context.name} moves to ${action.to.replace(/_/g, ' ')}. Nothing is deleted and the change is recorded in the audit trail.${consequence}`,
      confirmLabel: action.label,
    },
  };
}

/** Filters actions to those the principal may perform. */
export function permittedActions(
  actions: readonly EntityAction[],
  permissions: ReadonlySet<string>,
): EntityAction[] {
  return actions.filter((action) => permissions.has(action.permission));
}
