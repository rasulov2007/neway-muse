import { beforeEach, describe, expect, it } from 'vitest';
import { MAINTENANCE_DEFAULTS, SYSTEM_ROLES } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { MAINTENANCE_COST_PERMISSION, WorkOrdersService } from './work-orders.service';
import { FLEET_EXPENSE_PERMISSION } from './fleet-expense.controller';

/**
 * The promise this module makes to a mechanic: no endpoint ever hands them a price.
 *
 * It is worth testing at this level rather than only through HTTP, because the guarantee is
 * structural — the cost fields are absent from the serialised shape, not blanked in it — and this
 * is where that shape is built.
 */

function principal(permissions: string[]): Principal {
  return {
    userId: 'usr_1',
    userName: 'Test',
    companyId: 'co_1',
    companyTimezone: 'America/Chicago',
    weekStart: 1,
    roles: [],
    permissions: new Set(permissions),
    signedIn: true,
  };
}

/** A row as the database returns it, with money on it. */
function row(over: Partial<Record<string, unknown>> = {}) {
  const shopIn = new Date('2026-09-15T08:00:00Z');
  return {
    id: 'wo_1',
    companyId: 'co_1',
    number: 'RO-2026-1041',
    assetType: 'truck',
    unitId: 'trk_1',
    unitNumber: '3021',
    status: 'in_shop',
    shopStage: 'waiting_parts',
    workType: 'oil_change',
    workDone: null,
    title: null,
    shopInAt: shopIn,
    completedAt: null,
    downtimeMinutes: null,
    odometer: 138_812,
    assignedTo: 'J. Brandt',
    vendorId: 'ven_1',
    vendorName: 'Midwest Diesel Repair',
    partsTotal: '1180.00',
    laborTotal: '797.50',
    feesTotal: '85.00',
    total: '2062.50',
    invoiceNumber: 'MDR-44817',
    invoiceFileIds: ['file_1'],
    notes: null,
    migratedFrom: null,
    createdBy: 'Tom Brennan',
    createdAt: shopIn,
    updatedAt: shopIn,
    ...over,
  };
}

/** Reaches the private serialisers directly: they are the thing under test. */
function serialise(service: WorkOrdersService, who: Principal, data = row()) {
  const inner = service as unknown as {
    maySeeCost(p: Principal): boolean;
    toWorkOrder(r: unknown, a: null, now: number): Record<string, unknown>;
    toWorkOrderWithCost(r: unknown, a: null, now: number): Record<string, unknown>;
  };
  const now = Date.parse('2026-09-17T13:00:00Z');
  return inner.maySeeCost(who)
    ? inner.toWorkOrderWithCost(data, null, now)
    : inner.toWorkOrder(data, null, now);
}

// The shop's name is a place, not a price: it stays on the order for everybody (the repair log
// shows it). Its id, the invoice and every amount are money and go only with the permission.
const COST_FIELDS = [
  'total',
  'partsTotal',
  'laborTotal',
  'feesTotal',
  'estimatedCost',
  'vendorId',
  'invoiceNumber',
  'invoiceFileIds',
];

describe('a mechanic never receives a price', () => {
  let service: WorkOrdersService;

  beforeEach(() => {
    service = new WorkOrdersService({ db: {} } as never, {} as never, {} as never, {} as never);
  });

  it('omits every cost field for a maintenance account', () => {
    const out = serialise(service, principal(['maintenance.view', 'maintenance.edit']));
    for (const field of COST_FIELDS) {
      expect(Object.keys(out), field).not.toContain(field);
    }
  });

  /**
   * Absent, not blank. A zeroed total is a number somebody will eventually display, and a nulled
   * one is a field a future edit can fill; a key that does not exist cannot be either.
   */
  it('leaves no blanked placeholder behind', () => {
    const out = serialise(service, principal(['maintenance.view']));
    expect('total' in out).toBe(false);
    expect(out.total).toBeUndefined();
  });

  it('still tells the mechanic everything they need to work the job', () => {
    const out = serialise(service, principal(['maintenance.view']));
    expect(out).toMatchObject({
      number: 'RO-2026-1041',
      unitNumber: '3021',
      status: 'in_shop',
      shopStage: 'waiting_parts',
      workType: 'oil_change',
      odometer: 138_812,
      assignedTo: 'J. Brandt',
      label: 'Unit 3021 · Oil change',
    });
    // Downtime is counted to now while the unit is in the shop: 2 days 5 hours.
    expect(out.downtimeMinutes).toBe(2 * 24 * 60 + 5 * 60);
  });

  it('gives the costs to an account holding the cost permission', () => {
    const out = serialise(service, principal(['maintenance.view', MAINTENANCE_COST_PERMISSION]));
    expect(out.total).toBe(2062.5);
    expect(out.partsTotal).toBe(1180);
    expect(out.vendorName).toBe('Midwest Diesel Repair');
    expect(out.invoiceFileIds).toEqual(['file_1']);
  });

  it('freezes downtime once a record is completed', () => {
    const out = serialise(
      service,
      principal(['maintenance.view']),
      row({
        status: 'completed',
        completedAt: new Date('2026-09-16T08:00:00Z'),
        downtimeMinutes: 24 * 60,
      }),
    );
    expect(out.downtimeMinutes).toBe(24 * 60);
  });
});

describe('the role that cannot see money', () => {
  const maintenance = SYSTEM_ROLES.find((role) => role.code === 'maintenance');

  it('exists, and is granted the maintenance permissions', () => {
    expect(maintenance).toBeDefined();
    expect(maintenance?.permissions).toContain('maintenance.view');
    expect(maintenance?.permissions).toContain('maintenance.edit');
  });

  /** The whole reason the role exists. Two codes, and it must hold neither. */
  it('holds neither the cost permission nor the workspace blob', () => {
    expect(maintenance?.permissions).not.toContain(MAINTENANCE_COST_PERMISSION);
    expect(maintenance?.permissions).not.toContain('workspace.view');
    expect(maintenance?.permissions).not.toContain('workspace.edit');
  });

  /**
   * The expense summary used to require `maintenance.view`, so granting somebody the shop floor
   * granted them every invoice total in the company. This is the regression that must not return.
   */
  it('cannot reach the expense summary, because that is a money report now', () => {
    expect(FLEET_EXPENSE_PERMISSION).toBe(MAINTENANCE_COST_PERMISSION);
    expect(maintenance?.permissions).not.toContain(FLEET_EXPENSE_PERMISSION);
  });

  it('is still allowed to read the units it works on', () => {
    expect(maintenance?.permissions).toContain('trucks.view');
    expect(maintenance?.permissions).toContain('trailers.view');
  });
});

describe('settings, not constants', () => {
  it('carries a default for every clock the Today board judges', () => {
    expect(MAINTENANCE_DEFAULTS.oilChangeIntervalMiles).toBeGreaterThan(0);
    expect(MAINTENANCE_DEFAULTS.oilChangeDueSoonMiles).toBeGreaterThan(0);
    expect(MAINTENANCE_DEFAULTS.annualInspectionMonths).toBe(12);
    expect(MAINTENANCE_DEFAULTS.pmIntervalDays).toBeGreaterThan(0);
    expect(MAINTENANCE_DEFAULTS.downtimeAmberDays).toBeLessThan(
      MAINTENANCE_DEFAULTS.downtimeRedDays,
    );
  });
});
