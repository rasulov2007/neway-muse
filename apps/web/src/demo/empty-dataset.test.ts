import { describe, expect, it } from 'vitest';
import { emptyDataset, generateDemoData } from './data';

/**
 * The workspace a production build starts from holds nothing.
 *
 * The check is against the generated dataset's own shape, so a collection added to `DemoData`
 * later cannot quietly ship a production build with demo rows in it: the moment it exists, this
 * test asks the empty dataset for it and expects zero.
 */
describe('emptyDataset', () => {
  it('has every collection of the generated dataset, each at zero', () => {
    const generated = generateDemoData();
    const empty = emptyDataset();

    expect(Object.keys(empty).sort()).toEqual(Object.keys(generated).sort());
    for (const [key, value] of Object.entries(generated)) {
      // The walk-around catalog is configuration with defaults, not records.
      if (
        Array.isArray(value) &&
        key !== 'users' &&
        key !== 'memberships' &&
        key !== 'ptiComponents'
      ) {
        expect(empty[key as keyof typeof empty], key).toEqual([]);
      }
    }
  });

  it('reports zero on every KPI and an empty series', () => {
    const empty = emptyDataset();
    for (const [key, value] of Object.entries(empty.kpis)) {
      if (key === 'asOf') continue;
      expect(value, key).toEqual({ value: 0, previous: 0, deltaPercent: 0 });
    }
    expect(empty.series).toEqual({
      dailyRevenueProfit: [],
      weeklyFuelCost: [],
      fleetHealth: [],
      loadStatus: [],
    });
  });
});
