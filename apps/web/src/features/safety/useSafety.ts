import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  buildSafetyExceptions,
  correctiveActionState,
  defectUrgency,
  dotRecordable,
  inspectionState,
  reviewAccident,
  summarizeViolations,
  violationState,
  type AccidentReview,
  type CorrectiveActionStateResult,
  type DefectUrgency,
  type InspectionStateResult,
  type SafetyExceptionQueue,
  type ViolationStateResult,
  type ViolationSummary,
} from '@neway/shared';
import {
  listAccidents,
  listClaims,
  listCorrectiveActions,
  listDefects,
  listInspections,
  listViolations,
  type Accident,
  type Claim,
  type CorrectiveAction,
  type Defect,
  type Inspection,
  type Violation,
} from '@/demo';
import { nowIso as clockNowIso, today as companyToday } from '@/lib/clock';

/**
 * Everything Safety knows, derived once.
 *
 * Inspections, defects, violations, accidents and the corrective actions they raise are one system:
 * a roadside inspection produces defects *and* violations, a preventable accident produces a
 * corrective action, and a unit with an out-of-service defect cannot be dispatched. Deriving all of
 * that here rather than in each page is what makes those connections structurally true instead of
 * merely intended.
 *
 * When Phase 8 arrives, the six `list*` calls below point at HTTP instead of the demo store and
 * nothing else in this file — or in any page above it — changes.
 */

/** The demo API caps a page at 200 rows, so every list is drained rather than truncated. */
const PAGE = 200;

async function drain<T>(
  fetchPage: (page: number, pageSize: number) => Promise<{ data: T[]; total: number }>,
): Promise<T[]> {
  const first = await fetchPage(1, PAGE);
  const rows = [...first.data];
  const pages = Math.ceil(first.total / PAGE);
  for (let page = 2; page <= pages; page += 1) {
    rows.push(...(await fetchPage(page, PAGE)).data);
  }
  return rows;
}

/**
 * Cached for the length of a working session.
 *
 * These bundles are what a module's list pages render from, so the cache decides what "back"
 * feels like. The defaults (30 s stale, 5 min garbage collection) meant a detail page visited for
 * six minutes threw the list's data away, and returning to it showed a skeleton while the whole
 * nested bundle was fetched again. Keeping it an hour costs memory that is already allocated and
 * turns the return trip into a repaint; `refetchOnMount` still brings it up to date in the
 * background, and every mutation invalidates it explicitly.
 */
const BUNDLE_CACHE = { staleTime: 60_000, gcTime: 60 * 60_000 } as const;

export interface SafetyInspection {
  inspection: Inspection;
  state: InspectionStateResult;
  /** Defects this inspection raised. */
  defects: SafetyDefect[];
  openDefects: number;
  /** Violations written off the back of it. */
  violations: Violation[];
  correctiveActions: SafetyCorrectiveAction[];
}

export interface SafetyDefect {
  defect: Defect;
  urgency: DefectUrgency;
  correctiveActions: SafetyCorrectiveAction[];
}

export interface SafetyViolation {
  violation: Violation;
  state: ViolationStateResult;
  /** The inspection that produced it, when it came from one. */
  inspection: Inspection | null;
  correctiveActions: SafetyCorrectiveAction[];
}

export interface SafetyAccident {
  accident: Accident;
  review: AccidentReview;
  /** The federal test applied to what was reported, with its working shown. */
  recordability: ReturnType<typeof dotRecordable>;
  claim: Claim | null;
  correctiveActions: SafetyCorrectiveAction[];
  /** Total assessed damage, or null when nothing has been assessed yet. */
  totalDamage: number | null;
}

export interface SafetyCorrectiveAction {
  action: CorrectiveAction;
  state: CorrectiveActionStateResult;
}

export interface SafetyBundle {
  nowIso: string;
  today: string;
  inspections: SafetyInspection[];
  defects: SafetyDefect[];
  violations: SafetyViolation[];
  accidents: SafetyAccident[];
  claims: Claim[];
  correctiveActions: SafetyCorrectiveAction[];
  exceptions: SafetyExceptionQueue;
  /** Carrier-wide violation facts. Counts and repetition — never a score. */
  violationSummary: ViolationSummary;
  byInspectionId: Map<string, SafetyInspection>;
  byViolationId: Map<string, SafetyViolation>;
  byAccidentId: Map<string, SafetyAccident>;
  byClaimId: Map<string, Claim>;
  /** Every violation on one driver, for the driver-impact panel. */
  violationsByDriverId: Map<string, SafetyViolation[]>;
  violationsByTruckId: Map<string, SafetyViolation[]>;
}

