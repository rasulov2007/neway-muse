import { z } from 'zod';

/**
 * Broker risk.
 *
 * A single letter grade with no explanation is worse than no grade at all: nobody can act on it and
 * nobody can argue with it. So this engine emits the level *and* the factors that produced it, each
 * naming the observation and what it contributed. A broker manager can disagree with a threshold
 * and change it; that is the point of `BrokerRiskPolicy`.
 *
 * Every factor is computed from data the system actually holds — invoices, load outcomes and the
 * broker record. Factors that need data we do not have are reported in `notAssessed` rather than
 * quietly scored as zero, because "we did not check" and "we checked and it was fine" are different
 * statements.
 */

export const BROKER_RISK_LEVELS = ['low', 'medium', 'high', 'insufficient_data'] as const;
export const BrokerRiskLevelSchema = z.enum(BROKER_RISK_LEVELS);
export type BrokerRiskLevel = z.infer<typeof BrokerRiskLevelSchema>;

export interface BrokerRiskPolicy {
  /** Paying this many days beyond terms starts to count against a broker. */
  latePaymentGraceDays: number;
  /** Days beyond terms that counts as a serious payment problem. */
  severeLateDays: number;
  /** Cancellation rate, in percent, that counts against a broker. */
  cancellationRatePct: number;
  /** Margin, in percent, below which the relationship is unprofitable enough to matter. */
  thinMarginPct: number;
  /** Points at which the total score tips into each level. */
  mediumAt: number;
  highAt: number;
  /** Fewer settled loads than this and the engine declines to grade. */
  minimumLoads: number;
}

export const DEFAULT_BROKER_RISK_POLICY: BrokerRiskPolicy = {
  latePaymentGraceDays: 7,
  severeLateDays: 21,
  cancellationRatePct: 10,
  thinMarginPct: 8,
  mediumAt: 2,
  highAt: 4,
  minimumLoads: 3,
};

export interface BrokerRiskFactor {
  key: string;
  /** What was observed, in the operator's words. */
  observation: string;
  /** How much this added to the score. */
  points: number;
}

export interface BrokerRiskInput {
  /** Hard flag on the broker record; overrides scoring. */
  doNotUse: boolean;
  doNotUseReason: string | null;
  status: string;
  paymentTermsDays: number;
  /** From `summarizePayment`. */
  avgDaysToPay: number | null;
  overdueCount: number;
  overdueAmount: number | null;
  disputedCount: number;
  /** From `summarizePerformance`. */
  loadsSettled: number;
  cancellationRatePct: number | null;
  marginPct: number | null;
}

export interface BrokerRisk {
  level: BrokerRiskLevel;
  score: number;
  factors: BrokerRiskFactor[];
  /** Checks that could not run, each naming what it needs. */
  notAssessed: Array<{ factor: string; requires: string }>;
  /** One-line summary suitable for a tooltip. */
  summary: string;
}

/**
 * Grades a broker. Pure and explainable: `factors` is the whole derivation, and the level is a
 * function of their points against the policy thresholds.
 */
export function assessBrokerRisk(
  input: BrokerRiskInput,
  policy: BrokerRiskPolicy = DEFAULT_BROKER_RISK_POLICY,
): BrokerRisk {
  const factors: BrokerRiskFactor[] = [];

  const notAssessed = [
    { factor: 'Claims history', requires: 'a claims module; no claim record exists yet' },
    {
      factor: 'Credit standing',
      requires: 'a credit-check provider; nothing supplies a credit rating today',
    },
  ];

  // A do-not-use flag is a decision someone already made; it is reported, not re-litigated. The
  // recorded reason carries into the summary, because "high risk" with no stated cause is exactly
  // the unexplained grade this engine exists to avoid.
  if (input.doNotUse) {
    const observation = input.doNotUseReason
      ? `Flagged do-not-use: ${input.doNotUseReason}`
      : 'Flagged do-not-use on the broker record, with no reason recorded';
    return {
      level: 'high',
      score: policy.highAt,
      factors: [{ key: 'do_not_use', observation, points: policy.highAt }],
      notAssessed,
      summary: observation,
    };
  }

  if (input.loadsSettled < policy.minimumLoads) {
    return {
      level: 'insufficient_data',
      score: 0,
      factors: [],
      notAssessed,
      summary: `Only ${input.loadsSettled} settled load(s); at least ${policy.minimumLoads} are needed to grade this broker`,
    };
  }

  if (input.status === 'on_hold') {
    factors.push({ key: 'on_hold', observation: 'Broker account is on hold', points: 2 });
  }

  if (input.avgDaysToPay !== null) {
    const beyondTerms = input.avgDaysToPay - input.paymentTermsDays;
    if (beyondTerms >= policy.severeLateDays) {
      factors.push({
        key: 'payment_severe',
        observation: `Pays ${beyondTerms} days beyond ${input.paymentTermsDays}-day terms on average`,
        points: 3,
      });
    } else if (beyondTerms >= policy.latePaymentGraceDays) {
      factors.push({
        key: 'payment_late',
        observation: `Pays ${beyondTerms} days beyond ${input.paymentTermsDays}-day terms on average`,
        points: 1.5,
      });
    }
  } else {
    notAssessed.push({
      factor: 'Payment speed',
      requires: 'at least one paid invoice with both an issue and a payment date',
    });
  }

  if (input.overdueCount > 0) {
    factors.push({
      key: 'overdue',
      observation:
        input.overdueAmount === null
          ? `${input.overdueCount} invoice(s) past due`
          : `${input.overdueCount} invoice(s) past due, $${input.overdueAmount.toLocaleString('en-US')} outstanding`,
      points: Math.min(2, input.overdueCount * 0.75),
    });
  }

  if (input.disputedCount > 0) {
    factors.push({
      key: 'disputes',
      observation: `${input.disputedCount} invoice(s) in dispute`,
      points: Math.min(2, input.disputedCount),
    });
  }

  if (
    input.cancellationRatePct !== null &&
    input.cancellationRatePct >= policy.cancellationRatePct
  ) {
    factors.push({
      key: 'cancellations',
      observation: `${input.cancellationRatePct}% of loads cancelled or TONU, above the ${policy.cancellationRatePct}% threshold`,
      points: 1.5,
    });
  }

  if (input.marginPct !== null) {
    if (input.marginPct < 0) {
      factors.push({
        key: 'loss_making',
        observation: `This broker's freight has lost money overall (${input.marginPct}% margin)`,
        points: 3,
      });
    } else if (input.marginPct < policy.thinMarginPct) {
      factors.push({
        key: 'thin_margin',
        observation: `Margin of ${input.marginPct}% is below the ${policy.thinMarginPct}% threshold`,
        points: 1.5,
      });
    }
  } else {
    notAssessed.push({
      factor: 'Profitability',
      requires: 'priced loads; this broker has none the cost engine could restate',
    });
  }

  const score = Math.round(factors.reduce((sum, f) => sum + f.points, 0) * 10) / 10;
  const level: BrokerRiskLevel =
    score >= policy.highAt ? 'high' : score >= policy.mediumAt ? 'medium' : 'low';

  const summary =
    factors.length === 0
      ? 'No risk factors found in payment, cancellation or margin history'
      : factors
          .slice()
          .sort((a, b) => b.points - a.points)
          .map((f) => f.observation)
          .join('; ');

  return { level, score, factors, notAssessed, summary };
}
