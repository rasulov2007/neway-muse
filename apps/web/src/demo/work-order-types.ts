import { demoData } from './data';
import { saveSoon } from './state-persist';
import type { MaintenanceType } from './types';

/**
 * The kinds of work a work order can be about, and which units each applies to.
 *
 * Trailers break differently from trucks — doors, floors, landing gear, the reefer unit — and a
 * dropdown of engine and DPF jobs on a trailer order is how "other" becomes the most common type.
 * The list is a catalog in the workspace rather than a constant: an admin can retire a type,
 * rename it, or point it at the other kind of unit without a release.
 */

export type WorkOrderUnitKind = 'truck' | 'trailer';

export interface WorkOrderTypeDef {
  code: MaintenanceType;
  label: string;
  appliesTo: WorkOrderUnitKind | 'both';
  active: boolean;
  sortOrder: number;
}

export const DEFAULT_WORK_ORDER_TYPES: Omit<WorkOrderTypeDef, 'sortOrder'>[] = [
  { code: 'pm_service', label: 'PM service', appliesTo: 'truck', active: true },
  { code: 'oil_change', label: 'Oil change', appliesTo: 'truck', active: true },
  { code: 'brake_inspection', label: 'Brake inspection', appliesTo: 'both', active: true },
  { code: 'brake_repair', label: 'Brake repair', appliesTo: 'both', active: true },
  { code: 'tire_rotation', label: 'Tire rotation', appliesTo: 'truck', active: true },
  { code: 'tire_replacement', label: 'Tire replacement', appliesTo: 'both', active: true },
  { code: 'dot_inspection', label: 'Annual DOT inspection', appliesTo: 'both', active: true },
  { code: 'coolant', label: 'Coolant service', appliesTo: 'truck', active: true },
  { code: 'transmission', label: 'Transmission service', appliesTo: 'truck', active: true },
  { code: 'engine', label: 'Engine service', appliesTo: 'truck', active: true },
  { code: 'dpf', label: 'DPF cleaning', appliesTo: 'truck', active: true },
  { code: 'battery', label: 'Battery replacement', appliesTo: 'truck', active: true },
  { code: 'electrical', label: 'Electrical repair', appliesTo: 'truck', active: true },
  { code: 'lights', label: 'Lights & electrical', appliesTo: 'trailer', active: true },
  { code: 'doors_seals', label: 'Doors & seals', appliesTo: 'trailer', active: true },
  { code: 'floor_walls', label: 'Floor & walls', appliesTo: 'trailer', active: true },
  { code: 'landing_gear', label: 'Landing gear', appliesTo: 'trailer', active: true },
  { code: 'suspension', label: 'Suspension / airbags', appliesTo: 'both', active: true },
  { code: 'reefer_unit', label: 'Reefer unit', appliesTo: 'trailer', active: true },
  { code: 'other', label: 'Other', appliesTo: 'both', active: true },
];

/** The catalog, seeded with the defaults the first time it is asked for. */
export function ensureWorkOrderTypes(): WorkOrderTypeDef[] {
  if (demoData.workOrderTypes.length === 0) {
    demoData.workOrderTypes.push(
      ...DEFAULT_WORK_ORDER_TYPES.map((t, index) => ({ ...t, sortOrder: index })),
    );
    saveSoon();
  }
  return demoData.workOrderTypes;
}

/** The active types that apply to a kind of unit, in catalog order. */
export function listWorkOrderTypes(kind: WorkOrderUnitKind): WorkOrderTypeDef[] {
  return [...ensureWorkOrderTypes()]
    .filter((t) => t.active && (t.appliesTo === 'both' || t.appliesTo === kind))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** The label for a code as the catalog currently reads, falling back to the code itself. */
export function workOrderTypeLabel(code: string): string {
  return ensureWorkOrderTypes().find((t) => t.code === code)?.label ?? code.replace(/_/g, ' ');
}

export async function saveWorkOrderType(
  input: Pick<WorkOrderTypeDef, 'code'> &
    Partial<Pick<WorkOrderTypeDef, 'label' | 'appliesTo' | 'active'>>,
): Promise<WorkOrderTypeDef> {
  const row = ensureWorkOrderTypes().find((t) => t.code === input.code);
  if (!row) throw new Error('That work order type is not on the catalog');
  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label) throw new Error('A work order type needs a name');
    row.label = label;
  }
  if (input.appliesTo !== undefined) row.appliesTo = input.appliesTo;
  if (input.active !== undefined) row.active = input.active;
  saveSoon();
  return row;
}
