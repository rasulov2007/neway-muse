import { describe, expect, it } from 'vitest';
import {
  RULES,
  computeExpenseSummary,
  mileageFor,
  type EngineInput,
  type EngineTruck,
  type SourceOdometerReading,
  type SourceServiceRecord,
  type SourceWorkOrder,
} from './expense-summary.engine';

/**
 * The rules, one at a time, on hand-built records.
 *
 * Every test names the record it expects to be counted and the one it expects to be left out, so
 * a change that quietly widens or narrows the spending basis fails here with the id in the message.
 */

const PERIOD: EngineInput['period'] = {
  preset: 'month',
  from: '2026-09-01',
  to: '2026-09-15',
  label: 'Sep 1 – Sep 15, 2026',
  timezone: 'America/Chicago',
  comparison: { from: '2026-08-17', to: '2026-08-31', label: 'Aug 17 – Aug 31, 2026' },
};

function truck(over: Partial<EngineTruck> & { id: string }): EngineTruck {
  return {
    kind: 'truck',
    unitNumber: over.id.replace('trk_', ''),
    year: 2022,
    make: 'Freightliner',
    model: 'Cascadia',
    ownership: 'owned',
    status: 'active',
    odometer: 500_000,
    nextServiceOdometer: 510_000,
    nextServiceDate: '2026-12-01',
    ...over,
  };
}

function order(over: Partial<SourceWorkOrder> & { id: string }): SourceWorkOrder {
  return {
    roNumber: over.id.toUpperCase(),
    truckId: 'trk_1',
    status: 'completed',
    type: 'brake_repair',
    vendorName: 'Midwest Truck Service',
    vendorId: null,
    unitType: null,
    trailerId: null,
    openedAt: '2026-09-01T12:00:00.000Z',
    completedAt: '2026-09-05T18:00:00.000Z',
    odometer: null,
    total: 1000,
    invoices: [],
    ...over,
  };
}

function record(over: Partial<SourceServiceRecord> & { id: string }): SourceServiceRecord {
  return {
    truckId: 'trk_1',
    type: 'tire_rotation',
    description: 'Tire rotation',
    doneAt: '2026-09-03',
    odometer: null,
    vendorName: 'Tire Barn',
    cost: 150,
    repairOrderId: null,
    ...over,
  };
}

function reading(truckId: string, at: string, odometer: number): SourceOdometerReading {
  return { truckId, at, odometer };
}

/** Company-local day: the tests use instants far from midnight, so UTC day == Chicago day. */
const localDate = (iso: string): string => iso.slice(0, 10);

function run(over: Partial<EngineInput> = {}) {
  return computeExpenseSummary({
    trucks: [truck({ id: 'trk_1' }), truck({ id: 'trk_2' })],
    vendors: [],
    workOrders: [],
    serviceRecords: [],
    odometerReadings: [],
    period: PERIOD,
    today: '2026-09-15',
    selectedUnits: [],
    unknownUnits: [],
    unitType: 'all',
    localDate,
    provenance: 'workspace',
    snapshotUpdatedAt: null,
    asOf: '2026-09-15T12:00:00.000Z',
    ...over,
  });
}

