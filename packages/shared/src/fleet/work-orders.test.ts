import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_DEFAULTS,
  annualInspectionDue,
  annualInspectionStatus,
  daysBetweenDates,
  downtimeMinutes,
  formatDowntime,
  oilChangeStatus,
  pmInspectionStatus,
  workOrderLabel,
  CreateWorkOrderSchema,
  CompleteWorkOrderSchema,
} from './work-orders.js';

const D = MAINTENANCE_DEFAULTS;

describe('oil change', () => {
  const base = {
    intervalMiles: D.oilChangeIntervalMiles,
    dueSoonMiles: D.oilChangeDueSoonMiles,
  };

  it('counts the miles left on the interval', () => {
    const out = oilChangeStatus({ ...base, odometer: 310_000, lastOdometer: 295_000 });
    expect(out.milesRemaining).toBe(10_000);
    expect(out.status).toBe('ok');
  });

  it('is due soon inside the threshold', () => {
    const out = oilChangeStatus({ ...base, odometer: 319_500, lastOdometer: 295_000 });
    expect(out.milesRemaining).toBe(500);
    expect(out.status).toBe('due_soon');
  });

  it('is overdue on the interval, not a mile after it', () => {
    expect(oilChangeStatus({ ...base, odometer: 320_000, lastOdometer: 295_000 }).status).toBe(
      'overdue',
    );
  });

  it('reports how many miles over, as a negative', () => {
    const out = oilChangeStatus({ ...base, odometer: 323_108, lastOdometer: 295_000 });
    expect(out.milesRemaining).toBe(-3_108);
    expect(out.status).toBe('overdue');
  });

  /**
   * A unit nobody has ever recorded an oil change for is not late; it is unrecorded. Calling it
   * overdue would send a mechanic to do work that may have been done last week, and it hides the
   * thing that actually needs doing, which is entering the baseline.
   */
  it('is unknown with no history, never overdue', () => {
    expect(oilChangeStatus({ ...base, odometer: 310_000, lastOdometer: null }).status).toBe(
      'unknown',
    );
    expect(oilChangeStatus({ ...base, odometer: null, lastOdometer: 295_000 }).status).toBe(
      'unknown',
    );
  });

  it('honours a per-unit interval over the default', () => {
    const out = oilChangeStatus({
      odometer: 310_000,
      lastOdometer: 295_000,
      intervalMiles: 15_000,
      dueSoonMiles: 1_000,
    });
    expect(out.status).toBe('overdue');
  });
});

describe('annual inspection', () => {
  const base = { months: D.annualInspectionMonths, dueSoonDays: D.annualInspectionDueSoonDays };

  it('falls due twelve months after the last one', () => {
    expect(annualInspectionDue('2026-02-17', 12)).toBe('2027-02-17');
  });

  it('is on schedule well before the date', () => {
    const out = annualInspectionStatus({ ...base, lastDoneAt: '2026-02-17', today: '2026-09-17' });
    expect(out.dueDate).toBe('2027-02-17');
    expect(out.status).toBe('ok');
  });

  it('is due soon inside thirty days', () => {
    const out = annualInspectionStatus({ ...base, lastDoneAt: '2025-10-01', today: '2026-09-17' });
    expect(out.daysRemaining).toBe(14);
    expect(out.status).toBe('due_soon');
  });

  /** Under 49 CFR 396.17 the unit may not be operated, so the day after is already overdue. */
  it('is overdue the day after it expires', () => {
    const out = annualInspectionStatus({ ...base, lastDoneAt: '2025-09-16', today: '2026-09-17' });
    expect(out.daysRemaining).toBe(-1);
    expect(out.status).toBe('overdue');
  });

  it('is on schedule on the day itself', () => {
    const out = annualInspectionStatus({ ...base, lastDoneAt: '2025-09-17', today: '2026-09-17' });
    expect(out.daysRemaining).toBe(0);
    expect(out.status).toBe('due_soon');
  });

  it('is unknown with nothing on file', () => {
    expect(annualInspectionStatus({ ...base, lastDoneAt: null, today: '2026-09-17' }).status).toBe(
      'unknown',
    );
  });
});

