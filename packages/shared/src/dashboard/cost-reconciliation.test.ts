import { describe, expect, it } from 'vitest';
import {
  costMix,
  dateBasisNote,
  driverPayKey,
  expenseKey,
  factoringKey,
  obligationKey,
  settledObligations,
  staffPayrollKey,
  withoutSettled,
} from './cost-reconciliation';

/** A driver's unsettled pay for the week: what the company owes but has not posted. */
const estimate = (driverId: string, amount: number, periodEnd = '2026-09-27') => ({
  id: `est_${driverId}`,
  driverId,
  amount,
  isEstimate: true,
  source: 'settlement',
  obligationKey: driverPayKey(driverId, periodEnd),
});

/** The posted form of that obligation. */
const posted = (driverId: string, amount: number, periodEnd = '2026-09-27', date = '2026-09-26') => ({
  id: `jrn_${driverId}_${date}`,
  driverId,
  amount,
  date,
  isEstimate: false,
  source: 'ledger',
  obligationKey: driverPayKey(driverId, periodEnd),
});

const total = (lines: ReadonlyArray<{ amount: number }>) => lines.reduce((sum, l) => sum + l.amount, 0);

describe('posted costs against the estimates they replace', () => {
  // Ten drivers in one period is the case that broke: posting one settlement used to suppress the
  // whole driver-pay category, so nine drivers' pay vanished from the projection.
  const drivers = Array.from({ length: 10 }, (_, i) => `drv_${String(i + 1).padStart(2, '0')}`);
  const estimates = drivers.map((id, i) => estimate(id, 1000 + i * 100));
  const owedInFull = total(estimates); // 1000..1900 = 14,500

  it('replaces only the driver whose settlement was posted, and leaves the other nine owing', () => {
    const postings = [posted('drv_01', 1000)];
    const settled = settledObligations(postings);

    expect(settled.size).toBe(1);
    const remaining = withoutSettled(estimates, settled);
    expect(remaining).toHaveLength(9);
    expect(remaining.map((l) => l.driverId)).not.toContain('drv_01');
    // Every other driver is still owed, to the cent.
    expect(total(remaining)).toBe(owedInFull - 1000);
    // And the period's cost is the posting plus what is still owed: the obligation is counted once.
    expect(total(postings) + total(remaining)).toBe(owedInFull);
  });

  it('replaces each estimate individually as the rest are posted, never missing or doubling one', () => {
    const postings: ReturnType<typeof posted>[] = [];
    for (const [i, id] of drivers.entries()) {
      postings.push(posted(id, 1000 + i * 100));
      const settled = settledObligations(postings);
      const remaining = withoutSettled(estimates, settled);

      expect(remaining).toHaveLength(drivers.length - (i + 1));
      // The invariant that matters: posted + still owed is the same total at every step.
      expect(total(postings) + total(remaining)).toBe(owedInFull);
    }
    expect(withoutSettled(estimates, settledObligations(postings))).toHaveLength(0);
    expect(total(postings)).toBe(owedInFull);
  });

  it('counts a posted amount that differs from the estimate as the posted amount, not both', () => {
    // The settlement came out $120 higher than the projection; the books win.
    const postings = [posted('drv_03', 1320)];
    const remaining = withoutSettled(estimates, settledObligations(postings));
    expect(remaining.some((l) => l.driverId === 'drv_03')).toBe(false);
    expect(total(postings) + total(remaining)).toBe(owedInFull - 1200 + 1320);
  });

  it('keeps an obligation settled when a correcting entry is posted against it', () => {
    const postings = [posted('drv_04', 1300), { ...posted('drv_04', 45, '2026-09-27', '2026-09-28'), id: 'jrn_adj' }];
    const settled = settledObligations(postings);
    expect(settled.has(driverPayKey('drv_04', '2026-09-27')!)).toBe(true);
    expect(withoutSettled(estimates, settled).some((l) => l.driverId === 'drv_04')).toBe(false);
  });

  it('brings the estimate back when the posting is reversed, because the company owes it again', () => {
    const original = posted('drv_05', 1400);
    const reversal = { ...posted('drv_05', -1400, '2026-09-27', '2026-09-29'), id: 'jrn_reversal' };

    expect(settledObligations([original]).size).toBe(1);
    const afterReversal = settledObligations([original, reversal]);
    expect(afterReversal.size).toBe(0);

    const remaining = withoutSettled(estimates, afterReversal);
    expect(remaining).toHaveLength(10);
    expect(remaining.some((l) => l.driverId === 'drv_05')).toBe(true);
    // The two postings net to nothing, so the period still carries exactly what is owed.
    expect(total([original, reversal]) + total(remaining)).toBe(owedInFull);
  });

  it('drops the estimate when its settlement is posted in a later period, and only there', () => {
    // The week's work is settled the following Friday: the posting is dated outside the period
    // the estimate belongs to. Deciding by the key rather than the date is what stops the estimate
    // in September and the posting in October from being read as two costs.
    const latePosting = posted('drv_06', 1500, '2026-09-27', '2026-10-02');
    const settled = settledObligations([latePosting]);

    const septemberRemaining = withoutSettled(estimates, settled);
    expect(septemberRemaining.some((l) => l.driverId === 'drv_06')).toBe(false);
    expect(septemberRemaining).toHaveLength(9);

    // Across both periods the cost appears once, on the day it was posted.
    expect(total([latePosting]) + total(septemberRemaining)).toBe(owedInFull);
    expect(latePosting.date).toBe('2026-10-02');
  });

  it('never lets one kind of obligation settle another', () => {
    const keys = [
      driverPayKey('drv_01', '2026-09-27'),
      staffPayrollKey('drv_01'),
      expenseKey('drv_01'),
      factoringKey('drv_01'),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it('keeps a cost that carries no key, because nothing can be matched to it', () => {
    const unkeyed = { id: 'ro_77', amount: 500, isEstimate: false, source: 'maintenance', obligationKey: null };
    const settled = settledObligations([posted('drv_01', 1000)]);
    expect(withoutSettled([...estimates, unkeyed], settled)).toContainEqual(unkeyed);
  });

  it('refuses to build a key from a missing part rather than inventing one', () => {
    expect(driverPayKey(null, '2026-09-27')).toBeNull();
    expect(driverPayKey('drv_01', undefined)).toBeNull();
    expect(driverPayKey('drv_01', '  ')).toBeNull();
    expect(obligationKey('expense', 'work_order:wo_1')).toBe('expense:work_order:wo_1');
  });
});

describe('what a period cost is made of', () => {
  it('separates the books from the projection, and names what belongs to no unit', () => {
    const mix = costMix([
      { amount: 1260, isEstimate: false, source: 'ledger', truckId: 'trk_1', driverId: 'drv_1', loadNumber: 'L-1' },
      { amount: 210, isEstimate: false, source: 'ledger', truckId: null, driverId: null, loadNumber: null },
      { amount: 31.5, isEstimate: false, source: 'ledger', truckId: null, driverId: null, loadNumber: 'L-1' },
      { amount: 900, isEstimate: true, source: 'settlement', truckId: 'trk_2', driverId: 'drv_2', loadNumber: null },
    ]);
    expect(mix.postedCents).toBe(150_150);
    expect(mix.estimatedCents).toBe(90_000);
    // Only the staff payroll line names nothing; the factoring fee still names its load.
    expect(mix.unallocatedPostedCents).toBe(21_000);
    expect(mix.hasEstimates).toBe(true);
  });

  it('reports no projection when every cost is posted', () => {
    const mix = costMix([{ amount: 100, isEstimate: false, source: 'ledger', truckId: 'trk_1' }]);
    expect(mix.hasEstimates).toBe(false);
    expect(mix.estimatedCents).toBe(0);
  });

  it('explains the date basis, and says more when a projection is on screen', () => {
    const posted = costMix([{ amount: 10, isEstimate: false, source: 'ledger', truckId: 't' }]);
    const mixed = costMix([{ amount: 10, isEstimate: true, source: 'settlement', truckId: 't' }]);
    expect(dateBasisNote(posted)).toContain('the day the load was delivered');
    expect(dateBasisNote(posted)).not.toContain('projection');
    expect(dateBasisNote(mixed)).toContain('projection');
  });
});
