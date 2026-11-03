import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE,
  MANAGED_ENTITIES,
  actionsFor,
  decideTransition,
  permittedActions,
  type EntityAction,
} from './lifecycle.js';

function action(
  entity: Parameters<typeof actionsFor>[0],
  status: string,
  key: string,
): EntityAction {
  const found = actionsFor(entity, status).find((a) => a.key === key);
  if (!found) throw new Error(`no ${key} action from ${entity}:${status}`);
  return found;
}

describe('lifecycle catalog', () => {
  it('offers actions for every entity it manages', () => {
    for (const entity of MANAGED_ENTITIES) {
      expect(Object.keys(LIFECYCLE[entity]).length).toBeGreaterThan(0);
    }
  });

  it('returns nothing for a status it does not know, rather than guessing', () => {
    expect(actionsFor('customer', 'not_a_status')).toEqual([]);
  });

  it('never offers a hard delete for an operational record', () => {
    const everyAction = MANAGED_ENTITIES.flatMap((entity) =>
      Object.values(LIFECYCLE[entity]).flat(),
    );
    expect(everyAction.some((a) => /delete|destroy|remove/i.test(a.key))).toBe(false);
  });

  it('always offers a way back from a deactivated state', () => {
    expect(actionsFor('customer', 'inactive').some((a) => a.to === 'active')).toBe(true);
    expect(actionsFor('broker', 'archived').some((a) => a.to === 'active')).toBe(true);
    expect(actionsFor('driver', 'inactive').some((a) => a.to === 'available')).toBe(true);
    expect(actionsFor('truck', 'inactive').some((a) => a.to === 'available')).toBe(true);
    expect(actionsFor('load', 'cancelled').some((a) => a.to === 'booked')).toBe(true);
  });

  it('offers no transitions from a genuinely terminal state', () => {
    expect(actionsFor('driver', 'terminated')).toEqual([]);
    expect(actionsFor('truck', 'sold')).toEqual([]);
  });

  it('marks archiving and terminating as destructive so they always confirm', () => {
    expect(action('customer', 'active', 'archive').destructive).toBe(true);
    expect(action('worker', 'active', 'terminate').destructive).toBe(true);
  });
});

describe('decideTransition', () => {
  const driverInactive = () => action('driver', 'available', 'deactivate');

  it('blocks deactivating a driver who is on a load, and says what to do', () => {
    const decision = decideTransition(
      'driver',
      driverInactive(),
      [
        { key: 'active_loads', count: 1 },
        { key: 'assigned_truck', count: 1 },
      ],
      { name: 'James Wilson' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.map((b) => b.label)).toEqual(['1 active load', '1 assigned unit']);
    expect(decision.confirmation?.body).toContain('Reassign or complete the loads first');
    expect(decision.confirmation?.body).toContain('James Wilson');
  });

  it('allows the same change once the load is gone', () => {
    const decision = decideTransition('driver', driverInactive(), [
      { key: 'active_loads', count: 0 },
    ]);
    expect(decision.allowed).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.confirmation).not.toBeNull();
  });

  it('warns about open claims without blocking, so nobody deletes to get around it', () => {
    const decision = decideTransition(
      'customer',
      action('customer', 'active', 'deactivate'),
      [
        { key: 'open_claims', count: 3 },
        { key: 'unpaid_invoices', count: 2 },
      ],
      { name: 'Acme Freight' },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.warnings.map((w) => w.label)).toEqual(['3 open claims', '2 unpaid invoices']);
    expect(decision.confirmation?.body).toContain('those records are kept');
  });

  it('blocks archiving a customer that still has live freight', () => {
    const decision = decideTransition(
      'customer',
      action('customer', 'active', 'archive'),
      [{ key: 'active_loads', count: 4 }],
      { name: 'Acme Freight' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers[0]?.label).toBe('4 active loads');
  });

  it('states that nothing is deleted in every confirmation', () => {
    const decision = decideTransition('broker', action('broker', 'active', 'deactivate'), []);
    expect(decision.confirmation?.body).toContain('Nothing is deleted');
    expect(decision.confirmation?.body).toContain('audit trail');
  });

  it('needs no confirmation for a navigation or edit action', () => {
    const decision = decideTransition('customer', action('customer', 'active', 'edit'), [
      { key: 'active_loads', count: 9 },
    ]);
    expect(decision.allowed).toBe(true);
    expect(decision.confirmation).toBeNull();
  });

  it('blocks terminating a worker who still has reports', () => {
    const decision = decideTransition(
      'worker',
      action('worker', 'active', 'terminate'),
      [{ key: 'direct_reports', count: 2 }],
      { name: 'Monica Alvarez' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.confirmation?.body).toContain('Reassign the reports');
  });
});

describe('permittedActions', () => {
  it('hides actions the principal cannot perform', () => {
    const all = actionsFor('customer', 'active');
    const dispatcher = permittedActions(all, new Set(['loads.create']));
    expect(dispatcher.map((a) => a.key)).toEqual(['create_load']);

    const manager = permittedActions(all, new Set(['customers.edit', 'loads.create']));
    expect(manager.some((a) => a.key === 'archive')).toBe(false);
    expect(manager.some((a) => a.key === 'deactivate')).toBe(true);
  });

  it('returns nothing for a principal with no relevant permissions', () => {
    expect(permittedActions(actionsFor('driver', 'available'), new Set(['loads.view']))).toEqual(
      [],
    );
  });
});
