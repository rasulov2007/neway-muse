import type {
  ComplianceAction,
  ComplianceRole,
  ComplianceScope,
  EntityCompliance,
  QualificationRequirement,
} from '@neway/shared';
import { daysBetween } from '@neway/shared';
import { entityKey } from './compliance-ui';
import type { WorkbenchFocus, WorkbenchScope } from './safety-search';

/**
 * The command centre's workbench, as arithmetic: which of the engine's actions a focus shows,
 * how they fold into one row per requirement, what a requirement's catalog compliance is, and
 * the words under each tile. Pure, so the tests run it, and so a tile's count and the rows it
 * opens are the same filter and cannot disagree.
 *
 * Nothing here decides a status. Every input is a `ComplianceAction` or `EntityCompliance` the
 * shared engine already produced; this only counts, groups and sorts them.
 */

export const EXPIRING_WITHIN_DAYS = 30;

export const FOCUS_SEGMENTS: ReadonlyArray<{ focus: WorkbenchFocus; label: string }> = [
  { focus: 'held', label: 'Dispatch holds' },
  { focus: 'expiring', label: 'Expiring ≤ 30d' },
  { focus: 'pending', label: 'Review & rejected' },
  { focus: 'all', label: 'All open' },
];

/** The other focuses a tile can open; they show as a fifth segment while active. */
export const EXTRA_FOCUS_LABEL: Partial<Record<WorkbenchFocus, string>> = {
  expired: 'Expired',
  missing: 'Missing',
  failed: 'Rejected',
  critical: 'Critical',
};

export function matchesFocus(action: ComplianceAction, focus: WorkbenchFocus): boolean {
  switch (focus) {
    case 'held':
      return action.blocksDispatch;
    case 'expiring':
      // The tile's rule (summarizeCompliance): inside the 30-day window, not merely in a warning stage.
      return (
        action.item.status === 'expiring' &&
        action.item.daysRemaining !== null &&
        action.item.daysRemaining <= EXPIRING_WITHIN_DAYS
      );
    case 'expired':
      return action.item.status === 'expired';
    case 'missing':
      return action.item.status === 'missing';
    case 'pending':
      return (
        action.item.status === 'pending_verification' ||
        action.item.status === 'verification_failed'
      );
    case 'failed':
      return action.item.status === 'verification_failed';
    case 'critical':
      return action.severity === 'critical';
    case 'all':
      return true;
  }
}

export function matchesScope(action: ComplianceAction, scope: WorkbenchScope): boolean {
  return scope === 'all' || action.item.scope === scope;
}

export function matchesSearch(action: ComplianceAction, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return `${action.item.entityLabel} ${action.item.requirementName}`.toLowerCase().includes(needle);
}

export interface WorkbenchFilters {
  focus: WorkbenchFocus;
  scope: WorkbenchScope;
  q: string;
}

export function filterActions(
  actions: readonly ComplianceAction[],
  filters: WorkbenchFilters,
): ComplianceAction[] {
  return actions.filter(
    (a) =>
      matchesFocus(a, filters.focus) &&
      matchesScope(a, filters.scope) &&
      matchesSearch(a, filters.q),
  );
}

