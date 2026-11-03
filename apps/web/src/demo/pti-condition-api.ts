import { componentKeyFromName } from '@neway/shared';
import { demoData } from './data';
import { createRepairOrder } from './fleet-writes';
import {
  DEFAULT_PTI_COMPONENTS,
  DEFAULT_PTI_CONDITION_CONFIG,
  currentConditions,
  isDueSoon,
  windowClosed,
  windowLabel,
  worstCondition,
  type ComponentCondition,
  type PtiComponentDef,
  type PtiComponentRating,
  type PtiConditionConfig,
  type PtiRating,
  type PtiWindowUnit,
  withKey,
} from './pti-condition';
import { saveSoon } from './state-persist';
import type { IsoDate, MaintenanceType } from './types';

/**
 * The condition store: the walk-around catalog, the ratings, and the loop back to Maintenance.
 *
 * Everything here reads and writes real rows in the workspace. The only thing ever seeded is the
 * catalog's default components, and only into an empty catalog.
 */

const stamp = () => new Date().toISOString();
const today = (): IsoDate => new Date().toISOString().slice(0, 10);
/** Monday of the current cycle, from the clock — the board's pinned demo week is not the calendar. */
function thisWeek(): IsoDate {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The catalog, seeded with the walk-around defaults the first time it is asked for. */
export function ensurePtiCatalog(): PtiComponentDef[] {
  if (demoData.ptiComponents.length === 0) {
    demoData.ptiComponents.push(
      ...DEFAULT_PTI_COMPONENTS.map((c, index) => ({ ...c, id: `ptc_${index + 1}` })),
    );
    saveSoon();
  }
  return demoData.ptiComponents;
}

export function listPtiComponents(includeInactive = false): PtiComponentDef[] {
  return [...ensurePtiCatalog()]
    .filter((c) => includeInactive || c.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(withKey);
}

/** The catalog entry behind a defect's component key, when the catalog still has it. */
export function ptiComponentByKey(key: string): PtiComponentDef | undefined {
  return ensurePtiCatalog().map(withKey).find((c) => c.key === key);
}

export interface SavePtiComponentInput {
  id?: string;
  name: string;
  defaultLifeHint: string | null;
  active: boolean;
  trailerOnly: boolean;
  /** Left out: the existing chips stay. */
  quickPicks?: string[];
}

/** Chips, trimmed, deduplicated and without blanks. */
function cleanQuickPicks(picks: string[]): string[] {
  return [...new Set(picks.map((p) => p.trim()).filter(Boolean))];
}

/** Adds or edits a catalog entry. Ratings keep pointing at the id, so a rename keeps history. */
export async function savePtiComponent(input: SavePtiComponentInput): Promise<PtiComponentDef> {
  const catalog = ensurePtiCatalog();
  const name = input.name.trim();
  if (!name) throw new Error('A component needs a name');
  const existing = input.id ? catalog.find((c) => c.id === input.id) : undefined;
  if (existing) {
    // The key was set from the first name and stays; defects point at it.
    existing.key = existing.key ?? componentKeyFromName(existing.name);
    existing.name = name;
    existing.defaultLifeHint = input.defaultLifeHint?.trim() || null;
    existing.active = input.active;
    existing.trailerOnly = input.trailerOnly;
    if (input.quickPicks) existing.quickPicks = cleanQuickPicks(input.quickPicks);
    saveSoon();
    return withKey(existing);
  }
  const next: PtiComponentDef = {
    id: `ptc_${Date.now().toString(36)}`,
    // Fixed at creation; a later rename changes the name and not the key.
    key: componentKeyFromName(name),
    name,
    defaultLifeHint: input.defaultLifeHint?.trim() || null,
    active: input.active,
    trailerOnly: input.trailerOnly,
    quickPicks: cleanQuickPicks(input.quickPicks ?? []),
    sortOrder: catalog.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1,
  };
  catalog.push(next);
  saveSoon();
  return withKey(next);
}

export function ptiConditionConfig(): PtiConditionConfig {
  return demoData.ptiConditionConfig ?? DEFAULT_PTI_CONDITION_CONFIG;
}

export async function setPtiConditionConfig(
  patch: Partial<PtiConditionConfig>,
): Promise<PtiConditionConfig> {
  const current = ptiConditionConfig();
  const next = { ...current, ...patch };
  if (!Number.isInteger(next.staleAfterWeeks) || next.staleAfterWeeks < 1) {
    throw new Error('Stale after must be a whole number of weeks, at least 1');
  }
  demoData.ptiConditionConfig = next;
  saveSoon();
  return next;
}

/** The current condition of every component on a unit, as of a week. */
export function conditionsFor(
  truckId: string,
  weekStart: IsoDate = thisWeek(),
): ComponentCondition[] {
  const truck = demoData.trucks.find((t) => t.id === truckId);
  return currentConditions(demoData.ptiRatings, ensurePtiCatalog(), {
    truckId,
    weekStart,
    today: today(),
    odometer: truck?.odometer ?? null,
    trailerAttached: Boolean(truck?.currentTrailerId),
    config: ptiConditionConfig(),
  });
}

export interface RatingEntry {
  componentId: string;
  rating: PtiRating;
  windowValue: number | null;
  windowUnit: PtiWindowUnit | null;
}

/**
 * Records this week's observations on a PTI row. Append-only: each call adds rows, one per
 * component rated; components left unrated are simply not written and carry forward.
 */
export async function rateComponents(
  recordId: string,
  entries: RatingEntry[],
  by: { id: string; name: string },
): Promise<PtiComponentRating[]> {
  const record = demoData.ptiRecords.find((r) => r.id === recordId);
  if (!record) throw new Error('That inspection row no longer exists');
  return rateComponentsForUnit({ truckId: record.truckId, weekStart: record.weekStart, recordId }, entries, by);
}

/**
 * The same observations, keyed on the unit and the week rather than a legacy board row: what the
 * review drawer writes, whose inspection lives on the server and not in this store. A rating is
 * never written twice for one component in one call.
 */
export async function rateComponentsForUnit(
  target: { truckId: string; weekStart: IsoDate; recordId?: string | null },
  entries: RatingEntry[],
  by: { id: string; name: string },
): Promise<PtiComponentRating[]> {
  const truck = demoData.trucks.find((t) => t.id === target.truckId);
  if (!truck) throw new Error('That unit is not in the fleet');
  const catalog = new Map(ensurePtiCatalog().map((c) => [c.id, c]));
  const at = stamp();
  const written: PtiComponentRating[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!catalog.has(entry.componentId)) throw new Error('That component is not on the catalog');
    if (seen.has(entry.componentId)) continue;
    seen.add(entry.componentId);
    const soon = entry.rating === 'replace_soon';
    if (
      soon &&
      (entry.windowValue === null || entry.windowUnit === null || entry.windowValue <= 0)
    ) {
      throw new Error(
        `${catalog.get(entry.componentId)?.name}: a Replace soon rating needs its expected window`,
      );
    }
    const row: PtiComponentRating = {
      id: `ptr_${at.replace(/\D/g, '')}_${entry.componentId}_${target.truckId}`,
      recordId: target.recordId ?? null,
      weekStart: target.weekStart,
      truckId: target.truckId,
      componentId: entry.componentId,
      rating: entry.rating,
      windowValue: soon ? entry.windowValue : null,
      windowUnit: soon ? entry.windowUnit : null,
      odometerAtRating: truck.odometer ?? null,
      ratedAt: at,
      ratedById: by.id,
      ratedByName: by.name,
      note: null,
      workOrderId: null,
      workOrderNumber: null,
    };
    demoData.ptiRatings.push(row);
    written.push(row);
  }
  if (written.length > 0) saveSoon();
  return written;
}

/** The catalog item in the maintenance module's own vocabulary. */
export function maintenanceTypeFor(component: PtiComponentDef): MaintenanceType {
  const name = component.name.toLowerCase();
  if (name.includes('tyre') || name.includes('tire')) return 'tire_replacement';
  if (name.includes('brake')) return 'brake_repair';
  if (name.includes('light') || name.includes('electrical') || name.includes('battery'))
    return 'electrical';
  if (name.includes('leak') || name.includes('belt') || name.includes('hose')) return 'engine';
  return 'other';
}

/**
 * Opens a work order for a component from its current rating, carrying the component, the rating,
 * the window and where the observation came from, so the shop reads the video's verdict without
 * anybody retyping it. The rating remembers the order; when the order is completed the component
 * is reset to Good (see `closeConditionLoop` in fleet-writes).
 */
export async function raiseComponentWorkOrder(
  truckId: string,
  componentId: string,
  by: { id: string; name: string },
): Promise<{ order: Awaited<ReturnType<typeof createRepairOrder>>; rating: PtiComponentRating }> {
  const conditions = conditionsFor(truckId);
  const condition = conditions.find((c) => c.component.id === componentId);
  if (!condition?.source || !condition.rating)
    throw new Error('That component has no rating to act on');
  if (condition.rating === 'good' || condition.rating === 'monitor') {
    throw new Error('Only a component rated Replace soon or Replace now opens a work order');
  }
  const rating = condition.source;
  if (rating.workOrderId) {
    const open = demoData.repairOrders.find((o) => o.id === rating.workOrderId);
    if (open && open.status !== 'completed' && open.status !== 'cancelled') {
      throw new Error(`Already on work order ${rating.workOrderNumber}`);
    }
  }
  const truck = demoData.trucks.find((t) => t.id === truckId);
  const window = windowLabel(rating);
  const order = await createRepairOrder({
    truckId,
    status: 'open',
    priority: condition.rating === 'replace_now' ? 'high' : 'normal',
    type: maintenanceTypeFor(condition.component),
    summary: `${condition.component.name}: rated ${condition.rating === 'replace_now' ? 'Replace now' : 'Replace soon'} on the PTI video of ${rating.weekStart}`,
    vendorName: 'In-house shop',
    technician: by.name,
    promisedAt: null,
    warranty: false,
    notes: [
      `Raised from the walk-around condition rating on unit ${truck?.unitNumber ?? truckId}.`,
      `Component: ${condition.component.name}. Rating: ${condition.rating === 'replace_now' ? 'Replace now' : 'Replace soon'}${window ? ` (expected window ${window})` : ''}.`,
      `Source: PTI video, week of ${rating.weekStart}, rated by ${rating.ratedByName ?? 'unknown'}.`,
    ].join(' '),
  });
  rating.workOrderId = order.id;
  rating.workOrderNumber = order.roNumber;
  saveSoon();
  return { order, rating };
}

/** One unit's worst condition, for the board and the truck page. */
export function unitCondition(truckId: string, weekStart: IsoDate = thisWeek()) {
  const conditions = conditionsFor(truckId, weekStart);
  return { conditions, worst: worstCondition(conditions) };
}

/** Units with any component due soon (Replace now, or Replace soon closing within 14 days). */
export function isUnitDueSoon(truckId: string, weekStart: IsoDate = thisWeek()): boolean {
  return conditionsFor(truckId, weekStart).some((c) => isDueSoon(c, today()));
}

export interface ConditionQueueItem {
  truckId: string;
  unitNumber: string;
  condition: ComponentCondition;
  /** Why it is in the queue. */
  reason: 'replace_now' | 'window_closed';
}

/**
 * What Maintenance should plan for: every component rated Replace now, or Replace soon whose
 * window has closed, that is not already on an open work order.
 */
export function conditionQueue(): ConditionQueueItem[] {
  const items: ConditionQueueItem[] = [];
  const openOrders = new Set(
    demoData.repairOrders
      .filter((o) => o.status !== 'completed' && o.status !== 'cancelled')
      .map((o) => o.id),
  );
  for (const truck of demoData.trucks) {
    if (truck.status === 'sold' || truck.status === 'inactive' || truck.status === 'archived')
      continue;
    for (const condition of conditionsFor(truck.id)) {
      if (!condition.source) continue;
      if (condition.source.workOrderId && openOrders.has(condition.source.workOrderId)) continue;
      if (condition.rating === 'replace_now') {
        items.push({
          truckId: truck.id,
          unitNumber: truck.unitNumber,
          condition,
          reason: 'replace_now',
        });
      } else if (windowClosed(condition, today())) {
        items.push({
          truckId: truck.id,
          unitNumber: truck.unitNumber,
          condition,
          reason: 'window_closed',
        });
      }
    }
  }
  return items.sort((a, b) =>
    a.reason === b.reason
      ? a.unitNumber.localeCompare(b.unitNumber)
      : a.reason === 'replace_now'
        ? -1
        : 1,
  );
}

/** Units with a component in Replace soon or Replace now — upcoming spend, before it lands. */
export function conditionCandidates(): { units: number; replaceNow: number; replaceSoon: number } {
  let units = 0;
  let replaceNow = 0;
  let replaceSoon = 0;
  for (const truck of demoData.trucks) {
    if (truck.status === 'sold' || truck.status === 'archived') continue;
    const conditions = conditionsFor(truck.id);
    const now = conditions.filter((c) => c.rating === 'replace_now').length;
    const soon = conditions.filter((c) => c.rating === 'replace_soon').length;
    if (now + soon > 0) units += 1;
    replaceNow += now;
    replaceSoon += soon;
  }
  return { units, replaceNow, replaceSoon };
}