describe('spending basis', () => {
  it('counts completed orders by completion date and leaves out open, draft, cancelled and undated ones', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_done', total: 500 }),
        order({ id: 'ro_open', status: 'in_shop', total: 999 }),
        order({ id: 'ro_draft', status: 'draft', total: 999 }),
        order({ id: 'ro_cancelled', status: 'cancelled', total: 999 }),
        order({ id: 'ro_undated', completedAt: null, total: 999 }),
        // Opened inside the period, completed after it: dated by completion, so not in this period.
        order({ id: 'ro_later', completedAt: '2026-09-20T10:00:00.000Z', total: 999 }),
      ],
    });
    expect(out.events.map((e) => e.id)).toEqual(['ro_done']);
    expect(out.kpis.totalSpend.value).toBe(500);
    expect(out.coverage.excluded).toMatchObject({
      notCompleted: 1,
      draftOrCancelled: 2,
      missingCompletionDate: 1,
    });
  });

  it('never counts an order, its linked service record and its invoice more than once', () => {
    const out = run({
      workOrders: [
        order({
          id: 'ro_1',
          total: 1250,
          invoices: [
            { amount: 1100, uploadedAt: '2026-09-05T18:00:00.000Z' },
            { amount: 1250, uploadedAt: '2026-09-06T18:00:00.000Z' },
          ],
        }),
      ],
      serviceRecords: [
        record({ id: 'sr_linked', repairOrderId: 'ro_1', cost: 1250 }),
        record({ id: 'sr_alone', cost: 150 }),
        // Points at an order the workspace no longer holds: standalone in practice.
        record({ id: 'sr_orphan', repairOrderId: 'ro_gone', cost: 60 }),
      ],
    });
    expect(out.events.map((e) => e.id).sort()).toEqual(['ro_1', 'sr_alone', 'sr_orphan']);
    expect(out.kpis.totalSpend.value).toBe(1460);
    expect(out.coverage.excluded.linkedServiceRecords).toBe(1);
    expect(out.events.find((e) => e.id === 'ro_1')?.amountSource).toBe('invoice');
  });

  it('uses the canonical order total and reports an invoice that disagrees with it', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_agree', total: 900, invoices: [{ amount: 900, uploadedAt: 'x' }] }),
        order({ id: 'ro_disagree', total: 900, invoices: [{ amount: 1200, uploadedAt: 'x' }] }),
        order({ id: 'ro_unpriced', total: 900, invoices: [{ amount: null, uploadedAt: 'x' }] }),
      ],
    });
    expect(out.kpis.totalSpend.value).toBe(2700);
    expect(out.coverage.excluded.invoiceMismatch).toBe(1);
    expect(out.coverage.invoiceMismatchIds).toEqual(['ro_disagree']);
    expect(out.events.find((e) => e.id === 'ro_unpriced')?.amountSource).toBe('work_order');
  });

  it('keeps a real zero and excludes an unknown amount', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_zero', total: 0 }),
        order({ id: 'ro_unknown', total: null }),
        order({ id: 'ro_nan', total: Number.NaN }),
      ],
      serviceRecords: [
        record({ id: 'sr_zero', cost: 0 }),
        record({ id: 'sr_unknown', cost: null }),
      ],
    });
    expect(out.events.map((e) => e.id).sort()).toEqual(['ro_zero', 'sr_zero']);
    expect(out.kpis.totalSpend.value).toBe(0);
    expect(out.coverage.zeroAmountEvents).toBe(2);
    expect(out.coverage.excluded.unknownAmount).toBe(3);
  });

  it('counts only the company share of an owner-billed repair, and reports the rest', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_company', total: 1000 }),
        // Wholly the owner's: no company spend at all, and not an event.
        order({ id: 'ro_owner', total: 800, ownerBilledAmount: 800 }),
        // Split: the company keeps 300 of 1000.
        order({ id: 'ro_split', total: 1000, ownerBilledAmount: 700 }),
      ],
      serviceRecords: [],
    });
    expect(out.events.map((e) => e.id).sort()).toEqual(['ro_company', 'ro_split']);
    expect(out.kpis.totalSpend.value).toBe(1300);
    expect(out.coverage.ownerBilled).toEqual({ amount: 1500, orders: 2 });
  });

  it('respects both period boundaries inclusively and dates by the company-local day', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_first', completedAt: '2026-09-01T00:30:00.000Z', total: 1 }),
        order({ id: 'ro_last', completedAt: '2026-09-15T23:30:00.000Z', total: 2 }),
        order({ id: 'ro_before', completedAt: '2026-08-31T23:59:00.000Z', total: 4 }),
        order({ id: 'ro_after', completedAt: '2026-09-16T00:01:00.000Z', total: 8 }),
      ],
      // A conversion that moves everything one day earlier, as a western timezone would late at night.
      localDate: (iso) => {
        const day = new Date(iso);
        day.setUTCDate(day.getUTCDate() - 1);
        return day.toISOString().slice(0, 10);
      },
    });
    // ro_first shifts to Aug 31 (out), ro_after shifts to Sep 15 (in).
    expect(out.events.map((e) => e.id).sort()).toEqual(['ro_after', 'ro_last']);
    expect(out.kpis.totalSpend.value).toBe(10);
  });

  it('attributes records through the roster and excludes any on a unit the company does not own', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_mine', truckId: 'trk_1' }),
        order({ id: 'ro_theirs', truckId: 'trk_other_company' }),
      ],
      serviceRecords: [record({ id: 'sr_theirs', truckId: 'trk_other_company' })],
    });
    expect(out.events.map((e) => e.id)).toEqual(['ro_mine']);
    expect(out.coverage.excluded.unattributedTruck).toBe(2);
  });

  it('restricts every section to the selected units', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_1', truckId: 'trk_1', total: 100 }),
        order({ id: 'ro_2', truckId: 'trk_2', total: 200 }),
      ],
      selectedUnits: ['trk_2'],
    });
    expect(out.events.map((e) => e.id)).toEqual(['ro_2']);
    expect(out.kpis.totalSpend.value).toBe(200);
    expect(out.vehicles.rows.map((v) => v.truckId)).toEqual(['trk_2']);
    expect(out.kpis.averagePerVehicle.value).toBe(200);
    expect(out.meta.filters.units).toEqual(['trk_2']);
  });

  it('handles well over two hundred records without truncation', () => {
    const workOrders = Array.from({ length: 260 }, (_, i) =>
      order({
        id: `ro_${i}`,
        truckId: i % 2 === 0 ? 'trk_1' : 'trk_2',
        total: 10,
        type: 'oil_change',
      }),
    );
    const out = run({ workOrders });
    expect(out.events).toHaveLength(260);
    expect(out.kpis.totalSpend.value).toBe(2600);
    expect(out.kpis.totalSpend.recordIds).toHaveLength(260);
  });
});

