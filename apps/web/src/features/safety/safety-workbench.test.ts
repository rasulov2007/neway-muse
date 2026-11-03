import { describe, expect, it } from 'vitest';
import type {
  ComplianceAction,
  EntityCompliance,
  EvaluatedItem,
  QualificationRequirement,
} from '@neway/shared';
import {
  catalogCompliance,
  complianceFamily,
  entitiesOf,
  filterActions,
  focusCounts,
  groupByRequirement,
  scopeBreakdown,
} from './safety-workbench';

const TODAY = '2026-09-18';

function item(
  entityId: string,
  code: string,
  status: EvaluatedItem['status'],
  over: Partial<EvaluatedItem> = {},
): EvaluatedItem {
  const open = status !== 'valid' && status !== 'verified' && status !== 'waived';
  const blocks = status === 'missing' || status === 'expired' || status === 'verification_failed';
  return {
    itemId: `qi_${entityId}_${code}`,
    requirementCode: code,
    requirementName:
      code === 'cdl' ? 'CDL' : code === 'medical_card' ? 'Medical card' : 'Vehicle registration',
    scope: code === 'vehicle_registration' ? 'truck' : 'driver',
    entityId,
    entityLabel: entityId,
    status,
    severity: blocks ? 'critical' : open ? 'warning' : 'ok',
    expiresOn: null,
    daysRemaining: null,
    warningStage: null,
    inGracePeriod: false,
    blocksDispatch: blocks,
    owner: 'safety_coordinator',
    notify: [],
    reasons: ['because'],
    requiredAction: open ? 'Do the thing' : null,
    deadline: open ? TODAY : null,
    ...over,
  };
}

function entity(
  scope: EntityCompliance['scope'],
  id: string,
  items: EvaluatedItem[],
): EntityCompliance {
  const dispatchable = !items.some((i) => i.blocksDispatch);
  return {
    scope,
    entityId: id,
    entityLabel: id,
    state: dispatchable ? 'compliant' : 'non_compliant',
    dispatchable,
    gateReasons: items.filter((i) => i.blocksDispatch).map((i) => i.requirementName),
    severity: 'ok',
    nextDeadline: null,
    items,
    counts: {
      total: items.length,
      satisfied: items.filter((i) => i.requiredAction === null).length,
      expiring: 0,
      expired: 0,
      missing: 0,
      pendingVerification: 0,
      verificationFailed: 0,
      waived: 0,
    },
  };
}

function action(it: EvaluatedItem): ComplianceAction {
  return {
    key: `${it.scope}:${it.entityId}:${it.requirementCode}`,
    item: it,
    severity: it.severity,
    owner: it.owner,
    deadline: it.deadline,
    blocksDispatch: it.blocksDispatch,
  };
}

const ana = entity('driver', 'ana', [
  item('ana', 'cdl', 'valid'),
  item('ana', 'medical_card', 'expiring', {
    deadline: '2026-09-30',
    expiresOn: '2026-09-30',
    daysRemaining: 12,
  }),
]);
const ben = entity('driver', 'ben', [
  item('ben', 'cdl', 'expired', { deadline: '2026-09-13' }),
  item('ben', 'medical_card', 'pending_verification', { deadline: '2026-09-20' }),
]);
const cy = entity('driver', 'cy', [
  item('cy', 'cdl', 'valid'),
  item('cy', 'medical_card', 'valid'),
]);
const t1 = entity('truck', 't1', [item('t1', 'vehicle_registration', 'missing')]);
const t2 = entity('truck', 't2', [item('t2', 'vehicle_registration', 'valid')]);
const ENTITIES = [ana, ben, cy, t1, t2];
const ACTIONS = ENTITIES.flatMap((e) =>
  e.items.filter((i) => i.requiredAction !== null).map(action),
);
const RULES: QualificationRequirement[] = [
  {
    code: 'cdl',
    name: 'Commercial driver licence',
    scope: 'driver',
    owner: 'safety_coordinator',
  } as QualificationRequirement,
  {
    code: 'vehicle_registration',
    name: 'Vehicle registration',
    scope: 'truck',
    owner: 'fleet_manager',
  } as QualificationRequirement,
];

describe('the focus filter', () => {
  it('lists exactly what the tile counts, and the segments agree with the list', () => {
    const held = filterActions(ACTIONS, { focus: 'held', scope: 'all', q: '' });
    expect(held.map((a) => a.key)).toEqual(['driver:ben:cdl', 'truck:t1:vehicle_registration']);
    const counts = focusCounts(ACTIONS, 'all', '');
    expect(counts.held).toBe(held.length);
    expect(counts.expiring).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.all).toBe(ACTIONS.length);
  });
  it('narrows by scope and search without changing what a focus means', () => {
    expect(
      filterActions(ACTIONS, { focus: 'held', scope: 'truck', q: '' }).map((a) => a.item.entityId),
    ).toEqual(['t1']);
    expect(
      filterActions(ACTIONS, { focus: 'all', scope: 'all', q: 'medical' }).map(
        (a) => a.item.entityId,
      ),
    ).toEqual(['ana', 'ben']);
    expect(focusCounts(ACTIONS, 'driver', '').held).toBe(1);
  });
});

describe('one row per requirement', () => {
  it('folds the rows, most blockers first, with the catalog name and owner', () => {
    const groups = groupByRequirement(
      filterActions(ACTIONS, { focus: 'all', scope: 'all', q: '' }),
      ENTITIES,
      RULES,
      TODAY,
    );
    expect(groups.map((g) => [g.code, g.rows.length, g.blocking])).toEqual(
      [
        ['medical_card', 2, 0],
        ['cdl', 1, 1],
        ['vehicle_registration', 1, 1],
      ].sort(
        (a, b) =>
          (b[2] as number) - (a[2] as number) ||
          (b[1] as number) - (a[1] as number) ||
          String(a[0]).localeCompare(String(b[0])),
      ),
    );
    const cdl = groups.find((g) => g.code === 'cdl');
    expect(cdl?.name).toBe('Commercial driver licence');
    expect(cdl?.owner).toBe('safety_coordinator');
    expect(cdl?.soonestDays).toBe(-5);
    expect(cdl?.requiredAction).toBe('Do the thing');
    // A rule missing from the catalog still gets a row, named from its own items.
    expect(groups.find((g) => g.code === 'medical_card')?.name).toBe('Medical card');
  });
  it("measures catalog compliance across the requirement's scope only", () => {
    expect(catalogCompliance(ENTITIES, 'cdl', 'driver')).toEqual({
      applicable: 3,
      satisfied: 2,
      pct: 67,
    });
    expect(catalogCompliance(ENTITIES, 'vehicle_registration', 'truck')).toEqual({
      applicable: 2,
      satisfied: 1,
      pct: 50,
    });
    expect(catalogCompliance(ENTITIES, 'nothing', 'trailer')).toEqual({
      applicable: 0,
      satisfied: 0,
      pct: null,
    });
    expect(complianceFamily(90)).toBe('done');
    expect(complianceFamily(72)).toBe('warning');
    expect(complianceFamily(50)).toBe('urgent');
  });
});

describe('the words under a tile', () => {
  it('break the count down by scope so the parts add up to it', () => {
    expect(scopeBreakdown(ENTITIES, (e) => !e.dispatchable)).toBe('1 unit · 1 driver · 0 trailers');
  });
  it('lists each record once, in queue order', () => {
    const byKey = new Map(ENTITIES.map((e) => [`${e.scope}:${e.entityId}`, e]));
    expect(entitiesOf(ACTIONS, byKey).map((e) => e.entityId)).toEqual(['ana', 'ben', 't1']);
  });
});
