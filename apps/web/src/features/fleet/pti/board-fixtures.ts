import { unitServiceStatus, type PtiBoardRow, type PtiDefect, type PtiInspection } from '@neway/shared';

/**
 * Board rows for tests, built the way the API builds them: the verdict from the open defects,
 * the age from the oldest one. Today is 2026-09-17, the week is the one starting 2026-09-14.
 */

export const TODAY = '2026-09-17';
export const WEEK = '2026-09-14';

export function inspection(overrides: Partial<PtiInspection> & { unitNumber: string }): PtiInspection {
  return {
    id: `pin_${overrides.unitNumber}`,
    unitId: `trk_${overrides.unitNumber}`,
    weekStart: WEEK,
    dueAt: '2026-09-16',
    driverId: 'drv_1',
    driverName: 'Luis Herrera',
    driverType: 'company',
    dispatcherId: 'usr_elena',
    dispatcherName: 'Elena Vasquez',
    receiptStatus: 'missing',
    receivedAt: null,
    source: null,
    reviewState: 'unreviewed',
    reviewerId: null,
    reviewerName: null,
    reviewedAt: null,
    reviewResult: null,
    inReviewBy: null,
    inReviewByName: null,
    inReviewSince: null,
    openDefectDispositions: [],
    legacyRecordId: null,
    createdAt: '2026-09-14T05:00:00.000Z',
    updatedAt: '2026-09-14T05:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

export function defect(overrides: Partial<PtiDefect> & { id: string; defectNumber: string; unitNumber: string }): PtiDefect {
  return {
    unitId: `trk_${overrides.unitNumber}`,
    foundOnInspectionId: null,
    component: 'brakes',
    componentName: 'Brakes',
    description: 'Slack adjuster out of stroke on axle 3',
    quickPick: null,
    severity: 'monitor',
    state: 'open',
    evidence: { clipTime: null, screenshots: [] },
    ownerId: null,
    ownerName: null,
    dueAt: null,
    workOrderId: null,
    workOrderNumber: null,
    resolution: { fixedAt: null, fixedVia: null, verifiedAt: null, verifiedBy: null, dismissedReason: null },
    needsReview: false,
    legacyRecordId: null,
    history: [],
    createdBy: 'Tom Brennan',
    createdAt: '2026-09-12T15:00:00.000Z',
    updatedAt: '2026-09-12T15:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

export function row(
  insp: PtiInspection,
  defects: PtiDefect[] = [],
  extra: Partial<Pick<PtiBoardRow, 'latestReviewed' | 'inShop'>> = {},
): PtiBoardRow {
  const open = defects.filter((d) => d.state !== 'verified' && d.state !== 'dismissed');
  const oldest = open.reduce<number | null>((min, d) => {
    const t = Date.parse(d.createdAt);
    return min === null || t < min ? t : min;
  }, null);
  return {
    inspection: insp,
    latestReviewed: extra.latestReviewed ?? null,
    openDefects: open,
    verdict: unitServiceStatus(open),
    ageDays: oldest === null ? 0 : Math.max(0, Math.floor((Date.parse(`${TODAY}T00:00:00Z`) - oldest) / 86_400_000)),
    inShop: extra.inShop ?? false,
  };
}

/** The brief's live examples: 2785 (missing, stale clean), 2718 (5-day oos_risk), a clean video from yesterday, one to verify. */
export function briefRows(): PtiBoardRow[] {
  return [
    row(inspection({ unitNumber: '2785', receiptStatus: 'missing' }), [], {
      latestReviewed: { id: 'pin_2785_prev', weekStart: '2026-08-31', reviewedAt: '2026-09-02T14:00:00.000Z', reviewResult: 'no_issues' },
    }),
    row(
      inspection({ unitNumber: '2718', receiptStatus: 'received', receivedAt: '2026-09-15T14:00:00.000Z', reviewState: 'reviewed', reviewResult: 'issues_found', reviewedAt: '2026-09-15T15:00:00.000Z' }),
      [defect({ id: 'pd_4417', defectNumber: 'DEF-4417', unitNumber: '2718', severity: 'oos_risk', createdAt: '2026-09-12T15:00:00.000Z' })],
      { latestReviewed: { id: 'pin_2718', weekStart: WEEK, reviewedAt: '2026-09-15T15:00:00.000Z', reviewResult: 'issues_found' } },
    ),
    row(
      inspection({ unitNumber: '2701', receiptStatus: 'received', receivedAt: '2026-09-16T14:00:00.000Z', reviewState: 'reviewed', reviewResult: 'no_issues', reviewedAt: '2026-09-16T15:00:00.000Z' }),
      [],
      { latestReviewed: { id: 'pin_2701', weekStart: WEEK, reviewedAt: '2026-09-16T15:00:00.000Z', reviewResult: 'no_issues' } },
    ),
    row(
      inspection({ unitNumber: '0069', receiptStatus: 'received', receivedAt: '2026-09-15T10:00:00.000Z', reviewState: 'reviewed', reviewResult: 'no_issues', reviewedAt: '2026-09-15T11:00:00.000Z' }),
      [defect({ id: 'pd_0069', defectNumber: 'DEF-0069', unitNumber: '0069', state: 'fixed_pending_verify', ownerId: 'usr_tom', ownerName: 'Tom Brennan', workOrderId: 'ro_2031', workOrderNumber: 'RO-2031', createdAt: '2026-09-10T15:00:00.000Z' })],
      { latestReviewed: { id: 'pin_0069', weekStart: WEEK, reviewedAt: '2026-09-15T11:00:00.000Z', reviewResult: 'no_issues' } },
    ),
    row(inspection({ unitNumber: '2760', receiptStatus: 'received', receivedAt: '2026-09-16T09:00:00.000Z' })),
    row(inspection({ unitNumber: '2740', receiptStatus: 'exempt_in_shop' }), [], { inShop: true }),
  ];
}