describe('trailers', () => {
  const trailer: EngineTruck = {
    id: 'trl_1',
    kind: 'trailer',
    unitNumber: 'T-1',
    year: 2022,
    make: 'Great Dane',
    model: 'dry van 53 ft',
    ownership: 'owned',
    status: 'available',
    odometer: null,
    nextServiceOdometer: null,
    nextServiceDate: null,
  };
  const orders = [
    order({ id: 'ro_truck', truckId: 'trk_1', total: 100 }),
    order({
      id: 'ro_trailer',
      truckId: '',
      unitType: 'trailer',
      trailerId: 'trl_1',
      type: 'landing_gear',
      total: 250,
    }),
  ];

  it('counts a trailer order on the trailer, and the filter narrows to either kind', () => {
    const all = run({ trucks: [truck({ id: 'trk_1' }), trailer], workOrders: orders });
    expect(all.events.map((e) => [e.id, e.unitKind])).toEqual([
      ['ro_trailer', 'trailer'],
      ['ro_truck', 'truck'],
    ]);
    expect(all.kpis.totalSpend.value).toBe(350);
    expect(all.meta.fleet).toEqual({ trucks: 1, trailers: 1 });
    expect(all.vehicles.rows.find((v) => v.truckId === 'trl_1')).toMatchObject({
      kind: 'trailer',
      spend: 250,
    });
    expect(all.kpis.averagePerVehicle.value).toBe(175);
    expect(all.kpis.averagePerVehicle.basis).toMatch(/1 trucks, 1 trailers/);

    const trailersOnly = run({
      trucks: [truck({ id: 'trk_1' }), trailer],
      workOrders: orders,
      unitType: 'trailer',
    });
    expect(trailersOnly.kpis.totalSpend.value).toBe(250);
    expect(trailersOnly.vehicles.rows.map((v) => v.truckId)).toEqual(['trl_1']);
    expect(trailersOnly.kpis.costPerMile.value).toBeNull();
    expect(trailersOnly.kpis.costPerMile.reasons[0]).toMatch(/Not applicable to trailers/);

    const trucksOnly = run({
      trucks: [truck({ id: 'trk_1' }), trailer],
      workOrders: orders,
      unitType: 'truck',
    });
    expect(trucksOnly.kpis.totalSpend.value).toBe(100);
  });
});

