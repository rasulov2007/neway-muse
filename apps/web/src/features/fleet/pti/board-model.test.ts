import { describe, expect, it } from 'vitest';
import { queuesFor } from '@neway/shared';
import { briefRows, defect, inspection, row } from './board-fixtures';
import { EMPTY_FILTERS, matchesFilters, matchesSearch, nextAction, rowAction, sortRows, stripe, triageGroup } from './board-model';

describe('the board reads a row (§7)', () => {
  it('sorts a 5-day-old oos_risk defect above a clean inspection received yesterday', () => {
    const sorted = sortRows(briefRows()).map((r) => r.inspection.unitNumber);
    expect(sorted.indexOf('2718')).toBeLessThan(sorted.indexOf('2701'));
    // Risk first, then what needs a person, clean last.
    expect(sorted[0]).toBe('2718');
    expect(sorted.at(-1)).toBe('2740');
    expect(sorted.indexOf('0069')).toBeLessThan(sorted.indexOf('2785'));
  });

  it('puts each row in the first group that claims it', () => {
    const groups = Object.fromEntries(briefRows().map((r) => [r.inspection.unitNumber, triageGroup(r)]));
    expect(groups).toEqual({ '2785': 'missing', '2718': 'oos', '2701': 'clean', '0069': 'verify', '2760': 'review', '2740': 'clean' });
  });

  it('stripes by the worst open defect, blue where a person is needed, none when clean', () => {
    const rows = Object.fromEntries(briefRows().map((r) => [r.inspection.unitNumber, stripe(r)]));
    expect(rows['2718']).toBe('red');
    expect(rows['2785']).toBe('blue');
    expect(rows['2760']).toBe('blue');
    expect(rows['0069']).toBe('blue');
    expect(rows['2701']).toBeNull();
    const soon = row(inspection({ unitNumber: '9', receiptStatus: 'received', receivedAt: '2026-09-15T00:00:00.000Z', reviewState: 'reviewed', reviewResult: 'issues_found' }), [
      defect({ id: 'x', defectNumber: 'DEF-9', unitNumber: '9', severity: 'replace_soon', ownerId: 'u', ownerName: 'U' }),
    ]);
    expect(stripe(soon)).toBe('amber');
  });

  it('names one action per row, for the job that is due', () => {
    const actions = Object.fromEntries(briefRows().map((r) => [r.inspection.unitNumber, rowAction(r).label]));
    expect(actions['2785']).toBe('Chase driver');
    expect(actions['2760']).toBe('Review ▸');
    expect(actions['2718']).toBe('Assign owner');
    expect(actions['0069']).toBe('Verify & clear');
    expect(actions['2701']).toBe('Open unit');
    const linked = row(inspection({ unitNumber: '5', receiptStatus: 'received', receivedAt: '2026-09-15T00:00:00.000Z', reviewState: 'reviewed', reviewResult: 'issues_found' }), [
      defect({ id: 'y', defectNumber: 'DEF-5', unitNumber: '5', state: 'in_repair', ownerId: 'u', ownerName: 'U', workOrderId: 'ro_2031', workOrderNumber: 'RO-2031' }),
    ]);
    expect(rowAction(linked)).toMatchObject({ kind: 'open_ro', label: 'Open RO-2031' });
  });

  it('says Nobody / No action recorded in the next-action column rather than hiding it in a count', () => {
    const next = Object.fromEntries(briefRows().map((r) => [r.inspection.unitNumber, nextAction(r)]));
    expect(next['2718']).toMatchObject({ ownerName: null, what: 'No action recorded', unowned: true });
    expect(next['0069']).toMatchObject({ ownerName: 'Tom Brennan', what: 'Verify DEF-0069', unowned: false });
    expect(next['2785']).toMatchObject({ ownerName: 'Elena Vasquez', what: 'Chase the driver for the video' });
    expect(next['2701']).toBeNull();
  });

  it('a queue filter shows exactly the rows its tile counted', () => {
    const rows = briefRows();
    for (const queue of ['chase', 'review', 'defects', 'verify'] as const) {
      const counted = rows.filter((r) => queuesFor(r).includes(queue)).length;
      const shown = rows.filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, queue })).length;
      expect(shown, queue).toBe(counted);
    }
  });

  it('filters by severity, component, dispatcher, owner and age; search covers defect text and RO number', () => {
    const rows = briefRows();
    expect(rows.filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, severity: 'oos_risk' })).map((r) => r.inspection.unitNumber)).toEqual(['2718']);
    expect(rows.filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, component: 'brakes' })).length).toBe(2);
    expect(rows.filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, owner: 'nobody' })).map((r) => r.inspection.unitNumber)).toEqual(['2718']);
    expect(rows.filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, owner: 'usr_tom' })).map((r) => r.inspection.unitNumber)).toEqual(['0069']);
    expect(rows.filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, age: '5' })).map((r) => r.inspection.unitNumber)).toEqual(['0069']);
    expect(rows.filter((r) => matchesFilters(r, { ...EMPTY_FILTERS, dispatcher: 'usr_elena' })).length).toBe(rows.length);
    expect(rows.filter((r) => matchesSearch(r, 'ro-2031')).map((r) => r.inspection.unitNumber)).toEqual(['0069']);
    expect(rows.filter((r) => matchesSearch(r, 'slack adjuster')).map((r) => r.inspection.unitNumber).sort()).toEqual(['0069', '2718']);
    expect(rows.filter((r) => matchesSearch(r, 'Luis')).length).toBe(rows.length);
    // A bare number is a unit, never the digits of an RO or defect number (owner, 2026-10-27).
    expect(rows.filter((r) => matchesSearch(r, '2031')).map((r) => r.inspection.unitNumber)).toEqual([]);
    expect(rows.filter((r) => matchesSearch(r, '0069')).map((r) => r.inspection.unitNumber)).toEqual(['0069']);
  });
});
