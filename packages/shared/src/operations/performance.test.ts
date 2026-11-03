import { describe, expect, it } from 'vitest';
import { assessBrokerRisk, type BrokerRiskInput } from './broker-risk.js';
import { computeLoadEconomics } from './economics.js';
import {
  summarizePayment,
  summarizePerformance,
  type PerformanceLoad,
  type PerformanceStop,
} from './performance.js';

const costs = { fuel: 600, driverPay: 640, tolls: 70, maintenanceAllocation: 150, other: 60 };

function economics(revenue: number | null, loaded = 1000, empty = 50) {
  return computeLoadEconomics({ revenue, loadedMiles: loaded, emptyMiles: empty, costs });
}

function stop(overrides: Partial<PerformanceStop> = {}): PerformanceStop {
  return {
    kind: 'delivery',
    appointmentStartAt: '2026-09-07T14:00:00.000Z',
    appointmentEndAt: '2026-09-07T16:00:00.000Z',
    arrivedAt: '2026-09-07T15:00:00.000Z',
    departedAt: '2026-09-07T16:30:00.000Z',
    detentionMinutes: 0,
    ...overrides,
  };
}

function load(overrides: Partial<PerformanceLoad> = {}): PerformanceLoad {
  return {
    id: 'ld_1',
    status: 'delivered',
    economics: economics(3000),
    stops: [stop({ kind: 'pickup' }), stop()],
    ...overrides,
  };
}

describe('summarizePerformance', () => {
  it('rolls loads into one picture on total miles', () => {
    const s = summarizePerformance([load({ id: 'a' }), load({ id: 'b' })]);
    expect(s.counts.total).toBe(2);
    expect(s.counts.delivered).toBe(2);
    expect(s.revenue).toBe(6000);
    expect(s.totalMiles).toBe(2100);
    expect(s.profit).not.toBeNull();
    expect(s.marginPct).not.toBeNull();
  });

  it('excludes cancelled loads from money but counts them in the cancellation rate', () => {
    const s = summarizePerformance([
      load({ id: 'a' }),
      load({ id: 'b', status: 'cancelled', economics: economics(0, 0, 0) }),
    ]);
    expect(s.revenue).toBe(3000);
    expect(s.counts.cancelled).toBe(1);
    expect(s.cancellationRatePct).toBe(50);
  });

  it('reports how much of the set could be priced rather than hiding it', () => {
    const s = summarizePerformance([
      load({ id: 'a' }),
      load({ id: 'b', economics: economics(null) }),
    ]);
    expect(s.coverage.loads).toBe(2);
    expect(s.coverage.priced).toBe(1);
    expect(s.reasons.some((r) => r.includes('could not be priced'))).toBe(true);
  });

  it('measures on-time against the appointment window', () => {
    const late = load({
      id: 'late',
      stops: [stop({ kind: 'pickup' }), stop({ arrivedAt: '2026-09-07T17:00:00.000Z' })],
    });
    const s = summarizePerformance([load({ id: 'a' }), late]);
    expect(s.onTimeDeliveryPct).toBe(50);
    expect(s.onTimePickupPct).toBe(100);
  });

  it('returns null, not zero, when nothing can be timed', () => {
    const s = summarizePerformance([
      load({ id: 'a', stops: [stop({ arrivedAt: null, appointmentEndAt: null })] }),
    ]);
    expect(s.onTimeDeliveryPct).toBeNull();
    expect(s.reasons.some((r) => r.includes('on-time cannot be measured'))).toBe(true);
  });

  it('computes dwell only from stops that recorded both timestamps', () => {
    const s = summarizePerformance([
      load({ id: 'a', stops: [stop(), stop({ departedAt: null })] }),
    ]);
    // Only the complete stop counts: 15:00 to 16:30 is 90 minutes.
    expect(s.avgDwellMinutes).toBe(90);
  });

  it('names claims as unavailable rather than reporting zero claims', () => {
    const s = summarizePerformance([load()]);
    const claims = s.unavailable.find((u) => u.metric.includes('Claims'));
    expect(claims).toBeDefined();
    expect(claims?.requires).toContain('claims module');
  });

  it('handles an empty set without dividing by zero', () => {
    const s = summarizePerformance([]);
    expect(s.revenue).toBeNull();
    expect(s.marginPct).toBeNull();
    expect(s.cancellationRatePct).toBeNull();
    expect(s.counts.total).toBe(0);
  });
});