describe('categories, vendors and service types', () => {
  it('reconciles the category slices to the total and folds beyond six types into one slice', () => {
    const types = [
      'brake_repair',
      'engine',
      'transmission',
      'electrical',
      'dpf',
      'battery',
      'coolant',
      'oil_change',
    ];
    const out = run({
      workOrders: types.map((type, i) => order({ id: `ro_${type}`, type, total: (i + 1) * 100 })),
    });
    const total = out.categories.total;
    expect(total).toBe(3600);
    expect(out.categories.slices).toHaveLength(6);
    expect(out.categories.otherMembers).toHaveLength(3);
    const sliceSum = out.categories.slices.reduce((sum, s) => sum + s.spend, 0);
    expect(sliceSum).toBe(total);
    const idsInSlices = out.categories.slices.flatMap((s) => s.recordIds).sort();
    expect(idsInSlices).toEqual(out.events.map((e) => e.id).sort());
    expect(out.categories.slices[0]?.label).toBe('Oil change');
    expect(out.categories.slices[5]?.label).toMatch(/^All other types/);
  });

  it('groups vendors by normalised name, keeps the written name and buckets the unknown', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_a', vendorName: 'Midwest Truck Service', total: 100 }),
        order({
          id: 'ro_b',
          vendorName: '  midwest   truck service ',
          total: 200,
          completedAt: '2026-09-06T12:00:00.000Z',
        }),
        order({ id: 'ro_c', vendorName: '', total: 50 }),
        order({ id: 'ro_d', vendorName: null, total: 25 }),
      ],
    });
    expect(out.vendors.rows.map((v) => [v.key, v.spend, v.events])).toEqual([
      ['midwest truck service', 300, 2],
      ['unknown', 75, 2],
    ]);
    expect(out.vendors.rows[0]?.name).toBe('midwest   truck service');
    expect(out.vendors.rows[1]?.name).toBe('Unknown vendor');
  });

  it("groups by vendor record when the order names one, under the record's current name", () => {
    const out = run({
      vendors: [{ id: 'ven_1', name: 'TA Truck Service' }],
      workOrders: [
        order({ id: 'ro_a', vendorName: 'TA truck service', vendorId: 'ven_1', total: 100 }),
        order({ id: 'ro_b', vendorName: 'T.A. Truck Svc', vendorId: 'ven_1', total: 200 }),
        order({ id: 'ro_c', vendorName: 'Somebody Else', total: 50 }),
      ],
    });
    expect(out.vendors.groupedBy).toBe('vendor_id');
    expect(out.vendors.byNameOnly).toBe(1);
    expect(out.vendors.rows[0]).toMatchObject({
      vendorId: 'ven_1',
      name: 'TA Truck Service',
      spend: 300,
      events: 2,
    });
    expect(out.vendors.rows[1]).toMatchObject({ vendorId: null, name: 'Somebody Else' });
  });

  it('ranks service types by events, deduplicated, and marks a widespread one', () => {
    const trucks = Array.from({ length: 8 }, (_, i) => truck({ id: `trk_${i + 1}` }));
    const out = run({
      trucks,
      workOrders: [
        ...trucks
          .slice(0, 4)
          .map((t, i) => order({ id: `ro_brake_${i}`, truckId: t.id, type: 'brake_repair' })),
        order({ id: 'ro_eng', truckId: 'trk_1', type: 'engine', total: 5000 }),
      ],
      serviceRecords: [record({ id: 'sr_linked', repairOrderId: 'ro_eng', type: 'engine' })],
    });
    expect(out.serviceTypes.widespreadThreshold).toBe(3);
    expect(out.serviceTypes.rows[0]).toMatchObject({
      type: 'brake_repair',
      events: 4,
      truckCount: 4,
      widespread: true,
    });
    expect(out.serviceTypes.rows[1]).toMatchObject({
      type: 'engine',
      events: 1,
      widespread: false,
    });
  });
});

