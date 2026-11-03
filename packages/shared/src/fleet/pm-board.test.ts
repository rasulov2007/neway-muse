import { describe, expect, it } from 'vitest';
import {
  CompletePmSchema,
  SchedulePmSchema,
  completionOnTime,
  completionPreview,
  nextStepFor,
  nextStepLabel,
  odometerCheck,
  sortBoardRows,
} from './pm-board.js';

const now = '2026-09-17T13:00:00.000Z';

describe('nextStepFor - one next step per row (mockup A, note 7)', () => {
  it('asks for an interval before anything else', () => {
    expect(
      nextStepFor({ dueStatus: 'no_interval', pmResponsibility: 'us', appointment: null, now }),
    ).toBe('set_interval');
  });
  it('asks for a reading when the row cannot tell', () => {
    expect(
      nextStepFor({ dueStatus: 'no_reading', pmResponsibility: 'us', appointment: null, now }),
    ).toBe('get_reading');
  });
  it('asks for the last oil change when there is a reading but no service on record', () => {
    expect(
      nextStepFor({ dueStatus: 'no_baseline', pmResponsibility: 'us', appointment: null, now }),
    ).toBe('record_completion');
  });
  it('sends a lease unit to its lessor instead of a shop', () => {
    expect(
      nextStepFor({ dueStatus: 'overdue', pmResponsibility: 'lessor', appointment: null, now }),
    ).toBe('send_to_lessor');
    expect(nextStepLabel('send_to_lessor', 'Ryder')).toBe('Send to Ryder');
  });
  it('records the completion once the truck is in the shop or the slot is due', () => {
    expect(
      nextStepFor({
        dueStatus: 'overdue',
        pmResponsibility: 'us',
        appointment: { scheduledFor: '2026-09-17T08:00:00.000Z', inShop: false },
        now,
      }),
    ).toBe('record_completion');
    expect(
      nextStepFor({
        dueStatus: 'overdue',
        pmResponsibility: 'us',
        appointment: { scheduledFor: '2026-09-19T08:00:00.000Z', inShop: true },
        now,
      }),
    ).toBe('record_completion');
  });
  it('opens a future appointment and schedules when there is none', () => {
    expect(
      nextStepFor({
        dueStatus: 'overdue',
        pmResponsibility: 'us',
        appointment: { scheduledFor: '2026-09-19T08:00:00.000Z', inShop: false },
        now,
      }),
    ).toBe('open');
    expect(
      nextStepFor({ dueStatus: 'overdue', pmResponsibility: 'us', appointment: null, now }),
    ).toBe('schedule');
    expect(nextStepFor({ dueStatus: 'ok', pmResponsibility: 'us', appointment: null, now })).toBe(
      'schedule',
    );
  });
});

describe('sortBoardRows - urgent first, with the size of the problem', () => {
  const row = (
    unitNumber: string,
    dueStatus: 'overdue' | 'overdue_at_least' | 'due_soon' | 'ok' | 'no_reading',
    extra: Partial<{
      milesRemaining: number | null;
      milesOverAtReading: number | null;
      estimatedDueDate: string | null;
      appointment: { scheduledFor: string } | null;
    }> = {},
  ) => ({
    unitNumber,
    dueStatus,
    milesRemaining: null,
    milesOverAtReading: null,
    estimatedDueDate: null,
    appointment: null,
    ...extra,
  });

  it('puts the most miles over at the top, then the honest "at least"s, then due soon by date', () => {
    const sorted = sortBoardRows([
      row('0012', 'ok', { milesRemaining: 27_940 }),
      row('0058', 'due_soon', { milesRemaining: 1_320, estimatedDueDate: '2026-09-26' }),
      row('0017', 'overdue', { milesRemaining: -4_643 }),
      row('0052', 'overdue_at_least', { milesOverAtReading: 3_989 }),
      row('0031', 'due_soon', { milesRemaining: 940, estimatedDueDate: '2026-09-20' }),
      row('0026', 'overdue', { milesRemaining: -5_221 }),
      row('9003', 'no_reading'),
    ] as never[]);
    expect(sorted.map((r) => (r as { unitNumber: string }).unitNumber)).toEqual([
      '0026',
      '0017',
      '0052',
      '0031',
      '0058',
      '9003',
      '0012',
    ]);
  });

  it('breaks ties on the unit number so the order is stable', () => {
    const sorted = sortBoardRows([
      row('B', 'overdue', { milesRemaining: -100 }),
      row('A', 'overdue', { milesRemaining: -100 }),
    ] as never[]);
    expect(sorted.map((r) => (r as { unitNumber: string }).unitNumber)).toEqual(['A', 'B']);
  });
});

