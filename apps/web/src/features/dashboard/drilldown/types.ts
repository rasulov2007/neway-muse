import type { DashboardOpsNet, DrilldownMetric } from '@neway/shared';

/** What the drill-down drawer should show. */
export type DrilldownRequest =
  | { kind: 'metric'; metric: DrilldownMetric }
  | {
      kind: 'unknown_pay_types';
      unknown: DashboardOpsNet['unknown'];
    };