describe('cost per mile', () => {
  it('needs two readings that span the period and go forwards', () => {
    expect(mileageFor('t', [], '2026-09-01', '2026-09-15').reason).toMatch(/fewer than two/);
    expect(
      mileageFor(
        't',
        [
          { date: '2026-09-01', odometer: 100 },
          { date: '2026-09-03', odometer: 200 },
        ],
        '2026-09-01',
        '2026-09-15',
      ).reason,
    ).toMatch(/readings cover 3 of 15 days/);
    expect(
      mileageFor(
        't',
        [
          { date: '2026-09-01', odometer: 500 },
          { date: '2026-09-15', odometer: 400 },
        ],
        '2026-09-01',
        '2026-09-15',
      ).reason,
    ).toMatch(/backwards/);
    expect(
      mileageFor(
        't',
        [
          { date: '2026-09-01', odometer: 100 },
          { date: '2026-09-01', odometer: 100 },
          { date: '2026-09-15', odometer: 1100 },
        ],
        '2026-09-01',
        '2026-09-15',
      ),
    ).toMatchObject({ miles: 1000, readings: 2 });
  });

  /** Two readings a fortnight apart on one truck; the fleet's miles come from these. */
  const covered = (id: string, start = 100_000) => [
    reading(id, '2026-09-01T12:00:00.000Z', start),
    reading(id, '2026-09-14T12:00:00.000Z', start + 2_000),
  ];

  it('divides spend by miles only over units with valid coverage, and says who was left out', () => {
    // Nine of ten trucks covered: high confidence, so the figure is shown plainly.
    const trucks = Array.from({ length: 10 }, (_, i) => truck({ id: `trk_${i + 1}` }));
    const out = run({
      trucks,
      workOrders: [
        order({ id: 'ro_1', truckId: 'trk_1', total: 500 }),
        order({ id: 'ro_2', truckId: 'trk_10', total: 700 }),
      ],
      odometerReadings: [
        ...trucks.slice(0, 9).flatMap((tr) => covered(tr.id)),
        // The tenth has one reading only: no mileage, so its $700 is not in the ratio.
        reading('trk_10', '2026-09-10T12:00:00.000Z', 50_000),
      ],
    });
    expect(out.kpis.costPerMile.value).toBe(0.0278);
    expect(out.kpis.costPerMile.confidence).toMatchObject({ level: 'high', coveragePct: 90 });
    expect(out.kpis.costPerMile.reasons[0]).toMatch(
      /1 trucks left out: 1 fewer than two odometer readings/,
    );
    expect(out.kpis.costPerMile.recordIds).toEqual(['ro_1']);
  });

  /**
   * Acceptance test A16. A cost per mile computed over a third of the fleet is not the fleet's
   * cost per mile, and printed without that fact it gets acted on.
   */
  it('withholds the figure below 70% coverage and shows the coverage instead', () => {
    const out = run({
      workOrders: [
        order({ id: 'ro_1', truckId: 'trk_1', total: 500 }),
        order({ id: 'ro_2', truckId: 'trk_2', total: 700 }),
      ],
      odometerReadings: [
        ...covered('trk_1'),
        reading('trk_2', '2026-09-10T12:00:00.000Z', 50_000),
      ],
    });
    expect(out.kpis.costPerMile.value).toBeNull();
    expect(out.kpis.costPerMile.confidence).toMatchObject({ level: 'low', coveragePct: 50 });
    expect(out.kpis.costPerMile.reasons[0]).toMatch(
      /Not shown: odometer readings cover only 50% of the 2 trucks in scope/,
    );
  });

  it('shows the figure with a medium chip between 70% and 89% coverage', () => {
    const trucks = Array.from({ length: 4 }, (_, i) => truck({ id: `trk_${i + 1}` }));
    const out = run({
      trucks,
      workOrders: [order({ id: 'ro_1', truckId: 'trk_1', total: 500 })],
      odometerReadings: trucks.slice(0, 3).flatMap((tr) => covered(tr.id)),
    });
    expect(out.kpis.costPerMile.value).not.toBeNull();
    expect(out.kpis.costPerMile.confidence).toMatchObject({ level: 'medium', coveragePct: 75 });
  });

  /**
   * Acceptance test A17. "Up 200%" on a prior period of $80 is a sentence about three oil filters.
   */
  it('offers no percentage change against a prior period too small to mean anything', () => {
    const out = run({
      workOrders: [order({ id: 'ro_now', truckId: 'trk_1', total: 900 })],
    });
    expect(out.kpis.totalSpend.value).toBe(900);
    expect(out.kpis.totalSpend.deltaPct).toBeNull();
  });

  it('is unavailable with the coverage reason when no unit qualifies', () => {
    const out = run({ workOrders: [order({ id: 'ro_1', total: 500 })] });
    expect(out.kpis.costPerMile.value).toBeNull();
    expect(out.kpis.costPerMile.reasons[0]).toMatch(
      /No truck has odometer readings spanning at least 80%/,
    );
  });
});

