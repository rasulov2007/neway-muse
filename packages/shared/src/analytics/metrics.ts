/**
 * The metric vocabulary.
 *
 * The arithmetic already lives in the reporting engines (`computeFinancials` and friends) and is
 * not repeated here — a second implementation of "profit" is exactly what this file exists to
 * prevent. What lives here is the shared *vocabulary*: what each metric means, how it is worded,
 * whether a rise in it is good, and how a change between two periods is stated.
 *
 * Reports, analytics and the dashboard all read from this, so "margin" cannot come to mean two
 * things in two places.
 */

export const METRIC_KEYS = [
  'gross',
  'linehaul',
  'accessorials',
  'tonu',
  'cost',
  'costBeforeRecovery',
  'recovered',
  'profit',
  'marginPct',
  'miles',
  'rpm',
  'linehaulRpm',
  'cpm',
  'ppm',
  'activeTrucks',
  'grossPerTruck',
  'emptyPct',
  'loads',
  'loadedMiles',
  'emptyMiles',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  /** The formula, in the words used when somebody asks where the number came from. */
  formula: string;
  unit: 'money' | 'money_per_mile' | 'miles' | 'percent' | 'count';
  /** Whether a rise is good, bad, or neither. Drives which way an arrow is coloured. */
  direction: 'up_good' | 'down_good' | 'neutral';
  /**
   * Percentages that measure a *share* change in percentage points, not percent — a margin going
   * from 10% to 12% rose by 2 points, not by 20%. Getting this wrong overstates every move.
   */
  compareAs: 'percent_change' | 'percentage_points' | 'absolute';
}