export const SAFETY_QUERY_KEY = ['safety', 'bundle'] as const;

function sumDamage(accident: Accident): number | null {
  const values = Object.values(accident.damage).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) * 100) / 100;
}

export async function loadSafetyBundle(): Promise<SafetyBundle> {
  const [inspections, defects, violations, accidents, claims, actions] = await Promise.all([
    drain((page, pageSize) => listInspections({ page, pageSize })),
    drain((page, pageSize) => listDefects({ page, pageSize })),
    drain((page, pageSize) => listViolations({ page, pageSize })),
    drain((page, pageSize) => listAccidents({ page, pageSize })),
    drain((page, pageSize) => listClaims({ page, pageSize })),
    drain((page, pageSize) => listCorrectiveActions({ page, pageSize })),
  ]);

  const nowIso = clockNowIso();
  const today = companyToday();

  const safetyActions: SafetyCorrectiveAction[] = actions.map((action) => ({
    action,
    state: correctiveActionState(
      {
        status: action.status,
        assigneeId: action.assigneeId,
        dueAt: action.dueAt,
        completedAt: action.completedAt,
      },
      nowIso,
    ),
  }));

  const actionsBySubject = new Map<string, SafetyCorrectiveAction[]>();
  for (const row of safetyActions) {
    const key = `${row.action.subjectType}:${row.action.subjectId}`;
    const bucket = actionsBySubject.get(key);
    if (bucket) bucket.push(row);
    else actionsBySubject.set(key, [row]);
  }
  const actionsFor = (type: string, id: string) => actionsBySubject.get(`${type}:${id}`) ?? [];

  const safetyDefects: SafetyDefect[] = defects.map((defect) => ({
    defect,
    urgency: defectUrgency(
      {
        severity: defect.severity,
        status: defect.status,
        dueOn: defect.dueOn,
        outOfService: defect.outOfService,
      },
      today,
    ),
    correctiveActions: actionsFor('defect', defect.id),
  }));

  const defectsByInspection = new Map<string, SafetyDefect[]>();
  for (const row of safetyDefects) {
    if (!row.defect.inspectionId) continue;
    const bucket = defectsByInspection.get(row.defect.inspectionId);
    if (bucket) bucket.push(row);
    else defectsByInspection.set(row.defect.inspectionId, [row]);
  }

  const violationsByInspection = new Map<string, Violation[]>();
  for (const violation of violations) {
    if (!violation.inspectionId) continue;
    const bucket = violationsByInspection.get(violation.inspectionId);
    if (bucket) bucket.push(violation);
    else violationsByInspection.set(violation.inspectionId, [violation]);
  }

  const inspectionById = new Map(inspections.map((i) => [i.id, i]));

  const safetyInspections: SafetyInspection[] = inspections.map((inspection) => {
    const raised = defectsByInspection.get(inspection.id) ?? [];
    const openDefects = raised.filter((d) => d.defect.status !== 'resolved').length;
    return {
      inspection,
      state: inspectionState(
        {
          at: inspection.at,
          startedAt: inspection.startedAt,
          completedAt: inspection.completedAt,
          cancelledAt: inspection.cancelledAt,
          result: inspection.result,
          openDefects,
          totalDefects: raised.length,
        },
        nowIso,
      ),
      defects: raised,
      openDefects,
      violations: violationsByInspection.get(inspection.id) ?? [],
      correctiveActions: actionsFor('inspection', inspection.id),
    };
  });

  const safetyViolations: SafetyViolation[] = violations.map((violation) => {
    const violationActions = actionsFor('violation', violation.id);
    const openAction = violationActions.find((a) => a.state.outstanding);
    return {
      violation,
      state: violationState(
        {
          resolvedAt: violation.resolvedAt,
          contested: violation.contested,
          hasOpenCorrectiveAction: openAction !== undefined,
          correctiveActionDueOn: openAction?.action.dueAt.slice(0, 10) ?? null,
          severity: violation.severity,
        },
        today,
      ),
      inspection: violation.inspectionId
        ? (inspectionById.get(violation.inspectionId) ?? null)
        : null,
      correctiveActions: violationActions,
    };
  });

  const claimById = new Map(claims.map((c) => [c.id, c]));

  const safetyAccidents: SafetyAccident[] = accidents.map((accident) => {
    const accidentActions = actionsFor('accident', accident.id);
    const recordability = dotRecordable({
      fatalities: accident.fatalities,
      injuriesTreatedAway: accident.injuries.filter((i) => i.treatedAwayFromScene).length,
      towedFromScene: accident.towedFromScene,
    });
    return {
      accident,
      review: reviewAccident(
        {
          status: accident.status,
          at: accident.at,
          preventable: accident.preventable,
          recordable: accident.dotRecordable,
          evidence: accident.evidence,
          ownerId: accident.ownerId,
          investigationDueOn: accident.investigationDueOn,
          openCorrectiveActions: accidentActions.filter((a) => a.state.outstanding).length,
        },
        nowIso,
      ),
      recordability,
      claim: accident.claimId ? (claimById.get(accident.claimId) ?? null) : null,
      correctiveActions: accidentActions,
      totalDamage: sumDamage(accident),
    };
  });

  const exceptions = buildSafetyExceptions(
    {
      inspections: inspections.map((i) => ({
        id: i.id,
        at: i.at,
        startedAt: i.startedAt,
        completedAt: i.completedAt,
        cancelledAt: i.cancelledAt,
        result: i.result,
        openDefects: (defectsByInspection.get(i.id) ?? []).filter(
          (d) => d.defect.status !== 'resolved',
        ).length,
        totalDefects: (defectsByInspection.get(i.id) ?? []).length,
      })),
      defects: defects.map((d) => ({
        id: d.id,
        severity: d.severity,
        status: d.status,
        dueOn: d.dueOn,
        outOfService: d.outOfService,
      })),
      violations: safetyViolations.map((v) => ({
        id: v.violation.id,
        severity: v.violation.severity,
        resolvedAt: v.violation.resolvedAt,
        contested: v.violation.contested,
        hasOpenCorrectiveAction: v.correctiveActions.some((a) => a.state.outstanding),
        correctiveActionDueOn:
          v.correctiveActions.find((a) => a.state.outstanding)?.action.dueAt.slice(0, 10) ?? null,
      })),
      accidents: safetyAccidents.map((a) => ({
        id: a.accident.id,
        status: a.accident.status,
        preventable: a.accident.preventable,
        recordable: a.accident.dotRecordable,
        ownerId: a.accident.ownerId,
        missingEvidence: a.review.missingEvidence.length,
      })),
      correctiveActions: actions.map((a) => ({
        id: a.id,
        status: a.status,
        assigneeId: a.assigneeId,
        dueAt: a.dueAt,
        completedAt: a.completedAt,
      })),
    },
    nowIso,
  );

  const violationsByDriverId = new Map<string, SafetyViolation[]>();
  const violationsByTruckId = new Map<string, SafetyViolation[]>();
  for (const row of safetyViolations) {
    if (row.violation.driverId) {
      const bucket = violationsByDriverId.get(row.violation.driverId);
      if (bucket) bucket.push(row);
      else violationsByDriverId.set(row.violation.driverId, [row]);
    }
    if (row.violation.truckId) {
      const bucket = violationsByTruckId.get(row.violation.truckId);
      if (bucket) bucket.push(row);
      else violationsByTruckId.set(row.violation.truckId, [row]);
    }
  }

  return {
    nowIso,
    today,
    inspections: safetyInspections,
    defects: safetyDefects,
    violations: safetyViolations,
    accidents: safetyAccidents,
    claims,
    correctiveActions: safetyActions,
    exceptions,
    violationSummary: summarizeViolations(
      violations.map((v) => ({
        id: v.id,
        category: v.category,
        severity: v.severity,
        onDate: v.onDate,
        resolvedAt: v.resolvedAt,
        contested: v.contested,
        points: v.points,
      })),
      today,
    ),
    byInspectionId: new Map(safetyInspections.map((r) => [r.inspection.id, r])),
    byViolationId: new Map(safetyViolations.map((r) => [r.violation.id, r])),
    byAccidentId: new Map(safetyAccidents.map((r) => [r.accident.id, r])),
    byClaimId: claimById,
    violationsByDriverId,
    violationsByTruckId,
  };
}

export function useSafety(): UseQueryResult<SafetyBundle> {
  return useQuery({ queryKey: SAFETY_QUERY_KEY, queryFn: loadSafetyBundle, ...BUNDLE_CACHE });
}

/**
 * Invalidates everything a safety write can change.
 *
 * A safety write is never local to one list: an out-of-service defect changes a truck's status, a
 * corrective action changes a violation's state, and closing a claim changes an accident. Anything
 * narrower leaves a stale count on screen.
 */
export function useInvalidateSafety(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['safety'] }),
      queryClient.invalidateQueries({ queryKey: ['fleet'] }),
      queryClient.invalidateQueries({ queryKey: ['compliance'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
    ]);
  };
}