describe('the present-tense figures', () => {
  it('counts in-shop and inactive units from the roster status and states the denominator', () => {
    const out = run({
      trucks: [
        truck({ id: 'trk_1', status: 'in_shop' }),
        truck({ id: 'trk_2', status: 'inactive' }),
        truck({ id: 'trk_3', status: 'sold' }),
        truck({ id: 'trk_4', status: 'driving' }),
      ],
      workOrders: [
        // An open order does not put a unit in the shop.
        order({ id: 'ro_open', truckId: 'trk_4', status: 'in_shop' }),
        order({ id: 'ro_sold', truckId: 'trk_3', total: 300 }),
        order({ id: 'ro_1', truckId: 'trk_1', total: 600 }),
      ],
    });
    expect(out.kpis.inShopNow).toMatchObject({ value: 1, current: true, recordIds: ['trk_1'] });
    expect(out.kpis.inShopNow.link?.search).toEqual({ status: 'in_shop', ids: 'trk_1' });
    expect(out.kpis.inactiveNow).toMatchObject({ value: 1, current: true });
    // 3 units not sold; the sold unit's $300 is outside the numerator.
    expect(out.kpis.averagePerVehicle.value).toBe(200);
    expect(out.kpis.averagePerVehicle.basis).toMatch(/3 units on the roster now/);
    expect(out.kpis.leaseOverage.value).toBeNull();
    expect(out.kpis.leaseOverage.reasons[0]).toMatch(/Lease mileage terms not configured/);
  });
});

