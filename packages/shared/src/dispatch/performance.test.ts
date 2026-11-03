import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERFORMANCE_TARGETS,
  buildPerformance,
  scoreBand,
  type DispatcherPerformanceLoad,
  type PerformanceRosterRow,
} from './performance.js';

const FROM = '2026-09-21T00:00:00.000Z';
const TO = '2026-09-27T23:59:59.999Z';

function driver(over: Partial<PerformanceRosterRow> = {}): PerformanceRosterRow {
  return {
    driverId: 'drv_1',
    name: 'Reginald Pike',
    payTag: 'C',
    dispatcherId: 'disp_max',
    dispatcherName: 'MAX',
    truckUnit: '2785',
    unassignedAt: null,
    ...over,
  };
}

function load(over: Partial<DispatcherPerformanceLoad> = {}): DispatcherPerformanceLoad {
  return {
    id: 'ld_1',
    status: 'delivered',
    driverId: 'drv_1',
    pickupAt: '2026-09-22T14:00:00.000Z',
    rate: 2900,
    loadedMiles: 1000,
    weightLbs: 40_000,
    stops: [],
    ...over,
  };
}

const base = { from: FROM, to: TO, weeks: 1, targets: DEFAULT_PERFORMANCE_TARGETS };

describe('the four scores', () => {
  it('reads RPM against the $2.90 target', () => {
    const board = buildPerformance({ ...base, roster: [driver()], loads: [load()] });
    expect(board.rows[0]?.rpm).toBe(2.9);
    expect(board.rows[0]?.rpmPct).toBe(100);
  });

  it('reads efficiency against $10k per truck per week, over the weeks in the period', () => {
    const roster = [driver({ driverId: 'a', truckUnit: '1' }), driver({ driverId: 'b', truckUnit: '2' })];
    const one = buildPerformance({
      ...base,
      roster,
      loads: [load({ driverId: 'a', rate: 22_000, loadedMiles: 1 })],
    });
    // 2 trucks × $10k × 1 week = $20k; $22k booked = 110%.
    expect(one.rows[0]?.efficiencyPct).toBe(110);

    const two = buildPerformance({
      ...base,
      weeks: 2,
      roster,
      loads: [load({ driverId: 'a', rate: 22_000, loadedMiles: 1 })],
    });
    expect(two.rows[0]?.efficiencyPct).toBe(55);
  });

  it('reads activity against 5,000 miles per truck per week', () => {
    const board = buildPerformance({ ...base, roster: [driver()], loads: [load({ loadedMiles: 2500 })] });
    expect(board.rows[0]?.activityPct).toBe(50);
  });

  it('blends pickup and delivery on-time half and half', () => {
    const stops: DispatcherPerformanceLoad['stops'] = [
      // on time at the shipper
      { kind: 'pickup', appointmentStartAt: '2026-09-22T14:00:00Z', appointmentEndAt: '2026-09-22T16:00:00Z', arrivedAt: '2026-09-22T15:00:00Z' },
      // late at the receiver
      { kind: 'delivery', appointmentStartAt: '2026-09-23T14:00:00Z', appointmentEndAt: '2026-09-23T16:00:00Z', arrivedAt: '2026-09-23T18:00:00Z' },
    ];
    const board = buildPerformance({ ...base, roster: [driver()], loads: [load({ stops })] });
    expect(board.rows[0]?.onTimePickupPct).toBe(100);
    expect(board.rows[0]?.onTimeDeliveryPct).toBe(0);
    expect(board.rows[0]?.onTimePct).toBe(50);
  });
});