describe('PM inspection', () => {
  const base = {
    today: '2026-09-17',
    intervalMiles: D.pmIntervalMiles,
    intervalDays: D.pmIntervalDays,
    dueSoonMiles: D.pmDueSoonMiles,
    dueSoonDays: D.pmDueSoonDays,
  };

  it('takes whichever of miles and days comes first', () => {
    // Plenty of miles left, but the 90 days ran out yesterday.
    const out = pmInspectionStatus({
      ...base,
      odometer: 300_000,
      lastOdometer: 295_000,
      lastDoneAt: '2026-06-18',
    });
    expect(out.milesRemaining).toBe(20_000);
    expect(out.daysRemaining).toBe(-1);
    expect(out.status).toBe('overdue');
  });

  it('is overdue on miles even when the date is comfortable', () => {
    const out = pmInspectionStatus({
      ...base,
      odometer: 321_000,
      lastOdometer: 295_000,
      lastDoneAt: '2026-09-10',
    });
    expect(out.milesRemaining).toBe(-1_000);
    expect(out.status).toBe('overdue');
  });

  /**
   * A trailer carries no odometer. Days are not a fallback here, they are the whole answer, and
   * inventing miles for it would put a trailer into a mileage ranking it cannot belong to.
   */
  it('judges a trailer on days alone', () => {
    const out = pmInspectionStatus({
      ...base,
      odometer: null,
      lastOdometer: null,
      lastDoneAt: '2026-07-01',
    });
    expect(out.milesRemaining).toBeNull();
    expect(out.dueOdometer).toBeNull();
    expect(out.dueDate).toBe('2026-09-29');
    expect(out.daysRemaining).toBe(12);
    expect(out.status).toBe('due_soon');
  });

  it('is on schedule when both clocks have room', () => {
    const out = pmInspectionStatus({
      ...base,
      odometer: 300_000,
      lastOdometer: 295_000,
      lastDoneAt: '2026-09-01',
    });
    expect(out.status).toBe('ok');
  });

  it('is unknown with no baseline of either kind', () => {
    const out = pmInspectionStatus({
      ...base,
      odometer: null,
      lastOdometer: null,
      lastDoneAt: null,
    });
    expect(out.status).toBe('unknown');
  });
});

describe('downtime', () => {
  const shopIn = '2026-09-15T08:00:00Z';

  it('counts to now while the unit is in the shop', () => {
    const now = Date.parse('2026-09-17T13:00:00Z');
    expect(downtimeMinutes(shopIn, null, now)).toBe(2 * 24 * 60 + 5 * 60);
  });

  it('freezes at completion, so a closed record never moves', () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    expect(downtimeMinutes(shopIn, '2026-09-16T08:00:00Z', now)).toBe(24 * 60);
  });

  it('never goes negative when the dates disagree', () => {
    expect(downtimeMinutes(shopIn, '2026-09-14T08:00:00Z', Date.now())).toBe(0);
  });

  it('reads the way a shop floor says it', () => {
    expect(formatDowntime(45)).toBe('45m');
    expect(formatDowntime(5 * 60)).toBe('5h');
    expect(formatDowntime(2 * 24 * 60 + 5 * 60)).toBe('2d 5h');
  });

  it('counts whole days by calendar date', () => {
    expect(daysBetweenDates('2026-09-17', '2026-09-29')).toBe(12);
    expect(daysBetweenDates('2026-09-29', '2026-09-17')).toBe(-12);
  });
});

describe('what blocks a save', () => {
  const valid = {
    assetType: 'truck' as const,
    unitId: 'trk_1',
    status: 'in_shop' as const,
    workType: 'oil_change' as const,
  };

  it('accepts a record left in the shop with nothing written yet', () => {
    expect(CreateWorkOrderSchema.safeParse(valid).success).toBe(true);
  });

  /** Completed means somebody can be asked what was done. An empty one cannot be audited. */
  it('refuses a completed record with no description of the work', () => {
    // Everything else a completed repair needs is present, so the only thing missing is the work.
    const out = CreateWorkOrderSchema.safeParse({
      ...valid,
      status: 'completed',
      vendorName: 'Roadside Diesel',
      completedAt: '2026-09-17T12:00:00.000Z',
      invoiceTotal: 480,
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(
        out.error.issues.some(
          (issue) => issue.path[0] === 'workDone' || issue.path[0] === 'lines',
        ),
      ).toBe(true);
    }
  });

  it('accepts a completed record that says what was done', () => {
    expect(
      CreateWorkOrderSchema.safeParse({
        ...valid,
        status: 'completed',
        vendorName: 'Roadside Diesel',
        completedAt: '2026-09-17T12:00:00.000Z',
        invoiceTotal: 480,
        workDone: 'Oil, filters, grease',
      }).success,
    ).toBe(true);
  });

  it('refuses completing with whitespace for a description', () => {
    expect(CompleteWorkOrderSchema.safeParse({ workDone: '   ' }).success).toBe(false);
    expect(CompleteWorkOrderSchema.safeParse({ workDone: 'Radiator replaced' }).success).toBe(true);
  });

  it('needs a unit', () => {
    expect(CreateWorkOrderSchema.safeParse({ ...valid, unitId: '' }).success).toBe(false);
  });
});

describe('the label nobody types', () => {
  it('is built from the unit and the work type', () => {
    expect(workOrderLabel('3008', 'oil_change')).toBe('Unit 3008 · Oil change');
    expect(workOrderLabel('T-5301', 'annual_inspection')).toBe(
      'Unit T-5301 · Annual DOT inspection',
    );
  });
});
