import { describe, expect, it } from 'vitest';
import { REPORTS, availableReports, reportByKey } from './catalog.js';
import { METRICS, compareMetricPeriods, describeChange } from './metrics.js';

describe('the report catalogue', () => {
  it('gives every report a permission, so nothing is ungated by omission', () => {
    for (const report of REPORTS) {
      expect(report.permission, report.key).toMatch(/^reports\./);
    }
  });

  it('has unique keys', () => {
    const keys = REPORTS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('explains why an unavailable report cannot run instead of just hiding it', () => {
    const unavailable = REPORTS.filter((r) => r.unavailable);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const report of unavailable) {
      // The reason has to name the missing data, not say "coming soon".
      expect(report.unavailable, report.key).toMatch(/not in|carry no|are generated|cannot/i);
    }
  });

  it('keeps unavailable reports out of the runnable set', () => {
    expect(availableReports().every((r) => !r.unavailable)).toBe(true);
    expect(reportByKey('customer_performance')?.unavailable).toBeTruthy();
  });

  it('only totals columns that can be summed', () => {
    for (const report of REPORTS) {
      for (const column of report.columns) {
        // A rate is derived from the totals; summing RPM across rows is meaningless.
        if (['rpm', 'cpm', 'ppm', 'marginPct', 'perMile', 'emptyPct'].includes(column.key)) {
          expect(column.total, `${report.key}.${column.key}`).not.toBe('sum');
        }
      }
    }
  });

  it('offers a grouping only when the report declares it', () => {
    for (const report of REPORTS) {
      if (report.defaultGrouping) {
        expect(report.groupings, report.key).toContain(report.defaultGrouping);
      }
    }
  });
});

describe('metric comparison', () => {
  it('states a margin move in points, never as a percentage', () => {
    const margin = compareMetricPeriods('marginPct', 12, 10);
    expect(margin.change).toBe(2);
    // 10% → 12% is two points. Calling it "+20%" overstates it by an order of magnitude.
    expect(margin.changePct).toBeNull();
    expect(describeChange(margin)).toBe('+2.0 pts');
  });

  it('refuses a percentage change from a previous period of zero', () => {
    const gross = compareMetricPeriods('gross', 50_000, 0);
    expect(gross.changePct).toBeNull();
    expect(describeChange(gross)).toBe('No activity in the previous period');
  });

  it('says nothing at all when a figure is unavailable', () => {
    const cost = compareMetricPeriods('cost', null, 1_000);
    expect(cost.verdict).toBe('unknown');
    expect(describeChange(cost)).toBe('No comparable figure for the previous period');
  });

  it('knows that rising cost is worse and rising revenue is better', () => {
    expect(compareMetricPeriods('cost', 120, 100).verdict).toBe('worse');
    expect(compareMetricPeriods('gross', 120, 100).verdict).toBe('better');
    expect(compareMetricPeriods('cpm', 1.8, 2.0).verdict).toBe('better');
  });

  it('treats miles as neither good nor bad on their own', () => {
    expect(compareMetricPeriods('miles', 12_000, 10_000).verdict).toBe('flat');
  });

  it('defines every metric it names', () => {
    for (const [key, definition] of Object.entries(METRICS)) {
      expect(definition.key).toBe(key);
      expect(definition.formula.length).toBeGreaterThan(10);
    }
  });
});
