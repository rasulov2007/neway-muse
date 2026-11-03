import { describe, expect, it } from 'vitest';
import type { PmBoardRow, PmBoardSummary } from '@neway/shared';
import {
  dueText,
  intervalPct,
  milesAtLastReading,
  kpiCells,
  matchesFilters,
  matchesSearch,
  rowFamily,
  viewCounts,
  EMPTY_FILTERS,
} from './board-model';

function row(over: Partial<PmBoardRow>): PmBoardRow {
  return {
    unitId: 'trk_1',
    unitNumber: '0074',
    unitStatus: 'active',
    groupName: 'NWF',
    pmResponsibility: 'us',
    lessorName: null,
    serviceCode: 'OIL_CHANGE',
    lastServiceId: null,
    lastServiceAt: null,
    lastServiceOdometer: null,
    lastServiceSource: null,
    intervalMiles: 35_000,
    intervalDays: null,
    intervalHours: null,
    planOrigin: 'unit',
    planId: null,
    dueSoonMiles: 3_500,
    dueSoonDays: 14,
    nextServiceOdometer: 140_368,
    nextServiceDate: null,
    milesSinceService: 36_652,
    milesRemaining: -1_652,
    daysSinceService: 87,
    daysRemaining: null,
    avgMilesPerDay: 355,
    avgBasis: '30d',
    estimatedDueDate: null,
    dueStatus: 'overdue',
    dueBasis: 'miles',
    milesOverAtReading: null,
    readingId: 'odo_1',
    readingAt: '2026-09-17T12:25:00.000Z',
    readingOdometer: 142_020,
    readingSource: 'eld',
    readingAgeHours: 0.3,
    readingStale: false,
    readingAgeUnknown: false,
    computedAt: '2026-09-17T12:45:00.000Z',
    driverName: 'Wesley Rogers',
    location: { city: 'Grand Prairie', state: 'TX', updatedAt: '2026-09-17T12:40:00.000Z' },
    nextStop: null,
    route: [],
    appointment: null,
    lastService: null,
    alsoDue: [],
    nextStep: 'schedule',
    pctOver: 4.7,
    ...over,
  } as PmBoardRow;
}

describe('the "Oil change due" cell', () => {
  it('says how far over, honestly "at least" on a stale reading, and "can\'t tell" without one', () => {
    expect(dueText(row({}))).toBe('1,652 mi over');
    expect(dueText(row({ dueStatus: 'overdue_at_least', milesOverAtReading: 3_989 }))).toBe(
      '≥ 3,989 mi over',
    );
    expect(dueText(row({ dueStatus: 'due_soon', milesRemaining: 940 }))).toBe('940 mi left');
    expect(dueText(row({ dueStatus: 'no_reading' }))).toBe("can't tell");
  });
  it('fills the interval bar to the share used, capped at full', () => {
    expect(intervalPct(row({}))).toBe(100);
    expect(
      intervalPct(row({ dueStatus: 'due_soon', milesSinceService: 29_060, intervalMiles: 30_000 })),
    ).toBe(97);
    expect(intervalPct(row({ dueStatus: 'no_reading' }))).toBe(0);
  });
  it('gives a stale truck its miles as of the last reading, never a negative', () => {
    const stale = { dueStatus: 'no_reading' as const, readingOdometer: 550_697, lastServiceOdometer: 526_394 };
    expect(milesAtLastReading(stale)).toBe(24_303);
    expect(milesAtLastReading({ ...stale, readingOdometer: 1_682 })).toBeNull();
    expect(milesAtLastReading({ ...stale, dueStatus: 'ok' })).toBeNull();
  });
  it('maps each verdict to a status family: symbol + word, never colour alone', () => {
    expect(rowFamily(row({}))).toBe('urgent');
    expect(rowFamily(row({ dueStatus: 'due_soon' }))).toBe('warning');
    expect(rowFamily(row({ dueStatus: 'ok' }))).toBe('done');
    expect(rowFamily(row({ dueStatus: 'no_reading' }))).toBe('neutral');
  });
});

describe('the segments and the search', () => {
  const rows = [
    row({ unitId: 'a', unitNumber: '0026' }),
    row({
      unitId: 'b',
      unitNumber: '0042',
      appointment: {
        workOrderId: 'wo',
        workOrderNumber: 'RO-1',
        scheduledFor: '2026-09-18T12:00:00.000Z',
        vendorId: 'v1',
        vendorName: 'Speedco Capac',
        responsibleUserId: 'u1',
        responsibleName: 'Sarah Chen',
        noteForShop: null,
        holdMinutes: 120,
        inShop: false,
      },
    }),
    row({ unitId: 'c', unitNumber: '0031', dueStatus: 'due_soon', milesRemaining: 940 }),
    row({ unitId: 'd', unitNumber: '9003', dueStatus: 'no_reading', groupName: 'Ryder' }),
  ];
  it('counts are counts of the rows each segment shows', () => {
    expect(viewCounts(rows)).toEqual({ all: 4, overdue: 2, due_soon: 1, booked: 1, no_reading: 1 });
    expect(
      rows
        .filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, view: 'booked' }))
        .map((r) => r.unitNumber),
    ).toEqual(['0042']);
    expect(
      rows
        .filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, group: 'Ryder' }))
        .map((r) => r.unitNumber),
    ).toEqual(['9003']);
    expect(
      rows
        .filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, responsible: 'u1' }))
        .map((r) => r.unitNumber),
    ).toEqual(['0042']);
  });
  it('searches unit, driver, shop and city', () => {
    expect(rows.filter((r) => matchesSearch(r, 'speedco')).map((r) => r.unitNumber)).toEqual([
      '0042',
    ]);
    expect(rows.filter((r) => matchesSearch(r, '9003')).map((r) => r.unitNumber)).toEqual(['9003']);
    expect(rows.filter((r) => matchesSearch(r, 'wesley')).length).toBe(4);
    expect(rows.filter((r) => matchesSearch(r, 'grand prairie')).length).toBe(4);
  });
});

describe('the six numbers', () => {
  const summary: PmBoardSummary = {
    total: 98,
    overdue: 18,
    overdueWorstMiles: 5_221,
    overdueTotalMiles: 67_771,
    dueSoon: 9,
    dueSoonThisWeek: 4,
    booked: 7,
    bookedToday: 3,
    bookedAtOwnYard: 2,
    bookedOverdue: 4,
    noReading: 6,
    noReadingStale: 4,
    noReadingNever: 2,
    leaseDue: 2,
    leaseNames: ['Ryder', 'M&K'],
    onTime: { done: 59, onTime: 34 },
    avgCost: 512,
    ownYardAvgCost: 461,
    computedAt: '2026-09-17T12:45:00.000Z',
  };
  it('words them as the mockup does, and drops money for a role without the permission', () => {
    const cells = kpiCells(summary, true);
    expect(cells.overdue.note).toBe('worst 5,221 mi · 67,771 mi past due in total');
    expect(cells.dueSoon.note).toBe('≤ 2,500 mi or 14 days · 4 this week');
    expect(cells.booked.note).toBe('3 today · 2 at our yard · 4 overdue anyway');
    expect(cells.noReading.note).toBe('4 stale over 7 d · 2 never reported');
    expect(cells.lease.note).toBe('Ryder, M&K · PM covered, no shop cost');
    expect(cells.onTime.value).toBe('58%');
    expect(cells.onTime.small).toBe('34 of 59');
    expect(cells.onTime.note).toBe('avg $512 per oil change · $461 at our own yard');
    expect(kpiCells(summary, false).onTime.note).toBe('completed inside the interval');
  });
});