describe('what it refuses to invent', () => {
  it('leaves a stop with no recorded arrival out of on-time entirely', () => {
    const stops: DispatcherPerformanceLoad['stops'] = [
      { kind: 'pickup', appointmentStartAt: '2026-09-22T14:00:00Z', appointmentEndAt: '2026-09-22T16:00:00Z', arrivedAt: null },
      { kind: 'delivery', appointmentStartAt: '2026-09-23T14:00:00Z', appointmentEndAt: '2026-09-23T16:00:00Z', arrivedAt: null },
    ];
    const row = buildPerformance({ ...base, roster: [driver()], loads: [load({ stops })] }).rows[0];
    expect(row?.onTimePct).toBeNull();
    // and OVERALL is still a number, from the three scores that were measured
    expect(row?.overall).not.toBeNull();
  });

  it('gives a dispatcher with no trucks no efficiency and no activity, not zero', () => {
    const row = buildPerformance({
      ...base,
      roster: [driver({ truckUnit: null })],
      loads: [load()],
    }).rows[0];
    expect(row?.efficiencyPct).toBeNull();
    expect(row?.activityPct).toBeNull();
    expect(row?.grossPerTruck).toBeNull();
  });

  it('leaves a load with no weight out of the average rather than counting it as nothing', () => {
    const row = buildPerformance({
      ...base,
      roster: [driver()],
      loads: [load({ id: 'a', weightLbs: 40_000 }), load({ id: 'b', weightLbs: null })],
    }).rows[0];
    expect(row?.avgWeightLbs).toBe(40_000);
  });

  it('gives no RPM when no miles were run', () => {
    const row = buildPerformance({ ...base, roster: [driver()], loads: [load({ loadedMiles: 0 })] }).rows[0];
    expect(row?.rpm).toBeNull();
    expect(row?.rpmPct).toBeNull();
  });
});

describe('which loads count', () => {
  it('counts a cancelled load in CXL and not in the gross', () => {
    const board = buildPerformance({
      ...base,
      roster: [driver()],
      loads: [load({ id: 'a' }), load({ id: 'b', status: 'cancelled' }), load({ id: 'c', status: 'tonu' })],
    });
    expect(board.rows[0]?.loads).toBe(1);
    expect(board.rows[0]?.cancelled).toBe(2);
    expect(board.rows[0]?.gross).toBe(2900);
  });

  it('counts a load by its pickup, so one before the period is somebody else is week', () => {
    const board = buildPerformance({
      ...base,
      roster: [driver()],
      loads: [load({ id: 'a' }), load({ id: 'b', pickupAt: '2026-09-14T14:00:00.000Z' })],
    });
    expect(board.rows[0]?.loads).toBe(1);
  });

  it('gives the load to the dispatcher whose board the driver is on', () => {
    const board = buildPerformance({
      ...base,
      roster: [
        driver({ driverId: 'a', dispatcherId: 'disp_max', dispatcherName: 'MAX', truckUnit: '1' }),
        driver({ driverId: 'b', dispatcherId: 'disp_adin', dispatcherName: 'ADIN', truckUnit: '2' }),
      ],
      loads: [load({ driverId: 'b', rate: 5000 })],
    });
    const adin = board.rows.find((r) => r.dispatcherName === 'ADIN');
    const max = board.rows.find((r) => r.dispatcherName === 'MAX');
    expect(adin?.gross).toBe(5000);
    expect(max?.gross).toBe(0);
  });

  it('ignores a driver taken off the board', () => {
    const board = buildPerformance({
      ...base,
      roster: [driver({ unassignedAt: '2026-09-20T00:00:00Z' })],
      loads: [load()],
    });
    expect(board.rows).toHaveLength(0);
  });
});

describe('the ranking', () => {
  const roster = [
    driver({ driverId: 'a', dispatcherId: 'd1', dispatcherName: 'ONE', truckUnit: '1' }),
    driver({ driverId: 'b', dispatcherId: 'd2', dispatcherName: 'TWO', truckUnit: '2' }),
  ];

  it('ranks by OVERALL and says how far behind the rank above each one is', () => {
    const board = buildPerformance({
      ...base,
      roster,
      loads: [
        load({ id: 'a', driverId: 'a', rate: 10_000, loadedMiles: 5000 }),
        load({ id: 'b', driverId: 'b', rate: 5000, loadedMiles: 5000 }),
      ],
    });
    expect(board.rows.map((r) => r.dispatcherName)).toEqual(['ONE', 'TWO']);
    expect(board.rows[0]?.rank).toBe(1);
    expect(board.rows[0]?.behindPct).toBeNull();
    expect(board.rows[1]?.behindPct).toBeGreaterThan(0);
  });

  it('shows the movement against the previous period', () => {
    const board = buildPerformance({
      ...base,
      roster,
      loads: [load({ id: 'a', driverId: 'a', rate: 10_000, loadedMiles: 5000 })],
      previousRanks: { d1: 3, d2: 1 },
    });
    expect(board.rows[0]?.movement).toBe(2);
    expect(board.rows[1]?.movement).toBe(-1);
  });

  it('keeps a dispatcher whose week was empty on the board, below everyone with a score', () => {
    const board = buildPerformance({ ...base, roster, loads: [load({ id: 'a', driverId: 'a' })] });
    expect(board.rows).toHaveLength(2);
    expect(board.rows[1]?.dispatcherName).toBe('TWO');
    expect(board.rows[1]?.loads).toBe(0);
  });
});