/** Counts per focus segment, from the same predicate the list uses. */
export function focusCounts(
  actions: readonly ComplianceAction[],
  scope: WorkbenchScope,
  q: string,
): Record<WorkbenchFocus, number> {
  const counts = {
    held: 0,
    expiring: 0,
    expired: 0,
    missing: 0,
    pending: 0,
    failed: 0,
    critical: 0,
    all: 0,
  } as Record<WorkbenchFocus, number>;
  for (const action of actions) {
    if (!matchesScope(action, scope) || !matchesSearch(action, q)) continue;
    for (const focus of Object.keys(counts) as WorkbenchFocus[])
      if (matchesFocus(action, focus)) counts[focus] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------

export interface RequirementGroup {
  code: string;
  name: string;
  scope: ComplianceScope;
  owner: ComplianceRole;
  /** The engine's instruction on the first row; the same for every row of one requirement. */
  requiredAction: string;
  rows: ComplianceAction[];
  blocking: number;
  /** Days until the soonest deadline in the group; null when no row has one. */
  soonestDays: number | null;
  compliance: CatalogCompliance;
}

export interface CatalogCompliance {
  /** Entities in the requirement's scope the requirement applies to. */
  applicable: number;
  /** Of those, how many have it satisfied (on file, verified or waived). */
  satisfied: number;
  /** 0–100, or null when the requirement applies to nobody. */
  pct: number | null;
}

/**
 * How much of the fleet has this requirement in order: the entities in its scope that carry an
 * item for it, against the ones whose item needs nothing. A requirement nobody is subject to has
 * no percentage rather than a perfect one.
 */
export function catalogCompliance(
  entities: readonly EntityCompliance[],
  code: string,
  scope: ComplianceScope,
): CatalogCompliance {
  let applicable = 0;
  let satisfied = 0;
  for (const entity of entities) {
    if (entity.scope !== scope) continue;
    const item = entity.items.find((i) => i.requirementCode === code);
    if (!item) continue;
    applicable += 1;
    if (item.requiredAction === null) satisfied += 1;
  }
  return {
    applicable,
    satisfied,
    pct: applicable === 0 ? null : Math.round((satisfied / applicable) * 100),
  };
}

export function complianceFamily(pct: number | null): 'done' | 'warning' | 'urgent' {
  if (pct === null || pct >= 85) return 'done';
  if (pct >= 70) return 'warning';
  return 'urgent';
}

/**
 * One row per requirement, worst first: most dispatch blockers, then most rows, then the name so
 * the order is stable. The requirement's name, scope and owner come from the catalog when it is
 * there, and from the rows themselves otherwise (a retired rule still has its open items).
 */
export function groupByRequirement(
  actions: readonly ComplianceAction[],
  entities: readonly EntityCompliance[],
  requirements: readonly QualificationRequirement[],
  today: string,
): RequirementGroup[] {
  const catalog = new Map(requirements.map((r) => [r.code, r]));
  const map = new Map<string, ComplianceAction[]>();
  for (const action of actions) {
    const rows = map.get(action.item.requirementCode);
    if (rows) rows.push(action);
    else map.set(action.item.requirementCode, [action]);
  }
  const groups: RequirementGroup[] = [];
  for (const [code, rows] of map) {
    const first = rows[0] as ComplianceAction;
    const rule = catalog.get(code);
    const scope = rule?.scope ?? first.item.scope;
    let soonest: number | null = null;
    for (const row of rows) {
      if (!row.deadline) continue;
      const days = daysBetween(today, row.deadline);
      if (days === null) continue;
      if (soonest === null || days < soonest) soonest = days;
    }
    groups.push({
      code,
      name: rule?.name ?? first.item.requirementName,
      scope,
      owner: rule?.owner ?? first.owner,
      requiredAction: first.item.requiredAction ?? '',
      rows,
      blocking: rows.filter((r) => r.blocksDispatch).length,
      soonestDays: soonest,
      compliance: catalogCompliance(entities, code, scope),
    });
  }
  return groups.sort(
    (a, b) =>
      b.blocking - a.blocking || b.rows.length - a.rows.length || a.name.localeCompare(b.name),
  );
}

/** The records behind a set of actions, once each, in the order the actions come. */
export function entitiesOf(
  actions: readonly ComplianceAction[],
  byKey: ReadonlyMap<string, EntityCompliance>,
): EntityCompliance[] {
  const seen = new Set<string>();
  const out: EntityCompliance[] = [];
  for (const action of actions) {
    const key = entityKey(action.item.scope, action.item.entityId);
    if (seen.has(key)) continue;
    seen.add(key);
    const entity = byKey.get(key);
    if (entity) out.push(entity);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

const SCOPE_WORD: Record<ComplianceScope, [string, string]> = {
  driver: ['driver', 'drivers'],
  truck: ['unit', 'units'],
  trailer: ['trailer', 'trailers'],
  company: ['company', 'company'],
};

/** "3 units · 12 drivers · 1 trailer" - the parts of a count, in the order they matter. */
export function scopeBreakdown(
  entities: readonly EntityCompliance[],
  keep: (entity: EntityCompliance) => boolean,
): string {
  const parts: string[] = [];
  for (const scope of ['truck', 'driver', 'trailer'] as const) {
    const n = entities.filter((e) => e.scope === scope && keep(e)).length;
    parts.push(`${n} ${SCOPE_WORD[scope][n === 1 ? 0 : 1]}`);
  }
  return parts.join(' · ');
}

/** The same breakdown for a count of items rather than records. */
export function scopeBreakdownOfActions(actions: readonly ComplianceAction[]): string {
  const parts: string[] = [];
  for (const scope of ['truck', 'driver', 'trailer'] as const) {
    const n = actions.filter((a) => a.item.scope === scope).length;
    parts.push(`${n} ${SCOPE_WORD[scope][n === 1 ? 0 : 1]}`);
  }
  return parts.join(' · ');
}