describe('anomalies', () => {
  const at = (date: string) => `${date}T12:00:00.000Z`;

  it('flags a spend spike only against enough prior periods and enough money', () => {
    const history = [
      order({ id: 'p1', completedAt: at('2026-08-20'), total: 300 }),
      order({ id: 'p2', completedAt: at('2026-08-05'), total: 300 }),
    ];
    const spike = run({ workOrders: [...history, order({ id: 'now', total: 900 })] });
    const finding = spike.anomalies.findings.find((f) => f.rule === 'spend_spike');
    expect(finding).toMatchObject({ truckId: 'trk_1', severity: 'warning', recordIds: ['now'] });
    expect(finding?.detail).toMatch(
      /\$900\.00 this period against an average of \$300\.00 over 2 prior 15-day ranges/,
    );

    const onePrior = run({
      workOrders: [history[0] as SourceWorkOrder, order({ id: 'now', total: 900 })],
    });
    expect(onePrior.anomalies.findings.filter((f) => f.rule === 'spend_spike')).toHaveLength(0);

    const small = run({
      workOrders: [...history.map((o) => ({ ...o, total: 100 })), order({ id: 'now', total: 400 })],
    });
    expect(small.anomalies.findings.filter((f) => f.rule === 'spend_spike')).toHaveLength(0);
    expect(RULES.spikeMinSpend).toBe(500);
  });

  it('flags a repeated repair type within 60 days but not scheduled upkeep', () => {
    const out = run({
      workOrders: [
        order({ id: 'b1', type: 'brake_repair', completedAt: at('2026-07-20') }),
        order({ id: 'b2', type: 'brake_repair', completedAt: at('2026-09-10') }),
        // 71 days apart: outside the 60-day window, so not a repeat.
        order({ id: 't1', type: 'tire_replacement', completedAt: at('2026-07-01') }),
        order({ id: 't2', type: 'tire_replacement', completedAt: at('2026-09-10') }),
        order({ id: 'o1', type: 'oil_change', completedAt: at('2026-08-25') }),
        order({ id: 'o2', type: 'oil_change', completedAt: at('2026-09-10') }),
        order({ id: 'e1', type: 'engine', completedAt: at('2026-05-01') }),
        order({ id: 'e2', type: 'engine', completedAt: at('2026-09-10') }),
      ],
    });
    const repeats = out.anomalies.findings.filter((f) => f.rule === 'repeat_service');
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toMatchObject({ recordIds: ['b1', 'b2'] });
    expect(repeats[0]?.detail).toMatch(/do not say whether the same part/);
  });

  it('compares cost per mile to the median only with three covered units, otherwise says so', () => {
    const trucks = [truck({ id: 'trk_1' }), truck({ id: 'trk_2' }), truck({ id: 'trk_3' })];
    const readings = trucks.flatMap((t) => [
      reading(t.id, at('2026-09-01'), 1000),
      reading(t.id, at('2026-09-15'), 2000),
    ]);
    const out = run({
      trucks,
      odometerReadings: readings,
      workOrders: [
        order({ id: 'r1', truckId: 'trk_1', total: 100 }),
        order({ id: 'r2', truckId: 'trk_2', total: 100 }),
        order({ id: 'r3', truckId: 'trk_3', total: 1000 }),
      ],
    });
    const cpm = out.anomalies.findings.filter((f) => f.rule === 'cpm_above_median');
    expect(cpm).toHaveLength(1);
    expect(cpm[0]?.truckId).toBe('trk_3');
    expect(cpm[0]?.detail).toMatch(/\$1\.0000\/mi .* median of \$0\.1000\/mi across 3 units/);

    const two = run({ trucks: trucks.slice(0, 2), odometerReadings: readings, workOrders: [] });
    const check = two.anomalies.checks.find((c) => c.rule === 'cpm_above_median');
    expect(check?.status).toBe('unavailable');
    expect(check?.reason).toMatch(/Only 2 units/);
  });

  it('reports shop stay as a check that could not run, never as a finding', () => {
    const out = run({ workOrders: [order({ id: 'ro_open', status: 'in_shop' })] });
    expect(out.anomalies.findings.filter((f) => f.rule === 'long_shop_stay')).toHaveLength(0);
    expect(out.anomalies.checks.find((c) => c.rule === 'long_shop_stay')).toMatchObject({
      status: 'unavailable',
    });
  });

  it('flags PM overdue now from the roster, with the real today', () => {
    const out = run({
      trucks: [
        truck({ id: 'trk_1', odometer: 520_000, nextServiceOdometer: 510_000 }),
        truck({ id: 'trk_2', nextServiceDate: '2026-09-10' }),
        truck({ id: 'trk_3', status: 'sold', nextServiceDate: '2026-01-01' }),
      ],
    });
    const overdue = out.anomalies.findings.filter((f) => f.rule === 'pm_overdue');
    expect(overdue.map((f) => [f.truckId, f.severity, f.current])).toEqual([
      ['trk_1', 'critical', true],
      ['trk_2', 'warning', true],
    ]);
  });

  it('flags an unusually expensive event against enough same-type history and names the source', () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      order({ id: `h${i}`, type: 'oil_change', total: 300, completedAt: at('2026-06-01') }),
    );
    const out = run({
      workOrders: [
        ...history,
        order({
          id: 'big',
          type: 'oil_change',
          total: 900,
          invoices: [{ amount: 900, uploadedAt: 'x' }],
        }),
        order({ id: 'few', type: 'engine', total: 9000 }),
      ],
    });
    const expensive = out.anomalies.findings.filter((f) => f.rule === 'expensive_service');
    expect(expensive).toHaveLength(1);
    expect(expensive[0]).toMatchObject({ recordIds: ['big'], severity: 'info' });
    expect(expensive[0]?.title).toMatch(/^Invoice 3\.0× the usual oil change cost/);
    expect(expensive[0]?.detail).toMatch(/invoice amount/);
  });

  it('counts flags per vehicle and orders findings by severity', () => {
    const out = run({
      trucks: [
        truck({ id: 'trk_1', odometer: 520_000, nextServiceOdometer: 510_000 }),
        truck({ id: 'trk_2' }),
      ],
      workOrders: [
        order({ id: 'b1', type: 'brake_repair', completedAt: at('2026-08-20') }),
        order({ id: 'b2', type: 'brake_repair', completedAt: at('2026-09-10') }),
      ],
    });
    expect(out.anomalies.findings.map((f) => f.severity)).toEqual(['critical', 'warning']);
    expect(out.vehicles.rows.find((v) => v.truckId === 'trk_1')?.flags).toBe(2);
    expect(out.vehicles.flagged).toBe(1);
    expect(out.anomalies.counts).toEqual({ critical: 1, warning: 1, info: 0 });
  });
});