describe('the summary and the colours', () => {
  it('totals the period across everybody', () => {
    const board = buildPerformance({
      ...base,
      roster: [
        driver({ driverId: 'a', dispatcherId: 'd1', truckUnit: '1' }),
        driver({ driverId: 'b', dispatcherId: 'd2', truckUnit: '2' }),
      ],
      loads: [
        load({ id: 'a', driverId: 'a', rate: 6000, loadedMiles: 2000 }),
        load({ id: 'b', driverId: 'b', rate: 4000, loadedMiles: 2000 }),
      ],
    });
    expect(board.summary.dispatchers).toBe(2);
    expect(board.summary.loads).toBe(2);
    expect(board.summary.gross).toBe(10_000);
    expect(board.summary.miles).toBe(4000);
    expect(board.summary.rpm).toBe(2.5);
    // 2 trucks × $10k × 1 week = $20k target; $10k booked.
    expect(board.summary.efficiencyPct).toBe(50);
  });

  it('bands a score green at target, amber from 80, red below', () => {
    expect(scoreBand(110)).toBe('good');
    expect(scoreBand(100)).toBe('good');
    expect(scoreBand(80)).toBe('warn');
    expect(scoreBand(79.9)).toBe('bad');
    expect(scoreBand(null)).toBe('none');
  });
});

describe('opening a board', () => {
  it('lists the drivers on it, each measured against their own truck', () => {
    const board = buildPerformance({
      ...base,
      roster: [
        driver({ driverId: 'a', name: 'ONE', truckUnit: '1' }),
        driver({ driverId: 'b', name: 'TWO', truckUnit: '2' }),
      ],
      loads: [
        load({ id: 'x', driverId: 'a', rate: 11_000, loadedMiles: 3000 }),
        load({ id: 'y', driverId: 'b', rate: 9000, loadedMiles: 3000 }),
      ],
    });
    const rows = board.rows[0]!.driverRows;
    expect(rows.map((r) => r.name)).toEqual(['ONE', 'TWO']);
    // One truck, one week: $11,000 against a $10,000 target.
    expect(rows[0]?.efficiencyPct).toBe(110);
    expect(rows[0]?.loads).toBe(1);
  });

  it('keeps a driver who ran nothing on the list, at the bottom', () => {
    const board = buildPerformance({
      ...base,
      roster: [
        driver({ driverId: 'a', name: 'RAN', truckUnit: '1' }),
        driver({ driverId: 'b', name: 'IDLE', truckUnit: '2' }),
      ],
      loads: [load({ driverId: 'a' })],
    });
    const rows = board.rows[0]!.driverRows;
    expect(rows).toHaveLength(2);
    expect(rows[1]?.name).toBe('IDLE');
    expect(rows[1]?.loads).toBe(0);
  });

  it('gives a driver with no truck no efficiency, the same rule as a board with none', () => {
    const board = buildPerformance({
      ...base,
      roster: [driver({ driverId: 'a', name: 'NOTRUCK', truckUnit: null })],
      loads: [load({ driverId: 'a' })],
    });
    expect(board.rows[0]?.driverRows[0]?.efficiencyPct).toBeNull();
  });

  it('adds the drivers up to the board they are on', () => {
    const board = buildPerformance({
      ...base,
      roster: [
        driver({ driverId: 'a', name: 'ONE', truckUnit: '1' }),
        driver({ driverId: 'b', name: 'TWO', truckUnit: '2' }),
      ],
      loads: [
        load({ id: 'x', driverId: 'a', rate: 4000, loadedMiles: 1000 }),
        load({ id: 'y', driverId: 'b', rate: 6000, loadedMiles: 2000 }),
      ],
    });
    const row = board.rows[0]!;
    expect(row.driverRows.reduce((s, d) => s + d.gross, 0)).toBe(row.gross);
    expect(row.driverRows.reduce((s, d) => s + d.miles, 0)).toBe(row.miles);
    expect(row.driverRows.reduce((s, d) => s + d.loads, 0)).toBe(row.loads);
  });
});