describe('odometerCheck - the invoice reading against the ELD (§6.2)', () => {
  it('trusts a reading within the tolerance', () => {
    expect(odometerCheck({ serviceOdometer: 142_020, eldOdometer: 142_018, eldAt: now })).toEqual({
      verdict: 'trusted',
      gapMiles: 2,
    });
  });
  it('asks for a reason beyond it', () => {
    expect(
      odometerCheck({ serviceOdometer: 142_020, eldOdometer: 141_500, eldAt: now }).verdict,
    ).toBe('needs_reason');
  });
  it('stands alone when there is no ELD reading', () => {
    expect(odometerCheck({ serviceOdometer: 142_020, eldOdometer: null, eldAt: null })).toEqual({
      verdict: 'no_eld',
      gapMiles: null,
    });
  });
});

describe('completionPreview - what the save will do (mockup C)', () => {
  it('adds the interval, estimates the date and notices an interval that ran over', () => {
    const p = completionPreview({
      serviceOdometer: 142_020,
      intervalMiles: 35_000,
      previousServiceOdometer: 105_368,
      avgMilesPerDay: 355,
      serviceAt: '2026-09-17T14:40:00.000Z',
    });
    expect(p.nextServiceOdometer).toBe(177_020);
    expect(p.milesRun).toBe(36_652);
    expect(p.ranOverBy).toBe(1_652);
    expect(p.estimatedNextDate).toBe('2026-12-25');
  });
  it('has no date without a daily average and no run without a previous service', () => {
    const p = completionPreview({
      serviceOdometer: 142_020,
      intervalMiles: 35_000,
      previousServiceOdometer: null,
      avgMilesPerDay: null,
      serviceAt: now,
    });
    expect(p.estimatedNextDate).toBeNull();
    expect(p.milesRun).toBeNull();
    expect(p.ranOverBy).toBeNull();
  });
});

describe('completionOnTime - the strip\'s "on time · 90 days"', () => {
  it('is on time inside the interval and not beyond it', () => {
    expect(
      completionOnTime({
        previousOdometer: 100_000,
        serviceOdometer: 129_000,
        intervalMiles: 30_000,
      }),
    ).toBe(true);
    expect(
      completionOnTime({
        previousOdometer: 100_000,
        serviceOdometer: 131_000,
        intervalMiles: 30_000,
      }),
    ).toBe(false);
    expect(
      completionOnTime({ previousOdometer: null, serviceOdometer: 131_000, intervalMiles: 30_000 }),
    ).toBeNull();
  });
});

describe('the two inputs', () => {
  it('a completion needs the oil and filter line and a reason for a $0 invoice', () => {
    const base = {
      unitId: 'trk_1',
      serviceAt: now,
      serviceOdometer: 142_020,
      vendorId: 'ven_1',
      invoiceTotal: 550,
    };
    expect(CompletePmSchema.safeParse({ ...base, work: ['oil_filter'] }).success).toBe(true);
    expect(CompletePmSchema.safeParse({ ...base, work: ['grease'] }).success).toBe(false);
    expect(
      CompletePmSchema.safeParse({ ...base, work: ['oil_filter'], invoiceTotal: 0 }).success,
    ).toBe(false);
    expect(
      CompletePmSchema.safeParse({
        ...base,
        work: ['oil_filter'],
        invoiceTotal: 0,
        zeroReason: 'lease',
      }).success,
    ).toBe(true);
  });
  it('an appointment defaults to a two-hour hold with both notifications', () => {
    const parsed = SchedulePmSchema.parse({
      unitId: 'trk_1',
      vendorId: 'ven_1',
      scheduledFor: now,
      responsibleUserId: 'usr_1',
    });
    expect(parsed.holdMinutes).toBe(120);
    expect(parsed.notifyDriver).toBe(true);
    expect(parsed.notifyDispatcher).toBe(true);
    expect(parsed.moveExisting).toBe(false);
    expect(parsed.serviceCode).toBe('OIL_CHANGE');
  });
});