describe('vehicles', () => {
  it('sorts by spend, names the top service type and trends against the comparison range', () => {
    const out = run({
      workOrders: [
        order({ id: 'a1', truckId: 'trk_1', type: 'engine', total: 100 }),
        order({ id: 'a2', truckId: 'trk_1', type: 'engine', total: 100 }),
        order({ id: 'a3', truckId: 'trk_1', type: 'battery', total: 500 }),
        order({ id: 'a0', truckId: 'trk_1', total: 350, completedAt: '2026-08-20T12:00:00.000Z' }),
        order({ id: 'b1', truckId: 'trk_2', total: 900 }),
      ],
    });
    expect(out.vehicles.rows.map((v) => v.truckId)).toEqual(['trk_2', 'trk_1']);
    const one = out.vehicles.rows[1];
    expect(one).toMatchObject({
      topType: 'engine',
      topTypeEvents: 2,
      events: 3,
      spend: 700,
      previousSpend: 350,
      trendPct: 100,
    });
    expect(out.vehicles.rows[0]?.trendPct).toBeNull();
  });
});

describe('a record is never counted twice', () => {
  /*
   * The report reads two sources - the workspace snapshot and the server's own table - and the
   * same order can arrive from both. Whatever the service fails to recognise, the engine must
   * still count once: a total that double-counts a repair is a number somebody makes a decision
   * on.
   */
  it('counts one event per record id, and says how many copies it dropped', () => {
    const out = run({
      workOrders: [order({ id: 'ro_1', total: 1000 }), order({ id: 'ro_1', total: 1000 })],
    });
    expect(out.coverage.excluded.duplicateRecords).toBe(1);
    expect(out.events.filter((e) => e.id === 'ro_1')).toHaveLength(1);
    expect(out.categories.total).toBe(1000);
  });
});