describe('summarizePayment', () => {
  const invoice = (o: Partial<Parameters<typeof summarizePayment>[0][number]> = {}) => ({
    status: 'paid',
    issuedOn: '2026-08-01',
    dueOn: '2026-08-31',
    paidOn: '2026-08-20',
    total: 1000,
    balance: 0,
    ...o,
  });

  it('averages days to pay across invoices that were actually paid', () => {
    const s = summarizePayment([invoice(), invoice({ paidOn: '2026-09-10' })]);
    // 19 and 40 days from issue.
    expect(s.avgDaysToPay).toBe(30);
    expect(s.paidOnTimePct).toBe(50);
  });

  it('separates outstanding, overdue and disputed', () => {
    const s = summarizePayment([
      invoice({ status: 'overdue', paidOn: null, balance: 500 }),
      invoice({ status: 'disputed', paidOn: null, balance: 250 }),
      invoice(),
    ]);
    expect(s.overdueCount).toBe(1);
    expect(s.overdueAmount).toBe(500);
    expect(s.disputedCount).toBe(1);
    expect(s.outstanding).toBe(750);
  });

  it('returns null rather than zero when nothing has been paid', () => {
    const s = summarizePayment([invoice({ status: 'issued', paidOn: null, balance: 1000 })]);
    expect(s.avgDaysToPay).toBeNull();
    expect(s.paidOnTimePct).toBeNull();
  });
});

describe('assessBrokerRisk', () => {
  const base: BrokerRiskInput = {
    doNotUse: false,
    doNotUseReason: null,
    status: 'active',
    paymentTermsDays: 30,
    avgDaysToPay: 28,
    overdueCount: 0,
    overdueAmount: null,
    disputedCount: 0,
    loadsSettled: 12,
    cancellationRatePct: 2,
    marginPct: 22,
  };

  it('grades a clean broker low and says why', () => {
    const r = assessBrokerRisk(base);
    expect(r.level).toBe('low');
    expect(r.factors).toHaveLength(0);
    expect(r.summary).toContain('No risk factors');
  });

  it('declines to grade a broker with too little history', () => {
    const r = assessBrokerRisk({ ...base, loadsSettled: 1 });
    expect(r.level).toBe('insufficient_data');
    expect(r.summary).toContain('at least 3');
  });

  it('escalates on slow payment and states the observation', () => {
    const r = assessBrokerRisk({ ...base, avgDaysToPay: 60 });
    expect(r.level).toBe('medium');
    expect(r.factors.some((f) => f.key === 'payment_severe')).toBe(true);
    expect(r.summary).toContain('30 days beyond 30-day terms');
  });

  it('reaches high risk only by accumulating stated factors', () => {
    const r = assessBrokerRisk({
      ...base,
      avgDaysToPay: 60,
      overdueCount: 2,
      cancellationRatePct: 18,
      marginPct: 3,
    });
    expect(r.level).toBe('high');
    expect(r.score).toBeGreaterThanOrEqual(4);
    expect(r.factors.length).toBeGreaterThanOrEqual(4);
    // Every point in the score is attributable to a named observation.
    const stated = r.factors.reduce((sum, f) => sum + f.points, 0);
    expect(Math.round(stated * 10) / 10).toBe(r.score);
  });

  it('reports a do-not-use flag as the decision it is, not a computed score', () => {
    const r = assessBrokerRisk({ ...base, doNotUse: true, doNotUseReason: 'Non-payment 2025' });
    expect(r.level).toBe('high');
    expect(r.factors[0]?.key).toBe('do_not_use');
    expect(r.summary).toContain('Non-payment 2025');
  });

  it('lists checks it could not run instead of scoring them as clean', () => {
    const r = assessBrokerRisk({ ...base, avgDaysToPay: null, marginPct: null });
    expect(r.notAssessed.some((n) => n.factor === 'Payment speed')).toBe(true);
    expect(r.notAssessed.some((n) => n.factor === 'Profitability')).toBe(true);
    expect(r.notAssessed.some((n) => n.factor === 'Claims history')).toBe(true);
  });

  it('respects a changed policy rather than hardcoding thresholds', () => {
    const strict = assessBrokerRisk(
      { ...base, marginPct: 12 },
      {
        ...{
          latePaymentGraceDays: 7,
          severeLateDays: 21,
          cancellationRatePct: 10,
          thinMarginPct: 20,
          mediumAt: 1,
          highAt: 4,
          minimumLoads: 3,
        },
      },
    );
    expect(strict.level).toBe('medium');
    expect(strict.factors.some((f) => f.key === 'thin_margin')).toBe(true);
  });
});