export const METRICS: Record<MetricKey, MetricDefinition> = {
  gross: {
    key: 'gross',
    label: 'Gross revenue',
    formula:
      'Linehaul plus billed accessorials on loads delivered in the period (NeWay Loads, delivery day in Eastern time), plus TONU fees the brokers pay.',
    unit: 'money',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  linehaul: {
    key: 'linehaul',
    label: 'Linehaul',
    formula: 'The linehaul the broker pays on loads delivered in the period.',
    unit: 'money',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  accessorials: {
    key: 'accessorials',
    label: 'Accessorials',
    formula:
      'Billed accessorials (detention, layover, lumper, stop charges, fuel surcharge) at the amount billed to the broker, not the For driver amount.',
    unit: 'money',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  tonu: {
    key: 'tonu',
    label: 'TONU revenue',
    formula:
      'Truck-ordered-not-used fees the broker pays on a cancelled load, on the Eastern day of the cancellation. Included in gross.',
    unit: 'money',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  cost: {
    key: 'cost',
    label: 'Total cost',
    formula:
      'Every cost recorded in the period, minus what was recovered from drivers. Null when no expense data exists at all.',
    unit: 'money',
    direction: 'down_good',
    compareAs: 'percent_change',
  },
  costBeforeRecovery: {
    key: 'costBeforeRecovery',
    label: 'Cost before recoveries',
    formula: 'Every cost recorded in the period, in full, before money recovered from drivers.',
    unit: 'money',
    direction: 'down_good',
    compareAs: 'percent_change',
  },
  recovered: {
    key: 'recovered',
    label: 'Recovered from drivers',
    formula:
      'Company-paid fuel, repairs and other charges held back from drivers on their statements, dated by the statement week. Subtracted from cost.',
    unit: 'money',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  profit: {
    key: 'profit',
    label: 'Operating profit',
    formula: 'Gross revenue minus total cost.',
    unit: 'money',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  marginPct: {
    key: 'marginPct',
    label: 'Margin',
    formula: 'Operating profit ÷ gross revenue.',
    unit: 'percent',
    direction: 'up_good',
    compareAs: 'percentage_points',
  },
  miles: {
    key: 'miles',
    label: 'Miles',
    formula:
      'Load miles: loaded plus empty (deadhead) miles on the loads delivered in the period. RPM, CPM and PPM all divide by these.',
    unit: 'miles',
    direction: 'neutral',
    compareAs: 'percent_change',
  },
  rpm: {
    key: 'rpm',
    label: 'RPM',
    formula: 'Gross revenue ÷ load miles (loaded + empty).',
    unit: 'money_per_mile',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  linehaulRpm: {
    key: 'linehaulRpm',
    label: 'Linehaul RPM',
    formula: 'Linehaul ÷ load miles (loaded + empty): the figure market rates compare against.',
    unit: 'money_per_mile',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  cpm: {
    key: 'cpm',
    label: 'CPM',
    formula: 'Total cost ÷ load miles (loaded + empty).',
    unit: 'money_per_mile',
    direction: 'down_good',
    compareAs: 'percent_change',
  },
  ppm: {
    key: 'ppm',
    label: 'PPM',
    formula: 'Operating profit ÷ load miles (loaded + empty).',
    unit: 'money_per_mile',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  activeTrucks: {
    key: 'activeTrucks',
    label: 'Active trucks',
    formula: 'Trucks with at least one delivered load in the period.',
    unit: 'count',
    direction: 'neutral',
    compareAs: 'absolute',
  },
  grossPerTruck: {
    key: 'grossPerTruck',
    label: 'Revenue per active truck',
    formula: 'Gross revenue ÷ active trucks.',
    unit: 'money',
    direction: 'up_good',
    compareAs: 'percent_change',
  },
  emptyPct: {
    key: 'emptyPct',
    label: 'Empty miles',
    formula: 'Empty miles ÷ total miles.',
    unit: 'percent',
    direction: 'down_good',
    compareAs: 'percentage_points',
  },
  /*
   * Operations volume (2026-10-25). The same per-load sums the Operations section always showed,
   * now compared with the previous period. Volume is neutral like `miles`: more loads is not
   * judged good or bad here; fewer empty miles is, consistent with `emptyPct`.
   */
  loads: {
    key: 'loads',
    label: 'Loads delivered',
    formula: 'Loads delivered in the period.',
    unit: 'count',
    direction: 'neutral',
    compareAs: 'percent_change',
  },
  loadedMiles: {
    key: 'loadedMiles',
    label: 'Loaded miles',
    formula: 'Loaded miles recorded on loads delivered in the period.',
    unit: 'miles',
    direction: 'neutral',
    compareAs: 'percent_change',
  },
  emptyMiles: {
    key: 'emptyMiles',
    label: 'Empty miles',
    formula: 'Empty (deadhead) miles recorded on loads delivered in the period.',
    unit: 'miles',
    direction: 'down_good',
    compareAs: 'percent_change',
  },
};

/**
 * One metric, this period against the last.
 *
 * Named `compareMetricPeriods` rather than `compare` because the accounting module already exports
 * a `compare` for period figures; two functions called the same thing across one package is how a
 * caller ends up using the wrong one.
 *
 * `changePct` is `null` whenever it would be meaningless — a previous value of zero or null makes
 * "up 100%" a statement about nothing. The consumer shows the change as unavailable rather than as
 * a spectacular improvement.
 */
export interface MetricComparison {
  key: MetricKey;
  label: string;
  current: number | null;
  previous: number | null;
  /** Absolute difference, or difference in points for a share metric. Null when either side is. */
  change: number | null;
  /** Relative change, only when the previous value can carry one. */
  changePct: number | null;
  /** `better`, `worse` or `flat`, judged against the metric's own direction. */
  verdict: 'better' | 'worse' | 'flat' | 'unknown';
  unit: MetricDefinition['unit'];
  compareAs: MetricDefinition['compareAs'];
}

export function compareMetricPeriods(
  key: MetricKey,
  current: number | null,
  previous: number | null,
): MetricComparison {
  const definition = METRICS[key];
  const base = {
    key,
    label: definition.label,
    current,
    previous,
    unit: definition.unit,
    compareAs: definition.compareAs,
  };

  if (current === null || previous === null) {
    return { ...base, change: null, changePct: null, verdict: 'unknown' };
  }

  const change = round(current - previous);
  // A percentage move from zero is not a percentage move; it is a start.
  const changePct =
    definition.compareAs === 'percent_change' && previous !== 0
      ? round((change / Math.abs(previous)) * 100)
      : null;

  let verdict: MetricComparison['verdict'] = 'flat';
  if (change !== 0 && definition.direction !== 'neutral') {
    const improved = definition.direction === 'up_good' ? change > 0 : change < 0;
    verdict = improved ? 'better' : 'worse';
  }

  return { ...base, change, changePct, verdict };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** How a change should be written out. Percentage points are never called percent. */
export function describeChange(comparison: MetricComparison): string {
  if (comparison.change === null) return 'No comparable figure for the previous period';
  if (comparison.compareAs === 'percentage_points') {
    const sign = comparison.change > 0 ? '+' : '';
    return `${sign}${comparison.change.toFixed(1)} pts`;
  }
  if (comparison.changePct === null) {
    return comparison.previous === 0
      ? 'No activity in the previous period'
      : `${comparison.change > 0 ? '+' : ''}${comparison.change}`;
  }
  const sign = comparison.changePct > 0 ? '+' : '';
  return `${sign}${comparison.changePct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------------- exceptions

export type InsightSeverity = 'critical' | 'warning' | 'info';

/**
 * One finding, traceable to the numbers behind it.
 *
 * `evidence` is what makes this different from a generated sentence: every insight carries the
 * metric, both values and the entity it concerns, so a reader can check it rather than believe it.
 * Nothing in this system produces an insight without them.
 */
export interface Insight {
  key: string;
  severity: InsightSeverity;
  title: string;
  /** What to do about it. */
  action: string;
  entity: { type: string; id: string; label: string } | null;
  evidence: {
    metric: MetricKey;
    current: number | null;
    previous: number | null;
    change: number | null;
    changePct: number | null;
  };
  href?: string;
}

/** The move that makes something worth flagging rather than merely different. */
export const INSIGHT_THRESHOLDS = {
  /** Relative move in a per-mile rate before it is worth somebody's attention. */
  ratePct: 15,
  /** Points of margin. */
  marginPoints: 3,
  /** Minimum miles before a rate is stable enough to compare at all. */
  minimumMiles: 2_000,
} as const;
